// Page « Réglages IA » — logique.
// Parle uniquement au processus principal via window.pohDesktop.ai (patch
// préchargeur) : la clé en clair ne sort jamais de cette page vers le
// rendu principal, et n'est jamais affichée — seul « •••• + 4 derniers
// caractères » est montré.
const $ = (id) => document.getElementById(id);

let providers = [];
let current = null;
let testing = false;

// Délais (le test réseau côté principal est borné à 20 s — voir
// main-ai.js — donc 45 s côté rendu laisse une marge sans jamais laisser
// « Test en cours… » figé si le processus principal ne répond pas, par
// exemple quand l'invite du trousseau macOS bloque le déchiffrement de
// la clé derrière la fenêtre ; Electron lui-même rejette un appel IPC
// sans réponse au bout de 30 s — « reply was never sent », prouvé par
// reproduction — et ce rejet est traduit ci-dessous en message clair).
const TEST_TIMEOUT_MS = 45000;
const SAVE_TIMEOUT_MS = 30000;
const LOAD_TIMEOUT_MS = 15000;
const API_ABSENT_MESSAGE = 'La fonction IA n’est pas branchée dans cette application (le préchargeur ne l’expose pas).';
const TEST_TIMEOUT_MESSAGE = 'Le test n’a pas répondu à temps. Si une fenêtre du trousseau (macOS) est apparue derrière l’application, autorisez-la puis réessayez. Sinon, vérifiez votre connexion et réessayez.';
const SAVE_TIMEOUT_MESSAGE = 'L’enregistrement n’a pas répondu à temps. Réessayez.';
const CLEAR_TIMEOUT_MESSAGE = 'La suppression de la clé n’a pas répondu à temps. Réessayez.';

// Une promesse IPC qui ne répond jamais (processus principal bloqué,
// canal absent) ne doit JAMAIS laisser la page muette : au bout du délai,
// on rejette avec un message clair. L'erreur porte .isTimeout : les
// autres rejets (erreur IPC technique, par exemple) sont traduits en
// message simple côté appelant, jamais affichés tels quels.
function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      const e = new Error(message);
      e.isTimeout = true;
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Electron rejette un appel IPC sans réponse au bout de 30 s avec
// « reply was never sent » (processus principal bloqué — typiquement
// l'invite du trousseau macOS pendant le déchiffrement) : c'est un
// dépassement de délai, pas une erreur technique à afficher telle quelle.
function isNoReply(err) {
  return Boolean(err && /reply was never sent/i.test(err.message || ''));
}

function aiApi() {
  return window.pohDesktop && window.pohDesktop.ai ? window.pohDesktop.ai : null;
}

function setStatus(text, isError) {
  const el = $('aiSettingsStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ai-error', Boolean(isError));
}

function providerById(id) {
  return providers.find((p) => p.id === id);
}

function fillProviderDefaults(id, { force = false } = {}) {
  const def = providerById(id);
  if (!def) return;
  // Valeurs propres à CE fournisseur : celles qu'il a enregistrées, sinon
  // ses défauts. On ne remplit que si le champ est vide, ou quand
  // l'utilisateur vient de changer de fournisseur (force) : on n'écrase pas
  // une valeur qu'il a tapée lui-même en rechargeant la page.
  if (force || !$('aiModel').value.trim()) $('aiModel').value = def.model || def.defaultModel;
  if (force || !$('aiEndpoint').value.trim()) $('aiEndpoint').value = def.endpoint || def.defaultEndpoint;
  $('aiProviderHelp').textContent = def.keyHelp;
  $('aiKey').disabled = false;
  $('aiKey').placeholder = def.needsKey
    ? 'Collez votre clé ici'
    : 'Clé facultative (laisser vide pour une IA locale sans clé)';
  // L'état de la clé affiché est celui DE CE fournisseur : changer de
  // fournisseur ne montre jamais la clé d'un autre.
  $('aiKeyState').textContent = def.hasKey
    ? `Clé enregistrée : ${def.maskedKey} — laissez le champ vide pour la garder.`
    : 'Aucune clé enregistrée.';
}

async function refresh() {
  const api = aiApi();
  if (!api) {
    setStatus(API_ABSENT_MESSAGE, true);
    return;
  }
  let res;
  try {
    res = await withTimeout(api.getSettings(), LOAD_TIMEOUT_MS, 'Impossible de lire les réglages IA.');
  } catch (e) {
    setStatus('Impossible de lire les réglages IA.', true);
    return;
  }
  if (!res || !res.ok) {
    setStatus((res && res.error) || 'Impossible de lire les réglages IA.', true);
    return;
  }
  current = res.settings;
  providers = res.settings.providers || [];
  const select = $('aiProvider');
  select.innerHTML = '';
  for (const p of providers) {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.label;
    select.appendChild(o);
  }
  select.value = current.provider || 'gemini';
  $('aiModel').value = current.model || '';
  $('aiEndpoint').value = current.endpoint || '';
  fillProviderDefaults(select.value);
  $('aiKey').value = '';
  // L'état de la clé est affiché par fillProviderDefaults (celui du
  // fournisseur sélectionné).
  const note = $('aiEncryptionNote');
  if (!current.encryptionAvailable) {
    note.hidden = false;
    note.textContent = 'Sur cet ordinateur, le chiffrement du système n’est pas disponible : la clé est enregistrée dans un fichier de l’application, sur votre ordinateur uniquement.';
  } else {
    note.hidden = true;
    note.textContent = '';
  }
}

function bind() {
  $('aiProvider').addEventListener('change', (e) => {
    fillProviderDefaults(e.target.value, { force: true });
  });
  $('aiSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const api = aiApi();
    if (!api) {
      setStatus(API_ABSENT_MESSAGE, true);
      return;
    }
    setStatus('Enregistrement…');
    let res;
    try {
      res = await withTimeout(api.saveSettings({
        provider: $('aiProvider').value,
        model: $('aiModel').value.trim(),
        endpoint: $('aiEndpoint').value.trim(),
        key: $('aiKey').value.trim(),
      }), SAVE_TIMEOUT_MS, SAVE_TIMEOUT_MESSAGE);
    } catch (err) {
      setStatus((err && (err.isTimeout || isNoReply(err))) ? SAVE_TIMEOUT_MESSAGE : 'Enregistrement impossible.', true);
      return;
    }
    if (!res || !res.ok) {
      setStatus((res && res.error) || 'Enregistrement impossible.', true);
      return;
    }
    current = res.settings;
    providers = res.settings.providers || [];
    $('aiKey').value = '';
    $('aiKeyState').textContent = current.hasKey
      ? `Clé enregistrée : ${current.maskedKey} — laissez le champ vide pour la garder.`
      : 'Aucune clé enregistrée.';
    setStatus('Réglages enregistrés.');
  });
  $('aiTestBtn').addEventListener('click', async (e) => {
    // Le bouton est capturé AVANT toute attente : après un await,
    // e.currentTarget vaut null (événement recyclé) et .blur() levait une
    // erreur non rattrapée après chaque test réussi.
    const btn = e.currentTarget;
    const api = aiApi();
    if (!api) {
      setStatus(API_ABSENT_MESSAGE, true);
      return;
    }
    if (testing) return;
    testing = true;
    if (btn) btn.disabled = true;
    try {
      setStatus('Test en cours…');
      let res;
      try {
        res = await withTimeout(api.test(), TEST_TIMEOUT_MS, TEST_TIMEOUT_MESSAGE);
      } catch (err) {
        setStatus((err && (err.isTimeout || isNoReply(err))) ? TEST_TIMEOUT_MESSAGE : 'Le test a échoué. Réessayez.', true);
        return;
      }
      if (!res || !res.ok) {
        setStatus((res && res.error) || 'Le test a échoué.', true);
        return;
      }
      setStatus(`Connexion OK : le fournisseur a répondu « ${res.answer} ».`);
    } finally {
      testing = false;
      if (btn) btn.disabled = false;
      if (btn) btn.blur();
    }
  });
  $('aiClearKeyBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const api = aiApi();
    if (!api) {
      setStatus(API_ABSENT_MESSAGE, true);
      return;
    }
    if (!current || !current.hasKey) {
      setStatus('Aucune clé à effacer.');
      return;
    }
    if (!window.confirm('Effacer la clé API enregistrée ? Il faudra la saisir de nouveau pour utiliser l’IA.')) return;
    let res;
    try {
      res = await withTimeout(api.clearKey(), SAVE_TIMEOUT_MS, CLEAR_TIMEOUT_MESSAGE);
    } catch (err) {
      setStatus((err && (err.isTimeout || isNoReply(err))) ? CLEAR_TIMEOUT_MESSAGE : 'Impossible d’effacer la clé.', true);
      return;
    }
    if (!res || !res.ok) {
      setStatus((res && res.error) || 'Impossible d’effacer la clé.', true);
      return;
    }
    current = res.settings;
    providers = res.settings.providers || [];
    $('aiKeyState').textContent = 'Aucune clé enregistrée.';
    setStatus('Clé effacée.');
    if (btn) btn.blur();
  });
}

bind();
refresh();

// API pour les tests (auto-test IA).
window.__pohAiSettings = {
  ready: () => refresh(),
  state: () => ({
    provider: $('aiProvider').value,
    model: $('aiModel').value,
    endpoint: $('aiEndpoint').value,
    keyState: $('aiKeyState').textContent,
    status: $('aiSettingsStatus').textContent,
  }),
  save: async (values) => {
    if (values.provider) { $('aiProvider').value = values.provider; fillProviderDefaults(values.provider, { force: true }); }
    if (values.model !== undefined) $('aiModel').value = values.model;
    if (values.endpoint !== undefined) $('aiEndpoint').value = values.endpoint;
    if (values.key !== undefined) $('aiKey').value = values.key;
    $('aiSettingsForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 300));
    return $('aiSettingsStatus').textContent;
  },
};
