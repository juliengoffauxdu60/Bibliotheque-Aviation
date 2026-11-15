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
  // Pages de sommaire par le CONTENU (suite du sommaire sans titre en
  // tête : l'AIM liste ses chapitres sur les p. 5-29, « TABLE DES
  // MATIÈRES » n'apparaît qu'en tête de la première page). Le critère
  // est celui de la couche sommaire (≥3 lignes à points de suite, ≥50 %
  // des lignes — les pages de corps restent ≤0,45, vérifié sur l'AIM
  // réel : sommaires 0,85-0,97, pages de contenu ≤0,45).
  const tocContentPages = new Set(pages.filter(isTocPageForLayer).map((p) => p.pdf_page));
  // Bloc de sommaire en TÊTE de document : la première série contiguë
  // de pages de sommaire (par le contenu), à condition qu'elle commence
  // dans les 30 premières pages. Une mention « N.0 » sur ces pages est
  // une entrée de sommaire, jamais un départ de section — même quand la
  // ligne est propre en début de ligne (AIM p. 14 : « 9.0 Systèmes
  // d'avertissement… » sans points de suite sur la ligne, l'extraction
  // ayant séparé les points de suite sur une autre ligne). Vérifié sur
  // l'AIM réel : p. 7-34 contiguës, chute en p. 35 (premier contenu) ;
  // GEN : p. 3-4. Un index en milieu de document (AIM p. 50-65) n'est
  // PAS dans le bloc de tête : un vrai départ de section sur une page
  // d'index (GEN 4.0 p. 18 du sommaire imprimé) n'est pas exclu.
  const frontTocPages = new Set();
  {
    const first = pages.find((p) => p.pdf_page <= 30 && tocContentPages.has(p.pdf_page));
    if (first) {
      let started = false;
      for (const p of pages) {
        if (p.pdf_page < first.pdf_page) continue;
        if (tocContentPages.has(p.pdf_page)) { frontTocPages.add(p.pdf_page); started = true; }
        else if (started) break;
      }
    }
  }
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
      cands.get(num).push({ startPage: page.pdf_page, title: titleAfter(lines, i, rest), midLine: false, hasDots: /\.{2,}/.test(line) });
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
        cands.get(num).push({ startPage: page.pdf_page, title, tocLike, midLine, hasDots: /\.{2,}/.test(lines[i]) });
      }
    }
  }
  const sections = [{ key: 'front', label: 'Début du document', startPage: 1, level: 0 }];
  if (!kind) {
    sections.push({ key: '1', label: 'Section unique — document entier', startPage: 1, level: 2 });
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
      // Vrai début : hors page de sommaire. Sur une page de sommaire
      // (par le contenu), seule une ligne de titre PROPRE en début de
      // ligne compte — une mention en milieu de ligne (« ... 126 |
      // 9.0 ... », fusion de colonnes) ou une ligne à points de suite
      // n'est jamais un début de section. En revanche une page de
      // sommaire peut ÊTRE le contenu d'une section (GEN p. 18 : la
      // page EST la section 4.0 « Index des mots clés ») : sa ligne de
      // titre propre en début de ligne reste valable — sauf si la page
      // est dans le bloc de sommaire en TÊTE du document (frontTocPages :
      // AIM p. 14, entrée de sommaire propre en début de ligne). Repli :
      // première occurrence (mieux que rien).
      // Limite connue (passe plate) : les numéros recommencent à chaque
      // chapitre (AIM : chaque chapitre a son « 7.0 ») — la passe ne
      // peut pas les distinguer ; la couche signets (chapitres) le peut.
      // Autres limites du repli, vérifiées sur l'AIM réel : un titre
      // fusionné en milieu de ligne trop court (« 9.2.2 Marques 10.0
      // Prise de décision… », 14 caractères avant) n'est pas retenu, et
      // un titre absent du texte extrait (« 5.0 Divers » p. 66 : la
      // page est la fin de l'index, le titre n'y figure qu'en renvoi)
      // renvoie à la mention suivante (p. 98). La couche signets donne
      // les bonnes pages dans ces cas (GEN 5.0 p. 66, AGA 10.0 p. 120).
      const real = list.find((c) =>
        !tocPages.has(c.startPage) && !c.tocLike && !frontTocPages.has(c.startPage) &&
        !(tocContentPages.has(c.startPage) && (c.midLine || c.hasDots)));
      return { num, title, startPage: real ? real.startPage : list[0].startPage };
    })
    .sort((a, b) => a.startPage - b.startPage);
  for (const s of ordered) {
    const label = kind === 'sections'
      ? (s.title ? `Section ${s.num} — ${s.title}` : `Section ${s.num}`)
      : kind === 'numbered'
        ? (s.title ? `${s.num} — ${s.title}` : s.num)
        : (s.title ? `Chapitre ${s.num} — ${s.title}` : `Chapitre ${s.num}`);
    sections.push({ key: s.num, label, startPage: s.startPage, level: 2 });
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

// Assemblage commun aux couches outline / toc : dédoublonne (même clé, ou
// même page de début pour deux entrées du même niveau dans le même
// chapitre — on garde la première), trie par page (à égalité : chapitre
// avant sa première sous-section), exige ≥2 sections — ou 1 chapitre
// seul (un document avec des chapitres mais sans sous-sections
// numérotées montre quand même ses chapitres), ajoute
// « Début du document » et construit pageSection.
// `confidence` est la valeur par défaut ; une entrée peut porter la
// sienne (sommaire : 0.9 par étiquettes, 0.8 par ancres).
// Niveaux (v1.2.1) : 0 = début du document, 1 = chapitre, 2 =
// sous-section (défaut quand le champ est absent — anciennes données).
function finishLayeredSections(found, pages, source, confidence) {
  const seenKeys = new Set();
  const seenSlots = new Set();
  const uniq = [];
  for (const s of found) {
    if (!s) continue;
    if (seenKeys.has(s.key)) continue;
    // Même page de début : autorisée entre un chapitre et sa première
    // sous-section (même page, niveaux différents) ; deux entrées du
    // même niveau, dans le même chapitre, sur la même page restent un
    // doublon (la première gagne).
    const slot = `${s.startPage}|${s.level ?? 2}|${s.chapter || ''}`;
    if (seenSlots.has(slot)) continue;
    seenKeys.add(s.key);
    seenSlots.add(slot);
    uniq.push(s);
  }
  uniq.sort((a, b) => (a.startPage - b.startPage) || ((a.level ?? 2) - (b.level ?? 2)));
  if (uniq.length < 2 && !uniq.some((s) => (s.level ?? 2) === 1)) return null;
  const sections = [
    { key: 'front', label: 'Début du document', startPage: 1, level: 0, source, confidence: 1 },
    ...uniq.map((s) => ({ level: 2, ...s, source, confidence: s.confidence ?? confidence })),
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
const OUTLINE_PART_RE = /^(?:PART|PARTIE)\s+([IVXLCDM\d]+)\b\s*(.*)$/i;
// Code de chapitre à la AIM (« GEN — Généralités », « RAC — Règles… ») :
// 2 à 5 lettres capitales, tiret, nom du chapitre. Les numéros sont des
// SOUS-sections : les grands chapitres sont ces codes (imprimés
// verticalement dans la marge de l'AIM).
const OUTLINE_CODE_RE = /^([A-Z]{2,5})\s*[—–-]\s*(.+)$/;
const OUTLINE_CODE_BARE_RE = /^([A-Z]{2,5})$/;
// Une entrée de sommaire : toute sa sous-arborescence est une copie du
// sommaire imprimé (chapitres avec pages de sommaire, ex. AIM : GEN p.7,
// AGA p.8…), pas les vrais départs — à exclure entièrement.
const OUTLINE_TOC_RE = /^(table des matières|table of contents)$/i;
// Pages de garde : jamais des sections (repli signets plats).
const OUTLINE_NON_SECTION_RE = /^(couverture|colophon|page titre|title page|explication des changements|contents?|sommaire)$/i;

// Classifie un titre de signet : { kind, num, code, rest } ou null.
// kind : 'numbered' (« N.0 »), 'section' (« SECTION N »),
// 'chapter' (« CHAPTER/CHAPITRE N »), 'part' (« PART/IE X »),
// 'code' (« GEN — … »).
function classifyOutlineTitle(title) {
  let m = title.match(OUTLINE_NUMBERED_RE);
  if (m) return { kind: 'numbered', num: `${parseInt(m[1], 10)}.0`, rest: m[2] || '' };
  m = title.match(OUTLINE_SECTION_RE);
  if (m) return { kind: 'section', num: String(parseInt(m[1], 10)), rest: m[2] || '' };
  m = title.match(OUTLINE_CHAPTER_RE);
  if (m) return { kind: 'chapter', num: String(parseInt(m[1], 10)), rest: m[2] || '' };
  m = title.match(OUTLINE_PART_RE);
  if (m) return { kind: 'part', num: String(m[1]).toUpperCase(), rest: m[2] || '' };
  m = title.match(OUTLINE_CODE_RE);
  if (m) return { kind: 'code', code: m[1], rest: m[2] || '' };
  m = title.match(OUTLINE_CODE_BARE_RE);
  if (m) return { kind: 'code', code: m[1], rest: '' };
  return null;
}

// Clé + libellé d'un chapitre à partir de son titre.
// (« GEN — Généralités » -> GEN ; « CHAPTER 3 — Design » -> ch3 ;
// « PARTIE I » -> part-i ; autre titre -> slug.)
function chapterKeyLabel(title) {
  const info = classifyOutlineTitle(title);
  if (info && info.kind === 'code') {
    const t = cleanTitle(info.rest || '');
    return { key: info.code, label: t ? `${info.code} — ${t}` : info.code };
  }
  if (info && info.kind === 'chapter') {
    const t = cleanTitle(info.rest || '');
    return { key: `ch${info.num}`, label: t ? `Chapitre ${info.num} — ${t}` : `Chapitre ${info.num}` };
  }
  if (info && info.kind === 'part') {
    const t = cleanTitle(info.rest || '');
    return { key: `part-${info.num.toLowerCase()}`, label: t ? `Partie ${info.num} — ${t}` : `Partie ${info.num}` };
  }
  const slug = String(title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
  return { key: slug || 'chapitre', label: cleanTitle(title) || title };
}

// Libellé d'une sous-section numérotée (« 1.0 — Renseignements… »,
// « Section 1 — General »).
function numberedSectionLabel(kind, num, rest) {
  const t = cleanTitle(rest || '');
  if (kind === 'section') return t ? `Section ${num} — ${t}` : `Section ${num}`;
  return t ? `${num} — ${t}` : num;
}

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
//
// HIÉRARCHIE (v1.2.1) : on garde la structure parent -> enfants au lieu
// de l'aplatir. Un nœud est un CHAPITRE (niveau 1) s'il est nommé comme
// tel (code « GEN — … », « CHAPTER N », « PARTIE I ») ou s'il regroupe
// des sous-sections numérotées ; ses enfants numérotés (« N.0 »,
// « SECTION N ») sont ses SOUS-sections (niveau 2, clé « GEN 1.0 » —
// la numérotation recommence à chaque chapitre, une clé plate « 1.0 »
// les confondrait). Un chapitre sans sous-sections numérotées est quand
// même montré (dégradation gracieuse). Un signet numéroté hors chapitre
// reste une section plate (« 1.0 »), comme avant.
// Règles : la sous-arborescence « Table des matières » est écartée
// (ses chapitres pointent vers des pages de sommaire) ; « Couverture »,
// « Colophon », « Page titre » ne sont pas des sections. Repli : signets
// plats (tous au premier niveau, sans numérotation reconnaissable) et
// ≥2 -> on les prend tels quels. La destination est résolue comme le
// veut l'API : dest string -> getDestination() puis getPageIndex()
// (0-based, +1) ; dest array -> dest[0] est la réf de page. Un signet
// sans page résolvable est ignoré (ses enfants remontent au parent).
export async function detectOutlineSections(doc, pages) {
  let outline = null;
  try { outline = await doc.getOutline(); } catch { return null; }
  if (!outline || !outline.length) return null;
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
  // Arbre { title, startPage, children } — hiérarchie conservée.
  async function build(nodes) {
    const out = [];
    for (const node of nodes || []) {
      if (!node) continue;
      const title = cleanOutlineTitle(node.title);
      if (!title) continue;
      if (OUTLINE_TOC_RE.test(title)) continue; // sommaire : branche entière écartée
      const page = await resolvePage(node);
      const children = await build(node.items);
      if (page === null || page < 1 || page > doc.numPages) {
        out.push(...children); // enfants remontés au parent
        continue;
      }
      out.push({ title, startPage: page, children });
    }
    return out;
  }
  const roots = await build(outline);
  if (!roots.length) return null;

  const found = [];
  function hasNumberedDescendant(node) {
    for (const c of node.children) {
      const info = classifyOutlineTitle(c.title);
      if (info && (info.kind === 'numbered' || info.kind === 'section')) return true;
      if (hasNumberedDescendant(c)) return true;
    }
    return false;
  }
  function visit(node, chapterCtx) {
    const info = classifyOutlineTitle(node.title);
    if (info && (info.kind === 'chapter' || info.kind === 'part' || info.kind === 'code')) {
      const { key, label } = chapterKeyLabel(node.title);
      found.push({ key, label, startPage: node.startPage, level: 1 });
      const ctx = { key, label };
      for (const child of node.children) visit(child, ctx);
      return;
    }
    if (info && (info.kind === 'numbered' || info.kind === 'section')) {
      const label = numberedSectionLabel(info.kind, info.num, info.rest);
      if (chapterCtx) {
        found.push({ key: `${chapterCtx.key} ${info.num}`, label, startPage: node.startPage, level: 2, chapter: chapterCtx.key, chapterLabel: chapterCtx.label });
      } else {
        found.push({ key: info.num, label, startPage: node.startPage, level: 2 });
      }
      return; // les enfants (1.1, 1.1.1) ne sont pas des sections
    }
    // Nœud de regroupement au premier niveau avec des sous-sections
    // numérotées dedans (« Partie I »…) : c'est un chapitre. Dans un
    // chapitre, un tel nœud est transparent (on garde le chapitre).
    if (!chapterCtx && hasNumberedDescendant(node)) {
      const { key, label } = chapterKeyLabel(node.title);
      found.push({ key, label, startPage: node.startPage, level: 1 });
      const ctx = { key, label };
      for (const child of node.children) visit(child, ctx);
      return;
    }
    for (const child of node.children) visit(child, chapterCtx);
  }
  for (const root of roots) visit(root, null);

  if (found.length >= 2 || found.some((s) => s.level === 1)) {
    return finishLayeredSections(found, pages, 'outline', 0.95);
  }
  // Repli : signets plats (tous au premier niveau, sans numérotation
  // reconnaissable) et ≥2 -> on les prend tels quels (hors pages de
  // garde et sommaire).
  const contentRoots = roots.filter((r) => !OUTLINE_NON_SECTION_RE.test(r.title));
  if (contentRoots.length >= 2 && contentRoots.every((r) => r.children.length === 0)) {
    const flat = contentRoots.map((e, i) => ({
      key: `o${i + 1}`, label: cleanTitle(e.title) || e.title, startPage: e.startPage, level: 2,
    }));
    return finishLayeredSections(flat, pages, 'outline', 0.95);
  }
  return null;
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
  // Les entrées de chapitre (« GEN — Généralités », « CHAPITRE 3 »)
  // comptent aussi : elles ouvrent un chapitre dont les entrées
  // numérotées suivantes sont les sous-sections.
  let top = entries.filter((e) =>
    TOC_TOP_RE.test(e.rawTitle || e.title) || OUTLINE_CODE_RE.test(e.rawTitle || e.title));
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
  let chapterCtx = null;
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
    // Entrée de chapitre : elle ouvre un chapitre (niveau 1) ; les
    // entrées numérotées qui suivent en sont les sous-sections.
    const info = classifyOutlineTitle(e.rawTitle || e.title);
    if (info && (info.kind === 'chapter' || info.kind === 'part' || info.kind === 'code')) {
      const { key, label } = chapterKeyLabel(e.rawTitle || e.title);
      chapterCtx = { key, label };
      found.push({ key, label, startPage, level: 1, confidence });
      continue;
    }
    const s = outlineEntryToSection(e.rawTitle || e.title, startPage)
      || tocPlainEntryToSection(e.title, startPage);
    if (!s) continue;
    if (chapterCtx) {
      // Sous-section du chapitre courant : clé qualifiée (« GEN 1.0 ») —
      // la numérotation recommence à chaque chapitre.
      found.push({ ...s, key: `${chapterCtx.key} ${s.key}`, level: 2, chapter: chapterCtx.key, chapterLabel: chapterCtx.label, confidence });
    } else {
      found.push({ ...s, level: 2, confidence });
    }
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
