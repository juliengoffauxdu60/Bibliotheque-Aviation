// Lance l'application en auto-test (POH_SELFTEST=1) sous Xvfb si besoin,
// et enregistre les résultats + captures dans test-output/.
// Usage : npm run selftest   (ou : xvfb-run -a npm run selftest)
//
// Mise à jour (v1.2.5) : un FAUX flux local est démarré avant Electron
// (scripts/fake-update-feed.mjs) — latest.yml / latest-mac.yml + zip
// de test, version 9.9.9 — et passé par variables d'environnement
// (POH_UPDATE_FEED, POH_UPDATE_FAKE_PLATFORM=darwin,
// POH_UPDATE_TEST_APP=<fausse .app 1.2.4>). L'auto-test prouve ainsi
// tout le flux de mise à jour sans GitHub ; le serveur est arrêté à
// la fin, quoi qu'il arrive.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeFeed } from './fake-update-feed.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, '..', 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'selftest.json');
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const feed = await startFakeFeed({ version: '9.9.9', appName: 'FausseAppli' });
console.log(`SELFTEST : faux flux de mise à jour sur ${feed.base} (fausse appli ${feed.fakeAppDir})`);

const electronBin = path.join(root, '..', 'node_modules', '.bin', 'electron');
const freshProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-selftest-'));
const child = spawn(electronBin, ['.', '--user-data-dir=' + freshProfile], {
  cwd: path.join(root, '..'),
  env: {
    ...process.env,
    POH_SELFTEST: '1',
    POH_SELFTEST_OUT: outFile,
    POH_SELFTEST_SHOTS: shotsDir,
    POH_UPDATE_FEED: feed.base,
    POH_UPDATE_FAKE_PLATFORM: 'darwin',
    POH_UPDATE_TEST_APP: feed.fakeAppDir,
    ELECTRON_DISABLE_SANDBOX: '1',
  },
  stdio: 'inherit',
});

const timeout = setTimeout(async () => {
  console.error('SELFTEST : délai dépassé (120 s), arrêt forcé.');
  child.kill('SIGKILL');
  await feed.stop();
  process.exit(2);
}, 120000);

child.on('exit', async (code) => {
  clearTimeout(timeout);
  await feed.stop();
  if (fs.existsSync(outFile)) {
    const results = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const ok = results.filter((r) => r.ok).length;
    console.log(`\nRésultat : ${ok}/${results.length} vérifications OK — détail dans test-output/selftest.json`);
    process.exit(ok === results.length ? 0 : 1);
  }
  console.error('SELFTEST : aucun fichier de résultat (code de sortie ' + code + ').');
  process.exit(1);
});
