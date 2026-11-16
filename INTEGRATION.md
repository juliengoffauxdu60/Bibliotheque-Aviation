## Retrait des documents fournis (v1.2.0)

L'appli est livrée sans aucun document : au premier lancement, la zone
Documents est vide et invite à ajouter un premier document. Les 4 anciens
documents fournis (172N, 172R, 150, SOP C150) ont quitté le dépôt le
15 nov. 2026 : les tests utilisent désormais des fixtures SYNTHÉTIQUES
(`test/fixtures/synthetic/` — index JSON de 3 documents fictifs —
et `test/fixtures/synthetic-pdf.mjs`, qui génère un PDF de 10 pages),
jamais empaquetées (`package.json` → `build.files` : `assets/pdfjs/**`,
`assets/tesseract/**`, `data/synonyms.json` seulement, plus le code).

## Sections à deux niveaux + mise à niveau des anciens imports (v1.2.1, 15 nov. 2026)

- `import-core.js` : `detectOutlineSections` hiérarchique (chapitres niveau 1
  + sous-sections numérotées niveau 2, clés qualifiées `GEN 1.0`, sous-arbre
  « Table des matières » exclu) ; `detectTocSections` sensible aux chapitres ;
  `detectSections` (repli titres) exclut les pages de sommaire par le contenu
  ET le bloc de sommaire en tête du document (première série contiguë de pages
  de sommaire dans les 30 premières pages). Modèle : `front` niveau 0,
  chapitre niveau 1, sous-section niveau 2 avec `chapter`/`chapterLabel`.
  Vérifié sur le vrai AIM (569 p., local seulement) : 87 sections, 11 chapitres.
- `main-import.js` : `listImported()` et `refreshImportedDoc()` async ;
  le refresh relance `detectSectionsLayered` sur le PDF stocké pour tout
  document sans `meta.sectionFormat === 2`, puis marque le format 2 (chemin
  rapide ensuite) ; `importFile`/`ocrFinish` écrivent `sectionFormat: 2`.
- `renderer/` : deux rangées de puces (chapitres + sous-sections), menu à deux
  niveaux, clic qui colle (section épinglée + intervalle), `renderer/sections.js`
  (`fullSectionLabel`) utilisé par le titre du lecteur, le menu, les résultats
  et les citations IA. Auto-test 48/48.
- Correctif « Tester » IA : `TEST_TIMEOUT_MS = 28000` dans
  `renderer/ai-providers.js` (28 s < limite IPC 30 s, > 24 s mesurés chez
  Google), `isTestTimeout`, `main-ai.js` renvoie `code: 'timeout'`,
  `renderer/ai-settings.js` réessaie une fois sur dépassement de délai.
- Tests : `test/layered.test.mjs` (44), `test/refresh.test.mjs` (31),
  `test/fixtures/multi-chapter-pdf.mjs` (PDF synthétique 12 p. à vrais signets),
  tests outline GEN/RAC mis à jour pour la forme à chapitres (ils sont ignorés
  sans `/tmp/aim-gen.pdf` et `/tmp/aim-rac.pdf`, par conception).

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
  Depuis la v1.2.0, ce sont les SEULS documents : `data/docs.json` n'existe
  plus, le chargement démarre sur une liste vide.
- `renderer/ai.js` (`loadIndexes`) : même chargement des documents importés
  — les questions IA couvrent aussi les POH ajoutés par l'utilisateur.
  Depuis la v1.2.0, `data/docs.json` absent = 0 document, 0 passage trouvé,
  sans plantage.
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

## v1.2.2 (16 nov. 2026) — WASM pdf.js + lecture du texte robuste

- **Bug** : le 172N scanné de Julien (242 pages, images CCITT Groupe 4)
  rendait des pages blanches dans le paquet v1.2.1 : pdf.js décode ces
  images avec son décodeur WASM `jbig2.wasm`, qui n'était ni livré dans
  `assets/pdfjs/` ni renseigné (`wasmUrl` absent) — la lecture du texte
  défilait à vide et rendait 0 caractère. **Correctif** : les 5 fichiers
  WASM sont livrés (`assets/pdfjs/wasm/`, couverts par `build.files`
  `assets/pdfjs/**`), MIME `.wasm` dans le gestionnaire de protocole
  `app://`, `wasmUrl` dans les deux `getDocument` du rendu.
- **Robustesse** : démarrage automatique de la lecture du texte après
  l'import d'un document scanné ; arrêt après 5 pages blanches
  d'affilée avec message clair ; bouton « Rendre cherchable » sur la
  carte de tout document sans texte ; bannière de reprise à chaque
  lancement. Un document déjà importé (le 172N) se répare sans
  réimportation. Le mot « OCR » n'apparaît nulle part dans l'interface.
- **Tests** : auto-test Electron 59/59 (11 vérifications CCITT),
  suites Node 377/377 (`POH_TEST_OCR=1`), E2E IA OK (6 extraits).
  Nouveau fixture `test/fixtures/ccitt-1p.pdf` (1 page, CCITT G4,
  5 lignes de texte réel, généré par `scripts/make-ccitt-fixture.py` —
  une seule bande G4 par image : plusieurs bandes concaténées forment
  un flux G4 invalide et seule la 1re ligne rend).
- **Workflow** : `retention-days: 1` sur les deux artefacts Actions
  (quota gratuit GitHub 500 Mo saturé par 52 artefacts = 13 206 Mo).
