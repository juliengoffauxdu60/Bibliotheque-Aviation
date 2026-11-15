// Faux module « electron » pour les tests Node de main-ai.js.
// Rôle double :
//  1. Module de personnalisation (module.register) : toute importation de
//     'electron' est résolue vers ce fichier (hook resolve ci-dessous).
//  2. Faux app / ipcMain / safeStorage / BrowserWindow : userData pointe
//     vers un dossier temporaire, les handlers IPC sont enregistrés dans
//     `handlers` (le test les appelle directement), et safeStorage chiffre
//     en « FAUX-CHIFFRE:… » en comptant chaque appel — ce qui permet de
//     PROUVER que l'affichage des réglages ne déchiffre jamais.
// Aucune vraie clé n'est utilisée ici : que des fausses clés de test.
// Note : ce fichier est aussi chargé dans le fil des hooks de Node
// (module.register) ; les compteurs et handlers utiles vivent dans
// l'instance du fil principal, importée directement par le test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-ai-test-'));
export const handlers = new Map();
export const safeStorageCalls = { encrypt: 0, decrypt: 0 };

export const app = {
  getPath: () => userDataDir,
};

export const ipcMain = {
  handle: (channel, fn) => { handlers.set(channel, fn); },
};

// main-import.js importe aussi `dialog` (sélecteur de fichier) : le faux
// refuse l'ouverture (annulé) — le test du refresh ne l'appelle jamais,
// mais l'import du module exige que le nom soit exporté.
export const dialog = {
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => {
    safeStorageCalls.encrypt++;
    return Buffer.from('FAUX-CHIFFRE:' + s, 'utf8');
  },
  decryptString: (buf) => {
    safeStorageCalls.decrypt++;
    const t = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
    if (!t.startsWith('FAUX-CHIFFRE:')) throw new Error('tampon inconnu');
    return t.slice('FAUX-CHIFFRE:'.length);
  },
};

export class BrowserWindow {
  constructor() {}
  on() {}
  loadURL() {}
  focus() {}
  isDestroyed() { return false; }
}

// Hook de personnalisation des modules : 'electron' -> ce fichier.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL(import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
