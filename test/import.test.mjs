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
  isScanned, buildIndex, buildDocEntry, resolveTessdataDir,
} from '../import-core.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
const docsMeta = JSON.parse(fs.readFileSync(path.join(base, 'data/docs.json'), 'utf8'));

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

// 4. Scanné / non scanné.
check('isScanned vide', isScanned([{ text: '' }, { text: 'ab' }]), { scanned: true, medianChars: 1, charsPerPage: [0, 2] });
check('isScanned plein', isScanned([{ text: 'x'.repeat(500) }, { text: 'y'.repeat(400) }]).scanned, false);

// 5. Extraction réelle du C150N + sections comparées à docs.json.
const c150 = await extractPdfText(path.join(base, 'assets/C150N-final.pdf'));
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

// 6. Entrée docs.json.
const entry = buildDocEntry({
  docId: 'imp-test-abc', title: 'TEST', short: 'TEST', subtitle: 'Importé',
  pdfFile: 'Test.pdf', sections: det.sections, totalPages: 4, ocr: true, ocrNote: 'Note OCR',
});
check('doc entry : chemins user-pohs', [entry.pdf, entry.index],
  ['user-pohs/imp-test-abc/Test.pdf', 'user-pohs/imp-test-abc/index.json']);
check('doc entry : ocr + note', [entry.ocr, entry.ocrNote], [true, 'Note OCR']);

// 7. Tessdata vendu présent.
const tess = resolveTessdataDir([path.join(base, 'assets', 'tesseract', 'tessdata')]);
check('tessdata fra+eng vendu', tess, path.join(base, 'assets', 'tesseract', 'tessdata'));

// 8. OCR d'une page 172N (scannée) — lent, sous POH_TEST_OCR=1 seulement.
if (process.env.POH_TEST_OCR === '1') {
  try {
    execFileSync('pdftoppm', ['-png', '-r', '200', '-f', '8', '-l', '8',
      path.join(base, 'assets/C172N-final.pdf'), '/tmp/poh-import-ocr-page'], { stdio: 'ignore' });
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
