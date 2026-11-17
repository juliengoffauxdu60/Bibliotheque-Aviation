// Tests du workflow et de l'emballage de la mise à jour (v1.2.5) :
// le flux zéro-artefact de la v1.2.4 est conservé EXACTEMENT, et la
// Release publie en plus les fichiers du flux de l'updater
// (latest.yml, latest-mac.yml, ZIP Mac). Vérifie aussi que la mise à
// jour ne peut pas fuiter de jeton, n'exige pas de signature
// Authenticode, et que le code macOS ne touche jamais à Squirrel.
// Usage : node test/update-workflow.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.join(root, '..');

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
function skip(name, why) { skipped++; console.log(`PASSÉ ${name} — ${why}`); }

const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
const workflow = fs.readFileSync(path.join(appRoot, '.github', 'workflows', 'build.yml'), 'utf8');
const mainUpdate = fs.readFileSync(path.join(appRoot, 'main-update.js'), 'utf8');
const updateFeed = fs.readFileSync(path.join(appRoot, 'main', 'update-feed.js'), 'utf8');
const macUpdate = fs.readFileSync(path.join(appRoot, 'main', 'mac-update.js'), 'utf8');

// 1. Version et dépendances.
check('version 1.2.5', pkg.version, '1.2.5');
check('electron-updater en dépendances', typeof pkg.dependencies['electron-updater'] === 'string', true);

// 2. Zéro artefact (invariant v1.2.4, 17 nov. 2026) — le quota GitHub
// de Julien a bloqué les v1.2.2/v1.2.3 : AUCUN upload/download
// d'artefact ne doit réapparaître.
check('workflow : aucun upload-artifact', !workflow.includes('upload-artifact'), true);
check('workflow : aucun download-artifact', !workflow.includes('download-artifact'), true);
// electron-builder ne publie jamais : le --publish never vit dans les
// scripts npm (build / dist / dist:mac) que le workflow appelle — et
// le workflow n'invoque jamais electron-builder directement.
check('scripts npm : --publish never partout', ['build', 'dist', 'dist:mac'].every((s) => (pkg.scripts[s] || '').includes('--publish never')), true);
check('workflow : aucun appel direct à electron-builder', !/electron-builder(?!.*--publish never)/.test(workflow.replace(/#.*$/gm, '')), true);
const codeLines = workflow.split('\n').filter((l) => !/^\s*#/.test(l));
check('workflow : 4 jobs (create + win + mac + publish)', ['create-release:', 'build-windows:', 'build-macos:', 'publish-release:'].every((j) => workflow.includes(j)), true);
check('workflow : 2 envois gh release upload', codeLines.filter((l) => l.includes('gh release upload')).length, 2);
check('workflow : 1 création de release', codeLines.filter((l) => l.includes('gh release create')).length, 1);
check('workflow : 1 publication', codeLines.filter((l) => l.includes('gh release edit')).length, 1);

// 3. Le flux de mise à jour est publié dans la Release.
check('workflow Windows : latest.yml envoyé', workflow.includes('dist/latest.yml'), true);
check('workflow macOS : latest-mac.yml envoyé', workflow.includes('dist/latest-mac.yml'), true);
check('workflow macOS : ZIP envoyés', workflow.includes('dist/*.zip'), true);
check('workflow Windows : exe toujours envoyé', workflow.includes('dist/*.exe'), true);
check('workflow macOS : DMG toujours envoyés', workflow.includes('dist/*.dmg'), true);

// 4. Emballage : les ZIP Mac sont construits, les nouveaux fichiers
// du processus principal sont livrés dans l'installateur.
check('mac : cible zip présente', Array.isArray(pkg.build.mac.target) && pkg.build.mac.target.includes('zip'), true);
check('mac : cible dmg toujours présente', Array.isArray(pkg.build.mac.target) && pkg.build.mac.target.includes('dmg'), true);
check('mac : signature ad-hoc conservée', pkg.build.mac.identity, '-');
// 4b. Noms des installateurs (défaut bloquant de la première tentative
// v1.2.5, 17 nov. 2026) : sans artifactName, electron-builder écrit
// dans latest.yml un nom « sûr » en tirets alors que `gh release
// upload` publie l'asset avec des points — l'updater ferait 404.
// artifactName sans espace = nom sur disque = nom du yml = nom publié.
check('artifactName : noms sans espace', pkg.build.artifactName, '${name}-${version}-${arch}.${ext}');
check('artifactName : aucun espace littéral', !/\s/.test(pkg.build.artifactName || ''), true);
check('build.files : main-update.js livré', pkg.build.files.includes('main-update.js'), true);
check('build.files : main/**/* livré', pkg.build.files.includes('main/**/*'), true);
check('flux : provider github, dépôt unique', pkg.build.publish.provider === 'github' && pkg.build.publish.owner === 'juliengoffauxdu60' && pkg.build.publish.repo === 'Bibliotheque-Aviation', true);

// 5. Pas de signature Authenticode exigée : nsis.publisherName ne doit
// JAMAIS être défini (l'updater exigerait alors des mises à jour
// signées, et nos builds ne le sont pas).
check('win : pas de nsis.publisherName', !('publisherName' in (pkg.build.win || {})), true);

// 6. Aucun jeton dans le code de mise à jour (décision reportée :
// flux public, lecture anonyme — un jeton commité serait une fuite).
for (const [label, src] of [['main-update.js', mainUpdate], ['main/update-feed.js', updateFeed], ['main/mac-update.js', macUpdate]]) {
  check(`aucun jeton ghp_ dans ${label}`, !/ghp_[A-Za-z0-9]/.test(src), true);
  check(`aucun jeton github_pat_ dans ${label}`, !/github_pat_[A-Za-z0-9_]/.test(src), true);
  check(`aucun GH_TOKEN lu dans ${label}`, !src.includes('GH_TOKEN'), true);
}

// 7. macOS ne touche JAMAIS à Squirrel : le module maison n'importe
// pas electron-updater, et la colle ne l'appelle que sur win32. Les
// commentaires sont exclus du contrôle (l'en-tête explique justement
// pourquoi Squirrel est refusé).
const stripComments = (src) => src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const macCode = stripComments(macUpdate);
check('mac-update.js : pas d’electron-updater', !macCode.includes('electron-updater') && !macCode.includes('autoUpdater'), true);
check('mac-update.js : pas de quitAndInstall', !macCode.includes('quitAndInstall'), true);
check('mac-update.js : pas de downloadUpdate', !macCode.includes('downloadUpdate'), true);
check('main-update.js : downloadUpdate présent (Windows)', mainUpdate.includes('downloadUpdate'), true);
check('main-update.js : quitAndInstall présent (Windows)', mainUpdate.includes('quitAndInstall'), true);
check('main-update.js : chemin win32 gardé', mainUpdate.includes("platform === 'win32'"), true);
check('main-update.js : chemin darwin gardé', mainUpdate.includes("platform === 'darwin'"), true);
check('main-update.js : relance macOS maison', mainUpdate.includes('app.relaunch()'), true);

// 8. Les nouveaux fichiers existent et sont importés par la colle.
for (const f of ['main/update-feed.js', 'main/mac-update.js', 'main-update.js', 'scripts/fake-update-feed.mjs']) {
  check(`fichier présent : ${f}`, fs.existsSync(path.join(appRoot, f)), true);
}
check('main-update.js : importe le flux', mainUpdate.includes("from './main/update-feed.js'"), true);
check('main-update.js : importe le module macOS', mainUpdate.includes("from './main/mac-update.js'"), true);

// 9. La fenêtre Réglages expose la section Mises à jour (la colle IPC
// existe côté préchargeur : update:get-settings et update:check-now).
const preload = fs.readFileSync(path.join(appRoot, 'preload.cjs'), 'utf8');
check('preload : update:get-settings', preload.includes('update:get-settings'), true);
check('preload : update:check-now', preload.includes('update:check-now'), true);
check('preload : update:download', preload.includes('update:download'), true);
check('preload : update:install', preload.includes('update:install'), true);
check('preload : update:onStatus', preload.includes('update:status'), true);
const settingsHtml = fs.readFileSync(path.join(appRoot, 'renderer', 'ai-settings.html'), 'utf8');
check('Réglages : case « Vérifier automatiquement »', settingsHtml.includes('id="updateAutoCheck"'), true);
check('Réglages : bouton « Vérifier maintenant »', settingsHtml.includes('id="updateCheckNowBtn"'), true);
const indexHtml = fs.readFileSync(path.join(appRoot, 'renderer', 'index.html'), 'utf8');
check('page principale : bannière de mise à jour', indexHtml.includes('id="updateBanner"'), true);

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
