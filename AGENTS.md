# AGENTS.md — Bibliothèque Aviation

Application desktop (Electron) 100 % locale : recherche plein texte dans
les documents d'aviation (POH, AIM, RAC…), avec lecteur PDF intégré.
Depuis la v1.2.0, l'appli est livrée SANS aucun document : chacun importe
les siens (« ＋ Ajouter un document »), avec OCR.

## Lancer

```bash
npm install   # une seule fois (télécharge Electron et pdf.js)
npm start     # ouvre l'application
xvfb-run -a npm start   # sans écran (serveur)
```

## Tests

```bash
npm test          # suites Node (recherche, import, IA, surlignage)
npm run selftest  # l'application réelle sous Electron
                  # résultats : test-output/selftest.json
                  # captures : test-output/shots/*.png
```

## Fichiers clés

| Fichier | Rôle |
|---|---|
| `main.js` | Processus principal Electron, fenêtre 1440×900, protocole `app://` |
| `main-ai.js`, `renderer/ai-*.js` | Questions IA (chaque utilisateur met sa propre clé) |
| `main-import.js`, `import-core.js` | Import de documents + OCR + détection des sections |
| `preload.cjs` | Minimal volontairement |
| `renderer/app.js`, `search.js`, `highlight.js` | Interface, moteur de recherche, surlignage |
| `renderer/tools.js` | Conversions aéronautiques + calculatrice |
| `data/synonyms.json` | Synonymes FR↔EN (liste fixe) |
| `test/fixtures/bundled/` | Anciens documents fournis : fixtures de test uniquement, jamais empaquetés |
| `assets/pdfjs/` | pdf.js vendu dans l'appli (aucun CDN) |

## Règles

- `productName` = « Bibliotheque Aviation » SANS accent, pour toujours :
  l'accent fait crasher l'appli au lancement sur macOS (comparaison
  d'octets NFD/NFC dans Electron). Les textes d'interface gardent l'accent.
- `appId` : `ca.airrichelieu.bibliotheque-aviation`.
- Recherche en mot entier, insensible à la casse et aux accents ; synonymes
  FR↔EN (liste fixe). Résultats en ordre de lecture.
- Le surlignage tient compte de la rotation du texte (mots verticaux,
  ex. « RAC » dans l'AIM).
- Recherche par carte : cliquer toute la carte ouvre le document ; le bouton
  « Rechercher dans le document » ouvre le document + le champ de recherche ;
  puce « Tous les documents » = recherche globale. Navigation des occurrences
  par flèches en bas du lecteur (« X sur N ») ; navigation pages/sections
  en haut.
- Ne jamais remettre de document fourni dans le paquet.
- Aucune clé API en clair, jamais dans le code ; chaque utilisateur met la
  sienne dans les réglages IA.
- Releases : un tag `v*` déclenche le workflow `.github/workflows/build.yml`
  (Windows, puis macOS, puis job `release` unique). electron-builder ne
  publie jamais (`--publish never` partout).

## Docs

- `README.md` — présentation et lancement
- `INTEGRATION.md`, `PACKAGING.md`, `RAPPORT-VERIFICATION.md`
