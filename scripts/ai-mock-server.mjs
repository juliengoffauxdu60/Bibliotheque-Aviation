// Petit serveur local factice, compatible OpenAI, pour tester l'IA de
// l'application sans vraie clé ni réseau.
//  - POST /v1/chat/completions  (OpenAI / Ollama / LM Studio / personnalisé)
//  - POST /v1/messages          (Claude)
//  - POST /v1beta/models/...:generateContent (Gemini)
// Il enregistre la dernière requête (sans jamais journaliser la clé : seuls
// des booléens « en-tête présent / clé attendue reçue » sont retenus) et
// renvoie une réponse fixe qui indique combien d'extraits des POH le prompt
// contenait — ce qui prouve que les extraits ont bien été envoyés comme
// contexte.
// Usage seul : node scripts/ai-mock-server.mjs [port]
// Usage en test : import { startMockServer } from './ai-mock-server.mjs';
//   const srv = await startMockServer(0, { expectedKey: 'sk-fausse-cle-1234' });
import http from 'node:http';

function countExcerpts(promptText) {
  // Les extraits sont introduits par une ligne « [POH … — … — p. …] ».
  return (String(promptText || '').match(/^\[/gm) || []).length;
}

function promptFromBody(body) {
  if (typeof body?.messages?.[0]?.content === 'string') return body.messages[0].content;
  if (typeof body?.contents?.[0]?.parts?.[0]?.text === 'string') return body.contents[0].parts[0].text;
  return '';
}

export function startMockServer(port = 0, opts = {}) {
  const expectedKey = opts.expectedKey || '';
  let mode = 'ok'; // 'ok' | 'unauthorized'
  let last = null;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      if (req.url === '/__last') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(last || {}));
        return;
      }
      if (req.url === '/__health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode }));
        return;
      }
      const promptText = promptFromBody(body);
      const n = countExcerpts(promptText);
      const auth = req.headers.authorization || '';
      const googKey = req.headers['x-goog-api-key'] || '';
      const claudeKey = req.headers['x-api-key'] || '';
      last = {
        method: req.method,
        path: req.url,
        model: body.model || '',
        excerptCount: n,
        promptLength: promptText.length,
        hadAuthorization: Boolean(auth),
        hadGoogKey: Boolean(googKey),
        hadClaudeKey: Boolean(claudeKey),
        keyMatchesExpected: expectedKey !== '' && (
          auth === 'Bearer ' + expectedKey || googKey === expectedKey || claudeKey === expectedKey
        ),
      };
      if (mode === 'unauthorized') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Incorrect API key provided.' } }));
        return;
      }
      const answer = `Réponse du faux serveur. Extraits reçus : ${n}.`;
      let payload;
      if (req.url.includes(':generateContent')) {
        payload = { candidates: [{ content: { parts: [{ text: answer }] } }] };
      } else if (req.url === '/v1/messages') {
        payload = { content: [{ type: 'text', text: answer }] };
      } else {
        payload = { choices: [{ message: { role: 'assistant', content: answer } }] };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        port: address.port,
        baseUrl: `http://127.0.0.1:${address.port}`,
        setMode: (m) => { mode = m; },
        lastRequest: () => last,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Lancement seul (pour un test manuel) : affiche l'adresse et attend.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const port = parseInt(process.argv[2] || '0', 10);
  startMockServer(port, { expectedKey: process.env.MOCK_EXPECTED_KEY || '' }).then((srv) => {
    console.log(`Serveur IA factice : ${srv.baseUrl} (GET /__health, GET /__last)`);
  });
}
