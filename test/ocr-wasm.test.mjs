// Tests de non-régression du bug WASM (v1.2.2, 16 nov. 2026).
// Le 172N de Julien (242 p., images CCITT Groupe 4) rendait des pages
// BLANCHES : les décodeurs WASM de pdf.js (jbig2.wasm pour CCITT/JBIG2,
// openjpeg.wasm pour JPEG2000) n'étaient pas livrés dans assets/pdfjs/ et
// wasmUrl n'était jamais défini — la lecture du texte tournait alors à
// vide (0 caractère sur 242 pages, quelques secondes). Ces tests vérifient
// la présence des fichiers, le branchement wasmUrl et le fixture CCITT.
//   node test/ocr-wasm.test.mjs              -> contrôles statiques rapides
//   POH_TEST_OCR=1 node test/ocr-wasm.test.mjs -> + OCR du fixture CCITT
//     (nécessite pdftoppm, fourni par poppler-utils, et tesseract.js)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractPdfText, isScanned,
  resolveTessdataDir, getOcrWorker, ocrPngBufferWithWords, terminateOcrWorker,
} from '../import-core.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log(`PASSÉ ${name} — ${why}`); }

// 1. Décodeurs WASM livrés dans assets/pdfjs/wasm/ (copies exactes de
// node_modules/pdfjs-dist/wasm/ — voir RAPPORT-VERIFICATION.md).
const WASM_DIR = path.join(base, 'assets', 'pdfjs', 'wasm');
for (const f of ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm',
  'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm']) {
  check(`wasm présent : ${f}`, fs.existsSync(path.join(WASM_DIR, f)), true);
}
check('jbig2.wasm non vide (> 50 Ko)', fs.statSync(path.join(WASM_DIR, 'jbig2.wasm')).size > 50 * 1024, true);
check('openjpeg.wasm non vide (> 100 Ko)', fs.statSync(path.join(WASM_DIR, 'openjpeg.wasm')).size > 100 * 1024, true);
check('jbig2.wasm identique à pdfjs-dist',
  fs.readFileSync(path.join(WASM_DIR, 'jbig2.wasm')).equals(
    fs.readFileSync(path.join(base, 'node_modules', 'pdfjs-dist', 'wasm', 'jbig2.wasm'))), true);
check('openjpeg.wasm identique à pdfjs-dist',
  fs.readFileSync(path.join(WASM_DIR, 'openjpeg.wasm')).equals(
    fs.readFileSync(path.join(base, 'node_modules', 'pdfjs-dist', 'wasm', 'openjpeg.wasm'))), true);

// 2. wasmUrl branché aux deux getDocument du rendu (lecteur + lecture du
// texte) — sans lui, pdf.js ne sait pas où chercher les .wasm.
const appJs = fs.readFileSync(path.join(base, 'renderer', 'app.js'), 'utf8');
const importJs = fs.readFileSync(path.join(base, 'renderer', 'import.js'), 'utf8');
check('wasmUrl dans renderer/app.js', appJs.includes("wasmUrl: 'app://assets/pdfjs/wasm/'"), true);
check('wasmUrl dans renderer/import.js', importJs.includes("wasmUrl: 'app://assets/pdfjs/wasm/'"), true);

// 3. Type MIME .wasm dans le protocole app:// (main.js) — sinon le
// chargement du .wasm est refusé ou dégradé.
const mainJs = fs.readFileSync(path.join(base, 'main.js'), 'utf8');
check("MIME '.wasm' dans main.js", mainJs.includes("'.wasm': 'application/wasm'"), true);

// 4. Le paquet embarque assets/pdfjs/** (donc wasm/ aussi).
const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));
check('build.files couvre assets/pdfjs/**', pkg.build.files.includes('assets/pdfjs/**'), true);
check('version 1.2.5', pkg.version, '1.2.5');

// 5. Garde anti-pages-vides dans la lecture du texte (import.js) : elle
// doit exister — c'est elle qui aurait arrêté la boucle à la page 5 au
// lieu de laisser tourner 242 pages à vide.
check('garde pages vides présente (pageLooksBlank)', importJs.includes('pageLooksBlank'), true);
check('garde pages vides présente (BLANK_STREAK_MAX)', importJs.includes('BLANK_STREAK_MAX'), true);
check('lecture auto après import (startOcr appelé)', importJs.includes('if (!window.__pohImportNoAutoOcr) startOcr(res.doc_id);'), true);
check('reprise sur la carte (Rendre cherchable)', importJs.includes("textContent = 'Rendre cherchable'"), true);
check('reprise au démarrage (needsTextReading)', importJs.includes('state.imported.find(needsTextReading)'), true);

// 6. Zéro artefact GitHub Actions (v1.2.4, 17 nov. 2026) : le quota
// gratuit (500 Mo) est dépassé à chaque version (~450-545 Mo par run,
// deux runs par version) et le compteur GitHub n'a pas recalculé la
// suppression des 52 artefacts du 16 nov. (~32 h après, 0 octet vérifié
// par API) — chaque run échouait à l'upload d'artefact. Les
// installateurs vont donc DIRECTEMENT dans la Release (`gh release
// upload`), sans passer par les artefacts. Ce contrôle verrouille
// l'invariant : aucun upload/download-artifact ne doit revenir.
const workflow = fs.readFileSync(path.join(base, '.github', 'workflows', 'build.yml'), 'utf8');
check('aucun upload-artifact', !workflow.includes('upload-artifact'), true);
check('aucun download-artifact', !workflow.includes('download-artifact'), true);
check('envoi direct vers la Release (2 occurrences)', (workflow.match(/run: gh release upload/g) || []).length, 2);
check('Release créée en brouillon avant les builds', workflow.includes('gh release create'), true);

// 7. Fixture CCITT (test/fixtures/ccitt-1p.pdf) : 1 page, image CCITT G4,
// détecté scanné (aucun texte extractible).
const fixture = path.join(root, 'fixtures', 'ccitt-1p.pdf');
check('fixture CCITT présent', fs.existsSync(fixture), true);
const raw = fs.readFileSync(fixture);
check('fixture : filtre CCITTFaxDecode', raw.includes(Buffer.from('/CCITTFaxDecode')), true);
check('fixture : /K -1 (Groupe 4)', raw.includes(Buffer.from('/K -1')), true);
const extracted = await extractPdfText(fixture);
check('fixture : 1 page', extracted.numPages, 1);
check('fixture : détecté scanné', isScanned(extracted.pages).scanned, true);

// 8. OCR du fixture CCITT (lent, sous POH_TEST_OCR=1 seulement) : le
// texte dessiné doit être reconnu — c'est la preuve que la chaîne
// complète (rendu + tesseract) lit une page CCITT.
if (process.env.POH_TEST_OCR === '1') {
  try {
    const pngBase = path.join(process.env.TMPDIR || '/tmp', 'ccitt-1p');
    execFileSync('pdftoppm', ['-r', '200', '-png', '-f', '1', '-l', '1', fixture, pngBase]);
    const png = fs.readFileSync(pngBase + '-1.png');
    const tess = resolveTessdataDir([path.join(base, 'assets', 'tesseract', 'tessdata')]);
    const worker = await getOcrWorker(tess);
    const { text } = await ocrPngBufferWithWords(worker, png);
    await terminateOcrWorker();
    check('OCR CCITT : trouve CESSNA 172N', text.includes('CESSNA 172N'), true);
    check('OCR CCITT : trouve FUEL CAPACITY', text.includes('FUEL CAPACITY'), true);
    check('OCR CCITT : plus de 50 caractères', text.length > 50, true);
    console.log('  (extrait OCR : ' + JSON.stringify(text.slice(0, 120)) + ')');
  } catch (e) {
    console.log(`ÉCHEC OCR CCITT — ${e.message}`);
    failures++;
  }
} else {
  skip('OCR CCITT', 'lancer avec POH_TEST_OCR=1 (lent)');
}

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
