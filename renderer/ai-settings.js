// Page « Réglages IA » — logique.
// Parle uniquement au processus principal via window.pohDesktop.ai (patch
// préchargeur) : la clé en clair ne sort jamais de cette page vers le
// rendu principal, et n'est jamais affichée — seul « •••• + 4 derniers
// caractères » est montré.
const $ = (id) => document.getElementById(id);

let providers = [];
let current = null;
let testing = false;
let activeTestId = null;
let testWatchdog = null;

// Délais (v1.2.6) : le test de connexion ne passe PLUS par une réponse
// IPC — Electron rejette un appel sans réponse au bout de ~30 s, et
// l'ancien test (28 s + 2 essais) échouait par dépassement de délai
// sans dire où ça bloquait. Maintenant le test tourne en tâche de fond
// dans le processus principal (budget 120 s) : la progression arrive
// par événements (étape + temps écoulé, affichés en direct) et le
// résultat par un événement de fin (avec les durées mesurées : lecture
// de la clé, appel réseau, total). Un minuteur de secours (130 s)
// empêche que « Test en cours… » reste figé si l'événement de fin
// n'arrive jamais. L'enregistrement et la lecture des réglages gardent
// leurs propres délais, car ce sont des appels IPC courts.
const TEST_WATCHDOG_MS = 130000;
const SAVE_TIMEOUT_MS = 30000;
const LOAD_TIMEOUT_MS = 15000;
const API_ABSENT_MESSAGE = 'La fonction IA n’est pas branchée dans cette application (le préchargeur ne l’expose pas).';
const TEST_TIMEOUT_MESSAGE = 'Le test n’a pas répondu à temps. Si une fenêtre du trousseau (macOS) est apparue derrière l’application, autorisez-la puis réessayez. Sinon, vérifiez votre connexion et réessayez.';
const SAVE_TIMEOUT_MESSAGE = 'L’enregistrement n’a pas répondu à temps. Réessayez.';
const CLEAR_TIMEOUT_MESSAGE = 'La suppression de la clé n’a pas répondu à temps. Réessayez.';
const TEST_STEP_LABELS = {
  preparation: 'Préparation…',
  key: 'Lecture de la clé enregistrée…',
  request: 'Appel au fournisseur…',
};

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

function updateApi() {
  return window.pohDesktop && window.pohDesktop.update ? window.pohDesktop.update : null;
}

function setUpdateStatus(text, isError) {
  const el = $('updateSettingsStatus');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('ai-error', Boolean(isError));
}

// Les réglages de mise à jour se chargent à part, avec leur propre
// erreur : un échec ici ne doit jamais cacher les réglages IA.
async function refreshUpdateSettings() {
  const api = updateApi();
  const box = $('updateAutoCheck');
  if (!api || !box) return;
  try {
    const settings = await withTimeout(api.getSettings(), LOAD_TIMEOUT_MS, 'Impossible de lire le réglage des mises à jour.');
    box.checked = settings ? settings.autoUpdate !== false : true;
  } catch {
    box.checked = true;
  }
  // Version installée affichée dans la section (v1.2.6) : lue dans le
  // processus principal, jamais écrite en dur.
  const versionLabel = $('installedVersionLabel');
  if (versionLabel && typeof api.getVersion === 'function') {
    try {
      const version = await api.getVersion();
      if (typeof version === 'string' && version) versionLabel.textContent = version;
    } catch { /* le libellé garde « … » */ }
  }
}

function setUpdateDetail(text) {
  const el = $('updateDetail');
  if (!el) return;
  if (text) {
    el.textContent = `Détail : ${text}`;
    el.hidden = false;
  } else {
    el.textContent = '';
    el.hidden = true;
  }
}

function bindUpdateSettings() {
  const box = $('updateAutoCheck');
  if (box) {
    box.addEventListener('change', async () => {
      const api = updateApi();
      if (!api) {
        setUpdateStatus('La fonction de mise à jour n’est pas branchée dans cette application.', true);
        return;
      }
      try {
        await withTimeout(api.setSettings({ autoUpdate: box.checked }), SAVE_TIMEOUT_MS, SAVE_TIMEOUT_MESSAGE);
        setUpdateStatus(box.checked
          ? 'Vérification automatique activée.'
          : 'Vérification automatique désactivée. Vous pourrez toujours vérifier manuellement ici.');
      } catch {
        setUpdateStatus('Impossible d’enregistrer ce réglage.', true);
      }
    });
  }
  const checkBtn = $('updateCheckNowBtn');
  if (checkBtn) {
    checkBtn.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const api = updateApi();
      if (!api) {
        setUpdateStatus('La fonction de mise à jour n’est pas branchée dans cette application.', true);
        return;
      }
      if (btn) btn.disabled = true;
      try {
        setUpdateStatus('Vérification en cours…');
        setUpdateDetail('');
        const res = await withTimeout(api.checkNow(), LOAD_TIMEOUT_MS, 'La vérification n’a pas répondu à temps. Réessayez.');
        setUpdateStatus(res && res.available
          ? `Une mise à jour est disponible : version ${res.version}. Fermez cette fenêtre pour la voir en haut de la page principale.`
          : 'L’application est à jour.');
      } catch (err) {
        // Le processus principal joint le détail technique assaini au
        // message convivial (« … — Détail : … ») : on l'affiche à part,
        // sous le statut, pour ne pas noyer le message.
        const message = (err && err.message) || 'Impossible de vérifier les mises à jour.';
        const split = message.split(' — Détail : ');
        setUpdateStatus(split[0] || message, true);
        setUpdateDetail(split.length > 1 ? split.slice(1).join(' — Détail : ') : '');
      } finally {
        if (btn) btn.disabled = false;
        if (btn) btn.blur();
      }
    });
  }
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

function formatDurations(durations) {
  if (!durations || typeof durations !== 'object') return '';
  const parts = [];
  if (typeof durations.keyMs === 'number') parts.push(`lecture de la clé : ${durations.keyMs} ms`);
  if (typeof durations.networkMs === 'number') parts.push(`appel réseau : ${durations.networkMs} ms`);
  if (typeof durations.totalMs === 'number') parts.push(`total : ${(durations.totalMs / 1000).toFixed(1)} s`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// Un seul test à la fois : la promesse en attente du résultat.
let pendingTestResolve = null;

function bindTestEvents(api) {
  if (typeof api.onTestProgress !== 'function' || typeof api.onTestDone !== 'function') return;
  api.onTestProgress((payload) => {
    if (!payload || !payload.testId) return;
    // Le premier événement peut arriver avant que testStart ait rendu
    // le testId : on adopte le premier testId vu pendant un test.
    if (activeTestId && payload.testId !== activeTestId) return;
    if (!activeTestId) activeTestId = payload.testId;
    const label = TEST_STEP_LABELS[payload.step] || 'Test en cours…';
    const seconds = typeof payload.elapsedMs === 'number' ? (payload.elapsedMs / 1000).toFixed(1) : '0.0';
    setStatus(`Test en cours… ${label} (${seconds} s)`);
  });
  api.onTestDone((payload) => {
    if (!payload || !payload.testId) return;
    if (activeTestId && payload.testId !== activeTestId) return;
    activeTestId = null;
    if (testWatchdog) { clearTimeout(testWatchdog); testWatchdog = null; }
    const resolve = pendingTestResolve;
    pendingTestResolve = null;
    if (resolve) resolve(payload);
  });
}

// Lance le test de fond et attend son événement de fin (ou le minuteur
// de secours). Le statut affiche l'étape et le temps écoulé en direct
// grâce aux événements de progression (voir bindTestEvents).
function runBackgroundTest(api) {
  return new Promise((resolve) => {
    // Minuteur de secours : si l'événement de fin n'arrive jamais, on
    // ne laisse pas « Test en cours… » figé.
    testWatchdog = setTimeout(() => {
      testWatchdog = null;
      pendingTestResolve = null;
      activeTestId = null;
      setStatus(TEST_TIMEOUT_MESSAGE, true);
      resolve();
    }, TEST_WATCHDOG_MS);
    pendingTestResolve = (payload) => {
      if (testWatchdog) { clearTimeout(testWatchdog); testWatchdog = null; }
      if (payload && payload.ok) {
        setStatus(`Connexion OK : le fournisseur a répondu « ${payload.answer} ».${formatDurations(payload.durations)}`);
      } else if (payload) {
        setStatus(`${payload.error || 'Le test a échoué.'}${formatDurations(payload.durations)}`, true);
      }
      resolve();
    };
    api.testStart().then((res) => {
      if (!res || !res.ok) {
        // Démarrage refusé (un test est déjà en cours, ou autre) :
        // aucun événement de fin n'arrivera, on n'attend pas.
        if (testWatchdog) { clearTimeout(testWatchdog); testWatchdog = null; }
        pendingTestResolve = null;
        activeTestId = null;
        setStatus((res && res.error) || 'Impossible de lancer le test.', true);
        resolve();
        return;
      }
      activeTestId = res.testId;
      setStatus('Test en cours… Préparation… (0,0 s)');
    }).catch(() => {
      if (testWatchdog) { clearTimeout(testWatchdog); testWatchdog = null; }
      pendingTestResolve = null;
      activeTestId = null;
      setStatus('Impossible de lancer le test.', true);
      resolve();
    });
  });
}

function bind() {
  const api = aiApi();
  if (api) bindTestEvents(api);
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
      // Mécanisme de fond (v1.2.6) : ai:test-start rend un testId tout
      // de suite, la progression et le résultat arrivent par événements
      // — plus de boucle d'essais, plus de coupure à 30 s, et chaque
      // étape dit où en est le test et depuis combien de temps.
      if (typeof api.testStart === 'function' && typeof api.onTestProgress === 'function' && typeof api.onTestDone === 'function') {
        await runBackgroundTest(api);
        return;
      }
      // Repli (ancien préchargeur) : un seul appel direct.
      setStatus('Test en cours…');
      let res;
      try {
        res = await withTimeout(api.test(), TEST_WATCHDOG_MS, TEST_TIMEOUT_MESSAGE);
      } catch (err) {
        setStatus(TEST_TIMEOUT_MESSAGE, true);
        return;
      }
      if (res && res.ok) {
        setStatus(`Connexion OK : le fournisseur a répondu « ${res.answer} ».${formatDurations(res.durations)}`);
      } else {
        setStatus(`${(res && res.error) || 'Le test a échoué.'}${formatDurations(res && res.durations)}`, true);
      }
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
bindUpdateSettings();
refresh();
refreshUpdateSettings();

// API pour les tests (auto-test IA).
window.__pohAiSettings = {
  ready: () => refresh(),
  state: () => ({
    provider: $('aiProvider').value,
    model: $('aiModel').value,
    endpoint: $('aiEndpoint').value,
    keyState: $('aiKeyState').textContent,
    status: $('aiSettingsStatus').textContent,
    updateAutoChecked: $('updateAutoCheck') ? $('updateAutoCheck').checked : null,
    updateCheckNowPresent: Boolean($('updateCheckNowBtn')),
    updateStatus: $('updateSettingsStatus') ? $('updateSettingsStatus').textContent : '',
    installedVersion: $('installedVersionLabel') ? $('installedVersionLabel').textContent : '',
    updateDetail: $('updateDetail') ? $('updateDetail').textContent : '',
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
