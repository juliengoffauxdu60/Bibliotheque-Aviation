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
check('version 1.2.8', pkg.version, '1.2.8');
check('licence GPL-3.0 dans package.json', pkg.license, 'GPL-3.0');
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
check('page principale : libellé de version', indexHtml.includes('id="appVersionLabel"'), true);
check('page principale : bouton « Vérifier les mises à jour »', indexHtml.includes('id="updateCheckBtn"'), true);
const appJs = fs.readFileSync(path.join(appRoot, 'renderer', 'app.js'), 'utf8');
check('app.js : version lue par IPC (getVersion)', appJs.includes('getVersion()') && appJs.includes('appVersionLabel'), true);
check('app.js : bouton d’en-tête câblé (updateCheckBtn)', appJs.includes("getElementById('updateCheckBtn')") || appJs.includes("$('updateCheckBtn')"), true);

// 10. Version affichée (v1.2.6) : plus aucune version en dur côté
// rendu — la vraie version vient du processus principal (IPC).
check('preload : update:get-version', preload.includes('update:get-version'), true);
check('preload : plus de version en dur 1.0.0', !preload.includes("version: '1.0.0'"), true);
check('main-update.js : IPC update:get-version', mainUpdate.includes("ipcMain.handle('update:get-version'"), true);
check('main-update.js : détail d’erreur assaini (sanitizeErrorDetail)', mainUpdate.includes('sanitizeErrorDetail'), true);
check('main-update.js : détail transmis au statut d’erreur', mainUpdate.includes("sendStatus({ type: 'error', message, detail: detail || undefined })"), true);
const aiSettingsJs = fs.readFileSync(path.join(appRoot, 'renderer', 'ai-settings.js'), 'utf8');
check('Réglages : test de fond (ai:test-start)', aiSettingsJs.includes('testStart') && aiSettingsJs.includes('ai:test-start'), true);
check('Réglages : progression du test écoutée', aiSettingsJs.includes('onTestProgress') && aiSettingsJs.includes('bindTestEvents'), true);
check('Réglages : fin du test écoutée', aiSettingsJs.includes('onTestDone') && aiSettingsJs.includes('pendingTestResolve'), true);
check('preload : canaux ai:test-progress / ai:test-done', preload.includes('ai:test-progress') && preload.includes('ai:test-done'), true);
check('Réglages : plus de boucle de 2 essais', !aiSettingsJs.includes('attempt < 2'), true);
check('Réglages : libellé version installée', settingsHtml.includes('id="installedVersionLabel"'), true);
check('Réglages : ligne de détail d’erreur', settingsHtml.includes('id="updateDetail"'), true);
const mainAi = fs.readFileSync(path.join(appRoot, 'main-ai.js'), 'utf8');
check('main-ai.js : IPC ai:test-start', mainAi.includes("ipcMain.handle('ai:test-start'"), true);
check('main-ai.js : événements ai:test-progress / ai:test-done', mainAi.includes('ai:test-progress') && mainAi.includes('ai:test-done'), true);
check('main-ai.js : budget de test 120 s', mainAi.includes('AI_TEST_BUDGET_MS = 120000') || mainAi.includes('120000'), true);
check('main-ai.js : ai:test conservé (compatibilité)', mainAi.includes("ipcMain.handle('ai:test'"), true);

// 11. Licence et page projet (v1.2.6) : fichiers présents, licence
// complète, page bilingue, modèles simples, phrase d'accord présente.
const licenseText = fs.readFileSync(path.join(appRoot, 'LICENSE'), 'utf8');
check('LICENSE : titre GPL', licenseText.includes('GNU GENERAL PUBLIC LICENSE'), true);
check('LICENSE : version 3 du 29 juin 2007', licenseText.includes('Version 3, 29 June 2007'), true);
check('LICENSE : fin des conditions', licenseText.includes('END OF TERMS AND CONDITIONS'), true);
check('LICENSE : 18 sections (0 à 17)', ['0. Definitions', '17. Interpretation'].every((s) => licenseText.includes(s)), true);
const readme = fs.readFileSync(path.join(appRoot, 'README.md'), 'utf8');
check('README : partie française d’abord (téléchargement en tête)', readme.indexOf('Télécharger et installer') < readme.indexOf('# Bibliothèque Aviation (English version)'), true);
check('README : traduction anglaise complète', readme.includes('Download and install the application'), true);
check('README : aucune commande dans la partie utilisateurs', !readme.slice(0, readme.indexOf('Pour les développeurs')).includes('npm install'), true);
check('README : développeurs en dernière partie', readme.includes('Pour les développeurs') && readme.includes('For developers'), true);
const contributing = fs.readFileSync(path.join(appRoot, 'CONTRIBUTING.md'), 'utf8');
check('CONTRIBUTING : phrase d’accord FR', contributing.includes('je conserve mes droits sur mon code'), true);
check('CONTRIBUTING : phrase d’accord EN', contributing.includes('I keep my rights to my code'), true);
check('CONTRIBUTING : traduction anglaise', contributing.includes('Contributing — Bibliothèque Aviation (English version)'), true);
for (const f of ['.github/ISSUE_TEMPLATE/bug-report.md', '.github/ISSUE_TEMPLATE/suggestion.md', '.github/PULL_REQUEST_TEMPLATE.md']) {
  check(`modèle présent : ${f}`, fs.existsSync(path.join(appRoot, f)), true);
}
const prTemplate = fs.readFileSync(path.join(appRoot, '.github', 'PULL_REQUEST_TEMPLATE.md'), 'utf8');
check('modèle PR : case à cocher pour l’accord', prTemplate.includes('je conserve mes droits sur mon code'), true);

console.log(failures === 0
  ? `\nTOUS LES TESTS PASSENT (${skipped} passé(s))`
  : `\n${failures} ÉCHEC(S) (${skipped} passé(s))`);
process.exit(failures === 0 ? 0 : 1);
