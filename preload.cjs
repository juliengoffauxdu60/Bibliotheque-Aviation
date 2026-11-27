// Preload — volontairement minimal : l'application est 100 % locale et le rendu
// n'a besoin d'aucun accès Node, sauf l'import de POH et les réglages IA,
// qui passent par des canaux IPC nommés. La clé IA reste dans le processus
// principal (main-ai.js) et n'est jamais transmise en clair au rendu.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pohDesktop', {
  platform: process.platform,
  import: {
    list: () => ipcRenderer.invoke('poh-import:list'),
    chooseFile: () => ipcRenderer.invoke('poh-import:choose-file'),
    importFile: (filePath) => ipcRenderer.invoke('poh-import:import-file', { filePath }),
    ocrPage: (docId, pdfPage, pngBase64, imageWidth, imageHeight) => ipcRenderer.invoke('poh-import:ocr-page', { docId, pdfPage, pngBase64, imageWidth, imageHeight }),
    ocrFinish: (docId) => ipcRenderer.invoke('poh-import:ocr-finish', { docId }),
    ocrCancel: (docId) => ipcRenderer.invoke('poh-import:ocr-cancel', { docId }),
    deleteDoc: (docId) => ipcRenderer.invoke('poh-import:delete', { docId }),
  },
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    ask: (payload) => ipcRenderer.invoke('ai:ask', payload),
    test: () => ipcRenderer.invoke('ai:test'),
    // Test de connexion en tâche de fond (v1.2.6) : ai:test-start rend
    // un testId tout de suite, la progression et le résultat arrivent
    // par événements — plus de coupure à 30 s, et chaque étape est
    // datée (voir main-ai.js). ai:test reste pour compatibilité.
    testStart: () => ipcRenderer.invoke('ai:test-start'),
    onTestProgress: (cb) => ipcRenderer.on('ai:test-progress', (_event, payload) => cb(payload)),
    onTestDone: (cb) => ipcRenderer.on('ai:test-done', (_event, payload) => cb(payload)),
    openSettings: () => ipcRenderer.invoke('ai:open-settings'),
  },
  // Mise à jour automatique (v1.2.5) : réglage, vérification,
  // téléchargement, installation. Les événements de progression
  // arrivent par onStatus — le téléchargement est trop long pour une
  // réponse IPC (limite 30 s).
  update: {
    // v1.2.6 : la vraie version installée, lue dans le processus
    // principal — le rendu n'a plus aucune version en dur.
    getVersion: () => ipcRenderer.invoke('update:get-version'),
    getSettings: () => ipcRenderer.invoke('update:get-settings'),
    setSettings: (patch) => ipcRenderer.invoke('update:set-settings', patch),
    checkNow: () => ipcRenderer.invoke('update:check-now'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => ipcRenderer.on('update:status', (_event, payload) => cb(payload)),
  },
});
