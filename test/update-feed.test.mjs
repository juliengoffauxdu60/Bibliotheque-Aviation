// Tests du flux de mise à jour (v1.2.5) : lecture de latest.yml /
// latest-mac.yml, comparaison de versions, vérification sha512,
// téléchargement — contre un FAUX flux local (scripts/fake-update-feed),
// jamais contre GitHub.
// Usage : node test/update-feed.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  UPDATE_FEED, UpdateError, feedBase, latestYmlUrl, assetUrl,
  fetchText, parseLatestYml, compareVersions, isNewer,
  pickUpdateFile, sha512File, verifySha512, downloadFile,
  checkForUpdate,
} from '../main/update-feed.js';
import { startFakeFeed } from '../scripts/fake-update-feed.mjs';

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

// 1. Configuration : un seul point, pas de jeton.
check('dépôt du flux', [UPDATE_FEED.owner, UPDATE_FEED.repo], ['juliengoffauxdu60', 'Bibliotheque-Aviation']);
check('URL latest.yml (production)', latestYmlUrl('win32'), 'https://github.com/juliengoffauxdu60/Bibliotheque-Aviation/releases/latest/download/latest.yml');
check('URL latest-mac.yml (production)', latestYmlUrl('darwin'), 'https://github.com/juliengoffauxdu60/Bibliotheque-Aviation/releases/latest/download/latest-mac.yml');
check('assetUrl absolue inchangée', assetUrl('https://x.example/f.zip'), 'https://x.example/f.zip');
const feedSrc = fs.readFileSync(path.join(root, '..', 'main', 'update-feed.js'), 'utf8');
check('aucun jeton dans update-feed.js (ghp_)', !/ghp_[A-Za-z0-9]/.test(feedSrc), true);
check('aucun jeton dans update-feed.js (github_pat_)', !/github_pat_[A-Za-z0-9_]/.test(feedSrc), true);
check('aucun GH_TOKEN lu dans update-feed.js', !feedSrc.includes('GH_TOKEN'), true);

// 2. Analyse de latest.yml (format electron-builder, version entre
// guillemets ou non, un fichier Windows). Noms attendus : ceux produits
// par artifactName (${name}-${version}-${arch}.${ext}) — sans espace,
// identiques dans le yml et dans la Release (défaut bloquant v1.2.5).
const ymlWin = [
  'version: 1.2.5',
  'files:',
  '  - url: bibliotheque-aviation-1.2.5-x64.exe',
  '    sha512: QUJDREVGR0g=',
  '    size: 149763921',
  'path: bibliotheque-aviation-1.2.5-x64.exe',
  'sha512: QUJDREVGR0g=',
  "releaseDate: '2026-11-17T21:10:13.000Z'",
  '',
].join('\n');
const parsedWin = parseLatestYml(ymlWin);
check('latest.yml : version', parsedWin.version, '1.2.5');
check('latest.yml : 1 fichier', parsedWin.files.length, 1);
check('latest.yml : url', parsedWin.files[0].url, 'bibliotheque-aviation-1.2.5-x64.exe');
check('latest.yml : sha512', parsedWin.files[0].sha512, 'QUJDREVGR0g=');
check('latest.yml : taille', parsedWin.files[0].size, 149763921);

// 3. Analyse de latest-mac.yml (deux zips, un par architecture).
const ymlMac = [
  'version: 1.2.5',
  'files:',
  '  - url: bibliotheque-aviation-1.2.5-arm64.zip',
  '    sha512: YXJtNjQ=',
  '    size: 158249664',
  '  - url: bibliotheque-aviation-1.2.5-x64.zip',
  '    sha512: eDY0',
  '    size: 165468574',
  'path: bibliotheque-aviation-1.2.5-arm64.zip',
  'sha512: YXJtNjQ=',
  "releaseDate: '2026-11-17T21:10:13.000Z'",
  '',
].join('\n');
const parsedMac = parseLatestYml(ymlMac);
check('latest-mac.yml : version', parsedMac.version, '1.2.5');
check('latest-mac.yml : 2 fichiers', parsedMac.files.length, 2);
check('latest-mac.yml : choix arm64', pickUpdateFile(parsedMac.files, 'darwin', 'arm64').url, 'bibliotheque-aviation-1.2.5-arm64.zip');
check('latest-mac.yml : choix x64', pickUpdateFile(parsedMac.files, 'darwin', 'x64').url, 'bibliotheque-aviation-1.2.5-x64.zip');
check('latest.yml : choix exe', pickUpdateFile(parsedWin.files, 'win32', 'x64').url, 'bibliotheque-aviation-1.2.5-x64.exe');
check('latest.yml : pas de zip sur Windows', pickUpdateFile(parsedMac.files, 'win32', 'x64'), null);

// 4. latest.yml incompréhensible -> UpdateError en français.
await checkThrows('yml vide', async () => parseLatestYml(''), 'réponse vide');
await checkThrows('yml sans version', async () => parseLatestYml('files:\n  - url: x.exe\n'), 'incompréhensible');
await checkThrows('yml sans fichier', async () => parseLatestYml('version: 1.2.5\n'), 'incompréhensible');

// 5. Comparaison de versions.
check('comparer 1.2.5 > 1.2.4', compareVersions('1.2.5', '1.2.4'), 1);
check('comparer 1.2.4 < 1.2.5', compareVersions('1.2.4', '1.2.5'), -1);
check('comparer égales', compareVersions('1.2.5', '1.2.5'), 0);
check('comparer 1.10.0 > 1.2.0 (numérique)', compareVersions('1.10.0', '1.2.0'), 1);
check('comparer préfixe v toléré', compareVersions('v1.2.5', '1.2.4'), 1);
check('plus récent : oui', isNewer('9.9.9', '1.2.4'), true);
check('plus récent : non (même version)', isNewer('1.2.4', '1.2.4'), false);
check('plus récent : non (plus ancienne)', isNewer('1.2.3', '1.2.4'), false);

// 6. sha512 : vérification d'un vrai fichier, refus sinon.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-update-feed-'));
const sample = path.join(tmp, 'echantillon.bin');
fs.writeFileSync(sample, Buffer.from('contenu de test pour sha512', 'utf8'));
const digest = sha512File(sample);
check('sha512 : bon digest accepté', verifySha512(sample, digest), true);
check('sha512 : mauvais digest refusé', verifySha512(sample, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='), false);
check('sha512 : fichier absent refusé', verifySha512(path.join(tmp, 'absent.bin'), digest), false);
check('sha512 : digest vide refusé', verifySha512(sample, ''), false);

// 7. Flux complet contre le faux serveur local.
const feed = await startFakeFeed({ version: '9.9.9', appName: 'FausseAppli' });
process.env.POH_UPDATE_FEED = feed.base;
try {
  check('base du flux (test)', feedBase(), feed.base);
  check('URL latest-mac.yml (test)', latestYmlUrl('darwin'), feed.base + '/latest-mac.yml');

  // 7a. fetchText : 200, 404, redirection absente ici.
  const ok200 = await fetchText(feed.base + '/latest-mac.yml');
  check('fetchText 200', ok200.status, 200);
  check('fetchText contient la version', ok200.text.includes('version: 9.9.9'), true);
  const notFound = await fetchText(feed.base + '/inexistant.yml');
  check('fetchText 404', notFound.status, 404);
  await checkThrows('fetchText serveur coupé', async () => {
    await fetchText('http://127.0.0.1:1/rien.yml', { timeoutMs: 2000 });
  }, 'joindre le serveur');

  // 7b. Vérification : mise à jour disponible (9.9.9 > 1.2.4), bon
  // fichier choisi par architecture.
  const dispo = await checkForUpdate({ currentVersion: '1.2.4', platform: 'darwin', arch: 'arm64' });
  check('check : disponible', dispo.available, true);
  check('check : version', dispo.version, '9.9.9');
  check('check : fichier arm64', dispo.file.name, 'FausseAppli-9.9.9-arm64.zip');
  check('check : sha512 arm64', dispo.file.sha512, feed.zipArmSha512);
  const dispoX64 = await checkForUpdate({ currentVersion: '1.2.4', platform: 'darwin', arch: 'x64' });
  check('check : fichier x64', dispoX64.file.name, 'FausseAppli-9.9.9-x64.zip');
  const dispoWin = await checkForUpdate({ currentVersion: '1.2.4', platform: 'win32', arch: 'x64' });
  check('check Windows : disponible', dispoWin.available, true);
  check('check Windows : fichier exe', dispoWin.file.name, 'FausseAppli.Setup.9.9.9.exe');

  // 7c. Déjà à jour : rien à télécharger.
  const ajour = await checkForUpdate({ currentVersion: '9.9.9', platform: 'darwin', arch: 'arm64' });
  check('check : déjà à jour', ajour.available, false);
  check('check : déjà à jour, pas de fichier', ajour.file, null);

  // 7d. Flux inaccessible (404) : échec PROPRE, message français.
  const savedBase = process.env.POH_UPDATE_FEED;
  process.env.POH_UPDATE_FEED = feed.base + '/sous-dossier-absent';
  await checkThrows('check : flux 404 -> message clair', async () => {
    await checkForUpdate({ currentVersion: '1.2.4', platform: 'darwin', arch: 'arm64' });
  }, 'pas accessibles');
  process.env.POH_UPDATE_FEED = savedBase;

  // 7e. Téléchargement du zip + vérification de l'empreinte.
  const destZip = path.join(tmp, 'maj.zip');
  let lastProgress = null;
  const dl = await downloadFile(dispo.file.url, destZip, {
    onProgress: (p) => { lastProgress = p; },
  });
  check('download : taille reçue', dl.received > 0, true);
  check('download : progression vue', lastProgress !== null && lastProgress.received === dl.received, true);
  check('download : sha512 du zip OK', verifySha512(destZip, feed.zipArmSha512), true);
  check('download : sha512 du zip x64 refusé (mauvais fichier)', verifySha512(destZip, feed.zipX64Sha512), false);

  // 7f. Téléchargement d'une URL absente : échec propre, pas de
  // fichier partiel laissé.
  const destRaté = path.join(tmp, 'rate.zip');
  await checkThrows('download : 404 -> message clair', async () => {
    await downloadFile(feed.base + '/absent.zip', destRaté);
  }, 'introuvable');
  check('download : pas de fichier partiel', fs.existsSync(destRaté), false);
} finally {
  delete process.env.POH_UPDATE_FEED;
  await feed.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* nettoyage */ }
}

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
