#!/usr/bin/env python3
"""Génère test/fixtures/ccitt-1p.pdf : UNE page scannée (image CCITT Groupe 4,
comme le 172N de Julien — 242 p., images CCITT G4 600 ppp) avec du vrai texte.

Pourquoi : la v1.2.1 ne livrait pas les décodeurs WASM de pdf.js
(assets/pdfjs/wasm/ absent, wasmUrl jamais défini) — les pages CCITT
rendaient BLANCHES, la lecture du texte tournait à vide (0 caractère sur
242 pages, 16 nov. 2026). Ce fixture est la non-régression : l'auto-test
Electron l'importe, vérifie que la page rendue a de l'encre, puis que la
lecture du texte y trouve du texte.

Méthode : Pillow dessine le texte (DejaVu Sans, 1 bit), l'encode en TIFF
Groupe 4, et on extrait la bande compressée brute du TIFF pour l'embarquer
telle quelle dans un PDF minimal (filtre /CCITTFaxDecode, /K -1).
Régénération : python3 scripts/make-ccitt-fixture.py
(ne fait PAS partie du paquet : scripts/ n'est pas dans build.files).
"""
import os
import struct
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "test", "fixtures", "ccitt-1p.pdf")

W, H = 1700, 2200  # ~200 ppp sur une page lettre
LINES = [
    "CESSNA 172N",
    "FUEL CAPACITY 43 GALLONS",
    "OIL CAPACITY 8 QUARTS",
    "STALL SPEED 48 KNOTS",
    "CRUISE SPEED 122 KNOTS",
]

FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def make_image():
    im = Image.new("1", (W, H), 1)  # 1 = blanc
    draw = ImageDraw.Draw(im)
    font = None
    for path in FONT_PATHS:
        try:
            font = ImageFont.truetype(path, 72)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    y = 200
    for line in LINES:
        draw.text((120, y), line, font=font, fill=0)  # 0 = noir
        y += 180
    return im


def g4_strip(im):
    """Encode l'image en TIFF Groupe 4 et renvoie la bande compressée brute.
    UNE SEULE bande (strip_size énorme) : en TIFF, chaque bande est un
    flux G4 indépendant — concaténer plusieurs bandes donne un flux G4
    invalide (le décodeur s'arrête à la fin de la 1re bande, le reste de
    la page rend blanc)."""
    tmp = "/tmp/ccitt-fixture-g4.tiff"
    im.save(tmp, compression="group4", strip_size=16 * 1024 * 1024)
    data = open(tmp, "rb").read()
    endian = "<" if data[:2] == b"II" else ">"
    (ifd_off,) = struct.unpack(endian + "I", data[4:8])
    (n,) = struct.unpack(endian + "H", data[ifd_off:ifd_off + 2])
    # Types TIFF : 3 = SHORT (2 o), 4 = LONG (4 o). Une valeur tient dans
    # le champ de 4 o si elle est seule, sinon le champ est un décalage.
    sizes = {3: 2, 4: 4}
    tags = {}
    for i in range(n):
        e = data[ifd_off + 2 + 12 * i: ifd_off + 2 + 12 * (i + 1)]
        tag, typ, count, val = struct.unpack(endian + "HHI4s", e)
        if typ not in sizes:
            continue
        total = sizes[typ] * count
        raw = val[:total] if total <= 4 else data[struct.unpack(endian + "I", val)[0]:][:total]
        fmt = endian + ("H" if typ == 3 else "I") * count
        tags[tag] = struct.unpack(fmt, raw)
    strips, counts = tags.get(273), tags.get(279)
    if not strips or not counts or len(strips) != len(counts):
        raise SystemExit("TIFF G4 illisible : bandes introuvables")
    return b"".join(data[o:o + c] for o, c in zip(strips, counts))


def build_pdf(g4):
    objs = []
    objs.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objs.append(b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    objs.append(
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>"
    )
    img_dict = (
        b"<< /Type /XObject /Subtype /Image /Width %d /Height %d "
        b"/ColorSpace /DeviceGray /BitsPerComponent 1 "
        b"/Filter /CCITTFaxDecode "
        b"/DecodeParms << /K -1 /Columns %d /Rows %d /BlackIs1 true >> "
        b"/Length %d >>" % (W, H, W, H, len(g4))
    )
    objs.append(img_dict + b"\nstream\n" + g4 + b"\nendstream")
    content = b"q 612 0 0 792 0 0 cm /Im1 Do Q"
    objs.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 %d\n" % (len(objs) + 1)
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += (
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objs) + 1, xref_pos)
    )
    return bytes(out)


def main():
    im = make_image()
    g4 = g4_strip(im)
    pdf = build_pdf(g4)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(pdf)
    print(f"{OUT} : {len(pdf)} octets, bande G4 {len(g4)} octets, {W}x{H}")


if __name__ == "__main__":
    main()
