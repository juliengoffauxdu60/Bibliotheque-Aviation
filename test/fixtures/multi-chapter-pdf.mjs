// Génère un PDF synthétique MULTI-CHAPITRES avec une VRAIE table des
// signets (outline PDF), déterministe (aucun binaire lourd dans le dépôt).
// Utilisé par test/layered.test.mjs (détection en couches v1.2.1).
// Contenu (ASCII seulement, pour que l'extraction et les signets soient
// stables — les titres avec accents passeraient par un encodage PDFDoc
// fragile, inutile ici) :
//   p.1  couverture — « MANUEL DE TEST »
//   p.2  TABLE DES MATIÈRES (entrées GEN/AGA à points de suite)
//   p.3  GEN — Généralités / 1.0 Renseignements généraux
//   p.4  corps GEN 1.0
//   p.5  2.0 Sécurité
//   p.6  corps GEN 2.0
//   p.7  AGA — Aérodromes / 1.0 Généralités
//   p.8  corps AGA 1.0
//   p.9  2.0 Exploitation
//   p.10 corps AGA 2.0
//   p.11 RAC — Règles de l'air (chapitre SANS sous-section numérotée)
//   p.12 corps RAC
// Signets (arbre) :
//   « Table des matières » (p.2) -> GEN (p.2), AGA (p.2)  [branche EXCLUE :
//     ses pages sont celles du sommaire, pas les vrais départs]
//   « GEN - Generalites » (p.3) -> « 1.0 Renseignements generaux » (p.3),
//     « 2.0 Securite » (p.5)
//   « AGA - Aerodromes » (p.7) -> « 1.0 Generalites » (p.7),
//     « 2.0 Exploitation » (p.9)
//   « RAC - Regles de l'air » (p.11)  [sans enfant : chapitre seul]
// Résultat attendu (detectSectionsLayered, source outline) :
//   front@1, GEN@3 (niv. 1), GEN 1.0@3, GEN 2.0@5, AGA@7 (niv. 1),
//   AGA 1.0@7, AGA 2.0@9, RAC@11 (niv. 1) — 9 entrées dont front.
// Usage : node test/fixtures/multi-chapter-pdf.mjs (écrit le PDF dans /tmp
// et affiche le chemin) — ou importer multiChapterPdfPath() depuis un test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MULTI_CHAPTER_PAGES = [
  ['MANUEL DE TEST', 'Document multi-chapitres pour les tests de detection en couches.'],
  ['TABLE DES MATIERES', 'GEN - Generalites .... 3', 'AGA - Aerodromes .... 7'],
  ['GEN - Generalites', '1.0 Renseignements generaux', 'Contenu de la section GEN 1.0.'],
  ['Corps de la page quatre, toujours GEN 1.0.'],
  ['2.0 Securite', 'Contenu de la section GEN 2.0.'],
  ['Corps de la page six, toujours GEN 2.0.'],
  ['AGA - Aerodromes', '1.0 Generalites', 'Contenu de la section AGA 1.0.'],
  ['Corps de la page huit, toujours AGA 1.0.'],
  ['2.0 Exploitation', 'Contenu de la section AGA 2.0.'],
  ['Corps de la page dix, toujours AGA 2.0.'],
  ["RAC - Regles de l'air", 'Contenu du chapitre RAC, sans sous-section numerotee.'],
  ['Corps de la page douze, toujours RAC.'],
];

// Arbre des signets : { title, page (1-based), children }.
// Titres en français (accents, tiret cadratin) : ils sont écrits en
// chaînes hexadécimales UTF-16BE (BOM FEFF) — un littéral PDF en UTF-8
// garblerait les accents, et l'ASCII ne testerait pas la branche
// « Table des matières » du code (regex avec è).
export const MULTI_CHAPTER_OUTLINE = [
  { title: 'Table des matières', page: 2, children: [
    { title: 'GEN — Généralités', page: 2, children: [] },
    { title: 'AGA — Aérodromes', page: 2, children: [] },
  ] },
  { title: 'GEN — Généralités', page: 3, children: [
    { title: '1.0 Renseignements généraux', page: 3, children: [] },
    { title: '2.0 Sécurité', page: 5, children: [] },
  ] },
  { title: 'AGA — Aérodromes', page: 7, children: [
    { title: '1.0 Généralités', page: 7, children: [] },
    { title: '2.0 Exploitation', page: 9, children: [] },
  ] },
  { title: "RAC — Règles de l'air", page: 11, children: [] },
];

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Chaîne PDF pour un titre de signet : littéral ASCII quand c'est
// possible, sinon hexadécimal UTF-16BE (BOM FEFF — décodé par pdf.js).
// Un littéral UTF-8 garblerait les accents (chaque octet deviendrait un
// caractère WinAnsi distinct).
function pdfStr(s) {
  if (/^[\x00-\x7F]*$/.test(s)) return `(${esc(s)})`;
  let hex = 'FEFF';
  for (const ch of s) hex += ch.charCodeAt(0).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
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

export function multiChapterPdfBuffer() {
  const objects = [];
  // 1 catalogue, 2 pages, 3 police, puis par page (contenu + page),
  // puis dictionnaire des signets + un objet par entrée de signet.
  objects[1] = null; // catalogue, rempli plus bas (référence aux signets)
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const pageObjIds = [];
  const contentObjIds = [];
  let nextId = 4;
  for (let i = 0; i < MULTI_CHAPTER_PAGES.length; i++) {
    pageObjIds.push(nextId);
    contentObjIds.push(nextId + 1);
    nextId += 2;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageObjIds.map((id) => id + ' 0 R').join(' ')}] /Count ${MULTI_CHAPTER_PAGES.length} >>`;
  for (let i = 0; i < MULTI_CHAPTER_PAGES.length; i++) {
    const stream = pageStream(MULTI_CHAPTER_PAGES[i]);
    objects[contentObjIds[i]] = `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`;
    objects[pageObjIds[i]] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjIds[i]} 0 R >>`;
  }

  // Signets : un objet par entrée, liés par Parent/Prev/Next/First/Last.
  const outlinesId = nextId++;
  // Aplatit l'arbre en gardant l'ordre du document.
  const entries = [];
  function walk(nodes, parentId) {
    let prevId = null;
    const ids = [];
    for (const node of nodes) {
      const id = nextId++;
      entries.push({ ...node, id, parentId, prevId });
      if (prevId !== null) entries.find((e) => e.id === prevId).nextId = id;
      prevId = id;
      ids.push(id);
    }
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].children && nodes[i].children.length) {
        walk(nodes[i].children, ids[i]);
      }
    }
    return ids;
  }
  const rootIds = walk(MULTI_CHAPTER_OUTLINE, outlinesId);
  // Complète les liens First/Last/Count de chaque parent.
  for (const e of entries) {
    const kids = entries.filter((c) => c.parentId === e.id);
    if (kids.length) {
      e.firstId = kids[0].id;
      e.lastId = kids[kids.length - 1].id;
      e.count = kids.length;
    }
  }
  const totalCount = entries.length;
  objects[outlinesId] = `<< /Type /Outlines /First ${rootIds[0]} 0 R /Last ${rootIds[rootIds.length - 1]} 0 R /Count ${totalCount} >>`;
  for (const e of entries) {
    const parts = [
      `/Title ${pdfStr(e.title)}`,
      `/Parent ${e.parentId} 0 R`,
      `/Dest [${pageObjIds[e.page - 1]} 0 R /XYZ 0 792 null]`,
    ];
    if (e.prevId !== null && e.prevId !== undefined) parts.push(`/Prev ${e.prevId} 0 R`);
    if (e.nextId) parts.push(`/Next ${e.nextId} 0 R`);
    if (e.firstId) parts.push(`/First ${e.firstId} 0 R /Last ${e.lastId} 0 R /Count ${e.count}`);
    objects[e.id] = `<< ${parts.join(' ')} >>`;
  }
  objects[1] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outlinesId} 0 R /PageMode /UseOutlines >>`;

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let id = 1; id < objects.length; id++) {
    if (objects[id] === null || objects[id] === undefined) throw new Error(`objet ${id} manquant`);
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
  return Buffer.from(pdf, 'utf8');
}

// Chemin du PDF généré (régénéré à chaque appel, dans /tmp — aucun
// binaire dans le dépôt).
export function multiChapterPdfPath() {
  const outPath = path.join(os.tmpdir(), 'poh-multi-chapter-doc.pdf');
  fs.writeFileSync(outPath, multiChapterPdfBuffer());
  return outPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outPath = multiChapterPdfPath();
  console.log('Écrit : ' + outPath + ' (' + fs.statSync(outPath).size + ' octets, 12 pages)');
}
