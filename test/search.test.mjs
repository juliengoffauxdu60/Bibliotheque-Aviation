// Tests du moteur de recherche (Node, sans Electron).
// Vérifient les règles de la spécification contre des index JSON
// SYNTHÉTIQUES (test/fixtures/synthetic/) — petits, déterministes, sans
// aucun document réel : les 4 documents de base ont quitté le dépôt
// (15 nov. 2026) et ne doivent jamais y revenir.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchDocs, expandQuery, normalizeForLookup } from '../renderer/search.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
// Fixtures synthétiques : 3 petits documents fictifs (EN, FR, mixte),
// contenus connus, comptes mesurés (voir les commentaires arithmétiques).
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
function countIn(docId, res) {
  return res.results.filter((r) => r.docId === docId).length;
}

// 1. Mot entier : « stall » ne trouve pas « installed ».
//    Total 7 = 4 pages « stall » (syn-en p. 2, 6, 7 + syn-mix p. 3)
//    + 3 pages « décrochage » (syn-fr p. 2, 6, 8) − 0 page avec les deux.
const stall = searchDocs(docs, meta, 'stall', synonyms, { scope: 'all', limit: 1000 });
check('stall : pages syn-en (mot entier)', countIn('syn-en', stall), 3);
check('stall : total pages (3 docs, avec synonyme décrochage)', stall.total, 7);
// Aucun résultat ne doit venir d'« installed » seul : chaque résultat contient
// bien le mot « stall » ou « décrochage » en mot entier.
const parasite = stall.results.filter((r) => !['stall', 'décrochage'].includes(r.termFound));
check('stall : aucun résultat parasite', parasite.length, 0);
// « wind » ne prend pas « crosswind » (syn-mix p. 4 : « Wind » en titre
// + « Wind affects… », « crosswind » exclu par le garde mot entier).
const wind = searchDocs(docs, meta, 'wind', synonyms, { scope: 'all', limit: 1000 });
check('wind : 2 occurrences p. 4 syn-mix (crosswind exclu)',
  wind.results.find((r) => r.docId === 'syn-mix' && r.page === 4).occurrences, 2);

// 2. Phrase exacte : « stall speed ».
//    5 pages = 3 « stall speed » (syn-en p. 2, 6 + syn-mix p. 3)
//    + 2 « vitesse de décrochage » (syn-fr p. 2, 6) − 0 page avec les deux.
const ss = searchDocs(docs, meta, 'stall speed', synonyms, { scope: 'all', limit: 1000 });
check('stall speed : 5 pages', ss.total, 5);
check('stall speed : chaque résultat porte la phrase FR ou EN',
  ss.results.every((r) => ['stall speed', 'vitesse de décrochage'].includes(r.termFound)), true);

// 3. Insensible à la casse et aux accents.
const a = searchDocs(docs, meta, 'DÉCROCHAGE', synonyms, { scope: 'all', limit: 1000 });
const b = searchDocs(docs, meta, 'décrochage', synonyms, { scope: 'all', limit: 1000 });
check('décrochage insensible casse/accents (même total)', a.total, b.total);
check('décrochage : expansion vers stall (pages EN trouvées)', a.results.some((r) => r.docId === 'syn-en'), true);

// 4. Synonymes : « pression d'huile » trouve « oil pressure ».
const ph = searchDocs(docs, meta, "pression d'huile", synonyms, { scope: 'all', limit: 1000 });
check("pression d'huile : trouve des pages EN via oil pressure", ph.results.some((r) => r.docId === 'syn-en' && r.termFound === 'oil pressure'), true);
check("pression d'huile : total 2 pages (syn-fr p. 3 + syn-en p. 4)", ph.total, 2);
const carb = searchDocs(docs, meta, 'carburant', synonyms, { scope: 'all', limit: 1000 });
check('carburant : trouve fuel (pages EN)', carb.results.some((r) => r.docId === 'syn-en' && r.termFound === 'fuel'), true);
const cg = searchDocs(docs, meta, 'centrage', synonyms, { scope: 'all', limit: 1000 });
check('centrage : trouve center of gravity', cg.results.some((r) => r.termFound === 'center of gravity'), true);
const vol = searchDocs(docs, meta, 'volets', synonyms, { scope: 'all', limit: 1000 });
check('volets : trouve flaps', vol.results.some((r) => r.termFound === 'flaps'), true);
const giv = searchDocs(docs, meta, 'givrage', synonyms, { scope: 'all', limit: 1000 });
check('givrage : trouve icing', giv.results.some((r) => r.termFound === 'icing'), true);

// 5. Ordre de lecture : doc par doc (syn-en, syn-fr, syn-mix), puis page croissante.
const fuel = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'all', limit: 500 });
const order = ['syn-en', 'syn-fr', 'syn-mix'];
let ordered = true;
let lastDoc = -1; let lastPage = 0;
for (const r of fuel.results) {
  const di = order.indexOf(r.docId);
  if (di < lastDoc || (di === lastDoc && r.page < lastPage)) { ordered = false; break; }
  lastDoc = di; lastPage = r.page;
}
check('fuel : ordre de lecture respecté', ordered, true);
check('fuel : total 5 pages', fuel.total, 5);

// 6. Plafonds : le corpus synthétique (20 pages) ne permet pas d'observer
// les plafonds par défaut 500 / 1000 — on vérifie le mécanisme (limite
// explicite + drapeau tronqué), qui est le même code que les défauts.
check('fuel : non tronqué (5 < 500)', [fuel.results.length, fuel.truncated], [5, false]);
const capped = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'all', limit: 3 });
check('plafond : limité à 3 + tronqué signalé', [capped.results.length, capped.truncated], [3, true]);
const fuelEn = searchDocs(docs, meta, 'fuel', synonyms, { scope: 'syn-en', limit: 1000 });
check('fuel syn-en seul : 2 pages, non tronqué', [fuelEn.total, fuelEn.results.length, fuelEn.truncated], [2, 2, false]);

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
