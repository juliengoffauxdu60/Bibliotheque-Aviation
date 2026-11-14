# Intégration — import POH + Réglages IA (14 nov. 2026, coordinateur)

Patchs d'intégration appliqués après les livraisons des agents import/OCR et IA
(les deux agents n'avaient créé que des fichiers nouveaux) :

- `main.js` : imports `registerImportHandlers` (main-import.js) et
  `registerAiHandlers` (main-ai.js), appelés dans `app.whenReady()` avant
  `createWindow()` ; branche `app://user-pohs/` dans le protocole `app`
  (sert les PDF/index importés depuis `userData/pohs/`, avec garde 403).
- `preload.cjs` : réécriture FUSIONNÉE — expose `pohDesktop.import`
  (list, chooseFile, importFile, ocrPage, ocrFinish, ocrCancel, deleteDoc)
  ET `pohDesktop.ai` (getSettings, saveSettings, clearKey, ask, test,
  openSettings). Les deux patchs d'origine le réécrivaient chacun de leur
  côté : ne pas appliquer l'un sans l'autre.
- `renderer/index.html` : lien `ai.css`, bouton « Réglages IA » dans
  l'en-tête, section « Poser une question » dans `<main>` après les Outils,
  scripts `import.js` et `ai.js` après `app.js`.
- `renderer/app.js` (`loadData`) : charge aussi les documents importés
  (registre `userData/pohs`) — source unique de vérité pour la recherche.
- `renderer/ai.js` (`loadIndexes`) : même chargement des documents importés
  — les questions IA couvrent aussi les POH ajoutés par l'utilisateur.
- `package.json` : dépendance `tesseract.js@6.0.1` déclarée ; `build.files`
  ajoute `main-import.js` ET `main-ai.js` (racine, non couverts par
  `renderer/**/*`) ; `asarUnpack` pour `tesseract.js` et
  `tesseract.js-core` (recommandation de l'agent OCR, à confirmer sur un
  vrai paquet Windows).

## Vérification après intégration (14 nov. 2026)

- `npm test` : 24/24.
- `node test/ai.test.mjs` : 60/60.
- `node test/import.test.mjs` : 45/45 (test OCR passé sous `POH_TEST_OCR=1`).
- `node scripts/ai-e2e.mjs` : 20/20 dans results.json + 2 confirmations
  côté serveur factice (clé bien envoyée, 6 extraits reçus).
- `npm run selftest` : 25/25 sous xvfb-run par défaut ET sous écran
  1440×900 (correctif de centrage appliqué : centrage synchrone +
  double rAF + ResizeObserver dans `renderer/app.js`).

## Reste à faire

- Packaging Windows (electron-builder + GitHub Actions) et test de
  l'installateur sur le PC de Julien.
- Dépôt GitHub BLOQUÉ : la création via le connecteur échoue (403, l'appli
  GitHub ne peut pas créer de dépôt). Julien doit créer lui-même le dépôt
  privé vide « recherche-poh », puis donner l'accès à l'appli Muse.
