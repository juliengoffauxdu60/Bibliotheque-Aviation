# Contribuer au projet — Bibliothèque Aviation

> **English version below** — la version anglaise est plus bas dans cette même page.

Merci de vouloir aider ! Tout le monde peut aider : signaler un problème,
proposer une idée, ou proposer une modification du code. Cette page explique
comment faire, étape par étape, avec des mots simples.

**Responsable du projet :** Julien Goffaux.

**Licence du projet :** GPL-3.0 (voir le fichier `LICENSE`). En une phrase :
tout le monde peut utiliser, modifier et partager ce logiciel, à condition de
partager les modifications sous la même licence.

---

## 1. Signaler un problème

1. Ouvrez votre navigateur et allez à la page du projet :
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation
2. Si vous n'avez pas de compte GitHub, cliquez sur **Sign up** en haut à
   droite et créez un compte gratuit (une adresse courriel et un mot de
   passe). Sinon, cliquez sur **Sign in** et connectez-vous.
3. En haut de la page du projet, cliquez sur l'onglet **Issues**. La liste
   des problèmes déjà signalés s'affiche. Vérifiez si votre problème est
   déjà là : si oui, ajoutez un commentaire au lieu d'ouvrir un nouveau
   problème.
4. Cliquez sur le bouton vert **New issue**, à droite.
5. Cliquez sur **Get started** à côté de **Signaler un problème**.
6. Remplissez les cases avec vos mots, simplement :
   - ce que vous avez fait, dans l'ordre ;
   - ce que vous avez vu à l'écran ;
   - ce qui aurait dû se passer ;
   - votre ordinateur (Windows ou Mac) et le numéro de version écrit sous
     le titre de l'application.
   Une photo de l'écran aide beaucoup : glissez-la dans le formulaire.
7. Cliquez sur le bouton vert **Submit new issue**, en bas. C'est envoyé.
   Julien vous répondra sur la même page.

## 2. Proposer une idée

Faites exactement les mêmes étapes que pour un problème, mais choisissez le
modèle **Proposer une idée** à l'étape 5. Décrivez votre idée simplement :
ce que vous voudriez faire, et pourquoi ce serait utile. Une seule idée par
proposition, pour que la discussion reste claire.

## 3. Proposer une modification du code

Cette partie est pour les personnes qui modifient du code. Chaque mot
technique est expliqué sur place.

1. Ouvrez la page du projet dans votre navigateur (adresse ci-dessus).
2. En haut à droite de la page, cliquez sur **Fork**. Cela fait une copie
   du projet dans votre compte. Un « fork », c'est une copie à vous : ce que
   vous y changez ne touche pas au projet de Julien.
3. Dans votre copie, faites vos changements. Faites une seule chose à la
   fois : une proposition = un seul changement, pour que Julien puisse la
   lire facilement.
4. Avant d'envoyer, lancez les vérifications automatiques du projet. Ce sont
   des programmes qui vérifient que l'application marche encore. Si vous
   avez installé les outils du projet (voir la partie « Pour les
   développeurs » du fichier `README.md`), la commande est :

   ```bash
   npm test
   ```

   Toutes les vérifications doivent passer (le message de fin dit que tout
   passe). Si une vérification échoue, corrigez avant d'envoyer. Si vous
   ne pouvez pas lancer les vérifications, dites-le dans votre proposition.
5. Dans votre copie, sur GitHub, cliquez sur **Contribute**, puis sur
   **Open pull request**. Une « pull request », c'est une demande envoyée à
   Julien pour ajouter vos changements à son projet.
6. Décrivez ce que vous avez changé et pourquoi, simplement. Dites aussi
   comment vous avez vérifié que ça marche.
7. Cochez la case de l'accord du contributeur (voir la partie 4 ci-dessous).
   Sans cette case cochée, la demande ne peut pas être acceptée.
8. Cliquez sur **Create pull request**. Votre demande est envoyée. Julien la
   lira et vous répondra sur la même page. Il peut demander des changements :
   c'est normal, ce n'est pas un refus.

## 4. L'accord du contributeur (obligatoire)

En proposant une modification, vous acceptez la phrase suivante. Elle est
obligatoire : elle permet au projet de garder la porte ouverte, un jour,
à une autre licence (par exemple commerciale), tout en gardant le code
ouvert sous GPL-3.0 aujourd'hui.

> En proposant une modification, je conserve mes droits sur mon code et
> j'autorise le projet à l'utiliser, le modifier et le distribuer sous la
> licence du projet (GPL-3.0), y compris sous une autre licence plus tard
> (par exemple commerciale).

Vous gardez vos droits : cette phrase ne vous les enlève pas. Elle autorise
simplement le projet à réutiliser votre contribution, y compris si la licence
change un jour.

## 5. Les règles simples

- Soyez poli et patient : Julien lit tout, mais il répond quand il peut.
- Une proposition = un seul sujet. Ne mélangez pas plusieurs changements.
- Décrivez le « pourquoi », pas seulement le « quoi » : pourquoi ce
  changement aide les utilisateurs ?
- Ne changez jamais le comportement d'une fonction sans mettre à jour les
  vérifications automatiques qui la couvrent.
- Ne mettez jamais de mot de passe, de clé ou de secret dans le code, ni
  dans les messages. Les clés API restent sur l'ordinateur de chacun.
- Si vous n'êtes pas sûr, ouvrez d'abord une proposition d'idée (partie 2)
  pour en parler avant de coder.

---

# Contributing — Bibliothèque Aviation (English version)

> **Version française ci-dessus** — the French version is above, on this same page.

Thank you for wanting to help! Everyone can help: report a problem, suggest
an idea, or propose a code change. This page explains how, step by step, in
simple words.

**Project lead:** Julien Goffaux.

**Project licence:** GPL-3.0 (see the `LICENSE` file). In one sentence:
everyone may use, modify and share this software, provided that modifications
are shared under the same licence.

---

## 1. Report a problem

1. Open your browser and go to the project page:
   https://github.com/juliengoffauxdu60/Bibliotheque-Aviation
2. If you do not have a GitHub account, click **Sign up** at the top right
   and create a free account (an email address and a password). Otherwise,
   click **Sign in** and log in.
3. At the top of the project page, click the **Issues** tab. The list of
   problems already reported appears. Check whether your problem is already
   there: if it is, add a comment instead of opening a new problem.
4. Click the green **New issue** button, on the right.
5. Click **Get started** next to **Signaler un problème** (Report a problem).
6. Fill in the boxes in your own words, simply:
   - what you did, in order;
   - what you saw on the screen;
   - what should have happened;
   - your computer (Windows or Mac) and the version number written under
     the application's title.
   A photo of the screen helps a lot: drag it into the form. You may write
   in French or in English.
7. Click the green **Submit new issue** button, at the bottom. It is sent.
   Julien will answer you on the same page.

## 2. Suggest an idea

Follow exactly the same steps as for a problem, but choose the
**Proposer une idée** (Suggest an idea) template at step 5. Describe your
idea simply: what you would like to do, and why it would be useful. One idea
per proposal, so the discussion stays clear.

## 3. Propose a code change

This part is for people who modify code. Every technical word is explained
right where it appears.

1. Open the project page in your browser (address above).
2. At the top right of the page, click **Fork**. This makes a copy of the
   project in your account. A "fork" is a copy of your own: what you change
   in it does not touch Julien's project.
3. In your copy, make your changes. Do one thing at a time: one proposal =
   one single change, so Julien can read it easily.
4. Before sending, run the project's automatic checks. These are programs
   that verify the application still works. If you installed the project's
   tools (see the "For developers" part of the `README.md` file), the
   command is:

   ```bash
   npm test
   ```

   All checks must pass (the final message says everything passes). If a
   check fails, fix it before sending. If you cannot run the checks, say so
   in your proposal.
5. In your copy, on GitHub, click **Contribute**, then **Open pull request**.
   A "pull request" is a request sent to Julien to add your changes to his
   project.
6. Describe what you changed and why, simply. Also say how you verified
   that it works.
7. Check the contributor agreement box (see part 4 below). Without this box
   checked, the request cannot be accepted.
8. Click **Create pull request**. Your request is sent. Julien will read it
   and answer you on the same page. He may ask for changes: that is normal,
   it is not a refusal.

## 4. The contributor agreement (required)

By proposing a change, you accept the following sentence. It is required:
it keeps the door open, one day, to another licence (for example a
commercial one), while keeping the code open under GPL-3.0 today.

> By proposing a change, I keep my rights to my code and I allow the project
> to use, modify and distribute it under the project's licence (GPL-3.0),
> including under a different licence later (for example a commercial one).

You keep your rights: this sentence does not take them away. It simply
allows the project to reuse your contribution, including if the licence
changes one day.

## 5. Simple rules

- Be polite and patient: Julien reads everything, but answers when he can.
- One proposal = one subject. Do not mix several changes.
- Describe the "why", not only the "what": why does this change help users?
- Never change how something behaves without updating the automatic checks
  that cover it.
- Never put a password, a key or a secret in the code or in messages. API
  keys stay on each person's computer.
- If you are not sure, first open an idea proposal (part 2) to talk about
  it before coding.
