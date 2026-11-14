// Récupération du contexte local pour « Poser une question ».
// Réutilise le moteur de recherche existant (renderer/search.js) — il n'est
// pas réécrit ici. Lit la MÊME liste de documents que la recherche
// (data/docs.json) : documents fournis + tout document ajouté à docs.json.
// Module pur (aucune dépendance Electron) : testé en Node seul
// (test/ai.test.mjs) et importé par renderer/ai.js.
import { searchDocs, buildTermRegex, normalizeForLookup } from './search.js';

// Mots sans contenu pour une question en langage naturel : ils ne servent
// pas à retrouver des pages. On garde les mots de 3 lettres et plus (et les
// mots courts qui contiennent un chiffre, ex. « 150 », « 172n »).
const STOPWORDS = new Set([
  'le', 'la', 'les', 'de', 'des', 'du', 'un', 'une', 'et', 'ou', 'à', 'au', 'aux',
  'dans', 'sur', 'sous', 'pour', 'par', 'avec', 'sans', 'est', 'sont', 'il', 'elle',
  'ils', 'elles', 'ce', 'ces', 'cette', 'que', 'qui', 'quoi', 'comment', 'pourquoi',
  'quand', 'où', 'quel', 'quelle', 'quels', 'quelles', 'combien', 'plus', 'moins',
  'entre', 'vers', 'chez', 'tout', 'tous', 'toute', 'toutes', 'mon', 'ma', 'mes',
  'son', 'sa', 'ses', 'notre', 'nos', 'votre', 'vos', 'leur', 'leurs', 'je', 'tu',
  'nous', 'vous', 'on', 'ne', 'pas', 'se', 'si', 'comme', 'mais', 'donc', 'car',
  'en', 'être', 'avoir', 'faire', 'peut', 'peuvent', 'doit', 'doivent', 'faut',
  'y', 'a', 'ai', 'as', 'avons', 'avez', 'ont', 'suis', 'es', 'sommes', 'êtes',
  'serait', 'aurait', 'donne', 'donner', 'dit', 'dire',
  'the', 'is', 'are', 'of', 'to', 'in', 'and', 'or', 'for', 'what', 'how', 'when',
  'why', 'does', 'do', 'an', 'it', 'its', 'this', 'that', 'with', 'from', 'by',
  'at', 'on', 'as', 'if', 'then', 'than', 'so', 'such',
]);

// Extrait aussi les expressions de 2-3 mots consécutifs de la question
// (bornes = mots de contenu) : le moteur n'élargit par les synonymes que
// quand la requête ÉGALE un terme d'un groupe — « pression d'huile » trouve
// « oil pressure », mais le mot seul « pression » ne le trouve pas.
// Ex. « Quelle est la pression d'huile ? » -> ["pression d'huile"].
// Ex. « Quelle est la vitesse de décrochage ? » -> ["vitesse de décrochage"].
export function extractQuestionPhrases(question) {
  // Même normalisation de l'apostrophe que dans extractQuestionTerms.
  const norm = normalizeForLookup(question || '').replace(/’/g, "'");
  // L'apostrophe fait partie du mot (« d'huile ») : la classe inclut
  // l'apostrophe droite ' et les courbes ’ ‘ (sinon « d'huile » se coupe
  // en « d » + « huile » et l'expression ne correspond plus au groupe
  // de synonymes « pression d'huile »).
  const tokens = norm.split(/[^a-z0-9'’‘]+/).filter(Boolean);
  const isContent = (t) => !STOPWORDS.has(t) && t.length >= 2;
  const out = [];
  for (let len = 3; len >= 2; len--) {
    for (let i = 0; i + len <= tokens.length; i++) {
      const win = tokens.slice(i, i + len);
      if (!isContent(win[0]) || !isContent(win[win.length - 1])) continue;
      const phrase = win.join(' ');
      if (!out.includes(phrase)) out.push(phrase);
    }
  }
  return out.slice(0, 6);
}
// Ex. « Quelle est la vitesse de décrochage du 172N ? »
//  -> ['vitesse', 'decrochage', '172n'] (normalisés : sans accents, minuscules).
export function extractQuestionTerms(question) {
  // normalizeForLookup laisse passer ’ (U+2019) : on le ramène à
  // l'apostrophe droite, sinon l'égalité stricte d'expandQuery rate les
  // groupes de synonymes (« pression d'huile »).
  const norm = normalizeForLookup(question || '').replace(/’/g, "'");
  const tokens = norm.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    if (STOPWORDS.has(t)) continue;
    const hasDigit = /\d/.test(t);
    if (t.length < 3 && !hasDigit) continue;
    if (t.length < 2) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.slice(0, 8);
}

function pageLabel(page) {
  const printed = page.printed_label || page.printedLabel;
  const num = page.pdf_page || page.page;
  return printed ? `p. ${printed}` : `page PDF ${num}`;
}

// Fenêtre de texte autour de la première occurrence d'un des termes sur la
// page (coupée aux limites de mots, espaces repliés).
function contextWindow(text, terms) {
  let firstPos = -1;
  let firstLen = 0;
  for (const term of terms) {
    const re = buildTermRegex(term);
    const m = re.exec(text);
    if (m && (firstPos === -1 || m.index < firstPos)) {
      firstPos = m.index;
      firstLen = m[0].length;
    }
  }
  if (firstPos === -1) return text.slice(0, 1200).replace(/\s+/g, ' ').trim();
  let start = Math.max(0, firstPos - 500);
  let end = Math.min(text.length, firstPos + firstLen + 900);
  if (start > 0) {
    const sp = text.indexOf(' ', start);
    if (sp !== -1 && sp < firstPos) start = sp + 1;
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > firstPos + firstLen) end = sp;
  }
  const raw = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '… ' : '') + raw + (end < text.length ? ' …' : '');
}

// Retrouve les meilleures pages pour une question, dans les index locaux.
// docs : index JSON [{ doc_id, title, pages: [{ pdf_page, printed_label,
//   section, text }] }] — dans l'ordre d'affichage.
// meta : { [doc_id]: { short, title, sections: [{key,label,startPage}] } }.
// Retourne { pages, terms } — pages triées par pertinence (6 max) :
// [{ docId, docTitle, sectionLabel, pageLabel, page, excerpt, occurrences,
//    matchedTerms }].
// Règle de tri : une page qui contient PLUSIEURS termes distincts de la
// question prime sur une page qui répète un seul terme.
export function retrieveContext(docs, meta, synonyms, question, opts = {}) {
  const maxPages = opts.maxPages || 6;
  const terms = extractQuestionTerms(question);
  if (terms.length === 0) return { pages: [], terms };
  const byKey = new Map(); // "docId:page" -> { result, score, terms:Set, phrase }
  const add = (res, score, term, isPhrase) => {
    const key = res.docId + ':' + res.page;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { result: res, score: 0, terms: new Set(), phrase: false };
      byKey.set(key, entry);
    }
    entry.score += score;
    if (term) entry.terms.add(term);
    if (isPhrase) entry.phrase = true;
  };

  // 1) La question entière comme expression exacte (utile quand l'utilisateur
  // tape directement une expression du manuel, ex. « vitesse de décrochage »).
  const phraseRes = searchDocs(docs, meta, (question || '').trim(), synonyms, { limit: 3 });
  for (const r of phraseRes.results) add(r, 25, null, true);

  // 1b) Les expressions de 2-3 mots de la question (« pression d'huile »,
  // « vitesse de décrochage ») : elles déclenchent l'expansion synonymes
  // du moteur, que les mots seuls ne déclenchent pas.
  for (const phrase of extractQuestionPhrases(question)) {
    const res = searchDocs(docs, meta, phrase, synonyms, { limit: 3 });
    for (const r of res.results) add(r, 25, r.termFound, true);
  }

  // 2) Chaque terme (avec expansion synonymes du moteur : « décrochage »
  // trouve aussi « stall », « pression d'huile » trouve « oil pressure »…).
  for (const term of terms) {
    const res = searchDocs(docs, meta, term, synonyms, { limit: 5 });
    for (const r of res.results) {
      // +10 par terme distinct, +1 par occurrence (plafonné à 5).
      add(r, 10 + Math.min(r.occurrences, 5), r.termFound, false);
    }
  }

  const ranked = [...byKey.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const docOrder = (d) => docs.findIndex((x) => x.doc_id === d);
      const da = docOrder(a.result.docId) - docOrder(b.result.docId);
      if (da !== 0) return da;
      return a.result.page - b.result.page;
    })
    .slice(0, maxPages);

  // Texte brut de chaque page, pour la fenêtre de contexte.
  const textByKey = new Map();
  for (const doc of docs) {
    for (const p of doc.pages || []) textByKey.set(doc.doc_id + ':' + p.pdf_page, p);
  }
  const pages = ranked.map(({ result, terms: matched }) => {
    const raw = textByKey.get(result.docId + ':' + result.page);
    const excerpt = raw
      ? contextWindow(raw.text || '', [...matched])
      : result.excerpt;
    return {
      docId: result.docId,
      docTitle: result.docTitle,
      sectionLabel: result.sectionLabel,
      pageLabel: pageLabel(raw || result),
      page: result.page,
      excerpt,
      occurrences: result.occurrences,
      matchedTerms: [...matched],
    };
  });
  return { pages, terms };
}
