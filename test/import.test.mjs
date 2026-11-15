// Tests de l'import de POH (Node, sans Electron).
// Vérifient la logique pure (import-core.js) contre les VRAIS PDF fournis.
//   node test/import.test.mjs              -> tests rapides (sans OCR)
//   POH_TEST_OCR=1 node test/import.test.mjs -> + OCR d'une page 172N
//     (nécessite pdftoppm, fourni par poppler-utils)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  SCANNED_MEDIAN_CHARS,
  median, slugifyFilename, makeDocId, displayTitle, shortLabel,
  buildPageText, extractPdfText, detectPrintedLabel, detectSections,
  detectSectionsLayered, detectOutlineSections, detectTocSections,
  parseTocEntries, tagSectionsSource,
  isScanned, buildIndex, buildDocEntry, resolveTessdataDir,
  normalizeOcrWords, flattenOcrWords, ocrPngBufferWithWords,
} from '../import-core.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
// Documents anciennement fournis, désormais fixtures de test uniquement
// (v1.2.0 : l'appli livrée ne contient plus aucun document d'origine).
const bundled = path.join(root, 'fixtures', 'bundled');
const docsMeta = JSON.parse(fs.readFileSync(path.join(bundled, 'data/docs.json'), 'utf8'));

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log(`PASSÉ ${name} — ${why}`); }

// 1. Utilitaires.
check('median pair', median([5, 1, 9, 3]), 4);
check('median impair', median([10, 0, 30]), 10);
check('median vide', median([]), 0);
check('slugify', slugifyFilename('Mon POH 172N (Air Richelieu).pdf'), 'mon-poh-172n-air-richelieu');
check('slugify vide -> poh', slugifyFilename('---.pdf'), 'poh');
const id1 = makeDocId('C172N-test.pdf', new Set());
check('makeDocId préfixe', id1.startsWith('imp-c172n-test-'), true);
check('makeDocId collision -> suffixe', makeDocId('a.pdf', new Set([`imp-a-${Date.now().toString(36)}`])).startsWith('imp-a-'), true);
check('displayTitle majuscules', displayTitle('Cessna 172 POH', 'x.pdf'), 'CESSNA 172 POH');
check('displayTitle sans métadonnées', displayTitle(null, 'Mon Poh.pdf'), 'MON POH');
check('displayTitle : extension .pdf retirée du titre intégré', displayTitle('PA44.PDF', 'POH PA44.pdf'), 'PA44');
check('displayTitle : extension .pdf minuscule retirée', displayTitle('Manuel.pdf', 'x.pdf'), 'MANUEL');
check('shortLabel', shortLabel('Test-172N-3p.pdf'), 'TEST172N3P');
check('seuil scanné', SCANNED_MEDIAN_CHARS, 20);

// 2. Numéros imprimés.
check('label 1-1', detectPrintedLabel('INTRODUCTION\n\n1-1'), '1-1');
check('label ii', detectPrintedLabel('TABLE\n\nii'), 'ii');
check('label nombre seul (SOP)', detectPrintedLabel('Chapitre 1\n\n7'), '7');
check('label p. 3', detectPrintedLabel('texte\np. 3'), '3');
check('label absent', detectPrintedLabel('Que du texte\nsans folio'), null);
check('label vide', detectPrintedLabel(''), null);

// 3. Détection des sections (synthétique).
const pagesSec = [
  { pdf_page: 1, text: 'Page de garde' },
  { pdf_page: 2, text: 'SECTION 1\nGENERAL\nBla bla' },
  { pdf_page: 3, text: 'SECTION 1 GENERAL\nSuite' },
  { pdf_page: 4, text: 'SECTION 2\nLIMITATIONS\nBla' },
];
const det = detectSections(pagesSec);
check('sections : kind', det.kind, 'sections');
check('sections : libellés', det.sections.map((s) => s.label),
  ['Début du document', 'Section 1 — General', 'Section 2 — Limitations']);
check('sections : pages de début', det.sections.map((s) => s.startPage), [1, 2, 4]);
check('sections : page 3 -> section 1', det.pageSection.get(3), '1');
const pagesCh = [
  { pdf_page: 1, text: 'Couverture' },
  { pdf_page: 2, text: 'CHAPITRE 1 — Informations générales\nTexte' },
  { pdf_page: 5, text: 'Chapitre 2 — Procédures normales\nTexte' },
];
check('chapitres : kind', detectSections(pagesCh).kind, 'chapters');
check('chapitres : libellés', detectSections(pagesCh).sections.map((s) => s.label),
  ['Début du document', 'Chapitre 1 — Informations générales', 'Chapitre 2 — Procédures normales']);
const pagesNone = [{ pdf_page: 1, text: 'Sans aucun titre de section' }];
const detNone = detectSections(pagesNone);
check('aucune section : kind', detNone.kind, 'none');
check('aucune section : libellé clair', detNone.sections[1].label, 'Section unique — document entier');

// La table des matières du C150N ne crée pas de fausse section.
const pagesToc = [
  { pdf_page: 6, text: 'TABLE OF CONTENTS\nSECTION\nGENERAL 1\nLIMITATIONS 2\nEMERGENCY PROCEDURES 3' },
  { pdf_page: 7, text: 'CESSNA SECTION 1\nMODEL 150M GENERAL\nSECTION 1\nGENERAL\nTABLE OF CONTENTS' },
];
check('TOC : pas de faux positif, section 1 en p. 7',
  detectSections(pagesToc).sections.map((s) => [s.key, s.startPage]), [['front', 1], ['1', 7]]);

// Le PA-44 importé par Julien (14 nov.) : son sommaire (p. 25) et ses
// sommaires par section (p. 27, 41, 53…) listent « SECTION N TITRE »
// SANS points de suite — l'ancienne détection faisait démarrer les 10
// sections p. 25. Index réel du PA-44 (278 pages, OCR).
const pa44 = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'pa44-index.json'), 'utf8'));
const detPa44 = detectSections(pa44.pages);
check('PA-44 : 10 sections + début', detPa44.sections.map((s) => s.key),
  ['front', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
check('PA-44 : pages de début (hors sommaires)', detPa44.sections.map((s) => s.startPage),
  [1, 29, 43, 55, 83, 115, 151, 172, 212, 232, 276]);
check('PA-44 : libellés depuis le sommaire', detPa44.sections.map((s) => s.label),
  ['Début du document', 'Section 1 — General', 'Section 2 — Limitations',
   'Section 3 — Emergency Procedures', 'Section 4 — Normal Procedures',
   'Section 5 — Performance', 'Section 6 — Weight And Balance',
   'Section 7 — Description And Operation Of',
   'Section 8 — Airplane Handling, Servicing',
   'Section 9 — Supplements', 'Section 10 — Safety Tips']);
check('PA-44 : p. 25 -> front, p. 29 -> section 1, p. 151 -> section 6',
  [detPa44.pageSection.get(25), detPa44.pageSection.get(29), detPa44.pageSection.get(151)],
  ['front', '1', '6']);

// Passe numérotée « N.0 » (AIM GEN/RAC, v1.1.3) : titres fusionnés en
// milieu de ligne (extraction deux colonnes) et points de suite.
// La 1.0/2.0 ne sont ici que sur la page de sommaire : repli « mieux
// que rien » (page du sommaire). Les renvois courts (« see 5.0 »),
// les tableaux (« 1.3 1.9 3.0 4.0 5.0 ») et les renvois ponctués
// (« RAC 7.0, Instrument », « MAP 3.0. ») ne créent rien.
const pagesNum = [
  { pdf_page: 1, text: 'Page de garde' },
  { pdf_page: 3, text: 'TABLE OF CONTENTS\n1.0 General Information .... 1\n2.0 Safety .... 8' },
  { pdf_page: 5, text: 'holder continues to meet the certificate\u2019s conditions of issue. 3.0 Transportation Safety Board\nof Canada (TSB)' },
  { pdf_page: 6, text: '4.0 Index of Keywords – National Variations ............................................. MET 7.3' },
  { pdf_page: 7, text: 'system is located in MAP 3.0.\nsee 5.0 for details' },
  { pdf_page: 8, text: '5001 – 7000 1.3 1.9 3.0 4.0 5.0 RAC' },
  { pdf_page: 9, text: 'on the preferential runway should be allowed to continue when An elaboration thereof may be found in RAC 7.0, Instrument' },
];
const detNum = detectSections(pagesNum);
check('numérotée : clés (rien en plus)', detNum.sections.map((s) => s.key),
  ['front', '1.0', '2.0', '3.0', '4.0']);
check('numérotée : pages de début', detNum.sections.map((s) => s.startPage), [1, 3, 3, 5, 6]);
check('numérotée : libellés', detNum.sections.map((s) => s.label),
  ['Début du document', '1.0 — General Information', '2.0 — Safety',
   '3.0 — Transportation Safety Board', '4.0 — Index of Keywords – National Variations']);

// AIM 2026-1 GEN réel (fixture extraite du PDF, 56 pages) : 7/7 contre
// le sommaire officiel (pages PDF : 5, 12, 14, 18, 34, 55, 56).
const aimGen = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'aim-gen-index.json'), 'utf8'));
const detGen = detectSections(aimGen.pages);
check('AIM GEN (fixture) : 7 sections + début', detGen.sections.map((s) => s.key),
  ['front', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0', '7.0']);
check('AIM GEN (fixture) : pages de début (sommaire AIM 2026-1)', detGen.sections.map((s) => s.startPage),
  [1, 5, 12, 14, 18, 34, 55, 56]);
check('AIM GEN (fixture) : sommaire seul -> 7/7 par ancres',
  (() => { const t = detectTocSections(aimGen.pages, null); return t && t.sections.map((s) => s.startPage); })(),
  [1, 5, 12, 14, 18, 34, 55, 56]);

// Sommaire imprimé, synthétique : sans étiquettes de page, le décalage
// imprimé→PDF vient des ancres (médiane 4 sur 3 ancres).
function blankPages(n, overrides = {}) {
  return Array.from({ length: n }, (_, i) => ({ pdf_page: i + 1, text: overrides[i + 1] || '' }));
}
const pagesTocOk = blankPages(14, {
  2: 'Table of Contents\n1.0 General Information .... 1\n2.0 Safety .... 8\n3.0 Transportation Safety Board .... 10',
  5: '1.0 General Information\nContenu',
  12: '2.0 Safety\nContenu',
  14: 'holder continues to meet the certificate\u2019s conditions of issue. 3.0 Transportation Safety Board\nof Canada (TSB)',
});
const tocOk = detectTocSections(pagesTocOk, null);
check('sommaire par ancres : pages', tocOk && tocOk.sections.map((s) => s.startPage), [1, 5, 12, 14]);
check('sommaire par ancres : confiance 0.8', tocOk && tocOk.sections[1].confidence, 0.8);
check('sommaire par ancres : source toc', tocOk && tocOk.sections[1].source, 'toc');
// Même sommaire, références non numériques : les étiquettes de page
// donnent les pages exactes (confiance 0.9).
const pagesTocLabels = blankPages(14, {
  2: 'Table of Contents\n1.0 General Information .... A\n2.0 Safety .... B\n3.0 Transportation Safety Board .... C',
  5: '1.0 General Information\nContenu',
  12: '2.0 Safety\nContenu',
  14: '3.0 Transportation Safety Board\nContenu',
});
const labels14 = ['COVER', 'i', 'ii', 'iii', 'A', 'x', 'x', 'x', 'x', 'x', 'x', 'B', 'x', 'C'];
const tocLab = detectTocSections(pagesTocLabels, labels14);
check('sommaire par étiquettes : pages', tocLab && tocLab.sections.map((s) => s.startPage), [1, 5, 12, 14]);
check('sommaire par étiquettes : confiance 0.9', tocLab && tocLab.sections[1].confidence, 0.9);
// Sommaire façon C150N : ses numéros (1, 2, 3…) ne sont pas des pages —
// les ancres se contredisent (décalages 6, 13, 22, 36) -> sommaire
// rejeté, repli sur la couche titres.
const pagesTocBad = blankPages(40, {
  2: 'TABLE OF CONTENTS\nGENERAL 1\nLIMITATIONS 2\nEMERGENCY PROCEDURES 3\nNORMAL PROCEDURES 4',
  7: 'SECTION 1\nGENERAL\nContenu',
  15: 'SECTION 2\nLIMITATIONS\nContenu',
  25: 'SECTION 3\nEMERGENCY PROCEDURES\nContenu',
  40: 'SECTION 4\nNORMAL PROCEDURES\nContenu',
});
check('sommaire C150N : 4 entrées lues', parseTocEntries(pagesTocBad).entries.length, 4);
check('sommaire C150N : rejeté (ancres en désaccord)', detectTocSections(pagesTocBad, null), null);
// Sommaire « SECTION N TITRE » (PA-44) : le motif est lu sur le titre
// brut, la clé reste le numéro de section.
const pagesTocSec = blankPages(15, {
  2: 'TABLE OF CONTENTS\nSECTION 1 GENERAL .... 1\nSECTION 2 LIMITATIONS .... 9',
  7: 'SECTION 1\nGENERAL\nContenu',
  15: 'SECTION 2\nLIMITATIONS\nContenu',
});
const tocSec = detectTocSections(pagesTocSec, null);
check('sommaire SECTION : clés', tocSec && tocSec.sections.map((s) => s.key), ['front', '1', '2']);
check('sommaire SECTION : pages', tocSec && tocSec.sections.map((s) => s.startPage), [1, 7, 15]);
check('tagSectionsSource : source + confiance',
  tagSectionsSource([{ key: 'front', label: 'D', startPage: 1 }, { key: '1', label: 'S', startPage: 7 }], 'toc', 0.8),
  [{ key: 'front', label: 'D', startPage: 1, source: 'toc', confidence: 1 },
   { key: '1', label: 'S', startPage: 7, source: 'toc', confidence: 0.8 }]);

// 4. Scanné / non scanné.
check('isScanned vide', isScanned([{ text: '' }, { text: 'ab' }]), { scanned: true, medianChars: 1, charsPerPage: [0, 2] });
check('isScanned plein', isScanned([{ text: 'x'.repeat(500) }, { text: 'y'.repeat(400) }]).scanned, false);

// 5. Extraction réelle du C150N + sections comparées à docs.json.
const c150 = await extractPdfText(path.join(bundled, 'assets/C150N-final.pdf'));
check('C150N : 199 pages', c150.numPages, 199);
check('C150N : page 2 vide (comme l’index fourni)', c150.pages[1].text, '');
check('C150N : page 3 contient PERFORMANCE', c150.pages[2].text.includes('PERFORMANCE'), true);
const det150 = detectSections(c150.pages);
const ref150 = docsMeta.docs.find((d) => d.id === 'c150n');
check('C150N : sections détectées = docs.json (pages de début)',
  det150.sections.map((s) => s.startPage), ref150.sections.map((s) => s.startPage));
check('C150N : sections détectées = docs.json (clés)',
  det150.sections.map((s) => s.key), ref150.sections.map((s) => s.key));
const idx150 = buildIndex({ docId: 'c150n-test', title: 'TEST', pdfPath: 'user-pohs/x/y.pdf', pages: c150.pages });
check('C150N : index même format (clés)', Object.keys(idx150).sort(), ['doc_id', 'pages', 'pdf_path', 'title']);
check('C150N : page 7 label 1-1', idx150.pages[6].printed_label, '1-1');
check('C150N : page 5 label ii', idx150.pages[4].printed_label, 'ii');
check('C150N : page 7 section 1', idx150.pages[6].section, '1');
check('C150N : non scanné', isScanned(c150.pages).scanned, false);

// 5b. Détection en couches (v1.1.3).
// C150N : pas de signets, sommaire non fiable -> repli titres, sections
// identiques à docs.json.
const lay150 = await detectSectionsLayered(path.join(bundled, 'assets/C150N-final.pdf'), c150.pages);
check('couches C150N : source titres', lay150.source, 'heading');
check('couches C150N : sections = docs.json (pages)',
  lay150.sections.map((s) => s.startPage), ref150.sections.map((s) => s.startPage));
check('couches C150N : confiance titres', lay150.sections[1].confidence, 0.75);
// Fichier illisible ou absent -> repli titres, jamais d'exception.
const layMissing = await detectSectionsLayered(path.join(base, 'assets/n-existe-pas.pdf'), c150.pages);
check('couches fichier absent : repli titres', layMissing.source, 'heading');
// Signets : le C150N n'en a pas.
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc150 = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(path.join(bundled, 'assets/C150N-final.pdf'))), isEvalSupported: false }).promise;
check('signets C150N : aucun', await detectOutlineSections(doc150, c150.pages), null);
// AIM GEN/RAC : signets présents (PDF téléchargés dans /tmp, sinon passé).
for (const [nom, fichier, cles, pagesDebut] of [
  ['GEN', '/tmp/aim-gen.pdf',
   ['front', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0', '7.0'],
   [1, 5, 12, 14, 18, 34, 55, 56]],
  ['RAC', '/tmp/aim-rac.pdf',
   ['front', '1.0', '2.0', '3.0', '4.0', '5.0', '6.0', '7.0', '8.0', '9.0', '10.0', '11.0', '12.0'],
   [1, 11, 24, 37, 59, 81, 84, 89, 95, 100, 131, 134, 143]],
]) {
  if (!fs.existsSync(fichier)) { skip(`couches ${nom} (signets)`, 'PDF non téléchargé dans /tmp'); continue; }
  const exAim = await extractPdfText(fichier);
  const layAim = await detectSectionsLayered(fichier, exAim.pages);
  check(`couches ${nom} : source signets`, layAim.source, 'outline');
  check(`couches ${nom} : sections`, layAim.sections.map((s) => s.key), cles);
  check(`couches ${nom} : pages`, layAim.sections.map((s) => s.startPage), pagesDebut);
  check(`couches ${nom} : confiance signets`, layAim.sections[1].confidence, 0.95);
}
// buildIndex : pageSection et sectionSource fournis par la détection en
// couches (sinon, la passe titres — testée plus haut, clés inchangées).
const idxOver = buildIndex({
  docId: 'x', title: 'T', pdfPath: 'p', pages: c150.pages.slice(0, 10),
  pageSection: new Map([[1, 'front'], [7, '1']]), sectionSource: 'outline',
});
check('index : pageSection fourni respecté', idxOver.pages[6].section, '1');
check('index : section_source stockée', idxOver.section_source, 'outline');

// 6. Entrée docs.json.
const entry = buildDocEntry({
  docId: 'imp-test-abc', title: 'TEST', short: 'TEST', subtitle: 'Importé',
  pdfFile: 'Test.pdf', sections: det.sections, totalPages: 4, ocr: true, ocrNote: 'Note OCR',
});
check('doc entry : chemins user-pohs', [entry.pdf, entry.index],
  ['user-pohs/imp-test-abc/Test.pdf', 'user-pohs/imp-test-abc/index.json']);
check('doc entry : ocr + note', [entry.ocr, entry.ocrNote], [true, 'Note OCR']);

// 6b. Boîtes de mots OCR (v1.1.3 — surlignage).
check('mots OCR : mots valides gardés, confiance bornée',
  normalizeOcrWords([
    { text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
    { text: 'pump', confidence: 250, bbox: { x0: 70, y0: 20, x1: 120, y1: 40 } },
    { text: '', confidence: 90, bbox: { x0: 0, y0: 0, x1: 5, y1: 5 } },
    { text: 'sans-boite', confidence: 90, bbox: null },
    { text: 'inversee', confidence: 90, bbox: { x0: 60, y0: 20, x1: 10, y1: 40 } },
  ]),
  [
    { text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
    { text: 'pump', confidence: 100, bbox: { x0: 70, y0: 20, x1: 120, y1: 40 } },
  ]);
check('mots OCR : entrée non-tableau -> []', normalizeOcrWords(undefined), []);
check('mots OCR : repli système (pas de boîtes) -> []', normalizeOcrWords(null), []);
const fakeTessData = {
  blocks: [
    { paragraphs: [{ lines: [{ words: [
      { text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
    ] }] }] },
    { paragraphs: [] },
    { /* bloc sans paragraphes */ },
  ],
};
check('mots OCR : aplatissement blocs -> mots',
  flattenOcrWords(fakeTessData),
  [{ text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } }]);
check('mots OCR : blocks null -> []', flattenOcrWords({ blocks: null }), []);
check('mots OCR : données absentes -> []', flattenOcrWords(null), []);
// ocrPngBufferWithWords : le worker doit être appelé avec { blocks: true }
// (sans ça, tesseract.js ne retourne que le texte) ; texte + mots reviennent.
const fakeWorkerCalls = [];
const fakeWorker = {
  async recognize(png, opts, output) {
    fakeWorkerCalls.push({ opts, output });
    const words = [
      { text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
      { text: 'pump', confidence: 88, bbox: { x0: 70, y0: 20, x1: 120, y1: 40 } },
    ];
    return { data: { text: 'Fuel pump\n', blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } };
  },
};
const withWords = await ocrPngBufferWithWords(fakeWorker, Buffer.from('png-factice'));
check('mots OCR : recognize appelé avec blocks:true',
  fakeWorkerCalls, [{ opts: {}, output: { text: true, blocks: true } }]);
check('mots OCR : texte reconnu', withWords.text, 'Fuel pump');
check('mots OCR : mots reconnus', withWords.words,
  [{ text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } },
   { text: 'pump', confidence: 88, bbox: { x0: 70, y0: 20, x1: 120, y1: 40 } }]);
// buildIndex : les boîtes sont stockées dans l'entrée de page (champ
// ocr_words) quand elles sont fournies, absentes sinon.
const idxWords = buildIndex({
  docId: 'x', title: 'T', pdfPath: 'p',
  pages: [{ pdf_page: 1, text: 'Page un' }, { pdf_page: 2, text: 'Page deux' }],
  ocrWords: new Map([[2, { imageWidth: 1275, imageHeight: 1650,
    words: [{ text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } }] }]]),
});
check('index : page sans boîtes -> pas de champ ocr_words', 'ocr_words' in idxWords.pages[0], false);
check('index : page avec boîtes -> ocr_words stocké', idxWords.pages[1].ocr_words,
  { imageWidth: 1275, imageHeight: 1650,
    words: [{ text: 'Fuel', confidence: 95, bbox: { x0: 10, y0: 20, x1: 60, y1: 40 } }] });
const idxNoWords = buildIndex({
  docId: 'x', title: 'T', pdfPath: 'p',
  pages: [{ pdf_page: 1, text: 'Page un' }],
});
check('index : sans ocrWords, format inchangé (clés page)',
  Object.keys(idxNoWords.pages[0]).sort(), ['pdf_page', 'printed_label', 'section', 'text']);
const idxEmptyWords = buildIndex({
  docId: 'x', title: 'T', pdfPath: 'p',
  pages: [{ pdf_page: 1, text: 'Page un' }],
  ocrWords: new Map([[1, { imageWidth: 1275, imageHeight: 1650, words: [] }]]),
});
check('index : repli système -> mots vides stockés', idxEmptyWords.pages[0].ocr_words,
  { imageWidth: 1275, imageHeight: 1650, words: [] });

// 7. Tessdata vendu présent.
const tess = resolveTessdataDir([path.join(base, 'assets', 'tesseract', 'tessdata')]);
check('tessdata fra+eng vendu', tess, path.join(base, 'assets', 'tesseract', 'tessdata'));

// 8. OCR d'une page 172N (scannée) — lent, sous POH_TEST_OCR=1 seulement.
if (process.env.POH_TEST_OCR === '1') {
  try {
    execFileSync('pdftoppm', ['-png', '-r', '200', '-f', '8', '-l', '8',
      path.join(bundled, 'assets/C172N-final.pdf'), '/tmp/poh-import-ocr-page'], { stdio: 'ignore' });
    const rendered = fs.readdirSync('/tmp').filter((f) => f.startsWith('poh-import-ocr-page-') && f.endsWith('.png')).sort();
    if (!rendered.length) throw new Error('pdftoppm n’a rien produit');
    const png = fs.readFileSync(path.join('/tmp', rendered[0]));
    const { getOcrWorker, ocrPngBuffer, terminateOcrWorker } = await import('../import-core.js');
    const worker = await getOcrWorker(tess, () => {});
    const text = await ocrPngBuffer(worker, png);
    await terminateOcrWorker();
    check('OCR 172N p. 8 : trouve SECTION 1', text.includes('SECTION 1'), true);
    check('OCR 172N p. 8 : trouve GENERAL', /GENERAL/i.test(text), true);
    check('OCR 172N p. 8 : plus de 500 caractères', text.length > 500, true);
    console.log('  (extrait OCR : ' + JSON.stringify(text.slice(0, 120)) + ')');
  } catch (e) {
    console.log(`ÉCHEC OCR 172N p. 8 — ${e.message}`);
    failures++;
  }
} else {
  skip('OCR 172N p. 8', 'lancer avec POH_TEST_OCR=1 (lent)');
}

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
