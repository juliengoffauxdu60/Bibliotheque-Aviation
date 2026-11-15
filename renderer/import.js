// import.js — « Ajouter un document » + OCR intégré (rendu).
//
// CHARGÉ PAR renderer/index.html (patch d'intégration : 1 ligne).
// Ce module ne touche à AUCUNE fonction de app.js : il crée son propre
// bouton et ses propres panneaux dans le DOM, appelle l'API exposée par
// preload.cjs (window.pohDesktop.import) et recharge la page après un
// import / un OCR / une suppression — c'est au rechargement que le
// chargeur de app.js (patch d'intégration) reprend les documents importés
// avec les 4 fournis, dans la même recherche, les mêmes sections et le
// même lecteur.
//
// OCR : chaque page est rendue en image par pdf.js (déjà dans l'appli,
// échelle 2 ≈ 200 ppp), envoyée au processus principal page par page
// (tesseract.js fra+eng, 100 % local), avec barre de progression et
// annulation. Le PDF importé n'est jamais modifié ; l'index OCR est
// construit à partir du texte reconnu, au même format que les index fournis.
import * as pdfjsLib from 'app://assets/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://assets/pdfjs/pdf.worker.mjs';

const OCR_RENDER_SCALE = 2; // ~200 ppp sur une page lettre : bon compromis vitesse/qualité OCR.

const state = {
  imported: [], // entrées meta.json (registre userData/pohs)
  ocrCancelRequested: false,
  ocrRunning: false,
  pendingScannedDocId: null,
};

const $ = (id) => document.getElementById(id);
const api = () => (window.pohDesktop && window.pohDesktop.import) || null;

// ---------------------------------------------------------------------------
// Styles propres à l'import (injectés : styles.css n'est pas modifié)
// ---------------------------------------------------------------------------
function injectStyles() {
  if ($('importStyles')) return;
  const st = document.createElement('style');
  st.id = 'importStyles';
  st.textContent = `
#importBox { margin-top: 10px; }
#importAddBtn { width: 100%; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--blue); background: #fff; color: var(--blue-dark); font-weight: 700; }
#importAddBtn:hover { background: var(--blue-soft); }
#importAddBtn:disabled { opacity: .5; cursor: default; }
#importStatus { font-size: 13px; color: var(--muted); margin-top: 6px; min-height: 1.2em; }
#importStatus.error { color: #a33; font-weight: 600; }
#importStatus.ok { color: #1e6b34; font-weight: 600; }
#importWarning { margin-top: 8px; padding: 10px 12px; border: 1px solid #e8d27a; background: #fff3c4; border-radius: 8px; font-size: 13px; color: #5c4a00; }
#importWarning .warn-title { font-weight: 700; margin-bottom: 4px; }
#importWarning .warn-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
#importWarning button { padding: 7px 12px; border-radius: 8px; border: 1px solid #8a6d00; background: #fff; font-weight: 700; }
#importWarning button.primary { background: #8a6d00; color: #fff; }
#importProgress { margin-top: 8px; }
#importProgress .bar-wrap { height: 10px; background: #d5dde4; border-radius: 999px; overflow: hidden; }
#importProgress .bar { height: 100%; width: 0%; background: var(--blue); transition: width .2s; }
#importProgress .prog-label { font-size: 13px; color: var(--muted); margin-top: 4px; }
#importProgress .prog-actions { margin-top: 6px; }
#importProgress button { padding: 6px 12px; border-radius: 8px; border: 1px solid var(--line); background: #fff; }
.doc-card { position: relative; }
.doc-card .doc-delete { position: absolute; top: 4px; right: 6px; width: 22px; height: 22px; line-height: 20px; text-align: center; border-radius: 50%; border: 1px solid #d5dde4; background: #fff; color: #a33; font-size: 13px; font-weight: 700; cursor: pointer; padding: 0; }
.doc-card .doc-delete:hover { background: #fdecec; border-color: #a33; }
.doc-card .doc-imported { font-size: 11px; color: #1e6b34; }
#ocrBanner .reocr-btn { margin-left: 10px; padding: 4px 10px; border-radius: 8px; border: 1px solid #8a6d00; background: #fff; font-weight: 700; font-size: 12px; color: #5c4a00; }
#ocrBanner .reocr-btn:hover { background: #fff8e6; }`;
  document.head.appendChild(st);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------
function buildImportBox() {
  const docsBlock = document.querySelector('.docs-block');
  if (!docsBlock || $('importBox')) return;
  const box = document.createElement('div');
  box.id = 'importBox';
  box.innerHTML = `
    <button type="button" id="importAddBtn">＋ Ajouter un document</button>
    <div id="importStatus" aria-live="polite"></div>
    <div id="importWarning" hidden>
      <div class="warn-title">⚠ Ce PDF semble scanné (aucun texte).</div>
      <div id="importWarningText"></div>
      <div class="warn-actions">
        <button type="button" id="importOcrBtn" class="primary">Lancer l’OCR (français + anglais)</button>
        <button type="button" id="importLaterBtn">Plus tard</button>
      </div>
    </div>
    <div id="importProgress" hidden>
      <div class="bar-wrap"><div class="bar" id="importBar"></div></div>
      <div class="prog-label" id="importProgLabel"></div>
      <div class="prog-actions"><button type="button" id="importCancelBtn">Annuler l’OCR</button></div>
    </div>`;
  docsBlock.appendChild(box);
  $('importAddBtn').addEventListener('click', (e) => { onAddClick(); e.currentTarget.blur(); });
  $('importOcrBtn').addEventListener('click', (e) => { startOcr(state.pendingScannedDocId); e.currentTarget.blur(); });
  $('importLaterBtn').addEventListener('click', (e) => {
    $('importWarning').hidden = true;
    setStatus('Document ajouté : lisible dans le lecteur, mais non cherchable sans OCR. Relancez l’OCR depuis son avertissement en le rouvrant, ou supprimez-le puis réimportez-le.', '');
    e.currentTarget.blur();
  });
  $('importCancelBtn').addEventListener('click', (e) => { state.ocrCancelRequested = true; e.currentTarget.blur(); });
}

function setStatus(text, kind) {
  const el = $('importStatus');
  if (!el) return;
  el.textContent = text;
  el.className = kind || '';
}

// Rechargement après un import / OCR / suppression : c'est au rechargement
// que le chargeur reprend le document avec les 4 fournis. Crochet de test :
// window.__pohImportNoReload = true l'inhibe (auto-test E2E).
function scheduleReload(ms) {
  if (window.__pohImportNoReload) return;
  setTimeout(() => window.location.reload(), ms);
}

function showProgress(done, total, label) {
  const wrap = $('importProgress');
  if (!wrap) return;
  wrap.hidden = false;
  $('importBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
  $('importProgLabel').textContent = label || '';
}

function hideProgress() { const w = $('importProgress'); if (w) w.hidden = true; }

// ---------------------------------------------------------------------------
// Documents : options de portée + boutons ✕ sur TOUTES les cartes.
// ✕ = supprimer, définitivement : importé → le fichier est effacé ;
// fourni → son id est enregistré dans deleted-docs.json et il est filtré
// partout (ses PDF vivent dans le paquet, on ne peut pas les effacer).
function decorateImportedDocs() {
  const scope = $('scopeSelect');
  const importedIds = new Set(state.imported.map((e) => e.doc_id));
  for (const entry of state.imported) {
    const docId = entry.doc_id;
    if (scope && !scope.querySelector(`option[value="${docId}"]`)) {
      const opt = document.createElement('option');
      opt.value = docId;
      opt.textContent = `${entry.doc.short || entry.title} seulement`;
      scope.appendChild(opt);
    }
    const card = document.querySelector(`.doc-card[data-doc="${docId}"]`);
    if (card && !card.querySelector('.doc-delete')) {
      const sub = card.querySelector('.doc-sub');
      if (sub) sub.insertAdjacentHTML('afterend', ' <span class="doc-imported">· importé</span>');
    }
  }
  for (const card of document.querySelectorAll('.doc-card')) {
    if (card.querySelector('.doc-delete')) continue;
    const docId = card.dataset.doc;
    const title = (card.querySelector('.doc-name') || {}).textContent || docId;
    const isImported = importedIds.has(docId);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'doc-delete';
    del.title = 'Supprimer ce document';
    del.setAttribute('aria-label', `Supprimer ${title}`);
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (isImported) {
        const entry = state.imported.find((x) => x.doc_id === docId);
        onDeleteClick(entry || { doc_id: docId, title });
      } else {
        onDeleteClick({ doc_id: docId, title, bundled: true });
      }
    });
    card.appendChild(del);
  }
}

async function refreshImported() {
  const a = api();
  if (!a) return [];
  try {
    state.imported = (await a.list()) || [];
  } catch (e) {
    state.imported = [];
    setStatus('Impossible de lister les documents importés : ' + e.message, 'error');
  }
  decorateImportedDocs();
  return state.imported;
}

// ---------------------------------------------------------------------------
// Import d'un PDF
// ---------------------------------------------------------------------------
async function onAddClick() {
  const a = api();
  if (!a) {
    setStatus('Import indisponible : le patch d’intégration (preload / main.js) n’est pas installé.', 'error');
    return;
  }
  setStatus('');
  $('importWarning').hidden = true;
  let choice;
  try {
    choice = await a.chooseFile();
  } catch (e) {
    setStatus('Impossible d’ouvrir le sélecteur de fichier : ' + e.message, 'error');
    return;
  }
  if (!choice || choice.canceled || !choice.filePath) return; // annulé par l'utilisateur
  await importFilePath(choice.filePath);
}

async function importFilePath(filePath) {
  const a = api();
  setStatus('Import en cours : copie et extraction du texte…', '');
  $('importAddBtn').disabled = true;
  try {
    const res = await a.importFile(filePath);
    if (!res || !res.ok) {
      setStatus('Import impossible : ' + (res && res.error ? res.error : 'erreur inconnue'), 'error');
      return null;
    }
    await refreshImported();
    if (res.scanned) {
      // Le document est enregistré (PDF lisible), mais son index est vide :
      // la recherche ne marchera pas dessus sans OCR. On le dit clairement.
      state.pendingScannedDocId = res.doc_id;
      $('importWarningText').textContent =
        `Aucun texte n’a été trouvé dans ce PDF (médiane ${res.medianChars} caractères par page, ` +
        `sur ${res.totalPages} pages) : il s’agit probablement d’un document scanné. ` +
        `La recherche ne trouvera rien dans « ${res.title} » tant que l’OCR n’a pas été fait. ` +
        `L’OCR est intégré à l’application (français + anglais, 100 % local) : il prend quelques secondes par page.`;
      $('importWarning').hidden = false;
      setStatus(`« ${res.title} » ajouté (${res.totalPages} pages), sans texte. Lancez l’OCR ci-dessous pour le rendre cherchable.`, '');
      return res;
    }
    const sec = res.sectionDetection === 'none'
      ? 'aucune section détectée — le document forme une seule section'
      : `${res.sections.length - 1} section(s) détectée(s)`;
    setStatus(`« ${res.title} » ajouté : ${res.totalPages} pages, ${sec}. Rechargement…`, 'ok');
    scheduleReload(1200);
    return res;
  } catch (e) {
    setStatus('Import impossible : ' + e.message, 'error');
    return null;
  } finally {
    $('importAddBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// OCR d'un document importé (rendu page par page via pdf.js)
// ---------------------------------------------------------------------------
async function startOcr(docId) {
  const a = api();
  if (!a || !docId) return null;
  const entry = state.imported.find((e) => e.doc_id === docId);
  if (!entry) { setStatus('Document introuvable pour l’OCR : ' + docId, 'error'); return null; }
  if (state.ocrRunning) { setStatus('Un OCR est déjà en cours.', 'error'); return null; }
  state.ocrRunning = true;
  state.ocrCancelRequested = false;
  $('importWarning').hidden = true;
  $('importAddBtn').disabled = true;
  try {
    setStatus('OCR : chargement du PDF…', '');
    const pdf = await pdfjsLib.getDocument({
      url: 'app://' + entry.doc.pdf,
      disableRange: true,
      disableStream: true,
      isEvalSupported: false,
    }).promise;
    const total = pdf.numPages;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (let p = 1; p <= total; p++) {
      if (state.ocrCancelRequested) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`OCR annulé à la page ${p - 1} sur ${total}. Aucun index écrit : relancez l’OCR pour recommencer.`, 'error');
        return null;
      }
      showProgress(p - 1, total, `OCR — page ${p} sur ${total} (français + anglais, 100 % local)…`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
      // Dimensions du PNG envoyé : sans elles, les boîtes de mots OCR (en
      // pixels d'image) ne pourraient pas être replacées sur la page.
      const res = await a.ocrPage(docId, p, pngBase64, canvas.width, canvas.height);
      if (!res || !res.ok) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`OCR arrêté à la page ${p} sur ${total} : ` + (res && res.error ? res.error : 'erreur inconnue'), 'error');
        return null;
      }
      showProgress(p, total, `OCR — page ${p} sur ${total} (${res.chars} caractères reconnus)…`);
    }
    setStatus('OCR terminé : construction de l’index…', '');
    const done = await a.ocrFinish(docId);
    hideProgress();
    if (!done || !done.ok) {
      setStatus('OCR terminé mais index non enregistré : ' + (done && done.error ? done.error : 'erreur inconnue'), 'error');
      return null;
    }
    const sec = done.sectionDetection === 'none'
      ? 'aucune section détectée — le document forme une seule section'
      : `${done.sections.length - 1} section(s) détectée(s)`;
    setStatus(`OCR terminé pour « ${done.title} » (${done.totalPages} pages, ${sec}). Rechargement…`, 'ok');
    scheduleReload(1200);
    return done;
  } catch (e) {
    try { await a.ocrCancel(docId); } catch { /* déjà arrêté */ }
    hideProgress();
    setStatus('OCR impossible : ' + e.message, 'error');
    return null;
  } finally {
    state.ocrRunning = false;
    $('importAddBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Refaire l'OCR (avec surlignage) — bouton dans la bannière OCR du lecteur
// ---------------------------------------------------------------------------
// La bannière ne s'affiche que pour les documents OCR (172N fourni, imports
// OCR) : le bouton est dedans, il apparaît et disparaît avec elle.
//   - Document importé : relance startOcr — l'index est écrasé avec texte
//     + boîtes de mots (même chemin que l'OCR initial).
//   - Document fourni (172N) : même boucle, mais les boîtes vont dans
//     userData/ocr-words/<doc_id>.json — l'index fourni n'est jamais touché.
function addReocrButton() {
  const banner = $('ocrBanner');
  if (!banner || $('reocrBtn')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.id = 'reocrBtn';
  btn.className = 'reocr-btn';
  btn.textContent = 'Refaire l’OCR (avec surlignage)';
  btn.title = 'Refait la reconnaissance du texte et enregistre la position de chaque mot, pour surligner les résultats dans le lecteur.';
  btn.addEventListener('click', (e) => { onReocrClick(); e.currentTarget.blur(); });
  banner.appendChild(btn);
}

async function onReocrClick() {
  const a = api();
  if (!a) return;
  const card = document.querySelector('.doc-card.active');
  const docId = card && card.dataset.doc;
  if (!docId) { setStatus('Aucun document ouvert pour refaire l’OCR.', 'error'); return; }
  if (state.ocrRunning) { setStatus('Un OCR est déjà en cours.', 'error'); return; }
  const entry = state.imported.find((e) => e.doc_id === docId);
  if (entry) { await startOcr(docId); return; }
  let docs;
  try {
    docs = await fetch('app://data/docs.json').then((r) => r.json());
  } catch (e) {
    setStatus('Impossible de retrouver ce document : ' + e.message, 'error');
    return;
  }
  const doc = (docs.docs || []).find((d) => d.id === docId);
  if (!doc) { setStatus('Document fourni introuvable : ' + docId, 'error'); return; }
  await startReocrWords(docId, doc.pdf, doc.totalPages, doc.title);
}

// Re-OCR d'un document fourni : même boucle de rendu page par page que
// startOcr, mais les pages partent sur poh-import:ocr-words-page et le
// résultat est enregistré dans userData/ocr-words/<doc_id>.json.
async function startReocrWords(docId, pdfRelPath, totalPages, title) {
  const a = api();
  if (!a || !docId) return null;
  if (state.ocrRunning) { setStatus('Un OCR est déjà en cours.', 'error'); return null; }
  state.ocrRunning = true;
  state.ocrCancelRequested = false;
  $('importWarning').hidden = true;
  $('importAddBtn').disabled = true;
  try {
    setStatus('Re-OCR : chargement du PDF…', '');
    const pdf = await pdfjsLib.getDocument({
      url: 'app://' + pdfRelPath,
      disableRange: true,
      disableStream: true,
      isEvalSupported: false,
    }).promise;
    const total = pdf.numPages;
    if (total !== totalPages) {
      setStatus(`Re-OCR impossible : ce document a ${total} pages, ${totalPages} attendues.`, 'error');
      return null;
    }
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    for (let p = 1; p <= total; p++) {
      if (state.ocrCancelRequested) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`Re-OCR annulé à la page ${p - 1} sur ${total}. Aucune boîte enregistrée : relancez pour recommencer.`, 'error');
        return null;
      }
      showProgress(p - 1, total, `Re-OCR — page ${p} sur ${total} (français + anglais, 100 % local)…`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
      const res = await a.ocrWordsPage(docId, p, pngBase64, canvas.width, canvas.height);
      if (!res || !res.ok) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`Re-OCR arrêté à la page ${p} sur ${total} : ` + (res && res.error ? res.error : 'erreur inconnue'), 'error');
        return null;
      }
      showProgress(p, total, `Re-OCR — page ${p} sur ${total} (${res.chars} caractères, ${res.words} mots repérés)…`);
    }
    setStatus('Re-OCR terminé : enregistrement des boîtes…', '');
    const done = await a.ocrWordsFinish(docId, total);
    hideProgress();
    if (!done || !done.ok) {
      setStatus('Re-OCR terminé mais boîtes non enregistrées : ' + (done && done.error ? done.error : 'erreur inconnue'), 'error');
      return null;
    }
    setStatus(`Re-OCR terminé pour « ${title || docId} » (${done.totalPages} pages, ${done.wordsTotal} mots repérés). Rechargement…`, 'ok');
    scheduleReload(1200);
    return done;
  } catch (e) {
    try { await a.ocrCancel(docId); } catch { /* déjà arrêté */ }
    hideProgress();
    setStatus('Re-OCR impossible : ' + e.message, 'error');
    return null;
  } finally {
    state.ocrRunning = false;
    $('importAddBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Suppression d'un document (avec confirmation) — un seul chemin pour les
// deux sortes : importé → le fichier est effacé ; fourni (entry.bundled) →
// l'id est enregistré dans deleted-docs.json (suppression définitive).
// ---------------------------------------------------------------------------
async function onDeleteClick(entry) {
  const a = api();
  if (!a) return;
  const bundled = !!entry.bundled;
  const ok = window.confirm(
    bundled
      ? `Supprimer « ${entry.title} » ?\n\nIl disparaîtra de la liste et de la recherche, définitivement.`
      : `Supprimer « ${entry.title} » ?\n\nLe PDF et sa recherche seront supprimés de l’application, définitivement. ` +
        'Les documents fournis (172N, 172R, 150, SOP) ne sont pas touchés.',
  );
  if (!ok) return;
  setStatus('Suppression en cours…', '');
  try {
    const res = await a.deleteDoc(entry.doc_id);
    if (!res || !res.ok) {
      setStatus('Suppression impossible : ' + (res && res.error ? res.error : 'erreur inconnue'), 'error');
      return;
    }
    setStatus(`« ${entry.title} » supprimé. Rechargement…`, 'ok');
    scheduleReload(800);
  } catch (e) {
    setStatus('Suppression impossible : ' + e.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------------------
async function init() {
  injectStyles();
  buildImportBox();
  addReocrButton();
  await refreshImported();
}

const ready = (async () => {
  // app.js expose window.__poh.ready() ; on attend le chargement des données
  // (les cartes documents doivent exister avant d'y ajouter les ✕).
  try {
    if (window.__poh && typeof window.__poh.ready === 'function') await window.__poh.ready();
    else await new Promise((r) => setTimeout(r, 1500));
  } catch { /* on initialise quand même */ }
  await init();
})();

// API pour l'auto-test / le débogage (même convention que window.__poh).
window.__pohImport = {
  ready: () => ready,
  state: () => ({
    imported: state.imported.map((e) => e.doc_id),
    ocrRunning: state.ocrRunning,
    hasApi: !!api(),
  }),
  list: () => refreshImported(),
  importFile: (filePath) => importFilePath(filePath),
  startOcr: (docId) => startOcr(docId),
  reocr: () => onReocrClick(),
  startReocrWords: (docId, pdfRelPath, totalPages, title) => startReocrWords(docId, pdfRelPath, totalPages, title),
  deleteDoc: (docId) => {
    const entry = state.imported.find((e) => e.doc_id === docId);
    if (entry) return onDeleteClick(entry);
    const card = document.querySelector(`.doc-card[data-doc="${docId}"]`);
    const title = (card && card.querySelector('.doc-name') || {}).textContent || docId;
    return onDeleteClick({ doc_id: docId, title, bundled: true });
  },
  deletedList: () => api() && api().deletedList ? api().deletedList() : Promise.resolve([]),
};
