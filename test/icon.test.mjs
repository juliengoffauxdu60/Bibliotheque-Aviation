// Tests de l'icône de l'application (v1.2.8) : le fichier source existe,
// c'est un PNG RVBA 1024×1024 aux coins transparents, et la configuration
// de build pointe dessus.
// Sans ce fichier, electron-builder retomberait sur l'icône par défaut
// d'Electron — ce test est le contrôle bloquant du cahier des charges
// (CAHIER-DES-CHARGES-LOGO.md). La transparence des coins est le correctif
// v1.2.8 : le PNG v1.2.7 était RVB, coins blancs peints, visibles sur le
// bureau Windows.
// Usage : node test/icon.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

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
check('version 1.2.8', pkg.version, '1.2.8');
check('cahier des charges du logo présent', fs.existsSync(path.join(project, 'CAHIER-DES-CHARGES-LOGO.md')), true);

// Transparence des coins (v1.2.8) : décodage PNG sans dépendance —
// type de couleur 6 (RVBA), 8 bits, non entrelacé, puis décompression
// zlib + défiltrage des scanlines pour lire les alphas réels.
let colorType = -1;
let bitDepth = -1;
let interlace = -1;
let cornerAlphas = null;
let centerAlpha = null;
let holesInArtwork = null;
if (format === 'png') {
  const buf = fs.readFileSync(iconPath);
  let pos = 8;
  const idat = [];
  let w2 = 0;
  let h2 = 0;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w2 = data.readUInt32BE(0);
      h2 = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 8 + len + 4;
  }
  if (colorType === 6 && bitDepth === 8 && interlace === 0 && w2 > 0 && h2 > 0) {
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const bpp = 4;
    const stride = w2 * bpp;
    const px = Buffer.alloc(w2 * h2 * bpp);
    let src = 0;
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h2; y++) {
      const filter = raw[src++];
      const line = raw.subarray(src, src + stride);
      src += stride;
      const out = px.subarray(y * stride, (y + 1) * stride);
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? out[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (filter === 1) v = (v + a) & 0xff;
        else if (filter === 2) v = (v + b) & 0xff;
        else if (filter === 3) v = (v + Math.floor((a + b) / 2)) & 0xff;
        else if (filter === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
        }
        out[i] = v;
      }
      prev = Buffer.from(out);
    }
    const alphaAt = (x, y) => px[(y * w2 + x) * bpp + 3];
    cornerAlphas = [alphaAt(0, 0), alphaAt(w2 - 1, 0), alphaAt(0, h2 - 1), alphaAt(w2 - 1, h2 - 1)];
    centerAlpha = alphaAt(Math.floor(w2 / 2), Math.floor(h2 / 2));
    let holes = 0;
    for (let y = 256; y < 768; y++) {
      for (let x = 256; x < 768; x++) {
        if (alphaAt(x, y) === 0) holes++;
      }
    }
    holesInArtwork = holes;
  }
}
check('build/icon.png est RVBA (type de couleur 6)', colorType, 6);
check('build/icon.png 8 bits', bitDepth, 8);
check('build/icon.png non entrelacé', interlace, 0);
check('build/icon.png coins transparents (alpha 0)', cornerAlphas, [0, 0, 0, 0]);
check('build/icon.png centre opaque (alpha 255)', centerAlpha, 255);
check('build/icon.png aucun trou transparent au centre', holesInArtwork, 0);

console.log(failures === 0 ? '\nICÔNE OK' : `\n${failures} ÉCHEC(S) icône`);
process.exit(failures === 0 ? 0 : 1);
