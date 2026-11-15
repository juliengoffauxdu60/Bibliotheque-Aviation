// Tests IA (Node, sans Electron) : logique pure des fournisseurs, du prompt
// et de la récupération du contexte — contre des index JSON SYNTHÉTIQUES
// (test/fixtures/synthetic/) : les 4 documents de base ont quitté le
// dépôt (15 nov. 2026) et ne doivent jamais y revenir.
// Usage : node test/ai.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROVIDERS, maskKey, buildRequest, extractAnswer, mapHttpError,
  mapNetworkError, callProvider, buildPrompt, aiError,
} from '../renderer/ai-providers.js';
import { extractQuestionTerms, extractQuestionPhrases, retrieveContext } from '../renderer/ai-retrieve.js';
import { buildTermRegex } from '../renderer/search.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const base = path.join(root, '..');
const synthetic = path.join(root, 'fixtures', 'synthetic');
const docsMeta = JSON.parse(fs.readFileSync(path.join(synthetic, 'data/docs.json'), 'utf8'));
const synonyms = JSON.parse(fs.readFileSync(path.join(base, 'data/synonyms.json'), 'utf8'));
const docs = docsMeta.docs.map((d) => JSON.parse(fs.readFileSync(path.join(synthetic, d.index), 'utf8')));
const meta = {};
for (const d of docsMeta.docs) meta[d.id] = d;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu ${JSON.stringify(actual)}, attendu ${JSON.stringify(expected)}`);
  if (!ok) failures++;
}
async function checkThrows(name, fn, expectedMessage) {
  try {
    await fn();
    console.log(`ÉCHEC ${name} — aucune erreur levée, attendu « ${expectedMessage} »`);
    failures++;
  } catch (e) {
    const ok = (e.userMessage || e.message) === expectedMessage;
    console.log(`${ok ? 'OK  ' : 'ÉCHEC'} ${name} — obtenu « ${e.userMessage || e.message} », attendu « ${expectedMessage} »`);
    if (!ok) failures++;
  }
}
function fakeFetch(handler) {
  return (url, options) => handler(url, options);
}

// 1. Masquage de la clé : jamais en clair, 4 derniers caractères seulement.
check('maskKey(sk-abcdef1234)', maskKey('sk-abcdef1234'), '••••1234');
check('maskKey(vide)', maskKey(''), '');
check('maskKey(courte)', maskKey('abc'), '••••');

// 2. Fournisseurs : valeurs par défaut connues.
check('gemini : modèle par défaut', PROVIDERS.gemini.defaultModel, 'gemini-3.8-flash');
check('gemini : point de terminaison avec {model}', PROVIDERS.gemini.defaultEndpoint.includes('{model}'), true);
check('claude : modèle par défaut', PROVIDERS.claude.defaultModel, 'claude-sonnet-4-5');
check('claude : point de terminaison', PROVIDERS.claude.defaultEndpoint, 'https://api.anthropic.com/v1/messages');
check('openai : modèle par défaut', PROVIDERS.openai.defaultModel, 'gpt-4o-mini');
check('openai : point de terminaison', PROVIDERS.openai.defaultEndpoint, 'https://api.openai.com/v1/chat/completions');
check('local : pas de clé requise', PROVIDERS.local.needsKey, false);
check('local : point de terminaison Ollama', PROVIDERS.local.defaultEndpoint, 'http://localhost:11434/v1/chat/completions');
check('gemini/openai/claude : clé requise', [PROVIDERS.gemini.needsKey, PROVIDERS.openai.needsKey, PROVIDERS.claude.needsKey], [true, true, true]);

// 3. Construction des requêtes : URL, en-têtes, corps.
const promptTest = 'Question de test.';
const gReq = buildRequest('gemini', { model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest);
check('gemini : URL avec modèle inséré', gReq.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
check('gemini : clé dans x-goog-api-key', gReq.options.headers['x-goog-api-key'], 'CLE-FAUSSE');
check('gemini : corps contents/parts', JSON.parse(gReq.options.body).contents[0].parts[0].text, promptTest);

const cReq = buildRequest('claude', { model: 'claude-sonnet-4-5', endpoint: PROVIDERS.claude.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest);
check('claude : clé dans x-api-key + version', [cReq.options.headers['x-api-key'], cReq.options.headers['anthropic-version']], ['CLE-FAUSSE', '2023-06-01']);
check('claude : corps model + messages', JSON.parse(cReq.options.body).model, 'claude-sonnet-4-5');

const oReq = buildRequest('openai', { model: 'gpt-4o-mini', endpoint: PROVIDERS.openai.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest);
check('openai : clé en Bearer', oReq.options.headers.Authorization, 'Bearer CLE-FAUSSE');
check('openai : corps messages', JSON.parse(oReq.options.body).messages[0].content, promptTest);

const lReq = buildRequest('local', { model: 'llama3.1', endpoint: PROVIDERS.local.defaultEndpoint, key: '' }, promptTest);
check('local : pas d’en-tête Authorization sans clé', 'Authorization' in lReq.options.headers, false);
check('local : URL Ollama', lReq.url, 'http://localhost:11434/v1/chat/completions');

// 4. Lecture des réponses (formes de chaque fournisseur + forme illisible).
check('extractAnswer gemini', extractAnswer('gemini', { candidates: [{ content: { parts: [{ text: 'Réponse ' }, { text: 'Gemini.' }] } }] }), 'Réponse Gemini.');
check('extractAnswer claude', extractAnswer('claude', { content: [{ type: 'text', text: 'Réponse Claude.' }] }), 'Réponse Claude.');
check('extractAnswer openai', extractAnswer('openai', { choices: [{ message: { content: 'Réponse OpenAI.' } }] }), 'Réponse OpenAI.');
check('extractAnswer local (forme OpenAI)', extractAnswer('local', { choices: [{ message: { content: 'Réponse locale.' } }] }), 'Réponse locale.');
await checkThrows('extractAnswer vide -> erreur lisible',
  async () => extractAnswer('openai', { choices: [] }),
  'Le fournisseur a renvoyé une réponse vide ou illisible. Réessayez.');

// 5. Messages d'erreur clairs, sans jargon.
check('erreur 401', mapHttpError(401).userMessage, 'La clé API a été refusée par le fournisseur. Vérifiez la clé dans « Réglages IA ».');
check('erreur 404', mapHttpError(404).userMessage.includes('modèle'), true);
check('erreur 429', mapHttpError(429).userMessage.includes('attendre'), true);
check('erreur 500', mapHttpError(500).userMessage.includes('code 500'), true);
const refused = new Error('fetch failed'); refused.cause = { code: 'ECONNREFUSED' };
check('réseau local coupé', mapNetworkError(refused, 'http://localhost:11434/v1/chat/completions').userMessage.includes('IA locale'), true);
check('réseau distant coupé', mapNetworkError(refused, 'https://api.openai.com/v1/chat/completions').userMessage.includes('connexion Internet'), true);
const timeout = new Error('abandon'); timeout.name = 'AbortError';
check('délai dépassé', mapNetworkError(timeout, '').userMessage.includes('trop de temps'), true);

// 6. callProvider de bout en bout avec un fetch factice.
const okFetch = fakeFetch(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'OK, réponse.' } }] }) }));
check('callProvider openai OK',
  await callProvider({ provider: 'openai', model: 'gpt-4o-mini', endpoint: PROVIDERS.openai.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, okFetch),
  'OK, réponse.');
await checkThrows('callProvider sans clé (openai)',
  () => callProvider({ provider: 'openai', model: 'gpt-4o-mini', endpoint: PROVIDERS.openai.defaultEndpoint, key: '' }, promptTest, okFetch),
  'Il manque la clé API. Enregistrez-la dans « Réglages IA ».');
await checkThrows('callProvider sans fournisseur',
  () => callProvider({ provider: '', model: '', endpoint: '', key: '' }, promptTest, okFetch),
  'Aucune IA n’est configurée. Ouvrez « Réglages IA » pour choisir un fournisseur et enregistrer une clé.');
await checkThrows('callProvider sans modèle',
  () => callProvider({ provider: 'openai', model: '', endpoint: PROVIDERS.openai.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, okFetch),
  'Aucun modèle n’est indiqué. Complétez le nom du modèle dans « Réglages IA ».');
const fetch401 = fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }));
await checkThrows('callProvider 401 -> message clair',
  () => callProvider({ provider: 'openai', model: 'gpt-4o-mini', endpoint: PROVIDERS.openai.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, fetch401),
  'La clé API a été refusée par le fournisseur. Vérifiez la clé dans « Réglages IA ».');
const fetchDown = fakeFetch(async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; });
await checkThrows('callProvider local injoignable -> message clair',
  () => callProvider({ provider: 'local', model: 'llama3.1', endpoint: PROVIDERS.local.defaultEndpoint, key: '' }, promptTest, fetchDown),
  'Impossible de joindre l’IA locale. Vérifiez que le logiciel d’IA locale (Ollama ou LM Studio) est bien lancé, et l’adresse dans « Réglages IA ».');

// 6b. Erreur 503 de Gemini (14 nov. : Julien obtient « code 503 » sur le
// test et sur sa question) : le message du fournisseur est lu et traduit,
// et l'appel est réessayé automatiquement avant d'abandonner.
check('erreur 503 surchargé -> message clair',
  mapHttpError(503, '', 'The model is overloaded. Please try again later.').userMessage.includes('surchargé'), true);
check('erreur 400 clé invalide -> message clair',
  mapHttpError(400, '', 'API key not valid. Please pass a valid API key.').userMessage.includes('clé API'), true);
check('erreur 404 modèle introuvable -> message clair',
  mapHttpError(404, '', 'models/gemini-3.8-flash is not found for API version v1beta').userMessage.includes('modèle'), true);
check('erreur 503 sans détail -> code conservé',
  mapHttpError(503).userMessage.includes('code 503'), true);
let tries503 = 0;
const fetch503ThenOk = fakeFetch(async () => {
  tries503++;
  if (tries503 < 3) {
    return { ok: false, status: 503, json: async () => ({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }) };
  }
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) };
});
check('callProvider gemini 503 puis OK : réessaie et réussit',
  await callProvider({ provider: 'gemini', model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, fetch503ThenOk, { retryDelaysMs: [0, 0] }),
  'OK');
check('callProvider gemini 503 puis OK : 3 appels', tries503, 3);
const fetch503Always = fakeFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } }) }));
await checkThrows('callProvider gemini 503 persistant -> « surchargé », pas un code sec',
  () => callProvider({ provider: 'gemini', model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, fetch503Always, { retryDelaysMs: [0, 0] }),
  'Le modèle est surchargé en ce moment : le fournisseur demande de réessayer dans un moment. Si ça persiste, essayez un autre modèle (par exemple « gemini-3.6-flash ») dans « Réglages IA ».');
// La clé n'est jamais envoyée ailleurs que vers le fournisseur choisi :
// le fetch factice enregistre l'URL appelée.
let calledUrl = '';
const spyFetch = fakeFetch(async (url) => { calledUrl = url; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; });
await callProvider({ provider: 'custom', model: 'm', endpoint: 'http://localhost:9/v1/chat/completions', key: 'K' }, promptTest, spyFetch);
check('callProvider custom : appel vers le point configuré, pas ailleurs', calledUrl, 'http://localhost:9/v1/chat/completions');

// 7. Prompt : générique (v1.2.0, sans document fourni), consignes en
// français, avertissement OCR seulement si demandé, pas d'invention.
const pagesExemple = [
  { docTitle: 'POH Cessna 172N', sectionLabel: 'Section 5 — Performances', pageLabel: 'p. 5-12', excerpt: 'La vitesse de décrochage est de 48 kt.' },
];
const prompt = buildPrompt('Quelle est la vitesse de décrochage ?', pagesExemple);
check('prompt : question reprise', prompt.includes('Quelle est la vitesse de décrochage ?'), true);
check('prompt : extrait + référence exacte', prompt.includes('[POH Cessna 172N — Section 5 — Performances — p. 5-12]') && prompt.includes('48 kt'), true);
check('prompt : consigne ne jamais inventer', prompt.includes('N’invente jamais une valeur'), true);
// v1.2.0 : l'appli est livrée sans document fourni — le prompt est
// générique (aucun POH nommé dans les consignes) et l'avertissement sur
// les chiffres lus automatiquement n'apparaît que si on le demande
// explicitement. (Les extraits eux-mêmes citent leur vrai document —
// c'est normal : on vérifie les CONSIGNES, donc un prompt sans extrait.)
const promptSansExtrait = buildPrompt('Quelle est la vitesse de décrochage ?', []);
check('prompt : générique, aucun document nommé', !promptSansExtrait.includes('172N') && !promptSansExtrait.includes('172R') && !promptSansExtrait.includes('SOP') && !promptSansExtrait.includes('Air Richelieu') && promptSansExtrait.includes('documents chargés dans l’application'), true);
check('prompt : pas d’avertissement OCR par défaut', promptSansExtrait.includes('OCR') || promptSansExtrait.includes('lecture automatique'), false);
const promptOcr = buildPrompt('Quelle est la vitesse de décrochage ?', [], { ocrWarning: true });
check('prompt : avertissement OCR seulement si demandé', promptOcr.includes('lecture automatique') && promptOcr.includes('vérifier chaque valeur'), true);
check('prompt : avertissement OCR générique, sans 172N', promptOcr.includes('172N'), false);
check('prompt : réponse en français', prompt.includes('Réponds en français'), true);
check('prompt : citation document/section/page', prompt.includes('cite le document, la section et la page imprimée exacte'), true);

// 8. Termes de la question : mots vides écartés, mots utiles gardés.
check('termes : vitesse de décrochage du 172N',
  extractQuestionTerms('Quelle est la vitesse de décrochage du 172N ?'),
  ['vitesse', 'decrochage', '172n']);
check('termes : pression d’huile', extractQuestionTerms('Quelle est la pression d’huile ?'), ['pression', 'huile']);
check('termes : question vide', extractQuestionTerms('   '), []);
check('termes : que des mots vides', extractQuestionTerms('Quelle est la ?'), []);
check('expressions : pression d’huile (apostrophe normalisée en droite)',
  extractQuestionPhrases('Quelle est la pression d’huile ?').includes("pression d'huile"), true);
check('expressions : vitesse de décrochage (sans accents, normalisé)',
  extractQuestionPhrases('Quelle est la vitesse de décrochage du 172N ?').includes('vitesse de decrochage'), true);

// 9. Récupération du contexte sur les index SYNTHÉTIQUES (moteur existant réutilisé).
const ctx = retrieveContext(docs, meta, synonyms, 'Quelle est la vitesse de décrochage du 172N ?');
check('contexte décrochage : pages trouvées', ctx.pages.length > 0, true);
check('contexte décrochage : au plus 6 pages', ctx.pages.length <= 6, true);
check('contexte décrochage : une page syn-en', ctx.pages.some((p) => p.docId === 'syn-en'), true);
check('contexte décrochage : chaque page a doc/section/page + extrait',
  ctx.pages.every((p) => p.docTitle && p.sectionLabel && p.pageLabel && p.excerpt && p.excerpt.length > 20), true);
check('contexte décrochage : l’extrait contient un terme cherché',
  ctx.pages.every((p) => p.matchedTerms.some((t) => buildTermRegex(t).test(p.excerpt))), true);
const ctxHuile = retrieveContext(docs, meta, synonyms, 'Quelle est la pression d’huile ?');
check('contexte pression d’huile : trouve oil pressure (synonyme)',
  ctxHuile.pages.some((p) => p.matchedTerms.includes('oil pressure')), true);
const ctxRien = retrieveContext(docs, meta, synonyms, 'zzzqqq');
check('contexte terme absent : 0 page', ctxRien.pages.length, 0);
const ctxVide = retrieveContext(docs, meta, synonyms, 'Quelle est la ?');
check('contexte question sans terme : 0 page', ctxVide.pages.length, 0);

// 10. Réglages stockés (main-ai.js) avec Electron simulé : clés par
// fournisseur, clé masquée sans déchiffrement, migration v1 -> v2.
// Le faux Electron (test/electron-stub.mjs) compte les appels à
// safeStorage.decryptString : l'affichage (ai:get-settings) ne doit
// JAMAIS en faire — l'invite du trousseau macOS ne doit apparaître qu'à
// l'usage réel de la clé (ai:ask, ai:test).
import { register } from 'node:module';
register('./electron-stub.mjs', import.meta.url);
const { registerAiHandlers } = await import('../main-ai.js');
const electronStub = await import('./electron-stub.mjs');
registerAiHandlers();
const ipcHandlers = electronStub.handlers;
const settingsFile = path.join(electronStub.userDataDir, 'ai-settings.json');
const callIpc = (channel, ...args) => ipcHandlers.get(channel)(null, ...args);
const readStoredFile = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const decryptStored = (value) => electronStub.safeStorage.decryptString(Buffer.from(value, 'base64'));
const FAUSSE_CLE_GEMINI = 'sk-fausse-cle-gemini-AAAA1111';
const FAUSSE_CLE_CLAUDE = 'sk-fausse-cle-claude-BBBB2222';
const CONTEXTE_TEST = [{ docTitle: 'POH Cessna 172N', sectionLabel: 'Section 5 — Performances', pageLabel: 'p. 5-12', excerpt: 'La vitesse de décrochage est de 48 kt.' }];
const realFetchForSection10 = globalThis.fetch;

// 10a. Migration v1 : fichier plat, clé chiffrée, jamais déchiffrée à l'affichage.
fs.writeFileSync(settingsFile, JSON.stringify({
  provider: 'gemini', model: 'gemini-3.8-flash',
  endpoint: PROVIDERS.gemini.defaultEndpoint,
  keyMethod: 'safeStorage',
  keyValue: electronStub.safeStorage.encryptString(FAUSSE_CLE_GEMINI).toString('base64'),
}, null, 2), 'utf8');
let decrypts = electronStub.safeStorageCalls.decrypt;
let res = await callIpc('ai:get-settings');
check('migration v1 : lecture OK sans déchiffrement', res.ok === true && electronStub.safeStorageCalls.decrypt === decrypts, true);
check('migration v1 : fournisseur + modèle lus', [res.settings.provider, res.settings.model], ['gemini', 'gemini-3.8-flash']);
check('migration v1 : clé présente, masquée générique (derniers caractères inconnus sans déchiffrer)', [res.settings.hasKey, res.settings.maskedKey], [true, '••••']);
check('migration v1 : clé du fournisseur migrée dans la liste', res.settings.providers.find((p) => p.id === 'gemini').hasKey, true);
res = await callIpc('ai:save-settings', { provider: 'gemini', model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: '' });
check('migration v1 : sauvegarde OK', res.ok, true);
const apresMigration = readStoredFile();
check('migration v1 : fichier réécrit en v2 (plus de clé plate)', 'keyValue' in apresMigration, false);
check('migration v1 : clé conservée sous le fournisseur', decryptStored(apresMigration.providers.gemini.keyValue), FAUSSE_CLE_GEMINI);
check('migration v1 : modèle/endpoint conservés', [apresMigration.providers.gemini.model, apresMigration.providers.gemini.endpoint], ['gemini-3.8-flash', PROVIDERS.gemini.defaultEndpoint]);
decrypts = electronStub.safeStorageCalls.decrypt;
res = await callIpc('ai:get-settings');
check('affichage : get-settings ne déchiffre jamais', electronStub.safeStorageCalls.decrypt, decrypts);
check('affichage : clé masquée sans déchiffrement', res.settings.maskedKey, '••••');

// 10b. Usage réel : ai:test déchiffre (attendu) et la clé masquée est recalculée.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) });
decrypts = electronStub.safeStorageCalls.decrypt;
res = await callIpc('ai:test');
check('usage réel : ai:test réussit', res.ok, true);
check('usage réel : ai:test a déchiffré exactement une fois', electronStub.safeStorageCalls.decrypt - decrypts, 1);
globalThis.fetch = realFetchForSection10;
res = await callIpc('ai:get-settings');
check('usage réel : clé masquée recalculée après usage (4 derniers caractères)', res.settings.maskedKey, '••••1111');

// 10c. Clés par fournisseur : sauver A pour gemini, B pour claude, revenir sur gemini.
await callIpc('ai:save-settings', { provider: 'gemini', model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: FAUSSE_CLE_GEMINI });
await callIpc('ai:save-settings', { provider: 'claude', model: 'claude-sonnet-4-5', endpoint: PROVIDERS.claude.defaultEndpoint, key: FAUSSE_CLE_CLAUDE });
res = await callIpc('ai:save-settings', { provider: 'gemini', model: 'gemini-3.8-flash', endpoint: PROVIDERS.gemini.defaultEndpoint, key: '' });
check('clés par fournisseur : retour sur gemini, clé A restaurée', [res.settings.provider, res.settings.maskedKey], ['gemini', '••••1111']);
const stocke = readStoredFile();
check('clés par fournisseur : clé gemini intacte dans le fichier', decryptStored(stocke.providers.gemini.keyValue), FAUSSE_CLE_GEMINI);
check('clés par fournisseur : clé claude intacte dans le fichier', decryptStored(stocke.providers.claude.keyValue), FAUSSE_CLE_CLAUDE);
check('clés par fournisseur : aucune clé en clair dans le fichier',
  fs.readFileSync(settingsFile, 'utf8').includes(FAUSSE_CLE_GEMINI) || fs.readFileSync(settingsFile, 'utf8').includes(FAUSSE_CLE_CLAUDE), false);
check('clés par fournisseur : clé masquée stockée à la sauvegarde', stocke.providers.claude.maskedKey, '••••2222');

// 10d. ai:ask envoie la clé DU fournisseur courant, jamais celle d'un autre.
let seenHeaders = null;
globalThis.fetch = async (_url, options) => {
  seenHeaders = options.headers;
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) };
};
res = await callIpc('ai:ask', { question: 'Test ?', context: CONTEXTE_TEST });
check('ask gemini : la clé gemini est envoyée (pas celle de claude)', seenHeaders['x-goog-api-key'], FAUSSE_CLE_GEMINI);
await callIpc('ai:save-settings', { provider: 'claude', model: 'claude-sonnet-4-5', endpoint: PROVIDERS.claude.defaultEndpoint, key: '' });
globalThis.fetch = async (_url, options) => {
  seenHeaders = options.headers;
  return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: 'OK' }] }) };
};
res = await callIpc('ai:ask', { question: 'Test ?', context: CONTEXTE_TEST });
check('ask claude : la clé claude est envoyée (pas celle de gemini)', seenHeaders['x-api-key'], FAUSSE_CLE_CLAUDE);
globalThis.fetch = realFetchForSection10;

// 10e. ai:clear-key n'efface que la clé du fournisseur courant.
res = await callIpc('ai:clear-key');
check('clear-key : efface la clé du fournisseur courant', [res.ok, res.settings.hasKey], [true, false]);
const apresClear = readStoredFile();
check('clear-key : clé claude effacée', Boolean(apresClear.providers.claude.keyValue), false);
check('clear-key : clé gemini toujours là', decryptStored(apresClear.providers.gemini.keyValue), FAUSSE_CLE_GEMINI);

// 10f. Gardes : refus et défauts (comportement inchangé).
res = await callIpc('ai:save-settings', { provider: 'gemini', model: '', endpoint: '', key: 'court' });
check('sauvegarde : clé trop courte refusée', res.ok, false);
res = await callIpc('ai:save-settings', { provider: 'inconnu', model: '', endpoint: '', key: '' });
check('sauvegarde : fournisseur inconnu refusé', res.ok, false);
await callIpc('ai:save-settings', { provider: 'gemini', model: '', endpoint: '', key: '' });
res = await callIpc('ai:get-settings');
check('modèle/endpoint vides : défauts du fournisseur affichés', [res.settings.model, res.settings.endpoint], ['gemini-3.8-flash', PROVIDERS.gemini.defaultEndpoint]);

// 11. Régression — bug « Tester la connexion » muet (v1.2.0, 14 nov.) :
// le clic sur Tester ne donnait ni succès ni erreur quand l'appel IPC
// rejetait ou quand le processus principal ne répondait pas (invite du
// trousseau macOS qui bloque le déchiffrement) — le statut restait figé
// sur « Test en cours… ». Les bornes : appel réseau du test limité à
// 20 s côté principal (opts.timeoutMs, sous la limite IPC de 30 s),
// délai de 45 s côté rendu (filet de sécurité).

// 11a. Un fetch qui ne répond jamais est interrompu par timeoutMs.
const hangingFetch = fakeFetch((_url, options) => new Promise((_resolve, reject) => {
  const signal = options && options.signal;
  const onAbort = () => { const e = new Error('abandon'); e.name = 'AbortError'; reject(e); };
  if (!signal) return; // sans signal : ne répond jamais
  if (signal.aborted) { onAbort(); return; }
  signal.addEventListener('abort', onAbort);
}));
const t0Hang = Date.now();
await checkThrows('régression test muet : fetch qui ne répond jamais -> délai dépassé (timeoutMs)',
  () => callProvider({ provider: 'openai', model: 'gpt-4o-mini', endpoint: PROVIDERS.openai.defaultEndpoint, key: 'CLE-FAUSSE' }, promptTest, hangingFetch, { timeoutMs: 50 }),
  'La réponse a mis trop de temps à arriver. Réessayez.');
check('régression test muet : délai dépassé en moins de 5 s', Date.now() - t0Hang < 5000, true);

// 11b. Erreur réseau : le message « IA locale » ne sort que pour une IA
// locale — un Gemini (même via un faux serveur sur localhost) dit
// « le fournisseur », sinon l'utilisateur cherche une IA locale qu'il
// n'a pas.
check('régression test muet : gemini sur localhost -> pas « IA locale »',
  mapNetworkError(refused, 'http://127.0.0.1:9/v1beta/models/x:generateContent', 'gemini').userMessage.includes('IA locale'), false);
check('régression test muet : gemini sur localhost -> message fournisseur',
  mapNetworkError(refused, 'http://127.0.0.1:9/v1beta/models/x:generateContent', 'gemini').userMessage.includes('joindre le fournisseur'), true);
check('régression test muet : local sans fournisseur -> message IA locale (compatibilité)',
  mapNetworkError(refused, 'http://localhost:11434/v1/chat/completions').userMessage.includes('IA locale'), true);
check('régression test muet : fournisseur local -> message IA locale',
  mapNetworkError(refused, 'http://localhost:11434/v1/chat/completions', 'local').userMessage.includes('IA locale'), true);

// 11c. ai:test renvoie TOUJOURS {ok:true} ou {ok:false, error} avec un
// message lisible — jamais undefined, jamais d'exception (le bouton
// Tester ne doit jamais rester muet).
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }) });
res = await callIpc('ai:test');
check('régression test muet : ai:test renvoie {ok:true} (succès)', res.ok, true);
check('régression test muet : ai:test renvoie une réponse, pas undefined', typeof res.answer, 'string');
globalThis.fetch = realFetchForSection10;
await callIpc('ai:clear-key');
res = await callIpc('ai:test');
check('régression test muet : ai:test sans clé -> {ok:false} avec message lisible', [res.ok, typeof res.error === 'string' && res.error.includes('clé')], [false, true]);

// Nettoyage du dossier temporaire du faux Electron.
fs.rmSync(electronStub.userDataDir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTOUS LES TESTS PASSENT' : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
