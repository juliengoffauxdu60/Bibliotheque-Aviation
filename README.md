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

## Tests

```bash
npm test          # moteur de recherche seul (Node, 24 vérifications)
npm run selftest  # l'application réelle sous Electron (34 vérifications
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
