// highlight.js — Surlignage des termes cherchés dans le lecteur (v1.1.3).
//
// Module PUR (aucun DOM, aucun import pdf.js) : il est importé par
// renderer/app.js ET par les tests Node (node test/highlight.test.mjs).
// Deux sources de positions, même sortie (rectangles en points PDF) :
//   - PDF à vrai texte : items getTextContent() { str, x, y, width, height,
//     transform? } (x, y = origine de la ligne de base, y croissant vers
//     le haut ; transform = matrice [a, b, c, d, e, f] qui porte la
//     rotation — indispensable pour le texte vertical).
//   - PDF scanné : boîtes de mots OCR { text, bbox } en pixels d'image,
//     origine en haut à gauche.
// La conversion points PDF -> px CSS se fait dans app.js avec le viewport
// pdf.js du rendu courant (convertToViewportPoint, qui gère la rotation
// et le zoom : cette version de pdf.js n'a pas de convertToViewportRectangle),
// ici on ne fait que des points PDF.
//
// Correspondance : insensible à la casse et aux accents, en mot entier
// (comme la recherche) ; on ne surligne que les correspondances
// normalisées exactes — aucun flou inventé pour les mots OCR mal
// reconnus. Phrases : un rectangle par segment de ligne, jamais un gros
// rectangle qui enjambe deux lignes.
import { buildTermRegex } from './search.js';

// Normalisation de comparaison : minuscules, sans accents, apostrophes
// unifiées, espaces repliés. Même règle que la recherche (search.js).
export function normalizeForMatch(s) {
  return (s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Apostrophes typographiques -> droite (échappements \u explicites :
    // les caractères collés dans une classe se confondent facilement).
    .replace(/['\u2018\u2019\u2032]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Mot OCR comparé au terme : on enlève la ponctuation collée aux bords
// (« fuel, » compte pour « fuel », comme dans la recherche où la virgule
// est une frontière de mot) ; l'intérieur du mot est gardé tel quel
// (« l'huile » reste « l'huile »).
function stripEdgePunct(s) {
  return s.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

// ---------------------------------------------------------------------------
// Boîtes OCR (pixels d'image) -> points PDF
// ---------------------------------------------------------------------------
// frac est une boîte en pixels d'image (origine en haut à gauche) ;
// imageWidth/imageHeight sont les dimensions du PNG envoyé à l'OCR.
// Conversion : fractions de l'image -> points PDF, en inversant Y
// (en PDF, y = 0 est en BAS de la page : pdfY = (1 - fy) * hauteurPage).
// Retourne { x0, y0, x1, y1 } en points PDF (y0 < y1), ou null si les
// dimensions sont invalides.
export function fractionRectToPdfPoints(frac, imageWidth, imageHeight, pageWidth, pageHeight) {
  if (!frac) return null;
  const vals = [frac.x0, frac.y0, frac.x1, frac.y1, imageWidth, imageHeight, pageWidth, pageHeight];
  if (!vals.every((v) => Number.isFinite(v))) return null;
  if (imageWidth <= 0 || imageHeight <= 0 || pageWidth <= 0 || pageHeight <= 0) return null;
  const fx0 = frac.x0 / imageWidth, fy0 = frac.y0 / imageHeight;
  const fx1 = frac.x1 / imageWidth, fy1 = frac.y1 / imageHeight;
  // Arrondi au millième de point : la précision sous-pixel ne sert à rien
  // à l'affichage, et ça rend les rectangles comparables exactement.
  const r3 = (v) => Math.round(v * 1000) / 1000;
  return {
    x0: r3(fx0 * pageWidth),
    y0: r3((1 - fy1) * pageHeight),
    x1: r3(fx1 * pageWidth),
    y1: r3((1 - fy0) * pageHeight),
  };
}

// ---------------------------------------------------------------------------
// PDF scanné : rectangles d'un terme à partir des boîtes de mots OCR
// ---------------------------------------------------------------------------
// words : [{ text, bbox: { x0, y0, x1, y1 } }] en pixels d'image, dans
// l'ordre de lecture (celui de tesseract : blocs -> paragraphes ->
// lignes -> mots). term : terme cherché (mot ou phrase).
// Retourne des rectangles en points PDF, un par segment de ligne.
export function ocrRectsForTerm(words, imageWidth, imageHeight, term, pageWidth, pageHeight) {
  const normTerm = normalizeForMatch(term);
  if (!normTerm || !Array.isArray(words) || !words.length) return [];
  const parts = normTerm.split(' ');
  const normed = words
    .map((w) => ({ n: stripEdgePunct(normalizeForMatch(w && w.text)), bbox: w && w.bbox }))
    .filter((e) => e.n && e.bbox &&
      [e.bbox.x0, e.bbox.y0, e.bbox.x1, e.bbox.y1].every((v) => Number.isFinite(v)));
  if (!normed.length) return [];
  // Regroupement par ligne : deux mots consécutifs sont sur la même ligne
  // si leurs plages verticales se recouvrent nettement (≥ 30 % de la plus
  // petite hauteur). L'ordre tesseract est déjà l'ordre de lecture.
  const lines = [];
  for (const e of normed) {
    const last = lines.length ? lines[lines.length - 1] : null;
    if (last) {
      const prev = last[last.length - 1];
      const overlap = Math.min(e.bbox.y1, prev.bbox.y1) - Math.max(e.bbox.y0, prev.bbox.y0);
      const h = Math.min(e.bbox.y1 - e.bbox.y0, prev.bbox.y1 - prev.bbox.y0);
      if (overlap > 0.3 * h) { last.push(e); continue; }
    }
    lines.push([e]);
  }
  const out = [];
  for (const line of lines) {
    for (let i = 0; i + parts.length <= line.length; i++) {
      const window = line.slice(i, i + parts.length);
      if (window.map((e) => e.n).join(' ') !== normTerm) continue;
      const union = {
        x0: Math.min(...window.map((e) => e.bbox.x0)),
        y0: Math.min(...window.map((e) => e.bbox.y0)),
        x1: Math.max(...window.map((e) => e.bbox.x1)),
        y1: Math.max(...window.map((e) => e.bbox.y1)),
      };
      const rect = fractionRectToPdfPoints(union, imageWidth, imageHeight, pageWidth, pageHeight);
      if (rect) out.push(rect);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF à vrai texte : rectangles d'un terme à partir des items pdf.js
// ---------------------------------------------------------------------------
// items : [{ str, x, y, width, height, transform? }] en points PDF (x, y =
// origine de la ligne de base). transform est la matrice pdf.js [a, b, c,
// d, e, f] de l'item (transmise par app.js) : elle porte la rotation du
// texte — un texte vertical a a ≈ 0, d ≈ 0 et b, c ≈ ±taille de police.
// Sans transform (anciens appels, tests), le texte est supposé horizontal.
// Le terme est cherché avec la même regex que la recherche (mot entier,
// insensible à la casse et aux accents, y compris à cheval sur un saut de
// ligne devenu espace). Un rectangle par segment de ligne : une phrase
// coupée sur deux lignes donne deux rectangles.
//
// Géométrie : chaque ligne a une direction de lecture u (vecteur (a, b)
// normalisé) et une direction « haut de glyphe » v (vecteur (c, d)
// normalisé). Les caractères sont repérés par leur abscisse scalaire le
// long de u ; pour une correspondance, on prend les quatre coins du
// segment (extrémités le long de u, de -0,2*h à +h le long de v, comme
// pour l'horizontal) et on renvoie leur boîte englobante alignée sur les
// axes. Pour un texte horizontal, u = (1, 0) et v = (0, 1) : le résultat
// est exactement celui de l'ancien calcul.
export function textRectsForTerm(items, term) {
  if (!term || !Array.isArray(items) || !items.length) return [];
  const usable = items.filter((it) => it && typeof it.str === 'string' && it.str !== '');
  if (!usable.length) return [];
  // Orientation et vecteurs d'un item. t = matrice [a, b, c, d, e, f] ou null.
  const geom = (it) => {
    const t = Array.isArray(it.transform) && it.transform.length >= 6 &&
      it.transform.every((v) => Number.isFinite(v)) ? it.transform : null;
    const [a, b, c, d] = t || [1, 0, 0, 1];
    const la = Math.hypot(a, b), lc = Math.hypot(c, d);
    const u = la > 0 ? [a / la, b / la] : [1, 0];
    const v = lc > 0 ? [c / lc, d / lc] : [0, 1];
    const vertical = Math.abs(b) > Math.abs(a);
    const height = (typeof it.height === 'number' && it.height > 0) ? it.height
      : (la > 0 ? la : 10);
    return { u, v, vertical, height, coord: vertical ? it.x : it.y };
  };
  const sorted = [...usable].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const g = geom(it);
    const line = lines.find((l) => l.vertical === g.vertical && Math.abs(l.coord - g.coord) <= 3);
    if (line) line.items.push(it);
    else lines.push({ coord: g.coord, vertical: g.vertical, items: [it] });
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = [];
  for (const line of lines) {
    // Ordre de lecture : abscisse scalaire le long de la direction u du
    // premier item (dans l'ordre du tri global, qui met le haut en premier).
    const g0 = geom(line.items[0]);
    const u = g0.u, v = g0.v;
    const dot = (p, w) => p[0] * w[0] + p[1] * w[1];
    const ordered = [...line.items].sort((a, b) => dot([a.x, a.y], u) - dot([b.x, b.y], u));
    // Origine de la ligne : origine du premier item lu, recalée sur la
    // coordonnée transverse du groupe (pour l'horizontal : le y du groupe,
    // comme avant — le rectangle est donc identique à l'ancien calcul).
    const first = ordered[0];
    const n = line.vertical ? [1, 0] : [0, 1];
    const shift = line.coord - dot([first.x, first.y], n);
    const O = [first.x + n[0] * shift, first.y + n[1] * shift];
    const h = Math.max(...line.items.map((it) => geom(it).height));
    // Carte caractère -> abscisses scalaires le long de u : la largeur de
    // chaque fragment est répartie uniformément sur ses caractères ; un
    // écart net entre deux fragments devient un espace (même règle que
    // buildPageText).
    const chars = [];
    for (let i = 0; i < ordered.length; i++) {
      const it = ordered[i];
      const t0 = dot([it.x - O[0], it.y - O[1]], u);
      if (i > 0) {
        const prev = ordered[i - 1];
        const prevEnd = dot([prev.x - O[0], prev.y - O[1]], u) + prev.width;
        const gap = t0 - prevEnd;
        if (gap > 1) chars.push({ ch: ' ', s0: prevEnd, s1: t0 });
      }
      const s = it.str;
      const cw = s.length ? it.width / s.length : 0;
      for (let k = 0; k < s.length; k++) {
        chars.push({ ch: s[k], s0: t0 + k * cw, s1: t0 + (k + 1) * cw });
      }
    }
    const lineStr = chars.map((c) => c.ch).join('');
    const re = buildTermRegex(term);
    let m;
    let guard = 0;
    while ((m = re.exec(lineStr)) !== null && guard++ < 100) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const s0 = chars[m.index].s0;
      const s1 = chars[m.index + m[0].length - 1].s1;
      // Quatre coins du segment : extrémités le long de u, de -0,2*h à +h
      // le long de v ; boîte englobante alignée sur les axes.
      const corners = [
        [O[0] + u[0] * s0 + v[0] * (-0.2 * h), O[1] + u[1] * s0 + v[1] * (-0.2 * h)],
        [O[0] + u[0] * s1 + v[0] * (-0.2 * h), O[1] + u[1] * s1 + v[1] * (-0.2 * h)],
        [O[0] + u[0] * s1 + v[0] * h, O[1] + u[1] * s1 + v[1] * h],
        [O[0] + u[0] * s0 + v[0] * h, O[1] + u[1] * s0 + v[1] * h],
      ];
      out.push({
        x0: r3(Math.min(...corners.map((c) => c[0]))),
        y0: r3(Math.min(...corners.map((c) => c[1]))),
        x1: r3(Math.max(...corners.map((c) => c[0]))),
        y1: r3(Math.max(...corners.map((c) => c[1]))),
      });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Points PDF -> px CSS (viewport pdf.js du rendu courant)
// ---------------------------------------------------------------------------
// pdf.js 6.5.438 (version de l'appli) n'expose PAS convertToViewportRectangle
// sur le viewport — seulement convertToViewportPoint(x, y) : on convertit
// donc les deux coins du rectangle et on prend le min/max (le viewport
// gère la rotation, le retournement Y et le zoom). Retourne { left, top,
// width, height } en px CSS par rapport au coin haut-gauche du canevas.
export function pdfRectToCss(viewport, rect) {
  const [ax, ay] = viewport.convertToViewportPoint(rect.x0, rect.y0);
  const [bx, by] = viewport.convertToViewportPoint(rect.x1, rect.y1);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

// Ramène un rectangle CSS dans la page (viewport.width/height en px) ;
// retourne null si rien ne reste visible.
export function clampCssRect(r, pageWidth, pageHeight) {
  const left = Math.max(0, r.left);
  const top = Math.max(0, r.top);
  const width = Math.min(r.width - (left - r.left), pageWidth - left);
  const height = Math.min(r.height - (top - r.top), pageHeight - top);
  if (width <= 0.5 || height <= 0.5) return null;
  return { left, top, width, height };
}
