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

  ipcMain.handle('ai:test', async () => {
    try {
      const stored = loadStored();
      const def = PROVIDERS[stored.provider];
      if (!def) {
        return { ok: false, error: 'Aucune IA n’est configurée. Choisissez un fournisseur et enregistrez une clé, puis testez de nouveau.' };
      }
      const entry = stored.providers[stored.provider] || emptyEntry();
      // Usage réel : le déchiffrement a lieu ici (voir ai:ask).
      const key = decryptKeyEntry(entry);
      refreshMaskedKey(stored, key);
      const answer = await callProvider({
        provider: stored.provider,
        model: entry.model || def.defaultModel,
        endpoint: entry.endpoint || def.defaultEndpoint,
        key,
      }, 'Réponds uniquement par le mot OK.');
      return { ok: true, answer: answer.slice(0, 200) };
    } catch (e) {
      return { ok: false, error: (e && e.userMessage) || 'Le test a échoué. Réessayez.' };
    }
  });

  ipcMain.handle('ai:open-settings', () => {
    try {
      return { ok: true, ...openSettingsWindow() };
    } catch {
      return { ok: false, error: 'Impossible d’ouvrir la page Réglages IA.' };
    }
  });
}
