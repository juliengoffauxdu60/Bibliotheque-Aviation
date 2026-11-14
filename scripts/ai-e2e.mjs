// Test de bout en bout de l'IA dans la vraie application Electron.
// Lance le serveur IA factice, puis l'application (profil neuf) sous Xvfb,
// avec le harnais scripts/ai-e2e-harness-main.mjs qui enregistre les VRAIS
// handlers main-ai.js et pilote la page Réglages IA + la zone de question.
// Usage : node scripts/ai-e2e.mjs   (ou : xvfb-run -a node scripts/ai-e2e.mjs)
// Sortie : résultats dans la console (+ fichier temporaire indiqué à la fin).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockServer } from './ai-mock-server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE_KEY = 'sk-fausse-cle-1234';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-ai-e2e-'));
const profile = path.join(tmp, 'profile');
const outFile = path.join(tmp, 'results.json');

const mock = await startMockServer(0, { expectedKey: FAKE_KEY });
console.log(`Faux serveur IA : ${mock.baseUrl}`);

const electronBin = path.join(root, 'node_modules', '.bin', 'electron');
const harness = path.join(root, 'scripts', 'ai-e2e-harness-main.mjs');
const child = spawn('xvfb-run', ['-a', electronBin, harness, '--user-data-dir=' + profile], {
  cwd: root,
  env: {
    ...process.env,
    ELECTRON_DISABLE_SANDBOX: '1',
    POH_AI_E2E_ROOT: root,
    POH_AI_E2E_OUT: outFile,
    POH_AI_E2E_MOCK: mock.baseUrl,
  },
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  console.error('E2E : délai dépassé (180 s), arrêt forcé.');
  child.kill('SIGKILL');
}, 180000);

const code = await new Promise((resolve) => child.on('exit', (c) => {
  clearTimeout(timeout);
  resolve(c);
}));

let results = [];
try { results = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* pas de résultats */ }

// Vérification côté serveur factice : la dernière requête portait bien la
// clé déchiffrée et les extraits (preuve que la clé stockée a été relue et
// que le contexte a été envoyé).
let last = null;
try { last = await (await fetch(mock.baseUrl + '/__last')).json(); } catch { /* serveur arrêté */ }
if (last && last.path) {
  results.push({
    name: 'serveur factice : clé déchiffrée bien envoyée',
    ok: last.keyMatchesExpected === true,
    detail: 'path=' + last.path,
  });
  results.push({
    name: 'serveur factice : extraits reçus dans le prompt',
    ok: (last.excerptCount || 0) >= 1,
    detail: 'extraits=' + last.excerptCount,
  });
}
await mock.close();

const okCount = results.filter((r) => r.ok).length;
console.log(`\nE2E IA : ${okCount}/${results.length} vérifications OK`);
for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'ÉCHEC'} ${r.name} — ${r.detail}`);
console.log(`Détail : ${outFile} (profil temporaire : ${tmp})`);
process.exit(code === 0 && results.length > 0 && okCount === results.length ? 0 : 1);
