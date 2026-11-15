// Logique de l'application — Bibliothèque Aviation.
// Charge les 4 PDF ENTIERS avec UNE seule instance pdf.js par document (pas de
// découpage en morceaux) : un changement de page ou de section ne fait que
// re-rendre le canevas à partir du document déjà chargé, jamais recharger.
import * as pdfjsLib from 'app://assets/pdfjs/pdf.mjs';
import { searchDocs } from 'app://renderer/search.js';
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
  ocrWordsCache: {}, // docId -> { pages: [...] } (boîtes OCR des fournis) ou false (absent)
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
  const [docsMeta, synonyms] = await Promise.all([
    fetch('app://data/docs.json').then((r) => r.json()),
    fetch('app://data/synonyms.json').then((r) => r.json()),
  ]);
  state.docsMeta = docsMeta;
  state.synonyms = synonyms;
  const indexes = await Promise.all(
    docsMeta.docs.map((d) => fetch('app://' + d.index).then((r) => r.json())),
  );
  docsMeta.docs.forEach((d, i) => { state.indexes[d.id] = indexes[i]; });
  // Documents fournis supprimés par l'utilisateur : retirés de la liste
  // AVANT tout le reste (cartes, recherche, portée) — ils ne sont ni
  // affichés, ni cherchés, ni chargés. Suppression définitive : aucune
  // restauration n'est proposée.
  if (window.pohDesktop && window.pohDesktop.import && window.pohDesktop.import.deletedList) {
    try {
      const deleted = await window.pohDesktop.import.deletedList();
      const deletedIds = new Set((deleted || []).map((h) => h.id));
      if (deletedIds.size) {
        docsMeta.docs = docsMeta.docs.filter((d) => !deletedIds.has(d.id));
        for (const id of deletedIds) delete state.indexes[id];
        const scope = document.getElementById('scopeSelect');
        if (scope) {
          for (const id of deletedIds) {
            const opt = scope.querySelector(`option[value="${id}"]`);
            if (opt) opt.remove();
          }
          if (scope.value && deletedIds.has(scope.value)) scope.value = 'all';
        }
      }
    } catch { /* liste des supprimés illisible : on garde les 4 fournis */ }
  }
  // Documents importés (registre userData/pohs) : même format que les index
  // fournis, chargés avec eux — c'est LA source unique de vérité pour la
  // recherche (ordre : les 4 fournis, puis les importés par date d'ajout).
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
  const section = sectionForPage(meta, state.currentPage);
  $('readerTitle').textContent =
    `${meta.title} — ${section.label} — Page ${state.currentPage} sur ${meta.totalPages}`;
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
  document.querySelectorAll('#sectionChips .chip').forEach((el) => {
    el.classList.toggle('active', el.dataset.section === String(section.key));
  });
}

async function openDocPage(docId, pageNum) {
  const meta = docMeta(docId);
  state.currentDoc = docId;
  state.currentPage = Math.min(Math.max(1, pageNum), meta.totalPages);
  buildSectionChips(docId);
  buildSectionsMenu(docId);
  updateReaderChrome(); // titre, bannière OCR, puces : à jour même si le rendu échoue
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
// changement d'index), puis les boîtes OCR (index de l'importé, ou
// fichier userData/ocr-words des fournis). Sans recherche active, rien.

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

// Boîtes OCR des documents fournis (172N) : chargées une fois par
// document via IPC, puis en cache (y compris l'absence de fichier).
async function ensureOcrWords(docId) {
  if (docId in state.ocrWordsCache) return state.ocrWordsCache[docId];
  let data = false;
  try {
    const api = window.pohDesktop && window.pohDesktop.import;
    if (api && api.getOcrWords) {
      const res = await api.getOcrWords(docId);
      if (res && res.ok && res.found && res.data) data = res.data;
    }
  } catch { /* pas de boîtes : le lecteur continue sans surlignage OCR */ }
  state.ocrWordsCache[docId] = data;
  return data;
}

// Boîtes OCR de la page courante : index de l'importé d'abord, sinon
// fichier userData/ocr-words du fourni. Retourne
// { imageWidth, imageHeight, words } ou null.
async function ocrWordsForPage(docId, pageNum) {
  const idx = state.indexes[docId];
  const entry = idx && idx.pages ? idx.pages[pageNum - 1] : null;
  if (entry && entry.ocr_words && Array.isArray(entry.ocr_words.words)) {
    return entry.ocr_words;
  }
  const meta = docMeta(docId);
  if (meta && meta.ocr && meta.pdf && meta.pdf.startsWith('assets/')) {
    const wordsDoc = await ensureOcrWords(docId);
    if (wordsDoc && Array.isArray(wordsDoc.pages)) {
      const pg = wordsDoc.pages.find((p) => p.page === pageNum);
      if (pg && Array.isArray(pg.words)) return pg;
    }
  }
  return null;
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
    }));
    rectsPdf = textRectsForTerm(items, term);
    // 2) PDF scanné : boîtes OCR (rien dans le texte réel).
    if (!rectsPdf.length) {
      const wordsPage = await ocrWordsForPage(state.currentDoc, state.currentPage);
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
function buildDocCards() {
  const wrap = $('docCards');
  wrap.innerHTML = '';
  for (const doc of state.docsMeta.docs) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'doc-card';
    b.dataset.doc = doc.id;
    b.innerHTML = `<span class="doc-name">${doc.title}</span><br>` +
      `<span class="doc-sub">${doc.subtitle}</span><br>` +
      `<span class="doc-pages">${doc.totalPages} pages</span>` +
      (doc.ocr ? `<br><span class="doc-ocr">Texte par OCR — lire les valeurs dans le PDF</span>` : '');
    b.addEventListener('click', (e) => { openDocPage(doc.id, 1); e.currentTarget.blur(); });
    wrap.appendChild(b);
  }
}

function buildSectionChips(docId) {
  const doc = docMeta(docId);
  const wrap = $('sectionChips');
  wrap.innerHTML = '';
  for (const s of numberedSections(doc)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.dataset.section = String(s.key);
    b.textContent = s.label;
    b.addEventListener('click', (e) => { openDocPage(docId, s.startPage); e.currentTarget.blur(); });
    wrap.appendChild(b);
  }
}

function buildSectionsMenu(docId) {
  const doc = docMeta(docId);
  const menu = $('sectionsMenu');
  menu.innerHTML = '';
  for (const s of doc.sections) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span>${s.label}</span><span class="pg">p. ${s.startPage}</span>`;
    b.addEventListener('click', (e) => {
      menu.hidden = true;
      $('sectionsMenuBtn').setAttribute('aria-expanded', 'false');
      openDocPage(docId, s.startPage);
      e.currentTarget.blur();
    });
    menu.appendChild(b);
  }
}

// ---------------------------------------------------------------------------
// Recherche
// ---------------------------------------------------------------------------
function orderedIndexes() {
  return state.docsMeta.docs.map((d) => state.indexes[d.id]);
}
function metaMap() {
  const m = {};
  for (const d of state.docsMeta.docs) m[d.id] = d;
  return m;
}

async function runSearch(query) {
  const scope = $('scopeSelect').value;
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
    ? `Aucun résultat pour « ${query} ».`
    : `${total} résultat${total > 1 ? 's' : ''} pour « ${query} »` +
      (terms.length > 1 ? ` (termes cherchés : ${terms.join(', ')})` : '') +
      (truncated ? ` — affichage limité aux ${results.length} premiers.` : '');
  $('searchStatus').textContent = status;
  renderResults();
  if (results.length) await openResult(0);
  else clearHighlights(); // sans résultat, aucun surlignage ne doit rester
  return { total, results };
}

function renderResults() {
  const list = $('resultsList');
  list.innerHTML = '';
  if (!state.results.length) {
    list.innerHTML = '<p class="results-empty">Aucun résultat. Essayez un autre mot, en français ou en anglais (ex. : décrochage, fuel, volets).</p>';
  }
  state.results.forEach((r, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'result-card' + (i === state.currentResult ? ' current' : '');
    b.dataset.index = String(i);
    const pageLabel = r.printedLabel ? `p. ${r.printedLabel}` : `page PDF ${r.page}`;
    const synNote = r.termFound !== state.lastQuery.trim().toLowerCase() &&
      r.termFound.toLowerCase() !== state.lastQuery.trim().toLowerCase()
      ? ` <span class="syn">(synonyme de « ${state.lastQuery.trim()} »)</span>` : '';
    b.innerHTML =
      `<span class="result-head"><span class="doc">${r.docTitle}</span><span class="page">${pageLabel}</span></span>` +
      `<span class="result-section">${r.sectionLabel}</span>` +
      `<span class="result-found">Trouvé : <span class="term">« ${r.termFound} »</span> — ${r.occurrences} occurrence${r.occurrences > 1 ? 's' : ''} sur cette page${synNote}</span>` +
      `<span class="result-excerpt">${r.excerptHtml}</span>`;
    b.addEventListener('click', (e) => { openResult(i); e.currentTarget.blur(); });
    list.appendChild(b);
  });
  updateResultCounter();
}

function updateResultCounter() {
  const n = state.lastTotal;
  $('resultCounter').textContent = n === 0
    ? 'Aucun résultat'
    : `Résultat ${state.currentResult + 1} sur ${n}`;
  $('prevResultBtn').disabled = state.currentResult <= 0;
  $('nextResultBtn').disabled = state.currentResult < 0 || state.currentResult >= n - 1;
}

async function openResult(i) {
  if (i < 0 || i >= state.results.length) return null;
  state.currentResult = i;
  const r = state.results[i];
  document.querySelectorAll('.result-card').forEach((el) => {
    el.classList.toggle('current', Number(el.dataset.index) === i);
  });
  const card = document.querySelector(`.result-card[data-index="${i}"]`);
  if (card) {
    // Défilement limité à la liste des résultats : la page elle-même ne bouge pas.
    const list = $('resultsList');
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    if (cardRect.top < listRect.top) list.scrollTop -= (listRect.top - cardRect.top);
    else if (cardRect.bottom > listRect.bottom) list.scrollTop += (cardRect.bottom - listRect.bottom);
  }
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
  $('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('searchInput').value.trim();
    if (q) runSearch(q);
  });
  $('prevResultBtn').addEventListener('click', (e) => {
    if (state.currentResult > 0) openResult(state.currentResult - 1);
    e.currentTarget.blur();
  });
  $('nextResultBtn').addEventListener('click', (e) => {
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
  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const q = e.target.value.trim(); if (q) runSearch(q); }
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
  updateReaderChromeSafe();
  // Document par défaut : le premier document visible (172N d'habitude ;
  // si l'utilisateur l'a supprimé, c'est le suivant). Aucun document :
  // le lecteur reste sur son message vide.
  const firstDoc = state.docsMeta.docs[0];
  if (firstDoc) await openDocPage(firstDoc.id, 1);
})();

// Chevauchement de la colonne de gauche sur les outils (auto-test) :
// la grille a une hauteur fixe ; si les cartes + puces de sections +
// navigation des résultats dépassent son bas, elles peignent par-dessus
// la section « Outils » qui suit. Le correctif (.left-col défilante)
// fait défiler la colonne dans la grille au lieu de déborder.
// Mesure : on compare les rects VISIBLES (intersection avec la boîte
// de la colonne — getBoundingClientRect seul ne distingue pas un contenu
// rogné par le défilement d'un contenu qui peint par-dessus les outils).
function layoutOverlapInfo() {
  const grid = document.querySelector('.grid');
  const leftCol = document.querySelector('.left-col');
  const sections = document.querySelector('.sections-block');
  const nav = document.querySelector('.results-nav');
  const tools = document.querySelector('section.tools');
  if (!grid || !leftCol || !sections || !nav || !tools) return JSON.stringify({ error: 'éléments introuvables' });
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
  const visNav = clips ? inter(r(nav), col) : r(nav);
  const info = {
    gridBottom: Math.round(r(grid).bottom),
    sectionsBottom: Math.round(r(sections).bottom),
    resultsNavBottom: Math.round(r(nav).bottom),
    leftColScrolls: leftCol.scrollHeight > leftCol.clientHeight + 1,
    overlap: hits(visSections, toolsH2) || hits(visNav, toolsH2),
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
  search: (q) => runSearch(q),
  openResult: (i) => openResult(i),
  goToPage: (n) => openDocPage(state.currentDoc, n),
  goToSection: (key) => {
    const doc = docMeta(state.currentDoc);
    const s = doc.sections.find((x) => String(x.key) === String(key));
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
    return $('resultCounter').textContent;
  },
  prevResult: async () => {
    if (state.currentResult > 0) await openResult(state.currentResult - 1);
    return $('resultCounter').textContent;
  },
  centeringInfo,
  floatingNavInfo,
  layoutOverlapInfo,
  highlightInfo,
  nonBlankPixels: () => nonBlankPixels(),
  convert: (kind, value) => convertValue(kind, value),
  calc: (expr) => evaluateExpression(expr),
};
