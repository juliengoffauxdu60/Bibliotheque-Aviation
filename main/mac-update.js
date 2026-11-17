// Mise à jour macOS maison — remplacement du .app par l'application
// elle-même, sans Squirrel.Mac ni certificat Apple (99 $/an refusés).
//
// POURQUOI PAS Squirrel.Mac (electron-updater) : ShipIt valide l'appli
// téléchargée contre l'exigence désignée de l'appli EN COURS, et une
// signature ad-hoc a pour exigence un cdhash par build — CHAQUE mise à
// jour est donc rejetée (« Code signature … did not pass validation »).
// C'est prouvé par d'autres applis (dota2-companion, sync-multi-chat) :
// il n'y a pas de contournement côté Squirrel. La vérification du flux
// (latest-mac.yml) reste la même que partout ailleurs ; seul
// l'INSTALLATION change : on télécharge le zip soi-même, on vérifie son
// sha512 contre latest-mac.yml, on remplace le .app (sauvegarde d'abord,
// restauration en cas d'échec), puis on relance.
//
// Deux propriétés de ce chemin, vérifiées par ces mêmes applis :
//  - les fichiers téléchargés par l'appli elle-même ne portent PAS de
//    drapeau de quarantaine : pas de clic droit à refaire après mise à
//    jour (contrairement à un DMG téléchargé dans Safari) ;
//  - l'empreinte sha512 est vérifiée AVANT tout remplacement : un
//    fichier corrompu ou incomplet ne touche jamais à l'appli installée.
//
// Ce module ne dépend pas d'Electron : il ne prend que des chemins et
// des fonctions injectables (plateforme, extraction) — il est donc
// testable en Node sur un faux .app, et sur Linux dans l'auto-test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { verifySha512, UpdateError } from './update-feed.js';

// exe …/X.app/Contents/MacOS/X  ->  …/X.app
export function bundleDirFromExe(exePath) {
  const macos = path.dirname(exePath);
  const contents = path.dirname(macos);
  const bundle = path.dirname(contents);
  if (path.basename(macos) !== 'MacOS' || path.basename(contents) !== 'Contents' || !/\.app$/i.test(bundle)) {
    throw new UpdateError('Impossible de trouver l’application installée (chemin inattendu).');
  }
  return bundle;
}

// Extraction du zip. Par défaut : `ditto -x -k`, l'outil système de
// macOS (toujours présent, préserve la signature ad-hoc). Injectée dans
// les tests (sur Linux, `unzip` ou python3 -m zipfile).
export function extractZipDitto(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    execFile('ditto', ['-x', '-k', zipPath, destDir], (err) => {
      if (err) reject(new UpdateError(`Impossible d’ouvrir la mise à jour téléchargée (${err.message}).`));
      else resolve();
    });
  });
}

function findAppInDir(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new UpdateError('Impossible de lire la mise à jour téléchargée.');
  }
  const apps = entries.filter((e) => e.isDirectory() && /\.app$/i.test(e.name)).map((e) => path.join(dir, e.name));
  if (apps.length === 0) {
    // Le zip d'electron-builder met le .app à la racine ; tolère un
    // niveau de dossier en plus, pas plus.
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      try {
        const inner = fs.readdirSync(sub, { withFileTypes: true })
          .filter((x) => x.isDirectory() && /\.app$/i.test(x.name))
          .map((x) => path.join(sub, x.name));
        apps.push(...inner);
      } catch { /* dossier illisible : ignoré */ }
    }
  }
  if (apps.length === 0) {
    throw new UpdateError('La mise à jour téléchargée ne contient pas d’application (zip incomplet).');
  }
  return apps[0];
}

function isValidAppDir(appDir) {
  return fs.existsSync(path.join(appDir, 'Contents', 'Info.plist'))
    && fs.existsSync(path.join(appDir, 'Contents', 'MacOS'));
}

export function readAppVersion(appDir) {
  try {
    const plist = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8');
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

// Remplace le .app installé par celui du zip (déjà vérifié).
// Ordre strict : vérifier -> extraire -> sauvegarder l'ancien ->
// mettre le nouveau -> en cas d'échec APRES la sauvegarde, restaurer.
// L'ancien .app n'est JAMAIS supprimé avant que le nouveau soit en
// place ; la sauvegarde reste dans le dossier temporaire du système
// (restauration manuelle possible, le dossier est rendu dans le résultat).
export async function installMacUpdate({
  zipPath,
  expectedSha512,
  appDir,
  platform = process.platform,
  extractFn = extractZipDitto,
  // Déplacement injectable (tests uniquement) : par défaut fs.renameSync.
  moveFn = fs.renameSync,
  testOverride = false,
}) {
  if (platform !== 'darwin' && !testOverride) {
    throw new UpdateError('Cette installation ne concerne que macOS.');
  }
  if (!appDir || !fs.existsSync(appDir) || !isValidAppDir(appDir)) {
    throw new UpdateError('Impossible de trouver l’application installée à remplacer.');
  }
  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new UpdateError('Le fichier de mise à jour téléchargé est introuvable.');
  }
  if (!verifySha512(zipPath, expectedSha512)) {
    throw new UpdateError('La mise à jour téléchargée est corrompue (empreinte différente de celle publiée). L’application actuelle n’a pas été touchée.');
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliotheque-aviation-maj-'));
  let newApp = null;
  let backupDir = null;
  try {
    await extractFn(zipPath, workDir);
    newApp = findAppInDir(workDir);
    if (!isValidAppDir(newApp)) {
      throw new UpdateError('La mise à jour téléchargée est incomplète (application invalide).');
    }
    backupDir = path.join(os.tmpdir(), `bibliotheque-aviation-sauvegarde-${process.pid}-${Date.now()}`);
    moveFn(appDir, backupDir);
    try {
      moveFn(newApp, appDir);
    } catch (moveErr) {
      // Le nouveau n'a pas pu prendre la place : on remet l'ancien.
      try { moveFn(backupDir, appDir); backupDir = null; } catch { /* l'ancien est perdu, la sauvegarde reste */ }
      throw new UpdateError(`Impossible d’installer la mise à jour (${moveErr.message}). L’ancienne version a été restaurée.`);
    }
    return { ok: true, backupDir, newVersion: readAppVersion(appDir) };
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError(`Impossible d’installer la mise à jour (${e.message}).`);
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* nettoyage non bloquant */ }
  }
}
