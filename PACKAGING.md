# Packaging Windows — Recherche POH

Date : 14 novembre 2026. Installateur construit et testé sur le PC gaming
de Julien (hôte SSH `pc-fixe`).

## L'installateur

| Élément | Chemin / valeur |
|---|---|
| Installateur (NSIS) | `C:\Users\julie\poh-build\recherche-poh\dist\Recherche POH Setup 1.0.0.exe` — **183 205 772 octets** (~174,7 Mio), construit le 14 nov. 14:11 |
| Blockmap | `C:\Users\julie\poh-build\recherche-poh\dist\Recherche POH Setup 1.0.0.exe.blockmap` — 192 330 octets |
| Dossier non empaqueté | `C:\Users\julie\poh-build\recherche-poh\dist\win-unpacked\` |
| Appli installée | `C:\Users\julie\AppData\Local\Programs\recherche-poh\Recherche POH.exe` — 250 056 704 octets (installation par utilisateur, sans admin, silencieuse avec `/S`) |
| Dossier de build sur le PC | `C:\Users\julie\poh-build\recherche-poh\` (projet + `node_modules` + `dist`) |
| Dossier de test sur le PC | `C:\Users\julie\poh-test\` (profils de test, PDF test, journaux) |
| Version | 1.0.0 — Electron 45.3.2, electron-builder 26.18.0, appId `ca.airrichelieu.recherche-poh` |

Le profil réel de Julien (`%APPDATA%\recherche-poh`) n'a jamais été
touché : tous les tests ont utilisé des profils frais (`--user-data-dir`
sous `C:\Users\julie\poh-test\`). Sa première ouverture sera comme une
première installation.

## Refaire le build (sur le PC)

Prérequis sur le PC : Node v24.14.0, npm 11.10.1 (vérifiés). Le projet
fait ~46 Mo sans `node_modules` (PDF : 42 Mo) ; prévoir ~1 Go libre
(`node_modules` + `dist` + caches).

```cmd
:: 1. Copier le projet sur le PC (SANS node_modules), depuis la VM :
::    tar --exclude=node_modules --exclude=test-output -czf recherche-poh.tar.gz .
::    scp -F ~/workspace/pipeline-plex/serveurplex-ssh-config recherche-poh.tar.gz pc-fixe:C:/Users/julie/
::    puis sur le PC : tar -xzf C:\Users\julie\recherche-poh.tar.gz -C C:\Users\julie\poh-build\recherche-poh
:: 2. Installer les dépendances, tester, construire :
cd /d C:\Users\julie\poh-build\recherche-poh
npm ci
npm test
npm run dist
:: 3. Installer (silencieux) :
"dist\Recherche POH Setup 1.0.0.exe" /S
```

### Piège connu : `npm ci` ne télécharge pas toujours le binaire Electron

Observé deux fois sur ce PC : après `npm ci` (succès affiché),
`node_modules\electron\dist\electron.exe` était absent. Contournement
vérifié :

```cmd
node node_modules\electron\install.js
dir node_modules\electron\dist\electron.exe
```

Vérifier la présence du binaire AVANT `npm run dist` (et avant
`npm start`). Cause non établie ; le contournement suffit.

## Build via GitHub Actions (plus tard)

Le workflow est prêt : `.github/workflows/build-windows.yml` (runner
`windows-latest`, Node 24, `npm ci`, `npm test`, `npm run dist`,
artefacts `.exe` + `.blockmap`, déclenché sur push `main` et tags `v*`).

**Bloqué :** le dépôt GitHub n'existe pas encore. La création via le
connecteur échoue (403, l'appli GitHub de Muse ne peut pas créer de
dépôt). Julien doit créer lui-même le dépôt privé vide
« recherche-poh » sur github.com, puis y pousser ce projet. Rien n'a
été poussé sur GitHub.

## Deux correctifs appliqués pour que le build marche

1. **`electron` en `devDependencies` (package.json).** electron-builder
   26 refuse `electron` dans `dependencies` (« Package "electron" is
   only allowed in "devDependencies" »). Déplacé (avec
   `package-lock.json` régénéré) — aucun impact au runtime (l'appli
   empaquetée utilise le binaire Electron, pas le paquet npm).
2. **`import-core.js` ajouté à `build.files`.** Il manquait : le
   premier installateur plantait au démarrage (`ERR_MODULE_NOT_FOUND`,
   `main-import.js` importe `./import-core.js`). L'appli restait
   bloquée sur la boîte d'erreur Electron. Après ajout, rebuild +
   réinstallation : l'appli démarre. Vérifié aussi que `tesseract.js`
   et `tesseract.js-core` sont bien dépaquetés de l'asar
   (`resources\app.asar.unpacked\node_modules\`, `.wasm` présents).

## Ce qui a été vérifié sur le PC (appli empaquetée, installée)

- **`npm test` : 24/24** (`C:\Users\julie\poh-build\npm-test.log`).
- **Auto-test dans l'appli : 25/25 en 31 s**
  (`C:\Users\julie\poh-test\selftest.json`, copie :
  `test-output/selftest-pc.json`) : 4 docs / 1028 pages,
  « fuel » = 209 résultats, « stall » = 11 pages en 172N,
  « stall speed » = 12 pages, « pression d'huile » trouve
  « oil pressure » (43 pages), ouverture résultat 1 (172N p. 3,
  1 seul chargement), feuilletage 40→41 / 80→81 / 120→121,
  p. 39 et p. 2 (blanche, 0 pixel), saut section 1→8 (p. 146),
  centrage (offset 0), « Page entière », bloc flottant, 47→48,
  focus relâché, « Résultat 3 sur 209 », conversions
  (10 gal US = 37,85 L ; 100 lb = 45,36 kg), calculatrice 14,
  avertissement OCR, SOP p. 1 (5 chapitres), pas de débordement,
  10,5 gal → 39,75 L.
- **Pilote CDP : 16/18 + 6/6 après correction**
  (`test-output/cdp-pc.json`, `test-output/fix-check-pc.log`) :
  boutons « Ajouter un POH » et « Réglages IA » présents ; page
  « Réglages IA » ouverte (formulaire avec fournisseur + clé) ;
  recherche « fuel » = 209 ; 4 docs / 1028 pages.
- **OCR (point à risque n°1) : MARCHE.** PDF test image-only de
  3 pages (pages 8-10 du 172N, 0 caractère de texte, 1 image par
  page — `C:\Users\julie\poh-test\poh-test-scan-3p.pdf`) importé
  (détecté scanné, médiane 0 car./page), OCR terminé
  (source `ocr`, médiane 1094 car./page, 1094 / 537 / 1099
  caractères par page, section « Section 1 — Model 172n General »
  détectée, « SECTION » / « GENERAL » reconnus). Après
  rechargement, recherche « general » : 135 résultats dont les
  3 pages du document importé. Le worker tesseract.js tourne bien
  depuis l'asar dépaqueté. La recommandation `asarUnpack` pour
  `tesseract.js` / `tesseract.js-core` est donc CONFIRMÉE sur un
  vrai paquet Windows.
- **safeStorage (point à risque n°2) : MARCHE.** Fausse clé
  `FAUSSE-CLE-TEST-1234567890abcdef` enregistrée (fournisseur
  OpenAI) : `encryptionAvailable=true`,
  `keyMethod=safeStorage`, clé ABSENTE en clair du fichier
  `ai-settings.json`, affichage masqué `••••cdef` (4 derniers
  caractères). Clé effacée après le test (`hasKey=false`).
  (Les 2 « ÉCHEC » initiaux du pilote CDP venaient d'une erreur
  du pilote lui-même — il lisait `getSettings()` au lieu de
  `getSettings().settings` — pas de l'appli ; revérifié 6/6.)

## Point d'attention : le bureau du PC ne produit pas d'images Chromium

Pendant les tests, l'appli semblait bloquée au premier rendu PDF
(aucune image produite, `visibilityState=hidden`, `requestAnimationFrame`
ne se déclenche jamais, CPU ~0). Diagnostic par sondes CDP :

- Le protocole `app://`, les workers, les canvas 2D, les fetch, les
  IPC fonctionnent (getDocument 172N : 56 ms, fetch du PDF 19 Mo :
  18 ms, SOP parsé en 56 ms). Seul `page.render()` reste en attente.
- **Ce n'est PAS l'appli :** une fenêtre Electron minimale ET Google
  Chrome ordinaire, lancés de la même façon, montrent exactement les
  mêmes symptômes (`hidden`, rAF mort). C'est l'état du bureau
  Windows au moment des tests (aucune image Chromium produite).
- **Preuve que l'appli fonctionne :** forcer les images via CDP
  (`Page.startScreencast`, avec accusé de réception de chaque image)
  débloque TOUT instantanément — `ready()` en 0,0 s, recherche
  « fuel » 209 en 0,0 s, rendus de pages sans erreur. Le selftest
  25/25 ci-dessus a été obtenu ainsi (31 s).
- Conséquence pour Julien : en utilisation normale (double-clic,
  fenêtre au premier plan), l'appli fonctionne. Si jamais l'appli
  semblait figée à l'ouverture (page blanche, recherche sans
  réponse), cliquer sur la fenêtre / la mettre au premier plan
  suffit en principe à relancer la production d'images. Ce point
  n'a pas pu être tranché plus loin à distance.

## Ménage effectué après les tests

- Toutes les tâches planifiées `POH-*` créées pour les tests ont été
  supprimées (vérifié : aucune ne reste).
- Processus de test arrêtés (appli, node, electron). L'installateur
  et l'appli installée restent en place.
- À noter : un `taskkill /IM chrome.exe` global a fermé le Chrome de
  Julien par mégarde pendant le nettoyage (ses onglets se restaurent
  au prochain lancement de Chrome — session restaurée par défaut).
  À éviter à l'avenir (ne tuer que les processus de test nommés).
- Note : le `test-output/selftest.json` de la VM (25/25, intégration)
  a été écrasé par accident lors du rapatriement des preuves par
  `test-output/selftest-pc.json`. Le résultat VM reste documenté
  dans `INTEGRATION.md` / `RAPPORT-VERIFICATION.md` (25/25).
