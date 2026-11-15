// Génère test/fixtures/fixture-3p.pdf : petit PDF de 3 pages, texte connu,
// déterministe (aucun binaire lourd). Utilisé par l'auto-test Electron
// (main.js runSelfTest) comme document importé : import via l'IPC d'import,
// puis recherches / feuilletage / surlignage / suppression dessus.
// Contenu (lettres US, Helvetica) :
//   p.1 SECTION 1 GENERAL — « fuel » (2 occurrences, 1 page)
//   p.2 SECTION 2 LIMITATIONS — « stall speed », « fuel »
//   p.3 SECTION 3 PROCEDURES — « oil pressure »
// Comptes attendus (moteur de recherche, synonymes data/synonyms.json) :
//   fuel = 2 pages, stall = 1 page, « stall speed » = 1 page,
//   « pression d'huile » = 1 page (via « oil pressure »).
// Usage : node scripts/make-fixture-pdf.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(root, '..', 'test', 'fixtures', 'fixture-3p.pdf');

const PAGES = [
  [
    'Document de test aviation',
    'SECTION 1 GENERAL',
    'The fuel pump delivers fuel to the engine.',
    'Check the fuel tank before flight.',
  ],
  [
    'SECTION 2 LIMITATIONS',
    'The stall speed is 48 kt in landing configuration.',
    'Fuel quantity must be checked before takeoff.',
  ],
  [
    'SECTION 3 PROCEDURES',
    'Normal procedures for takeoff and landing.',
    'The oil pressure must be in the green arc.',
  ],
];

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function pageStream(lines) {
  let ops = 'BT /F1 14 Tf\n';
  let y = 750;
  for (const line of lines) {
    ops += `1 0 0 1 72 ${y} Tm (${esc(line)}) Tj\n`;
    y -= 28;
  }
  ops += 'ET';
  return ops;
}

// Objets : 1 catalogue, 2 pages, 3 police, puis par page (contenu + page).
const objects = [];
objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
const pageObjIds = [];
const contentObjIds = [];
let nextId = 4;
for (let i = 0; i < PAGES.length; i++) {
  pageObjIds.push(nextId);
  contentObjIds.push(nextId + 1);
  nextId += 2;
}
objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => id + ' 0 R').join(' ')}] /Count ${PAGES.length} >>`;
for (let i = 0; i < PAGES.length; i++) {
  const stream = pageStream(PAGES[i]);
  objects[contentObjIds[i]] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
  objects[pageObjIds[i]] =
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
}

let pdf = '%PDF-1.4\n';
const offsets = [0];
for (let id = 1; id < objects.length; id++) {
  offsets[id] = Buffer.byteLength(pdf);
  pdf += `${id} 0 obj\n${objects[id]}\nendobj\n`;
}
const xrefPos = Buffer.byteLength(pdf);
const count = objects.length;
pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
for (let id = 1; id < count; id++) {
  pdf += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
}
pdf += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, pdf, 'utf8');
console.log('Écrit : ' + outPath + ' (' + fs.statSync(outPath).size + ' octets, 3 pages)');
