# Cahier des charges — changement du logo (icône) de Bibliothèque Aviation

Version du logiciel concernée : 1.2.6 → 1.2.7.
État de départ vérifié le 27 novembre 2026 : aucune icône personnalisée n’est
configurée (pas de clé `icon` dans `package.json`, aucun fichier .icns/.ico,
rien dans `main.js` ni dans le workflow). L’icône affichée est celle par
défaut d’Electron.

## Règle d’uniformité (Julien, 27 novembre 2026)

Ce qu’on change quelque part doit être exactement pareil partout. Comme un vrai
logiciel d’entreprise : aucune différence entre les surfaces. Le même visuel,
partout :

- icône de l’application (Dock macOS, barre des tâches Windows),
- installeur,
- en-tête du README et des documents,
- page du dépôt GitHub.

Si le logo change un jour, il change sur toutes les surfaces en même temps,
dans la même version. Jamais une surface avec l’ancien et une autre avec le nouveau.

## Design

- Un seul symbole, simple : un manuel ouvert (livre) avec un petit avion au-dessus.
- Deux couleurs : bleu nuit et ambre.
- Lisible dès 16 pixels (barre des tâches, Dock) : pas de détails fins.
- Pas de texte dans l’icône : le nom de l’application est affiché à côté par le système.
- Aucun changement de l’interface elle-même : la parité avec la page web et le
  design actuel ne bougent pas (voir la règle de parité : mêmes écrans, mêmes
  boutons, mêmes mots, partout).

## Formats et implémentation

- Source : PNG 1024 × 1024, conservée dans le dépôt.
- Générés au build : `.icns` (macOS) et `.ico` (Windows), à partir de la source.
- Clé `icon` ajoutée dans la configuration de build de `package.json`.
- Contrôle bloquant : le build refuse de partir si aucun fichier d’icône n’est
  présent — l’icône par défaut d’Electron ne doit plus jamais pouvoir sortir.

## Mise en œuvre et acceptation

1. Proposition approuvée par Julien le 27 novembre 2026 : n° 2, la rose des vents avec l’avion au centre.
2. Implémentation (fichiers + configuration de build).
3. Tests : les 12 suites + l’auto-test Electron doivent rester verts.
4. Version 1.2.7, release avec les installeurs Mac et Windows.
5. Vérification : l’icône est visible dans le Dock, la barre des tâches et
   l’installeur, sur Mac et sur Windows.
6. Les camarades de classe retéléchargent la version pour voir la nouvelle icône.

Hors périmètre : aucune nouvelle fonction, aucun changement de design de
l’interface, aucune modification du mécanisme de mise à jour.
