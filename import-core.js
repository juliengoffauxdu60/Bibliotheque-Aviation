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
// L'extension « .pdf » est retirée du titre : elle vient souvent du titre
// intégré du PDF (« PA44.PDF ») et n'apporte rien à l'affichage.
export function displayTitle(pdfTitle, fileName) {
  const raw = (pdfTitle && String(pdfTitle).trim()) ||
    path.basename(fileName, path.extname(fileName));
  return raw.replace(/\.pdf$/i, '').trim().toUpperCase();
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
// Sections numérotées « N.0 Titre » (AIM de Transports Canada, RAC…) :
// ces documents n'ont ni « SECTION N » ni « CHAPITRE N » — leurs
// grandes divisions sont « 1.0 General Information », « 2.0 Safety »…
// Seul le niveau « N.0 » compte (les « 1.1 », « 1.1.1 » sont des
// sous-sections). Garde-fous : le titre doit être court (≤ 8 mots,
// sinon c'est une phrase du corps de texte) et ne pas commencer par
// une unité (« 4.0 NM and are capped… » est une mesure, pas un titre).
const NUMBERED_RE = /^\s*(\d{1,2})\.0\s+(.*)$/;
const UNIT_FIRST_RE = /^(NM|FT|KT|LB|KG|KM|MI|YD|GAL|AGL|AAE|MSL|RPM|PSI|HPA|MB|°C|°F|%|M|L|CM|MM|IN)\b/i;

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
    if (SECTION_RE.test(next) || CHAPTER_RE.test(next) || NUMBERED_RE.test(next)) continue;
    const cleaned = cleanTitle(next);
    if (cleaned && cleaned.length <= 50) return cleaned;
    break;
  }
  return '';
}

// Une page de table des matières n'est JAMAIS le début d'une section :
// le PA-44 (importé par Julien, 14 nov.) liste « SECTION 1 GENERAL …
// SECTION 10 SAFETY TIPS » sur sa page de sommaire (p. 25) puis un
// sommaire par section (p. 27, 41, 53…) — sans points de suite, donc
// le garde-fou « ... » ne les écartait pas, et les 10 sections
// démarraient toutes p. 25. On écarte les pages dont le titre est une
// table des matières (dans les 3 premières lignes non vides — un vrai
// début de section peut mentionner « TABLE OF CONTENTS » plus bas,
// cf. le test C150N p. 7). Repli : si une section n'apparaît QUE sur
// des pages de sommaire, on garde sa première occurrence (mieux que rien).
const TOC_TITLE_RE = /TABLE OF CONTENTS|TABLE DES MATIÈRES/i;

function isTocPage(page) {
  const firstLines = (page.text || '').split('\n').filter((l) => l.trim()).slice(0, 3);
  return firstLines.some((l) => TOC_TITLE_RE.test(l));
}

export function detectSections(pages) {
  const tocPages = new Set(pages.filter(isTocPage).map((p) => p.pdf_page));
  const cands = new Map(); // numéro -> [{ startPage, title }] (ordre des pages)
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
      if (!cands.has(num)) cands.set(num, []);
      cands.get(num).push({ startPage: page.pdf_page, title: titleAfter(lines, i, rest) });
    }
  }
  // Deuxième passe : sections numérotées « N.0 Titre » (AIM, RAC…).
  // On ne la tente QUE si aucun « SECTION N » / « CHAPITRE N » n'a été
  // trouvé : un POH ne doit jamais basculer sur ce motif par accident.
  if (!kind) {
    for (const page of pages) {
      const lines = (page.text || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        // Points de suite : le suffixe « … page » (sommaire, index :
        // « 4.0 Index of Keywords – National Variations … MET 7.3 »)
        // est retiré AVANT de tester la ligne, sinon le garde-fou
        // « ... » tuait le titre.
        const line = lines[i].replace(/\.{2,}.*$/, '');
        let mNum = line.match(NUMBERED_RE);
        let midLine = false;
        if (!mNum) {
          // Titre fusionné EN MILIEU DE LIGNE (extraction deux
          // colonnes : « …conditions of issue. 3.0 Transportation
          // Safety Board »). ≥ 20 caractères avant = fusion de
          // colonnes, pas un renvoi court (« see 5.0 … »). Premier
          // « N.0 » de la ligne seulement : un tableau (« 1.3 1.9
          // 3.0 4.0 5.0 ») ne doit pas en créer un second.
          const mMid = line.match(/\b(\d{1,2})\.0\s+(.+)$/);
          if (mMid && mMid.index >= 20) { mNum = mMid; midLine = true; }
        }
        if (!mNum) continue;
        const rest = (mNum[2] || '').trim();
        // Phrase, pas titre (« 4.0 NM and are capped… » est une mesure).
        if (rest && !/^[A-ZÀ-Ý—–-]/.test(rest)) continue;
        // En milieu de ligne, le titre fusionné commence par une
        // majuscule : un renvoi laisse une ponctuation avant le titre
        // (« RAC 7.0, Instrument », « COM 6.0. ») — et le « \s+ » du
        // motif écarte déjà les « N.0, » / « N.0. ».
        if (midLine && rest && !/^[A-ZÀ-Ý]/.test(rest)) continue;
        if (rest && UNIT_FIRST_RE.test(rest)) continue;
        // Le titre peut être sur la ligne suivante (« 3.0 » seul, puis
        // « Transportation Safety Board of Canada (TSB) »).
        const title = titleAfter(lines, i, rest);
        if (!title || UNIT_FIRST_RE.test(title)) continue;
        if (title.split(/\s+/).length > 8) continue;
        const num = `${parseInt(mNum[1], 10)}.0`;
        if (!kind) kind = 'numbered';
        if (!cands.has(num)) cands.set(num, []);
        // Ligne de sommaire ou d'index ? Les points de suite suivis
        // d'un NUMÉRO DE PAGE (« 4.0 Index of Keywords … 14 ») disent
        // « sommaire » ; des points suivis d'un renvoi (« … MET 7.3 »,
        // p. 18 du GEN : la page EST le début de la section 4.0) ne
        // le disent pas. Sans ce drapeau, les pages de suite du
        // sommaire (RAC p. 4-10, sans « TABLE OF CONTENTS » en tête)
        // passaient pour le vrai début des sections.
        const tocLike = /\.{2,}\s*\d{1,3}\s*$/.test(lines[i]);
        cands.get(num).push({ startPage: page.pdf_page, title, tocLike });
      }
    }
  }
  const sections = [{ key: 'front', label: 'Début du document', startPage: 1 }];
  if (!kind) {
    sections.push({ key: '1', label: 'Section unique — document entier', startPage: 1 });
    return { kind: 'none', sections, pageSection: new Map(pages.map((p) => [p.pdf_page, '1'])) };
  }
  const ordered = [...cands.entries()]
    .map(([num, list]) => {
      // Titre : le premier non vide rencontré (souvent celui du sommaire,
      // propre : « GENERAL », « LIMITATIONS »). Début : la première
      // occurrence HORS sommaire (le vrai début de la section) — une
      // ligne de sommaire (page de sommaire, ou points de suite suivis
      // d'un numéro de page) ne compte jamais comme début.
      const title = (list.find((c) => c.title) || { title: '' }).title;
      const real = list.find((c) => !tocPages.has(c.startPage) && !c.tocLike);
      return { num, title, startPage: real ? real.startPage : list[0].startPage };
    })
    .sort((a, b) => a.startPage - b.startPage);
  for (const s of ordered) {
    const label = kind === 'sections'
      ? (s.title ? `Section ${s.num} — ${s.title}` : `Section ${s.num}`)
      : kind === 'numbered'
        ? (s.title ? `${s.num} — ${s.title}` : s.num)
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
// Détection des sections en couches (v1.1.3)
// ---------------------------------------------------------------------------
// Précédence : (1) signets PDF (outline) — référence de page exacte,
// fournie par l'auteur ; (2) sommaire imprimé — titres + numéros de page
// en fin de ligne, convertis imprimé→PDF par les étiquettes de page
// (getPageLabels) ou par la méthode des ancres (décalage validé par la
// médiane sur ≥2 ancres en majorité d'accord) ; (3) titres dans les pages
// — detectSections(), inchangé, qui reste aussi la référence pour
// refreshImportedDoc.
// Chaque entrée porte `source` (outline | toc | heading) et `confidence`
// (1 pour « Début du document », 0.95 signets, 0.9 sommaire par
// étiquettes, 0.8 sommaire par ancres, 0.75 titres).
// ---------------------------------------------------------------------------

// Ajoute `source` + `confidence` aux sections de detectSections().
export function tagSectionsSource(sections, source, confidence) {
  return sections.map((s) => ({ ...s, source, confidence: s.key === 'front' ? 1 : confidence }));
}

// Assemblage commun aux couches outline / toc : dédoublonne (même clé ou
// même page de début — on garde la première), trie par page, exige ≥2
// sections, ajoute « Début du document » et construit pageSection.
// `confidence` est la valeur par défaut ; une entrée peut porter la
// sienne (sommaire : 0.9 par étiquettes, 0.8 par ancres).
function finishLayeredSections(found, pages, source, confidence) {
  const seenKeys = new Set();
  const seenPages = new Set();
  const uniq = [];
  for (const s of found) {
    if (!s || seenKeys.has(s.key) || seenPages.has(s.startPage)) continue;
    seenKeys.add(s.key);
    seenPages.add(s.startPage);
    uniq.push(s);
  }
  uniq.sort((a, b) => a.startPage - b.startPage);
  if (uniq.length < 2) return null;
  const sections = [
    { key: 'front', label: 'Début du document', startPage: 1, source, confidence: 1 },
    ...uniq.map((s) => ({ ...s, source, confidence: s.confidence ?? confidence })),
  ];
  const pageSection = new Map();
  for (const p of pages) {
    let current = 'front';
    for (const s of sections) if (p.pdf_page >= s.startPage) current = s.key;
    pageSection.set(p.pdf_page, current);
  }
  return { sections, pageSection };
}

// --- Couche 1 : signets PDF -------------------------------------------------

const OUTLINE_NUMBERED_RE = /^(\d{1,2})\.0\b\s*(.*)$/;
const OUTLINE_SECTION_RE = /^SECTION\s+(\d{1,2})\b\s*(.*)$/i;
const OUTLINE_CHAPTER_RE = /^(?:CHAPTER|CHAPITRE)\s+(\d{1,2})\b\s*(.*)$/i;

function cleanOutlineTitle(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

// « 1.0 General Information » -> { key: '1.0', label: '1.0 — General…' }.
// Un titre qui ne ressemble pas à une section de premier niveau -> null.
function outlineEntryToSection(title, startPage) {
  let m = title.match(OUTLINE_NUMBERED_RE);
  if (m) {
    const num = `${parseInt(m[1], 10)}.0`;
    const t = cleanTitle(m[2] || '');
    return { key: num, label: t ? `${num} — ${t}` : num, startPage };
  }
  m = title.match(OUTLINE_SECTION_RE);
  if (m) {
    const num = String(parseInt(m[1], 10));
    const t = cleanTitle(m[2] || '');
    return { key: num, label: t ? `Section ${num} — ${t}` : `Section ${num}`, startPage };
  }
  m = title.match(OUTLINE_CHAPTER_RE);
  if (m) {
    const num = String(parseInt(m[1], 10));
    const t = cleanTitle(m[2] || '');
    return { key: num, label: t ? `Chapitre ${num} — ${t}` : `Chapitre ${num}`, startPage };
  }
  return null;
}

// Signets PDF : `doc` est un PDFDocumentProxy pdf.js déjà ouvert, `pages`
// la liste { pdf_page, text } (pour pageSection). Retourne
// { sections, pageSection } ou null (pas de signets utilisables).
// Règles : on ne garde que les nœuds qui ressemblent à une section de
// premier niveau, à toute profondeur — l'AIM range ses « 1.0 … 7.0 »
// sous « GEN—General », et « Title Page » / « Table of Contents » ne
// sont pas des sections. Repli : signets plats (tous au premier niveau,
// sans numérotation reconnaissable) et ≥2 -> on les prend tels quels.
// La destination est résolue comme le veut l'API : dest string ->
// getDestination() puis getPageIndex() (0-based, +1) ; dest array ->
// dest[0] est la réf de page. Un signet sans page résolvable est ignoré.
export async function detectOutlineSections(doc, pages) {
  let outline = null;
  try { outline = await doc.getOutline(); } catch { return null; }
  if (!outline || !outline.length) return null;
  const flat = [];
  async function resolvePage(node) {
    try {
      const dest = node.dest;
      if (typeof dest === 'string') {
        const d = await doc.getDestination(dest);
        if (d && d[0]) return (await doc.getPageIndex(d[0])) + 1;
      } else if (Array.isArray(dest) && dest[0]) {
        return (await doc.getPageIndex(dest[0])) + 1;
      }
    } catch { /* signet sans page résolvable : ignoré */ }
    return null;
  }
  async function walk(nodes, depth) {
    for (const node of nodes || []) {
      if (!node) continue;
      const title = cleanOutlineTitle(node.title);
      const page = title ? await resolvePage(node) : null;
      if (title && page && page >= 1 && page <= doc.numPages) {
        flat.push({ title, startPage: page, depth });
      }
      if (node.items && node.items.length) await walk(node.items, depth + 1);
    }
  }
  await walk(outline, 0);
  if (!flat.length) return null;
  let found = [];
  for (const e of flat) {
    const s = outlineEntryToSection(e.title, e.startPage);
    if (s) found.push(s);
  }
  if (found.length < 2) {
    const topLevel = flat.filter((e) => e.depth === 0);
    if (topLevel.length < 2 || topLevel.length !== flat.length) return null;
    found = topLevel.map((e, i) => ({
      key: `o${i + 1}`,
      label: cleanTitle(e.title) || e.title,
      startPage: e.startPage,
    }));
  }
  return finishLayeredSections(found, pages, 'outline', 0.95);
}

// --- Couche 2 : sommaire imprimé --------------------------------------------

// On ne scanne que le début du document : un sommaire est toujours devant.
export const TOC_SCAN_PAGES = 20;

const TOC_HEADING_RE = /TABLE OF CONTENTS|TABLE DES MATIÈRES/i;
// Ligne d'entrée : titre, points de suite, numéro de page en fin de ligne.
const TOC_DOT_ENTRY_RE = /^(.*?)[·.]{2,}\s*(\S+)\s*$/;
// Sans points de suite : titre + numéro isolé en fin de ligne (C150N :
// « GENERAL 1 » ; POH : « SECTION 1 GENERAL 1-1 »).
const TOC_PLAIN_ENTRY_RE = /^(.*?)\s+(\d{1,3}(?:-\d{1,3})?|[ivxlcdm]{1,5})\s*$/i;
// Entrée de premier niveau : « N.0 », « SECTION N », « CHAPTER N »…
const TOC_TOP_RE = /^(?:\d{1,2}\.0|SECTION\s+\d{1,2}|CHAPTER\s+\d{1,2}|CHAPITRE\s+\d{1,2}|PART\s+\d{1,2})\b/i;

function tocPageLines(page) {
  return (page.text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

// Page de sommaire : titre « TABLE OF CONTENTS » dans les 3 premières
// lignes (comme isTocPage), ou page presque entièrement composée
// d'entrées à points de suite (≥3 lignes, ≥50 % — les pages de corps
// avec tableaux ou mini-sommaires de chapitre restent sous 1/3, vérifié
// sur GEN/RAC : sommaires 0.85-0.97, corps ≤0.32).
function isTocPageForLayer(page) {
  const lines = tocPageLines(page);
  if (!lines.length) return false;
  if (lines.slice(0, 3).some((l) => TOC_HEADING_RE.test(l))) return true;
  const dots = lines.filter((l) => TOC_DOT_ENTRY_RE.test(l)).length;
  return dots >= 3 && dots / lines.length >= 0.5;
}

// Extrait les entrées du sommaire : [{ title, printedRef, tocPage }].
// Un numéro de page ne contient jamais de point (« 5.0 » est un renvoi
// de section, pas une page — exclu). Les titres coupés sur deux lignes
// ne sont pas recollés (trop risqué : « SECTION » seul en tête de
// colonne du sommaire C150N) : la ligne sans numéro est ignorée.
export function parseTocEntries(pages) {
  const scanned = pages.slice(0, TOC_SCAN_PAGES);
  const tocPages = scanned.filter(isTocPageForLayer).map((p) => p.pdf_page);
  const entries = [];
  for (const page of scanned) {
    if (!tocPages.includes(page.pdf_page)) continue;
    for (const line of tocPageLines(page)) {
      if (line.length < 3) continue;
      if (/^pages?\s*$/i.test(line)) continue;
      if (TOC_HEADING_RE.test(line) && line.length < 40) continue;
      let title = null;
      let ref = null;
      const mDot = line.match(TOC_DOT_ENTRY_RE);
      if (mDot) { title = mDot[1].trim(); ref = mDot[2]; }
      else {
        const mPlain = line.match(TOC_PLAIN_ENTRY_RE);
        if (mPlain) { title = mPlain[1].trim(); ref = mPlain[2]; }
      }
      if (!title || !ref || ref.includes('.')) continue;
      // Titre brut gardé pour la reconnaissance du motif (« SECTION 1
      // GENERAL » : cleanTitle enlève « SECTION 1 », le motif ne le
      // verrait plus) ; titre nettoyé pour l'affichage et les ancres.
      const rawTitle = title;
      title = cleanTitle(title);
      if (!title) continue;
      entries.push({ title, rawTitle, printedRef: ref, tocPage: page.pdf_page });
    }
  }
  return { entries, tocPages };
}

// Sommaire imprimé : `pageLabels` est le tableau de getPageLabels()
// (ou null). Retourne { sections, pageSection } ou null.
// Conversion imprimé→PDF : (1) étiquette de page exacte si présente ;
// (2) sinon décalage imprimé→PDF par la méthode des ancres — on
// retrouve un titre du sommaire dans le corps (d'abord en début de
// ligne, sinon n'importe où dans la page : titre fusionné, deux
// colonnes), décalage = page PDF − page imprimée, validé par la
// médiane sur ≥2 ancres en majorité d'accord à ±1. Si les ancres se
// contredisent
// (sommaire dont les numéros ne sont pas des pages, ex. C150N
// « GENERAL 1 »), le sommaire n'est pas fiable -> null, repli titres.
// Une entrée sans page résolvable est écartée ; il faut ≥2 sections.
export function detectTocSections(pages, pageLabels = null) {
  const { entries, tocPages } = parseTocEntries(pages);
  if (entries.length < 2 || !tocPages.length) return null;
  // Ne garder que les entrées de premier niveau ; sinon, celles qui ne
  // sont pas des sous-sections numérotées (« 1.1 … ») — un sommaire
  // détaillé liste aussi les sous-sections, qui ne sont pas des sections.
  // Le motif est testé sur le titre brut (voir parseTocEntries).
  let top = entries.filter((e) => TOC_TOP_RE.test(e.rawTitle || e.title));
  if (!top.length) top = entries.filter((e) => !/^\d+\.\d+/.test(e.title));
  if (top.length < 2) return null;
  const numPages = Math.max(...pages.map((p) => p.pdf_page), 0);
  const lastTocPage = Math.max(...tocPages);
  const bodyPages = pages.filter((p) => p.pdf_page > lastTocPage);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const bodyNorm = bodyPages.map((p) => ({
    pdf_page: p.pdf_page,
    text: norm(p.text),
    lines: (p.text || '').split('\n').map(norm),
  }));
  function findAnchor(entry) {
    const key = norm(entry.title).split(' ').slice(0, 3).join(' ');
    if (!key || key.length < 3) return null;
    for (const p of bodyNorm) {
      if (p.lines.some((l) => l.startsWith(key))) return p.pdf_page;
    }
    for (const p of bodyNorm) {
      if (p.text.includes(key)) return p.pdf_page;
    }
    return null;
  }
  function labelPage(ref) {
    if (!pageLabels) return null;
    const idx = pageLabels.findIndex(
      (l) => String(l).trim().toLowerCase() === String(ref).trim().toLowerCase());
    return idx >= 0 ? idx + 1 : null;
  }
  const offsets = [];
  const resolved = top.map((e) => {
    const anchor = findAnchor(e);
    const printedInt = /^\d+$/.test(e.printedRef) ? parseInt(e.printedRef, 10) : null;
    if (printedInt !== null && anchor !== null) offsets.push(anchor - printedInt);
    return { ...e, anchor, printedInt, fromLabel: labelPage(e.printedRef) };
  });
  let medianOffset = null;
  if (offsets.length >= 2) {
    const sorted = [...offsets].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const agreeing = offsets.filter((o) => Math.abs(o - med) <= 1).length;
    // Décalage confirmé par ≥2 ancres en majorité d'accord ; sinon les
    // numéros du sommaire ne sont pas des pages (ex. C150N).
    if (agreeing >= 2 && agreeing > offsets.length / 2) medianOffset = med;
  }
  const found = [];
  for (const e of resolved) {
    let startPage = null;
    let confidence = null;
    if (e.fromLabel !== null && e.fromLabel >= 1 && e.fromLabel <= numPages) {
      startPage = e.fromLabel; confidence = 0.9;
    } else if (e.printedInt !== null && medianOffset !== null) {
      const p = e.printedInt + medianOffset;
      if (p >= 1 && p <= numPages) { startPage = p; confidence = 0.8; }
    }
    if (startPage === null) continue;
    const s = outlineEntryToSection(e.rawTitle || e.title, startPage)
      || tocPlainEntryToSection(e.title, startPage);
    if (s) found.push({ ...s, confidence });
  }
  return finishLayeredSections(found, pages, 'toc', 0.8);
}

// Entrée de sommaire sans numérotation (« GENERAL ») : clé dérivée du
// titre, libellé tel quel.
function tocPlainEntryToSection(title, startPage) {
  const slug = title.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  if (!slug) return null;
  return { key: slug, label: title, startPage };
}

// --- Détection en couches ---------------------------------------------------
// Ouvre le PDF avec pdfjs-dist et tente les couches dans l'ordre :
// signets, sommaire imprimé, titres (detectSections, inchangé).
// Ne lève jamais d'exception : tout échec replie sur la couche titres.
export async function detectSectionsLayered(pdfPath, pages) {
  const headingFallback = () => {
    const det = detectSections(pages);
    return {
      source: 'heading', kind: det.kind,
      sections: tagSectionsSource(det.sections, 'heading', 0.75),
      pageSection: det.pageSection,
    };
  };
  if (!pdfPath || !Array.isArray(pages) || !pages.length) return headingFallback();
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    // pdfjs-dist 6.5.438 (version de l'appli) n'expose pas doc.destroy()
    // sur PDFDocumentProxy : on laisse le document au ramasse-miettes.
    const outline = await detectOutlineSections(doc, pages);
    if (outline) {
      return { source: 'outline', kind: 'outline', sections: outline.sections, pageSection: outline.pageSection };
    }
    let pageLabels = null;
    try { pageLabels = await doc.getPageLabels(); } catch { /* pas d'étiquettes */ }
    const toc = detectTocSections(pages, pageLabels);
    if (toc) {
      return { source: 'toc', kind: 'toc', sections: toc.sections, pageSection: toc.pageSection };
    }
  } catch { /* PDF illisible ici : repli titres */ }
  return headingFallback();
}

// ---------------------------------------------------------------------------
// Index au format des index fournis + diagnostic « scanné »
// ---------------------------------------------------------------------------
export function isScanned(pages) {
  const chars = pages.map((p) => (p.text || '').length);
  const med = median(chars);
  return { scanned: med < SCANNED_MEDIAN_CHARS, medianChars: med, charsPerPage: chars };
}

export function buildIndex({ docId, title, pdfPath, pages, pageSection, sectionSource, ocrWords }) {
  // pageSection fourni (détection en couches) : on l'utilise tel quel,
  // sinon la passe titres. sectionSource, si fourni, est stocké dans
  // l'index pour que refreshImportedDoc sache d'où viennent les sections.
  // ocrWords (optionnel, Map ou objet pdf_page -> { imageWidth,
  // imageHeight, words }) : boîtes de mots OCR de la page, stockées
  // telles quelles dans l'entrée de page (champ « ocr_words ») pour que
  // le lecteur puisse surligner les occurrences. Absent = page sans
  // boîtes (PDF à vrai texte, ou OCR d'avant les boîtes).
  const ps = pageSection || detectSections(pages).pageSection;
  const index = {
    doc_id: docId,
    title,
    pdf_path: pdfPath,
    pages: pages.map((p) => {
      const entry = {
        pdf_page: p.pdf_page,
        printed_label: detectPrintedLabel(p.text),
        section: ps.get(p.pdf_page) || 'front',
        text: p.text || '',
      };
      const ow = ocrWords
        ? (ocrWords instanceof Map ? ocrWords.get(p.pdf_page) : ocrWords[p.pdf_page])
        : null;
      if (ow) {
        entry.ocr_words = {
          imageWidth: ow.imageWidth ?? null,
          imageHeight: ow.imageHeight ?? null,
          words: Array.isArray(ow.words) ? ow.words : [],
        };
      }
      return entry;
    }),
  };
  if (sectionSource) index.section_source = sectionSource;
  return index;
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

// ---------------------------------------------------------------------------
// Boîtes de mots OCR (v1.1.3 — surlignage des résultats dans le lecteur)
// ---------------------------------------------------------------------------
// tesseract.js ne donne les boîtes que si on les demande : troisième
// argument de recognize(), { blocks: true } (défaut : texte seul).
// Les boîtes sont en PIXELS d'image, origine en haut à gauche (comme le
// PNG envoyé) ; les dimensions de l'image ne sont pas fournies par
// tesseract — c'est le rendu qui les envoie avec la page (canvas).
// Un mot retenu : { text, confidence (0-100), bbox: { x0, y0, x1, y1 } }.
// Tout le reste (mots vides, boîtes invalides, confiance absente) est
// écarté ici, jamais dans le lecteur : l'index ne contient que du propre.

// Nettoie une liste de mots bruts (tesseract ou autre source) : ne garde
// que les mots avec un texte non vide et une boîte valide, confiance
// bornée à 0-100. Entrée non-tableau (dont undefined, cas du repli
// binaire système qui ne donne pas de boîtes) -> [].
export function normalizeOcrWords(words) {
  if (!Array.isArray(words)) return [];
  const out = [];
  for (const w of words) {
    if (!w || typeof w.text !== 'string' || !w.text.trim()) continue;
    const b = w.bbox || {};
    const x0 = Number(b.x0), y0 = Number(b.y0), x1 = Number(b.x1), y1 = Number(b.y1);
    if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) continue;
    let conf = Number(w.confidence);
    if (!Number.isFinite(conf)) conf = 0;
    out.push({
      text: w.text,
      confidence: Math.max(0, Math.min(100, Math.round(conf))),
      bbox: { x0: Math.round(x0), y0: Math.round(y0), x1: Math.round(x1), y1: Math.round(y1) },
    });
  }
  return out;
}

// Aplatit data.blocks -> paragraphs -> lines -> words (structure
// tesseract.js : chaque mot porte text, confidence, bbox). Tolère les
// niveaux absents (blocks null, paragraphes/lignes manquants).
export function flattenOcrWords(data) {
  const words = [];
  const blocks = (data && data.blocks) || [];
  for (const b of blocks) {
    for (const para of (b.paragraphs || [])) {
      for (const line of (para.lines || [])) {
        for (const w of (line.words || [])) words.push(w);
      }
    }
  }
  return normalizeOcrWords(words);
}

// Comme ocrPngBuffer, mais retourne aussi les boîtes de mots :
// { text, words: [{ text, confidence, bbox }] }. ocrPngBuffer est
// inchangé (utilisé par les tests et par l'ancien chemin).
export async function ocrPngBufferWithWords(worker, pngBuffer) {
  const { data } = await worker.recognize(pngBuffer, {}, { text: true, blocks: true });
  const text = (data && data.text ? data.text : '').replace(/\r/g, '').trim();
  return { text, words: flattenOcrWords(data) };
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
