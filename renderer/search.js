// Moteur de recherche plein texte — Bibliothèque Aviation.
// Règles (spécification) :
//  - insensible à la casse et aux accents ;
//  - MOT ENTIER pour tous les termes : « stall » ne trouve jamais « installed » ;
//  - l'expression tapée (« stall speed ») est cherchée comme un tout (phrase exacte) ;
//  - synonymes FR <-> EN (liste fixe, data/synonyms.json) : la requête égale à un
//    terme d'un groupe élargit la recherche à tous les termes du groupe.
// Le moteur travaille sur le texte ORIGINAL de l'index (positions exactes pour
// l'extrait) avec des classes de caractères accentués, jamais sur un texte
// normalisé dont les positions ne correspondraient plus à l'original.

const ACCENT_CLASSES = {
  a: '[aàáâãäå]', c: '[cç]', e: '[eèéêë]', i: '[iìíîï]', n: '[nñ]',
  o: '[oòóôõö]', u: '[uùúûü]', y: '[yÿ]',
};

export function normalizeForLookup(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Construit une regex qui trouve `term` en mot entier, insensible à la casse
// et aux accents, y compris à cheval sur un saut de ligne (espaces -> \s+).
export function buildTermRegex(term) {
  const parts = [];
  for (const ch of term) {
    if (ch === ' ') parts.push('\\s+');
    else if (ch === "'" || ch === '’' || ch === '‘') parts.push("[''’]");
    else if (ACCENT_CLASSES[ch.toLowerCase()]) parts.push(ACCENT_CLASSES[ch.toLowerCase()]);
    else parts.push(escapeRegExp(ch));
  }
  // Mot entier : pas de lettre/chiffre/underscore juste avant ni juste après.
  return new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])${parts.join('')}(?![A-Za-zÀ-ÿ0-9_])`, 'gi');
}

// Élargit la requête via les synonymes. Retourne la liste des termes à chercher,
// requête d'origine en premier.
export function expandQuery(query, synonyms) {
  const q = normalizeForLookup(query);
  if (!q) return [];
  const found = [query.trim()];
  if (synonyms && Array.isArray(synonyms.groups)) {
    for (const group of synonyms.groups) {
      const terms = group.terms || [];
      if (terms.some((t) => normalizeForLookup(t) === q)) {
        for (const t of terms) {
          if (normalizeForLookup(t) !== q && !found.includes(t)) found.push(t);
        }
      }
    }
  }
  return found;
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Extrait autour de la première occurrence du terme dans le texte original.
function makeExcerpt(text, term) {
  const re = buildTermRegex(term);
  const m = re.exec(text);
  if (!m) return { excerpt: '', excerptHtml: '' };
  // Fenêtre autour de la première occurrence, coupée aux limites de mots
  // (jamais en plein milieu d'un mot).
  let start = Math.max(0, m.index - 80);
  let end = Math.min(text.length, m.index + m[0].length + 120);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < m.index) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > m.index + m[0].length) end = sp;
  }
  let raw = text.slice(start, end).replace(/\s+/g, ' ');
  const relStart = m.index - start;
  const relEnd = relStart + m[0].length;
  // On recale les bornes après la normalisation des espaces (approximatif mais
  // sûr : on surligne en cherchant le terme dans l'extrait nettoyé).
  const cleaned = raw;
  const inner = buildTermRegex(term);
  const m2 = inner.exec(cleaned);
  let html;
  if (m2) {
    html = escapeHtml(cleaned.slice(0, m2.index))
      + '<mark>' + escapeHtml(cleaned.slice(m2.index, m2.index + m2[0].length)) + '</mark>'
      + escapeHtml(cleaned.slice(m2.index + m2[0].length));
  } else {
    html = escapeHtml(cleaned);
  }
  void relStart; void relEnd;
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < text.length ? ' …' : '';
  return { excerpt: prefix + raw + suffix, excerptHtml: prefix + html + suffix };
}

// Recherche dans les documents indexés.
// docs : [{ doc_id, title, pages: [{ pdf_page, printed_label, section, text }] }]
//        dans l'ordre d'affichage (172N, 172R, 150, SOP).
// meta : { [doc_id]: { short, title, sections: [{key,label,startPage}] } }
// opts : { scope: 'all' | doc_id, limit }
// Retourne { results, total, truncated, terms } — results en ordre de lecture.
export function searchDocs(docs, meta, query, synonyms, opts = {}) {
  const terms = expandQuery(query, synonyms);
  if (terms.length === 0) return { results: [], total: 0, truncated: false, terms: [] };
  const scope = opts.scope || 'all';
  const limit = opts.limit || (scope === 'all' ? 500 : 1000);
  const regexes = terms.map((t) => ({ term: t, re: buildTermRegex(t) }));
  const results = [];
  let total = 0;

  for (const doc of docs) {
    if (scope !== 'all' && doc.doc_id !== scope) continue;
    const m = meta[doc.doc_id] || {};
    for (const page of doc.pages) {
      if (!page.text) continue;
      let occ = 0;
      let termFound = null;
      let termFoundCount = 0;
      const matched = [];
      for (const { term, re } of regexes) {
        re.lastIndex = 0;
        let n = 0;
        while (re.exec(page.text) !== null) n++;
        if (n > 0) {
          matched.push({ term, count: n });
          occ += n;
          if (term === terms[0] || termFoundCount === 0) {
            // Le terme tapé prime ; sinon le premier synonyme trouvé.
            if (term === terms[0]) { termFound = term; termFoundCount = n; }
            else if (!termFound) { termFound = term; termFoundCount = n; }
          }
        }
      }
      if (occ === 0) continue;
      total++;
      if (results.length >= limit) continue;
      const section = (m.sections || []).find((s) => String(s.key) === String(page.section));
      const { excerpt, excerptHtml } = makeExcerpt(page.text, termFound);
      results.push({
        docId: doc.doc_id,
        docTitle: m.title || doc.title,
        docShort: m.short || doc.doc_id,
        page: page.pdf_page,
        printedLabel: page.printed_label || null,
        section: page.section,
        sectionLabel: section ? section.label : ('Section ' + page.section),
        termFound,
        occurrences: occ,
        matchedTerms: matched,
        excerpt,
        excerptHtml,
      });
    }
  }
  return { results, total, truncated: total > results.length, terms };
}

// Libellé de page affiché : numéro imprimé quand il existe, sinon numéro PDF.
export function pageDisplayLabel(page) {
  return page.printed_label ? `p. ${page.printed_label}` : `page PDF ${page.pdf_page}`;
}
