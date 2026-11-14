// main-import.js — Import de POH + OCR, côté processus principal.
//
// CHARGÉ PAR main.js (patch d'intégration : 2 lignes — voir le rapport).
// Ne touche jamais aux 4 POH fournis : chaque PDF importé est COPIÉ dans
// app.getPath('userData')/pohs/<doc_id>/ avec son index.json et son
// meta.json (registre : un meta.json par document importé).
//
// Canaux IPC (exposés au rendu par preload.cjs, patch d'intégration) :
//   poh-import:list         -> [{ doc_id, title, ..., doc }]
//   poh-import:choose-file  -> { canceled, filePath }
//   poh-import:import-file  -> { ok, doc_id, title, totalPages, scanned,
//                                medianChars, sectionDetection, sections, source }
//   poh-import:ocr-page     -> { ok, pdfPage, chars }  (une page, annulable
//                                côté rendu : on s'arrête simplement d'appeler)
//   poh-import:ocr-finish   -> { ok, doc_id, title, totalPages, sections }
//   poh-import:ocr-cancel   -> { ok: true }
//   poh-import:delete       -> { ok: true }
//   poh-import:hidden-list  -> [{ id, title }] (documents fournis masqués)
//   poh-import:hide-doc     -> { ok: true } (masque un document fourni)
//   poh-import:unhide-doc   -> { ok: true } (restaure un document fourni)
// En cas d'erreur un handler retourne { ok: false, error } (jamais d'exception
// non attrapée : le rendu affiche le message).
import { app, dialog, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SCANNED_MEDIAN_CHARS,
  makeDocId, displayTitle, shortLabel,
  extractPdfText, detectSections, isScanned,
  buildIndex, buildDocEntry,
  resolveTessdataDir, getOcrWorker, terminateOcrWorker,
  ocrPngBuffer, systemTesseractAvailable, ocrPngBufferWithSystemTesseract,
} from './import-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function pohsDir() {
  return path.join(app.getPath('userData'), 'pohs');
}

function docDir(docId) {
  return path.join(pohsDir(), docId);
}

// doc_id valide : lettres/chiffres/tirets, sinon refus (anti-traversée de dossier).
function isSafeDocId(docId) {
  return typeof docId === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(docId);
}

function readMeta(docId) {
  const metaPath = path.join(docDir(docId), 'meta.json');
  return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

function writeMeta(docId, meta) {
  fs.writeFileSync(path.join(docDir(docId), 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

function listImported() {
  const base = pohsDir();
  if (!fs.existsSync(base)) return [];
  const out = [];
  for (const name of fs.readdirSync(base)) {
    if (!isSafeDocId(name)) continue;
    const metaPath = path.join(base, name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      out.push(refreshImportedDoc(name, meta));
    } catch (e) { console.warn(`[import] meta.json illisible pour ${name} : ${e.message}`); }
  }
  out.sort((a, b) => String(a.added_at || '').localeCompare(String(b.added_at || '')));
  return out;
}

// Réparation des imports déjà faits : la détection des sections a changé
// (les sommaires ne comptent plus comme début de section — le PA-44 de
// Julien démarrait ses 10 sections p. 25). À chaque lecture du registre,
// on recalcule les sections depuis le texte déjà stocké dans index.json
// (aucun OCR à refaire) et on réécrit index.json + meta.json quand ça
// diffère. Le titre perd aussi son « .pdf » éventuel (« PA44.PDF »).
// Ne casse jamais la liste : toute erreur rend la méta telle quelle.
function refreshImportedDoc(docId, meta) {
  try {
    const indexPath = path.join(docDir(docId), 'index.json');
    if (!fs.existsSync(indexPath)) return meta;
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!index || !Array.isArray(index.pages) || index.pages.length === 0) return meta;
    const { sections, pageSection } = detectSections(index.pages);
    const sameSections = JSON.stringify(meta.doc && meta.doc.sections) === JSON.stringify(sections);
    const samePages = index.pages.every((p) => (pageSection.get(p.pdf_page) || 'front') === p.section);
    const cleanTitle = String(meta.title || '').replace(/\.pdf$/i, '').trim();
    const sameTitle = cleanTitle === meta.title && meta.doc && cleanTitle === meta.doc.title;
    if (sameSections && samePages && sameTitle) return meta;
    for (const p of index.pages) p.section = pageSection.get(p.pdf_page) || 'front';
    fs.writeFileSync(indexPath, JSON.stringify(index), 'utf8');
    meta.title = cleanTitle;
    if (meta.doc) {
      meta.doc.title = cleanTitle;
      meta.doc.sections = sections;
    }
    writeMeta(docId, meta);
    return meta;
  } catch (e) {
    console.warn(`[import] sections non rafraîchies pour ${docId} : ${e.message}`);
    return meta;
  }
}

// ---------------------------------------------------------------------------
// Documents fournis masqués (l'utilisateur peut retirer un document de
// base — 172N, 172R, 150, SOP — comme un importé ; on ne supprime jamais
// les fichiers fournis, on les masque seulement, et on peut les restaurer).
// Stockage : userData/hidden-docs.json — simple tableau d'identifiants.
// ---------------------------------------------------------------------------
function hiddenDocsPath() {
  return path.join(app.getPath('userData'), 'hidden-docs.json');
}

function bundledDocs() {
  try {
    const docs = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'docs.json'), 'utf8'));
    return Array.isArray(docs.docs) ? docs.docs : [];
  } catch {
    return [];
  }
}

function readHiddenDocs() {
  try {
    const raw = JSON.parse(fs.readFileSync(hiddenDocsPath(), 'utf8'));
    if (!Array.isArray(raw)) return [];
    const known = new Set(bundledDocs().map((d) => d.id));
    return raw.filter((id) => typeof id === 'string' && known.has(id));
  } catch { return []; }
}

function writeHiddenDocs(ids) {
  fs.mkdirSync(path.dirname(hiddenDocsPath()), { recursive: true });
  fs.writeFileSync(hiddenDocsPath(), JSON.stringify([...new Set(ids)], null, 2), 'utf8');
}

function listHiddenDocs() {
  const hidden = new Set(readHiddenDocs());
  return bundledDocs().filter((d) => hidden.has(d.id)).map((d) => ({ id: d.id, title: d.title }));
}

function hideDoc({ docId }) {
  const known = new Set(bundledDocs().map((d) => d.id));
  if (!known.has(docId)) return { ok: false, error: 'Document fourni introuvable : ' + String(docId) };
  const ids = readHiddenDocs();
  if (!ids.includes(docId)) { ids.push(docId); writeHiddenDocs(ids); }
  return { ok: true, doc_id: docId };
}

function unhideDoc({ docId }) {
  const ids = readHiddenDocs().filter((id) => id !== docId);
  writeHiddenDocs(ids);
  return { ok: true, doc_id: docId };
}

// Dossiers candidats pour les données OCR (fra+eng). En dev : assets/.
// Empaqueté : extraResources (process.resourcesPath) ou assets/ dans asar.
function tessdataCandidates() {
  return [
    path.join(process.resourcesPath || '', 'assets', 'tesseract', 'tessdata'),
    path.join(process.resourcesPath || '', 'tesseract', 'tessdata'),
    path.join(__dirname, 'assets', 'tesseract', 'tessdata'),
    path.join(app.getPath('userData'), 'tesseract', 'tessdata'),
  ];
}

// Sessions OCR en cours : docId -> { totalPages, texts: Map(pdfPage -> text) }.
// Un seul worker tesseract.js à la fois (un seul OCR à la fois dans l'appli).
const ocrSessions = new Map();
let ocrWorkerFailed = false; // tesseract.js inutilisable -> secours binaire système

async function importFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: 'Fichier introuvable : ' + String(filePath || '') };
  }
  if (path.extname(filePath).toLowerCase() !== '.pdf') {
    return { ok: false, error: 'Le fichier choisi n’est pas un PDF.' };
  }
  let extracted;
  try {
    extracted = await extractPdfText(filePath);
  } catch (e) {
    return { ok: false, error: 'Impossible de lire ce PDF : ' + (e && e.message ? e.message : e) };
  }
  if (!extracted.numPages || extracted.numPages < 1) {
    return { ok: false, error: 'Ce PDF ne contient aucune page.' };
  }
  const existing = new Set(listImported().map((m) => m.doc_id));
  const docId = makeDocId(filePath, existing);
  const dir = docDir(docId);
  fs.mkdirSync(dir, { recursive: true });
  const pdfFile = path.basename(filePath);
  try {
    fs.copyFileSync(filePath, path.join(dir, pdfFile));
  } catch (e) {
    return { ok: false, error: 'Impossible de copier le PDF : ' + e.message };
  }
  const title = displayTitle(extracted.pdfTitle, filePath);
  const { scanned, medianChars } = isScanned(extracted.pages);
  const { kind, sections } = detectSections(extracted.pages);
  const index = buildIndex({
    docId, title, pdfPath: `user-pohs/${docId}/${pdfFile}`, pages: extracted.pages,
  });
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index), 'utf8');
  const sectionNote = kind === 'none'
    ? 'aucune section détectée (document entier)'
    : `${sections.length - 1} section${sections.length - 1 > 1 ? 's' : ''} détectée${sections.length - 1 > 1 ? 's' : ''}`;
  const meta = {
    doc_id: docId,
    title,
    short: shortLabel(filePath),
    added_at: new Date().toISOString(),
    source: 'import',
    original_filename: pdfFile,
    pdf_file: pdfFile,
    totalPages: extracted.numPages,
    scanned,
    medianCharsPerPage: medianChars,
    scannedThreshold: SCANNED_MEDIAN_CHARS,
    sectionDetection: kind,
    doc: buildDocEntry({
      docId, title,
      short: shortLabel(filePath),
      subtitle: `Importé le ${new Date().toLocaleDateString('fr-CA')} — ${sectionNote}`,
      pdfFile, sections, totalPages: extracted.numPages, ocr: false,
    }),
  };
  writeMeta(docId, meta);
  return {
    ok: true, doc_id: docId, title, totalPages: extracted.numPages,
    scanned, medianChars, sectionDetection: kind,
    sections: sections.map((s) => ({ key: s.key, label: s.label, startPage: s.startPage })),
    source: 'import',
  };
}

async function ocrPage({ docId, pdfPage, pngBase64 }) {
  if (!isSafeDocId(docId)) return { ok: false, error: 'Identifiant de document invalide.' };
  if (!pngBase64 || typeof pngBase64 !== 'string') return { ok: false, error: 'Image de page manquante.' };
  let meta;
  try { meta = readMeta(docId); }
  catch { return { ok: false, error: 'Document importé introuvable : ' + docId }; }
  const pageNum = Number(pdfPage);
  if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > meta.totalPages) {
    return { ok: false, error: 'Numéro de page invalide : ' + String(pdfPage) };
  }
  let session = ocrSessions.get(docId);
  if (!session) {
    session = { totalPages: meta.totalPages, texts: new Map() };
    ocrSessions.set(docId, session);
  }
  const pngBuffer = Buffer.from(pngBase64, 'base64');
  if (!pngBuffer.length) return { ok: false, error: 'Image de page vide.' };
  let text = null;
  let lastError = null;
  if (!ocrWorkerFailed) {
    try {
      const tessdataDir = resolveTessdataDir(tessdataCandidates());
      if (!tessdataDir) {
        throw new Error('Données OCR absentes (tessdata fra+eng introuvables).');
      }
      const worker = await getOcrWorker(tessdataDir);
      text = await ocrPngBuffer(worker, pngBuffer);
    } catch (e) {
      lastError = e;
      ocrWorkerFailed = true;
      try { await terminateOcrWorker(); } catch { /* déjà arrêté */ }
    }
  }
  if (text === null) {
    // Secours : binaire tesseract du système, s'il est installé.
    try {
      if (!(await systemTesseractAvailable())) {
        throw new Error(lastError ? lastError.message
          : 'OCR indisponible : tesseract.js a échoué et aucun binaire tesseract système n’est installé.');
      }
      text = await ocrPngBufferWithSystemTesseract(pngBuffer);
    } catch (e) {
      return { ok: false, error: 'OCR impossible : ' + e.message };
    }
  }
  session.texts.set(pageNum, text);
  return { ok: true, pdfPage: pageNum, chars: text.length, done: session.texts.size, total: session.totalPages };
}

async function ocrFinish({ docId }) {
  if (!isSafeDocId(docId)) return { ok: false, error: 'Identifiant de document invalide.' };
  const session = ocrSessions.get(docId);
  if (!session || session.texts.size === 0) {
    return { ok: false, error: 'Aucune page OCR à enregistrer (OCR annulé ou jamais lancé).' };
  }
  let meta;
  try { meta = readMeta(docId); }
  catch { return { ok: false, error: 'Document importé introuvable : ' + docId }; }
  if (session.texts.size < session.totalPages) {
    return {
      ok: false,
      error: `OCR incomplet : ${session.texts.size} page(s) sur ${session.totalPages}. Relancez l’OCR (il recommence au début).`,
    };
  }
  const pages = [];
  for (let p = 1; p <= session.totalPages; p++) {
    pages.push({ pdf_page: p, text: session.texts.get(p) || '' });
  }
  const { kind, sections } = detectSections(pages);
  const index = buildIndex({
    docId, title: meta.title, pdfPath: `user-pohs/${docId}/${meta.pdf_file}`, pages,
  });
  // Vérification avant écriture : l'index OCR doit contenir du texte.
  const { scanned, medianChars } = isScanned(pages);
  if (scanned) {
    return {
      ok: false,
      error: `L’OCR n’a presque rien reconnu (médiane ${medianChars} caractères/page). ` +
        'Le document est peut-être illisible (pages blanches, résolution trop faible). Index non écrasé.',
    };
  }
  fs.writeFileSync(path.join(docDir(docId), 'index.json'), JSON.stringify(index), 'utf8');
  const sectionNote = kind === 'none'
    ? 'aucune section détectée (document entier)'
    : `${sections.length - 1} section${sections.length - 1 > 1 ? 's' : ''} détectée${sections.length - 1 > 1 ? 's' : ''}`;
  meta.source = 'ocr';
  meta.ocr = true;
  meta.medianCharsPerPage = medianChars;
  meta.sectionDetection = kind;
  meta.doc = buildDocEntry({
    docId, title: meta.title, short: meta.short,
    subtitle: `Importé le ${new Date(meta.added_at).toLocaleDateString('fr-CA')} — OCR (fra+eng) — ${sectionNote}`,
    pdfFile: meta.pdf_file, sections, totalPages: meta.totalPages, ocr: true,
    ocrNote: 'Texte issu d’un OCR (fra+eng, intégré à l’appli) : la recherche sert à TROUVER la page. ' +
      'Les valeurs des tableaux se lisent dans le PDF affiché, jamais dans le texte reconnu.',
  });
  writeMeta(docId, meta);
  ocrSessions.delete(docId);
  try { await terminateOcrWorker(); } catch { /* déjà arrêté */ }
  return {
    ok: true, doc_id: docId, title: meta.title, totalPages: meta.totalPages,
    medianChars, sectionDetection: kind,
    sections: sections.map((s) => ({ key: s.key, label: s.label, startPage: s.startPage })),
    source: 'ocr',
  };
}

async function ocrCancel({ docId }) {
  if (docId && isSafeDocId(docId)) ocrSessions.delete(docId);
  try { await terminateOcrWorker(); } catch { /* déjà arrêté */ }
  ocrWorkerFailed = false; // un nouvel OCR retentera tesseract.js
  return { ok: true };
}

function deleteDoc({ docId }) {
  if (!isSafeDocId(docId)) return { ok: false, error: 'Identifiant de document invalide.' };
  const dir = docDir(docId);
  // Garde : on ne supprime que sous userData/pohs/<doc_id>, jamais ailleurs.
  const base = pohsDir();
  if (!dir.startsWith(base) || dir === base) return { ok: false, error: 'Refus de supprimer hors du dossier des POH importés.' };
  if (!fs.existsSync(dir)) return { ok: false, error: 'Document introuvable : ' + docId };
  ocrSessions.delete(docId);
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true, doc_id: docId };
}

export function registerImportHandlers() {
  ipcMain.handle('poh-import:list', () => listImported());
  ipcMain.handle('poh-import:choose-file', async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choisir un document (PDF)',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePaths.length) return { canceled: true };
    return { canceled: false, filePath: res.filePaths[0] };
  });
  ipcMain.handle('poh-import:import-file', (_e, args) => importFile(args && args.filePath));
  ipcMain.handle('poh-import:ocr-page', (_e, args) => ocrPage(args || {}));
  ipcMain.handle('poh-import:ocr-finish', (_e, args) => ocrFinish(args || {}));
  ipcMain.handle('poh-import:ocr-cancel', (_e, args) => ocrCancel(args || {}));
  ipcMain.handle('poh-import:delete', (_e, args) => deleteDoc(args || {}));
  ipcMain.handle('poh-import:hidden-list', () => listHiddenDocs());
  ipcMain.handle('poh-import:hide-doc', (_e, args) => hideDoc(args || {}));
  ipcMain.handle('poh-import:unhide-doc', (_e, args) => unhideDoc(args || {}));
}
