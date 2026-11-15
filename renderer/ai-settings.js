// Page « Réglages IA » — logique.
// Parle uniquement au processus principal via window.pohDesktop.ai (patch
// préchargeur) : la clé en clair ne sort jamais de cette page vers le
// rendu principal, et n'est jamais affichée — seul « •••• + 4 derniers
// caractères » est montré.
const $ = (id) => document.getElementById(id);

let providers = [];
let current = null;

function aiApi() {
  return window.pohDesktop && window.pohDesktop.ai ? window.pohDesktop.ai : null;
}

function setStatus(text, isError) {
  const el = $('aiSettingsStatus');
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
    setStatus('La fonction IA n’est pas branchée dans cette application (le préchargeur ne l’expose pas).', true);
    return;
  }
  const res = await api.getSettings();
  if (!res.ok) {
    setStatus(res.error || 'Impossible de lire les réglages IA.', true);
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
    if (!api) return;
    setStatus('Enregistrement…');
    const res = await api.saveSettings({
      provider: $('aiProvider').value,
      model: $('aiModel').value.trim(),
      endpoint: $('aiEndpoint').value.trim(),
      key: $('aiKey').value.trim(),
    });
    if (!res.ok) {
      setStatus(res.error || 'Enregistrement impossible.', true);
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
    const api = aiApi();
    if (!api) return;
    setStatus('Test en cours…');
    const res = await api.test();
    if (!res.ok) {
      setStatus(res.error || 'Le test a échoué.', true);
      return;
    }
    setStatus(`Connexion OK : le fournisseur a répondu « ${res.answer} ».`);
    e.currentTarget.blur();
  });
  $('aiClearKeyBtn').addEventListener('click', async (e) => {
    const api = aiApi();
    if (!api) return;
    if (!current || !current.hasKey) {
      setStatus('Aucune clé à effacer.');
      return;
    }
    if (!window.confirm('Effacer la clé API enregistrée ? Il faudra la saisir de nouveau pour utiliser l’IA.')) return;
    const res = await api.clearKey();
    if (!res.ok) {
      setStatus(res.error || 'Impossible d’effacer la clé.', true);
      return;
    }
    current = res.settings;
    providers = res.settings.providers || [];
    $('aiKeyState').textContent = 'Aucune clé enregistrée.';
    setStatus('Clé effacée.');
    e.currentTarget.blur();
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
