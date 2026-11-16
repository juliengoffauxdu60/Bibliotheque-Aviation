// Tests de la recherche tolérante v1.2.3 (Node, sans Electron).
// Rangs : exact (+ pluriels), préfixe (dernier mot incomplet),
// ET (repli multi-mots), flou (distance d'édition 1).
// Fixtures SYNTHÉTIQUES (test/fixtures/synthetic/) — NE PAS modifier —
// puis section sur les INDEX RÉELS de Julien (/home/hatch/uploads/),
// skippée proprement si les fichiers sont absents (ils ne sont pas
// dans le dépôt).
//
// VALEURS MESURÉES, pas prédites : plusieurs comptes du brief initial
// étaient sous-estimés parce qu'ils oubliaient l'expansion synonymique
// dans les nouveaux rangs ou d'autres mots qui commencent par le préfixe.
// Chaque écart est documenté par un commentaire « MESURÉ » ci-dessous ;
// le comportement mesuré est celui que la spécification demande :
//  - le pluriel est toléré AUSSI dans l'expansion synonymique
//    (« speeds » se comporte comme « speed », donc trouve « vitesse ») ;
//  - le rang ET inclut les synonymes (spécification : « le mot lui-même
//    + ses synonymes d'un seul mot ») ;
//  - le rang préfixe matche TOUS les mots qui commencent par la frappe
//    (« sta » trouve aussi « stay », « décro » aussi « décroissante ») ;
//  - le préfixe et le flou traversent la barrière FR/EN via les synonymes
//    (« décro » trouve « stall » sur un texte anglais, « décrohage »
//    trouve « stall » via le mot corrigé « décrochage ») — sans ça,
//    « décro » et « décrohage » ne trouveraient RIEN sur le C150N,
//    dont le texte est en anglais : c'est exactement la panne que la
//    v1.2.3 doit réparer ;
//  - le rang préfixe est calculé AVANT le flou : « stal » trouve
//    « stall » par préfixe (4 pages sur les fixtures avant expansion,
//    7 avec), le flou ne se déclenche donc pas pour lui.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDocs } from '../renderer/search.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
const synthetic = path.join(root, 'fixtures', 'synthetic');
const docsMeta = JSON.parse(fs.readFileSync(path.join(synthetic, 'data/docs.json'), 'utf8'));
const synonyms = JSON.parse(fs.readFileSync(path.join(base, 'data/synonyms.json'), 'utf8'));
const docs = docsMeta.docs.map((d) => JSON.parse(fs.readFileSync(path.join(synthetic, d.index), 'utf8')));
const meta = {};
for (const d of docsMeta.docs) meta[d.id] = d;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function search(q, opts) {
  return searchDocs(docs, meta, q, synonyms, opts || { scope: 'all', limit: 1000 });
}
function pagesOf(res, docId) {
  return res.results.filter((r) => r.docId === docId).map((r) => r.page);
}

// ---------------------------------------------------------------------------
// 1. Rang préfixe (fixtures synthétiques)
// ---------------------------------------------------------------------------
// « décro » : 3 pages FR (« décrochage » syn-fr p. 2, 6, 8) + 4 pages EN
// via le synonyme « stall » (syn-en p. 2, 6, 7 + syn-mix p. 3).
// MESURÉ 7, pas 3 : le préfixe traverse FR/EN comme le rang exact.
const decro = search('décro');
check('décro : 7 pages, rang préfixe', [decro.total, decro.tierCounts], [7, { exact: 0, prefix: 7, and: 0, fuzzy: 0 }]);
check('décro : pages syn-fr', pagesOf(decro, 'syn-fr'), [2, 6, 8]);
check('décro : pages syn-en + syn-mix (via stall)', [pagesOf(decro, 'syn-en'), pagesOf(decro, 'syn-mix')], [[2, 6, 7], [3]]);
check('décro : highlightTerm = le mot entier trouvé',
  decro.results.find((r) => r.docId === 'syn-fr' && r.page === 2).highlightTerm, 'décrochage');
check('décro : extrait surligné', decro.results.every((r) => r.excerptHtml.includes('<mark>')), true);

// « vitess » : 2 pages FR (« vitesse ») + 3 pages EN via « speed ».
// MESURÉ 5, pas 2 (même raison que « décro »).
const vitess = search('vitess');
check('vitess : 5 pages, rang préfixe', [vitess.total, vitess.tierCounts.prefix], [5, 5]);
check('vitess : highlightTerm syn-en p. 2', vitess.results.find((r) => r.docId === 'syn-en' && r.page === 2).highlightTerm, 'stall speed');

// « sta » : « stall » (syn-en p. 2, 6, 7 + syn-mix p. 3) + « stay »
// (syn-en p. 4 — un mot qui commence par « sta », comme « stall »)
// + « décrochage » via synonyme (syn-fr p. 2, 6, 8).
// MESURÉ 8, pas 4 : le préfixe ne se limite pas au mot attendu.
const sta = search('sta');
check('sta : 8 pages, rang préfixe', [sta.total, sta.tierCounts.prefix], [8, 8]);
check('sta : syn-en p. 4 trouvée via « stay »',
  sta.results.some((r) => r.docId === 'syn-en' && r.page === 4 && r.highlightTerm === 'stay'), true);

// ---------------------------------------------------------------------------
// 2. Rang exact + pluriels
// ---------------------------------------------------------------------------
// « stall speeds » : 3 pages EN (« stall speed ») + 2 pages FR
// (« vitesse de décrochage ») via l'expansion synonymique tolérante
// au pluriel (« stall speeds » désigne le groupe « stall speed »).
const ss = search('stall speeds');
check('stall speeds : 5 pages, rang exact', [ss.total, ss.tierCounts], [5, { exact: 5, prefix: 0, and: 0, fuzzy: 0 }]);
check('stall speeds : highlightTerm FR = la phrase trouvée',
  ss.results.find((r) => r.docId === 'syn-fr' && r.page === 2).highlightTerm, 'vitesse de décrochage');

// « speeds » : « speed » au pluriel, 3 pages EN + 2 pages FR via
// l'expansion (« speeds » -> groupe « speed » -> « vitesse »).
// MESURÉ 5, pas 3 : le pluriel ne coupe pas l'expansion synonymique.
const speeds = search('speeds');
check('speeds : 5 pages, rang exact', [speeds.total, speeds.tierCounts.exact], [5, 5]);
check('speeds : highlightTerm EN = « speed » (singulier trouvé)',
  speeds.results.find((r) => r.docId === 'syn-en' && r.page === 2).highlightTerm, 'speed');
check('speeds : highlightTerm FR = « vitesse »',
  speeds.results.find((r) => r.docId === 'syn-fr' && r.page === 2).highlightTerm, 'vitesse');

// « vitesse de décrochages » : pluriel FR, 2 pages FR + 3 pages EN
// (« stall speed ») via l'expansion tolérante au pluriel.
// MESURÉ 5, pas 2 (symétrique de « speeds »).
const vd = search('vitesse de décrochages');
check('vitesse de décrochages : 5 pages, rang exact', [vd.total, vd.tierCounts.exact], [5, 5]);

// Garde pluriel : « les » (3 lettres, en « s ») est exact seulement —
// il ne trouve pas « le » (syn-fr p. 2 porte « Le décrochage »,
// « Le carburant », « Le réservoir », aucune ne doit matcher).
const les = search('les');
check('garde pluriel : « les » ne trouve pas « le » (4 pages)', [les.total, pagesOf(les, 'syn-fr')], [4, [1, 4, 5, 6]]);
check('garde pluriel : « bus » ne trouve pas « bu »', search('bus').total, 0);

// ---------------------------------------------------------------------------
// 3. Rang ET (repli multi-mots)
// ---------------------------------------------------------------------------
// « décrochage vitesse » : l'expression n'existe nulle part, le préfixe
// non plus (dernier mot « vitesse » : aucune page n'a « décrochage »
// suivi d'un mot en « vitesse* ») — le rang ET trouve les pages qui ont
// (décrochage OU stall) ET (vitesse OU speed) : 2 FR + 3 EN.
// MESURÉ 5, pas 2 : le rang ET inclut les synonymes (spécification).
const et = search('décrochage vitesse');
check('décrochage vitesse : 5 pages, rang ET', [et.total, et.tierCounts], [5, { exact: 0, prefix: 0, and: 5, fuzzy: 0 }]);
check('décrochage vitesse : highlightTerm = 1er mot de contenu trouvé',
  et.results.find((r) => r.docId === 'syn-fr' && r.page === 2).highlightTerm, 'décrochage');
check('décrochage vitesse : highlightTerm EN = « stall »',
  et.results.find((r) => r.docId === 'syn-en' && r.page === 2).highlightTerm, 'stall');

// ---------------------------------------------------------------------------
// 4. Rang flou
// ---------------------------------------------------------------------------
// « décrohage » (insertion d'un « c ») : 3 pages FR (« décrochage »)
// + 4 pages EN via le pont flou -> synonyme (« décrochage » -> « stall »).
// MESURÉ 7, pas 3 (même traversée FR/EN que le préfixe).
const fuzzy = search('décrohage');
check('décrohage : 7 pages, rang flou', [fuzzy.total, fuzzy.tierCounts], [7, { exact: 0, prefix: 0, and: 0, fuzzy: 7 }]);
check('décrohage : highlightTerm = le mot corrigé',
  fuzzy.results.find((r) => r.docId === 'syn-fr' && r.page === 2).highlightTerm, 'décrochage');
check('décrohage : extrait surligné', fuzzy.results.every((r) => r.excerptHtml.includes('<mark>')), true);

// « stal » : une lettre manquante, mais « stall » commence par « stal » —
// le rang préfixe le trouve AVANT le flou (le flou ne se déclenche que
// si exact + préfixe + ET = 0). MESURÉ : 7 pages, rang PRÉFIXE (4 « stal* »
// + 3 « décrochage » via synonyme), pas flou — le compte est le même
// qu'attendu pour le flou (4 avant expansion), le rang diffère.
const stal = search('stal');
check('stal : 7 pages, rang préfixe (pas flou)', [stal.total, stal.tierCounts], [7, { exact: 0, prefix: 7, and: 0, fuzzy: 0 }]);

// « stalll » (un « l » de trop, suppression) : le préfixe ne matche rien
// (aucun mot ne commence par « stalll »), le flou trouve « stall »
// + « décrochage » via le pont. MESURÉ 7, pas 4 (pont FR/EN).
const stalll = search('stalll');
check('stalll : 7 pages, rang flou', [stalll.total, stalll.tierCounts.fuzzy], [7, 7]);

// Flou multi-mots : « décrohage vitesse » — « décrohage » ne matche que
// par le flou, « vitesse » exactement (ou « speed »). 2 FR + 3 EN.
const fuzzyMulti = search('décrohage vitesse');
check('décrohage vitesse : 5 pages, rang flou', [fuzzyMulti.total, fuzzyMulti.tierCounts], [5, { exact: 0, prefix: 0, and: 0, fuzzy: 5 }]);

// ---------------------------------------------------------------------------
// 5. Gardes : exact sans flou, absent, mot court avec faute
// ---------------------------------------------------------------------------
const exact = search('décrochage');
check('décrochage exact : 7 pages, rang exact, pas de flou',
  [exact.total, exact.tierCounts], [7, { exact: 7, prefix: 0, and: 0, fuzzy: 0 }]);
check('zzzqqq : 0 résultat', search('zzzqqq').total, 0);
// « fue » (3 lettres) : préfixe seulement (« fuel » syn-en p. 2, 3 +
// syn-mix p. 2, « carburant » syn-fr p. 2, 7 via le synonyme « fuel »),
// pas de flou (mot < 4 lettres + préfixe non vide).
const fue = search('fue');
check('fue : préfixe seulement, pas de flou', [fue.tierCounts.prefix > 0, fue.tierCounts.fuzzy], [true, 0]);

// ---------------------------------------------------------------------------
// 6. Ordre des rangs et plafond
// ---------------------------------------------------------------------------
// « le » : 7 exacts puis 2 préfixes (« Lean » syn-en p. 8,
// « level » syn-mix p. 2) — l'ordre de lecture est respecté dans
// chaque rang, les exacts d'abord.
const le = search('le');
check('ordre : exacts avant préfixes',
  [le.results.slice(0, 7).every((r) => r.tier === 'exact'), le.results.slice(7).every((r) => r.tier === 'prefix')],
  [true, true]);
const capped = search('décro', { scope: 'all', limit: 4 });
check('plafond : limité à 4 + tronqué signalé', [capped.results.length, capped.truncated], [4, true]);
check('tierCounts présent sur un résultat vide', JSON.stringify(search('zzzqqq').tierCounts),
  JSON.stringify({ exact: 0, prefix: 0, and: 0, fuzzy: 0 }));

// ---------------------------------------------------------------------------
// 7. Index réels de Julien (skippés si absents — ils ne sont pas en dépôt)
// ---------------------------------------------------------------------------
const REAL = {
  aim: '/home/hatch/uploads/9DF2D609-0DB5-4FCA-A133-94B7FB9F8CEB/index.json',
  pa44: '/home/hatch/uploads/42E1149A-CD8D-411C-BD99-DD8E9AF566B0/index.json',
  c150n: '/home/hatch/uploads/5180CA8F-96FF-4D4A-9F46-535592024C5D/index.json',
};
const realPresent = Object.values(REAL).every((p) => fs.existsSync(p));
if (!realPresent) {
  console.log('SKIP section index réels : fichiers /home/hatch/uploads/... absents');
} else {
  const loadReal = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  const realDocs = [loadReal(REAL.c150n), loadReal(REAL.aim), loadReal(REAL.pa44)];
  const realMeta = {};
  for (const d of realDocs) realMeta[d.doc_id] = { title: d.title, short: d.doc_id, sections: [] };
  const rq = (doc, q) => searchDocs([doc], realMeta, q, synonyms, { scope: 'all', limit: 1000 });
  const c150 = realDocs[0];
  const aim = realDocs[1];
  const pa44 = realDocs[2];
  const pages = (r) => r.results.map((x) => x.page);

  // C150N « vitesse de décrochage » : 2 pages avant (« stall speed »
  // p. 3, 31) + 3 pages « Stall speeds » (p. 56, 62, 71 — le tableau
  // p. 71 est trouvé grâce au pluriel).
  const c150v = rq(c150, 'vitesse de décrochage');
  check('C150N vitesse de décrochage : 5 pages, rang exact',
    [c150v.total, c150v.tierCounts.exact, pages(c150v)], [5, 5, [3, 31, 56, 62, 71]]);
  // C150N « décro » : le texte est en anglais (« stall », pas
  // « décrochage ») — le préfixe traverse via le synonyme « stall ».
  // MESURÉ 14, pas 10 : 10 pages « stall » + 3 pages « Stalls »
  // (p. 20, 22, 41) + 1 page « Stalling » (p. 12).
  const c150d = rq(c150, 'décro');
  check('C150N décro : 14 pages, rang préfixe',
    [c150d.total, c150d.tierCounts.prefix, pages(c150d)],
    [14, 14, [3, 12, 20, 22, 31, 37, 41, 45, 56, 57, 58, 62, 71, 128]]);
  // C150N « décrohage » : le flou corrige en « décrochage » puis
  // traverse vers « stall ». MESURÉ 13, pas 10 : 10 « stall » +
  // 3 « Stalls » (p. 20, 22, 41) — « Stalling » (p. 12) ne matche
  // pas en mot entier flou.
  const c150f = rq(c150, 'décrohage');
  check('C150N décrohage : 13 pages, rang flou',
    [c150f.total, c150f.tierCounts.fuzzy, pages(c150f)],
    [13, 13, [3, 20, 22, 31, 37, 41, 45, 56, 57, 58, 62, 71, 128]]);
  // C150N « décrochage 172 » : « 172 » seul ne trouve que p. 190-192,
  // qui ne parlent pas de décrochage — le rang ET ne trouve rien
  // (mesuré : 0 page sur les trois index ; AIM « 172 » = 4 pages —
  // p. 16, 206, 271 exactes + p. 211 « 172000Z » en préfixe, un horaire
  // METAR ; PA-44 « 172 » = 0 page).
  check('C150N 172 seul : 3 pages', pages(rq(c150, '172')), [190, 191, 192]);
  check('AIM 172 seul : 4 pages (3 exactes + p. 211 « 172000Z » en préfixe)',
    [rq(aim, '172').total, rq(aim, '172').tierCounts, pages(rq(aim, '172'))],
    [4, { exact: 3, prefix: 1, and: 0, fuzzy: 0 }, [16, 206, 271, 211]]); // exacts d'abord, puis préfixe
  check('PA-44 172 seul : 0 page', rq(pa44, '172').total, 0);
  check('C150N décrochage 172 : 0 page (aucune intersection)', rq(c150, 'décrochage 172').total, 0);
  // Cas ET qui trouve des pages (choisi après mesure de « 172 ») :
  // « décrochage volets » — (décrochage OU stall, pluriels inclus)
  // ET (volets OU flaps, pluriels inclus) : p. 3, 31, 56, 58 +
  // p. 20, 22, 41 (« Stalls ») + p. 71 (« FLAP » singulier).
  const c150et = rq(c150, 'décrochage volets');
  check('C150N décrochage volets : 8 pages, rang ET',
    [c150et.total, c150et.tierCounts.and, pages(c150et)],
    [8, 8, [3, 20, 22, 31, 41, 56, 58, 71]]);
  // AIM : « vitesse de décrochage » 8 exacts ; « décro » 15 préfixes
  // (11 « décrochage » + p. 252 « décroissante », p. 470 « décroît » /
  // « décroissance », p. 482 « décroiser », p. 494 « décroître ») ;
  // « décrohage » 11 flous ; « décrochage volets » 4 ET.
  const aimv = rq(aim, 'vitesse de décrochage');
  check('AIM vitesse de décrochage : 8 pages, rang exact',
    [aimv.total, aimv.tierCounts.exact, pages(aimv)], [8, 8, [40, 370, 485, 496, 497, 499, 500, 501]]);
  const aimd = rq(aim, 'décro');
  check('AIM décro : 15 pages, rang préfixe',
    [aimd.total, aimd.tierCounts.prefix, pages(aimd)],
    [15, 15, [30, 40, 164, 252, 370, 470, 482, 485, 490, 494, 496, 497, 499, 500, 501]]);
  check('AIM décrohage : 11 pages, rang flou',
    [rq(aim, 'décrohage').total, rq(aim, 'décrohage').tierCounts.fuzzy], [11, 11]);
  check('AIM décrochage volets : 4 pages, rang ET',
    [rq(aim, 'décrochage volets').total, pages(rq(aim, 'décrochage volets'))], [4, [40, 370, 500, 501]]);
  // PA-44 : « stall speed » 4 exacts, « stall speeds » 4 exacts aussi.
  check('PA-44 stall speed : 4 pages, rang exact',
    [rq(pa44, 'stall speed').total, pages(rq(pa44, 'stall speed'))], [4, [108, 123, 126, 203]]);
  check('PA-44 stall speeds : 4 pages, rang exact',
    [rq(pa44, 'stall speeds').total, pages(rq(pa44, 'stall speeds'))], [4, [108, 123, 126, 203]]);

  // -----------------------------------------------------------------------
  // 8. Perfs : chaque appel searchDocs sur l'AIM (569 p.) < 100 ms
  // -----------------------------------------------------------------------
  for (const q of ['décrochage', 'décro', 'décrohage', 'vitesse de décrochage']) {
    const ts = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      searchDocs([aim], realMeta, q, synonyms, { scope: 'all', limit: 500 });
      ts.push(performance.now() - t0);
    }
    const max = Math.max(...ts);
    console.log(`PERF AIM ${q} : ${ts.map((t) => t.toFixed(1)).join(' / ')} ms (max ${max.toFixed(1)})`);
    check(`perf AIM ${q} < 100 ms`, max < 100, true);
  }
}

console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
