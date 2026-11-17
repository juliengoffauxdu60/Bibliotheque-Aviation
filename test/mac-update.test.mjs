// Tests de l'installation macOS maison (v1.2.5) : remplacement du
// .app par l'application elle-même, sur un FAUX .app dans un dossier
// temporaire — jamais sur une vraie application. Sur Linux, l'extraction
// passe par `unzip` (ou python3 -m zipfile) injecté, et la plateforme
// est forcée (testOverride) : le code de production n'accepte que
// darwin.
// Usage : node test/mac-update.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UpdateError } from '../main/update-feed.js';
import {
  bundleDirFromExe, readAppVersion, installMacUpdate,
} from '../main/mac-update.js';
import { startFakeFeed, createStoredZip } from '../scripts/fake-update-feed.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log(`PASSÉ ${name} — ${why}`); }
async function checkThrows(name, fn, expectPart) {
  try {
    await fn();
    console.log(`ÉCHEC ${name} — aucune erreur levée`);
    failures++;
  } catch (e) {
    const ok = e instanceof UpdateError && (!expectPart || String(e.userMessage).includes(expectPart));
    console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — ${ok ? 'UpdateError : ' + e.userMessage : 'mauvaise erreur : ' + (e && e.message)}`);
    if (!ok) failures++;
  }
}

// Extraction de test (Linux) : `unzip` si présent, sinon python3.
// Le code de production utilise `ditto` sur macOS — jamais ici.
function extractTest(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('unzip', ['-q', '-o', zipPath, '-d', destDir], (err) => {
      if (!err) return resolve();
      execFile('python3', ['-m', 'zipfile', '-e', zipPath, destDir], (err2) => {
        if (err2) reject(new UpdateError(`Extraction de test impossible (${err2.message}).`));
        else resolve();
      });
    });
  });
}

// 1. Chemin de l'exécutable -> dossier .app.
check('bundle depuis exe', bundleDirFromExe('/Applications/Bibliotheque Aviation.app/Contents/MacOS/Bibliotheque Aviation'), '/Applications/Bibliotheque Aviation.app');
await checkThrows('bundle : chemin non .app refusé', async () => {
  bundleDirFromExe('/usr/bin/quelque-chose');
}, 'trouver l’application');

// 2. Garde plateforme : sur Linux sans testOverride, refus.
const feed = await startFakeFeed({ version: '9.9.9', appName: 'FausseAppli' });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-mac-update-'));
try {
  await checkThrows('garde : plateforme non-mac refusée', async () => {
    await installMacUpdate({
      zipPath: path.join(tmp, 'rien.zip'),
      expectedSha512: 'x',
      appDir: feed.fakeAppDir,
      platform: 'linux',
    });
  }, 'macOS');

  // 3. Remplacement complet : la fausse appli 1.2.4 devient 9.9.9
  // (arm64), l'ancienne est en sauvegarde avec son contenu intact.
  const zipArm = path.join(tmp, 'maj-arm64.zip');
  {
    const { downloadFile } = await import('../main/update-feed.js');
    process.env.POH_UPDATE_FEED = feed.base;
    const dispo = await (await import('../main/update-feed.js')).checkForUpdate({ currentVersion: '1.2.4', platform: 'darwin', arch: 'arm64' });
    await downloadFile(dispo.file.url, zipArm);
    delete process.env.POH_UPDATE_FEED;
  }
  check('version installée avant : 1.2.4', readAppVersion(feed.fakeAppDir), '1.2.4');
  const res = await installMacUpdate({
    zipPath: zipArm,
    expectedSha512: feed.zipArmSha512,
    appDir: feed.fakeAppDir,
    platform: 'linux',
    extractFn: extractTest,
    testOverride: true,
  });
  check('remplacement : ok', res.ok, true);
  check('remplacement : nouvelle version', res.newVersion, '9.9.9');
  check('remplacement : version.txt = 9.9.9', fs.readFileSync(path.join(feed.fakeAppDir, 'Contents', 'Resources', 'version.txt'), 'utf8').trim(), '9.9.9');
  check('remplacement : arch arm64', fs.readFileSync(path.join(feed.fakeAppDir, 'Contents', 'Resources', 'arch.txt'), 'utf8').trim(), 'arm64');
  check('remplacement : sauvegarde présente', Boolean(res.backupDir) && fs.existsSync(res.backupDir), true);
  // La sauvegarde, c'est le dossier .app lui-même, déplacé tel quel.
  const backupApp = res.backupDir;
  check('remplacement : sauvegarde = ancienne 1.2.4', readAppVersion(backupApp), '1.2.4');
  check('remplacement : sauvegarde version.txt = 1.2.4', fs.readFileSync(path.join(backupApp, 'Contents', 'Resources', 'version.txt'), 'utf8').trim(), '1.2.4');

  // 4. Empreinte différente : refus AVANT tout remplacement — la
  // 9.9.9 installée ne bouge pas.
  await checkThrows('sha512 : mauvaise empreinte refusée', async () => {
    await installMacUpdate({
      zipPath: zipArm,
      expectedSha512: feed.zipX64Sha512, // empreinte de l'autre zip
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      testOverride: true,
    });
  }, 'corrompue');
  check('sha512 : appli intacte après refus', readAppVersion(feed.fakeAppDir), '9.9.9');

  // 5. Zip sans .app : refus, appli intacte.
  const zipVide = path.join(tmp, 'vide.zip');
  fs.writeFileSync(zipVide, createStoredZip([{ path: 'rien.txt', content: 'vide' }]));
  const { sha512File } = await import('../main/update-feed.js');
  await checkThrows('zip sans .app refusé', async () => {
    await installMacUpdate({
      zipPath: zipVide,
      expectedSha512: sha512File(zipVide),
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      testOverride: true,
    });
  }, 'pas d’application');
  check('zip sans .app : appli intacte', readAppVersion(feed.fakeAppDir), '9.9.9');

  // 6. Zip absent : refus, appli intacte.
  await checkThrows('zip absent refusé', async () => {
    await installMacUpdate({
      zipPath: path.join(tmp, 'absent.zip'),
      expectedSha512: feed.zipArmSha512,
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      testOverride: true,
    });
  }, 'introuvable');
  check('zip absent : appli intacte', readAppVersion(feed.fakeAppDir), '9.9.9');

  // 7. Échec pendant le remplacement : l'ancien est restauré.
  // On casse l'extraction pour que le .app extrait soit invalide
  // (pas de Contents/Info.plist) : refus avant toute sauvegarde.
  const zipInvalide = path.join(tmp, 'invalide.zip');
  fs.writeFileSync(zipInvalide, createStoredZip([
    { path: 'FausseAppli.app/Contents/MacOS/FausseAppli', content: 'x' },
  ]));
  await checkThrows('app invalide refusée', async () => {
    await installMacUpdate({
      zipPath: zipInvalide,
      expectedSha512: sha512File(zipInvalide),
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      testOverride: true,
    });
  }, 'incomplète');
  check('app invalide : appli intacte', readAppVersion(feed.fakeAppDir), '9.9.9');

  // 8. Restauration : le déplacement du nouveau échoue (déplacement
  // injecté qui lève pour le 2e appel) -> l'ancien revient en place,
  // avec son contenu intact.
  let moves = 0;
  const moveFragile = (from, to) => {
    moves++;
    if (moves === 2) throw new Error('disque plein (simulé)');
    fs.renameSync(from, to);
  };
  await checkThrows('restauration : échec du déplacement', async () => {
    await installMacUpdate({
      zipPath: zipArm,
      expectedSha512: feed.zipArmSha512,
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      moveFn: moveFragile,
      testOverride: true,
    });
  }, 'restaurée');
  check('restauration : appli revenue à 9.9.9', readAppVersion(feed.fakeAppDir), '9.9.9');
  check('restauration : version.txt intact', fs.readFileSync(path.join(feed.fakeAppDir, 'Contents', 'Resources', 'version.txt'), 'utf8').trim(), '9.9.9');

  // 9. App installée invalide (fichier, pas un dossier) : refus avant
  // tout déplacement.
  const sauve = feed.fakeAppDir + '.sauve-test';
  fs.renameSync(feed.fakeAppDir, sauve);
  fs.writeFileSync(feed.fakeAppDir, 'fichier, pas un dossier');
  await checkThrows('app installée invalide refusée', async () => {
    await installMacUpdate({
      zipPath: zipArm,
      expectedSha512: feed.zipArmSha512,
      appDir: feed.fakeAppDir,
      platform: 'linux',
      extractFn: extractTest,
      testOverride: true,
    });
  }, 'trouver l’application');
  fs.unlinkSync(feed.fakeAppDir);
  fs.renameSync(sauve, feed.fakeAppDir);
  check('app installée invalide : appli restaurée 9.9.9', readAppVersion(feed.fakeAppDir), '9.9.9');
} finally {
  await feed.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nettoyage */ }
}

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
