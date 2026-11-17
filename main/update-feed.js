// Flux de mise à jour — logique pure, sans Electron (testable en Node).
// UN SEUL point de configuration : le dépôt GitHub des Releases.
// AUCUN jeton ici, jamais : le flux est lu en HTTPS anonyme. Contre le
// dépôt privé actuel, GitHub répond 404 — c'est un échec PROPRE (message
// français clair, pas de plantage). Le jour où les versions seront
// publiques (ou lues avec un jeton — décision reportée par Julien), le
// même code fonctionnera sans changement : il ne fait que lire le
// fichier latest.yml / latest-mac.yml publié par electron-builder.
//
// Formats lus (écrits par electron-builder dans dist/ à chaque build) :
//   latest.yml     — version, files: [{ url: <exe>, sha512, size }]
//   latest-mac.yml — version, files: [{ url: <zip arm64>, ... },
//                                      { url: <zip x64>, ... }]
// Les fichiers latest-*.yml sont les seuls fichiers du flux : la
// vérification ne touche jamais à l'API GitHub (pas de jeton, pas de
// limite de débit).
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import crypto from 'node:crypto';

export const UPDATE_FEED = {
  owner: 'juliengoffauxdu60',
  repo: 'Bibliotheque-Aviation',
};

// Erreur présentable : message français, jamais de détail technique brut.
export class UpdateError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UpdateError';
    this.userMessage = message;
  }
}

// Base du flux. En production : les assets de la dernière Release.
// POH_UPDATE_FEED est un crochet de TEST UNIQUEMENT (auto-test Electron
// + tests Node) : il remplace la base par un serveur local.
export function feedBase() {
  const override = (process.env.POH_UPDATE_FEED || '').trim();
  if (override) return override.replace(/\/+$/, '');
  return `https://github.com/${UPDATE_FEED.owner}/${UPDATE_FEED.repo}/releases/latest/download`;
}

export function latestYmlFile(platform) {
  return platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
}

export function latestYmlUrl(platform) {
  return `${feedBase()}/${latestYmlFile(platform)}`;
}

// URL de téléchargement d'un fichier du flux (url nu = nom de fichier
// dans la Release ; url absolue = telle quelle).
export function assetUrl(fileUrl) {
  if (/^https?:\/\//i.test(fileUrl)) return fileUrl;
  return `${feedBase()}/${fileUrl}`;
}

// GET avec suivi des redirections (GitHub /releases/latest/download
// répond 302 vers l'asset de la dernière Release) et délai borné.
export function fetchText(url, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (current, hops) => {
      let u;
      try {
        u = new URL(current);
      } catch {
        reject(new UpdateError('L’adresse du serveur des mises à jour est invalide.'));
        return;
      }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.get(u, { headers: { 'User-Agent': 'Bibliotheque-Aviation' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) {
            reject(new UpdateError('Le serveur des mises à jour renvoie trop de redirections.'));
            return;
          }
          follow(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') });
        });
        res.on('error', () => {
          reject(new UpdateError('Impossible de joindre le serveur des mises à jour (connexion coupée).'));
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new UpdateError('Le serveur des mises à jour ne répond pas (délai dépassé). Vérifiez votre connexion.'));
      });
      req.on('error', (e) => {
        if (e instanceof UpdateError) reject(e);
        else reject(new UpdateError('Impossible de joindre le serveur des mises à jour (pas de connexion ou serveur injoignable).'));
      });
    };
    follow(url, 0);
  });
}

function unquote(value) {
  const v = value.trim();
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1);
  }
  return v;
}

// Analyse minimale du YAML d'electron-builder (js-yaml, style par
// défaut) : version, files: [{ url, sha512, size }], path, sha512.
// Rien d'autre n'est lu — pas de parseur YAML complet, le format est
// fixe et ces champs suffisent à vérifier + télécharger.
export function parseLatestYml(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new UpdateError('Le serveur des mises à jour a renvoyé une réponse vide.');
  }
  const out = { version: '', files: [], path: '', sha512: '' };
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const fileMatch = /^  - (\S.*)$/.exec(line);
    if (fileMatch) {
      current = {};
      out.files.push(current);
      const kv = /^(\w[\w-]*):\s*(.*)$/.exec(fileMatch[1].trim());
      if (kv) current[kv[1]] = kv[1] === 'size' ? Number(kv[2]) : unquote(kv[2]);
      continue;
    }
    const indented = /^    (\w[\w-]*):\s*(.*)$/.exec(line);
    if (indented && current) {
      current[indented[1]] = indented[1] === 'size' ? Number(indented[2]) : unquote(indented[2]);
      continue;
    }
    const top = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (top) {
      current = null;
      if (top[1] === 'version') out.version = unquote(top[2]);
      else if (top[1] === 'path') out.path = unquote(top[2]);
      else if (top[1] === 'sha512') out.sha512 = unquote(top[2]);
    }
  }
  if (!out.version) {
    throw new UpdateError('Le serveur des mises à jour a renvoyé une réponse incompréhensible (pas de version).');
  }
  out.files = out.files.filter((f) => typeof f.url === 'string' && f.url);
  if (out.files.length === 0) {
    throw new UpdateError('Le serveur des mises à jour a renvoyé une réponse incompréhensible (aucun fichier).');
  }
  return out;
}

// Comparaison de versions « 1.2.5 » (segments numériques, préfixe « v »
// toléré). -1 / 0 / 1.
export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.');
  const pb = String(b || '').replace(/^v/, '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number(pa[i] || 0);
    const nb = Number(pb[i] || 0);
    if (Number.isFinite(na) && Number.isFinite(nb)) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (String(pa[i] || '') !== String(pb[i] || '')) {
      return String(pa[i] || '') < String(pb[i] || '') ? -1 : 1;
    }
  }
  return 0;
}

export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// Choix du fichier à télécharger pour cette plateforme / architecture.
// Windows : l'exe. macOS : le zip dont le nom contient l'architecture
// (arm64 / x64 — latest-mac.yml liste les deux).
export function pickUpdateFile(files, platform, arch) {
  const list = Array.isArray(files) ? files : [];
  if (platform === 'darwin') {
    const zips = list.filter((f) => /\.zip$/i.test(f.url));
    if (arch === 'arm64') {
      return zips.find((f) => /arm64/i.test(f.url)) || zips[0] || null;
    }
    // x64 : electron-builder nomme le zip x64 SANS suffixe d'architecture
    // (le zip arm64 porte '-arm64') — on prend le premier zip sans 'arm64'.
    // Un nom explicite '-x64' passe aussi par ce filtre.
    return zips.find((f) => !/arm64/i.test(f.url)) || zips[0] || null;
  }
  return list.find((f) => /\.exe$/i.test(f.url)) || null;
}

export function sha512File(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

export function verifySha512(filePath, expectedBase64) {
  try {
    if (typeof expectedBase64 !== 'string' || !expectedBase64) return false;
    const actual = Buffer.from(sha512File(filePath), 'base64');
    const expected = Buffer.from(expectedBase64, 'base64');
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// Téléchargement avec progression ({ received, total, percent }) et
// nettoyage du fichier partiel en cas d'échec.
export function downloadFile(url, destPath, { timeoutMs = 120000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (current, hops) => {
      let u;
      try {
        u = new URL(current);
      } catch {
        reject(new UpdateError('L’adresse du fichier de mise à jour est invalide.'));
        return;
      }
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.get(u, { headers: { 'User-Agent': 'Bibliotheque-Aviation' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (hops >= 5) {
            reject(new UpdateError('Le serveur des mises à jour renvoie trop de redirections.'));
            return;
          }
          follow(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new UpdateError(res.statusCode === 404
            ? 'Le fichier de mise à jour est introuvable sur le serveur.'
            : `Le téléchargement de la mise à jour a échoué (serveur : ${res.statusCode}).`));
          return;
        }
        const total = Number(res.headers['content-length']) || null;
        let received = 0;
        const out = fs.createWriteStream(destPath);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (typeof onProgress === 'function') {
            onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
          }
        });
        res.pipe(out);
        out.on('finish', () => resolve({ received, total }));
        out.on('error', (e) => {
          try { fs.unlinkSync(destPath); } catch { /* déjà absent */ }
          reject(new UpdateError(`Impossible d’enregistrer la mise à jour téléchargée (${e.message}).`));
        });
        res.on('error', () => {
          try { fs.unlinkSync(destPath); } catch { /* déjà absent */ }
          reject(new UpdateError('Le téléchargement de la mise à jour a été coupé.'));
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new UpdateError('Le téléchargement de la mise à jour a mis trop de temps (délai dépassé).'));
      });
      req.on('error', (e) => {
        if (e instanceof UpdateError) reject(e);
        else reject(new UpdateError('Impossible de joindre le serveur des mises à jour (pas de connexion ou serveur injoignable).'));
      });
    };
    follow(url, 0);
  });
}

// Vérification complète contre le flux : lit latest.yml / latest-mac.yml,
// compare avec la version courante, choisit le fichier. Renvoie
// { available, version, currentVersion, file } — file est null quand il
// n'y a rien de plus récent. Lève UpdateError (message français) quand
// le flux est inaccessible ou illisible : l'appelant ne doit JAMAIS
// laisser passer une erreur technique brute ni planter.
export async function checkForUpdate({ currentVersion, platform, arch, fetchTextFn = fetchText }) {
  const url = latestYmlUrl(platform);
  let res;
  try {
    res = await fetchTextFn(url, { timeoutMs: 15000 });
  } catch (e) {
    if (e instanceof UpdateError) throw e;
    throw new UpdateError('Impossible de joindre le serveur des mises à jour (pas de connexion ou serveur injoignable).');
  }
  if (!res || res.status === 404 || res.status === 403) {
    throw new UpdateError('Impossible de vérifier les mises à jour : les versions ne sont pas accessibles pour le moment. Vérifiez votre connexion et réessayez plus tard.');
  }
  if (!res || res.status !== 200) {
    throw new UpdateError(`Impossible de vérifier les mises à jour (le serveur a répondu ${res ? res.status : 'sans réponse'}). Réessayez plus tard.`);
  }
  const parsed = parseLatestYml(res.text);
  const file = pickUpdateFile(parsed.files, platform, arch);
  if (!file) {
    throw new UpdateError('Aucune mise à jour publiée pour cette plateforme.');
  }
  const available = isNewer(parsed.version, currentVersion);
  return {
    available,
    version: parsed.version,
    currentVersion,
    file: available ? { url: assetUrl(file.url), name: file.url, sha512: file.sha512 || '', size: file.size || null } : null,
  };
}
