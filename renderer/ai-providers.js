// Fournisseurs IA — définitions, construction des requêtes, lecture des
// réponses, construction du prompt.
// Module PUR (aucune dépendance Electron) : il est utilisé par main-ai.js
// (processus principal, qui détient la clé) et par renderer/ai.js
// (construction du prompt). Il est testé en Node seul (test/ai.test.mjs).
//
// La clé API n'apparaît JAMAIS dans les journaux : ce module ne fait aucun
// console.log, et main-ai.js ne journalise que le fournisseur et le modèle.

// Modèles par défaut (vérifiés le 14 nov. 2026 — champs modifiables dans la
// page Réglages IA, car les noms de modèles changent chez les fournisseurs) :
//  - Gemini : « gemini-3.8-flash » — Google ne sert plus gemini-2.5-flash aux
//    nouveaux projets (avis de sept. 2026) ; son guide de démarrage utilise
//    gemini-3.8-flash.
//  - Claude : « claude-sonnet-4-5 » (identifiant de l'API Messages Anthropic).
//  - OpenAI : « gpt-4o-mini ».
//  - IA locale : « llama3.1 » (exemple Ollama — mettre le nom du modèle
//    réellement installé).
export const PROVIDERS = {
  gemini: {
    id: 'gemini',
    label: 'Gemini (Google)',
    needsKey: true,
    defaultModel: 'gemini-3.8-flash',
    defaultEndpoint: 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
    keyHelp: 'Clé API Google AI Studio (aistudio.google.com/apikey).',
  },
  claude: {
    id: 'claude',
    label: 'Claude (Anthropic)',
    needsKey: true,
    defaultModel: 'claude-sonnet-4-5',
    defaultEndpoint: 'https://api.anthropic.com/v1/messages',
    keyHelp: 'Clé API Anthropic (console.anthropic.com).',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    needsKey: true,
    defaultModel: 'gpt-4o-mini',
    defaultEndpoint: 'https://api.openai.com/v1/chat/completions',
    keyHelp: 'Clé API OpenAI (platform.openai.com).',
  },
  local: {
    id: 'local',
    label: 'IA locale (Ollama / LM Studio)',
    needsKey: false,
    defaultModel: 'llama3.1',
    defaultEndpoint: 'http://localhost:11434/v1/chat/completions',
    keyHelp: 'En général, aucune clé pour une IA locale. LM Studio écoute sur http://localhost:1234/v1/chat/completions — mettez cette adresse si vous utilisez LM Studio.',
  },
  custom: {
    id: 'custom',
    label: 'Point de terminaison personnalisé (compatible OpenAI)',
    needsKey: false,
    defaultModel: '',
    defaultEndpoint: '',
    keyHelp: 'Adresse complète du point de terminaison compatible OpenAI, et clé si le service en demande une.',
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

// Masquage de la clé : « •••• » + 4 derniers caractères. La clé n'est
// JAMAIS affichée en clair, ni journalisée.
export function maskKey(key) {
  if (!key) return '';
  const s = String(key);
  if (s.length <= 4) return '••••';
  return '••••' + s.slice(-4);
}

// Erreur destinée à l'utilisateur : message en français clair, sans jargon,
// sans détail technique (ni clé, ni URL complète, ni trace).
export function aiError(userMessage) {
  const e = new Error(userMessage);
  e.userMessage = userMessage;
  return e;
}

function isLocalhostUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

// Construit la requête HTTP pour le fournisseur. Retourne { url, options }.
// `settings` : { model, endpoint, key } (déjà validés par callProvider).
export function buildRequest(providerId, settings, prompt) {
  const def = PROVIDERS[providerId];
  if (!def) throw aiError('Fournisseur IA inconnu.');
  const model = (settings.model || '').trim();
  const endpoint = (settings.endpoint || '').trim();
  const key = settings.key || '';
  const json = (body, extraHeaders = {}) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  });

  if (providerId === 'gemini') {
    const url = endpoint.replace('{model}', encodeURIComponent(model));
    return {
      url,
      options: json(
        { contents: [{ parts: [{ text: prompt }] }] },
        { 'x-goog-api-key': key },
      ),
    };
  }
  if (providerId === 'claude') {
    return {
      url: endpoint,
      options: json(
        { model, max_tokens: 1024, messages: [{ role: 'user', content: prompt }] },
        { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      ),
    };
  }
  // openai, local, custom : forme compatible OpenAI.
  const headers = {};
  if (key) headers.Authorization = 'Bearer ' + key;
  return {
    url: endpoint,
    options: json(
      { model, temperature: 0.2, messages: [{ role: 'user', content: prompt }] },
      headers,
    ),
  };
}

// Extrait le texte de la réponse du fournisseur. Lève une erreur lisible
// si la forme de la réponse est inattendue.
export function extractAnswer(providerId, data) {
  let text = '';
  try {
    if (providerId === 'gemini') {
      const parts = data?.candidates?.[0]?.content?.parts || [];
      text = parts.map((p) => p.text || '').join('');
    } else if (providerId === 'claude') {
      const blocks = data?.content || [];
      text = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('');
    } else {
      text = data?.choices?.[0]?.message?.content || '';
    }
  } catch {
    text = '';
  }
  text = String(text || '').trim();
  if (!text) {
    throw aiError('Le fournisseur a renvoyé une réponse vide ou illisible. Réessayez.');
  }
  return text;
}

// Message d'erreur renvoyé par le fournisseur lui-même (corps JSON
// { error: { message } }) : c'est lui qui dit POURQUOI ça a échoué
// (« The model is overloaded », « API key not valid »…) — sans lui, on
// ne voit que le code HTTP et l'utilisateur ne sait pas quoi faire.
function providerErrorMessage(data) {
  const m = data && data.error && typeof data.error.message === 'string' ? data.error.message : '';
  return m.trim();
}

// Traduit une erreur HTTP en message clair. `detail` est le message du
// fournisseur (s'il en a donné un) : il précise la cause réelle —
// surcharge du modèle, clé invalide, API non activée, quota dépassé —
// au lieu d'un simple code.
export function mapHttpError(status, endpoint, detail = '') {
  const d = String(detail || '');
  if (/overloaded/i.test(d)) {
    return aiError('Le modèle est surchargé en ce moment : le fournisseur demande de réessayer dans un moment. Si ça persiste, essayez un autre modèle (par exemple « gemini-3.6-flash ») dans « Réglages IA ».');
  }
  if (/API key not valid/i.test(d)) {
    return aiError('La clé API a été refusée par le fournisseur. Vérifiez la clé dans « Réglages IA ».');
  }
  if (/is not found|not found for API version/i.test(d)) {
    return aiError('Le fournisseur ne connaît pas ce modèle ou cette adresse. Vérifiez le nom du modèle et l’adresse du point de terminaison dans « Réglages IA ».');
  }
  if (/has not been used|is disabled|not enabled/i.test(d)) {
    return aiError('L’API du fournisseur n’est pas activée pour ce projet. Dans Google AI Studio, vérifiez que l’API Generative Language est activée pour la clé.');
  }
  if (/quota|exceeded/i.test(d)) {
    return aiError('Quota dépassé chez le fournisseur. Réessayez plus tard ou vérifiez votre forfait.');
  }
  if (status === 401 || status === 403) {
    return aiError('La clé API a été refusée par le fournisseur. Vérifiez la clé dans « Réglages IA ».');
  }
  if (status === 404) {
    return aiError('Le fournisseur ne connaît pas ce modèle ou cette adresse. Vérifiez le nom du modèle et l’adresse du point de terminaison dans « Réglages IA ».');
  }
  if (status === 429) {
    return aiError('Trop de demandes d’un coup : le fournisseur demande d’attendre un peu avant de réessayer.');
  }
  if (status === 400) {
    return aiError('Le fournisseur a refusé la demande. Vérifiez le nom du modèle dans « Réglages IA ».');
  }
  if (status >= 500) {
    return aiError(d
      ? `Le fournisseur a renvoyé une erreur (code ${status}) : ${d.slice(0, 160)}`
      : `Le fournisseur a renvoyé une erreur (code ${status}). Réessayez dans un moment.`);
  }
  return aiError(`Le fournisseur a renvoyé une erreur (code ${status}).`);
}

// Traduit une erreur réseau (fetch rejeté) en message clair.
// `providerId` (facultatif) : quand il est connu et différent de 'local',
// le message reste générique (« le fournisseur ») même si l'adresse
// pointe vers localhost (cas d'un faux serveur ou d'un mandataire) —
// dire « IA locale » pour un Gemini en échec serait faux. Sans
// providerId, on garde l'ancien comportement (adresse localhost = IA
// locale) pour ne pas casser les appelants existants.
export function mapNetworkError(err, endpoint, providerId) {
  if (err && err.name === 'AbortError') {
    return aiError('La réponse a mis trop de temps à arriver. Réessayez.');
  }
  const code = (err && err.cause && err.cause.code) || err?.code || '';
  const msg = String((err && err.message) || '');
  const networkish = code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN'
    || /fetch failed|network|ECONNREFUSED|ENOTFOUND|not reachable/i.test(msg);
  if (networkish) {
    if ((providerId === undefined && isLocalhostUrl(endpoint)) || providerId === 'local') {
      return aiError('Impossible de joindre l’IA locale. Vérifiez que le logiciel d’IA locale (Ollama ou LM Studio) est bien lancé, et l’adresse dans « Réglages IA ».');
    }
    return aiError('Impossible de joindre le fournisseur. Vérifiez votre connexion Internet et réessayez.');
  }
  return aiError('La demande n’a pas pu partir. Vérifiez votre connexion Internet et réessayez.');
}

// Appel complet : validation, requête, lecture de la réponse.
// `fetchImpl` est injectable pour les tests (fetch natif par défaut).
// `opts.retryDelaysMs` : délais entre les nouvelles tentatives sur 429/503
// (par défaut 2 s puis 5 s — Google conseille de réessayer quand le
// modèle est surchargé ; sans nouvelle tentative, un 503 passager
// ressemble à une panne). `opts.sleepImpl` est injectable pour les tests.
// `opts.timeoutMs` : durée maximale de l'appel (par défaut 120 s). Le
// test de connexion utilise une durée courte (20 s) : un test ne doit
// jamais laisser « Test en cours… » figé des minutes — et il doit rester
// SOUS la limite de 30 s d'Electron pour un appel IPC (au-delà, l'appel
// est rejeté avec « reply was never sent » — prouvé par reproduction).
// Lève une Error avec .userMessage en français clair en cas d'échec.
export async function callProvider(settings, prompt, fetchImpl = globalThis.fetch, opts = {}) {
  const providerId = settings.provider;
  const def = PROVIDERS[providerId];
  if (!def) {
    throw aiError('Aucune IA n’est configurée. Ouvrez « Réglages IA » pour choisir un fournisseur et enregistrer une clé.');
  }
  const model = (settings.model || '').trim();
  const endpoint = (settings.endpoint || def.defaultEndpoint || '').trim();
  if (!model) {
    throw aiError('Aucun modèle n’est indiqué. Complétez le nom du modèle dans « Réglages IA ».');
  }
  if (!endpoint) {
    throw aiError('Aucune adresse de point de terminaison n’est indiquée. Complétez-la dans « Réglages IA ».');
  }
  if (def.needsKey && !(settings.key || '').trim()) {
    throw aiError('Il manque la clé API. Enregistrez-la dans « Réglages IA ».');
  }
  const { url, options } = buildRequest(providerId, { model, endpoint, key: settings.key || '' }, prompt);
  const retryDelays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : [2000, 5000];
  const sleepFn = typeof opts.sleepImpl === 'function' ? opts.sleepImpl : ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 120000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(url, { ...options, signal: ctrl.signal });
      } catch (e) {
        throw mapNetworkError(e, endpoint, providerId);
      }
      if (res.ok) {
        let data;
        try {
          data = await res.json();
        } catch {
          throw aiError('La réponse du fournisseur n’a pas pu être lue. Réessayez.');
        }
        return extractAnswer(providerId, data);
      }
      // Erreur HTTP : on lit le message du fournisseur avant de décider.
      let detail = '';
      try { detail = providerErrorMessage(await res.json()); } catch { /* corps illisible */ }
      if ((res.status === 429 || res.status === 503) && attempt < retryDelays.length) {
        await sleepFn(retryDelays[attempt]);
        continue;
      }
      throw mapHttpError(res.status, endpoint, detail);
    }
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Prompt : extraits locaux + consignes. Construit côté rendu (ai.js) à
// partir des pages retrouvées par le moteur de recherche local, puis envoyé
// tel quel au fournisseur par le processus principal.
// Générique (v1.2.0 : l'appli est livrée SANS document fourni — chacun
// importe les siens) : le prompt ne nomme AUCUN document en particulier.
// `opts.ocrWarning` : n'ajouter l'avertissement sur les chiffres lus
// automatiquement que si le contexte vient réellement d'un document lu
// automatiquement ; sinon, on ne le mentionne pas.
// ---------------------------------------------------------------------------
export function buildPrompt(question, pages, opts = {}) {
  const lines = [
    'Tu réponds à une question sur des manuels de vol, à partir des documents chargés dans l’application. Tu ne dois utiliser QUE les extraits ci-dessous, tirés de ces documents.',
    '',
    'Règles :',
    '- Réponds en français, de façon courte et directe.',
    '- Pour chaque affirmation, cite le document, la section et la page imprimée exacte (exemple : Manuel de vol, section 5 — Performances, p. 5-12).',
    '- N’invente jamais une valeur : si l’information n’est pas dans les extraits, dis-le clairement au lieu de deviner.',
  ];
  if (opts.ocrWarning) {
    lines.push('- Certains chiffres des tableaux peuvent venir d’une lecture automatique : ils peuvent contenir des erreurs. Préviens l’utilisateur de vérifier chaque valeur dans le document affiché.');
  }
  lines.push(
    '- Si les extraits ne permettent pas de répondre, dis-le.',
    '',
    `Question : ${question}`,
    '',
    'Extraits :',
  );
  if (!pages || pages.length === 0) {
    lines.push('(aucun extrait trouvé dans les documents pour cette question)');
  } else {
    for (const p of pages) {
      lines.push(`[${p.docTitle} — ${p.sectionLabel} — ${p.pageLabel}]`);
      lines.push(p.excerpt || '');
      lines.push('');
    }
  }
  return lines.join('\n');
}
