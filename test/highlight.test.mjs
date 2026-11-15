// Tests du surlignage des termes cherchés (v1.1.3, Node, sans Electron).
// Vérifient la géométrie pure (renderer/highlight.js) et la correspondance
// (mot entier, casse/accents) contre le VRAI viewport pdf.js du C172R.
//   node test/highlight.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  normalizeForMatch, fractionRectToPdfPoints, ocrRectsForTerm,
  textRectsForTerm, pdfRectToCss, clampCssRect,
} from '../renderer/highlight.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
// Document anciennement fourni, désormais fixture de test uniquement
// (v1.2.0 : l'appli livrée ne contient plus aucun document d'origine).
const bundled = path.join(root, 'fixtures', 'bundled');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

// 1. Normalisation de comparaison.
check('normalisation : casse + accents', normalizeForMatch('DÉCROCHAGE'), 'decrochage');
check('normalisation : apostrophes', normalizeForMatch('l’huile'), "l'huile");
check('normalisation : espaces', normalizeForMatch('  stall   speed '), 'stall speed');

// 2. Fractions d'image -> points PDF (Y inversé, rotation 0).
// Page lettre 612 x 792 pt, image 1224 x 1584 px (échelle 2).
check('géométrie : image entière -> page entière',
  fractionRectToPdfPoints({ x0: 0, y0: 0, x1: 1224, y1: 1584 }, 1224, 1584, 612, 792),
  { x0: 0, y0: 0, x1: 612, y1: 792 });
check('géométrie : moitié haute de l’image -> moitié haute de la page (Y inversé)',
  fractionRectToPdfPoints({ x0: 0, y0: 0, x1: 1224, y1: 792 }, 1224, 1584, 612, 792),
  { x0: 0, y0: 396, x1: 612, y1: 792 });
check('géométrie : moitié basse de l’image -> moitié basse de la page',
  fractionRectToPdfPoints({ x0: 0, y0: 792, x1: 1224, y1: 1584 }, 1224, 1584, 612, 792),
  { x0: 0, y0: 0, x1: 612, y1: 396 });
check('géométrie : mot en haut à gauche de l’image -> en haut à gauche de la page',
  fractionRectToPdfPoints({ x0: 122, y0: 158, x1: 244, y1: 198 }, 1224, 1584, 612, 792),
  { x0: 61, y0: 693, x1: 122, y1: 713 });
check('géométrie : dimensions invalides -> null',
  fractionRectToPdfPoints({ x0: 0, y0: 0, x1: 10, y1: 10 }, 0, 1584, 612, 792), null);
check('géométrie : boîte invalide -> null',
  fractionRectToPdfPoints(null, 1224, 1584, 612, 792), null);

// 3. Boîtes OCR -> rectangles d'un terme.
const ocrWords = [
  { text: 'Fuel', confidence: 95, bbox: { x0: 100, y0: 100, x1: 180, y1: 130 } },
  { text: 'pump,', confidence: 88, bbox: { x0: 190, y0: 100, x1: 280, y1: 130 } },
  { text: 'fuels', confidence: 90, bbox: { x0: 300, y0: 100, x1: 380, y1: 130 } },
  { text: 'STALL', confidence: 92, bbox: { x0: 100, y0: 200, x1: 200, y1: 230 } },
  { text: 'speed', confidence: 91, bbox: { x0: 210, y0: 200, x1: 300, y1: 230 } },
  { text: 'stall', confidence: 93, bbox: { x0: 100, y0: 300, x1: 180, y1: 330 } },
  { text: 'speed', confidence: 94, bbox: { x0: 190, y0: 300, x1: 280, y1: 330 } },
];
const W = 1000, H = 1000, PW = 612, PH = 792;
check('OCR : un mot, casse indifférente',
  ocrRectsForTerm(ocrWords, W, H, 'fuel', PW, PH),
  [{ x0: 61.2, y0: 689.04, x1: 110.16, y1: 712.8 }]);
check('OCR : ponctuation collée acceptée (« pump, »)',
  ocrRectsForTerm(ocrWords, W, H, 'pump', PW, PH).length, 1);
check('OCR : mot entier — « fuel » ne prend pas « fuels »',
  ocrRectsForTerm(ocrWords, W, H, 'fuel', PW, PH).length, 1);
check('OCR : phrase sur une ligne -> un seul rectangle',
  ocrRectsForTerm(ocrWords, W, H, 'stall speed', PW, PH),
  [
    { x0: 61.2, y0: 609.84, x1: 183.6, y1: 633.6 },
    { x0: 61.2, y0: 530.64, x1: 171.36, y1: 554.4 },
  ]);
check('OCR : phrase à cheval sur deux lignes -> aucun rectangle',
  ocrRectsForTerm([
    { text: 'stall', confidence: 90, bbox: { x0: 100, y0: 100, x1: 180, y1: 130 } },
    { text: 'speed', confidence: 90, bbox: { x0: 100, y0: 200, x1: 200, y1: 230 } },
  ], W, H, 'stall speed', PW, PH), []);
check('OCR : mot mal reconnu -> pas de rectangle inventé',
  ocrRectsForTerm(ocrWords, W, H, 'fue1', PW, PH), []);
check('OCR : terme vide -> []', ocrRectsForTerm(ocrWords, W, H, '', PW, PH), []);
check('OCR : mots vides (repli système) -> []', ocrRectsForTerm([], W, H, 'fuel', PW, PH), []);

// 4. Texte réel (items pdf.js) -> rectangles d'un terme.
const textItems = [
  { str: 'FUEL', x: 100, y: 700, width: 40, height: 12 },
  { str: ' PUMP', x: 145, y: 700, width: 50, height: 12 },
  { str: 'installed', x: 100, y: 680, width: 80, height: 12 },
  { str: 'stall', x: 100, y: 660, width: 30, height: 12 },
  { str: 'speed', x: 135, y: 660, width: 35, height: 12 },
  { str: 'DÉCROCHAGE', x: 100, y: 640, width: 90, height: 12 },
];
check('texte : un mot, casse indifférente',
  textRectsForTerm(textItems, 'fuel'),
  [{ x0: 100, y0: 697.6, x1: 140, y1: 712 }]);
check('texte : mot entier — « stall » ne prend pas « installed »',
  textRectsForTerm(textItems, 'stall'),
  [{ x0: 100, y0: 657.6, x1: 130, y1: 672 }]);
check('texte : phrase sur deux fragments -> un rectangle',
  textRectsForTerm(textItems, 'stall speed'),
  [{ x0: 100, y0: 657.6, x1: 170, y1: 672 }]);
check('texte : accents indifférents',
  textRectsForTerm(textItems, 'décrochage'),
  [{ x0: 100, y0: 637.6, x1: 190, y1: 652 }]);
check('texte : terme absent -> []', textRectsForTerm(textItems, 'volets'), []);
check('texte : items vides -> []', textRectsForTerm([], 'fuel'), []);
// Phrase coupée sur deux lignes : deux rectangles, pas un qui enjambe.
const textItemsSplit = [
  { str: 'stall', x: 100, y: 660, width: 30, height: 12 },
  { str: 'speed', x: 500, y: 660, width: 35, height: 12 },
  { str: 'stall speed', x: 100, y: 640, width: 70, height: 12 },
];
check('texte : phrase coupée -> deux rectangles (un par ligne)',
  textRectsForTerm(textItemsSplit, 'stall speed'),
  [{ x0: 100, y0: 657.6, x1: 535, y1: 672 }, { x0: 100, y0: 637.6, x1: 170, y1: 652 }]);

// 5. Points PDF -> px CSS avec le VRAI viewport pdf.js (rotation 0).
const data = new Uint8Array(fs.readFileSync(path.join(bundled, 'assets/C172R-final.pdf')));
const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
const page = await doc.getPage(5);
const viewport = page.getViewport({ scale: 1 });
check('viewport 172R p.5 : rotation 0', viewport.rotation, 0);
check('viewport 172R p.5 : dimensions lettre', [Math.round(viewport.width), Math.round(viewport.height)], [612, 792]);
check('CSS : page entière -> canevas entier',
  pdfRectToCss(viewport, { x0: 0, y0: 0, x1: 612, y1: 792 }),
  { left: 0, top: 0, width: 612, height: 792 });
check('CSS : Y inversé par le viewport (bas de page -> bas du canevas)',
  pdfRectToCss(viewport, { x0: 100, y0: 100, x1: 200, y1: 150 }),
  { left: 100, top: 642, width: 100, height: 50 });
check('CSS : échelle 2 = px doublés',
  pdfRectToCss(page.getViewport({ scale: 2 }), { x0: 100, y0: 100, x1: 200, y1: 150 }),
  { left: 200, top: 1284, width: 200, height: 100 });
check('clamp : rectangle intérieur inchangé',
  clampCssRect({ left: 10, top: 20, width: 100, height: 30 }, 612, 792),
  { left: 10, top: 20, width: 100, height: 30 });
check('clamp : rectangle qui dépasse -> rogné à la page',
  clampCssRect({ left: 600, top: 780, width: 100, height: 30 }, 612, 792),
  { left: 600, top: 780, width: 12, height: 12 });
check('clamp : rectangle hors page -> null',
  clampCssRect({ left: 700, top: 20, width: 100, height: 30 }, 612, 792), null);

console.log(failures === 0
  ? '\nTOUS LES TESTS PASSENT'
  : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
