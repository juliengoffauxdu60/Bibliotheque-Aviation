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
// Petit PDF fixture (3 pages, texte connu) importé pendant l'auto-test —
// plus rapide et déterministe qu'un POH de 19 Mo ; généré par
// scripts/make-fixture-pdf.mjs. Comptes attendus : fuel = 2 pages,
// stall = 1 page, « stall speed » = 1 page, « pression d'huile » = 1 page
// (via « oil pressure »), sections 1/2/3 en p. 1/2/3.
const SELFTEST_FIXTURE = path.join(__dirname, 'test', 'fixtures', 'fixture-3p.pdf');
// Garde-fou : did-finish-load se déclenche à CHAQUE rechargement — sans
// lui, chaque reload de l'auto-test (après import, après suppression)
// relancerait runSelfTest en entier, en concurrence avec l'exécution en
// cours (imports en double, état corrompu). Une seule exécution par processus.
let selfTestStarted = false;

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
      if (selfTestStarted) return; // un seul passage, même après rechargements
      selfTestStarted = true;
      // Laisse le temps au rendu de charger les données.
      await new Promise((r) => setTimeout(r, 1500));
      if (process.env.POH_DEBUG) {
        const probe = await win.webContents.executeJavaScript(`(async () => {
          const out = ['origin=' + location.origin + ' base=' + document.baseURI + ' __poh=' + typeof window.__poh];
          for (const u of ['app://renderer/app.js','app://renderer/search.js','app://renderer/tools.js','app://assets/pdfjs/pdf.mjs','app://data/synonyms.json','app://renderer/styles.css']) {
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
  // Après un rechargement : attend le nouveau __poh prêt, puis laisse
  // le temps à import.js de construire sa boîte d'ajout.
  const WAIT_READY = `new Promise((resolve) => { const t = setInterval(() => { if (window.__poh && window.__poh.ready) { clearInterval(t); window.__poh.ready().then(() => setTimeout(() => resolve('docs=' + window.__poh.state().docsLoaded + ' pages=' + window.__poh.state().totalPages + ' cartes=' + document.querySelectorAll('.doc-card').length + ' ajout=' + (document.querySelector('#importAddBtn') && document.querySelector('#importAddBtn').offsetParent !== null ? 'visible' : 'masqué') + ' message=' + (document.querySelector('.docs-empty') ? 'oui' : 'non')), 800)); } }, 200); setTimeout(() => { clearInterval(t); resolve('timeout'); }, 15000); })`;
  const FIXTURE = JSON.stringify(SELFTEST_FIXTURE);

  // (a) État vide au lancement (v1.2.0 : plus aucun document fourni,
  // profil de test frais) : 0 doc, bouton d'ajout visible, message clair.
  await step('état vide au lancement (0 doc, bouton ajout visible, message clair)',
    `window.__poh.ready().then(() => new Promise((resolve) => setTimeout(() => resolve('docs=' + window.__poh.state().docsLoaded + ' pages=' + window.__poh.state().totalPages + ' cartes=' + document.querySelectorAll('.doc-card').length + ' ajout=' + (document.querySelector('#importAddBtn') && document.querySelector('#importAddBtn').offsetParent !== null ? 'visible' : 'masqué') + ' message=' + (document.querySelector('.docs-empty') ? 'oui' : 'non')), 800)))`,
    (v) => v === 'docs=0 pages=0 cartes=0 ajout=visible message=oui');

  await step('recherche « fuel » avec 0 document : 0 résultat, pas de plantage',
    `window.__poh.search('fuel').then(r => 'n=' + r.total + ' statut=' + document.querySelector('#searchStatus').textContent)`,
    (v) => v.startsWith('n=0 statut=Aucun résultat'));

  await step('question IA avec 0 document : 0 passage trouvé',
    `window.__pohAi.retrieve('fuel').then(r => 'pages=' + r.pages.length)`,
    (v) => v === 'pages=0');

  // (b) Import du document fixture via l'IPC d'import (petit PDF de
  // 3 pages, texte connu — plus rapide et déterministe qu'un POH de 19 Mo).
  await step('import du fixture 3 pages (via IPC import)',
    `window.__pohImportNoReload = true; window.__pohImport.importFile(${FIXTURE}).then(r => 'ok=' + r.ok + ' pages=' + r.totalPages + ' titre=' + r.title)`,
    (v) => v.startsWith('ok=true pages=3'));

  await step('rechargement après import',
    `window.location.reload(); 'rechargement demandé'`,
    (v) => v === 'rechargement demandé');

  await step('après rechargement : 1 document, 3 pages, carte présente',
    WAIT_READY,
    (v) => v === 'docs=1 pages=3 cartes=1 ajout=visible message=non');
  await shot('01-fixture-importe');

  // (c) Vérifications équivalentes sur le document fixture.
  await step('recherche « fuel » : 2 pages (fixture)',
    `window.__poh.search('fuel').then(r => 'n=' + r.total)`,
    (v) => v === 'n=2');
  await shot('02-recherche-fuel');

  await step('recherche « stall » : 1 page (fixture)',
    `window.__poh.search('stall').then(r => 'n=' + r.total)`,
    (v) => v === 'n=1');

  await step('recherche « stall speed » : 1 page exacte',
    `window.__poh.search('stall speed').then(r => 'n=' + r.total)`,
    (v) => v === 'n=1');

  await step('recherche « pression d\u2019huile » : trouve oil pressure',
    `window.__poh.search("pression d'huile").then(r => 'n=' + r.total + ' en=' + r.results.some(x => x.termFound === 'oil pressure'))`,
    (v) => v === 'n=1 en=true');

  await step('ancien champ d\u2019en-tête supprimé (pas de #searchForm ni #scopeSelect, pas de bloc résultats)',
    `'form=' + (document.querySelector('#searchForm') ? 'oui' : 'non') + ' menu=' + (document.querySelector('#scopeSelect') ? 'oui' : 'non') + ' bloc=' + (document.querySelector('.results-block') ? 'oui' : 'non')`,
    (v) => v === 'form=non menu=non bloc=non');

  await step('clic sur toute la carte : ouvre en lecture, sans champ de recherche ni badge',
    `(async () => { const c = document.querySelector('[data-close]'); if (c) c.click(); await new Promise(r => setTimeout(r, 300)); document.querySelector('.doc-pages').click(); await new Promise(r => setTimeout(r, 800)); const info = JSON.parse(window.__poh.scopeInfo()); return 'titre=' + document.querySelector('#readerTitle').textContent + ' champ=' + info.cardFieldOpen + ' badge=' + info.badgeDoc + ' compteur=' + info.hitCounter; })()`,
    (v) => { const m = /titre=(.+) champ=(null) badge=(null) compteur=(—)/.exec(v); return !!m && m[1].startsWith('FIXTURE-3P'); });

  await step('bouton carte « Rechercher dans le document » : champ visible + badge « Recherche ici » + occurrences',
    `(async () => { const id = document.querySelector('.doc-card').dataset.doc; document.querySelector('[data-search]').click(); const input = document.querySelector('.card-search-input'); input.value = 'fuel'; input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 900)); const info = JSON.parse(window.__poh.scopeInfo()); return 'badge=' + info.badgeDoc + ' doc=' + id + ' champ=' + info.cardFieldOpen + ' hits=' + document.querySelector('.card-hits').textContent + ' compteur=' + info.hitCounter; })()`,
    (v) => { const m = /badge=(.+) doc=(.+) champ=(search-.+) hits=(.+) compteur=(.+)/.exec(v); return !!m && m[1] === m[2] && m[4].includes('occurrence') && m[5] === '1 sur 2'; });

  await step('puce « Tous les documents » : occurrences par document, clic -> la bonne carte avec la requête',
    `(async () => { document.querySelector('#chipAll').click(); const g = document.querySelector('#globalInput'); g.value = 'fuel'; g.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 700)); const rows = [...document.querySelectorAll('.global-hit')].map(b => b.textContent.trim()).join(' | '); if (!rows) return 'lignes=aucune'; document.querySelector('.global-hit').click(); await new Promise(r => setTimeout(r, 900)); const info = JSON.parse(window.__poh.scopeInfo()); const input = document.querySelector('.card-search-input'); return 'lignes=' + rows + ' badge=' + (info.badgeDoc || '') + ' champ=' + (input ? input.value : '') + ' compteur=' + info.hitCounter; })()`,
    (v) => { const m = /lignes=(.+) badge=(.+) champ=(fuel) compteur=(1 sur 2)/.exec(v); return !!m && m[1].includes('occurrence') && m[2] !== ''; });

  await step('flèches d\u2019occurrences dans le lecteur : Suivant -> « 2 sur 2 », Précédent -> « 1 sur 2 »',
    `(async () => { document.querySelector('#nextHitBtn').click(); await new Promise(r => setTimeout(r, 900)); const a = document.querySelector('#hitCounter').textContent; document.querySelector('#prevHitBtn').click(); await new Promise(r => setTimeout(r, 900)); const b = document.querySelector('#hitCounter').textContent; return 'apres-suivant=' + a + ' apres-precedent=' + b; })()`,
    (v) => v === 'apres-suivant=2 sur 2 apres-precedent=1 sur 2');

  await step('barre d\u2019occurrences : visible pendant la recherche, cachée sans recherche',
    `(async () => { const visiblePendant = !document.querySelector('#hitNav').hidden; document.querySelector('[data-close]').click(); await new Promise(r => setTimeout(r, 400)); const cacheeApres = document.querySelector('#hitNav').hidden; const compteur = document.querySelector('#hitCounter').textContent; return 'visible=' + visiblePendant + ' cachee=' + cacheeApres + ' compteur=' + compteur; })()`,
    (v) => v === 'visible=true cachee=true compteur=—');

  await step('clic résultat 1 de « fuel » : PDF fixture affiché, 1 seul chargement du document',
    `window.__poh.search('fuel').then(() => window.__poh.openResult(0)).then(s => { const id = document.querySelector('.doc-card').dataset.doc; return 'ok=' + (s.doc === id && s.page === 1 && Object.values(s.loads)[0] === 1); })`,
    (v) => v === 'ok=true');

  await step('feuilletage 1 -> 2 -> 3, page 3 rendue avec du texte',
    `window.__poh.goToPage(1).then(() => window.__poh.goToPage(2)).then(() => window.__poh.goToPage(3)).then(s => 'page=' + s.page + ' erreur=' + s.error + ' pixels=' + window.__poh.nonBlankPixels())`,
    (v) => { const m = /page=(\d+) erreur=(\S+) pixels=(\d+)/.exec(v); return !!m && m[1] === '3' && m[2] === 'aucune' && +m[3] > 0; });
  await shot('03-page-3');

  await step('saut de section 1 -> 3 (p. 3) sans rechargement',
    `window.__poh.goToSection('3').then(s => 'page=' + s.page + ' erreur=' + s.error + ' chargements=' + Object.values(s.loads)[0])`,
    (v) => v === 'page=3 erreur=aucune chargements=1');

  // (d) Étapes indépendantes des documents (inchangées depuis la v1.1.3).
  await step('centrage « Plus grand » : milieu de page au milieu de la vue',
    `window.__poh.goToPage(2).then(() => window.__poh.centeringInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.mode === 'large' && Math.abs(o.offsetPx) <= 3; } catch { return false; } });

  await step('zoom 150 % : canevas 1,5× plus large, page toujours centrée',
    `(() => { const b = JSON.parse(window.__poh.zoomInfo()); window.__zoomBase = b.canvasCssWidth; return window.__poh.setZoom(150).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); window.__zoomW = z.canvasCssWidth; return 'base=' + b.canvasCssWidth + ' zoom=' + z.canvasCssWidth + ' off=' + z.offsetPx + ' label=' + z.label; }); })()`,
    (v) => { const m = /base=(\d+) zoom=(\d+) off=(-?\d+) label=(.*)/.exec(v); if (!m) return false; const base = +m[1], zoom = +m[2]; return zoom / base >= 1.48 && zoom / base <= 1.52 && Math.abs(+m[3]) <= 3 && m[4] === '150 %'; });

  await step('zoom conservé après changement de page (2 -> 3)',
    `window.__poh.goToPage(3).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); return 'pct=' + z.zoomPct + ' w=' + z.canvasCssWidth + ' attendu=' + window.__zoomW; })`,
    (v) => { const m = /pct=(\d+) w=(\d+) attendu=(\d+)/.exec(v); return !!m && +m[1] === 150 && +m[2] === +m[3]; });

  await step('retour à 100 % : canevas à sa largeur de base, boutons −/+ réactivés',
    `window.__poh.setZoom(100).then(() => { const z = JSON.parse(window.__poh.zoomInfo()); return 'pct=' + z.zoomPct + ' w=' + z.canvasCssWidth + ' base=' + window.__zoomBase + ' out=' + z.zoomOutDisabled + ' in=' + z.zoomInDisabled; })`,
    (v) => { const m = /pct=(\d+) w=(\d+) base=(\d+) out=(\w+) in=(\w+)/.exec(v); return !!m && +m[1] === 100 && +m[2] === +m[3] && m[4] === 'false' && m[5] === 'false'; });

  // Surlignage : PDF à vrai texte (fixture) — le terme du résultat
  // courant est surligné sur toutes ses occurrences de la page.
  await step('surlignage : recherche « fuel », page 1 du fixture — occurrences surlignées',
    `window.__poh.search('fuel').then(r => { const i = r.results.findIndex(x => x.page === 1); return window.__poh.openResult(i).then(() => window.__poh.highlightInfo()); })`,
    (v) => { try { const o = JSON.parse(v); return o.page === 1 && o.term === 'fuel' && o.rects > 0; } catch { return false; } });
  await shot('04-surlignage-fuel');

  await step('surlignage : zoom 150 % conserve les rects sur la même page',
    `window.__poh.setZoom(150).then(() => window.__poh.highlightInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.page === 1 && o.term === 'fuel' && o.rects > 0 && o.aligned === true; } catch { return false; } });

  await step('surlignage : retour à 100 % puis recherche sans résultat — plus aucun rect',
    `window.__poh.setZoom(100).then(() => window.__poh.search('zzzqqqintrouvable')).then(() => window.__poh.highlightInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.rects === 0 && o.term === null; } catch { return false; } });

  await step('mode « Page entière » : page visible sans défilement',
    `window.__poh.setMode('fit').then(() => window.__poh.centeringInfo())`,
    (v) => { try { const o = JSON.parse(v); return o.mode === 'fit' && o.fitsWithoutScroll === true; } catch { return false; } });
  await shot('05-page-entiere');

  await step('bloc flottant : visible, en bas au centre, hors zone de défilement',
    `window.__poh.floatingNavInfo()`,
    (v) => { try { const o = JSON.parse(v); return o.visible && o.pinnedBottom && o.outsideScrollArea; } catch { return false; } });

  await step('navigation page par page 3 -> 2 (page précédente)',
    `window.__poh.setMode('large').then(() => window.__poh.goToPage(3)).then(() => window.__poh.prevPage()).then(s => 'page=' + s.page + ' erreur=' + s.error)`,
    (v) => v === 'page=2 erreur=aucune');

  await step('aucune sélection collée après un clic (focus relâché)',
    `(() => { document.querySelector('#nextPageBtn').click(); return new Promise(r => setTimeout(() => r(document.activeElement === document.body ? 'focus=body' : 'focus=' + (document.activeElement && document.activeElement.id)), 300)); })()`,
    (v) => v === 'focus=body');

  await step('résultat Suivant / Précédent + compteur « X sur N » (bloc flottant du lecteur)',
    `window.__poh.search('fuel').then(() => window.__poh.nextResult()).then(() => window.__poh.prevResult())`,
    (v) => v === '1 sur 2');

  await step('conversion : 10 gal US = 37,85 L ; 37,85 L = 10,00 gal US',
    `import('app://renderer/tools.js').then(m => m.convertValue('avgas', 10) + ' / ' + m.convertValueReverse('avgas', 37.85))`,
    (v) => v === '37,85 L / 10,00 gal US');

  await step('conversion : 100 lb = 45,36 kg ; avgas 10 gal = 60 lb ; 45,36 kg = 100,00 lb',
    `import('app://renderer/tools.js').then(m => m.convertValue('lbkg', 100) + ' / ' + m.convertValue('avgaslb', 10) + ' / ' + m.convertValueReverse('lbkg', 45.36))`,
    (v) => v === '45,36 kg / 60,00 lb / 100,00 lb');

  await step('calculatrice : 2 + 3 × 4 = 14',
    `window.__poh.calc('2+3*4')`,
    (v) => v === '14');

  await step('puce document : le fixture s\u2019ouvre à sa page 1 (3 sections, pas de bannière d\u2019avertissement)',
    `(() => { const id = document.querySelector('.doc-card').dataset.doc; return window.__poh.goToDoc(id).then(s => 'doc=' + s.doc + ' page=' + s.page + ' sections=' + s.sections + ' ocr=' + s.ocrWarningVisible); })()`,
    (v) => { const m = /doc=(.+) page=1 sections=3 ocr=false/.exec(v); return !!m; });

  await step('pas de débordement horizontal (aucun défilement latéral)',
    `(() => { const vw = document.documentElement.clientWidth; const bad = []; document.querySelectorAll('body *').forEach(el => { const r = el.getBoundingClientRect(); if (r.right > vw + 1 || r.left < -1) bad.push((el.tagName || '?') + '.' + String(el.className && el.className.baseVal === undefined ? el.className : '').split(' ')[0] + ' w=' + Math.round(r.width)); }); return JSON.stringify({ scrollW: document.documentElement.scrollWidth, clientW: vw, bad: [...new Set(bad)].slice(0, 6) }); })()`,
    (v) => { try { const o = JSON.parse(v); return o.scrollW <= o.clientW; } catch { return false; } });

  await step('outils : conversion dans les deux champs, virgule décimale acceptée (10,5 gal US)',
    `(() => { const row = document.querySelector('#conv-avgas').closest('.converter-row'); const a = row.querySelector('#conv-avgas'); const b = row.querySelector('#conv-avgas-2'); const fire = (el) => el.dispatchEvent(new Event('input', {bubbles:true})); a.value = '10,5'; fire(a); const aller = b.value; b.value = '39,75'; fire(b); const retour = a.value; a.value = ''; fire(a); const vide = b.value === '' ? 'vide-ok' : 'vide-ko'; document.querySelector('#convertersCard').scrollIntoView(); return 'aller=' + aller + ' retour=' + retour + ' ' + vide; })()`,
    (v) => v === 'aller=39,75 retour=10,50 vide-ok');
  await shot('06-outils');

  // Chevauchement (14 nov., capture de Julien) : avec 6 fausses cartes de
  // plus, la colonne de gauche dépasse la grille ; elle doit défiler dans
  // la grille au lieu de se peindre par-dessus « Outils ».
  await step('chevauchement : colonne trop haute -> défile, rien ne déborde sur les outils',
    `(() => { const wrap = document.querySelector('#docCards'); for (let i = 0; i < 6; i++) { const b = document.createElement('button'); b.type = 'button'; b.className = 'doc-card'; b.innerHTML = '<span class="doc-name">TEST ' + i + '</span><br><span class="doc-sub">Document de test pour le contrôle de débordement</span><br><span class="doc-pages">100 pages</span>'; wrap.appendChild(b); } return window.__poh.search('fuel').then(() => { const info = window.__poh.layoutOverlapInfo(); document.querySelectorAll('#docCards .doc-card').forEach((c) => { const t = (c.querySelector('.doc-name') || c.querySelector('.doc-title') || {}).textContent || ''; if (t.startsWith('TEST')) c.remove(); }); return info; }); })()`,
    (v) => { try { const o = JSON.parse(v); return o.overlap === false; } catch { return false; } });

  // Supprimer = supprimer : le fixture supprimé, rechargement, retour à
  // l'état vide (0 document). Profil de test frais, jeté après.
  await step('supprimer le fixture : suppression enregistrée, rechargement',
    `(() => { const id = document.querySelector('.doc-card').dataset.doc; return window.pohDesktop.import.deleteDoc(id).then(r => { const s = 'ok=' + r.ok + ' doc=' + id; window.location.reload(); return s; }); })()`,
    (v) => v.startsWith('ok=true doc='));
  await step('supprimer le fixture : après rechargement, retour à 0 document',
    WAIT_READY,
    (v) => v === 'docs=0 pages=0 cartes=0 ajout=visible message=oui');

  await shot('07-etat-vide');
  return out;
}
