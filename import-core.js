// import-core.js — Logique d'import de POH, sans Electron.
//
// Ce module ne fait AUCUN appel Electron : il est testable en Node pur
// (node test/import.test.mjs). Le collage Electron (dialogue fichier,
// copie, registre, IPC) vit dans main-import.js ; l'interface vit dans
// renderer/import.js.
//
// Formats produits (identiques aux index fournis dans data/index/) :
//   { "doc_id", "title", "pdf_path",
//     "pages": [{ "pdf_page" (1-based), "printed_label", "section", "text" }] }
//
// Dépendances : pdfjs-dist (déjà dans l'appli) pour l'extraction du texte,
// tesseract.js (fra+eng, WASM, sans binaire natif) pour l'OCR.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Seuil « PDF scanné » : médiane < 20 caractères par page -> quasi aucun
// texte extractible, la recherche ne marchera pas sans OCR (spécification).
export const SCANNED_MEDIAN_CHARS = 20;

// ---------------------------------------------------------------------------
// Petits utilitaires
// ---------------------------------------------------------------------------
export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// « Mon POH 172.pdf » -> « mon-poh-172 » (base d'un doc_id).
export function slugifyFilename(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const slug = base
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'poh';
}

// doc_id unique : « imp-<slug>-<base36 horodatage> », suffixe -2, -3 si collision.
export function makeDocId(fileName, existingIds = new Set()) {
  const stamp = Date.now().toString(36);
  let id = `imp-${slugifyFilename(fileName)}-${stamp}`;
  let n = 2;
  while (existingIds.has(id)) { id = `imp-${slugifyFilename(fileName)}-${stamp}-${n}`; n++; }
  return id;
}

// Titre affiché : en MAJUSCULES comme les onglets des documents fournis
// (172N, 150, SOP). Titre PDF si présent, sinon nom du fichier sans extension.
export function displayTitle(pdfTitle, fileName) {
  const raw = (pdfTitle && String(pdfTitle).trim()) ||
    path.basename(fileName, path.extname(fileName));
  return raw.toUpperCase();
}

// Abréviation courte (recherche, sélecteur de portée) : lettres/chiffres du
// nom de fichier, en majuscules, 10 caractères max.
export function shortLabel(fileName) {
  const slug = slugifyFilename(fileName).replace(/-/g, '').toUpperCase();
  return (slug || 'POH').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Extraction du texte avec pdf.js (même bibliothèque que le lecteur)
// ---------------------------------------------------------------------------
// Reconstruit les lignes : les items pdf.js sont triés par ordonnée
// décroissante puis abscisse, regroupés par ligne (tolérance 3 unités PDF),
// joints par un espace quand l'écart horizontal le justifie.
export function buildPageText(textContent) {
  const items = (textContent.items || [])
    .filter((it) => it.str && it.str.trim() !== '')
    .map((it) => ({
      str: it.str,
      x: it.transform ? it.transform[4] : 0,
      y: it.transform ? it.transform[5] : 0,
      w: typeof it.width === 'number' ? it.width : 0,
    }));
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= 3);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  return lines.map((l) => {
    l.items.sort((a, b) => a.x - b.x);
    let out = '';
    for (let i = 0; i < l.items.length; i++) {
      const it = l.items[i];
      if (i > 0) {
        const prev = l.items[i - 1];
        const gap = it.x - (prev.x + prev.w);
        // Écart net entre deux fragments -> espace ; sinon ils se collent
        // (mot coupé par le PDF en deux fragments).
        out += gap > 1 ? ' ' : '';
      }
      out += it.str;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean).join('\n');
}

// Extrait le texte de toutes les pages. Retourne aussi le titre PDF
// (métadonnées) quand il existe.
export async function extractPdfText(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  let pdfTitle = null;
  try {
    const meta = await doc.getMetadata();
    if (meta && meta.info && meta.info.Title) pdfTitle = String(meta.info.Title);
  } catch { /* métadonnées absentes : pas bloquant */ }
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push({ pdf_page: p, text: buildPageText(tc) });
  }
  return { numPages: doc.numPages, pdfTitle, pages };
}

// ---------------------------------------------------------------------------
// Numéros de page imprimés (pied de page)
// ---------------------------------------------------------------------------
// Formats rencontrés dans les index fournis : « 1-1 », « 1-2 » (POH),
// « ii », « iii » (pages liminaires), « 1 », « 2 » (SOP).
// On ne regarde que les 3 dernières lignes non vides : un numéro isolé au
// milieu du texte n'est jamais un folio. Un libellé faux ne casserait que
// l'affichage (la recherche utilise pdf_page), jamais la recherche.
const ROMAN = /^[ivxlcdm]{1,5}$/i;
export function detectPrintedLabel(pageText) {
  if (!pageText) return null;
  const lines = pageText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(-3).reverse()) {
    const dash = line.match(/(\d{1,2}-\d{1,3})\s*$/);
    if (dash) return dash[1];
    const withWord = line.match(/^(?:p\.?|page)\s*(\d{1,3})\s*$/i);
    if (withWord) return withWord[1];
    // Le folio peut être coupé en fragments par le PDF (« i i » pour « ii »).
    const collapsed = line.replace(/\s+/g, '');
    if (ROMAN.test(collapsed)) return collapsed.toLowerCase();
    if (/^\d{1,3}$/.test(collapsed)) return collapsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Détection des sections
// ---------------------------------------------------------------------------
// - POH : lignes « SECTION N » (titre sur la ligne même ou la suivante).
//   La table des matières du C150N ne déclenche pas de faux positif : ses
//   lignes sont « SECTION » seul puis « GENERAL 1 », « LIMITATIONS 2 »...
//   sans « SECTION N » sur une même ligne.
// - SOP / chapitres : « CHAPITRE N » ou « CHAPTER N ».
// - Rien détecté : une seule section « document entier », dite clairement.
//
// ANCRAGE : le motif doit commencer la ligne (éventuel « CESSNA »
// d'en-tête courant admis). Sinon les renvois en milieu de phrase
// (« illustrated in Section 6 », « (Section 4) », « Section 2 includes… »)
// créent de fausses sections — vérifié sur le C150N réel.
// De plus, le reste de la ligne doit être vide ou commencer par une
// majuscule, un chiffre ou un tiret (titre) : « Section 2 includes… »
// (phrase, minuscule) est rejeté.
const SECTION_RE = /^\s*(?:CESSNA\s+)?SECTION\s+(\d{1,2})\b/i;
const CHAPTER_RE = /^\s*(?:CHAPITRE|CHAPTER)\s+(\d{1,2})\b/i;

function cleanTitle(raw) {
  if (!raw) return '';
  let t = raw
    .replace(/\b(?:SECTION|CHAPITRE|CHAPTER)\s+\d{1,2}\b/gi, '')
    .replace(/TABLE OF CONTENTS/gi, '')
    .replace(/[.·]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:;,. ]+|[-–—:;,. ]+$/g, '')
    .slice(0, 40)
    .trim();
  // Titre tout en capitales (« GENERAL », « LIMITATIONS ») -> casse de titre.
  if (t && t.length > 2 && t === t.toUpperCase()) {
    t = t.toLowerCase().replace(/(^|[\s-])([a-zà-ÿ])/g, (_, p, c) => p + c.toUpperCase());
  }
  return t;
}

function titleAfter(lines, idx, restOfLine) {
  const fromLine = cleanTitle(restOfLine);
  if (fromLine) return fromLine;
  // Titre sur la ligne suivante (« SECTION 1 » seul, puis « GENERAL »).
  for (let j = idx + 1; j < Math.min(lines.length, idx + 3); j++) {
    const next = lines[j].trim();
    if (!next) continue;
    if (/^TABLE OF CONTENTS$/i.test(next) || /^Page$/i.test(next)) continue;
    if (SECTION_RE.test(next) || CHAPTER_RE.test(next)) continue;
    const cleaned = cleanTitle(next);
    if (cleaned && cleaned.length <= 50) return cleaned;
    break;
  }
  return '';
}

export function detectSections(pages) {
  const found = new Map(); // numéro -> { startPage, title }
  let kind = null;
  for (const page of pages) {
    const lines = (page.text || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Une ligne de table des matières avec points de suite (« ... 1-1 »)
      // n'est jamais un titre de section.
      if (/\.{3,}/.test(line)) continue;
      const mSec = line.match(SECTION_RE);
      const mCh = mSec ? null : line.match(CHAPTER_RE);
      const m = mSec || mCh;
      if (!m) continue;
      const rest = line.slice(m.index + m[0].length).trim();
      // Phrase, pas titre (« Section 2 includes… », « Chapitre 3 décrit… »).
      if (rest && !/^[A-ZÀ-Ý0-9—–-]/.test(rest)) continue;
      const num = String(parseInt(m[1], 10));
      const thisKind = mSec ? 'sections' : 'chapters';
      if (kind && kind !== thisKind) continue; // un seul type par document
      if (!kind) kind = thisKind;
      if (found.has(num)) continue; // première occurrence = début (les
      // en-têtes courants répètent « SECTION N » sur chaque page).
      found.set(num, { startPage: page.pdf_page, title: titleAfter(lines, i, rest) });
    }
  }
  const sections = [{ key: 'front', label: 'Début du document', startPage: 1 }];
  if (!kind) {
    sections.push({ key: '1', label: 'Section unique — document entier', startPage: 1 });
    return { kind: 'none', sections, pageSection: new Map(pages.map((p) => [p.pdf_page, '1'])) };
  }
  const ordered = [...found.entries()]
    .map(([num, v]) => ({ num, ...v }))
    .sort((a, b) => a.startPage - b.startPage);
  for (const s of ordered) {
    const label = kind === 'sections'
      ? (s.title ? `Section ${s.num} — ${s.title}` : `Section ${s.num}`)
      : (s.title ? `Chapitre ${s.num} — ${s.title}` : `Chapitre ${s.num}`);
    sections.push({ key: s.num, label, startPage: s.startPage });
  }
  const pageSection = new Map();
  for (const p of pages) {
    let current = 'front';
    for (const s of sections) if (p.pdf_page >= s.startPage) current = s.key;
    pageSection.set(p.pdf_page, current);
  }
  return { kind, sections, pageSection };
}

// ---------------------------------------------------------------------------
// Index au format des index fournis + diagnostic « scanné »
// ---------------------------------------------------------------------------
export function isScanned(pages) {
  const chars = pages.map((p) => (p.text || '').length);
  const med = median(chars);
  return { scanned: med < SCANNED_MEDIAN_CHARS, medianChars: med, charsPerPage: chars };
}

export function buildIndex({ docId, title, pdfPath, pages }) {
  const { pageSection } = detectSections(pages);
  return {
    doc_id: docId,
    title,
    pdf_path: pdfPath,
    pages: pages.map((p) => ({
      pdf_page: p.pdf_page,
      printed_label: detectPrintedLabel(p.text),
      section: pageSection.get(p.pdf_page) || 'front',
      text: p.text || '',
    })),
  };
}

// Entrée au format data/docs.json, prête à être poussée dans docsMeta.docs
// par le chargeur (renderer/app.js, patch d'intégration). Les chemins sont
// relatifs au protocole app:// (user-pohs/ = userData/pohs, servi par le
// handler du protocole, voir main.js).
export function buildDocEntry({ docId, title, short, subtitle, pdfFile, sections, totalPages, ocr, ocrNote }) {
  const entry = {
    id: docId,
    title,
    short,
    subtitle,
    pdf: `user-pohs/${docId}/${pdfFile}`,
    index: `user-pohs/${docId}/index.json`,
    sections,
    totalPages,
    ocr: !!ocr,
  };
  if (ocrNote) entry.ocrNote = ocrNote;
  return entry;
}

// ---------------------------------------------------------------------------
// OCR — tesseract.js (WASM, fra+eng, 100 % local)
// ---------------------------------------------------------------------------
// Résout le dossier tessdata : premier candidat qui contient les deux
// fichiers *.traineddata.gz. Ordre : dossier de l'appli empaquetée
// (extraResources), dossier dev (assets/tesseract/tessdata), userData.
export function resolveTessdataDir(candidates) {
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, 'fra.traineddata.gz')) &&
          fs.existsSync(path.join(dir, 'eng.traineddata.gz'))) {
        return dir;
      }
    } catch { /* candidat illisible : suivant */ }
  }
  return null;
}

let ocrWorkerPromise = null;

export async function getOcrWorker(tessdataDir, onProgress) {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = (async () => {
    const mod = await import('tesseract.js');
    const createWorker = mod.createWorker || (mod.default && mod.default.createWorker);
    if (typeof createWorker !== 'function') {
      throw new Error('tesseract.js introuvable ou incomplet (createWorker absent).');
    }
    const worker = await createWorker('fra+eng', 1, {
      langPath: tessdataDir,
      // 'none' : aucune lecture/écriture de cache sur disque. Les données
      // sont lues depuis langPath (.gz décompressé en mémoire) : indispensable
      // une fois empaqueté (app.asar en lecture seule) et hors réseau.
      cacheMethod: 'none',
      logger: (m) => { if (onProgress && m && m.status) onProgress(m); },
    });
    return worker;
  })().catch((e) => { ocrWorkerPromise = null; throw e; });
  return ocrWorkerPromise;
}

export async function terminateOcrWorker() {
  if (!ocrWorkerPromise) return;
  const p = ocrWorkerPromise;
  ocrWorkerPromise = null;
  try { const w = await p; await w.terminate(); } catch { /* déjà arrêté */ }
}

// Reconnaît un PNG (Buffer). Le Buffer est accepté directement par
// tesseract.js en Node (vérifié : même texte qu'avec un chemin de fichier).
export async function ocrPngBuffer(worker, pngBuffer) {
  const { data } = await worker.recognize(pngBuffer);
  return (data && data.text ? data.text : '').replace(/\r/g, '').trim();
}

// Secours : binaire tesseract du système, s'il est installé (utile si le
// worker tesseract.js ne démarre pas, par ex. dans un paquet mal empaqueté).
// N'est utilisé QUE si tesseract.js échoue : l'appli ne dépend pas de lui.
export function systemTesseractAvailable() {
  return new Promise((resolve) => {
    execFile('tesseract', ['--version'], (err) => resolve(!err));
  });
}

export function ocrPngBufferWithSystemTesseract(pngBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'tesseract', ['stdin', 'stdout', '--oem', '1', '-l', 'fra+eng'],
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(new Error('tesseract système : ' + err.message));
        else resolve(String(stdout || '').replace(/\r/g, '').trim());
      },
    );
    child.stdin.on('error', () => {});
    child.stdin.end(pngBuffer);
  });
}
