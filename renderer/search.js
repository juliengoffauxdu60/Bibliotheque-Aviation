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
//
// v1.2.3 — recherche tolérante, par rangs (dans cet ordre) :
//  1. EXACT : comme avant, chaque mot d'un terme acceptant en plus son
//     pluriel en -s, dans les deux sens ;
//  2. PRÉFIXE : le dernier mot de chaque terme matche les mots qui
//     commencent par lui (frappe incomplète) — toujours calculé, en une
//     seule passe avec le rang exact. Le dernier mot incomplet est aussi
//     complété par les synonymes : s'il est le préfixe d'un terme de
//     groupe, les autres termes du groupe sont cherchés en préfixe
//     (« décro » trouve « stall » sur un texte anglais) ;
//  3. ET : repli multi-mots, seulement si exact + préfixe = 0 page —
//     chaque mot de contenu doit matcher (mot, synonyme, pluriel) ;
//  4. FLOU : seulement si exact + préfixe + ET = 0 page — distance
//     d'édition 1 (Damerau-Levenshtein) par mot de contenu de 4 lettres
//     minimum, au moins un mot ne matchant QUE par le flou. Le mot
//     corrigé par le flou ouvre aussi ses synonymes : une faute de
//     frappe dans une langue retrouve la page dans l'autre langue
//     (« décrohage » -> « décrochage » -> « stall »).
// Chaque résultat porte son rang (`tier`) et le mot réellement trouvé sur
// la page (`highlightTerm`, texte tel que dans la page).
import { fullSectionLabel } from './sections.js';

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

// Motif regex d'un seul caractère du terme : espace -> \s+ (à cheval sur un
// saut de ligne), apostrophe -> les trois formes, lettre -> sa classe
// d'accents, le reste échappé.
function charPattern(ch) {
  if (ch === ' ') return '\\s+';
  if (ch === "'" || ch === '’' || ch === '‘') return "[''’]";
  if (ACCENT_CLASSES[ch.toLowerCase()]) return ACCENT_CLASSES[ch.toLowerCase()];
  return escapeRegExp(ch);
}

// Construit une regex qui trouve `term` en mot entier, insensible à la casse
// et aux accents, y compris à cheval sur un saut de ligne (espaces -> \s+).
// Contrat inchangé (utilisé par renderer/highlight.js) : mot entier EXACT,
// sans pluriel ni préfixe.
export function buildTermRegex(term) {
  const parts = [];
  for (const ch of term) parts.push(charPattern(ch));
  // Mot entier : pas de lettre/chiffre/underscore juste avant ni juste après.
  return new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])${parts.join('')}(?![A-Za-zÀ-ÿ0-9_])`, 'gi');
}

// Motif regex d'un mot, avec son pluriel en -s accepté (rang exact) :
//  - mot sans « s » final (finissant par une lettre) -> motif + `[s]?` ;
//  - mot en « s » final de 4 lettres ou plus -> le « s » final devient `[s]?` ;
//  - mot en « s » de moins de 4 lettres -> exact seulement
//    (« bus » ne doit pas trouver « bu »).
function wordPatternPlural(word) {
  const norm = normalizeForLookup(word);
  const chars = [...word];
  let body = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (i === chars.length - 1 && norm.endsWith('s') && norm.length >= 4 && /[a-zà-ÿ]/i.test(ch)) {
      body += '[s]?';
    } else {
      body += charPattern(ch);
    }
  }
  if (!norm.endsWith('s') && /[a-zà-ÿ]$/.test(norm)) body += '[s]?';
  return body;
}

// Regex d'un terme en mot entier, chaque mot acceptant son pluriel (rang exact).
function buildPluralTermRegex(term) {
  const parts = term.split(/\s+/).map((w) => wordPatternPlural(w));
  return new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])${parts.join('\\s+')}(?![A-Za-zÀ-ÿ0-9_])`, 'gi');
}

// Regex d'un terme dont le DERNIER mot est un préfixe (frappe incomplète) :
// mots précédents en mot entier (pluriel accepté), dernier mot sans
// frontière droite, frontière gauche gardée. Le suffixe `[A-Za-zÀ-ÿ0-9_]*`
// consomme la fin du mot trouvé : le texte matché (highlightTerm) est le
// mot ENTIER (« décrochage » pour la frappe « décro »), pas le préfixe seul.
function buildPrefixTermRegex(term) {
  const words = term.split(/\s+/);
  const parts = words.map((w, i) => {
    if (i === words.length - 1) {
      return [...w].map((ch) => charPattern(ch)).join('') + '[A-Za-zÀ-ÿ0-9_]*';
    }
    return wordPatternPlural(w);
  });
  return new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])${parts.join('\\s+')}`, 'gi');
}

// Forme canonique d'une requête ou d'un terme de groupe pour la recherche
// de synonymes : chaque mot en « s » final de 4 lettres ou plus perd son
// « s » — « stall speeds » et « stall speed » désignent le même groupe,
// dans les deux sens (même règle que le pluriel du rang exact).
function canonicalForLookup(norm) {
  return norm.split(' ').map((w) => (
    w.endsWith('s') && w.length >= 4 ? w.slice(0, -1) : w
  )).join(' ');
}

// Élargit la requête via les synonymes. Retourne la liste des termes à chercher,
// requête d'origine en premier.
export function expandQuery(query, synonyms) {
  const q = normalizeForLookup(query);
  if (!q) return [];
  const found = [query.trim()];
  if (synonyms && Array.isArray(synonyms.groups)) {
    const cq = canonicalForLookup(q);
    for (const group of synonyms.groups) {
      const terms = group.terms || [];
      if (terms.some((t) => canonicalForLookup(normalizeForLookup(t)) === cq)) {
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

// Extrait autour de la première occurrence de la regex qui a RÉELLEMENT
// matché dans le texte original (mot entier, préfixe, ET ou flou —
// buildTermRegex(term) raterait par ex. « speeds » pour le terme « speed »).
function makeExcerpt(text, re) {
  const first = new RegExp(re.source, re.flags);
  first.lastIndex = 0;
  const m = first.exec(text);
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
  // On recale les bornes après la normalisation des espaces (approximatif mais
  // sûr : on surligne en cherchant le terme dans l'extrait nettoyé).
  const cleaned = raw;
  const inner = new RegExp(re.source, re.flags);
  inner.lastIndex = 0;
  const m2 = inner.exec(cleaned);
  let html;
  if (m2) {
    html = escapeHtml(cleaned.slice(0, m2.index))
      + '<mark>' + escapeHtml(cleaned.slice(m2.index, m2.index + m2[0].length)) + '</mark>'
      + escapeHtml(cleaned.slice(m2.index + m2[0].length));
  } else {
    html = escapeHtml(cleaned);
  }
  const prefix = start > 0 ? '… ' : '';
  const suffix = end < text.length ? ' …' : '';
  return { excerpt: prefix + raw + suffix, excerptHtml: prefix + html + suffix };
}

// ---------------------------------------------------------------------------
// Rangs ET et FLOU — mots de contenu de la requête
// ---------------------------------------------------------------------------

// Mots-outils (FR + EN) exclus des rangs ET et FLOU : ils ne portent pas
// le sens de la requête. Liste locale minimale — ne pas importer
// ai-retrieve.js ici (il importe search.js : ce serait circulaire).
const STOPWORDS = new Set([
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'a', 'au',
  'aux', 'dans', 'sur', 'sous', 'pour', 'par', 'avec', 'sans', 'en',
  'the', 'of', 'to', 'in', 'and', 'or', 'for', 'an',
]);

// Mots de contenu de la requête : mots normalisés, longueur >= 2, hors
// mots-outils ; un mot contenant un chiffre est gardé quelle que soit sa
// longueur (ex. « 172 »).
export function contentWords(query) {
  const norm = normalizeForLookup(query);
  if (!norm) return [];
  return norm.split(/[^a-z0-9]+/).filter((w) => {
    if (!w) return false;
    if (/\d/.test(w)) return true;
    if (w.length < 2) return false;
    return !STOPWORDS.has(w);
  });
}

// Variantes d'un mot de contenu : le mot lui-même + ses synonymes d'un seul
// mot (même test d'appartenance à un groupe que expandQuery, pluriel
// toléré comme lui) — les termes de groupe de plusieurs mots ne sont pas
// des variantes d'un mot isolé.
function wordVariants(word, synonyms) {
  const found = [word];
  if (synonyms && Array.isArray(synonyms.groups)) {
    const cw = canonicalForLookup(word);
    for (const group of synonyms.groups) {
      const terms = group.terms || [];
      if (terms.some((t) => canonicalForLookup(normalizeForLookup(t)) === cw)) {
        for (const t of terms) {
          const nt = normalizeForLookup(t);
          if (!nt.includes(' ') && nt !== word && !found.includes(nt)) found.push(nt);
        }
      }
    }
  }
  return found;
}

// Regex mot entier qui accepte n'importe laquelle des variantes (pluriel
// accepté pour chacune).
function buildWordAlternationRegex(variants) {
  const alt = variants.map((v) => wordPatternPlural(v)).join('|');
  return new RegExp(`(?<![A-Za-zÀ-ÿ0-9_])(?:${alt})(?![A-Za-zÀ-ÿ0-9_])`, 'gi');
}

// Motifs regex des variantes d'un mot normalisé à distance d'édition 1
// (Damerau-Levenshtein : 1 suppression, 1 insertion, 1 substitution,
// 1 transposition). Chaque lettre du mot est mappée sur sa classe
// d'accents comme buildTermRegex ; une lettre insérée ou substituée est
// la classe [A-Za-zÀ-ÿ]. Variantes dédupliquées.
function fuzzyWordPatterns(word) {
  const letters = [...word];
  const pats = new Set();
  const cls = (ch) => (ACCENT_CLASSES[ch] ? ACCENT_CLASSES[ch] : escapeRegExp(ch));
  const patOf = (arr) => arr.map(cls).join('');
  // 1 suppression
  for (let i = 0; i < letters.length; i++) {
    const a = letters.slice();
    a.splice(i, 1);
    pats.add(patOf(a));
  }
  // 1 insertion (la lettre insérée est une classe, pas 26 variantes)
  for (let i = 0; i <= letters.length; i++) {
    const a = letters.slice();
    a.splice(i, 0, '\u0001');
    pats.add(a.map((c) => (c === '\u0001' ? '[A-Za-zÀ-ÿ]' : cls(c))).join(''));
  }
  // 1 substitution (la lettre substituée est une classe)
  for (let i = 0; i < letters.length; i++) {
    const a = letters.slice();
    a[i] = '\u0001';
    pats.add(a.map((c) => (c === '\u0001' ? '[A-Za-zÀ-ÿ]' : cls(c))).join(''));
  }
  // 1 transposition de deux lettres adjacentes
  for (let i = 0; i < letters.length - 1; i++) {
    const a = letters.slice();
    const t = a[i];
    a[i] = a[i + 1];
    a[i + 1] = t;
    pats.add(patOf(a));
  }
  return [...pats];
}

// Liste des { term, re } du rang préfixe : chaque terme avec son dernier
// mot en préfixe, PLUS les synonymes des complétions du dernier mot.
// Si le dernier mot W est le préfixe d'un terme de groupe U (premier mot
// de U commençant par W, différent de W), chaque AUTRE terme M du groupe
// est cherché en préfixe — avec le dernier mot de la requête remplacé par
// M quand la requête a plusieurs mots (« vitesse de décroc » ->
// « vitesse de stall »). Les termes M dont le premier mot commence déjà
// par W sont exclus : la regex préfixe de W les couvre déjà.
// Ex. « décro » -> préfixes « décro » et « stall » (groupe décrochage/stall).
function prefixTermList(terms, synonyms) {
  const out = [];
  const seen = new Set();
  const push = (term) => {
    const words = normalizeForLookup(term).split(' ').filter(Boolean);
    const last = words[words.length - 1] || '';
    // Garde : dernier mot normalisé de 2 lettres minimum.
    if (last.length < 2) return;
    const key = term;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ term, re: buildPrefixTermRegex(term) });
  };
  for (const t of terms) push(t);
  if (synonyms && Array.isArray(synonyms.groups)) {
    for (const t of terms) {
      const words = normalizeForLookup(t).split(' ').filter(Boolean);
      const last = words[words.length - 1] || '';
      if (last.length < 2) continue;
      for (const group of synonyms.groups) {
        const gterms = group.terms || [];
        const completes = gterms.some((u) => {
          const fu = (normalizeForLookup(u).split(' ')[0] || '');
          return fu !== last && fu.startsWith(last);
        });
        if (!completes) continue;
        for (const m of gterms) {
          const fm = (normalizeForLookup(m).split(' ')[0] || '');
          if (fm.startsWith(last)) continue;
          const cand = words.length <= 1 ? m : [...words.slice(0, -1), m].join(' ');
          push(cand);
        }
      }
    }
  }
  return out;
}

// Termes de groupe d'un seul mot, normalisés (pour le pont flou -> synonyme).
function singleWordGroupTerms(synonyms) {
  const set = new Set();
  if (synonyms && Array.isArray(synonyms.groups)) {
    for (const group of synonyms.groups) {
      for (const t of group.terms || []) {
        const nt = normalizeForLookup(t);
        if (nt && !nt.includes(' ')) set.add(nt);
      }
    }
  }
  return set;
}

// Variantes CONCRÈTES (chaînes) d'un mot à distance d'édition 1
// (Damerau-Levenshtein : suppressions, insertions, substitutions,
// transpositions). Sert uniquement au pont flou -> synonyme : on y cherche
// les termes de groupe à distance 1 du mot tapé.
function concreteFuzzyVariants(word) {
  const letters = [...word];
  const out = new Set();
  for (let i = 0; i < letters.length; i++) {
    const a = letters.slice();
    a.splice(i, 1);
    out.add(a.join(''));
  }
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i <= letters.length; i++) {
    for (const ch of alphabet) {
      const a = letters.slice();
      a.splice(i, 0, ch);
      out.add(a.join(''));
    }
  }
  for (let i = 0; i < letters.length; i++) {
    for (const ch of alphabet) {
      const a = letters.slice();
      a[i] = ch;
      out.add(a.join(''));
    }
  }
  for (let i = 0; i < letters.length - 1; i++) {
    const a = letters.slice();
    const tmp = a[i];
    a[i] = a[i + 1];
    a[i + 1] = tmp;
    out.add(a.join(''));
  }
  out.delete(word);
  return out;
}

// Pont flou -> synonyme : les synonymes d'un seul mot des termes de groupe
// qui sont à distance d'édition 1 du mot tapé. Ex. « décrohage » : le mot
// corrigé « décrochage » est un terme de groupe, son synonyme « stall »
// est donc une variante floue du mot tapé — la faute de frappe dans une
// langue retrouve la page dans l'autre langue.
function fuzzyBridgeVariants(word, synonyms, groupTerms) {
  const corrected = [...concreteFuzzyVariants(word)].filter((v) => groupTerms.has(v));
  if (corrected.length === 0) return [];
  if (!synonyms || !Array.isArray(synonyms.groups)) return [];
  const mates = new Set();
  for (const group of synonyms.groups || []) {
    const terms = (group.terms || []).map((t) => normalizeForLookup(t));
    if (!terms.some((t) => corrected.includes(t))) continue;
    for (const t of terms) {
      if (!t.includes(' ') && !corrected.includes(t)) mates.add(t);
    }
  }
  return [...mates];
}
function countMatches(re, text) {
  re.lastIndex = 0;
  let n = 0;
  let first = null;
  let mm;
  while ((mm = re.exec(text)) !== null) {
    n++;
    if (first === null) first = mm[0];
  }
  return { count: n, first };
}

// Match d'une page contre une liste de { term, re } (rang exact ou préfixe).
// Le terme tapé prime ; sinon le premier synonyme trouvé. Retourne le
// nombre total d'occurrences, le terme trouvé, sa regex et le texte du
// premier match de ce terme.
function matchTermList(text, regexList, primaryTerm) {
  let occ = 0;
  let termFound = null;
  let termFoundCount = 0;
  let termFoundRe = null;
  let firstMatchText = null;
  const matched = [];
  for (const entry of regexList) {
    if (!entry) continue;
    const { term, re } = entry;
    const { count, first } = countMatches(re, text);
    if (count > 0) {
      matched.push({ term, count });
      occ += count;
      if (term === primaryTerm || termFoundCount === 0) {
        // Le terme tapé prime ; sinon le premier synonyme trouvé.
        if (term === primaryTerm) {
          termFound = term; termFoundCount = count; termFoundRe = re; firstMatchText = first;
        } else if (!termFound) {
          termFound = term; termFoundCount = count; termFoundRe = re; firstMatchText = first;
        }
      }
    }
  }
  return { occ, termFound, termFoundRe, firstMatchText, matched };
}

// Recherche dans les documents indexés.
// docs : [{ doc_id, title, pages: [{ pdf_page, printed_label, section, text }] }]
//        dans l'ordre d'affichage (172N, 172R, 150, SOP).
// meta : { [doc_id]: { short, title, sections: [{key,label,startPage}] } }
// opts : { scope: 'all' | doc_id, limit }
// Retourne { results, total, truncated, terms, tierCounts } — results en
// ordre de lecture dans chaque rang, rangs dans l'ordre exact, préfixe,
// ET, flou ; le plafond `limit` se remplit dans l'ordre des rangs.
// Chaque résultat porte en plus `tier` et `highlightTerm` (mot ou expression
// réellement trouvé sur la page).
export function searchDocs(docs, meta, query, synonyms, opts = {}) {
  const terms = expandQuery(query, synonyms);
  const emptyTierCounts = { exact: 0, prefix: 0, and: 0, fuzzy: 0 };
  if (terms.length === 0) {
    return { results: [], total: 0, truncated: false, terms: [], tierCounts: emptyTierCounts };
  }
  const scope = opts.scope || 'all';
  const limit = opts.limit || (scope === 'all' ? 500 : 1000);
  const tierCounts = { exact: 0, prefix: 0, and: 0, fuzzy: 0 };
  // L'extrait n'est calculé qu'après le plafond (comme avant) : on garde
  // la regex qui a matché dans chaque enregistrement en attente.
  // Un tableau par rang : les résultats sont rendus exacts, puis préfixe,
  // puis ET, puis flou (ordre de lecture dans chaque rang), et le plafond
  // `limit` se remplit dans l'ordre des rangs.
  const pendingByTier = { exact: [], prefix: [], and: [], fuzzy: [] };
  const pushPending = (doc, m, page, tier, termFound, highlightTerm, occurrences, matched, excerptRe) => {
    pendingByTier[tier].push({ doc, m, page, tier, termFound, highlightTerm, occurrences, matched, excerptRe });
  };
  const sectionOf = (m, page) => (
    (m.sections || []).find((s) => String(s.key) === String(page.section))
  );

  // --- Rangs exact + préfixe, en une seule passe. Une page est « exact »
  // si elle a au moins une occurrence exacte, sinon « préfixe ».
  const exactRes = terms.map((t) => ({ term: t, re: buildPluralTermRegex(t) }));
  const prefixRes = prefixTermList(terms, synonyms);
  for (const doc of docs) {
    if (scope !== 'all' && doc.doc_id !== scope) continue;
    const m = meta[doc.doc_id] || {};
    for (const page of doc.pages) {
      if (!page.text) continue;
      const found = matchTermList(page.text, exactRes, terms[0]);
      if (found.occ > 0) {
        tierCounts.exact++;
        pushPending(doc, m, page, 'exact', found.termFound, found.firstMatchText,
          found.occ, found.matched, found.termFoundRe);
        continue;
      }
      const pre = matchTermList(page.text, prefixRes, terms[0]);
      if (pre.occ > 0) {
        tierCounts.prefix++;
        pushPending(doc, m, page, 'prefix', pre.termFound, pre.firstMatchText,
          pre.occ, pre.matched, pre.termFoundRe);
      }
    }
  }

  // --- Rang ET (repli multi-mots), seulement si exact + préfixe = 0 page.
  const content = contentWords(query);
  if (tierCounts.exact + tierCounts.prefix === 0 && content.length >= 2) {
    const wordRes = content.map((w) => ({
      word: w, re: buildWordAlternationRegex(wordVariants(w, synonyms)),
    }));
    for (const doc of docs) {
      if (scope !== 'all' && doc.doc_id !== scope) continue;
      const m = meta[doc.doc_id] || {};
      for (const page of doc.pages) {
        if (!page.text) continue;
        let occ = 0;
        let firstText = null;
        let firstRe = null;
        const matched = [];
        let allOk = true;
        for (const { word, re } of wordRes) {
          const { count, first } = countMatches(re, page.text);
          if (count === 0) { allOk = false; break; }
          occ += count;
          matched.push({ term: word, count });
          if (firstText === null) { firstText = first; firstRe = re; }
        }
        if (!allOk) continue;
        tierCounts.and++;
        // highlightTerm : le premier mot de contenu trouvé sur la page.
        pushPending(doc, m, page, 'and', firstText, firstText, occ, matched, firstRe);
      }
    }
  }

  // --- Rang flou, seulement si exact + préfixe + ET = 0 page.
  if (tierCounts.exact + tierCounts.prefix + tierCounts.and === 0) {
    const fuzzyWords = content.filter((w) => w.length >= 4);
    if (fuzzyWords.length > 0) {
      const groupTerms = singleWordGroupTerms(synonyms);
      const wordRes = content.map((w) => {
        const variants = wordVariants(w, synonyms);
        const exactRe = buildWordAlternationRegex(variants);
        let combinedRe = exactRe;
        if (w.length >= 4) {
          const alt = [
            ...variants.map((v) => wordPatternPlural(v)),
            ...fuzzyWordPatterns(w),
            // Pont flou -> synonyme (variantes floues, pas exactes : une
            // page qui ne matche que par ce pont reste un résultat flou).
            ...fuzzyBridgeVariants(w, synonyms, groupTerms).map((v) => wordPatternPlural(v)),
          ].join('|');
          combinedRe = new RegExp(
            `(?<![A-Za-zÀ-ÿ0-9_])(?:${alt})(?![A-Za-zÀ-ÿ0-9_])`, 'gi');
        }
        return { word: w, exactRe, combinedRe };
      });
      for (const doc of docs) {
        if (scope !== 'all' && doc.doc_id !== scope) continue;
        const m = meta[doc.doc_id] || {};
        for (const page of doc.pages) {
          if (!page.text) continue;
          let occ = 0;
          let fuzzyOnlyFirst = null;
          let fuzzyOnlyRe = null;
          const matched = [];
          let allOk = true;
          for (const { word, exactRe, combinedRe } of wordRes) {
            const exact = countMatches(exactRe, page.text);
            const combined = countMatches(combinedRe, page.text);
            if (combined.count === 0) { allOk = false; break; }
            occ += combined.count;
            matched.push({ term: word, count: combined.count });
            // Mot qui ne matche QUE par le flou : aucun match exact.
            if (exact.count === 0 && fuzzyOnlyFirst === null) {
              fuzzyOnlyFirst = combined.first;
              fuzzyOnlyRe = combinedRe;
            }
          }
          if (!allOk || fuzzyOnlyFirst === null) continue;
          tierCounts.fuzzy++;
          pushPending(doc, m, page, 'fuzzy', fuzzyOnlyFirst, fuzzyOnlyFirst,
            occ, matched, fuzzyOnlyRe);
        }
      }
    }
  }

  const total = tierCounts.exact + tierCounts.prefix + tierCounts.and + tierCounts.fuzzy;
  const kept = [...pendingByTier.exact, ...pendingByTier.prefix, ...pendingByTier.and, ...pendingByTier.fuzzy]
    .slice(0, limit);
  const results = kept.map((p) => {
    const section = sectionOf(p.m, p.page);
    const { excerpt, excerptHtml } = makeExcerpt(p.page.text, p.excerptRe);
    return {
      docId: p.doc.doc_id,
      docTitle: p.m.title || p.doc.title,
      docShort: p.m.short || p.doc.doc_id,
      page: p.page.pdf_page,
      printedLabel: p.page.printed_label || null,
      section: p.page.section,
      sectionLabel: section ? fullSectionLabel(section) : ('Section ' + p.page.section),
      termFound: p.termFound,
      highlightTerm: p.highlightTerm,
      tier: p.tier,
      occurrences: p.occurrences,
      matchedTerms: p.matched,
      excerpt,
      excerptHtml,
    };
  });
  return { results, total, truncated: total > results.length, terms, tierCounts };
}

// Libellé de page affiché : numéro imprimé quand il existe, sinon numéro PDF.
export function pageDisplayLabel(page) {
  return page.printed_label ? `p. ${page.printed_label}` : `page PDF ${page.pdf_page}`;
}
