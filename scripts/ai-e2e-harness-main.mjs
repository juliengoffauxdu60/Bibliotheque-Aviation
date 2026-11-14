// Harnais Electron du test E2E IA — lancé par scripts/ai-e2e.mjs.
// Enregistre les VRAIS handlers de main-ai.js, sert app:// depuis la racine
// du workspace (hôte « e2e » -> scripts/, pour la page de test), puis pilote
// la page Réglages IA et la zone « Poser une question » dans la vraie
// application. Ne modifie AUCUN fichier de l'application.
// Variables d'environnement : POH_AI_E2E_ROOT, POH_AI_E2E_OUT, POH_AI_E2E_MOCK.
import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = process.env.POH_AI_E2E_ROOT;
const OUT = process.env.POH_AI_E2E_OUT;
const MOCK = process.env.POH_AI_E2E_MOCK;
const FAKE_KEY = 'sk-fausse-cle-1234';
const QUESTION = 'Quelle est la vitesse de décrochage du 172N ?';

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf',
};

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: String(detail ?? '') });
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — ${detail ?? ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let win;
const js = (code) => win.webContents.executeJavaScript(code);
const step = (n, label) => console.log(`--- étape ${n} : ${label}`);
async function waitFor(code, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await js(code);
      if (v) return v;
    } catch { /* pas encore prêt */ }
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé pour : ' + code);
    await sleep(300);
  }
}

async function runAll() {
  // D'abord charger une page : executeJavaScript n'a pas de contexte
  // d'exécution tant qu'aucun document n'est chargé (appel bloqué).
  await win.loadURL('app://e2e/ai-e2e-ask.html');
  await waitFor(`typeof window.__pohAi !== 'undefined'`);
  await waitFor(`window.__pohAi.ready().then(() => true)`);
  const online = await js('navigator.onLine');
  // Le flux question passe par le fournisseur « local » quand la machine
  // est hors réseau (la garde hors réseau de ai.js laisse passer le local,
  // qui tourne sur l'ordinateur) — sinon par « custom ».
  const askProvider = online ? 'custom' : 'local';
  check('réseau : état lu (le flux question utilise ce fournisseur)', true,
    `navigator.onLine=${online} -> fournisseur ${askProvider}`);

  // 1. Sans configuration : la question ne part pas, l'appli l'explique.
  step(1, 'sans configuration');
  await js(`window.__pohAi.ask(${JSON.stringify(QUESTION)})`);
  let answer = await js(`window.__pohAi.answerText()`);
  check('sans configuration : message clair, pas d’appel', answer.includes('Aucune IA n’est configurée'), answer.slice(0, 140));
  check('sans configuration : bandeau visible', await js(`window.__pohAi.notConfiguredVisible()`), '');
  const enc = await js(`window.pohDesktop.ai.getSettings().then(s => s.settings.encryptionAvailable)`);
  check('chiffrement système : état lu', typeof enc === 'boolean', 'encryptionAvailable=' + enc);

  // 2. Page Réglages : enregistrer une fausse clé.
  step(2, 'enregistrer une fausse clé');
  await win.loadURL('app://renderer/ai-settings.html');
  await waitFor(`typeof window.__pohAiSettings !== 'undefined'`);
  await sleep(500);
  let status = await js(`window.__pohAiSettings.save({provider:'custom', model:'modele-factice', endpoint: ${JSON.stringify(MOCK + '/v1/chat/completions')}, key: ${JSON.stringify(FAKE_KEY)}})`);
  await sleep(800);
  status = await js(`window.__pohAiSettings.state().status`);
  check('réglages : enregistrement', status.includes('Réglages enregistrés'), status);
  let st = await js(`window.__pohAiSettings.state()`);
  check('réglages : clé masquée •••• + 4 derniers, jamais en clair',
    st.keyState.includes('••••1234') && !st.keyState.includes(FAKE_KEY), st.keyState);

  // 3. Persistance après rechargement de la page.
  step(3, 'persistance après rechargement');
  await win.loadURL('app://renderer/ai-settings.html');
  await waitFor(`typeof window.__pohAiSettings !== 'undefined'`);
  await sleep(500);
  st = await js(`window.__pohAiSettings.state()`);
  check('réglages : clé toujours là après rechargement, masquée', st.keyState.includes('••••1234'), st.keyState);

  // 4. Fichier sur disque : pas de clé en clair si le chiffrement est dispo.
  const settingsFile = path.join(app.getPath('userData'), 'ai-settings.json');
  const stored = fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : '';
  if (enc) {
    check('stockage : clé chiffrée (absente en clair du fichier)', !stored.includes(FAKE_KEY), 'fichier=' + settingsFile);
  } else {
    check('stockage : repli fichier (chiffrement indisponible sur cette machine)',
      stored.includes('"keyMethod": "plain"'), 'chiffrement indisponible ici, repli documenté');
  }

  // 5. Test de connexion sur les 3 formes d'API (faux serveur).
  step(5, 'tests de connexion custom/gemini/claude');
  let t = await js(`window.pohDesktop.ai.test()`);
  check('test connexion custom (faux serveur)', t.ok && String(t.answer).includes('Réponse du faux serveur'), JSON.stringify(t).slice(0, 140));
  await js(`window.pohDesktop.ai.saveSettings({provider:'gemini', model:'modele-factice', endpoint: ${JSON.stringify(MOCK + '/v1beta/models/{model}:generateContent')}, key:''})`);
  t = await js(`window.pohDesktop.ai.test()`);
  check('test connexion gemini (faux serveur, forme Gemini)', t.ok && String(t.answer).includes('Réponse du faux serveur'), JSON.stringify(t).slice(0, 140));
  await js(`window.pohDesktop.ai.saveSettings({provider:'claude', model:'modele-factice', endpoint: ${JSON.stringify(MOCK + '/v1/messages')}, key:''})`);
  t = await js(`window.pohDesktop.ai.test()`);
  check('test connexion claude (faux serveur, forme Claude)', t.ok && String(t.answer).includes('Réponse du faux serveur'), JSON.stringify(t).slice(0, 140));

  // 6. Ouvrir la fenêtre Réglages depuis le rendu (ai:open-settings).
  step(6, 'ouvrir la fenêtre Réglages');
  await js(`window.pohDesktop.ai.openSettings()`);
  await sleep(1200);
  const wins = BrowserWindow.getAllWindows();
  const extra = wins.find((w) => w !== win);
  check('open-settings : une fenêtre Réglages s’ouvre sur la bonne page',
    wins.length === 2 && extra && extra.webContents.getURL() === 'app://renderer/ai-settings.html',
    `fenêtres=${wins.length} url=${extra ? extra.webContents.getURL() : 'aucune'}`);
  if (extra) extra.close();

  // 7. Flux question : d'abord le serveur coupé (point fermé).
  step(7, 'question, serveur coupé');
  await js(`window.pohDesktop.ai.saveSettings({provider: ${JSON.stringify(askProvider)}, model:'modele-factice', endpoint: ${JSON.stringify(MOCK + '/v1/chat/completions')}, key:''})`);
  await win.loadURL('app://e2e/ai-e2e-ask.html');
  await waitFor(`typeof window.__pohAi !== 'undefined'`);
  await waitFor(`window.__pohAi.ready().then(() => true)`);
  await js(`window.pohDesktop.ai.saveSettings({provider: ${JSON.stringify(askProvider)}, model:'modele-factice', endpoint:'http://127.0.0.1:1/v1/chat/completions', key:''})`);
  await js(`window.__pohAi.ask(${JSON.stringify(QUESTION)})`);
  answer = await js(`window.__pohAi.answerText()`);
  check('serveur coupé : message clair, sans jargon', answer.includes('Impossible de joindre'), answer.slice(0, 180));

  // 8. Flux question : le faux serveur répond, extraits envoyés, sources listées.
  step(8, 'question, faux serveur');
  await js(`window.pohDesktop.ai.saveSettings({provider: ${JSON.stringify(askProvider)}, model:'modele-factice', endpoint: ${JSON.stringify(MOCK + '/v1/chat/completions')}, key:''})`);
  await js(`window.__pohAi.ask(${JSON.stringify(QUESTION)})`);
  answer = await js(`window.__pohAi.answerText()`);
  const m = answer.match(/Extraits reçus : (\d+)/);
  const n = m ? parseInt(m[1], 10) : -1;
  check('question -> réponse affichée', answer.includes('Réponse du faux serveur'), answer.slice(0, 140));
  check('extraits des POH envoyés comme contexte (>= 1)', n >= 1, 'extraits=' + n);
  const nSrc = await js(`window.__pohAi.sourcesCount()`);
  check('sources listées sous la réponse', nSrc >= 1, 'sources=' + nSrc);

  // 9. Clic sur une source -> navigation (faux __poh enregistré).
  await js(`document.querySelector('.ai-source').click()`);
  await sleep(500);
  const called = await js(`window.__pohCalled || null`);
  check('clic source : ouvre le document à la bonne page',
    called && typeof called.doc === 'string' && Number.isInteger(called.page) && called.page > 0,
    JSON.stringify(called));

  // 10. Clé absente (OpenAI sans clé) : message clair, pas d'appel.
  step(10, 'clé absente');
  await js(`window.pohDesktop.ai.clearKey()`);
  await js(`window.pohDesktop.ai.saveSettings({provider:'openai', model:'gpt-4o-mini', endpoint:'https://api.openai.com/v1/chat/completions', key:''})`);
  const noKey = await js(`window.pohDesktop.ai.ask({question: ${JSON.stringify(QUESTION)}, context: [{docTitle:'POH Cessna 172N', sectionLabel:'Section 5 — Performances', pageLabel:'p. 5-12', excerpt:'La vitesse de décrochage est de 48 kt.'}]})`);
  check('clé absente : message clair, pas d’appel', !noKey.ok && String(noKey.error).includes('Il manque la clé API'), JSON.stringify(noKey).slice(0, 180));

  // 11. Clé effacée : elle a disparu (page + fichier).
  step(11, 'clé effacée');
  await win.loadURL('app://renderer/ai-settings.html');
  await waitFor(`typeof window.__pohAiSettings !== 'undefined'`);
  await sleep(500);
  st = await js(`window.__pohAiSettings.state()`);
  check('clé effacée : la page indique aucune clé', st.keyState.includes('Aucune clé enregistrée'), st.keyState);
  let keyGone = false;
  try { keyGone = !JSON.parse(fs.readFileSync(settingsFile, 'utf8') || '{}').keyValue; } catch { keyGone = false; }
  check('clé effacée : le fichier ne contient plus de clé', keyGone, 'fichier=' + settingsFile);
}

app.whenReady().then(async () => {
  const safety = setTimeout(() => {
    try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch { /* ignore */ }
    app.quit();
  }, 150000);
  try {
    protocol.handle('app', (request) => {
      const url = new URL(request.url);
      let base = ROOT;
      let rel;
      if (url.host === 'e2e') {
        base = path.join(ROOT, 'scripts');
        rel = decodeURIComponent(url.pathname).replace(/^\//, '');
      } else {
        rel = decodeURIComponent(url.host + url.pathname);
        if (rel.startsWith('/')) rel = rel.slice(1);
      }
      if (!rel) rel = 'renderer/index.html';
      const filePath = path.normalize(path.join(base, rel));
      if (!filePath.startsWith(base)) return new Response('Interdit', { status: 403 });
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response('Introuvable : ' + rel, { status: 404 });
      }
      const body = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      return new Response(body, {
        status: 200,
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': String(body.length),
          'Access-Control-Allow-Origin': '*',
        },
      });
    });

    const { registerAiHandlers } = await import(pathToFileURL(path.join(ROOT, 'main-ai.js')).href);
    registerAiHandlers();

    win = new BrowserWindow({
      width: 1280,
      height: 860,
      title: 'Recherche POH — harnais E2E IA',
      webPreferences: {
        preload: path.join(ROOT, 'scripts', 'ai-e2e-preload.cjs'),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    win.webContents.on('console-message', (e, level, message) => {
      console.log(`[rendu:${level}] ${message}`);
    });
    await runAll();
  } catch (e) {
    check('harnais : erreur inattendue', false, String((e && e.message) || e));
  } finally {
    clearTimeout(safety);
    try { fs.writeFileSync(OUT, JSON.stringify(results, null, 2)); } catch { /* ignore */ }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
