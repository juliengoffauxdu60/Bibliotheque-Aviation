// Préchargeur du harnais E2E IA — copie EXACTE du patch préchargeur proposé
// pour preload.cjs (voir rapport). Sert uniquement aux tests ; il n'est
// jamais copié dans l'application.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pohDesktop', {
  platform: process.platform,
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    ask: (payload) => ipcRenderer.invoke('ai:ask', payload),
    test: () => ipcRenderer.invoke('ai:test'),
    testStart: () => ipcRenderer.invoke('ai:test-start'),
    onTestProgress: (cb) => ipcRenderer.on('ai:test-progress', (_event, payload) => cb(payload)),
    onTestDone: (cb) => ipcRenderer.on('ai:test-done', (_event, payload) => cb(payload)),
    openSettings: () => ipcRenderer.invoke('ai:open-settings'),
  },
});
