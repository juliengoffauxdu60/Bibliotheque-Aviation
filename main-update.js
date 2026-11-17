// Mise à jour automatique (v1.2.5) — colle Electron.
//
// Deux chemins, une seule source de vérité (le flux GitHub, voir
// main/update-feed.js) :
//  - Windows : electron-updater standard (vérifier, télécharger en
//    arrière-plan, installer au redémarrage). L'appli n'est PAS signée
//    Authenticode, donc on ne définit JAMAIS nsis.publisherName :
//    l'updater exigerait sinon des mises à jour signées.
//  - macOS : on NE PASSE JAMAIS par autoUpdater.downloadUpdate() ni
//    quitAndInstall — Squirrel.Mac refuse les signatures ad-hoc (son
//    exigence désignée est un cdhash par build, chaque mise à jour est
//    rejetée « Code signature … did not pass validation »). La
//    VÉRIFICATION lit latest-mac.yml (même code que partout ailleurs) ;
//    le TÉLÉCHARGEMENT et l'INSTALLATION sont maison (main/mac-update.js :
//    zip vérifié sha512, .app remplacé avec sauvegarde, relance).
//  - Linux / développement : la vérification fonctionne (à titre
//    informatif), l'installation est refusée avec un message clair.
//
// Réglages : userData/update-settings.json, { autoUpdate: true } par
// défaut (même motif que main-ai.js : chmod 0600, jamais de jeton).
// Vérification automatique 20 s après le démarrage puis toutes les 6 h,
// uniquement si activée — et JAMAIS en auto-test (POH_SELFTEST=1).
//
// Téléchargement long (150-300 Mo) : l'IPC `update:download` répond
// tout de suite (démarrage en arrière-plan) et la progression arrive
// par événements `update:status` — une réponse IPC ne doit jamais
// attendre un téléchargement (limite 30 s côté rendu).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { app, ipcMain } from 'electron';
import {
  UpdateError, checkForUpdate, downloadFile, isNewer, verifySha512,
} from './main/update-feed.js';
import { bundleDirFromExe, installMacUpdate } from './main/mac-update.js';

const UPDATE_SETTINGS_FILE = 'update-settings.json';
const AUTO_CHECK_DELAY_MS = 20_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const IPC_TIMEOUT_MS = 25_000;

let mainWindow = null;
let settingsCache = null;
let checkingPromise = null;
let pendingUpdate = null; // { version, file, updateInfo?, platform }
let downloading = null; // { promise, destPath, version }
let downloadedReady = null; // { version, destPath?, updateInfo? }
let autoCheckTimer = null;

function isTestMode() {
  return Boolean(process.env.POH_UPDATE_TEST_APP);
}

function fakePlatform() {
  return process.env.POH_UPDATE_FAKE_PLATFORM || null;
}

function currentPlatform() {
  return fakePlatform() || process.platform;
}

function settingsPath() {
  return path.join(app.getPath('userData'), UPDATE_SETTINGS_FILE);
}

export function getUpdateSettings() {
  if (settingsCache) return { ...settingsCache };
  let loaded = { autoUpdate: true };
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed.autoUpdate === 'boolean') loaded.autoUpdate = parsed.autoUpdate;
  } catch {
    // Fichier absent ou illisible : défauts (activé).
  }
  settingsCache = loaded;
  return { ...loaded };
}

export function saveUpdateSettings(patch) {
  const next = { ...getUpdateSettings(), ...patch };
  next.autoUpdate = next.autoUpdate !== false;
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
    try { fs.chmodSync(settingsPath(), 0o600); } catch { /* déjà 0600 */ }
  } catch (e) {
    throw new UpdateError(`Impossible d’enregistrer le réglage des mises à jour (${e.message}).`);
  }
  settingsCache = next;
  return { ...next };
}

function sendStatus(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update:status', payload);
    }
  } catch { /* fenêtre fermée : l'état reste lisible par IPC */ }
}

function withTimeout(promise, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new UpdateError(message)), IPC_TIMEOUT_MS);
    }),
  ]);
}

// Extraction de TEST (Linux, auto-test uniquement) : `unzip` puis
// python3. En production sur macOS, c'est `ditto` (main/mac-update.js).
function extractZipTest(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], (err) => {
      if (!err) return resolve();
      execFile('python3', ['-m', 'zipfile', '-e', zipPath, destDir], (err2) => {
        if (err2) reject(new UpdateError(`Impossible d’ouvrir la mise à jour téléchargée (${err2.message}).`));
        else resolve();
      });
    });
  });
}

// --- Chemin Windows (electron-updater) ---------------------------------
async function loadAutoUpdater() {
  // Import paresseux : electron-updater n'est touché que sur Windows,
  // jamais sur macOS (ni dans l'auto-test).
  const pkg = await import('electron-updater');
  const autoUpdater = pkg.autoUpdater || pkg.default?.autoUpdater;
  if (!autoUpdater) throw new UpdateError('Le module de mise à jour Windows est indisponible.');
  return autoUpdater;
}

async function checkWindows() {
  const autoUpdater = await loadAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  let result;
  try {
    result = await withTimeout(autoUpdater.checkForUpdates(), 'La vérification des mises à jour a mis trop de temps (délai dépassé).');
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError('Impossible de vérifier les mises à jour (le serveur des versions est injoignable ou la configuration est absente). Réessayez plus tard.');
  }
  const info = result?.updateInfo;
  if (!info || !info.version) {
    throw new UpdateError('Le serveur des mises à jour a renvoyé une réponse incompréhensible (pas de version).');
  }
  const currentVersion = app.getVersion();
  const available = isNewer(info.version, currentVersion);
  return {
    available,
    version: info.version,
    currentVersion,
    file: available ? { name: info.path || '', sha512: info.sha512 || '', size: null } : null,
    updateInfo: info,
  };
}

// --- Chemin macOS / Linux (flux direct) --------------------------------
async function checkFeed() {
  const platform = currentPlatform();
  return checkForUpdate({
    currentVersion: app.getVersion(),
    platform,
    arch: process.arch,
  });
}

export async function checkForUpdateNow() {
  if (checkingPromise) return checkingPromise;
  checkingPromise = (async () => {
    const platform = currentPlatform();
    let result;
    if (platform === 'win32') {
      result = await checkWindows();
    } else {
      result = await checkFeed();
    }
    pendingUpdate = result.available
      ? { version: result.version, file: result.file, updateInfo: result.updateInfo || null, platform }
      : null;
    downloadedReady = null;
    sendStatus({ type: result.available ? 'available' : 'up-to-date', version: result.version, currentVersion: result.currentVersion });
    return { available: result.available, version: result.version, currentVersion: result.currentVersion };
  })();
  try {
    return await checkingPromise;
  } finally {
    checkingPromise = null;
  }
}

async function downloadWindows() {
  const autoUpdater = await loadAutoUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  const onProgress = (p) => {
    sendStatus({ type: 'progress', percent: Math.round(p.percent || 0), received: p.transferred || null, total: p.total || null });
  };
  autoUpdater.on('download-progress', onProgress);
  try {
    await autoUpdater.downloadUpdate();
    downloadedReady = { version: pendingUpdate.version, updateInfo: pendingUpdate.updateInfo };
    sendStatus({ type: 'ready', version: pendingUpdate.version });
    return { ok: true, version: pendingUpdate.version };
  } finally {
    autoUpdater.removeListener('download-progress', onProgress);
  }
}

async function downloadMac() {
  const file = pendingUpdate.file;
  if (!file || !file.url) throw new UpdateError('Aucun fichier de mise à jour à télécharger.');
  const destPath = path.join(os.tmpdir(), `bibliotheque-aviation-maj-${pendingUpdate.version}-${process.pid}.zip`);
  await downloadFile(file.url, destPath, {
    onProgress: (p) => {
      sendStatus({ type: 'progress', percent: p.percent, received: p.received, total: p.total });
    },
  });
  if (!verifySha512(destPath, file.sha512)) {
    try { fs.unlinkSync(destPath); } catch { /* déjà absent */ }
    throw new UpdateError('La mise à jour téléchargée est corrompue (empreinte différente de celle publiée). Le téléchargement a été supprimé, l’application actuelle n’a pas été touchée.');
  }
  downloadedReady = { version: pendingUpdate.version, destPath };
  sendStatus({ type: 'ready', version: pendingUpdate.version });
  return { ok: true, version: pendingUpdate.version };
}

export function startDownload() {
  if (downloading) return { started: true, alreadyRunning: true, version: pendingUpdate?.version || '' };
  if (!pendingUpdate) throw new UpdateError('Aucune mise à jour à télécharger : vérifiez d’abord s’il y en a une.');
  const platform = currentPlatform();
  const job = (async () => {
    try {
      if (platform === 'win32') await downloadWindows();
      else if (platform === 'darwin') await downloadMac();
      else throw new UpdateError('Le téléchargement automatique n’est pas disponible sur cette plateforme.');
    } catch (e) {
      const message = e instanceof UpdateError ? e.userMessage : 'Le téléchargement de la mise à jour a échoué. Réessayez plus tard.';
      sendStatus({ type: 'error', message });
      throw e;
    } finally {
      downloading = null;
    }
  })();
  // L'IPC répond tout de suite : la progression arrive par événements.
  downloading = { promise: job, version: pendingUpdate.version };
  job.catch(() => { /* l'erreur est déjà envoyée par événement */ });
  return { started: true, version: pendingUpdate.version };
}

export async function installDownloaded() {
  if (!downloadedReady) throw new UpdateError('Aucune mise à jour téléchargée à installer.');
  const platform = currentPlatform();
  if (platform === 'win32') {
    const autoUpdater = await loadAutoUpdater();
    // L'installation se fait au redémarrage : l'appli se ferme ici.
    autoUpdater.quitAndInstall();
    return { ok: true, restarting: true, version: downloadedReady.version };
  }
  if (platform === 'darwin') {
    const appDir = isTestMode()
      ? process.env.POH_UPDATE_TEST_APP
      : bundleDirFromExe(process.execPath);
    const result = await installMacUpdate({
      zipPath: downloadedReady.destPath,
      expectedSha512: pendingUpdate?.file?.sha512 || '',
      appDir,
      platform: 'darwin',
      extractFn: isTestMode() ? extractZipTest : undefined,
      testOverride: isTestMode(),
    });
    try { fs.unlinkSync(downloadedReady.destPath); } catch { /* nettoyage */ }
    downloadedReady = null;
    if (isTestMode()) {
      // Auto-test : pas de relance, on rend le résultat vérifiable.
      return { ok: true, swapped: true, version: result.newVersion, backupDir: result.backupDir };
    }
    app.relaunch();
    app.quit();
    return { ok: true, restarting: true, version: result.newVersion };
  }
  throw new UpdateError('L’installation automatique n’est pas disponible sur cette plateforme.');
}

export function stopAutoChecks() {
  if (autoCheckTimer) { clearInterval(autoCheckTimer); autoCheckTimer = null; }
}

export function scheduleAutoChecks() {
  if (process.env.POH_SELFTEST === '1') return; // déterminisme de l'auto-test
  stopAutoChecks();
  const tick = async () => {
    if (!getUpdateSettings().autoUpdate) return;
    try { await checkForUpdateNow(); } catch (e) {
      // Échec silencieux en arrière-plan : le réglage « Vérifier
      // maintenant » affichera le message ; on ne spamme pas.
      sendStatus({ type: 'error', message: e instanceof UpdateError ? e.userMessage : 'Impossible de vérifier les mises à jour.' });
    }
  };
  setTimeout(tick, AUTO_CHECK_DELAY_MS);
  autoCheckTimer = setInterval(tick, AUTO_CHECK_INTERVAL_MS);
}

export function initUpdate(win) {
  mainWindow = win;
  ipcMain.handle('update:get-settings', () => getUpdateSettings());
  ipcMain.handle('update:set-settings', (_e, patch) => saveUpdateSettings(patch || {}));
  ipcMain.handle('update:check-now', async () => {
    try {
      return await checkForUpdateNow();
    } catch (e) {
      if (e instanceof UpdateError) throw new Error(e.userMessage);
      throw new Error('Impossible de vérifier les mises à jour. Réessayez plus tard.');
    }
  });
  ipcMain.handle('update:download', () => {
    try {
      return startDownload();
    } catch (e) {
      if (e instanceof UpdateError) throw new Error(e.userMessage);
      throw new Error('Impossible de lancer le téléchargement. Réessayez plus tard.');
    }
  });
  ipcMain.handle('update:install', async () => {
    try {
      return await installDownloaded();
    } catch (e) {
      if (e instanceof UpdateError) throw new Error(e.userMessage);
      throw new Error('Impossible d’installer la mise à jour. Réessayez plus tard.');
    }
  });
  scheduleAutoChecks();
}
