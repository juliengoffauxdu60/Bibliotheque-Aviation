// Tests de la détection des sections à DEUX NIVEAUX (v1.2.1, Node, sans Electron).
// Complète test/import.test.mjs : ici la hiérarchie chapitres / sous-sections
// (detectSectionsLayered, detectOutlineSections, detectTocSections avec
// chapitres), le bloc de sommaire en tête (passe titres) et le helper
// d'affichage renderer/sections.js.
// Le vrai AIM (569 p., 87 sections) est vérifié par le script LOCAL
// /tmp/verify-aim-v121.mjs (jamais commité) — cette suite n'utilise que des
// fixtures synthétiques et reste dans le dépôt.
//   node test/layered.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractPdfText, detectSections, detectSectionsLayered, detectOutlineSections,
  detectTocSections,
} from '../import-core.js';
import { multiChapterPdfPath } from './fixtures/multi-chapter-pdf.mjs';
import { fullSectionLabel } from '../renderer/sections.js';

const root = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

function blankPages(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({ pdf_page: i + 1, text: overrides[i + 1] || '' }));
}

// ---------------------------------------------------------------------------
// B. PDF synthétique multi-chapitres avec VRAIS signets (fixture générée
// en écriture brute : test/fixtures/multi-chapter-pdf.mjs, 12 pages).
// ---------------------------------------------------------------------------
const mcPdf = multiChapterPdfPath();
const mc = await extractPdfText(mcPdf);
check('B : PDF multi-chapitres 12 pages', mc.numPages, 12);
const layMc = await detectSectionsLayered(mcPdf, mc.pages);
check('B : source signets', layMc.source, 'outline');
check('B : clés (chapitres + sous-sections qualifiées)',
  layMc.sections.map((s) => s.key),
  ['front', 'GEN', 'GEN 1.0', 'GEN 2.0', 'AGA', 'AGA 1.0', 'AGA 2.0', 'RAC']);
check('B : pages de début',
  layMc.sections.map((s) => s.startPage), [1, 3, 3, 5, 7, 7, 9, 11]);
check('B : niveaux (0 début, 1 chapitre, 2 sous-section)',
  layMc.sections.map((s) => s.level), [0, 1, 2, 2, 1, 2, 2, 1]);
check('B : libellés',
  layMc.sections.map((s) => s.label),
  ['Début du document', 'GEN — Généralités', '1.0 — Renseignements généraux',
   '2.0 — Sécurité', 'AGA — Aérodromes', '1.0 — Généralités',
   '2.0 — Exploitation', "RAC — Règles de l'air"]);
check('B : sous-sections portent leur chapitre',
  layMc.sections.filter((s) => s.level === 2).map((s) => [s.key, s.chapter, s.chapterLabel]),
  [['GEN 1.0', 'GEN', 'GEN — Généralités'], ['GEN 2.0', 'GEN', 'GEN — Généralités'],
   ['AGA 1.0', 'AGA', 'AGA — Aérodromes'], ['AGA 2.0', 'AGA', 'AGA — Aérodromes']]);
check('B : chapitres sans champ chapter', layMc.sections.filter((s) => s.level === 1).every((s) => !('chapter' in s)), true);
check('B : branche « Table des matières » exclue (GEN démarre p.3, pas p.2)',
  layMc.sections.find((s) => s.key === 'GEN').startPage, 3);
check('B : aucune section ne démarre sur la page de sommaire',
  layMc.sections.filter((s) => s.startPage === 2).map((s) => s.key), []);
check('B : chapitre sans sous-section numérotée quand même affiché (RAC@11)',
  layMc.sections.some((s) => s.key === 'RAC' && s.level === 1 && s.startPage === 11), true);
check('B : numéros qui recommencent à chaque chapitre (deux « 1.0 » distincts)',
  layMc.sections.filter((s) => s.key.endsWith('1.0')).map((s) => s.key), ['GEN 1.0', 'AGA 1.0']);
check('B : mapping des pages',
  [layMc.pageSection.get(4), layMc.pageSection.get(6), layMc.pageSection.get(8),
   layMc.pageSection.get(10), layMc.pageSection.get(12)],
  ['GEN 1.0', 'GEN 2.0', 'AGA 1.0', 'AGA 2.0', 'RAC']);
check('B : confiance signets 0.95', layMc.sections[1].confidence, 0.95);

// ---------------------------------------------------------------------------
// B (mock). detectOutlineSections sur un faux document pdfjs : même
// hiérarchie, sans passer par des octets de PDF — prouve la logique
// (exclusion du sommaire, déduplication, chapitre seul, repli plat).
// ---------------------------------------------------------------------------
function mockDoc(outlineTree, pageOfDest) {
  const refs = new Map(); // dest string -> { page }
  for (const [dest, page] of Object.entries(pageOfDest)) refs.set(dest, { page });
  return {
    numPages: 12,
    async getOutline() { return outlineTree; },
    async getDestination(dest) {
      const r = refs.get(dest);
      return r ? [r] : null;
    },
    async getPageIndex(ref) { return ref.page - 1; },
  };
}
const mockPages = blankPages(12);
const mockTree = [
  { title: 'Table des matières', dest: 'toc', items: [
    { title: 'GEN — Généralités', dest: 'toc-gen', items: [] },
  ] },
  { title: 'GEN — Généralités', dest: 'gen', items: [
    { title: '1.0 Renseignements généraux', dest: 'g1', items: [] },
    { title: '1.0 Renseignements généraux', dest: 'g1dup', items: [] },
    { title: '2.0 Sécurité', dest: 'g2', items: [] },
  ] },
  { title: 'RAC — Règles de l’air', dest: 'rac', items: [] },
];
const mockOut = await detectOutlineSections(
  mockDoc(mockTree, { toc: 2, 'toc-gen': 2, gen: 3, g1: 3, g1dup: 3, g2: 5, rac: 11 }), mockPages);
check('B mock : clés (sommaire exclu, doublon « 1.0 » dédupliqué)',
  mockOut && mockOut.sections.map((s) => s.key),
  ['front', 'GEN', 'GEN 1.0', 'GEN 2.0', 'RAC']);
check('B mock : pages', mockOut && mockOut.sections.map((s) => s.startPage), [1, 3, 3, 5, 11]);
check('B mock : chapitre seul (RAC) conservé', mockOut && mockOut.sections.some((s) => s.key === 'RAC' && s.level === 1), true);
// Document plat : signets numérotés sans chapitre -> clés plates, niveau 2, sans chapter.
const mockFlat = await detectOutlineSections(
  mockDoc([
    { title: '1.0 Renseignements généraux', dest: 'f1', items: [] },
    { title: '2.0 Sécurité', dest: 'f2', items: [] },
  ], { f1: 3, f2: 5 }), mockPages);
check('B mock plat : clés plates', mockFlat && mockFlat.sections.map((s) => s.key), ['front', '1.0', '2.0']);
check('B mock plat : niveau 2 sans chapter',
  mockFlat && mockFlat.sections.slice(1).map((s) => [s.level, 'chapter' in s]), [[2, false], [2, false]]);
// Un seul signet numéroté -> pas assez pour une détection -> null.
const mockOne = await detectOutlineSections(
  mockDoc([{ title: '1.0 Renseignements généraux', dest: 'f1', items: [] }], { f1: 3 }), mockPages);
check('B mock : un seul signet -> null', mockOne, null);
// getOutline en échec -> null, jamais d'exception.
const mockErr = await detectOutlineSections(
  { numPages: 12, async getOutline() { throw new Error('signets illisibles'); } }, mockPages);
check('B mock : signets illisibles -> null', mockErr, null);

// ---------------------------------------------------------------------------
// C. Sommaire imprimé avec chapitres (detectTocSections).
// ---------------------------------------------------------------------------
const pagesTocCh = blankPages(12, {
  2: 'Table des matières\nGEN — Généralités .... 1\n1.0 Renseignements généraux .... 1\n2.0 Sécurité .... 3\nAGA — Aérodromes .... 5\n1.0 Généralités .... 5\n2.0 Exploitation .... 7',
  5: 'GEN — Généralités\n1.0 Renseignements généraux\nContenu',
  7: '2.0 Sécurité\nContenu',
  9: 'AGA — Aérodromes\n1.0 Généralités\nContenu',
  11: '2.0 Exploitation\nContenu',
});
const tocCh = detectTocSections(pagesTocCh, null);
check('C : sommaire avec chapitres -> clés qualifiées',
  tocCh && tocCh.sections.map((s) => s.key),
  ['front', 'GEN', 'GEN 1.0', 'GEN 2.0', 'AGA', 'AGA 1.0', 'AGA 2.0']);
check('C : sommaire avec chapitres -> pages',
  tocCh && tocCh.sections.map((s) => s.startPage), [1, 5, 5, 7, 9, 9, 11]);
check('C : sommaire avec chapitres -> niveaux',
  tocCh && tocCh.sections.map((s) => s.level), [0, 1, 2, 2, 1, 2, 2]);
check('C : sommaire avec chapitres -> chapitre des sous-sections',
  tocCh && tocCh.sections.filter((s) => s.level === 2).map((s) => s.chapter),
  ['GEN', 'GEN', 'AGA', 'AGA']);
check('C : sommaire par ancres -> confiance 0.8', tocCh && tocCh.sections[1].confidence, 0.8);
// Sans chapitre : comportement identique à avant (clés plates).
const pagesTocFlat = blankPages(12, {
  2: 'Table des matières\n1.0 Renseignements généraux .... 1\n2.0 Sécurité .... 3\n3.0 Divers .... 5',
  5: '1.0 Renseignements généraux\nContenu',
  7: '2.0 Sécurité\nContenu',
  9: '3.0 Divers\nContenu',
});
const tocFlat = detectTocSections(pagesTocFlat, null);
check('C plat : clés plates, niveau 2, sans chapitre',
  tocFlat && tocFlat.sections.map((s) => [s.key, s.level, 'chapter' in s]),
  [['front', 0, false], ['1.0', 2, false], ['2.0', 2, false], ['3.0', 2, false]]);

// ---------------------------------------------------------------------------
// D. Passe titres : bloc de sommaire en TÊTE exclu, index en milieu de
// document conservé (cas GEN 4.0@18 du fixture, déjà en import.test).
// ---------------------------------------------------------------------------
const pagesFront = blankPages(12, {
  2: 'TABLE DES MATIÈRES\n1.0 Renseignements généraux .... 1\n2.0 Sécurité .... 3\n9.0 Systèmes d’avertissement .... 9',
  3: '9.0 Systèmes d’avertissement\n1.0 Renseignements généraux .... 1\n2.0 Sécurité .... 3\n9.0 Systèmes d’avertissement .... 9',
  5: '1.0 Renseignements généraux\nContenu du corps',
  7: '2.0 Sécurité\nContenu du corps',
  10: '9.0 Systèmes d’avertissement\nVrai début de la section 9.0.',
});
const detFront = detectSections(pagesFront);
check('D : bloc de tête -> 9.0 va à la vraie page, pas à la page de sommaire',
  detFront.sections.map((s) => [s.key, s.startPage]),
  [['front', 1], ['1.0', 5], ['2.0', 7], ['9.0', 10]]);
check('D : bloc de tête -> aucune section ne démarre sur les p.2-3',
  detFront.sections.filter((s) => s.startPage === 2 || s.startPage === 3).length, 0);
check('D : bloc de tête -> la mention propre en début de ligne p.3 ne compte pas',
  detFront.pageSection.get(3), 'front');
// La règle n'exclut pas trop : le fixture GEN garde 4.0@18 — vrai départ
// sur une page d'index en MILIEU de document, hors du bloc de tête.
const aimGen = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'aim-gen-index.json'), 'utf8'));
const detGen = detectSections(aimGen.pages);
check('D : GEN fixture garde 4.0@18 (index milieu de document, hors bloc de tête)',
  detGen.sections.find((s) => s.key === '4.0')?.startPage, 18);
check('D : GEN fixture, autres départs inchangés',
  detGen.sections.map((s) => s.startPage), [1, 5, 12, 14, 18, 34, 55, 56]);
// Limites connues de la passe titres, vérifiées sur le vrai AIM
// (/tmp/verify-aim-v121.mjs) — documentées ici, à ne pas « corriger » en
// affaiblissant les règles : 5.0 -> p.98 (titre absent du texte extrait
// de p.66), 7.0 -> p.89 (titre fusionné en milieu de ligne), 10.0 ->
// p.166 (titre fusionné trop court). Les signets donnent p.66 / p.89
// (GEN 7.0) / p.120 (AGA 10.0).

// ---------------------------------------------------------------------------
// E. Documents simples intacts (couche titres quand le PDF est absent).
// ---------------------------------------------------------------------------
const pa44 = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'pa44-index.json'), 'utf8'));
const layPa44 = await detectSectionsLayered(path.join(root, 'fixtures', 'n-existe-pas.pdf'), pa44.pages);
check('E : PA-44 sans PDF -> repli titres', layPa44.source, 'heading');
check('E : PA-44 repli titres -> 10 sections, pages inchangées',
  layPa44.sections.map((s) => s.startPage), [1, 29, 43, 55, 83, 115, 151, 172, 212, 232, 276]);
check('E : PA-44 repli titres -> clés plates', layPa44.sections.map((s) => s.key),
  ['front', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
// Sans rien du tout : une seule section « document entier ».
const layNone = await detectSectionsLayered(null, blankPages(3, { 1: 'Texte sans aucun titre.' }));
check('E : sans titre -> source titres, kind none', [layNone.source, layNone.kind], ['heading', 'none']);
check('E : sans titre -> Section unique', layNone.sections.map((s) => [s.key, s.label]),
  [['front', 'Début du document'], ['1', 'Section unique — document entier']]);

// ---------------------------------------------------------------------------
// Helper d'affichage à deux niveaux (renderer/sections.js, module pur).
// ---------------------------------------------------------------------------
check('label : sous-section avec chapitre -> préfixe',
  fullSectionLabel({ key: 'GEN 1.0', label: '1.0 — Renseignements généraux', chapter: 'GEN' }),
  'GEN 1.0 — Renseignements généraux');
check('label : sous-section déjà préfixée -> inchangée',
  fullSectionLabel({ key: 'GEN 1.0', label: 'GEN 1.0 — Renseignements généraux', chapter: 'GEN' }),
  'GEN 1.0 — Renseignements généraux');
check('label : sous-section sans chapter explicite + chapitre de repli (position)',
  fullSectionLabel({ key: '1.0', label: '1.0 — Renseignements généraux' }, 'RAC'),
  'RAC 1.0 — Renseignements généraux');
check('label : document simple (pas de chapitre) -> libellé tel quel',
  fullSectionLabel({ key: '1', label: 'Section 1 — General' }), 'Section 1 — General');
check('label : chapitre lui-même -> libellé tel quel',
  fullSectionLabel({ key: 'GEN', label: 'GEN — Généralités' }), 'GEN — Généralités');
check('label : section absente -> chaîne vide', fullSectionLabel(null), '');
check('label : anciennes données sans level -> libellé tel quel',
  fullSectionLabel({ key: '1.0', label: '1.0 — Safety' }), '1.0 — Safety');

console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
