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

// Forme stockée : { provider, model, endpoint, keyMethod, keyValue }.
// keyMethod : 'safeStorage' (valeur = base64 du tampon chiffré) ou 'plain'
// (repli quand le chiffrement du système n'est pas disponible).
function loadStored() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (raw && typeof raw === 'object') {
      return {
        provider: typeof raw.provider === 'string' ? raw.provider : '',
        model: typeof raw.model === 'string' ? raw.model : '',
        endpoint: typeof raw.endpoint === 'string' ? raw.endpoint : '',
        keyMethod: typeof raw.keyMethod === 'string' ? raw.keyMethod : '',
        keyValue: typeof raw.keyValue === 'string' ? raw.keyValue : '',
      };
    }
  } catch { /* pas de réglages : première utilisation */ }
  return { provider: '', model: '', endpoint: '', keyMethod: '', keyValue: '' };
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

function decryptKey(stored) {
  if (!stored.keyValue) return '';
  if (stored.keyMethod === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(stored.keyValue, 'base64'));
    } catch {
      throw aiError('La clé enregistrée n’a pas pu être relue (chiffrement du système). Effacez-la dans « Réglages IA » puis enregistrez-la de nouveau.');
    }
  }
  return stored.keyValue;
}

// Ce que le rendu a le droit de voir : jamais la clé en clair.
function publicSettings() {
  const stored = loadStored();
  const def = PROVIDERS[stored.provider];
  const hasKey = Boolean(stored.keyValue);
  const key = hasKey ? decryptKey(stored) : '';
  const endpoint = stored.endpoint || (def ? def.defaultEndpoint : '');
  const model = stored.model || (def ? def.defaultModel : '');
  const configured = Boolean(def)
    && model.trim() !== ''
    && endpoint.trim() !== ''
    && (!def.needsKey || hasKey);
  return {
    provider: stored.provider,
    model,
    endpoint,
    hasKey,
    maskedKey: hasKey ? maskKey(key) : '',
    keyMethod: stored.keyMethod,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    configured,
    providers: PROVIDER_IDS.map((id) => ({
      id,
      label: PROVIDERS[id].label,
      needsKey: PROVIDERS[id].needsKey,
      defaultModel: PROVIDERS[id].defaultModel,
      defaultEndpoint: PROVIDERS[id].defaultEndpoint,
      keyHelp: PROVIDERS[id].keyHelp,
    })),
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
    title: 'Réglages IA — Recherche POH',
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
      const key = typeof payload.key === 'string' ? payload.key : '';
      if (key !== '') {
        if (key.trim().length < 8) {
          return { ok: false, error: 'Cette clé semble trop courte : vérifiez que vous l’avez copiée en entier.' };
        }
        const enc = encryptKey(key.trim());
        stored.keyMethod = enc.method;
        stored.keyValue = enc.value;
      }
      stored.provider = provider;
      stored.model = String(payload.model || '').trim();
      stored.endpoint = String(payload.endpoint || '').trim();
      saveStored(stored);
      return { ok: true, settings: publicSettings() };
    } catch (e) {
      return { ok: false, error: (e && e.userMessage) || 'Impossible d’enregistrer les réglages IA.' };
    }
  });

  ipcMain.handle('ai:clear-key', () => {
    try {
      const stored = loadStored();
      stored.keyMethod = '';
      stored.keyValue = '';
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
      const prompt = buildPrompt(question, context.slice(0, 6));
      const answer = await callProvider({
        provider: stored.provider,
        model: stored.model || def.defaultModel,
        endpoint: stored.endpoint || def.defaultEndpoint,
        key: decryptKey(stored),
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
      const answer = await callProvider({
        provider: stored.provider,
        model: stored.model || def.defaultModel,
        endpoint: stored.endpoint || def.defaultEndpoint,
        key: decryptKey(stored),
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
