// Tests du surlignage du texte VERTICAL (v1.2.0, Node, sans Electron).
// Cas : l'onglet latéral « RAC » de l'AIM (chapitre RAC, Transports Canada),
// écrit à 90° sur le côté des pages — la recherche le trouve mais le
// rectangle de surlignage restait horizontal et ne couvrait pas le mot.
//   node test/highlight-vertical.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { textRectsForTerm } from '../renderer/highlight.js';

const root = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

// 1. Item vertical synthétique, texte descendant (matrice [0, -22, 22, 0]) :
// le mot va de (100, 300) vers le bas sur 66 pt, glyphes hauts de 22 pt
// vers +x. Le rectangle doit être une bande VERTICALE (largeur 26,4 <
// hauteur 66), pas le rectangle horizontal 66 x 26,4 de l'ancien calcul.
check('vertical descendant : bande verticale qui couvre le mot',
  textRectsForTerm(
    [{ str: 'RAC', x: 100, y: 300, width: 66, height: 22, transform: [0, -22, 22, 0, 100, 300] }],
    'RAC'),
  [{ x0: 95.6, y0: 234, x1: 122, y1: 300 }]);

// 2. Même mot, texte ascendant (matrice [0, 22, -22, 0]) : le mot monte
// de (100, 200) sur 66 pt, glyphes vers -x.
check('vertical ascendant : bande verticale vers le haut',
  textRectsForTerm(
    [{ str: 'RAC', x: 100, y: 200, width: 66, height: 22, transform: [0, 22, -22, 0, 100, 200] }],
    'RAC'),
  [{ x0: 78, y0: 200, x1: 104.4, y1: 266 }]);

// 3. Mot vertical coupé en deux fragments sur la même colonne : un seul
// rectangle, comme une phrase horizontale sur deux fragments.
check('vertical sur deux fragments -> un rectangle',
  textRectsForTerm([
    { str: 'RA', x: 100, y: 300, width: 44, height: 22, transform: [0, -22, 22, 0, 100, 300] },
    { str: 'C', x: 100, y: 256, width: 22, height: 22, transform: [0, -22, 22, 0, 100, 256] },
  ], 'RAC'),
  [{ x0: 95.6, y0: 234, x1: 122, y1: 300 }]);

// 4. VRAI item extrait du PDF RAC de l'AIM (page 11, fixture) :
// matrice [0, -31, 31, 0, 583.5027, 305.1783], largeur 66.1447.
// Vraie boîte du mot : x 583.503–614.503, y 239.034–305.178 (bande
// verticale 31 x 66,14). L'ancien calcul donnait le rectangle horizontal
// { x0: 583.503, y0: 298.978, x1: 649.647, y1: 336.178 }, qui ne couvrait
// que 6,2 pt du mot sur 66,14 et débordait de 35 pt à droite et 31 pt
// au-dessus. Le nouveau rectangle doit contenir la vraie boîte entière
// (avec la même marge de 0,2*h sous la ligne de base que l'horizontal).
const fixture = JSON.parse(fs.readFileSync(
  path.join(root, 'fixtures', 'rac-vertical-items.json'), 'utf8'));
const rectsReels = textRectsForTerm(fixture.items, 'RAC');
check('RAC reel (AIM p.11) : rectangle vertical corrige',
  rectsReels,
  [{ x0: 577.303, y0: 239.034, x1: 614.503, y1: 305.178 }]);
{
  const r = rectsReels[0];
  const vraieBoite = { x0: 583.503, y0: 239.034, x1: 614.503, y1: 305.178 };
  const couvre = r && r.x0 <= vraieBoite.x0 && r.y0 <= vraieBoite.y0 &&
    r.x1 >= vraieBoite.x1 && r.y1 >= vraieBoite.y1;
  const vertical = r && (r.x1 - r.x0) < (r.y1 - r.y0);
  check('RAC reel (AIM p.11) : le rectangle contient la vraie boite du mot',
    { couvre, vertical }, { couvre: true, vertical: true });
}

// 5. Non-régression : un item horizontal AVEC matrice donne exactement
// le même rectangle que sans matrice (cf. highlight.test.mjs §4).
check('horizontal avec matrice : identique au calcul sans matrice',
  textRectsForTerm(
    [{ str: 'FUEL', x: 100, y: 700, width: 40, height: 12, transform: [12, 0, 0, 12, 100, 700] }],
    'fuel'),
  [{ x0: 100, y0: 697.6, x1: 140, y1: 712 }]);
check('fixture : item horizontal « TC AIM » inchange',
  textRectsForTerm(fixture.items, 'TC AIM'),
  [{ x0: 62.362, y0: 756.901, x1: 93.178, y1: 767.701 }]);
check('fixture : numero de page horizontal « 183 » inchange',
  textRectsForTerm(fixture.items, '183'),
  [{ x0: 582.359, y0: 15.586, x1: 596.097, y1: 27.586 }]);

// 6. Un mot vertical et un mot horizontal au même y ne se mélangent pas :
// deux rectangles distincts, un vertical et un horizontal.
check('vertical + horizontal au meme y -> deux rectangles separes',
  textRectsForTerm([
    { str: 'RAC', x: 100, y: 300, width: 66, height: 22, transform: [0, -22, 22, 0, 100, 300] },
    { str: 'RAC', x: 200, y: 300, width: 33, height: 11 },
  ], 'RAC'),
  [
    { x0: 95.6, y0: 234, x1: 122, y1: 300 },
    { x0: 200, y0: 297.8, x1: 233, y1: 311 },
  ]);

console.log(failures === 0
  ? '\nTOUS LES TESTS PASSENT'
  : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
