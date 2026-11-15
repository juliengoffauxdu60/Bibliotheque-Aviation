// Logique de l'application — Bibliothèque Aviation.
// Charge les 4 PDF ENTIERS avec UNE seule instance pdf.js par document (pas de
// découpage en morceaux) : un changement de page ou de section ne fait que
// re-rendre le canevas à partir du document déjà chargé, jamais recharger.
import * as pdfjsLib from 'app://assets/pdfjs/pdf.mjs';
import { searchDocs } from 'app://renderer/search.js';
import { fullSectionLabel } from 'app://renderer/sections.js';
import {
  ocrRectsForTerm, textRectsForTerm, pdfRectToCss, clampCssRect,
} from 'app://renderer/highlight.js';
import { initTools, convertValue, evaluateExpression } from 'app://renderer/tools.js';

// IMPORTANT : pour le schéma app://, « renderer » est le HÔTE de l'URL
// (app://renderer/app.js a pour chemin /app.js) : une résolution relative
// « ../assets/... » donnerait app://renderer/assets/... — faux. Donc URLs ABSOLUES.
pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://assets/pdfjs/pdf.worker.mjs';

const $ = (id) => document.getElementById(id);
const LARGE_WIDTH_PX = 640; // « Plus grand » ≈ 640 px de large (checklist, ligne 6).
// Zoom : en % de l'échelle de base (mode « Plus grand » ou « Page entière »),
// par pas de 25 points, de 50 % à 300 %. 100 % = taille de base du mode.
const ZOOM_MIN = 50, ZOOM_MAX = 300, ZOOM_STEP = 25;
function clampZoom(pct) {
  const n = Number.isFinite(pct) ? Math.round(pct) : 100;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n));
}

const state = {
  docsMeta: null, synonyms: null, indexes: {}, // docId -> index JSON
  currentDoc: null, currentPage: 1,
  viewMode: localStorage.getItem('poh-view-mode') || 'large',
  zoomPct: clampZoom(parseInt(localStorage.getItem('poh-zoom') || '100', 10)),
  results: [], currentResult: -1, lastQuery: '', lastScope: 'all', lastTotal: 0,
  pdfDocs: {},   // docId -> PDFDocumentProxy
  pdfPromises: {}, // docId -> promesse getDocument (évite les doubles chargements)
  pdfLoads: {},  // docId -> nombre d'appels getDocument (doit rester à 1)
  ready: null,
};

let lastHighlightRects = []; // rectangles CSS (par rapport au canevas) de la page affichée

let renderSeq = 0;
let currentRenderTask = null;
let centeringArmed = false; // vrai dès le premier centrage (le ResizeObserver ne recentre qu'après)
let scrollResizeObserver = null;

// Amène le milieu du canevas au milieu de la zone de lecture, avec les
// dimensions réelles du moment (même formule que le centrage historique).
// Idempotente : peut être rappelée après stabilisation de la mise en page
// ou quand la zone change de taille, sans effet de bord.
function centerCurrentPage() {
  const scroll = $('pdfScroll');
  const canvas = $('pdfCanvas');
  canvas.style.marginTop = '0px';
  const topPad = 18;
  const canvasCenter0 = topPad + canvas.offsetHeight / 2;
  const target = canvasCenter0 - scroll.clientHeight / 2;
  const maxScroll = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
  if (target < 0) {
    canvas.style.marginTop = (-target) + 'px';
    scroll.scrollTop = 0; scroll.scrollLeft = 0;
  } else {
    scroll.scrollTop = Math.min(target, maxScroll);
    scroll.scrollLeft = 0;
  }
}

// ---------------------------------------------------------------------------
// Chargement des données
// ---------------------------------------------------------------------------
async function loadData() {
  // v1.2.0 : plus aucun document fourni — data/docs.json est absent du
  // paquet (et du dépôt). Le fetch échoue proprement : liste vide, pas
  // de plantage. Les documents importés (userData/pohs) restent la
  // seule source de documents.
  let docsMeta = { docs: [] };
  try {
    const r = await fetch('app://data/docs.json');
    if (r.ok) {
      const parsed = await r.json();
      if (parsed && Array.isArray(parsed.docs)) docsMeta = parsed;
    }
  } catch { /* aucun document fourni : on part d'une liste vide */ }
  const synonyms = await fetch('app://data/synonyms.json').then((r) => r.json());
  state.docsMeta = docsMeta;
  state.synonyms = synonyms;
  const indexes = await Promise.all(
    docsMeta.docs.map((d) => fetch('app://' + d.index).then((r) => r.json())),
  );
  docsMeta.docs.forEach((d, i) => { state.indexes[d.id] = indexes[i]; });
  // Documents importés (registre userData/pohs) : même format que les
  // index fournis d'avant la v1.2.0, chargés avec eux — c'est LA source
  // unique de vérité pour la recherche (ordre : par date d'ajout).
  if (window.pohDesktop && window.pohDesktop.import) {
    const imported = await window.pohDesktop.import.list();
    for (const entry of imported) {
      const idx = await fetch('app://user-pohs/' + entry.doc_id + '/index.json').then((r) => r.json());
      docsMeta.docs.push(entry.doc);
      state.indexes[entry.doc_id] = idx;
    }
  }
  return docsMeta;
}

function docMeta(id) { return state.docsMeta.docs.find((d) => d.id === id); }
function numberedSections(doc) { return doc.sections.filter((s) => s.key !== 'front'); }
function sectionForPage(doc, page) {
  let current = doc.sections[0];
  for (const s of doc.sections) if (page >= s.startPage) current = s;
  return current;
}

// ---------------------------------------------------------------------------
// Sections à deux niveaux (v1.2.1) : chapitres (niveau 1, ex. GEN, RAC)
// et sous-sections (niveau 2, ex. « 1.0 — ... »). Les anciennes données
// sans champ `level` sont traitées comme niveau 2 sans chapitre : un
// document simple garde exactement l'interface d'aujourd'hui.
// ---------------------------------------------------------------------------
// Niveau d'une section : 0 = « Début du document », 1 = chapitre,
// 2 = sous-section (défaut pour les données anciennes).
function sectionLevel(s) { return s.level == null ? (s.key === 'front' ? 0 : 2) : s.level; }
function chapters(doc) { return doc.sections.filter((s) => sectionLevel(s) === 1); }
// Chapitre d'une sous-section : son champ `chapter`, ou à défaut le
// dernier chapitre dont le début précède ou égale le sien.
function chapterKeyOfSection(doc, s) {
  if (s.chapter) return String(s.chapter);
  let current = null;
  for (const x of doc.sections) {
    if (sectionLevel(x) === 1 && x.startPage <= s.startPage) current = x;
  }
  return current ? String(current.key) : null;
}
function chapterOfPage(doc, page) {
  let current = null;
  for (const s of doc.sections) {
    if (sectionLevel(s) === 1 && page >= s.startPage) current = s;
  }
  return current ? String(current.key) : null;
}
function subsectionsOfChapter(doc, chapterKey) {
  return doc.sections.filter((s) =>
    sectionLevel(s) === 2 && chapterKeyOfSection(doc, s) === String(chapterKey));
}

// Section « épinglée » par un clic sur une puce ou une entrée de menu :
// elle reste la section affichée/active tant que la page courante est
// dans son intervalle [startPage, début de la section suivante de même
// niveau ou supérieur avec une page strictement plus grande). Au-delà,
// le calcul normal par la page reprend. C'est ce qui fait « coller » le
// clic quand deux sections partagent la même page (ex. GEN et GEN 1.0
// commencent tous deux p. 35 de l'AIM).
let pinnedSection = null; // { docId, key }
function pinSection(docId, key) { pinnedSection = { docId, key: String(key) }; }
function effectiveSection(doc, page) {
  if (pinnedSection && pinnedSection.docId === doc.id) {
    const pinned = doc.sections.find((s) => String(s.key) === String(pinnedSection.key));
    if (pinned) {
      const level = sectionLevel(pinned);
      let end = Infinity;
      for (const s of doc.sections) {
        if (s.startPage > pinned.startPage && sectionLevel(s) <= level && s.startPage < end) end = s.startPage;
      }
      if (page >= pinned.startPage && page < end) return pinned;
    }
  }
  return sectionForPage(doc, page);
}

// ---------------------------------------------------------------------------
// PDF : une seule instance par document, rendue sur place
// ---------------------------------------------------------------------------
async function getPdfDoc(docId) {
  // On met en cache la PROMESSE, pas seulement le document résolu : sinon
  // deux rendus lancés pendant le premier chargement appelleraient
  // getDocument deux fois (le 172N fait 19 Mo, le chargement n'est pas instantané).
  if (state.pdfPromises[docId]) return state.pdfPromises[docId];
  const meta = docMeta(docId);
  state.pdfLoads[docId] = (state.pdfLoads[docId] || 0) + 1;
  const promise = pdfjsLib.getDocument({
    url: 'app://' + meta.pdf,
    disableRange: true,   // un seul téléchargement, pas de requêtes par morceaux
    disableStream: true,
    isEvalSupported: false,
  }).promise.then((pdf) => {
    state.pdfDocs[docId] = pdf;
    return pdf;
  }).catch((e) => {
    delete state.pdfPromises[docId]; // un échec ne doit pas empoisonner le cache
    throw e;
  });
  state.pdfPromises[docId] = promise;
  return promise;
}

async function renderCurrentPage() {
  const mySeq = ++renderSeq;
  const docId = state.currentDoc;
  const pageNum = state.currentPage;
  const meta = docMeta(docId);
  const scroll = $('pdfScroll');
  const canvas = $('pdfCanvas');
  const ctx = canvas.getContext('2d');
  $('pdfEmpty').hidden = true;
  // Le surlignage de la page précédente ne doit jamais rester visible
  // pendant le rendu de la nouvelle (il serait décalé) : on l'efface
  // dès le départ, le nouveau est peint après le rendu.
  clearHighlights();
  try {
    if (currentRenderTask) { try { await currentRenderTask.cancel(); } catch { /* déjà terminé */ } }
    const pdf = await getPdfDoc(docId);
    if (mySeq !== renderSeq) return { page: pageNum, error: 'annulé' };
    const page = await pdf.getPage(pageNum);
    if (mySeq !== renderSeq) return { page: pageNum, error: 'annulé' };
    const viewport0 = page.getViewport({ scale: 1 });
    const availW = scroll.clientWidth - 36;
    // En « Page entière », on réserve aussi la place du bloc de navigation
    // flottant (~64 px) pour que le bas de la page ne passe pas dessous.
    const availH = scroll.clientHeight - (state.viewMode === 'fit' ? 100 : 96);
    let scale;
    if (state.viewMode === 'fit') {
      scale = Math.min(availW / viewport0.width, availH / viewport0.height);
    } else {
      scale = Math.min(LARGE_WIDTH_PX, availW) / viewport0.width;
    }
    // Zoom : multiplie l'échelle de base du mode courant. Le centrage
    // (synchrone + double rAF, plus bas) s'applique après chaque rendu,
    // donc la page reste centrée à tous les niveaux de zoom.
    scale *= state.zoomPct / 100;
    const viewport = page.getViewport({ scale });
    canvas.width = Math.floor(viewport.width * window.devicePixelRatio);
    canvas.height = Math.floor(viewport.height * window.devicePixelRatio);
    canvas.style.width = Math.floor(viewport.width) + 'px';
    canvas.style.height = Math.floor(viewport.height) + 'px';
    const renderContext = {
      canvasContext: ctx,
      viewport,
      transform: [window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0],
    };
    currentRenderTask = page.render(renderContext);
    await currentRenderTask.promise;
    if (mySeq !== renderSeq) return { page: pageNum, error: 'annulé' };
    // Centrage : le milieu de la page arrive au milieu de la vue.
    // (Calcul par getBoundingClientRect : offsetTop serait faux ici, le panneau
    // lecteur étant positionné — les offsets se compteraient deux fois.)
    // On vise scrollTop = centrePage − moitié de la vue ; si ce scroll est
    // impossible (page plus courte que la vue : le scroll reste à 0 et le
    // centre n'est pas atteint), on compense par une marge haute.
    // Le centrage est appliqué SYNCHRONEMENT, avant le retour de la promesse :
    // un simple requestAnimationFrame courrait après la résolution (la mesure
    // qui suit un changement de page lirait alors le scrollTop de la page
    // précédente — décalé dès que la hauteur de la vue a changé entre les
    // deux pages, par ex. l'en-tête du lecteur passe à deux lignes pour les
    // titres longs). Un double requestAnimationFrame recentre ensuite, au cas
    // où la mise en page se stabiliserait après le rendu.
    updateReaderChrome();
    centerCurrentPage();
    centeringArmed = true;
    // Surlignage du terme cherché sur cette page, recalculé à chaque
    // rendu (le zoom et le mode changent le viewport) : il survit donc
    // au changement de page, de section, de document et de zoom.
    await updateHighlights(page, viewport);
    requestAnimationFrame(() => {
      if (mySeq !== renderSeq) return;
      requestAnimationFrame(() => {
        if (mySeq !== renderSeq) return;
        centerCurrentPage();
        // Le recentrage peut décaler le canevas (marge haute) : le calque
        // de surlignage suit, avec les mêmes rectangles.
        positionHighlightLayer();
      });
    });
    return { page: pageNum, error: 'aucune', loads: { ...state.pdfLoads } };
  } catch (e) {
    return { page: pageNum, error: String(e && e.message ? e.message : e), loads: { ...state.pdfLoads } };
  }
}

function updateReaderChrome() {
  const meta = docMeta(state.currentDoc);
  const section = effectiveSection(meta, state.currentPage);
  // Titre du lecteur : libellé complet partagé (chapitre + sous-section,
  // ex. « GEN 1.0 — Renseignements généraux ») ; le 2e argument n'est
  // qu'un repli pour une sous-section sans champ `chapter` explicite.
  $('readerTitle').textContent =
    `${meta.title} — ${fullSectionLabel(section, chapterKeyOfSection(meta, section))} — Page ${state.currentPage} sur ${meta.totalPages}`;
  $('pageCounter').textContent = `Page ${state.currentPage} sur ${meta.totalPages}`;
  $('ocrBanner').hidden = !meta.ocr;
  $('prevPageBtn').disabled = state.currentPage <= 1;
  $('nextPageBtn').disabled = state.currentPage >= meta.totalPages;
  $('zoomLabel').textContent = state.zoomPct + ' %';
  $('zoomOutBtn').disabled = state.zoomPct <= ZOOM_MIN;
  $('zoomInBtn').disabled = state.zoomPct >= ZOOM_MAX;
  $('fitBtn').classList.toggle('active', state.viewMode === 'fit');
  $('largeBtn').classList.toggle('active', state.viewMode === 'large');
  $('pdfScroll').classList.toggle('fit-mode', state.viewMode === 'fit');
  document.querySelectorAll('.doc-card').forEach((el) => {
    el.classList.toggle('active', el.dataset.doc === state.currentDoc);
  });
  // Puce active : dans la rangée chapitres, le chapitre de la section
  // courante (ou le chapitre lui-même) ; dans la rangée sous-sections,
  // la sous-section courante. Document simple : une seule rangée, la
  // puce de la section courante, comme aujourd'hui.
  const effChapterKey = sectionLevel(section) === 1
    ? String(section.key) : chapterKeyOfSection(meta, section);
  document.querySelectorAll('#sectionChips .chip').forEach((el) => {
    const inChapterRow = el.parentElement && el.parentElement.id === 'chapterChips';
    el.classList.toggle('active', inChapterRow
      ? el.dataset.section === effChapterKey
      : el.dataset.section === String(section.key) && sectionLevel(section) === 2);
  });
  document.querySelectorAll('#sectionsMenu button').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === String(section.key));
  });
}

async function openDocPage(docId, pageNum) {
  const meta = docMeta(docId);
  state.currentDoc = docId;
  state.currentPage = Math.min(Math.max(1, pageNum), meta.totalPages);
  buildSectionChips(docId);
  buildSectionsMenu(docId);
  updateReaderChrome(); // titre, bannière d'avertissement, puces : à jour même si le rendu échoue
  const res = await renderCurrentPage();
  return { doc: docId, page: state.currentPage, error: res.error, loads: { ...state.pdfLoads } };
}

// ---------------------------------------------------------------------------
// Surlignage des termes cherchés (v1.1.3)
// ---------------------------------------------------------------------------
// Les rectangles sont des <div> absolument positionnés AU-DESSUS du
// canevas (jamais dessinés dessus — le re-rendu les effacerait), dans le
// calque #pdfHighlightLayer, qui suit le canevas (même origine, même
// taille, recalculé à chaque rendu et à chaque recentrage). Le terme
// surligné est celui du résultat courant (result.termFound), sur toutes
// ses occurrences de la page affichée — pas seulement la première.
// Sources, dans l'ordre : le texte réel du PDF (getTextContent, aucun
// changement d'index), puis les boîtes OCR de l'index du document importé
// (champ ocr_words de la page). Sans recherche active, rien.

function clearHighlights() {
  lastHighlightRects = [];
  const layer = $('pdfHighlightLayer');
  if (layer) {
    layer.innerHTML = '';
    // Un calque vide avec une géométrie périmée (page/zoom d'avant)
    // étendrait quand même la zone de défilement : on la réinitialise.
    layer.style.left = '';
    layer.style.top = '';
    layer.style.width = '';
    layer.style.height = '';
  }
}

// Recale le calque sur le canevas (origine + taille), sans toucher aux
// rectangles qu'il contient (exprimés par rapport au canevas).
function positionHighlightLayer() {
  const layer = $('pdfHighlightLayer');
  const canvas = $('pdfCanvas');
  const wrap = $('pdfPageWrap');
  if (!layer || !canvas || !wrap || !lastHighlightRects.length) return;
  const c = canvas.getBoundingClientRect();
  const w = wrap.getBoundingClientRect();
  layer.style.left = (c.left - w.left) + 'px';
  layer.style.top = (c.top - w.top) + 'px';
  layer.style.width = c.width + 'px';
  layer.style.height = c.height + 'px';
}

function paintHighlightRects(rects) {
  lastHighlightRects = rects;
  const layer = $('pdfHighlightLayer');
  if (!layer) return;
  layer.innerHTML = '';
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'pdf-highlight';
    d.style.left = r.left + 'px';
    d.style.top = r.top + 'px';
    d.style.width = r.width + 'px';
    d.style.height = r.height + 'px';
    layer.appendChild(d);
  }
  positionHighlightLayer();
}

async function updateHighlights(page, viewport) {
  const result = state.currentResult >= 0 ? state.results[state.currentResult] : null;
  const term = result ? result.termFound : null;
  if (!term) { clearHighlights(); return; }
  try {
    let rectsPdf = [];
    // 1) PDF à vrai texte : positions via getTextContent au moment du rendu.
    const tc = await page.getTextContent();
    const items = (tc.items || []).map((it) => ({
      str: it.str,
      x: it.transform ? it.transform[4] : 0,
      y: it.transform ? it.transform[5] : 0,
      width: typeof it.width === 'number' ? it.width : 0,
      height: typeof it.height === 'number' ? it.height
        : (it.transform ? Math.abs(it.transform[3]) : 10),
      // Matrice [a, b, c, d, e, f] : porte la rotation du texte — sans
      // elle, un mot vertical (onglet « RAC » de l'AIM) est surligné par
      // un rectangle horizontal qui ne le couvre pas (v1.2.0).
      transform: it.transform ? [...it.transform] : undefined,
    }));
    rectsPdf = textRectsForTerm(items, term);
    // 2) PDF scanné : boîtes OCR, dans l'index du document importé
    // (champ ocr_words de la page). Sans recherche active, rien.
    if (!rectsPdf.length) {
      const idx = state.indexes[state.currentDoc];
      const entry = idx && idx.pages ? idx.pages[state.currentPage - 1] : null;
      const wordsPage = entry && entry.ocr_words && Array.isArray(entry.ocr_words.words)
        ? entry.ocr_words : null;
      if (wordsPage) {
        const vp0 = page.getViewport({ scale: 1 });
        rectsPdf = ocrRectsForTerm(
          wordsPage.words, wordsPage.imageWidth, wordsPage.imageHeight,
          term, vp0.width, vp0.height);
      }
    }
    const cssRects = rectsPdf
      .map((r) => pdfRectToCss(viewport, r))
      .map((r) => clampCssRect(r, viewport.width, viewport.height))
      .filter(Boolean);
    paintHighlightRects(cssRects);
  } catch {
    // Le surlignage ne doit jamais casser l'affichage de la page.
    clearHighlights();
  }
}

// Mesure pour l'auto-test : nombre de rectangles visibles sur la page
// courante, terme surligné, et alignement du calque sur le canevas.
function highlightInfo() {
  const layer = $('pdfHighlightLayer');
  const canvas = $('pdfCanvas');
  const result = state.currentResult >= 0 ? state.results[state.currentResult] : null;
  let aligned = false;
  if (layer && canvas && lastHighlightRects.length) {
    const l = layer.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    aligned = Math.abs(l.left - c.left) <= 1 && Math.abs(l.top - c.top) <= 1 &&
      Math.abs(l.width - c.width) <= 1 && Math.abs(l.height - c.height) <= 1;
  }
  return JSON.stringify({
    term: result ? result.termFound : null,
    page: state.currentPage,
    doc: state.currentDoc,
    rects: layer ? layer.childElementCount : 0,
    aligned,
  });
}

// ---------------------------------------------------------------------------
// Documents, sections
// ---------------------------------------------------------------------------
// Échappement HTML minimal (titres de documents importés affichés
// dans les cartes).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Un document a du texte cherchable si au moins une page de son index
// contient du texte. Sans texte (document scanné dont la lecture du
// texte n'a pas été faite), la carte l'indique — c'est le seul
// avertissement affiché sur une carte (v1.2.0).
function hasSearchableText(doc) {
  const idx = state.indexes[doc.id];
  const pages = idx && Array.isArray(idx.pages) ? idx.pages : [];
  return pages.some((p) => p && typeof p.text === 'string' && p.text.trim() !== '');
}

function buildDocCards() {
  const wrap = $('docCards');
  wrap.innerHTML = '';
  // État vide (v1.2.0, premier lancement sans document importé) : message
  // clair dans la zone Documents ; le bouton « ＋ Ajouter un document »
  // (construit par renderer/import.js) reste visible juste en dessous.
  if (!state.docsMeta.docs.length) {
    const p = document.createElement('p');
    p.className = 'docs-empty';
    p.textContent = 'Aucun document pour l’instant. Ajoutez votre premier document avec le bouton « ＋ Ajouter un document » ci-dessous.';
    wrap.appendChild(p);
    return;
  }
  // Carte (maquette approuvée) : titre + nombre de pages seulement,
  // bouton « Rechercher dans le document », champ qui apparaît sur la
  // carte, badge « Recherche ici » sur la carte active. Le ✕ Supprimer
  // est ajouté par renderer/import.js. Générique pour CHAQUE document,
  // importés compris — rien n'est codé en dur pour un document précis.
  const searchSvg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="2.2"/><path d="M15.5 15.5 L21 21" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  for (const doc of state.docsMeta.docs) {
    const card = document.createElement('article');
    card.className = 'doc-card';
    card.dataset.doc = doc.id;
    card.innerHTML =
      '<div class="card-top"><span class="search-badge">Recherche ici</span></div>' +
      `<button type="button" class="doc-title">${esc(doc.title)}</button>` +
      `<span class="doc-pages">${doc.totalPages} pages</span>` +
      (hasSearchableText(doc) ? ''
        : '<p class="doc-no-text">Pas de texte cherchable : la recherche ne trouvera rien dans ce document, mais vous pouvez le lire dans le lecteur.</p>') +
      `<button type="button" class="btn-search" data-search="${esc(doc.id)}">${searchSvg}<span>Rechercher dans le document</span></button>` +
      `<div class="card-search" id="search-${esc(doc.id)}">` +
        '<div class="field-row">' +
          `<input class="search-input card-search-input" id="input-${esc(doc.id)}" type="search" placeholder="Un mot dans ${esc(doc.title)}…" autocomplete="off">` +
          `<button type="button" class="btn-close" data-close="${esc(doc.id)}" aria-label="Fermer la recherche">✕</button>` +
        '</div>' +
        `<p class="card-hits" id="hits-${esc(doc.id)}"></p>` +
      '</div>';
    wrap.appendChild(card);
  }
}

function makeSectionChip(docId, s, extraClass, row) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip' + (extraClass ? ' ' + extraClass : '');
  b.dataset.section = String(s.key);
  b.textContent = s.label;
  b.addEventListener('click', (e) => {
    pinSection(docId, s.key); // le clic colle (voir effectiveSection)
    openDocPage(docId, s.startPage);
    e.currentTarget.blur();
  });
  row.appendChild(b);
}

// Deux rangées sobres : chapitres (niveau 1) puis sous-sections du
// chapitre courant (niveau 2). Document sans chapitres : une seule
// rangée, les mêmes puces qu'aujourd'hui. Chapitre sans sous-sections :
// seule la rangée chapitres. La rangée 2 est reconstruite à chaque
// changement de page (openDocPage), donc elle suit le feuilletage,
// la recherche et les clics.
function buildSectionChips(docId) {
  const doc = docMeta(docId);
  const chapterRow = $('chapterChips');
  const subRow = $('subChips');
  chapterRow.innerHTML = '';
  subRow.innerHTML = '';
  const chaps = chapters(doc);
  if (chaps.length) {
    for (const c of chaps) makeSectionChip(docId, c, 'chapter-chip', chapterRow);
    let chKey = chapterOfPage(doc, state.currentPage);
    if (!chKey) chKey = chapterKeyOfSection(doc, effectiveSection(doc, state.currentPage));
    if (chKey) {
      for (const s of subsectionsOfChapter(doc, chKey)) makeSectionChip(docId, s, '', subRow);
    }
  } else {
    for (const s of numberedSections(doc)) makeSectionChip(docId, s, '', subRow);
  }
}

function buildSectionsMenu(docId) {
  const doc = docMeta(docId);
  const menu = $('sectionsMenu');
  menu.innerHTML = '';
  const eff = effectiveSection(doc, state.currentPage);
  for (const s of doc.sections) {
    const level = sectionLevel(s);
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.section = String(s.key);
    b.dataset.level = String(level);
    // Chapitres en en-têtes (gras, cliquables), sous-sections indentées.
    // Document simple : aucune classe, l'aspect d'aujourd'hui.
    if (level === 1) b.className = 'menu-chapter';
    else if (level === 2 && chapters(doc).length) b.className = 'menu-sub';
    if (eff && String(eff.key) === String(s.key)) b.classList.add('active');
    // Libellé complet partagé : une sous-section s'affiche avec son
    // chapitre (« GEN 1.0 — ... ») ; chapitre et document simple inchangés.
    b.innerHTML = `<span>${esc(fullSectionLabel(s, chapterKeyOfSection(doc, s)))}</span><span class="pg">p. ${s.startPage}</span>`;
    b.addEventListener('click', (e) => {
      menu.hidden = true;
      $('sectionsMenuBtn').setAttribute('aria-expanded', 'false');
      pinSection(docId, s.key); // le clic colle (voir effectiveSection)
      openDocPage(docId, s.startPage);
      e.currentTarget.blur();
    });
    menu.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Recherche (v1.2.0, design approuvé — maquette)
// Portée : le document de la carte active, ou « tous » via la puce.
// Plus de menu déroulant, plus de champ dans l'en-tête : la recherche
// globale vit dans la puce « Tous les documents », la recherche par
// document dans les cartes. La navigation entre occurrences (flèches +
// compteur « X sur N ») vit dans le bloc flottant du lecteur, en bas —
// le gros bloc de résultats de la colonne de gauche est supprimé.
// (Choix de placement : Julien demande les flèches « en bas du lecteur » ;
// la maquette les montre en haut du lecteur, dans sa barre de titre —
// le bloc flottant, en bas, est le placement retenu.)
// ---------------------------------------------------------------------------
function orderedIndexes() {
  return state.docsMeta.docs.map((d) => state.indexes[d.id]);
}
function metaMap() {
  const m = {};
  for (const d of state.docsMeta.docs) m[d.id] = d;
  return m;
}

// Petit anti-rebond pour la saisie en direct (carte / globale).
const searchTimers = {};
function debounce(key, ms, fn) {
  clearTimeout(searchTimers[key]);
  searchTimers[key] = setTimeout(fn, ms);
}

// État de la portée : 'all' | docId | null (aucune recherche active).
// Met à jour puce, panneau global, badges et champs des cartes.
function updateSearchScopeUI(openFieldFor) {
  const scope = state.lastScope;
  document.querySelectorAll('.doc-card').forEach((card) => {
    const active = scope !== 'all' && scope !== null && card.dataset.doc === scope;
    card.classList.toggle('search-active', active);
    const field = card.querySelector('.card-search');
    if (field && card.dataset.doc !== openFieldFor) field.classList.remove('open');
  });
  $('chipAll').setAttribute('aria-pressed', scope === 'all' ? 'true' : 'false');
  $('globalSearch').classList.toggle('open', scope === 'all');
  const note = $('scopeNote');
  if (scope === 'all') {
    note.textContent = 'La recherche porte sur tous les documents.';
  } else if (scope) {
    const doc = docMeta(scope);
    note.textContent = doc
      ? `La recherche porte sur ${doc.title} — c'est la carte marquée « Recherche ici ».`
      : 'Choisis un document, ou cherche partout.';
  } else {
    note.textContent = 'Choisis un document, ou cherche partout.';
  }
  if (openFieldFor) {
    const field = $('search-' + openFieldFor);
    if (field) field.classList.add('open');
  }
}

function setSearchScope(scope, openField) {
  state.lastScope = scope;
  updateSearchScopeUI(openField ? scope : null);
  if (openField) {
    const input = $('input-' + scope);
    if (input) setTimeout(() => input.focus(), 60);
  }
}

// Passer en global efface la recherche par document en cours : les
// résultats et le surlignage repartent de zéro.
function setScopeAll(focusInput) {
  clearSearchResults();
  setSearchScope('all', false);
  renderGlobalResults();
  if (focusInput) setTimeout(() => $('globalInput').focus(), 60);
}

// Ouvre le champ de recherche d'une carte et y inscrit la requête
// (sans voler le focus, sauf demande explicite).
function revealCardSearch(docId, query, focus) {
  const input = $('input-' + docId);
  if (input && typeof query === 'string') input.value = query;
  const hitsEl = $('hits-' + docId);
  if (hitsEl) hitsEl.textContent = '';
  state.lastScope = docId;
  updateSearchScopeUI(docId);
  if (focus) {
    const el = $('input-' + docId);
    if (el) setTimeout(() => el.focus(), 60);
  }
}

function closeCardSearch(docId) {
  const field = $('search-' + docId);
  if (field) field.classList.remove('open');
  const input = $('input-' + docId);
  if (input) input.value = '';
  const hitsEl = $('hits-' + docId);
  if (hitsEl) hitsEl.textContent = '';
  if (state.lastScope === docId) {
    state.lastScope = null;
    updateSearchScopeUI(null);
    clearSearchResults();
    $('searchStatus').textContent = '';
  }
}

// Ligne « N occurrences — surlignées dans le lecteur. » sous le champ
// d'une carte (occurrences comptées sur les pages trouvées).
function updateCardHits(docId) {
  const hitsEl = $('hits-' + docId);
  if (!hitsEl) return;
  const q = (state.lastQuery || '').trim();
  if (!q) { hitsEl.textContent = ''; return; }
  const mine = state.results.filter((r) => r.docId === docId);
  if (!mine.length) {
    hitsEl.textContent = 'Aucun résultat dans ce document.';
    return;
  }
  const occ = mine.reduce((n, r) => n + r.occurrences, 0);
  hitsEl.textContent = `${occ} occurrence${occ > 1 ? 's' : ''} — surlignées dans le lecteur.`;
}

// Efface la recherche en cours : résultats, compteur, surlignage.
function clearSearchResults() {
  state.results = [];
  state.currentResult = -1;
  state.lastTotal = 0;
  state.lastQuery = '';
  updateResultCounter();
  clearHighlights();
}

async function runSearch(query, scopeOpt) {
  const scope = scopeOpt || state.lastScope || 'all';
  const limit = scope === 'all' ? 500 : 1000;
  const { results, total, truncated, terms } = searchDocs(
    orderedIndexes(), metaMap(), query, state.synonyms, { scope, limit },
  );
  state.results = results;
  state.lastQuery = query;
  state.lastScope = scope;
  state.lastTotal = total;
  state.currentResult = results.length ? 0 : -1;
  const status = total === 0
    ? `Aucun résultat pour « ${query} ». Essayez un autre mot, en français ou en anglais (ex. : décrochage, fuel, volets).`
    : `${total} résultat${total > 1 ? 's' : ''} pour « ${query} »` +
      (terms.length > 1 ? ` (termes cherchés : ${terms.join(', ')})` : '') +
      (truncated ? ` — affichage limité aux ${results.length} premiers.` : '');
  $('searchStatus').textContent = status;
  updateResultCounter();
  if (scope !== 'all') updateCardHits(scope);
  if (results.length) await openResult(0);
  else clearHighlights(); // sans résultat, aucun surlignage ne doit rester
  return { total, results };
}

// Recherche dans la carte d'un document (saisie en direct).
async function runCardSearch(docId) {
  const input = $('input-' + docId);
  const q = input ? input.value.trim() : '';
  state.lastScope = docId;
  updateSearchScopeUI(docId); // badge + champ ouvert, autres fermés
  if (!q) {
    clearSearchResults();
    updateCardHits(docId);
    $('searchStatus').textContent = '';
    return { total: 0, results: [] };
  }
  return runSearch(q, docId);
}

// Recherche globale (puce « Tous les documents ») : occurrences par
// document ; un clic sur une ligne ouvre la bonne carte, avec la
// requête reprise dans son champ.
function renderGlobalResults() {
  const list = $('globalResults');
  const q = $('globalInput').value.trim();
  list.innerHTML = '';
  if (!q) return;
  const { results } = searchDocs(
    orderedIndexes(), metaMap(), q, state.synonyms, { scope: 'all', limit: 1000 },
  );
  const byDoc = new Map();
  for (const r of results) {
    const entry = byDoc.get(r.docId) || { title: r.docTitle, occ: 0 };
    entry.occ += r.occurrences;
    byDoc.set(r.docId, entry);
  }
  if (!byDoc.size) {
    const p = document.createElement('p');
    p.className = 'global-empty';
    p.textContent = 'Aucun résultat dans les documents.';
    list.appendChild(p);
    return;
  }
  for (const [docId, entry] of byDoc) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'global-hit';
    b.dataset.doc = docId;
    b.innerHTML = `<span>${esc(entry.title)}</span><span class="n">${entry.occ} occurrence${entry.occ > 1 ? 's' : ''}</span>`;
    b.addEventListener('click', (e) => {
      revealCardSearch(docId, q, true);
      runSearch(q, docId);
      e.currentTarget.blur();
    });
    list.appendChild(b);
  }
}

// Compteur des occurrences, dans le bloc flottant du lecteur :
// « X sur N » (N = pages contenant le terme), « 0 résultat »,
// « — » quand aucune recherche n'est en cours.
function updateResultCounter() {
  const n = state.lastTotal;
  const counter = $('hitCounter');
  if (counter) {
    counter.textContent = !state.lastQuery ? '—'
      : n === 0 ? '0 résultat'
      : `${state.currentResult + 1} sur ${n}`;
  }
  // La barre d'occurrences n'apparaît QUE pendant une recherche active.
  const hitNav = $('hitNav');
  if (hitNav) hitNav.hidden = !state.lastQuery;
  $('prevHitBtn').disabled = state.currentResult <= 0;
  $('nextHitBtn').disabled = state.currentResult < 0 || state.currentResult >= n - 1;
}

async function openResult(i) {
  if (i < 0 || i >= state.results.length) return null;
  state.currentResult = i;
  const r = state.results[i];
  // En recherche globale, ouvrir un résultat bascule la recherche sur
  // son document : badge + champ de la carte, requête reprise.
  if (state.lastScope === 'all') revealCardSearch(r.docId, state.lastQuery, false);
  updateResultCounter();
  const res = await openDocPage(r.docId, r.page);
  return { doc: res.doc, page: res.page, error: res.error, loads: res.loads };
}

// ---------------------------------------------------------------------------
// Mesures pour l'auto-test (état réel du DOM, jamais une relecture du code)
// ---------------------------------------------------------------------------
function centeringInfo() {
  const scroll = $('pdfScroll');
  const canvas = $('pdfCanvas');
  const sRect = scroll.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  const canvasCenterY = cRect.top + cRect.height / 2;
  const viewportCenterY = sRect.top + sRect.height / 2;
  return JSON.stringify({
    mode: state.viewMode,
    offsetPx: Math.round(canvasCenterY - viewportCenterY),
    fitsWithoutScroll: scroll.scrollHeight <= scroll.clientHeight + 1 &&
      scroll.scrollWidth <= scroll.clientWidth + 1,
    canvasCssWidth: Math.round(cRect.width),
    clientHeight: scroll.clientHeight,
    canvasH: Math.round(cRect.height),
    marginTop: canvas.style.marginTop || '0px',
    scrollTop: scroll.scrollTop,
  });
}

function zoomInfo() {
  const scroll = $('pdfScroll');
  const canvas = $('pdfCanvas');
  const sRect = scroll.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  // Le centre de la vue se mesure avec clientHeight (zone visible réelle),
  // pas avec la hauteur de la boîte : quand la page zoomée est plus large
  // que la vue, la barre de défilement horizontale réduit clientHeight
  // (~15 px) alors que getBoundingClientRect garde la hauteur totale —
  // mesurer avec la boîte fausserait le centrage de ~8 px.
  const viewportCenterY = sRect.top + scroll.clientHeight / 2;
  return JSON.stringify({
    zoomPct: state.zoomPct,
    mode: state.viewMode,
    offsetPx: Math.round((cRect.top + cRect.height / 2) - viewportCenterY),
    canvasCssWidth: Math.round(cRect.width),
    label: $('zoomLabel').textContent,
    zoomOutDisabled: $('zoomOutBtn').disabled,
    zoomInDisabled: $('zoomInBtn').disabled,
  });
}

function floatingNavInfo() {
  const nav = document.querySelector('.floating-nav');
  const panel = document.querySelector('.reader-panel');
  const scroll = $('pdfScroll');
  const nRect = nav.getBoundingClientRect();
  const pRect = panel.getBoundingClientRect();
  return JSON.stringify({
    visible: nav.offsetParent !== null,
    pinnedBottom: Math.abs(pRect.bottom - nRect.bottom) <= 30,
    outsideScrollArea: !scroll.contains(nav) && nav.parentElement === panel,
    centered: Math.abs((nRect.left + nRect.width / 2) - (pRect.left + pRect.width / 2)) <= 5,
  });
}

function nonBlankPixels() {
  const canvas = $('pdfCanvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const step = 8;
  const data = ctx.getImageData(0, 0, w, h).data;
  let n = 0;
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      if (data[i] < 250 || data[i + 1] < 250 || data[i + 2] < 250) n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Démarrage + API d'auto-test
// ---------------------------------------------------------------------------
function bindEvents() {
  // Puce « Tous les documents » : bascule vers la recherche globale,
  // ou revient à la recherche par document en cours.
  $('chipAll').addEventListener('click', (e) => {
    if (state.lastScope === 'all') {
      // Retour : aucune recherche active (le badge « Recherche ici »
      // ne marque que la carte où une recherche est en cours).
      state.lastScope = null;
      updateSearchScopeUI(null);
    } else {
      setScopeAll(true);
    }
    e.currentTarget.blur();
  });
  // Recherche globale : saisie en direct, occurrences par document.
  $('globalInput').addEventListener('input', () => {
    debounce('global', 200, renderGlobalResults);
  });
  $('globalInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = e.target.value.trim();
      if (q) renderGlobalResults();
    }
  });
  // Cartes : bouton = ouvrir sa recherche ; TOUTE la carte = ouvrir le
  // document en lecture, sans recherche ; ✕ = fermer sa recherche.
  // Délégation : les cartes sont reconstruites à chaque chargement des
  // données. Le clic sur le bouton de recherche ne déclenche pas
  // l'ouverture simple (retour immédiat), et le clic dans le champ de
  // recherche de la carte ne l'ouvre pas non plus.
  $('docCards').addEventListener('click', (e) => {
    const searchBtn = e.target.closest('[data-search]');
    if (searchBtn) {
      const docId = searchBtn.dataset.search;
      setSearchScope(docId, true);
      if (state.currentDoc !== docId) openDocPage(docId, 1);
      else updateReaderChrome();
      return;
    }
    const closeBtn = e.target.closest('[data-close]');
    if (closeBtn) { closeCardSearch(closeBtn.dataset.close); return; }
    // Clics dans le champ de recherche de la carte ou sur le ✕ Supprimer
    // ne doivent pas ouvrir le document.
    if (e.target.closest('.card-search') || e.target.closest('.doc-delete')) return;
    const card = e.target.closest('.doc-card');
    if (card) {
      // Clic sur TOUTE la carte = ouvrir en lecture, sans recherche :
      // la recherche en cours (portée, badge, champ) n'est pas touchée.
      openDocPage(card.dataset.doc, 1);
    }
  });
  // Saisie en direct dans le champ d'une carte.
  $('docCards').addEventListener('input', (e) => {
    if (!e.target.classList || !e.target.classList.contains('card-search-input')) return;
    const docId = e.target.id.replace('input-', '');
    debounce('card-' + docId, 250, () => runCardSearch(docId));
  });
  // Navigation entre occurrences, dans le bloc flottant du lecteur.
  $('prevHitBtn').addEventListener('click', (e) => {
    if (state.currentResult > 0) openResult(state.currentResult - 1);
    e.currentTarget.blur();
  });
  $('nextHitBtn').addEventListener('click', (e) => {
    if (state.currentResult >= 0 && state.currentResult < state.results.length - 1) openResult(state.currentResult + 1);
    e.currentTarget.blur();
  });
  $('prevPageBtn').addEventListener('click', (e) => { openDocPage(state.currentDoc, state.currentPage - 1); e.currentTarget.blur(); });
  $('nextPageBtn').addEventListener('click', (e) => { openDocPage(state.currentDoc, state.currentPage + 1); e.currentTarget.blur(); });
  $('zoomInBtn').addEventListener('click', (e) => { setZoom(state.zoomPct + ZOOM_STEP); e.currentTarget.blur(); });
  $('zoomOutBtn').addEventListener('click', (e) => { setZoom(state.zoomPct - ZOOM_STEP); e.currentTarget.blur(); });
  $('fitBtn').addEventListener('click', (e) => { setViewMode('fit'); e.currentTarget.blur(); });
  $('largeBtn').addEventListener('click', (e) => { setViewMode('large'); e.currentTarget.blur(); });
  $('sectionsMenuBtn').addEventListener('click', (e) => {
    const menu = $('sectionsMenu');
    menu.hidden = !menu.hidden;
    $('sectionsMenuBtn').setAttribute('aria-expanded', String(!menu.hidden));
    e.currentTarget.blur();
  });
  document.addEventListener('click', (e) => {
    const menu = $('sectionsMenu');
    if (!menu.hidden && !e.target.closest('.sections-menu-wrap')) {
      menu.hidden = true;
      $('sectionsMenuBtn').setAttribute('aria-expanded', 'false');
    }
  });
  // Recentrage si la zone de lecture change de taille après le rendu
  // (redimensionnement de la fenêtre, en-tête du lecteur qui passe à deux
  // lignes pour un titre long...) : la cible du centrage dépend de la
  // hauteur de la vue. Ne recentre qu'après le premier rendu, jamais sur
  // le canevas vide du démarrage.
  if (!scrollResizeObserver) {
    scrollResizeObserver = new ResizeObserver(() => {
      if (centeringArmed) {
        centerCurrentPage();
        positionHighlightLayer();
      }
    });
    scrollResizeObserver.observe($('pdfScroll'));
  }
}

async function setViewMode(mode) {
  if (mode !== state.viewMode) {
    state.viewMode = mode;
    localStorage.setItem('poh-view-mode', mode);
    // Changer de mode repart de la taille de base : « Page entière » doit
    // montrer la page entière, « Plus grand » ses 640 px de base.
    state.zoomPct = 100;
    localStorage.setItem('poh-zoom', '100');
  }
  if (state.currentDoc) await renderCurrentPage();
  else updateReaderChromeSafe();
}

// Zoom : le facteur vit dans l'état, donc il survit à tout changement de
// page, de section et de document (chaque rendu l'applique) ; il est aussi
// mémorisé d'une session à l'autre, comme le mode d'affichage.
async function setZoom(pct) {
  state.zoomPct = clampZoom(pct);
  localStorage.setItem('poh-zoom', String(state.zoomPct));
  if (state.currentDoc) await renderCurrentPage();
  else {
    $('zoomLabel').textContent = state.zoomPct + ' %';
    $('zoomOutBtn').disabled = state.zoomPct <= ZOOM_MIN;
    $('zoomInBtn').disabled = state.zoomPct >= ZOOM_MAX;
  }
  return state.zoomPct + ' %';
}

function updateReaderChromeSafe() {
  if (!state.currentDoc) {
    $('fitBtn').classList.toggle('active', state.viewMode === 'fit');
    $('largeBtn').classList.toggle('active', state.viewMode === 'large');
  }
}

state.ready = (async () => {
  await loadData();
  buildDocCards();
  initTools();
  bindEvents();
  updateResultCounter(); // flèches d'occurrences désactivées, compteur « — »
  updateReaderChromeSafe();
  // Document par défaut : le premier document visible. Aucun document :
  // le lecteur reste sur son message vide.
  const firstDoc = state.docsMeta.docs[0];
  if (firstDoc) await openDocPage(firstDoc.id, 1);
})();

// Chevauchement de la colonne de gauche sur les outils (auto-test) :
// la grille a une hauteur fixe ; si les cartes + puces de sections
// dépassent son bas, elles peignent par-dessus la section « Outils »
// qui suit. Le correctif (.left-col défilante) fait défiler la colonne
// dans la grille au lieu de déborder.
// Mesure : on compare les rects VISIBLES (intersection avec la boîte
// de la colonne — getBoundingClientRect seul ne distingue pas un contenu
// rogné par le défilement d'un contenu qui peint par-dessus les outils).
function layoutOverlapInfo() {
  const grid = document.querySelector('.grid');
  const leftCol = document.querySelector('.left-col');
  const sections = document.querySelector('.sections-block');
  const tools = document.querySelector('section.tools');
  if (!grid || !leftCol || !sections || !tools) return JSON.stringify({ error: 'éléments introuvables' });
  const r = (el) => el.getBoundingClientRect();
  const inter = (a, b) => {
    const x0 = Math.max(a.left, b.left), y0 = Math.max(a.top, b.top);
    const x1 = Math.min(a.right, b.right), y1 = Math.min(a.bottom, b.bottom);
    return (x1 > x0 && y1 > y0) ? { left: x0, top: y0, right: x1, bottom: y1 } : null;
  };
  const hits = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const col = r(leftCol);
  const toolsH2 = r(tools.querySelector('h2') || tools);
  // Zone réellement peinte : si la colonne rogne son contenu (défilement),
  // c'est l'intersection avec sa boîte ; sinon (ancien code, débordement
  // visible), c'est le rectangle entier — qui peut atteindre les outils.
  const clips = getComputedStyle(leftCol).overflowY !== 'visible';
  const visSections = clips ? inter(r(sections), col) : r(sections);
  const info = {
    gridBottom: Math.round(r(grid).bottom),
    sectionsBottom: Math.round(r(sections).bottom),
    leftColScrolls: leftCol.scrollHeight > leftCol.clientHeight + 1,
    overlap: hits(visSections, toolsH2),
  };
  return JSON.stringify(info);
}

// API utilisée par l'auto-test (main.js, POH_SELFTEST=1) — état réel de l'appli.
window.__poh = {
  ready: () => state.ready,
  state: () => ({
    docsLoaded: Object.keys(state.indexes).length,
    totalPages: state.docsMeta.docs.reduce((n, d) => n + d.totalPages, 0),
  }),
  search: (q) => {
    // Entrée programmatique (auto-test) : recherche globale, comme si
    // la puce « Tous les documents » avait été activée puis le mot tapé.
    setScopeAll(false);
    $('globalInput').value = q;
    renderGlobalResults();
    return runSearch(q, 'all');
  },
  // Ouvre la recherche de la carte d'un document, avec la requête
  // reprise dans son champ (équivalent du clic sur son bouton).
  openCardSearch: async (docId, q) => {
    revealCardSearch(docId, q || '', true);
    if (state.currentDoc !== docId) await openDocPage(docId, 1);
    if (q && q.trim()) return runSearch(q.trim(), docId);
    return { total: 0, results: [] };
  },
  // État de la recherche pour l'auto-test (portée, puce, badge, champs).
  scopeInfo: () => JSON.stringify({
    scope: state.lastScope,
    chipPressed: $('chipAll').getAttribute('aria-pressed'),
    globalOpen: $('globalSearch').classList.contains('open'),
    badgeDoc: (() => { const el = document.querySelector('.doc-card.search-active'); return el ? el.dataset.doc : null; })(),
    cardFieldOpen: (() => { const el = document.querySelector('.card-search.open'); return el ? el.id : null; })(),
    hitCounter: $('hitCounter').textContent,
  }),
  openResult: (i) => openResult(i),
  goToPage: (n) => openDocPage(state.currentDoc, n),
  goToSection: (key) => {
    const doc = docMeta(state.currentDoc);
    const s = doc.sections.find((x) => String(x.key) === String(key));
    if (s) pinSection(state.currentDoc, s.key);
    return openDocPage(state.currentDoc, s ? s.startPage : 1);
  },
  goToDoc: async (id) => {
    const res = await openDocPage(id, 1);
    const doc = docMeta(id);
    return { ...res, sections: numberedSections(doc).length, ocrWarningVisible: !$('ocrBanner').hidden };
  },
  setMode: (m) => setViewMode(m).then(() => m),
  setZoom: (pct) => setZoom(pct),
  zoomInfo,
  nextPage: () => openDocPage(state.currentDoc, state.currentPage + 1),
  prevPage: () => openDocPage(state.currentDoc, state.currentPage - 1),
  nextResult: async () => {
    if (state.currentResult < state.results.length - 1) await openResult(state.currentResult + 1);
    return $('hitCounter').textContent;
  },
  prevResult: async () => {
    if (state.currentResult > 0) await openResult(state.currentResult - 1);
    return $('hitCounter').textContent;
  },
  centeringInfo,
  floatingNavInfo,
  layoutOverlapInfo,
  highlightInfo,
  // Navigation à deux niveaux (v1.2.1) : état réel des deux rangées de
  // puces, du menu et du titre, pour l'auto-test.
  sectionInfo: () => JSON.stringify({
    title: $('readerTitle').textContent,
    page: state.currentPage,
    effective: (() => { const d = docMeta(state.currentDoc); const s = d ? effectiveSection(d, state.currentPage) : null; return s ? String(s.key) : null; })(),
    chapterChips: [...document.querySelectorAll('#chapterChips .chip')].map((el) => el.dataset.section),
    subChips: [...document.querySelectorAll('#subChips .chip')].map((el) => el.dataset.section),
    activeChapter: (() => { const el = document.querySelector('#chapterChips .chip.active'); return el ? el.dataset.section : null; })(),
    activeSub: (() => { const el = document.querySelector('#subChips .chip.active'); return el ? el.dataset.section : null; })(),
    menu: [...document.querySelectorAll('#sectionsMenu button')].map((b) => ({ key: b.dataset.section, level: b.dataset.level })),
    menuActive: (() => { const el = document.querySelector('#sectionsMenu button.active'); return el ? el.dataset.section : null; })(),
  }),
  // Remplace les sections d'un document (auto-test : injecte un document
  // à chapitres construit à la main — le fixture-3p.pdf est plat).
  getSections: (docId) => JSON.stringify(docMeta(docId).sections),
  setSections: (docId, sections) => {
    const doc = docMeta(docId);
    doc.sections = sections;
    pinnedSection = null;
    buildSectionChips(docId);
    buildSectionsMenu(docId);
    updateReaderChrome();
    return sections.length;
  },
  nonBlankPixels: () => nonBlankPixels(),
  convert: (kind, value) => convertValue(kind, value),
  calc: (expr) => evaluateExpression(expr),
};
