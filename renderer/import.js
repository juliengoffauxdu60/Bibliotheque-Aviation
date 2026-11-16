// import.js — « Ajouter un document » + OCR intégré (rendu).
//
// CHARGÉ PAR renderer/index.html (patch d'intégration : 1 ligne).
// Ce module ne touche à AUCUNE fonction de app.js : il crée son propre
// bouton et ses propres panneaux dans le DOM, appelle l'API exposée par
// preload.cjs (window.pohDesktop.import) et recharge la page après un
// import / un OCR / une suppression — c'est au rechargement que le
// chargeur de app.js (patch d'intégration) reprend les documents importés
// dans la même recherche, les mêmes sections et le même lecteur.
// (v1.2.0 : plus aucun document fourni, les importés sont les seuls
// documents de l'application.)
//
// OCR : chaque page est rendue en image par pdf.js (déjà dans l'appli,
// échelle 2 ≈ 200 ppp), envoyée au processus principal page par page
// (tesseract.js fra+eng, 100 % local), avec barre de progression et
// annulation. Le PDF importé n'est jamais modifié ; l'index OCR est
// construit à partir du texte reconnu, au même format que les anciens
// index fournis.
import * as pdfjsLib from 'app://assets/pdfjs/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = 'app://assets/pdfjs/pdf.worker.mjs';

const OCR_RENDER_SCALE = 2; // ~200 ppp sur une page lettre : bon compromis vitesse/qualité OCR.

// Une page rendue BLANCHE donne un PNG minuscule — mais on ne juge pas
// sur la taille du PNG (trop variable) : on compte l'encre sur un aperçu
// réduit. 5 pages vides d'affilée = le lecteur ne lit pas les images.
const BLANK_STREAK_MAX = 5;

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
.doc-card .doc-ocr-btn { display: block; margin-top: 6px; padding: 6px 10px; border-radius: 8px; border: 1px solid #8a6d00; background: #fff3c4; color: #5c4a00; font-weight: 700; font-size: 12px; cursor: pointer; }
.doc-card .doc-ocr-btn:hover { background: #ffe98a; }
.doc-card .doc-delete { position: absolute; top: 4px; right: 6px; width: 22px; height: 22px; line-height: 20px; text-align: center; border-radius: 50%; border: 1px solid #d5dde4; background: #fff; color: #a33; font-size: 13px; font-weight: 700; cursor: pointer; padding: 0; }
.doc-card .doc-delete:hover { background: #fdecec; border-color: #a33; }`;
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
        <button type="button" id="importOcrBtn" class="primary">Rendre le document cherchable</button>
        <button type="button" id="importLaterBtn">Plus tard</button>
      </div>
    </div>
    <div id="importProgress" hidden>
      <div class="bar-wrap"><div class="bar" id="importBar"></div></div>
      <div class="prog-label" id="importProgLabel"></div>
      <div class="prog-actions"><button type="button" id="importCancelBtn">Annuler la lecture du texte</button></div>
    </div>`;
  docsBlock.appendChild(box);
  $('importAddBtn').addEventListener('click', (e) => { onAddClick(); e.currentTarget.blur(); });
  $('importOcrBtn').addEventListener('click', (e) => { startOcr(state.pendingScannedDocId); e.currentTarget.blur(); });
  $('importLaterBtn').addEventListener('click', (e) => {
    $('importWarning').hidden = true;
    setStatus('Document ajouté : vous pouvez le lire dans le lecteur, mais la recherche ne trouvera rien dedans pour l’instant.', '');
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
// que le chargeur reprend le document. Crochet de test :
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
// Documents : boutons ✕ sur TOUTES les cartes.
// ✕ = supprimer, définitivement : le fichier est effacé (v1.2.0 : tous
// les documents sont des importés, il n'y a plus de documents fournis).
function decorateImportedDocs() {
  for (const card of document.querySelectorAll('.doc-card')) {
    if (card.querySelector('.doc-delete')) continue;
    const docId = card.dataset.doc;
    const title = (card.querySelector('.doc-name') || {}).textContent || docId;
    const entry = state.imported.find((x) => x.doc_id === docId);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'doc-delete';
    del.title = 'Supprimer ce document';
    del.setAttribute('aria-label', `Supprimer ${title}`);
    del.textContent = '✕';
    del.addEventListener('click', (e) => {
      e.stopPropagation(); e.preventDefault();
      onDeleteClick(entry || { doc_id: docId, title });
    });
    card.appendChild(del);
    // v1.2.2 : document sans texte -> bouton de reprise direct sur la carte
    // (lecture annulée, ou ratée avant le correctif WASM — pas besoin de
    // réimporter, la lecture repart du PDF déjà stocké).
    if (needsTextReading(entry)) {
      const ocrBtn = document.createElement('button');
      ocrBtn.type = 'button';
      ocrBtn.className = 'doc-ocr-btn';
      ocrBtn.title = 'Lire le texte des pages pour rendre ce document cherchable';
      ocrBtn.textContent = 'Rendre cherchable';
      ocrBtn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        startOcr(docId);
      });
      card.appendChild(ocrBtn);
    }
  }
}

// Un document a besoin de sa lecture du texte : scanné, jamais lu
// (source 'import', pas 'ocr'). C'est le cas du 172N importé en v1.2.1
// dont la lecture a tourné à vide (pages blanches, décodeur WASM absent)
// : il doit pouvoir être relu SANS réimportation.
function needsTextReading(entry) {
  if (!entry || entry.scanned !== true) return false;
  if (entry.source === 'ocr') return false;
  if (entry.doc && entry.doc.ocr) return false;
  return true;
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
      // la recherche ne marchera pas dessus sans lecture du texte.
      // v1.2.2 : la lecture DÉMARRE TOUTE SEULE (avant, il fallait cliquer
      // sur le bouton — le document restait silencieusement vide si on
      // l'oubliait). Annulable à tout moment (bouton sous la progression) ;
      // la reprise reste possible depuis la carte du document.
      state.pendingScannedDocId = res.doc_id;
      setStatus(`« ${res.title} » ajouté (${res.totalPages} pages), sans texte. ` +
        (window.__pohImportNoAutoOcr
          ? 'Lancez la lecture du texte depuis sa carte pour le rendre cherchable.'
          : 'Lecture du texte lancée automatiquement…'), '');
      if (!window.__pohImportNoAutoOcr) startOcr(res.doc_id);
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

// Page rendue vide ? Aperçu réduit (110×170) : une page avec du texte a
// toujours des pixels sombres ; une page blanche n'en a aucun. Bon marché
// (un getImageData sur ~18 700 pixels) et indépendant de la compression PNG.
const blankProbe = document.createElement('canvas');
function pageLooksBlank(canvas) {
  const w = 110, h = 170;
  blankProbe.width = w; blankProbe.height = h;
  const bctx = blankProbe.getContext('2d');
  bctx.drawImage(canvas, 0, 0, w, h);
  const d = bctx.getImageData(0, 0, w, h).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return false;
  return true;
}

// ---------------------------------------------------------------------------
// OCR d'un document importé (rendu page par page via pdf.js)
// ---------------------------------------------------------------------------
async function startOcr(docId) {
  const a = api();
  if (!a || !docId) return null;
  const entry = state.imported.find((e) => e.doc_id === docId);
  if (!entry) { setStatus('Document introuvable pour la lecture du texte : ' + docId, 'error'); return null; }
  if (state.ocrRunning) { setStatus('Une lecture du texte est déjà en cours.', 'error'); return null; }
  state.ocrRunning = true;
  state.ocrCancelRequested = false;
  $('importWarning').hidden = true;
  $('importAddBtn').disabled = true;
  try {
    setStatus('Lecture du texte : chargement du document…', '');
    const pdf = await pdfjsLib.getDocument({
      url: 'app://' + entry.doc.pdf,
      disableRange: true,
      disableStream: true,
      isEvalSupported: false,
      // v1.2.2 : voir renderer/app.js — sans wasmUrl, les images CCITT
      // (JBIG2) et JPEG2000 ne se décodent pas et les pages rendent blanches.
      wasmUrl: 'app://assets/pdfjs/wasm/',
    }).promise;
    const total = pdf.numPages;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let blankStreak = 0;
    for (let p = 1; p <= total; p++) {
      if (state.ocrCancelRequested) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`Lecture du texte annulée à la page ${p - 1} sur ${total}. Rien n’a été enregistré : lancez de nouveau la lecture du texte pour recommencer.`, 'error');
        return null;
      }
      showProgress(p - 1, total, `Lecture du texte — page ${p} sur ${total} (français + anglais, 100 % local)…`);
      const page = await pdf.getPage(p);
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      // Garde anti-pages-vides (v1.2.2, 172N) : si le rendu sort des pages
      // blanches, la reconnaissance rend 0 caractère en quelques centièmes
      // de seconde par page et la boucle tourne 242 pages « à vide » avant
      // d'échouer. On s'arrête avec un message clair au lieu de laisser
      // croire que la lecture a eu lieu.
      if (pageLooksBlank(canvas)) {
        blankStreak++;
        if (blankStreak >= BLANK_STREAK_MAX) {
          await a.ocrCancel(docId).catch(() => {});
          hideProgress();
          setStatus(`Lecture du texte arrêtée à la page ${p} sur ${total} : les pages rendues sont vides — les images de ce PDF ne peuvent pas être lues. Le document reste affichable, mais la recherche restera vide pour lui.`, 'error');
          return null;
        }
      } else {
        blankStreak = 0;
      }
      const pngBase64 = canvas.toDataURL('image/png').split(',')[1];
      // Dimensions du PNG envoyé : sans elles, les boîtes de mots OCR (en
      // pixels d'image) ne pourraient pas être replacées sur la page.
      const res = await a.ocrPage(docId, p, pngBase64, canvas.width, canvas.height);
      if (!res || !res.ok) {
        await a.ocrCancel(docId).catch(() => {});
        hideProgress();
        setStatus(`Lecture du texte arrêtée à la page ${p} sur ${total} : ` + (res && res.error ? res.error : 'erreur inconnue'), 'error');
        return null;
      }
      showProgress(p, total, `Lecture du texte — page ${p} sur ${total} (${res.chars} caractères lus)…`);
    }
    setStatus('Lecture du texte terminée : enregistrement du document…', '');
    const done = await a.ocrFinish(docId);
    hideProgress();
    if (!done || !done.ok) {
      setStatus('Lecture du texte terminée mais document non enregistré : ' + (done && done.error ? done.error : 'erreur inconnue'), 'error');
      return null;
    }
    const sec = done.sectionDetection === 'none'
      ? 'aucune section détectée — le document forme une seule section'
      : `${done.sections.length - 1} section(s) détectée(s)`;
    setStatus(`Lecture du texte terminée pour « ${done.title} » (${done.totalPages} pages, ${sec}). Rechargement…`, 'ok');
    scheduleReload(1200);
    return done;
  } catch (e) {
    try { await a.ocrCancel(docId); } catch { /* déjà arrêté */ }
    hideProgress();
    setStatus('Lecture du texte impossible : ' + e.message, 'error');
    return null;
  } finally {
    state.ocrRunning = false;
    $('importAddBtn').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Suppression d'un document (avec confirmation) — supprimer = effacer le
// fichier, définitivement (v1.2.0 : tous les documents sont des importés).
// ---------------------------------------------------------------------------
async function onDeleteClick(entry) {
  const a = api();
  if (!a) return;
  const ok = window.confirm(
    `Supprimer « ${entry.title} » ?\n\nLe PDF et sa recherche seront supprimés de l’application, définitivement.`,
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
  // Reprise au démarrage (v1.2.2) : un document déjà importé mais sans
  // texte (lecture annulée, ou ratée avant le correctif WASM) propose de
  // nouveau sa lecture — sans réimportation. Le bouton reste aussi sur sa
  // carte (« Rendre cherchable »).
  const pending = state.imported.find(needsTextReading);
  if (pending) {
    state.pendingScannedDocId = pending.doc_id;
    $('importWarningText').textContent =
      `« ${pending.title} » n’a pas de texte : il s’agit probablement d’un document scanné. ` +
      `La recherche ne trouvera rien dedans tant que le texte n’a pas été lu. ` +
      `La lecture du texte est intégrée à l’application (français + anglais, 100 % locale) : elle prend quelques secondes par page.`;
    $('importWarning').hidden = false;
    setStatus(`« ${pending.title} » est sans texte : lancez sa lecture du texte pour le rendre cherchable.`, '');
  }
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
  needsTextReading: (docId) => {
    const entry = state.imported.find((e) => e.doc_id === docId);
    return needsTextReading(entry);
  },
  deleteDoc: (docId) => {
    const entry = state.imported.find((e) => e.doc_id === docId);
    if (entry) return onDeleteClick(entry);
    const card = document.querySelector(`.doc-card[data-doc="${docId}"]`);
    const title = (card && card.querySelector('.doc-name') || {}).textContent || docId;
    return onDeleteClick({ doc_id: docId, title });
  },
};
