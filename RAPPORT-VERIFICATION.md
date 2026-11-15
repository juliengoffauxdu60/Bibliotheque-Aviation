# Rapport de vérification — Bibliothèque Aviation (desktop)

> Note v1.2.1 (15 nov. 2026) : sections à deux niveaux (chapitres +
> sous-sections, ex. « RAC 1.0 »), mise à niveau automatique des anciens
> imports, bouton « Tester » IA réparé (28 s + nouvel essai). Suites Node :
> search 25, import 83 (97 avec les PDF GEN/RAC dans /tmp), ai 122,
> highlight 32, highlight-vertical 9, layered 44, refresh 31 — total 360,
> 0 échec. Auto-test Electron : 48/48. Vérifié sur le vrai AIM de Julien
> (569 p., local seulement, jamais dans le dépôt) : détection en couches
> source outline, 87 sections, 11 chapitres (GEN@35, AGA@91, COM@127,
> MET@169, RAC@237, NAT@399, SAR@415, MAP@429, LRA@441, AIR@467, ATP@525),
> GEN 5.0@66, AGA 9.0@118, RAC 1.0@237 ; passe titres 9.0 → p.118
> (était p.14). Limites connues du repli titres (documentées dans les
> tests) : 5.0 → p.98, 7.0 → p.89, 10.0 → p.166 — les signets donnent
> les bonnes pages.
>
> Note v1.2.0 (14 nov. 2026), mise à jour 15 nov. 2026 : ce rapport
> documente la v1.1.3, livrée AVEC les 4 documents fournis (172N, 172R,
> 150, SOP C150 — 1028 pages). Depuis la v1.2.0, l'appli est livrée SANS
> aucun document. Les 4 documents de base ont quitté le dépôt le
> 15 nov. 2026 : les chiffres ci-dessous (fuel = 209, stall 172N = 11
> pages, etc.) étaient des mesures sur les anciens fichiers de test,
> remplacés depuis par des fixtures SYNTHÉTIQUES
> (`test/fixtures/synthetic/` : fuel = 5 pages, stall = 7 pages).
> Le selftest actuel (40 vérifications) part de l'état vide et importe
> un petit PDF fixture de 3 pages (fuel = 2 pages, stall = 1 page).

Date : 14 novembre 2026. Vérifié par tests réels dans l'application
(Electron lancé sous Xvfb), pas par revue de code seule.

- **Tests du moteur de recherche** : `npm test` — 24 vérifications Node sur
  les vrais index JSON — **toutes passent**.
- **Auto-test dans l'appli** : `npm run selftest` — 25 vérifications qui
  pilotent l'application réelle (DOM, canvas pdf.js, mesures géométriques)
  — **25/25 à 1440×900 et 25/25 en fenêtre étroite 390×844**
  (sauf indication, les chiffres ci-dessous viennent de ces deux passages).
  Détail : `test-output/selftest.json`. Captures : `test-output/shots/`.
- L'espace web « recherche-poh » n'a jamais été lu ni touché.

## Les 16 points de la checklist

### 1. « Aller à la section » — sections sélectionnables rapidement
**Vérifié.** Puces « Aller à la section » pour le document courant (172N :
8 puces, 172R : 9, 150 : 9, SOP : 5 chapitres), en enroulement sans
défilement horizontal (capture 01). Le menu « Sections » du bloc flottant
liste en plus chaque chapitre avec son numéro de page (saut direct vérifié
par le test « saut de section 1 → 8, p. 146 »).

### 2. Résultats dans l'ordre, compteur, terme trouvé
**Vérifié.** Ordre de lecture contrôlé par test : doc par doc (172N, 172R,
150, SOP) puis page croissante ; « fuel » = 209 résultats (même chiffre
que la checklist de l'espace). Chaque carte indique document, section,
page (numéro imprimé ou numéro PDF), le terme réellement trouvé et le
nombre d'occurrences, plus un extrait avec le terme surligné. Boutons
Précédent/Suivant + « Résultat X sur N » testés dans l'appli
(« Résultat 3 sur 209 » après deux « Suivant »).

### 3. Mot entier, phrase exacte
**Vérifié par les tests du moteur.** « stall » : 11 pages en 172N en mot
entier (48 en sous-chaîne — le même 48 → 11 que la checklist) ;
« stall speed » : 12 pages exactes (le même 12 que la checklist) ;
aucun résultat parasite (« installed » ne remonte jamais pour « stall »).
Le surlignage DANS la page PDF reste impossible (pas de calque texte) :
l'extrait surligné est dans la liste de gauche (capture 01).

### 4. Outils à leur place, pleine largeur sous la grille
**Vérifié visuellement** (capture 06) : conversions + calculatrice en pleine
largeur SOUS la grille, à leur place, jamais déplacées.

### 5. Sections visibles + PDF centré + page entière visible
**Vérifié.** Sections visibles d'un coup d'œil (capture 01) ; centrage
mesuré (offset −1 px à 1440×900, 0 px à 390×844) ; en « Page entière » la
page tient sans défilement (`fitsWithoutScroll: true`, capture 04).

### 6. « Page entière / Plus grand », « Plus grand » ≈ 640 px
**Vérifié.** Bascule dans l'en-tête du lecteur ; largeur mesurée du canevas
en « Plus grand » : 640 px (1440×900) ; boutons Précédent/Suivant de gauche
fixes (en-tête de colonne, hors zone de défilement de la liste). 172N : 8
sections, c'est normal (pas de section 9). **Écart volontaire :** le choix
est mémorisé (localStorage) — ça corrige la limite connue de l'espace web
(« le choix n'était pas mémorisé ») ; le défaut à l'ouverture reste
« Plus grand » (vérifié sur profil frais).

### 7. Centrage en « Plus grand », boutons qui ne bougent pas
**Vérifié.** Milieu de page au milieu de la vue à chaque résultat mesuré
(offset −1 px) ; la sélection reste visible dans la liste (la liste défile
seule, la page ne bouge pas quand on ouvre un résultat — correctif appliqué
pendant la vérification, voir « Bogues trouvés »).

### 8. Centrage fiable, pas aléatoire (surtout les premiers résultats)
**Vérifié.** Centrage mesuré sur les résultats 1 (page 3), 72 et 146, et
après 5 changements de page : offset 0 à −1 px à chaque fois, jamais
aléatoire.

### 9. « Plus grand » par défaut à l'ouverture
**Vérifié.** Sur profil frais (auto-test avec `--user-data-dir` neuf), le
mode à l'ouverture est « large » ; « Page entière » reste disponible en
un clic.

### 10. Même comportement en fenêtre étroite (390×844)
**Vérifié** (adaptation du point mobile au desktop : fenêtre redimensionnée
à 390×844). 25/25 vérifications OK à cette taille aussi : même centrage
(offset 0 px), même « Plus grand » par défaut, mêmes boutons fixes, mêmes
sections visibles, pas de débordement horizontal (test dédié :
`scrollWidth` = `clientWidth`). Non vérifié sur un vrai téléphone :
c'est une application desktop, il n'y a pas de version mobile.

### 11. Bloc de navigation flottant
**Vérifié par mesure.** Visible, épinglé en bas au centre du lecteur,
hors de la zone de défilement du PDF (`outsideScrollArea: true`,
`pinnedBottom: true`, `centered: true`), dans les deux modes, aux deux
tailles de fenêtre. Contenu : Sections (menu + numéros de page), Page
précédente/suivante, « Page X sur N » toujours visible (captures 01–05).

### 12. Changement de page sans rechargement
**Vérifié.** Une seule instance pdf.js par document ; compteur de
chargements mesuré : `chargements172n = 1` après ouverture du résultat,
feuilletage 40→41, 80→81, 120→121, saut de section et navigation 47→48.
Page 2 du 172N rendue sans erreur et mesurée à 0 pixel non blanc :
elle est réellement blanche dans le PDF d'origine, pas un bug.

### 13. Changement de section sans rechargement, quelle que soit la distance
**Vérifié.** Saut section 1 → section 8 (p. 146) : page affichée, erreur
« aucune », toujours 1 seul chargement du document. Premier changement de
section compris (point 14, même mesure).

### 14. Le TOUT PREMIER changement de section ne recharge pas non plus
**Vérifié.** Le premier saut de section après l'ouverture (section 8,
p. 146) se fait avec 1 seul chargement, sans état de chargement.

### 15. Page par page : arriver à une nouvelle section ne recharge pas, jamais de page vide
**Vérifié.** Navigation 47 → 48 (fin de section 3 → section 4) : page 48
affichée, erreur « aucune ». Les anciennes frontières de morceaux du 172N
(40↔41, 80↔81, 120↔121) s'affichent toutes sur place, sans erreur
« Impossible d'afficher cette page » — il n'y a plus de morceaux du tout :
le PDF entier est chargé d'un coup. Page 39 (scan décalé dans la source) :
rendue telle quelle, sans erreur, sans retouche.

### 16. Panneau « Résultats » non épinglé, page qui défile normalement
**Vérifié.** Aucun `position: fixed` ni `position: sticky` dans
`renderer/styles.css` (grep). La page défile dans l'ordre normal
(résultats, puis documents, puis outils — capture 06, prise après
défilement jusqu'aux outils). La colonne de gauche et le lecteur défilent
indépendamment. Le seul élément épinglé est le bloc flottant, à
l'intérieur du lecteur (point 11).

## Autres points de la spécification

- **Synonymes.** Liste fixe dans `data/synonyms.json` (43 groupes FR↔EN).
  **Statut : toutes les paires sont marquées « à confirmer »** — la
  vérification par l'action de recherche de l'espace web n'a pas été
  possible pour cet agent (aucune fonction d'invocation d'action de
  l'artifact n'était exposée). En revanche chaque paire a été vérifiée sur
  les données locales (les mêmes index que l'espace) : « décrochage »
  trouve « stall », « pression d'huile » trouve « oil pressure » (43 pages
  au total, dont les pages EN), « carburant » trouve « fuel », « centrage »
  trouve « center of gravity », « volets » → « flaps », « givrage » →
  « icing ». Surtout, le moteur reproduit EXACTEMENT les chiffres connus
  de l'espace : « stall » 172N = 11 pages, « stall speed » = 12 pages,
  « fuel » = 209 résultats — ce qui corrobore le comportement
  d'expansion. Une paire reste à confirmer côté espace avant d'être
  présentée comme acquise.
- **Avertissement OCR (172N).** Bannière affichée quand le 172N est ouvert
  (test : `ocr=true`) et mention sur sa carte document. Aucun chiffre OCR
  n'est présenté comme valeur sûre.
- **Puces documents.** Chaque document s'ouvre à sa page 1 (test SOP :
  `doc=sop-c150 page=1 chapitres=5`).
- **Conversions.** Testées dans l'appli et via le champ : 10 gal US =
  37,85 L ; 100 lb = 45,36 kg ; 10 gal US d'avgas = 60,00 lb (6 lb/gal) ;
  virgule acceptée (10,5 gal → 39,75 L). Aussi : ft↔m, in↔cm, NM↔km,
  kt↔km/h, °C↔°F, inHg↔hPa.
- **Calculatrice.** Générale : `2+3*4 = 14` (test dans l'appli).
- **Pas de « Demander à Jarvis ».** Absent, comme demandé (remplacé plus
  tard par les réglages IA, hors périmètre).
- **Aucune sélection collée.** Après un clic, le focus est relâché
  (`blur()`, test : `focus=body`) ; aucun anneau de focus persistant
  (CSS `:focus` sans contour, `:focus-visible` seul pour le clavier).
- **Hors réseau.** Zéro appel réseau : seules des URL `app://` locales sont
  chargées (PDF, index, pdf.js vendu dans l'appli). Aucun CDN.
- **Packaging.** `package.json` prêt pour electron-builder (main, scripts
  `start`/`build`, section `build`, electron-builder 26.18.0 installé et
  vérifié). Le `.exe` Windows via GitHub Actions est hors périmètre.

## Bogues trouvés et corrigés pendant la vérification

1. Protocole `app://` : le host (`renderer`) était perdu dans le chemin —
   tout retournait 404. Corrigé (host + pathname).
2. Imports de modules ES relatifs cassés sur le schéma maison — passés en
   URL absolues `app://…` (documenté dans le code).
3. URL du worker pdf.js résolue en relatif (`app://renderer/assets/…`) —
   mise en absolu.
4. `getDocument` appelé plusieurs fois en parallèle (7 chargements) —
   promesse mise en cache : 1 seul chargement par document.
5. Centrage faux (−193 px) : `offsetTop` compté deux fois (panneau
   positionné). Recalcul par `getBoundingClientRect`, puis compensation
   par marge quand le défilement ne peut pas centrer (fenêtre étroite).
6. Bloc flottant qui passait sur deux lignes (rétrécissement flex) —
   `width: max-content`.
7. Carte de résultat : section et « Trouvé » collés sur la même ligne
   (spans en ligne) — passés en bloc ; extraits coupés en milieu de mot —
   coupe aux limites de mots.
8. Ouverture d'un résultat qui faisait défiler toute la page —
   défilement limité à la liste des résultats.
9. Débordement horizontal de 16 px en fenêtre étroite (barre de navigation
   des résultats trop large) — `min-width: 0` + enroulement + marges
   réduites.

## Points non vérifiés / limites honnêtes

- **Synonymes vs espace web** : voir ci-dessus — « à confirmer » pour
  toutes les paires (action de l'espace non invocable depuis cet agent).
- **Vrai téléphone** : non testé (application desktop) ; la fenêtre étroite
  390×844 a été testée à la place, 25/25.
- **Packaging Windows** : non produit (hors périmètre) ; la configuration
  est prête, non le `.exe`.
- **Performance sur la machine de Julien** : testé sur cette VM (1,5 CPU)
  ; le chargement du 172N (19 Mo) prend ~1 s ici. Le 172R (482 pages) n'a
  pas fait l'objet d'un test de durée de premier chargement isolé.
- **Page 39 du 172N** : rendu vérifié sans erreur ; le décalage du scan
  est dans le PDF source et rendu tel quel (pas de retouche possible ni
  souhaitée).
