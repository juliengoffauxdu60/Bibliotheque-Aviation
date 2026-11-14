// Processus principal — Bibliothèque Aviation (Electron).
// 100 % local, hors réseau : aucun appel réseau, les PDF / index / pdf.js sont
// servis depuis le dossier de l'application via le protocole personnalisé « app:// ».
import { app, BrowserWindow, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { registerImportHandlers } from './main-import.js';
import { registerAiHandlers } from './main-ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Le schéma « app:// » doit être déclaré standard + sécurisé AVANT que
// l'application soit prête, sinon les imports de modules ES et les fetch()
// depuis la page sont bloqués par Chromium.
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true, secure: true, supportFetchAPI: true, corsEnabled: true,
  },
}]);
const SELFTEST = process.env.POH_SELFTEST === '1';
const SELFTEST_OUT = process.env.POH_SELFTEST_OUT || '';
const SELFTEST_SHOTS = process.env.POH_SELFTEST_SHOTS || '';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.pdf': 'application/pdf',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

function createWindow() {
  const win = new BrowserWindow({
    width: parseInt(process.env.POH_WIDTH || '1440', 10),
    height: parseInt(process.env.POH_HEIGHT || '900', 10),
    title: 'Bibliothèque Aviation — Air Richelieu',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadURL('app://renderer/index.html');
  return win;
}

app.whenReady().then(() => {
  // Protocole app:// -> fichiers locaux du dossier de l'application.
  // (Pas de file:// direct : pdf.js charge les PDF par fetch, qui exige un
  // schéma servi ; app:// ne sort jamais du dossier de l'application.)
  protocol.handle('app', (request) => {
    const url = new URL(request.url);
    // Pour app://renderer/index.html : host = « renderer », pathname = « /index.html ».
    // Le chemin dans l'application est donc host + pathname.
    let rel = decodeURIComponent(url.host + url.pathname);
    if (rel.startsWith('/')) rel = rel.slice(1);
    if (!rel) rel = 'renderer/index.html';
    // Documents importés : servis depuis userData/pohs (hors dossier de l'appli).
    if (rel.startsWith('user-pohs/')) {
      const pohsBase = path.join(app.getPath('userData'), 'pohs');
      const userPath = path.normalize(path.join(pohsBase, rel.slice('user-pohs/'.length)));
      if (!userPath.startsWith(pohsBase)) return new Response('Interdit', { status: 403 });
      if (!fs.existsSync(userPath) || !fs.statSync(userPath).isFile()) {
        return new Response('Introuvable : ' + rel, { status: 404 });
      }
      const userBody = fs.readFileSync(userPath);
      return new Response(userBody, {
        status: 200,
        headers: {
          'Content-Type': MIME[path.extname(userPath).toLowerCase()] || 'application/octet-stream',
          'Content-Length': String(userBody.length),
          'Access-Control-Allow-Origin': '*',
        },
      });
    }
    const filePath = path.normalize(path.join(__dirname, rel));
    if (!filePath.startsWith(__dirname)) return new Response('Interdit', { status: 403 });
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      return new Response('Introuvable : ' + rel, { status: 404 });
    }
    // Lecture directe depuis le disque (pas de net.fetch : sa réponse relayée
    // n'était pas acceptée par Chromium pour les imports de modules ES).
    const body = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': String(body.length),
        // Les modules ES sont chargés en mode CORS : sans cet en-tête,
        // Chromium refuse l'import même en même origine sur un schéma maison.
        'Access-Control-Allow-Origin': '*',
      },
    });
  });

  const win = createWindow();

  // Import de POH : dialogue fichier, copie, extraction, OCR, registre.
  registerImportHandlers();
  // Réglages IA : stockage sécurisé de la clé + appels au fournisseur.
  registerAiHandlers();

  if (SELFTEST) {
    win.webContents.on('console-message', (e, level, message, line, sourceId) => {
      console.log(`[rendu:${level}] ${message} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (e, code, desc, url) => {
      console.log(`[échec chargement] ${code} ${desc} ${url}`);
    });
    win.webContents.on('did-finish-load', async () => {
      // Laisse le temps au rendu de charger les données.
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.POH_DEBUG) {
        const probe = await win.webContents.executeJavaScript(`(async () => {
          const out = ['origin=' + location.origin + ' base=' + document.baseURI + ' __poh=' + typeof window.__poh];
          for (const u of ['app://renderer/app.js','app://renderer/search.js','app://renderer/tools.js','app://assets/pdfjs/pdf.mjs','app://data/docs.json','app://renderer/styles.css']) {
            try { const r = await fetch(u); out.push(u + ' -> ' + r.status + ' ' + (r.headers.get('content-type')||'')); }
            catch(e){ out.push(u + ' -> ERREUR ' + e.message); }
          }
          try { await import('app://renderer/search.js'); out.push('import search.js OK'); }
          catch(e){ out.push('import search.js ERREUR: ' + (e && e.message)); }
          try { await import('app://renderer/tools.js'); out.push('import tools.js OK'); }
          catch(e){ out.push('import tools.js ERREUR: ' + (e && e.message)); }
          try { await import('app://assets/pdfjs/pdf.mjs'); out.push('import pdf.mjs OK'); }
          catch(e){ out.push('import pdf.mjs ERREUR: ' + (e && e.message)); }
          try { await import('app://renderer/app.js'); out.push('import app.js OK, __poh=' + typeof window.__poh); }
          catch(e){ out.push('import app.js ERREUR: ' + (e && e.message)); }
          return out.join('\\n');
        })()`);
        console.log('[sonde]\n' + probe);
      }
      const results = await runSelfTest(win);
      if (SELFTEST_OUT) fs.writeFileSync(SELFTEST_OUT, JSON.stringify(results, null, 2), 'utf8');
      console.log('SELFTEST terminé : ' + results.filter((r) => r.ok).length + '/' + results.length + ' vérifications OK');
      for (const r of results) console.log(`  ${r.ok ? 'OK  ' : 'ÉCHEC'} ${r.name} — ${r.detail}`);
      app.quit();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// Auto-test dans l'application réelle (POH_SELFTEST=1).
// Chaque étape exécute du JS dans le rendu, puis capture une image.
// Les vérifications portent sur l'état réel de l'appli (DOM, canvas, PDF.js),
// jamais sur une relecture du code.
// ---------------------------------------------------------------------------
async function runSelfTest(win) {
  const wc = win.webContents;
  const out = [];
  const shot = async (name) => {
    if (!SELFTEST_SHOTS) return;
    try {
      const img = await wc.capturePage();
      fs.writeFileSync(path.join(SELFTEST_SHOTS, name + '.png'), img.toPNG());
    } catch (e) { /* capture non bloquante */ }
  };
  const step = async (name, js, check) => {
    try {
      const value = await wc.executeJavaScript(js);
      await new Promise((r) => setTimeout(r, 400));
      const ok = check ? check(value) : value === true;
      out.push({ name, ok: !!ok, detail: typeof value === 'string' ? value : JSON.stringify(value) });
    } catch (e) {
      out.push({ name, ok: false, detail: 'ERREUR : ' + e.message });
    }
  };

  await step('données chargées (4 docs, 1028 pages)',
    `window.__poh.ready().then(() => 'docs=' + window.__poh.state().docsLoaded + ' pages=' + window.__poh.state().totalPages)`,
    (v) => v === 'docs=4 pages=1028');

  await step('recherche « fuel » : 209 résultats',
    `window.__poh.search('fuel').then(r => 'n=' + r.total)`,
    (v) => v === 'n=209');
  await shot('01-recherche-fuel');

  await step('recherche « stall » : 11 pages en 172N',
    `window.__poh.search('stall').then(r => 'n172n=' + r.results.filter(x => x.docId === 'c172n').length)`,
    (v) => v === 'n172n=11');

  await step('recherche « stall speed » : 12 pages exactes',
    `window.__poh.search('stall speed').then(r => 'n=' + r.total)`,
    (v) => v === 'n=12');

  await step('recherche « pression d\u2019huile » : trouve oil pressure',
    `window.__poh.search("pression d'huile").then(r => 'n=' + r.total + ' en=' + r.results.some(x => x.termFound === 'oil pressure'))`,
    (v) => v.startsWith('n=') && v.includes('en=true'));

  await step('clic résultat 1 de « fuel » : PDF 172N affiché, 1 seul chargement du document',
    `window.__poh.search('fuel').then(() => window.__poh.openResult(0)).then(s => 'doc=' + s.doc + ' page=' + s.page + ' chargements172n=' + s.loads.c172n)`,
    (v) => v === 'doc=c172n page=3 chargements172n=1');

  await step('feuilletage 40 -> 41 (ancienne frontière de morceau)',
    `window.__poh.goToPage(40).then(() => window.__poh.goToPage(41)).then(s => 'page=' + s.page + ' erreur=' + s.error + ' chargements172n=' + s.loads.c172n)`,
    (v) => v === 'page=41 erreur=aucune chargements172n=1');
  await shot('02-page-41');

  await step('feuilletage 80 -> 81',
    `window.__poh.goToPage(80).then(() => window.__poh.goToPage(81)).then(s => 'page=' + s.page + ' erreur=' + s.error)`,
    (v) => v === 'page=81 erreur=aucune');

  await step('feuilletage 120 -> 121',
    `window.__poh.goToPage(120).then(() => window.__poh.goToPage(121)).then(s => 'page=' + s.page + ' erreur=' + s.error)`,
    (v) => v === 'page=121 erreur=aucune');

  await step('page 39 du 172N (scan décalé dans la source) : rendue telle quelle, sans erreur',
    `window.__poh.goToPage(39).then(s => 'page=' + s.page + ' erreur=' + s.error)`,
    (v) => v === 'page=39 erreur=aucune');

  await step('page 2 du 172N : blanche (réalité du PDF, pas un bug) — rendue sans erreur',
    `window.__poh.goToPage(2).then(s => 'page=' + s.page + ' erreur=' + s.error + ' pixels=' + window.__poh.nonBlankPixels())`,
    (v) => v.startsWith('page=2 erreur=aucune'));

  await step('saut de section 1 -> 8 (p. 146) sans rechargement',
    `window.__poh.goToSection('8').then(s => 'page=' + s.page + ' erreur=' + s.error + ' chargements172n=' + s.loads.c172n)`,
    (v) => v === 'page=146 erreur=aucune chargements172n=1');
  await shot('03-section-8');

  await step('centrage « Plus grand » : milieu de page au milieu de la vue',
    `window.__poh.goToPage(72).then(() => window.__poh.centeringInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.mode === 'large' && Math.abs(o.offsetPx) <= 3; } catch { return false; } });

  await step('zoom 150 % : canevas 1,5× plus large, page toujours centrée',
    `(() => { const b = JSON.parse(window.__poh.zoomInfo()); window.__zoomBase = b.canvasCssWidth; return window.__poh.setZoom(150).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); window.__zoomW = z.canvasCssWidth; return 'base=' + b.canvasCssWidth + ' zoom=' + z.canvasCssWidth + ' off=' + z.offsetPx + ' label=' + z.label; }); })()`,
    (v) => { const m = /base=(\d+) zoom=(\d+) off=(-?\d+) label=(.*)/.exec(v); if (!m) return false; const base = +m[1], zoom = +m[2]; return zoom / base >= 1.48 && zoom / base <= 1.52 && Math.abs(+m[3]) <= 3 && m[4] === '150 %'; });

  await step('zoom conservé après changement de page (72 -> 73)',
    `window.__poh.goToPage(73).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); return 'pct=' + z.zoomPct + ' w=' + z.canvasCssWidth + ' attendu=' + window.__zoomW; })`,
    (v) => { const m = /pct=(\d+) w=(\d+) attendu=(\d+)/.exec(v); return !!m && +m[1] === 150 && +m[2] === +m[3]; });

  await step('retour à 100 % : canevas à sa largeur de base, boutons −/+ réactivés',
    `window.__poh.setZoom(100).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); return 'pct=' + z.zoomPct + ' w=' + z.canvasCssWidth + ' base=' + window.__zoomBase + ' out=' + z.zoomOutDisabled + ' in=' + z.zoomInDisabled; })`,
    (v) => { const m = /pct=(\d+) w=(\d+) base=(\d+) out=(\w+) in=(\w+)/.exec(v); return !!m && +m[1] === 100 && +m[2] === +m[3] && m[4] === 'false' && m[5] === 'false'; });

  await step('mode « Page entière » : page visible sans défilement',
    `window.__poh.setMode('fit').then(() => window.__poh.centeringInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.mode === 'fit' && o.fitsWithoutScroll === true; } catch { return false; } });
  await shot('04-page-entiere');

  await step('bloc flottant : visible, en bas au centre, hors zone de défilement',
    `window.__poh.floatingNavInfo()`,
    (v) => { try { const o = JSON.parse(v); return o.visible && o.pinnedBottom && o.outsideScrollArea; } catch { return false; } });

  await step('navigation page par page 47 -> 48 (fin de section 3)',
    `window.__poh.setMode('large').then(() => window.__poh.goToPage(47)).then(() => window.__poh.nextPage()).then(s => 'page=' + s.page + ' erreur=' + s.error)`,
    (v) => v === 'page=48 erreur=aucune');

  await step('aucune sélection collée après un clic (focus relâché)',
    `(() => { document.querySelector('#nextPageBtn').click(); return new Promise(r => setTimeout(() => r(document.activeElement === document.body ? 'focus=body' : 'focus=' + (document.activeElement && document.activeElement.id)), 300)); })()`,
    (v) => v === 'focus=body');

  await step('résultat Suivant / Précédent + compteur « X sur N »',
    `window.__poh.search('fuel').then(() => window.__poh.nextResult()).then(() => window.__poh.nextResult()).then(s => s)`,
    (v) => v === 'Résultat 3 sur 209');

  await step('conversion : 10 gal US = 37,85 L',
    `window.__poh.convert('avgas', 10)`,
    (v) => v === '37,85 L');

  await step('conversion : 100 lb = 45,36 kg ; avgas 10 gal = 60 lb',
    `window.__poh.convert('lbkg', 100) + ' / ' + window.__poh.convert('avgaslb', 10)`,
    (v) => v === '45,36 kg / 60,00 lb');

  await step('calculatrice : 2 + 3 × 4 = 14',
    `window.__poh.calc('2+3*4')`,
    (v) => v === '14');

  await step('avertissement OCR affiché pour le 172N',
    `window.__poh.goToDoc('c172n').then(s => 'ocr=' + s.ocrWarningVisible)`,
    (v) => v === 'ocr=true');

  await step('puce document : le SOP s\u2019ouvre à sa page 1',
    `window.__poh.goToDoc('sop-c150').then(s => 'doc=' + s.doc + ' page=' + s.page + ' chapitres=' + s.sections)`,
    (v) => v === 'doc=sop-c150 page=1 chapitres=5');

  await step('pas de débordement horizontal (aucun défilement latéral)',
    `(() => { const vw = document.documentElement.clientWidth; const bad = []; document.querySelectorAll('body *').forEach(el => { const r = el.getBoundingClientRect(); if (r.right > vw + 1 || r.left < -1) bad.push((el.tagName || '?') + '.' + String(el.className && el.className.baseVal === undefined ? el.className : '').split(' ')[0] + ' w=' + Math.round(r.width)); }); return JSON.stringify({ scrollW: document.documentElement.scrollWidth, clientW: vw, bad: [...new Set(bad)].slice(0, 6) }); })()`,
    (v) => { try { const o = JSON.parse(v); return o.scrollW <= o.clientW; } catch { return false; } });

  await step('outils : conversion dans le champ, virgule décimale acceptée (10,5 gal US)',
    `(() => { const input = document.querySelector('#conv-avgas'); input.value = '10,5'; input.dispatchEvent(new Event('input', {bubbles:true})); document.querySelector('#convertersCard').scrollIntoView(); return document.querySelector('#conv-avgas').closest('.converter-row').querySelector('.conv-result').textContent; })()`,
    (v) => v === '39,75 L');
  await shot('06-outils');

  await shot('05-sop-page-1');
  return out;
}
