// Tests de l'icône de l'application (v1.2.7) : le fichier source existe,
// c'est un PNG 1024×1024, et la configuration de build pointe dessus.
// Sans ce fichier, electron-builder retomberait sur l'icône par défaut
// d'Electron — ce test est le contrôle bloquant du cahier des charges
// (CAHIER-DES-CHARGES-LOGO.md).
// Usage : node test/icon.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const project = path.dirname(root);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}

const iconPath = path.join(project, 'build', 'icon.png');
check('build/icon.png existe', fs.existsSync(iconPath), true);

let format = '';
let width = 0;
let height = 0;
if (fs.existsSync(iconPath)) {
  const buf = fs.readFileSync(iconPath);
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  format = buf.subarray(0, 8).equals(signature) ? 'png' : 'inconnu';
  if (format === 'png' && buf.length >= 24) {
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  }
}
check('build/icon.png est un PNG', format, 'png');
check('build/icon.png fait 1024 de large', width, 1024);
check('build/icon.png fait 1024 de haut', height, 1024);

const pkg = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf-8'));
check('package.json build.icon pointe sur build/icon.png', pkg.build && pkg.build.icon, 'build/icon.png');
check('version 1.2.7', pkg.version, '1.2.7');
check('cahier des charges du logo présent', fs.existsSync(path.join(project, 'CAHIER-DES-CHARGES-LOGO.md')), true);

console.log(failures === 0 ? '\nICÔNE OK' : `\n${failures} ÉCHEC(S) icône`);
process.exit(failures === 0 ? 0 : 1);
