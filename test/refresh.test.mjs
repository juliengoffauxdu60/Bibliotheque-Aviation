// Tests du refresh des anciens imports (v1.2.1, main-import.js, Node).
// Motif repris de test/ai.test.mjs section 10 : faux Electron
// (test/electron-stub.mjs + register) puis import du module principal —
// les handlers IPC sont appelés directement, sans vraie fenêtre.
//   node test/refresh.test.mjs
//
// Ce qui est testé (données LOCALES, jamais dans le dépôt) :
//  - un import simulé v1.1.1 du VRAI AIM de Julien (copie locale du PDF
//    569 p. + du vrai index + meta.json aux anciennes sections plates
//    fausses, sectionDetection "none", sans sectionSource ni
//    sectionFormat) : le 1er `poh-import:list` le remet à niveau
//    (87 sections à chapitres, sectionFormat 2, sectionSource outline,
//    pages de l'index re-sectionnées) ; le 2e appel prend le chemin
//    rapide (aucune réécriture — vérifié par mtime + hachage).
//  - un document plat (PDF synthétique, sans pdf_file dans la méta —
//    le seul PDF du dossier est utilisé) : sections conservées, format 2.
//  - robustesse : document sans index.json rendu tel quel, meta.json
//    corrompue ignorée sans casser la liste.
// Si le vrai AIM est absent de cette machine, sa partie est passée
// (comme les PDF GEN/RAC de import.test.mjs) et le reste tourne.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

const root = path.dirname(fileURLToPath(import.meta.url));
const AIM_PDF = '/home/hatch/uploads/FE8FE31C-3C75-498D-B08D-0F8EDD4109D4/AIM.pdf';
const AIM_INDEX = '/home/hatch/uploads/5C518697-3295-4FE2-8F94-9977F132C951/index.json';

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log(`PASSÉ ${name} — ${why}`); }
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const mtime = (p) => fs.statSync(p).mtimeMs;

// Faux Electron, puis module principal (même motif que ai.test.mjs §10).
register('./electron-stub.mjs', import.meta.url);
const { registerImportHandlers } = await import('../main-import.js');
const electronStub = await import('./electron-stub.mjs');
registerImportHandlers();
const callIpc = (channel, ...args) => electronStub.handlers.get(channel)(null, ...args);
const userDataDir = electronStub.userDataDir;
const pohsDir = path.join(userDataDir, 'pohs');

import { extractPdfText, buildIndex, detectSections } from '../import-core.js';
import { syntheticPdfPath } from './fixtures/synthetic-pdf.mjs';

// --- Mise en place du faux userData ---------------------------------------
// Doc plat : PDF synthétique (10 p., SECTION 1@4, SECTION 2@9), index
// construit par la passe titres, méta SANS pdf_file (repli « seul PDF
// du dossier ») et SANS sectionFormat (ancien import à remettre à niveau).
const synPdf = syntheticPdfPath();
const syn = await extractPdfText(synPdf);
const synDocId = 'imp-synthetique-test';
const synDir = path.join(pohsDir, synDocId);
fs.mkdirSync(synDir, { recursive: true });
fs.copyFileSync(synPdf, path.join(synDir, 'Synthetique.pdf'));
const synIndex = buildIndex({
  docId: synDocId, title: 'SYNTHETIQUE', pdfPath: `user-pohs/${synDocId}/Synthetique.pdf`, pages: syn.pages,
});
fs.writeFileSync(path.join(synDir, 'index.json'), JSON.stringify(synIndex), 'utf8');
const synSections = detectSections(syn.pages).sections
  .map(({ key, label, startPage, level }) => ({ key, label, startPage, level }));
fs.writeFileSync(path.join(synDir, 'meta.json'), JSON.stringify({
  doc_id: synDocId, title: 'SYNTHETIQUE', short: 'SYNTHETIQ',
  added_at: '2026-11-11T10:00:00.000Z', source: 'import',
  original_filename: 'Synthetique.pdf', totalPages: 10,
  scanned: false, medianCharsPerPage: 100, scannedThreshold: 20,
  sectionDetection: 'sections',
  doc: {
    id: synDocId, title: 'SYNTHETIQUE', short: 'SYNTHETIQ',
    subtitle: 'Importé le 2026-11-11 — 2 sections détectées',
    pdf: `user-pohs/${synDocId}/Synthetique.pdf`,
    index: `user-pohs/${synDocId}/index.json`,
    sections: synSections, totalPages: 10, ocr: false,
  },
}, null, 2), 'utf8');

// Doc sans index.json : rendu tel quel, jamais de crash.
const noIndexId = 'imp-sans-index-test';
fs.mkdirSync(path.join(pohsDir, noIndexId), { recursive: true });
fs.writeFileSync(path.join(pohsDir, noIndexId, 'meta.json'), JSON.stringify({
  doc_id: noIndexId, title: 'SANS INDEX', short: 'SANSINDEX',
  added_at: '2026-11-12T10:00:00.000Z', source: 'import',
  original_filename: 'SansIndex.pdf', totalPages: 3,
  scanned: false, medianCharsPerPage: 100, scannedThreshold: 20,
  sectionDetection: 'sections',
  doc: { id: noIndexId, title: 'SANS INDEX', short: 'SANSINDEX', sections: [], totalPages: 3, ocr: false },
}, null, 2), 'utf8');

// Doc à la meta corrompue : ignoré, la liste des autres ne casse pas.
const badId = 'imp-corrompu-test';
fs.mkdirSync(path.join(pohsDir, badId), { recursive: true });
fs.writeFileSync(path.join(pohsDir, badId, 'meta.json'), '{ ceci n’est pas du JSON', 'utf8');

// Doc AIM v1.1.1 (si les fichiers locaux sont présents) : copie locale
// du vrai PDF + du vrai index, méta aux anciennes sections plates
// fausses (première apparition de chaque clé plate dans l'index —
// 9.0@14, page de sommaire ; pas de 6.0), sectionDetection "none",
// sans sectionSource ni sectionFormat.
const aimDocId = 'imp-aim-test';
const aimDir = path.join(pohsDir, aimDocId);
const aimPresent = fs.existsSync(AIM_PDF) && fs.existsSync(AIM_INDEX);
let oldAimSections = null;
if (aimPresent) {
  fs.mkdirSync(aimDir, { recursive: true });
  fs.copyFileSync(AIM_PDF, path.join(aimDir, 'AIM.pdf'));
  const aimIndex = JSON.parse(fs.readFileSync(AIM_INDEX, 'utf8'));
  fs.writeFileSync(path.join(aimDir, 'index.json'), JSON.stringify(aimIndex), 'utf8');
  const firstSeen = new Map();
  for (const p of aimIndex.pages) {
    if (!firstSeen.has(p.section)) firstSeen.set(p.section, p.pdf_page);
  }
  oldAimSections = [{ key: 'front', label: 'Début du document', startPage: 1, level: 0 }];
  for (const [key, startPage] of [...firstSeen.entries()].sort((a, b) => a[1] - b[1])) {
    if (key === 'front') continue;
    oldAimSections.push({ key, label: key, startPage, level: 2 });
  }
  fs.writeFileSync(path.join(aimDir, 'meta.json'), JSON.stringify({
    doc_id: aimDocId, title: aimIndex.title, short: 'AIM',
    added_at: '2026-11-10T10:00:00.000Z', source: 'import',
    original_filename: 'AIM.pdf', pdf_file: 'AIM.pdf', totalPages: 569,
    scanned: false, medianCharsPerPage: 1200, scannedThreshold: 20,
    sectionDetection: 'none',
    doc: {
      id: aimDocId, title: aimIndex.title, short: 'AIM',
      subtitle: 'Importé le 2026-11-10 — sections plates (v1.1.1)',
      pdf: `user-pohs/${aimDocId}/AIM.pdf`,
      index: `user-pohs/${aimDocId}/index.json`,
      sections: oldAimSections, totalPages: 569, ocr: false,
    },
  }, null, 2), 'utf8');
}

// --- Premier appel : remise à niveau --------------------------------------
const t0 = Date.now();
const list1 = await callIpc('poh-import:list');
console.log(`(1er list en ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
check('refresh : liste triée par added_at', list1.map((m) => m.doc_id),
  aimPresent
    ? [aimDocId, synDocId, noIndexId]
    : [synDocId, noIndexId]);

const synMeta1 = list1.find((m) => m.doc_id === synDocId);
check('refresh plat : marqué format 2', synMeta1.sectionFormat, 2);
check('refresh plat : source titres', synMeta1.sectionSource, 'heading');
check('refresh plat : détection sections (SECTION N)', synMeta1.sectionDetection, 'sections');
check('refresh plat : sections conservées (clés)',
  synMeta1.doc.sections.map((s) => s.key), ['front', '1', '2']);
check('refresh plat : sections conservées (pages)',
  synMeta1.doc.sections.map((s) => s.startPage), [1, 4, 9]);
check('refresh plat : méta sans pdf_file (repli seul-PDF, rien ajouté)',
  'pdf_file' in synMeta1, false);
const synIndexApres = JSON.parse(fs.readFileSync(path.join(synDir, 'index.json'), 'utf8'));
check('refresh plat : index re-sectionné pareil',
  [synIndexApres.pages[3].section, synIndexApres.pages[6].section, synIndexApres.pages[8].section],
  ['1', '1', '2']);

const noIndexMeta = list1.find((m) => m.doc_id === noIndexId);
check('refresh sans index : méta rendue telle quelle (pas de format 2)',
  noIndexMeta.sectionFormat, undefined);
check('refresh meta corrompue : absente de la liste, les autres passent',
  list1.some((m) => m.doc_id === badId), false);

// Empreintes avant le 2e appel (chemin rapide).
const prints1 = {};
for (const [id, dir] of [[synDocId, synDir], ...(aimPresent ? [[aimDocId, aimDir]] : [])]) {
  prints1[id] = { meta: [mtime(path.join(dir, 'meta.json')), sha(path.join(dir, 'meta.json'))],
    index: [mtime(path.join(dir, 'index.json')), sha(path.join(dir, 'index.json'))] };
}

if (aimPresent) {
  const aimMeta1 = list1.find((m) => m.doc_id === aimDocId);
  check('refresh AIM : marqué format 2', aimMeta1.sectionFormat, 2);
  check('refresh AIM : source signets', aimMeta1.sectionSource, 'outline');
  check('refresh AIM : détection signets', aimMeta1.sectionDetection, 'outline');
  check('refresh AIM : 87 sections (front + 11 chapitres + 75 sous-sections)',
    aimMeta1.doc.sections.length, 87);
  check('refresh AIM : 11 chapitres',
    aimMeta1.doc.sections.filter((s) => s.level === 1).length, 11);
  check('refresh AIM : chapitres (clé@page)',
    aimMeta1.doc.sections.filter((s) => s.level === 1).map((s) => `${s.key}@${s.startPage}`),
    ['GEN@35', 'AGA@91', 'COM@127', 'MET@169', 'RAC@237', 'NAT@399', 'SAR@415', 'MAP@429', 'LRA@441', 'AIR@467', 'ATP@525']);
  check('refresh AIM : GEN 5.0@66 Divers',
    (() => { const s = aimMeta1.doc.sections.find((x) => x.key === 'GEN 5.0'); return s && [s.startPage, s.label]; })(),
    [66, '5.0 — Divers']);
  check('refresh AIM : AGA 9.0@118 (était 8.0 plat p.118)',
    (() => { const s = aimMeta1.doc.sections.find((x) => x.key === 'AGA 9.0'); return s && s.startPage; })(), 118);
  check('refresh AIM : plus aucune clé plate N.0',
    aimMeta1.doc.sections.filter((s) => /^\d+\.0$/.test(s.key)).length, 0);
  check('refresh AIM : anciennes sections plates remplacées (9.0@14 disparu)',
    aimMeta1.doc.sections.some((s) => s.key === '9.0' && s.startPage === 14), false);
  const aimIndexApres = JSON.parse(fs.readFileSync(path.join(aimDir, 'index.json'), 'utf8'));
  check('refresh AIM : index re-sectionné (p.35 -> GEN 1.0)', aimIndexApres.pages[34].section, 'GEN 1.0');
  check('refresh AIM : index re-sectionné (p.118 -> AGA 9.0)', aimIndexApres.pages[117].section, 'AGA 9.0');
  check('refresh AIM : index re-sectionné (p.300 -> RAC 4.0)', aimIndexApres.pages[299].section, 'RAC 4.0');
  check('refresh AIM : index re-sectionné (p.569 -> ATP 3.0)', aimIndexApres.pages[568].section, 'ATP 3.0');
} else {
  skip('refresh AIM (vrai PDF + vrai index)', 'AIM.pdf / index.json absents de cette machine');
}

// --- Deuxième appel : chemin rapide, aucune réécriture --------------------
const list2 = await callIpc('poh-import:list');
check('refresh 2e appel : même nombre de documents', list2.length, list1.length);
if (aimPresent) {
  check('refresh 2e appel : AIM toujours 87 sections',
    list2.find((m) => m.doc_id === aimDocId).doc.sections.length, 87);
}
check('refresh 2e appel : plat toujours 3 entrées (front + 2)',
  list2.find((m) => m.doc_id === synDocId).doc.sections.length, 3);
for (const [id, dir] of [[synDocId, synDir], ...(aimPresent ? [[aimDocId, aimDir]] : [])]) {
  check(`refresh 2e appel : ${id} meta.json non réécrite (mtime + sha)`,
    [mtime(path.join(dir, 'meta.json')), sha(path.join(dir, 'meta.json'))], prints1[id].meta);
  check(`refresh 2e appel : ${id} index.json non réécrit (mtime + sha)`,
    [mtime(path.join(dir, 'index.json')), sha(path.join(dir, 'index.json'))], prints1[id].index);
}

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
