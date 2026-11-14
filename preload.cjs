// Preload — volontairement minimal : l'application est 100 % locale et le rendu
// n'a besoin d'aucun accès Node, sauf l'import de POH et les réglages IA,
// qui passent par des canaux IPC nommés. La clé IA reste dans le processus
// principal (main-ai.js) et n'est jamais transmise en clair au rendu.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pohDesktop', {
  version: '1.0.0',
  platform: process.platform,
  import: {
    list: () => ipcRenderer.invoke('poh-import:list'),
    chooseFile: () => ipcRenderer.invoke('poh-import:choose-file'),
    importFile: (filePath) => ipcRenderer.invoke('poh-import:import-file', { filePath }),
    ocrPage: (docId, pdfPage, pngBase64) => ipcRenderer.invoke('poh-import:ocr-page', { docId, pdfPage, pngBase64 }),
    ocrFinish: (docId) => ipcRenderer.invoke('poh-import:ocr-finish', { docId }),
    ocrCancel: (docId) => ipcRenderer.invoke('poh-import:ocr-cancel', { docId }),
    deleteDoc: (docId) => ipcRenderer.invoke('poh-import:delete', { docId }),
    hiddenList: () => ipcRenderer.invoke('poh-import:hidden-list'),
    hideDoc: (docId) => ipcRenderer.invoke('poh-import:hide-doc', { docId }),
    unhideDoc: (docId) => ipcRenderer.invoke('poh-import:unhide-doc', { docId }),
  },
  ai: {
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (settings) => ipcRenderer.invoke('ai:save-settings', settings),
    clearKey: () => ipcRenderer.invoke('ai:clear-key'),
    ask: (payload) => ipcRenderer.invoke('ai:ask', payload),
    test: () => ipcRenderer.invoke('ai:test'),
    openSettings: () => ipcRenderer.invoke('ai:open-settings'),
  },
});
