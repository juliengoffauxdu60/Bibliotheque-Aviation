// Libellés de sections à deux niveaux (v1.2.1) — helper partagé par le
// lecteur (renderer/app.js : titre + menu « Sections ▾ »), la recherche
// (renderer/search.js : `sectionLabel` des résultats) et les citations
// de l'IA (qui affichent ce même `sectionLabel`, via ai-retrieve.js,
// ai.js et ai-providers.js — aucun code à changer de ce côté-là, la
// valeur arrive déjà complète).
// Module pur (aucune dépendance DOM/Electron) : importable en Node
// (tests) comme dans le rendu.
// Modèle v1.2.1 : une sous-section porte `chapter` (clé du chapitre,
// ex. 'GEN') et un libellé court (ex. '1.0 — Renseignements généraux') ;
// le libellé complet préfixe le chapitre : 'GEN 1.0 — Renseignements
// généraux'. Sans chapitre (document simple, anciennes données sans
// champ `level`), le libellé est renvoyé tel quel — rien ne change.
// `fallbackChapterKey` (optionnel) : chapitre résolu par la position
// (app.js) pour une sous-section sans champ `chapter` explicite.
export function fullSectionLabel(section, fallbackChapterKey) {
  if (!section) return '';
  const label = section.label || '';
  const ch = section.chapter || fallbackChapterKey;
  if (!ch) return label;
  if (label.startsWith(ch + ' ')) return label; // déjà préfixé
  return ch + ' ' + label;
}
