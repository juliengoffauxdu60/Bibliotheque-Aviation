// Tests du moteur de recherche (Node, sans Electron).
// Vérifient les règles de la spécification contre les VRAIS index JSON.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDocs, expandQuery, normalizeForLookup } from '../renderer/search.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
// Documents anciennement fournis, désormais fixtures de test uniquement
// (v1.2.0 : l'appli livrée ne contient plus aucun document d'origine).
const bundled = path.join(root, 'fixtures', 'bundled');
const docsMeta = JSON.parse(fs.readFileSync(path.join(bundled, 'data/docs.json'), 'utf8'));
const synonyms = JSON.parse(fs.readFileSync(path.join(base, 'data/synonyms.json'), 'utf8'));
const docs = docsMeta.docs.map((d) => JSON.parse(fs.readFileSync(path.join(bundled, d.index), 'utf8')));
const meta = {};
for (const d of docsMeta.docs) meta[d.id] = d;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function countIn(docId, res) {
  return res.results.filter((r) => r.docId === docId).length;
}

// 1. Mot entier : « stall » ne trouve pas « installed ».
//    Référence checklist : « stall » 48 pages en sous-chaîne -> 11 pages en mot entier (172N).
//    Total 56 = 38 pages « stall » + 22 pages « décrochage » (synonyme) − 4 pages avec les deux.
const stall = searchDocs(docs, meta, 'stall', synonyms, { scope: 'all', limit: 1000 });
check('stall : pages 172N (mot entier)', countIn('c172n', stall), 11);
check('stall : total pages (4 docs, avec synonyme décrochage)', stall.total, 56);
// Aucun résultat ne doit venir d'« installed » seul : chaque résultat contient
// bien le mot « stall » ou « décrochage » en mot entier.
const parasite = stall.results.filter((r) => !['stall', 'décrochage'].includes(r.termFound));
check('stall : aucun résultat parasite', parasite.length, 0);

// 2. Phrase exacte : « stall speed ».
//    12 pages = 8 « stall speed » + 5 « vitesse de décrochage » − 1 page avec les deux.
//    C'est EXACTEMENT le chiffre de la checklist (« stall speed » = 12 pages exactes).
const ss = searchDocs(docs, meta, 'stall speed', synonyms, { scope: 'all', limit: 1000 });
check('stall speed : 12 pages (comme la checklist)', ss.total, 12);
check('stall speed : chaque résultat porte la phrase FR ou EN',
  ss.results.every((r) => ['stall speed', 'vitesse de décrochage'].includes(r.termFound)), true);

// 3. Insensible à la casse et aux accents.
const a = searchDocs(docs, meta, 'DÉCROCHAGE', synonyms, { scope: 'all', limit: 1000 });
const b = searchDocs(docs, meta, 'décrochage', synonyms, { scope: 'all', limit: 1000 });
check('décrochage insensible casse/accents (même total)', a.total, b.total);
check('décrochage : expansion vers stall (pages EN trouvées)', a.results.some((r) => r.docId === 'c172n'), true);

// 4. Synonymes : « pression d'huile » trouve « oil pressure ».
const ph = searchDocs(docs, meta, "pression d'huile", synonyms, { scope: 'all', limit: 1000 });
check("pression d'huile : trouve des pages EN via oil pressure", ph.results.some((r) => r.docId === 'c172r' && r.termFound === 'oil pressure'), true);
check("pression d'huile : total > pages FR seules (4)", ph.total > 4, true);
const carb = searchDocs(docs, meta, 'carburant', synonyms, { scope: 'all', limit: 1000 });
check('carburant : trouve fuel (pages EN)', carb.results.some((r) => r.docId === 'c172n' && r.termFound === 'fuel'), true);
const cg = searchDocs(docs, meta, 'centrage', synonyms, { scope: 'all', limit: 1000 });
check('centrage : trouve center of gravity', cg.results.some((r) => r.termFound === 'center of gravity'), true);
const vol = searchDocs(docs, meta, 'volets', synonyms, { scope: 'all', limit: 1000 });
check('volets : trouve flaps', vol.results.some((r) => r.termFound === 'flaps'), true);
const giv = searchDocs(docs, meta, 'givrage', synonyms, { scope: 'all', limit: 1000 });
check('givrage : trouve icing', giv.results.some((r) => r.termFound === 'icing'), true);

// 5. Ordre de lecture : doc par doc (172N, 172R, 150, SOP), puis page croissante.
const fuel = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'all', limit: 500 });
const order = ['c172n', 'c172r', 'c150n', 'sop-c150'];
let ordered = true;
let lastDoc = -1; let lastPage = 0;
for (const r of fuel.results) {
  const di = order.indexOf(r.docId);
  if (di < lastDoc || (di === lastDoc && r.page < lastPage)) { ordered = false; break; }
  lastDoc = di; lastPage = r.page;
}
check('fuel : ordre de lecture respecté', ordered, true);
check('fuel : total 209 pages (comme la checklist)', fuel.total, 209);

// 6. Plafonds : 500 tous docs, 1000 un seul doc.
check('fuel : non tronqué (209 < 500)', [fuel.results.length, fuel.truncated], [209, false]);
// Plafond vérifié avec une limite explicite (même code que la limite 500/1000).
const capped = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'all', limit: 10 });
check('plafond : limité à 10 + tronqué signalé', [capped.results.length, capped.truncated], [10, true]);
const fuel172r = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'c172r', limit: 1000 });
check('fuel 172R seul : 81 pages, non tronqué', [fuel172r.total, fuel172r.results.length, fuel172r.truncated], [81, 81, false]);

// 7. Chaque résultat indique le terme réellement trouvé + le nombre d'occurrences.
check('fuel : chaque résultat a termFound + occurrences > 0',
  fuel.results.every((r) => r.termFound && r.occurrences > 0 && r.excerptHtml.includes('<mark>')), true);

// 8. Requête vide / sans résultat.
check('requête vide : 0 résultat', searchDocs(docs, meta, '   ', synonyms).total, 0);
check('terme absent : 0 résultat', searchDocs(docs, meta, 'zzzqqq', synonyms).total, 0);

// 9. Expansion : la requête elle-même reste le premier terme.
check('expandQuery(décrochage)[0]', expandQuery('décrochage', synonyms)[0], 'décrochage');
check('expandQuery(stall) contient décrochage', expandQuery('stall', synonyms).includes('décrochage'), true);
check('normalize : décrochage -> decrochage', normalizeForLookup('DÉCROCHAGE'), 'decrochage');

console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
