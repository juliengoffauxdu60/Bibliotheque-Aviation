// Faux flux de mise à jour (TESTS UNIQUEMENT — jamais livré dans
// l'application) : sert latest.yml / latest-mac.yml + un zip de test
// depuis un serveur HTTP local, pour prouver tout le flux
// vérification -> téléchargement -> vérification d'empreinte ->
// remplacement, sans GitHub et sans Internet.
// Usage :
//   const feed = await startFakeFeed({ version: '9.9.9', appName: 'FausseAppli' });
//   // feed.base = 'http://127.0.0.1:PORT' (à mettre dans POH_UPDATE_FEED)
//   // feed.fakeAppDir = dossier 'FausseAppli.app' à remplacer
//   // feed.zipSha512 / feed.zipArmSha512 / feed.zipX64Sha512
//   await feed.stop();
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// CRC32 (table) — un zip « stored » (sans compression) n'a besoin que
// de ça : pas de dépendance pour écrire un zip valide.
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Écrit un zip « stored » (méthode 0, sans compression) à partir de
// fichiers { path, content: Buffer|string } — dossiers créés d'office.
export function createStoredZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const seenDirs = new Set();
  const addDir = (dir) => {
    if (!dir || seenDirs.has(dir)) return;
    seenDirs.add(dir);
    const name = Buffer.from(dir + '/', 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0, 8);
    head.writeUInt32LE(0, 14);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt16LE(0x10, 38); // attribut dossier
    cent.writeUInt32LE(offset, 42);
    cent.writeUInt16LE(name.length, 28);
    central.push(cent, name);
    offset += 30 + name.length;
  };
  for (const f of files) {
    const filePath = f.path.replace(/\\/g, '/');
    const dirParts = filePath.split('/').slice(0, -1);
    let acc = '';
    for (const d of dirParts) { acc = acc ? acc + '/' + d : d; addDir(acc); }
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(String(f.content), 'utf8');
    const name = Buffer.from(filePath, 'utf8');
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    parts.push(head, name, data);
    const cent = Buffer.alloc(46);
    cent.writeUInt32LE(0x02014b50, 0);
    cent.writeUInt16LE(20, 4);
    cent.writeUInt16LE(20, 6);
    cent.writeUInt32LE(crc, 16);
    cent.writeUInt32LE(data.length, 20);
    cent.writeUInt32LE(data.length, 24);
    cent.writeUInt16LE(name.length, 28);
    cent.writeUInt32LE(offset, 42);
    central.push(cent, name);
    offset += 30 + name.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

function plistFor(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>CFBundleShortVersionString</key>\n\t<string>${version}</string>\n\t<key>CFBundleName</key>\n\t<string>FausseAppli</string>\n</dict>\n</plist>\n`;
}

export async function startFakeFeed({ version = '9.9.9', appName = 'FausseAppli' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'poh-fake-feed-'));
  const fakeAppDir = path.join(root, `${appName}.app`);
  // La fausse appli installée (version 1.2.4) : c'est elle que la mise
  // à jour doit remplacer.
  const installedVersion = '1.2.4';
  for (const [dir, file, content] of [
    [path.join(fakeAppDir, 'Contents', 'MacOS'), appName, '#!/bin/sh\necho fausse appli\n'],
    [path.join(fakeAppDir, 'Contents'), 'Info.plist', plistFor(installedVersion)],
    [path.join(fakeAppDir, 'Contents', 'Resources'), 'version.txt', installedVersion + '\n'],
    [path.join(fakeAppDir, 'Contents', 'Resources'), 'arch.txt', 'arm64\n'],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  // Le zip de mise à jour (version du flux) : deux variantes, une par
  // architecture — le contenu diffère (arch.txt) pour prouver le choix.
  const zipFor = (arch) => createStoredZip([
    { path: `${appName}.app/Contents/MacOS/${appName}`, content: '#!/bin/sh\necho fausse appli mise à jour\n' },
    { path: `${appName}.app/Contents/Info.plist`, content: plistFor(version) },
    { path: `${appName}.app/Contents/Resources/version.txt`, content: version + '\n' },
    { path: `${appName}.app/Contents/Resources/arch.txt`, content: arch + '\n' },
  ]);
  const zipArm = zipFor('arm64');
  const zipX64 = zipFor('x64');
  const sha = (buf) => crypto.createHash('sha512').update(buf).digest('base64');
  const zipArmName = `${appName}-${version}-arm64.zip`;
  const zipX64Name = `${appName}-${version}-x64.zip`;
  const exeName = `${appName}.Setup.${version}.exe`;
  const exeBuf = Buffer.from('faux-installateur-windows-' + version, 'utf8');
  const latestMac = [
    `version: ${version}`,
    'files:',
    `  - url: ${zipArmName}`,
    `    sha512: ${sha(zipArm)}`,
    `    size: ${zipArm.length}`,
    `  - url: ${zipX64Name}`,
    `    sha512: ${sha(zipX64)}`,
    `    size: ${zipX64.length}`,
    `path: ${zipArmName}`,
    `sha512: ${sha(zipArm)}`,
    `releaseDate: '2026-11-17T00:00:00.000Z'`,
    '',
  ].join('\n');
  const latestWin = [
    `version: ${version}`,
    'files:',
    `  - url: ${exeName}`,
    `    sha512: ${sha(exeBuf)}`,
    `    size: ${exeBuf.length}`,
    `path: ${exeName}`,
    `sha512: ${sha(exeBuf)}`,
    `releaseDate: '2026-11-17T00:00:00.000Z'`,
    '',
  ].join('\n');
  const routes = new Map([
    ['/latest-mac.yml', { type: 'text/yaml', body: Buffer.from(latestMac, 'utf8') }],
    ['/latest.yml', { type: 'text/yaml', body: Buffer.from(latestWin, 'utf8') }],
    [`/${zipArmName}`, { type: 'application/zip', body: zipArm }],
    [`/${zipX64Name}`, { type: 'application/zip', body: zipX64 }],
    [`/${exeName}`, { type: 'application/octet-stream', body: exeBuf }],
  ]);
  const server = http.createServer((req, res) => {
    const hit = routes.get(req.url);
    if (!hit) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('introuvable');
      return;
    }
    res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.body.length });
    res.end(hit.body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    root,
    fakeAppDir,
    zipArmName,
    zipX64Name,
    zipArmSha512: sha(zipArm),
    zipX64Sha512: sha(zipX64),
    exeName,
    exeSha512: sha(exeBuf),
    version,
    stop: () => new Promise((resolve) => {
      server.close(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* nettoyage non bloquant */ }
        resolve();
      });
    }),
  };
}
