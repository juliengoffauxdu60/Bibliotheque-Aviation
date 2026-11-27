// Processus principal — Réglages IA et appel au fournisseur.
// À brancher depuis main.js (voir PATCH D'INTÉGRATION dans le rapport) :
//   import { registerAiHandlers } from './main-ai.js';
//   registerAiHandlers();   // dans app.whenReady(), avant createWindow()
//
// Règles de sécurité :
//  - la clé API n'est JAMAIS journalisée, jamais renvoyée au rendu en clair
//    (le rendu ne reçoit que « •••• + 4 derniers caractères ») ;
//  - elle n'est envoyée qu'au fournisseur choisi par l'utilisateur, dans
//    l'en-tête de la requête (voir renderer/ai-providers.js) ;
//  - stockage local uniquement : safeStorage d'Electron (chiffrement du
//    système) quand il est disponible, sinon fichier dans userData avec
//    permissions 0600 (dossier de l'application, sur l'ordinateur).
import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS, PROVIDER_IDS, maskKey, aiError, buildPrompt, callProvider,
  TEST_TIMEOUT_MS,
} from './renderer/ai-providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function settingsPath() {
  return path.join(app.getPath('userData'), 'ai-settings.json');
}

// Forme stockée v2 : { provider, providers: { [id]: { model, endpoint, keyMethod, keyValue, maskedKey } } }.
//  - UNE CLÉ PAR FOURNISSEUR : changer de fournisseur ne touche pas aux
//    autres clés ; revenir en arrière restaure la clé de ce fournisseur
//    (avant, une seule clé partagée partait chez le nouveau fournisseur).
//  - keyMethod : 'safeStorage' (valeur = base64 du tampon chiffré) ou 'plain'
//    (repli quand le chiffrement du système n'est pas disponible).
//  - maskedKey : « •••• » + 4 derniers caractères, calculé AU MOMENT DE LA
//    SAUVEGARDE (ou au premier usage réel) — l'affichage des réglages ne
//    déchiffre JAMAIS : sur macOS, safeStorage.decryptString bloque sur
//    l'invite du trousseau et la page Réglages restait vide.
//  - Migration v1 (plate : { provider, model, endpoint, keyMethod, keyValue }) :
//    lue comme la clé du fournisseur stocké, réécrite en v2 à la prochaine
//    sauvegarde. Aucune clé existante n'est perdue.
function emptyEntry() {
  return { model: '', endpoint: '', keyMethod: '', keyValue: '', maskedKey: '' };
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyEntry();
  return {
    model: typeof raw.model === 'string' ? raw.model : '',
    endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
    keyMethod: typeof raw.keyMethod === 'string' ? raw.keyMethod : '',
    keyValue: typeof raw.keyValue === 'string' ? raw.keyValue : '',
    maskedKey: typeof raw.maskedKey === 'string' ? raw.maskedKey : '',
  };
}

function loadStored() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch { /* pas de réglages : première utilisation */ }
  const stored = { provider: '', providers: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return stored;
  if (typeof raw.provider === 'string') stored.provider = raw.provider;
  if (raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
    for (const [id, entry] of Object.entries(raw.providers)) {
      if (typeof id === 'string' && id) stored.providers[id] = normalizeEntry(entry);
    }
    return stored;
  }
  // Migration de la forme v1 (plate) : la clé et les réglages appartiennent
  // au fournisseur stocké. La clé masquée est inconnue sans déchiffrer —
  // on ne déchiffre jamais à la lecture : « •••• » générique en attendant
  // le prochain usage réel, qui la recalculera (voir ai:ask / ai:test).
  const entry = normalizeEntry(raw);
  if (entry.keyValue && !entry.maskedKey) entry.maskedKey = '••••';
  if (stored.provider || entry.model || entry.endpoint || entry.keyValue || entry.keyMethod) {
    stored.providers[stored.provider] = entry;
  }
  return stored;
}

function saveStored(stored) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(stored, null, 2), 'utf8');
  try { fs.chmodSync(file, 0o600); } catch { /* Windows : pas de chmod POSIX */ }
}

function encryptKey(key) {
  if (safeStorage.isEncryptionAvailable()) {
    return { method: 'safeStorage', value: safeStorage.encryptString(key).toString('base64') };
  }
  return { method: 'plain', value: key };
}

function decryptKeyEntry(entry) {
  if (!entry || !entry.keyValue) return '';
  if (entry.keyMethod === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(entry.keyValue, 'base64'));
    } catch {
      throw aiError('La clé enregistrée n’a pas pu être relue (chiffrement du système). Effacez-la dans « Réglages IA » puis enregistrez-la de nouveau.');
    }
  }
  return entry.keyValue;
}

// Après un usage réel (déchiffrement), on recalcule la clé masquée si elle
// était inconnue ou périmée (cas d'une clé migrée de la forme v1) — sans
// jamais bloquer la demande si l'écriture échoue.
function refreshMaskedKey(stored, plainKey) {
  try {
    const entry = stored.providers[stored.provider];
    if (!entry || !entry.keyValue || !plainKey) return;
    const masked = maskKey(plainKey);
    if (entry.maskedKey !== masked) {
      entry.maskedKey = masked;
      saveStored(stored);
    }
  } catch { /* l'affichage se rattrapera au prochain usage */ }
}

// Ce que le rendu a le droit de voir : jamais la clé en clair, et JAMAIS de
// déchiffrement sur ce chemin — on lit la clé masquée stockée à la sauvegarde.
function publicSettings() {
  const stored = loadStored();
  const entry = stored.providers[stored.provider] || emptyEntry();
  const def = PROVIDERS[stored.provider];
  const hasKey = Boolean(entry.keyValue);
  const endpoint = entry.endpoint || (def ? def.defaultEndpoint : '');
  const model = entry.model || (def ? def.defaultModel : '');
  const configured = Boolean(def)
    && model.trim() !== ''
    && endpoint.trim() !== ''
    && (!def.needsKey || hasKey);
  return {
    provider: stored.provider,
    model,
    endpoint,
    hasKey,
    maskedKey: hasKey ? (entry.maskedKey || '••••') : '',
    keyMethod: entry.keyMethod,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    configured,
    providers: PROVIDER_IDS.map((id) => {
      const p = stored.providers[id] || emptyEntry();
      return {
        id,
        label: PROVIDERS[id].label,
        needsKey: PROVIDERS[id].needsKey,
        defaultModel: PROVIDERS[id].defaultModel,
        defaultEndpoint: PROVIDERS[id].defaultEndpoint,
        keyHelp: PROVIDERS[id].keyHelp,
        model: p.model,
        endpoint: p.endpoint,
        hasKey: Boolean(p.keyValue),
        maskedKey: p.keyValue ? (p.maskedKey || '••••') : '',
      };
    }),
  };
}

let settingsWin = null;

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return { opened: true };
  }
  settingsWin = new BrowserWindow({
    width: 800,
    height: 720,
    minWidth: 640,
    minHeight: 560,
    title: 'Réglages IA — Bibliothèque Aviation',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadURL('app://renderer/ai-settings.html');
  return { opened: true };
}

export function registerAiHandlers() {
  ipcMain.handle('ai:get-settings', () => {
    try {
      return { ok: true, settings: publicSettings() };
    } catch (e) {
      return { ok: false, error: (e && e.userMessage) || 'Impossible de lire les réglages IA.' };
    }
  });

  ipcMain.handle('ai:save-settings', (_event, payload = {}) => {
    try {
      const provider = String(payload.provider || '').trim();
      if (!PROVIDERS[provider]) return { ok: false, error: 'Choisissez un fournisseur.' };
      const stored = loadStored();
      const entry = stored.providers[provider] || (stored.providers[provider] = emptyEntry());
      const key = typeof payload.key === 'string' ? payload.key : '';
      if (key !== '') {
        if (key.trim().length < 8) {
          return { ok: false, error: 'Cette clé semble trop courte : vérifiez que vous l’avez copiée en entier.' };
        }
        const enc = encryptKey(key.trim());
        entry.keyMethod = enc.method;
        entry.keyValue = enc.value;
        // Clé masquée calculée ici, une fois pour toutes : l'affichage ne
        // déchiffre jamais (voir publicSettings).
        entry.maskedKey = maskKey(key.trim());
      }
      // Champ clé vide : on garde la clé DE CE fournisseur — les clés des
      // autres fournisseurs ne sont jamais touchées.
      entry.model = String(payload.model || '').trim();
      entry.endpoint = String(payload.endpoint || '').trim();
      stored.provider = provider;
      saveStored(stored);
      return { ok: true, settings: publicSettings() };
    } catch (e) {
      return { ok: false, error: (e && e.userMessage) || 'Impossible d’enregistrer les réglages IA.' };
    }
  });

  ipcMain.handle('ai:clear-key', () => {
    try {
      const stored = loadStored();
      // Efface la clé du fournisseur courant seulement — les autres
      // fournisseurs gardent la leur.
      const entry = stored.providers[stored.provider];
      if (entry) {
        entry.keyMethod = '';
        entry.keyValue = '';
        entry.maskedKey = '';
      }
      saveStored(stored);
      return { ok: true, settings: publicSettings() };
    } catch {
      return { ok: false, error: 'Impossible d’effacer la clé.' };
    }
  });

  ipcMain.handle('ai:ask', async (_event, payload = {}) => {
    try {
      const question = String(payload.question || '').trim();
      if (!question) return { ok: false, error: 'Écrivez d’abord votre question.' };
      const context = Array.isArray(payload.context) ? payload.context : [];
      if (context.length === 0) {
        return { ok: false, error: 'Je n’ai trouvé aucun passage dans les POH pour cette question. Essayez avec d’autres mots (par exemple des mots du manuel : « décrochage », « fuel », « volets »).' };
      }
      const stored = loadStored();
      const def = PROVIDERS[stored.provider];
      if (!def) {
        return { ok: false, error: 'Aucune IA n’est configurée. Ouvrez « Réglages IA » pour choisir un fournisseur et enregistrer une clé.' };
      }
      const entry = stored.providers[stored.provider] || emptyEntry();
      // Usage réel : le déchiffrement a lieu ici (l'invite du trousseau,
      // s'il y en a une, n'apparaît qu'à ce moment — jamais à l'affichage).
      const key = decryptKeyEntry(entry);
      refreshMaskedKey(stored, key);
      const prompt = buildPrompt(question, context.slice(0, 6));
      const answer = await callProvider({
        provider: stored.provider,
        model: entry.model || def.defaultModel,
        endpoint: entry.endpoint || def.defaultEndpoint,
        key,
      }, prompt);
      return { ok: true, answer };
    } catch (e) {
      return { ok: false, error: (e && e.userMessage) || 'La demande à l’IA a échoué. Réessayez.' };
    }
  });

  // --- Test de connexion en tâche de fond (v1.2.6) -------------------
  // Le test ne passe PLUS par une réponse IPC : Electron rejette un
  // appel sans réponse au bout de ~30 s (« reply was never sent »),
  // et l'ancien test (28 s + 2 essais) échouait par dépassement de
  // délai sans dire où ça bloquait. Maintenant `ai:test-start` rend
  // un testId tout de suite, le travail se fait en arrière-plan avec
  // un budget de 120 s, et chaque étape est datée : la progression
  // arrive par `ai:test-progress` (étape + temps écoulé), le résultat
  // par `ai:test-done` (ok/erreur + durées mesurées : lecture de la
  // clé, appel réseau, total). La clé n'est jamais journalisée ni
  // renvoyée — seules des durées et des messages en français partent
  // vers le rendu. `ai:test` (invoke) reste pour compatibilité
  // (tests Node, harnais E2E) avec l'ancien budget de 28 s.
  const AI_TEST_BUDGET_MS = 120000;
  let aiTestCounter = 0;
  let runningAiTest = null; // { testId, promise } — un seul test à la fois

  function emitToSender(event, channel, payload) {
    try {
      const sender = event && event.sender;
      if (sender && typeof sender.send === 'function') sender.send(channel, payload);
    } catch { /* fenêtre fermée : le résultat reste lisible via ai:test */ }
  }

  async function runAiTest({ timeoutMs, onProgress }) {
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;
    const durations = { keyMs: 0, networkMs: 0, totalMs: 0 };
    const progress = (step) => { try { onProgress && onProgress(step, elapsed()); } catch { /* jamais bloquant */ } };
    try {
      progress('preparation');
      const stored = loadStored();
      const def = PROVIDERS[stored.provider];
      if (!def) {
        durations.totalMs = elapsed();
        return { ok: false, error: 'Aucune IA n’est configurée. Choisissez un fournisseur et enregistrez une clé, puis testez de nouveau.', durations };
      }
      const entry = stored.providers[stored.provider] || emptyEntry();
      // Usage réel : le déchiffrement a lieu ici (l'invite du trousseau,
      // s'il y en a une, n'apparaît qu'à ce moment — jamais à l'affichage).
      // Attention : safeStorage.decryptString est synchrone et, sur macOS,
      // peut attendre l'invite du trousseau — aucun délai ne peut le
      // borner ici ; c'est exactement ce que l'étape « key » et sa durée
      // permettent de voir.
      const keyStart = Date.now();
      let key;
      try {
        key = decryptKeyEntry(entry);
      } finally {
        durations.keyMs = Date.now() - keyStart;
      }
      refreshMaskedKey(stored, key);
      progress('key');
      progress('request');
      const netStart = Date.now();
      let answer;
      try {
        answer = await callProvider({
          provider: stored.provider,
          model: entry.model || def.defaultModel,
          endpoint: entry.endpoint || def.defaultEndpoint,
          key,
        }, 'Réponds uniquement par le mot OK.', undefined, { timeoutMs });
      } finally {
        durations.networkMs = Date.now() - netStart;
      }
      durations.totalMs = elapsed();
      return { ok: true, answer: answer.slice(0, 200), durations };
    } catch (e) {
      durations.totalMs = elapsed();
      const out = { ok: false, error: (e && e.userMessage) || 'Le test a échoué. Réessayez.', durations };
      // Le code « timeout » dit au rendu que c'est un dépassement de
      // délai — il n'est renvoyé que pour ça, jamais pour une clé
      // refusée ou un modèle inconnu.
      if (e && e.code) out.code = e.code;
      return out;
    }
  }

  ipcMain.handle('ai:test-start', (event) => {
    if (runningAiTest) {
      return { ok: false, error: 'Un test de connexion est déjà en cours. Attendez son résultat.' };
    }
    const testId = `ai-test-${++aiTestCounter}`;
    const job = (async () => {
      try {
        const emitProgress = (step, elapsedMs) => emitToSender(event, 'ai:test-progress', { testId, step, elapsedMs });
        const result = await runAiTest({ timeoutMs: AI_TEST_BUDGET_MS, onProgress: emitProgress });
        emitToSender(event, 'ai:test-done', { testId, ...result });
        return result;
      } finally {
        if (runningAiTest && runningAiTest.testId === testId) runningAiTest = null;
      }
    })();
    runningAiTest = { testId, promise: job };
    job.catch(() => { /* l'erreur est déjà dans l'événement done */ });
    return { ok: true, testId };
  });

  ipcMain.handle('ai:test', async () => {
    // Compatibilité (tests Node, harnais E2E) : même moteur, ancien
    // budget de 28 s, réponse directe. La page Réglages utilise
    // ai:test-start et ne passe plus par ici.
    return runAiTest({ timeoutMs: TEST_TIMEOUT_MS });
  });

  ipcMain.handle('ai:open-settings', () => {
    try {
      return { ok: true, ...openSettingsWindow() };
    } catch {
      return { ok: false, error: 'Impossible d’ouvrir la page Réglages IA.' };
    }
  });
}
