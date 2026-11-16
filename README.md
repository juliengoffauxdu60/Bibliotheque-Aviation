# Bibliothèque Aviation — application desktop (Electron)

Recherche plein texte dans vos documents d'aviation (POH, AIM, RAC…),
avec lecteur PDF intégré. Application 100 % locale : aucun réseau,
pdf.js est dans l'application. Depuis la v1.2.0, l'appli est livrée
SANS aucun document : chacun importe ses propres documents
(« ＋ Ajouter un document »), qui sont ensuite cherchés et lus ici.

## Lancer

```bash
npm install   # une seule fois (télécharge Electron et pdf.js)
npm start     # ouvre l'application
```

Sur une machine sans écran (serveur), lancer sous X virtuel :

```bash
xvfb-run -a npm start
```

## Nouveautés v1.2.1 (15 nov. 2026)

- **Sections à deux niveaux** : les documents complexes sont découpés par
  chapitres (GEN, RAC, MET…) avec leurs sous-sections numérotées dedans
  (ex. « RAC 1.0 », « MET 9.0 ») — signets PDF avec hiérarchie quand ils
  existent, sinon sommaire imprimé, sinon titres. Les documents simples
  (POH, PA-44…) sont inchangés ; sans rien, « Section unique ». Les
  documents déjà importés se remettent à niveau tout seuls à l'ouverture
  (aucune réimportation à faire).
- **Bouton « Tester » des réglages IA réparé** : le test attendait 20 s
  alors que Google met 24 s à répondre — délai porté à 28 s (sous la
  limite de 30 s d'Electron) avec un nouvel essai en cas de dépassement
  de délai seulement.

## Tests

```bash
node test/search.test.mjs    # moteur de recherche (25 vérifications)
node test/import.test.mjs    # import + détection des sections (83 sans
                             # les PDF GEN/RAC dans /tmp, 97 avec)
node test/ai.test.mjs        # fournisseurs IA + réglages (122)
node test/highlight.test.mjs # surlignage (32)
node test/highlight-vertical.test.mjs  # surlignage vertical (9)
node test/layered.test.mjs   # sections à chapitres (44)
node test/refresh.test.mjs   # mise à niveau des anciens imports (31)
npm run selftest  # l'application réelle sous Electron (48 vérifications
                  # dans l'appli : état vide, import d'un document fixture,
                  # recherches, feuilletage, centrage,
                  # bloc flottant, conversions, calculatrice…)
                  # Résultats : test-output/selftest.json
                  # Captures :  test-output/shots/*.png
```

Pour tester en fenêtre étroite (390×844) :

```bash
POH_WIDTH=390 POH_HEIGHT=844 xvfb-run -a npm run selftest
```

## Contenu

| Fichier | Rôle |
|---|---|
| `main.js` | Processus principal Electron : fenêtre 1440×900, protocole `app://` qui sert les fichiers locaux, auto-test (`POH_SELFTEST=1`). |
| `preload.cjs` | Minimal volontairement : le rendu n'a besoin d'aucun accès Node. |
| `renderer/index.html`, `styles.css`, `app.js` | Interface : recherche, cartes documents, puces de sections, liste de résultats, lecteur PDF. |
| `renderer/search.js` | Moteur de recherche (mot entier, insensible à la casse et aux accents, synonymes FR↔EN, ordre de lecture). |
| `renderer/sections.js` | Libellé complet d'une section (`GEN 1.0 — …`) pour le titre du lecteur, le menu, les résultats et les citations IA. |
| `test/layered.test.mjs`, `test/refresh.test.mjs` | Tests des sections à chapitres et de la mise à niveau des anciens imports. |
| `test/fixtures/multi-chapter-pdf.mjs` | Générateur d'un PDF synthétique de 12 pages avec vrais signets (chapitres GEN/AGA/RAC). |
| `renderer/tools.js` | Conversions aéronautiques + calculatrice générale. |
| `data/synonyms.json` | Synonymes FR↔EN, liste fixe (voir le statut « à confirmer » dans le rapport). |
| `test/fixtures/synthetic/` | Fixtures synthétiques (index JSON de 3 documents fictifs + docs.json) : données de test uniquement, jamais empaquetées. Le PDF synthétique (10 pages) est généré par `test/fixtures/synthetic-pdf.mjs`. |
| `assets/pdfjs/` | pdf.js vendu dans l'appli (pdf.mjs + pdf.worker.mjs, v6.5.438) : aucun CDN. |

## Fichiers binaires (à ajouter manuellement au dépôt)

Le connecteur GitHub de Muse ne pousse que des fichiers texte (UTF-8) :
les 2 fichiers binaires ci-dessous ne sont PAS dans ce premier envoi et
doivent être déposés dans le dépôt via l'interface web de GitHub
(glisser-déposer), aux mêmes chemins :

- `assets/tesseract/tessdata/fra.traineddata.gz`,
  `assets/tesseract/tessdata/eng.traineddata.gz` (données OCR, ~2,6 Mo)

Sans eux, l'OCR ne marche pas. `npm ci` suffit pour le reste (pdf.js vient de npm aussi,
mais la copie vendue dans `assets/pdfjs/` est déjà dans le dépôt).

## Comportement (résumé)

- Recherche en **mot entier** sur les documents importés, insensible à la casse et
  aux accents ; l'expression tapée est cherchée comme un tout ; synonymes
  FR↔EN (liste fixe). Résultats en **ordre de lecture** (par date d'ajout,
  puis page 1 → dernière), 500 max (1000 sur un seul document).
- Le lecteur charge **le PDF entier avec une seule instance pdf.js par
  document** : changer de page ou de section ne recharge jamais, la page
  change sur place. « Plus grand » (≈ 640 px) par défaut, centrage
  automatique ; « Page entière » en un clic. Bloc de navigation flottant
  épinglé en bas du lecteur.
- **Sections à deux niveaux** (v1.2.1) : deux rangées de puces — chapitres
  (GEN, RAC…) puis sous-sections du chapitre courant ; menu « Sections ▾ »
  avec chapitres cliquables et sous-sections indentées ; cliquer une
  section sélectionne celle-là même si deux sections partagent une page.
  Les documents sans chapitre gardent une seule rangée, comme avant.
- Avertissement OCR pour les documents scannés : la recherche sert à trouver la page, les
  valeurs se lisent dans le PDF affiché.
- Outils (conversions + calculatrice générale) en pleine largeur sous la
  grille. Pas de « Demander à Jarvis » dans cette appli (remplacé plus tard
  par les réglages IA — hors périmètre).

## Packaging Windows

`package.json` est prêt pour electron-builder (`main`, scripts `start` /
`build`, section `build` avec appId et cibles win/mac/linux). Le packaging
est fait — voir `PACKAGING.md` (installateur construit et testé sur le PC
le 14 nov. 2026 ; workflow GitHub Actions prêt dans
`.github/workflows/build-windows.yml`, en attente de la création du dépôt
privé « recherche-poh » par Julien). Une fois empaquetée, l'appli est un
dossier autonome à copier (clé USB, par exemple) : aucune installation
réseau ensuite.

## Rapport de vérification

Voir `RAPPORT-VERIFICATION.md` : les 16 points de la checklist, ce qui a été
vérifié et comment (tests réels dans l'appli, pas une revue de code seule),
et les points restés ouverts.

## v1.2.2 (16 nov. 2026) — lecture du texte des PDF scannés réparée

Cause racine : le paquet ne livrait pas les décodeurs WASM de pdf.js
(`jbig2.wasm`, `openjpeg.wasm`, `qcms_bg.wasm` + replis JS) et `wasmUrl`
n'était jamais renseigné. Les images CCITT Groupe 4 (le cas du 172N de
Julien, 242 pages, 600 ppp) ne se décodaient pas : chaque page rendait
blanche, la lecture du texte tournait à vide en quelques secondes et
rendait 0 caractère. Correctif : les 5 fichiers WASM sont livrés dans
`assets/pdfjs/wasm/`, `wasmUrl` est passé aux deux rendus pdf.js, et la
lecture du texte est devenue impossible à rater : démarrage automatique
après l'import d'un document scanné, arrêt net après 5 pages blanches
d'affilée avec un message clair, bouton « Rendre cherchable » sur la
carte de tout document sans texte, et bannière de reprise à chaque
lancement pour ces documents (le 172N déjà importé se répare sans
réimportation). Le mot « OCR » n'apparaît nulle part dans l'interface
(« lecture du texte », « Rendre cherchable »). Vérifié : auto-test
Electron 59/59 (dont 11 vérifications CCITT : page rendue avec de
l'encre, texte trouvé, recherche « fuel » = 1 page), suites Node
377/377 avec `POH_TEST_OCR=1`, et `ai:ask` de bout en bout (6 extraits
de contexte envoyés, réponse affichée, sources cliquables) — la
recherche IA « dans le vide » venait de l'index vide, pas de `ai:ask`.
Aussi : `retention-days: 1` sur les deux artefacts Actions du workflow
(52 artefacts = 13 206 Mo avaient saturé le quota gratuit GitHub de
500 Mo ; les releases ne sont pas touchées).
