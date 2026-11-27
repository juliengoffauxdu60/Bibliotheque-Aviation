# Bibliothèque Aviation

<img src="build/icon.png" alt="Icône de la Bibliothèque Aviation" width="120">

> **English version below** — la version anglaise est plus bas dans cette même page.

La Bibliothèque Aviation est une application pour chercher des mots dans vos
manuels de vol (les POH, les AIM, les RAC et les autres documents d'aviation).
Vous tapez un mot, l'application vous montre les pages où il se trouve, et vous
lisez la page dans le document. L'application fonctionne sans Internet pour la
recherche. Elle marche sur Windows et sur Mac, de la même façon.

**Responsable du projet :** Julien Goffaux. C'est lui qui décide seul ce qui
entre dans le projet.

**Licence :** GPL-3.0. En une phrase : tout le monde peut utiliser, modifier et
partager ce logiciel, à condition de partager les modifications sous la même
licence. Le texte complet est dans le fichier `LICENSE`.

---

## Télécharger et installer l'application

Vous n'avez besoin d'aucune connaissance en informatique. Suivez les étapes
dans l'ordre. Une seule action par étape.

1. Ouvrez votre navigateur Internet (Chrome, Edge, Safari ou Firefox).
2. Allez à la page des versions de l'application :
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation/releases
   La page des versions s'affiche.
3. En haut de la page, trouvez la version marquée **Latest** (c'est la plus
   récente). Ne touchez à rien d'autre.
4. Sous le titre de la version, trouvez la liste des fichiers à télécharger
   (la partie appelée **Assets**).
   - **Si vous avez un ordinateur Windows :** cliquez sur le fichier dont le
     nom se termine par `.exe`. Le téléchargement commence.
   - **Si vous avez un ordinateur Mac :** cliquez sur le fichier dont le nom
     se termine par `.dmg`. Le téléchargement commence.
5. Attendez que le téléchargement soit terminé. Le fichier arrive dans votre
   dossier **Téléchargements**.

### Sur Windows

6. Ouvrez le dossier **Téléchargements** et double-cliquez sur le fichier
   `.exe` que vous venez de télécharger. Une fenêtre d'installation s'ouvre.
7. Si Windows affiche un avertissement de sécurité, cliquez sur
   **Informations complémentaires**, puis sur **Exécuter quand même**.
   L'installation continue.
8. Suivez les écrans de l'installation en cliquant sur **Suivant**, puis sur
   **Installer**. Quand c'est terminé, cliquez sur **Terminer**.
9. L'application s'ouvre. Vous pouvez aussi la rouvrir plus tard depuis le
   menu **Démarrer** de Windows : cherchez « Bibliothèque Aviation ».

### Sur Mac

6. Ouvrez le dossier **Téléchargements** et double-cliquez sur le fichier
   `.dmg` que vous venez de télécharger. Une fenêtre s'ouvre avec deux icônes.
7. Faites glisser l'icône **Bibliothèque Aviation** sur l'icône du dossier
   **Applications** dans la même fenêtre. La copie commence.
8. Ouvrez le dossier **Applications** et double-cliquez sur
   **Bibliothèque Aviation**. L'application s'ouvre.
9. Si votre Mac refuse d'ouvrir l'application la première fois, faites un
   clic droit (ou un clic en gardant la touche **Ctrl** enfoncée) sur
   **Bibliothèque Aviation**, choisissez **Ouvrir**, puis cliquez de nouveau
   sur **Ouvrir** dans la petite fenêtre qui apparaît. L'application s'ouvre.
   Vous n'aurez à le faire qu'une seule fois.

---

## Ajouter vos manuels

Au premier lancement, l'application est vide : c'est normal. L'application est
livrée sans aucun document. Vous ajoutez vos propres manuels, qui restent sur
votre ordinateur.

1. Dans l'application, trouvez la partie **Documents**, à gauche.
2. Cliquez sur le bouton **＋ Ajouter un document**. Une fenêtre s'ouvre pour
   choisir un fichier.
3. Choisissez le fichier PDF de votre manuel (par exemple un POH), puis
   cliquez sur **Ouvrir**. Le document apparaît dans la liste des documents.
4. Attendez quelques secondes : l'application lit le document pour pouvoir
   y chercher des mots. Quand la carte du document est prête, vous pouvez
   chercher dedans.
5. Recommencez pour chaque manuel que vous voulez ajouter.

Pour enlever un document, ouvrez sa carte et utilisez le bouton de suppression
de la carte. Cela n'efface pas votre fichier PDF, seulement sa copie dans
l'application.

---

## Faire une recherche

1. Dans l'application, cliquez sur **Tous les documents** (en haut, à gauche)
   pour chercher partout, ou cliquez sur la carte d'un seul document pour
   chercher seulement dedans.
2. Cliquez dans le champ de recherche et tapez le mot que vous cherchez
   (par exemple `décrochage`).
3. Appuyez sur la touche **Entrée** de votre clavier. La liste des pages
   trouvées s'affiche.
4. Cliquez sur un résultat. La page du document s'ouvre dans le lecteur,
   à droite, avec le mot surligné.
5. Pour changer de page, cliquez sur **Page précédente** ou **Page suivante**
   en haut du lecteur. Pour changer de section, cliquez sur **Sections ▾**.

La recherche trouve les mots entiers, avec ou sans accents, en français comme
en anglais. Si un document a été lu automatiquement (document scanné), la
recherche sert à trouver la page : les valeurs des tableaux se lisent dans
le document affiché, jamais dans le texte lu.

---

## Poser une question à l'IA (facultatif)

L'IA répond à vos questions en citant le document, la section et la page. Elle
ne répond qu'à partir des manuels que vous avez ajoutés. Elle n'invente rien :
si l'information n'est pas dans vos documents, elle le dit.

Pour l'utiliser, il faut une **clé API**. Une clé API, c'est un code personnel
que le fournisseur d'IA vous donne, comme un mot de passe pour utiliser son
service. Chacun met sa propre clé. Votre clé reste sur votre ordinateur : elle
n'est envoyée qu'au fournisseur que vous avez choisi.

1. En haut à droite de l'application, cliquez sur **Réglages IA**. La page
   des réglages s'ouvre.
2. Dans la liste **Fournisseur**, choisissez le fournisseur que vous voulez
   utiliser (par exemple **Gemini (Google)**).
3. Le nom du modèle (le modèle, c'est la version du service d'IA que
   l'application utilise) et l'adresse sont déjà remplis. Ne les changez
   que si le fournisseur vous dit de le faire.
4. Cliquez dans le champ **Clé API** et collez votre clé.
5. Cliquez sur **Enregistrer**. Le message « Réglages enregistrés » s'affiche.
6. Cliquez sur **Tester la connexion**. Si le test réussit, le message
   « Connexion OK » s'affiche, avec le temps que chaque étape a pris. Si le
   test échoue, le message dit pourquoi (par exemple la clé a été refusée,
   ou la réponse a mis trop de temps).
7. Fermez la page des réglages. En bas de la page principale, tapez votre
   question dans le champ prévu, puis cliquez sur **Demander à l'IA**.
   La réponse s'affiche avec ses sources. Cliquez sur une source pour ouvrir
   la page du document.

Sans clé, sans Internet, ou si le test échoue : la recherche et le lecteur
fonctionnent quand même, normalement.

---

## Mises à jour

L'application vérifie toute seule s'il existe une version plus récente, au
démarrage puis régulièrement. Vous n'avez rien à faire.

- Le numéro de la version que vous utilisez est écrit sous le titre
  **Bibliothèque Aviation**, en haut de la page principale.
- Pour vérifier vous-même : cliquez sur **Vérifier les mises à jour**, en haut
  à droite. Si une nouvelle version existe, une bande s'affiche en haut de la
  page : cliquez sur **Mettre à jour** pour la télécharger, puis sur
  **Redémarrer pour installer** quand le téléchargement est terminé.
- Pour arrêter les vérifications automatiques : ouvrez **Réglages IA**,
  allez en bas de la page, dans la partie **Mises à jour**, et décochez la
  case **Vérifier automatiquement les mises à jour au démarrage**. Vous
  pourrez toujours vérifier vous-même avec le bouton en haut de la page.
- Si une vérification échoue, l'application continue normalement. Le message
  dit ce qui s'est passé, et un détail technique s'affiche dans la partie
  **Mises à jour** des réglages.

---

## Signaler un problème

Vous avez trouvé quelque chose qui ne marche pas ? Dites-le : chaque problème
signalé aide à améliorer l'application. Vous n'avez pas besoin de savoir
comment l'application est faite. Il faut seulement un compte GitHub gratuit
(un compte, c'est une adresse courriel et un mot de passe sur le site GitHub).

1. Ouvrez votre navigateur et allez à la page du projet :
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation
   La page du projet s'affiche.
2. Si vous n'avez pas de compte GitHub, cliquez sur **Sign up** en haut à
   droite et suivez les écrans pour créer un compte gratuit. Sinon, cliquez
   sur **Sign in** et connectez-vous.
3. En haut de la page du projet, cliquez sur l'onglet **Issues**. La liste
   des problèmes déjà signalés s'affiche.
4. Cliquez sur le bouton vert **New issue**, à droite. Une page s'ouvre avec
   des modèles à choisir.
5. Cliquez sur **Get started** à côté de **Signaler un problème**.
   Un formulaire s'ouvre.
6. Remplissez les cases :
   - **Ce qui s'est passé :** décrivez ce que vous avez fait, dans l'ordre,
     et ce que vous avez vu à l'écran.
   - **Ce que vous attendiez :** décrivez ce qui aurait dû se passer.
   - **Votre ordinateur :** Windows ou Mac, et le numéro de version écrit
     sous le titre de l'application.
   Écrivez avec vos mots, simplement. Une photo de l'écran aide beaucoup :
   glissez-la dans le formulaire.
7. Cliquez sur le bouton vert **Submit new issue**, en bas. Votre problème
   est envoyé. Julien lit les problèmes signalés régulièrement et vous
   répondra sur la même page.

---

## Proposer une idée

Vous avez une idée pour améliorer l'application ? Faites comme pour un
problème, mais choisissez le modèle **Proposer une idée** à l'étape 5.
Décrivez votre idée simplement : ce que vous voudriez faire, et pourquoi ce
serait utile. Julien lit les idées régulièrement et décide ce qui entre dans
le projet.

---

## Proposer une modification du code

Vous savez modifier du code et vous voulez proposer un changement ? Les étapes
sont expliquées une par une dans le fichier `CONTRIBUTING.md`. En résumé :

1. Faites une copie du projet dans votre compte (c'est ce qu'on appelle
   un « fork » : une copie à vous, qui ne change rien au projet de Julien).
2. Faites vos changements dans votre copie.
3. Envoyez une demande à Julien pour ajouter vos changements (c'est ce qu'on
   appelle une « pull request » : une demande d'ajout).
4. Décrivez ce que vous avez changé, et cochez la case qui dit que vous
   acceptez les règles de contribution (voir `CONTRIBUTING.md`).
5. Julien lit votre demande et décide seul si elle entre dans le projet.

---

## Pour les développeurs

> Cette partie est seulement pour les personnes qui modifient le code de
> l'application. Si vous voulez seulement utiliser l'application,
> arrêtez-vous ici : vous avez déjà tout ce qu'il faut plus haut.

L'application est faite avec Electron (un outil qui fabrique des applications
pour ordinateurs à partir de pages web). Le code est dans ce dépôt.

```bash
git clone https://github.com/juliengoffauxdu60/Bibliotheque-Aviation.git
cd Bibliotheque-Aviation
npm install   # une seule fois : télécharge les outils
npm start     # ouvre l'application
npm test      # lance les vérifications automatiques
```

Pour fabriquer les fichiers à installer (Windows et Mac) :

```bash
npm run dist      # installateur Windows (.exe)
npm run dist:mac  # fichiers Mac (.dmg et .zip)
```

Les règles pour proposer du code sont dans `CONTRIBUTING.md`. Les vérifications
automatiques doivent toutes passer avant d'envoyer une demande.

---

# Bibliothèque Aviation (English version)

> **Version française ci-dessus** — the French version is above, on this same page.

Bibliothèque Aviation is an application for searching words in your flight
manuals (POHs, AIMs, RACs and other aviation documents). You type a word, the
application shows you the pages where it appears, and you read the page in the
document. Searching works without Internet. The application runs on Windows and
on Mac, in the same way.

**Project lead:** Julien Goffaux. He alone decides what goes into the project.

**Licence:** GPL-3.0. In one sentence: everyone may use, modify and share this
software, provided that modifications are shared under the same licence. The
full text is in the `LICENSE` file.

---

## Download and install the application

You need no computer knowledge. Follow the steps in order. One action per step.

1. Open your web browser (Chrome, Edge, Safari or Firefox).
2. Go to the application's releases page:
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation/releases
   The releases page appears.
3. At the top of the page, find the version marked **Latest** (it is the most
   recent one). Do not touch anything else.
4. Under the version title, find the list of files to download (the part
   called **Assets**).
   - **If you use a Windows computer:** click the file whose name ends with
     `.exe`. The download starts.
   - **If you use a Mac computer:** click the file whose name ends with
     `.dmg`. The download starts.
5. Wait until the download is finished. The file arrives in your
   **Downloads** folder.

### On Windows

6. Open the **Downloads** folder and double-click the `.exe` file you just
   downloaded. An installation window opens.
7. If Windows shows a security warning, click **More info**, then
   **Run anyway**. The installation continues.
8. Follow the installation screens by clicking **Next**, then **Install**.
   When it is finished, click **Finish**.
9. The application opens. You can also reopen it later from the Windows
   **Start** menu: search for "Bibliothèque Aviation".

### On Mac

6. Open the **Downloads** folder and double-click the `.dmg` file you just
   downloaded. A window opens with two icons.
7. Drag the **Bibliothèque Aviation** icon onto the **Applications** folder
   icon in the same window. The copy starts.
8. Open the **Applications** folder and double-click
   **Bibliothèque Aviation**. The application opens.
9. If your Mac refuses to open the application the first time, right-click
   (or click while holding the **Ctrl** key) on **Bibliothèque Aviation**,
   choose **Open**, then click **Open** again in the small window that
   appears. The application opens. You only have to do this once.

---

## Add your manuals

On first launch, the application is empty: that is normal. The application
comes with no documents. You add your own manuals, which stay on your
computer.

1. In the application, find the **Documents** part, on the left.
2. Click the **＋ Ajouter un document** button. A window opens to choose
   a file.
3. Choose the PDF file of your manual (for example a POH), then click
   **Open**. The document appears in the document list.
4. Wait a few seconds: the application reads the document so that words can
   be searched in it. When the document card is ready, you can search in it.
5. Repeat for each manual you want to add.

To remove a document, open its card and use the card's delete button. This
does not delete your PDF file, only its copy inside the application.

---

## Search

1. In the application, click **Tous les documents** (at the top, on the left)
   to search everywhere, or click a single document's card to search only
   in that document.
2. Click in the search field and type the word you are looking for
   (for example `décrochage`).
3. Press the **Enter** key on your keyboard. The list of pages found appears.
4. Click a result. The document page opens in the reader, on the right, with
   the word highlighted.
5. To change pages, click **Page précédente** (previous page) or
   **Page suivante** (next page) at the top of the reader. To change
   sections, click **Sections ▾**.

Searching finds whole words, with or without accents, in French and in
English. If a document was read automatically (a scanned document), search
is for finding the page: table values are read in the displayed document,
never in the read text.

---

## Ask the AI a question (optional)

The AI answers your questions and quotes the document, the section and the
page. It answers only from the manuals you added. It never invents anything:
if the information is not in your documents, it says so.

To use it, you need an **API key**. An API key is a personal code that the AI
provider gives you, like a password for using its service. Each person enters
their own key. Your key stays on your computer: it is only sent to the
provider you chose.

1. At the top right of the application, click **Réglages IA** (AI settings).
   The settings page opens.
2. In the **Fournisseur** (provider) list, choose the provider you want to
   use (for example **Gemini (Google)**).
3. The model name (the model is the version of the AI service the
   application uses) and the address are already filled in. Only change
   them if the provider tells you to.
4. Click in the **Clé API** (API key) field and paste your key.
5. Click **Enregistrer** (Save). The message « Réglages enregistrés »
   (settings saved) appears.
6. Click **Tester la connexion** (Test the connection). If the test succeeds,
   the message « Connexion OK » appears, with the time each step took. If the
   test fails, the message says why (for example the key was refused, or the
   answer took too long).
7. Close the settings page. At the bottom of the main page, type your
   question in the field provided, then click **Demander à l'IA** (Ask the
   AI). The answer appears with its sources. Click a source to open the
   document page.

Without a key, without Internet, or if the test fails: search and the reader
still work, normally.

---

## Updates

The application checks by itself whether a newer version exists, at startup
and then regularly. You have nothing to do.

- The number of the version you are using is written under the
  **Bibliothèque Aviation** title, at the top of the main page.
- To check yourself: click **Vérifier les mises à jour** (Check for updates),
  at the top right. If a new version exists, a banner appears at the top of
  the page: click **Mettre à jour** (Update) to download it, then click
  **Redémarrer pour installer** (Restart to install) when the download is
  finished.
- To stop automatic checks: open **Réglages IA**, go to the bottom of the
  page, in the **Mises à jour** (Updates) part, and uncheck the box
  **Vérifier automatiquement les mises à jour au démarrage**. You can still
  check yourself with the button at the top of the page.
- If a check fails, the application keeps working normally. The message says
  what happened, and a technical detail appears in the **Mises à jour** part
  of the settings.

---

## Report a problem

You found something that does not work? Say so: every problem reported helps
improve the application. You do not need to know how the application is made.
You only need a free GitHub account (an account is an email address and a
password on the GitHub website).

1. Open your browser and go to the project page:
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation
   The project page appears.
2. If you do not have a GitHub account, click **Sign up** at the top right
   and follow the screens to create a free account. Otherwise, click
   **Sign in** and log in.
3. At the top of the project page, click the **Issues** tab. The list of
   problems already reported appears.
4. Click the green **New issue** button, on the right. A page opens with
   templates to choose from.
5. Click **Get started** next to **Signaler un problème** (Report a problem).
   A form opens.
6. Fill in the boxes:
   - **What happened:** describe what you did, in order, and what you saw
     on the screen.
   - **What you expected:** describe what should have happened.
   - **Your computer:** Windows or Mac, and the version number written
     under the application's title.
   Write in your own words, simply. A photo of the screen helps a lot:
   drag it into the form. You may write in French or in English.
7. Click the green **Submit new issue** button, at the bottom. Your problem
   is sent. Julien reads reported problems regularly and will answer you on
   the same page.

---

## Suggest an idea

You have an idea to improve the application? Do the same as for a problem,
but choose the **Proposer une idée** (Suggest an idea) template at step 5.
Describe your idea simply: what you would like to do, and why it would be
useful. Julien reads ideas regularly and decides what goes into the project.

---

## Propose a code change

You know how to modify code and you want to propose a change? The steps are
explained one by one in the `CONTRIBUTING.md` file. In short:

1. Make a copy of the project in your account (this is called a "fork": a
   copy of your own, which changes nothing in Julien's project).
2. Make your changes in your copy.
3. Send Julien a request to add your changes (this is called a "pull
   request": a request to add).
4. Describe what you changed, and check the box that says you accept the
   contribution rules (see `CONTRIBUTING.md`).
5. Julien reads your request and alone decides whether it goes into the
   project.

---

## For developers

> This part is only for people who modify the application's code. If you only
> want to use the application, stop here: you already have everything you
> need above.

The application is built with Electron (a tool that makes computer
applications from web pages). The code is in this repository.

```bash
git clone https://github.com/juliengoffauxdu60/Bibliotheque-Aviation.git
cd Bibliotheque-Aviation
npm install   # once: downloads the tools
npm start     # opens the application
npm test      # runs the automatic checks
```

To build the install files (Windows and Mac):

```bash
npm run dist      # Windows installer (.exe)
npm run dist:mac  # Mac files (.dmg and .zip)
```

The rules for proposing code are in `CONTRIBUTING.md`. The automatic checks
must all pass before sending a request.
