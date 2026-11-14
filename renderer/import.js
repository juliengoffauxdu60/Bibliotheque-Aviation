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
#hiddenBox { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--line); }
#hiddenBox .hidden-title { font-size: 12px; font-weight: 700; color: var(--muted); margin-bottom: 6px; }
#hiddenBox .hidden-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 13px; padding: 4px 0; }
#hiddenBox .hidden-row button { padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line); background: #fff; font-weight: 700; cursor: pointer; }
#hiddenBox .hidden-row button:hover { background: var(--blue-soft); }`;
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
    <div id="hiddenBox" hidden>
      <div class="hidden-title">Documents masqués</div>
      <div id="hiddenList"></div>
    </div>
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
// Importé : ✕ = supprimer le fichier (définitif). Fourni : ✕ = masquer
// (le fichier reste dans l'application, restorable depuis « Documents
// masqués » ci-dessous) — un élève qui n'a pas besoin du 172R ou du 150
// peut l'enlever sans perdre le document.
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
    del.title = isImported ? 'Supprimer ce document importé' : 'Masquer ce document';
    del.setAttribute('aria-label', `${isImported ? 'Supprimer' : 'Masquer'} ${title}`);
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (isImported) {
        const entry = state.imported.find((x) => x.doc_id === docId);
        onDeleteClick(entry || { doc_id: docId, title });
      } else {
        onHideClick(docId, title);
      }
    });
    card.appendChild(del);
  }
}

async function renderHiddenDocs() {
  const a = api();
  const box = $('hiddenBox');
  const list = $('hiddenList');
  if (!a || !a.hiddenList || !box || !list) return;
  let hidden = [];
  try { hidden = (await a.hiddenList()) || []; } catch { hidden = []; }
  list.innerHTML = '';
  box.hidden = hidden.length === 0;
  for (const h of hidden) {
    const row = document.createElement('div');
    row.className = 'hidden-row';
    const name = document.createElement('span');
    name.textContent = h.title;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Restaurer';
    btn.addEventListener('click', async (e) => {
      e.currentTarget.blur();
      try {
        const res = await a.unhideDoc(h.id);
        if (!res || !res.ok) { setStatus('Restauration impossible : ' + (res && res.error ? res.error : 'erreur inconnue'), 'error'); return; }
        setStatus(`« ${h.title} » restauré. Rechargement…`, 'ok');
        scheduleReload(800);
      } catch (err) { setStatus('Restauration impossible : ' + err.message, 'error'); }
    });
    row.appendChild(name);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

// Masquer un document fourni (avec confirmation) : il disparaît des
// cartes et de la recherche, mais reste dans l'application.
async function onHideClick(docId, title) {
  const a = api();
  if (!a) return;
  const ok = window.confirm(
    `Masquer « ${title} » ?\n\nLe document ne sera plus affiché ni cherché, mais il reste dans l’application : ` +
    'vous pourrez le restaurer depuis « Documents masqués » ci-dessous.',
  );
  if (!ok) return;
  setStatus('Masquage en cours…', '');
  try {
    const res = await a.hideDoc(docId);
    if (!res || !res.ok) {
      setStatus('Masquage impossible : ' + (res && res.error ? res.error : 'erreur inconnue'), 'error');
      return;
    }
    setStatus(`« ${title} » masqué. Rechargement…`, 'ok');
    scheduleReload(800);
  } catch (e) {
    setStatus('Masquage impossible : ' + e.message, 'error');
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
  await renderHiddenDocs();
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
      const res = await a.ocrPage(docId, p, pngBase64);
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
// Suppression d'un document importé (avec confirmation)
// ---------------------------------------------------------------------------
async function onDeleteClick(entry) {
  const a = api();
  if (!a) return;
  const ok = window.confirm(
    `Supprimer « ${entry.title} » ?\n\nLe PDF importé et son index seront supprimés du dossier de l’application. ` +
    'Les documents fournis ne sont jamais concernés.',
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
  deleteDoc: (docId) => onDeleteClick(
    state.imported.find((e) => e.doc_id === docId) || { doc_id: docId, title: docId }),
  hideDoc: (docId) => {
    const card = document.querySelector(`.doc-card[data-doc="${docId}"]`);
    const title = (card && card.querySelector('.doc-name') || {}).textContent || docId;
    return onHideClick(docId, title);
  },
  hiddenList: () => api() && api().hiddenList ? api().hiddenList() : Promise.resolve([]),
};
