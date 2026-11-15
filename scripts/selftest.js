// Lance l'application en auto-test (POH_SELFTEST=1) sous Xvfb si besoin,
// et enregistre les résultats + captures dans test-output/.
// Usage : npm run selftest   (ou : xvfb-run -a npm run selftest)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(root, '..', 'test-output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'selftest.json');
const shotsDir = path.join(outDir, 'shots');
fs.mkdirSync(shotsDir, { recursive: true });

const electronBin = path.join(root, '..', 'node_modules', '.bin', 'electron');
const freshProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-selftest-'));
const child = spawn(electronBin, ['.', '--user-data-dir=' + freshProfile], {
  cwd: path.join(root, '..'),
  env: {
    ...process.env,
    POH_SELFTEST: '1',
    POH_SELFTEST_OUT: outFile,
    POH_SELFTEST_SHOTS: shotsDir,
    ELECTRON_DISABLE_SANDBOX: '1',
  },
  stdio: 'inherit',
});

const timeout = setTimeout(() => {
  console.error('SELFTEST : délai dépassé (120 s), arrêt forcé.');
  child.kill('SIGKILL');
  process.exit(2);
}, 120000);

child.on('exit', (code) => {
  clearTimeout(timeout);
  if (fs.existsSync(outFile)) {
    const results = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    const ok = results.filter((r) => r.ok).length;
    console.log(`\nRésultat : ${ok}/${results.length} vérifications OK — détail dans test-output/selftest.json`);
    process.exit(ok === results.length ? 0 : 1);
  }
  console.error('SELFTEST : aucun fichier de résultat (code de sortie ' + code + ').');
  process.exit(1);
});
