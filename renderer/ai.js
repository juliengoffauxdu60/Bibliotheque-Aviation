// Zone « Poser une question » — Bibliothèque Aviation.
// Branchée par le PATCH D'INTÉGRATION (index.html) : section #aiAskSection +
// <script type="module" src="./ai.js"></script>.
// Fonctionnement :
//  1. la question est découpée en termes, retrouvés dans les index LOCAUX
//     par le moteur de recherche existant (renderer/ai-retrieve.js, qui
//     réutilise searchDocs) — même liste de documents que la recherche
//     (data/docs.json : fournis + importés) ;
//  2. le prompt (extraits + consignes : français, citations exactes,
//     jamais inventer, avertissement OCR 172N) est construit par
//     renderer/ai-providers.js ;
//  3. la demande part vers le fournisseur via le processus principal
//     (window.pohDesktop.ai.ask) : la clé ne traverse JAMAIS le rendu.
// Hors réseau : sans IA configurée, ou sans connexion (sauf IA locale), la
// question ne part pas et l'application l'explique. La recherche et le
// lecteur continuent de marcher hors réseau.
// Le module ne fait rien si les éléments du patch ne sont pas présents
// (chargement sans erreur), et signale si le préchargeur n'expose pas l'API IA.
import { retrieveContext } from 'app://renderer/ai-retrieve.js';

const $ = (id) => document.getElementById(id);

let indexesPromise = null;
let asking = false;

function loadIndexes() {
  if (!indexesPromise) {
    indexesPromise = (async () => {
      const [docsMeta, synonyms] = await Promise.all([
        fetch('app://data/docs.json').then((r) => r.json()),
        fetch('app://data/synonyms.json').then((r) => r.json()),
      ]);
      const indexes = await Promise.all(
        docsMeta.docs.map((d) => fetch('app://' + d.index).then((r) => r.json())),
      );
      const docs = docsMeta.docs.map((d, i) => indexes[i]);
      const meta = {};
      for (const d of docsMeta.docs) meta[d.id] = d;
      // Documents importés (registre userData/pohs) : même source que la
      // recherche (app.js loadData) — les questions couvrent aussi les POH
      // ajoutés par l'utilisateur.
      if (window.pohDesktop && window.pohDesktop.import) {
        const imported = await window.pohDesktop.import.list();
        for (const entry of imported) {
          const idx = await fetch('app://user-pohs/' + entry.doc_id + '/index.json').then((r) => r.json());
          docs.push(idx);
          meta[entry.doc_id] = entry.doc;
        }
      }
      return { docs, meta, synonyms };
    })();
  }
  return indexesPromise;
}

function aiApi() {
  return window.pohDesktop && window.pohDesktop.ai ? window.pohDesktop.ai : null;
}

function setStatus(text) {
  const el = $('aiAskStatus');
  if (el) el.textContent = text || '';
}

function showNotice(html) {
  const el = $('aiAnswer');
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<p>${html}</p>`;
  const src = $('aiSources');
  if (src) { src.hidden = true; src.innerHTML = ''; }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderAnswer(answer, pages) {
  const el = $('aiAnswer');
  if (!el) return;
  const paragraphs = String(answer).split(/\n\s*\n/).map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  el.hidden = false;
  el.innerHTML = paragraphs;
  const src = $('aiSources');
  if (src) {
    src.hidden = false;
    const canOpen = window.__poh
      && typeof window.__poh.goToDoc === 'function'
      && typeof window.__poh.goToPage === 'function';
    src.innerHTML = '<h3>Sources utilisées</h3>' + pages.map((p, i) => {
      const label = `${escapeHtml(p.docTitle)} — ${escapeHtml(p.sectionLabel)} — ${escapeHtml(p.pageLabel)}`;
      if (canOpen) {
        return `<button type="button" class="ai-source" data-i="${i}">${label} — ouvrir la page</button>`;
      }
      return `<span class="ai-source-text">${label}</span>`;
    }).join('');
    src.querySelectorAll('.ai-source').forEach((b) => {
      b.addEventListener('click', async (e) => {
        // currentTarget ne survit pas aux await (objet événement recyclé) :
        // on capture le bouton avant.
        const btn = e.currentTarget;
        const p = pages[Number(btn.dataset.i)];
        if (!p) return;
        await window.__poh.goToDoc(p.docId);
        await window.__poh.goToPage(p.page);
        btn.blur();
      });
    });
  }
}

async function askQuestion() {
  if (asking) return;
  const input = $('aiQuestion');
  const btn = $('aiAskBtn');
  const question = input ? input.value.trim() : '';
  if (!question) {
    setStatus('Écrivez d’abord votre question.');
    if (input) input.focus();
    return;
  }
  const api = aiApi();
  if (!api) {
    showNotice('La fonction IA n’est pas encore branchée dans cette application (le préchargeur ne l’expose pas). La recherche et le lecteur fonctionnent normalement.');
    return;
  }
  asking = true;
  if (btn) btn.disabled = true;
  try {
    setStatus('Vérification de la configuration IA…');
    const cfg = await api.getSettings();
    if (!cfg.ok) {
      showNotice('Impossible de lire la configuration IA. Réessayez.');
      return;
    }
    if (!cfg.settings.configured) {
      const notice = $('aiNotConfigured');
      if (notice) notice.hidden = false;
      setStatus('Aucune IA n’est configurée.');
      showNotice('Aucune IA n’est configurée. Configurez d’abord un fournisseur et une clé dans « Réglages IA », puis reposez votre question.');
      return;
    }
    const notice = $('aiNotConfigured');
    if (notice) notice.hidden = true;
    // Hors réseau : la question ne part pas (sauf IA locale, qui tourne sur
    // l'ordinateur même sans Internet).
    if (!navigator.onLine && cfg.settings.provider !== 'local') {
      setStatus('');
      showNotice('Pas de connexion Internet : la question ne peut pas partir vers le fournisseur. Vérifiez votre connexion et réessayez — la recherche et le lecteur fonctionnent toujours hors réseau.');
      return;
    }
    setStatus('Recherche des passages dans les POH…');
    const { docs, meta, synonyms } = await loadIndexes();
    const { pages } = retrieveContext(docs, meta, synonyms, question);
    if (pages.length === 0) {
      setStatus('');
      showNotice('Je n’ai trouvé aucun passage dans les POH pour cette question. Essayez avec d’autres mots (par exemple des mots du manuel : « décrochage », « fuel », « volets »).');
      return;
    }
    setStatus(`Envoi à l’IA (${pages.length} passage${pages.length > 1 ? 's' : ''} trouvé${pages.length > 1 ? 's' : ''} dans les POH)…`);
    const res = await api.ask({ question, context: pages });
    if (!res.ok) {
      setStatus('');
      showNotice(escapeHtml(res.error || 'La demande à l’IA a échoué.'));
      return;
    }
    setStatus('');
    renderAnswer(res.answer, pages);
  } catch (e) {
    setStatus('');
    showNotice('La demande à l’IA a échoué. Réessayez.');
  } finally {
    asking = false;
    if (btn) btn.disabled = false;
  }
}

function bind() {
  const askBtn = $('aiAskBtn');
  if (askBtn) askBtn.addEventListener('click', (e) => { askQuestion(); e.currentTarget.blur(); });
  const input = $('aiQuestion');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); askQuestion(); }
    });
  }
  const openSettings = () => {
    const api = aiApi();
    if (api) api.openSettings();
  };
  const headerBtn = $('aiSettingsBtn');
  if (headerBtn) headerBtn.addEventListener('click', (e) => { openSettings(); e.currentTarget.blur(); });
  const zoneBtn = $('aiOpenSettingsBtn1');
  if (zoneBtn) zoneBtn.addEventListener('click', (e) => { openSettings(); e.currentTarget.blur(); });
  // Si l'API IA est absente (patch préchargeur non appliqué), l'expliquer
  // dans la zone plutôt que de laisser des boutons muets.
  if (!aiApi()) {
    const notice = $('aiNotConfigured');
    if (notice) {
      notice.hidden = false;
      notice.textContent = 'La fonction IA n’est pas encore branchée dans cette application. La recherche et le lecteur fonctionnent normalement.';
    }
  }
}

bind();

// API pour les tests (auto-test IA) — état réel de la zone.
window.__pohAi = {
  ready: () => loadIndexes(),
  ask: (q) => {
    const input = $('aiQuestion');
    if (input) input.value = q;
    return askQuestion();
  },
  retrieve: async (q) => {
    const { docs, meta, synonyms } = await loadIndexes();
    return retrieveContext(docs, meta, synonyms, q);
  },
  answerText: () => {
    const el = $('aiAnswer');
    return el ? el.textContent : '';
  },
  sourcesCount: () => {
    const src = $('aiSources');
    return src ? src.querySelectorAll('.ai-source, .ai-source-text').length : 0;
  },
  statusText: () => {
    const el = $('aiAskStatus');
    return el ? el.textContent : '';
  },
  notConfiguredVisible: () => {
    const el = $('aiNotConfigured');
    return el ? !el.hidden : false;
  },
};
