/**
 * check-idb-browser.mjs — rehearse the app in REAL Chrome, at phone size.
 *
 *   npm run build && npm run check:idb-browser
 *   SHOTS=<folder> npm run check:idb-browser      (also saves screenshots)
 *
 * The unit tests run IndexedDB through fake-indexeddb and never render a
 * screen. This builds the app (dist/), opens it in headless Chrome and drives
 * it like a person would, then reads what is actually stored.
 *
 * SYNC IS OFF: app-config.js is replaced with an empty config, so nothing this
 * does can reach the production database.
 *
 * Scenarios:
 *   1. a phone that ran the earlier protocols: its database is deleted, the
 *      app starts clean and asks for the first registrations
 *   2. a local database that cannot open -> the error banner, with Reintentar
 *   3. the whole cycle on screen: racks, a container, a cage, food in, a
 *      recolecta, its chequeo and distribución, a caja's chequeo, carga and
 *      separación, the oven, closing / cleaning / repopulating the cage with
 *      the 2 %, the next generation's recolecta, a correction and its
 *      "revisar" — then IndexedDB read directly
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const { DB_NAME, DB_VERSION } = await import('../src/data/idb/schema.js');
const { ddmm } = await import('../src/data/time.js');

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.log('Falta dist/. Corre primero: npm run build');
  process.exit(1);
}

const CHROME = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'
].find(p => p && existsSync(p));
if (!CHROME) { console.log('No encontré Chrome/Edge. Define CHROME_PATH.'); process.exit(1); }

let pass = 0, fail = 0;
const ok = (l, x) => { pass++; console.log('  ok    ' + l + (x ? '   ' + x : '')); };
const bad = (l, x) => { fail++; console.log('  FAIL  ' + l + (x ? '   ' + x : '')); };
const check = (cond, l, x) => (cond ? ok(l, x) : bad(l, x));

/* ── static server: dist/, with sync disabled ─────────────────────────────── */

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const send = (body, type) => { res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body); };
  if (rel === '/app-config.js') return send('window.__TRYENTO_CONFIG__ = { authMode: "none" };', 'text/javascript');
  if (rel === '/__setup.html') return send('<!doctype html><title>setup</title>', 'text/html');
  const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
  if (!path.normalize(file).startsWith(DIST)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

/* ── Chrome over the DevTools protocol ────────────────────────────────────── */

async function launch() {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'tryento-idb-'));
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'],
    { stdio: 'ignore' });
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  const [port] = (await readFile(portFile, 'utf8')).split('\n');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0;
  const pending = new Map();
  const listeners = [];
  const logs = [];
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      logs.push(msg.params.args.map(a => a.value ?? a.description ?? '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push('EXCEPTION ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    }
    for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  await send('Page.enable');
  await send('Runtime.enable');
  // A phone-sized screen, so layouts are judged at the size staff use.
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 1, mobile: true });

  // Everything waits with a deadline: a missed browser event must fail the run
  // with a message, not hang it.
  const within = (p, ms, what) => Promise.race([p, new Promise((_, j) =>
    setTimeout(() => j(new Error(`${what}: sin respuesta en ${ms / 1000} s`)), ms))]);
  const navigate = async url => {
    const loaded = new Promise(r => listeners.push(m => { if (m.method === 'Page.loadEventFired') r(); }));
    await within(send('Page.navigate', { url }), 15000, 'navegar a ' + url);
    await within(loaded, 20000, 'cargar ' + url);
  };
  const evaluate = async (expression) => {
    const r = await within(send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }), 30000, 'evaluar');
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const close = async () => {
    try { await send('Browser.close'); } catch { /* already closing */ }
    ws.close();
    await new Promise(r => setTimeout(r, 500));
    try { proc.kill(); } catch { /* gone */ }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
  };
  /** SHOTS=<folder> saves a full-page screenshot, to look at a screen. */
  const shot = async name => {
    if (!process.env.SHOTS) return;
    await new Promise(r => setTimeout(r, 300));
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(process.env.SHOTS, { recursive: true });
    await writeFile(path.join(process.env.SHOTS, name + '.png'), Buffer.from(data, 'base64'));
  };
  return { navigate, evaluate, close, logs, shot };
}

/** Poll an expression in the page until it is truthy. */
async function waitFor(b, expression, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await b.evaluate(expression).catch(() => null);
    if (v) return v;
    await new Promise(r => setTimeout(r, 150));
  }
  return null;
}

/* ── page-side helpers: act on the screen like a person ──────────────────── */

const HELPERS = `(() => {
  const norm = s => String(s || '').replace(/\\s+/g, ' ').trim();
  window.__t = {
    text: () => norm(document.body.innerText),
    /** Tap the button whose text is, starts with, or contains txt (in that order). */
    click(txt, n = 0) {
      const all = [...document.querySelectorAll('button, label')].filter(b => !b.disabled && norm(b.innerText).includes(txt));
      const rank = b => { const t = norm(b.innerText); return t === txt ? 0 : t.startsWith(txt) ? 1 : 2; };
      const el = all.sort((a, b) => rank(a) - rank(b) || norm(a.innerText).length - norm(b.innerText).length)[n];
      if (!el) return false;
      el.click();
      return true;
    },
    /** The n-th form control after a label with exactly this text. */
    field(label, n = 0) {
      const labs = [...document.querySelectorAll('div, span')].filter(e => e.children.length === 0 && norm(e.textContent) === label);
      const lab = labs[n];
      if (!lab) return null;
      return [...document.querySelectorAll('input, select, textarea')].find(c => lab.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
    },
    setEl(el, value) {
      if (!el) return false;
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      return true;
    },
    set(label, value, n = 0) { return this.setEl(this.field(label, n), value); },
    setPh(ph, value) { return this.setEl(document.querySelector('input[placeholder="' + ph + '"]'), value); },
    /** Choose an option by the text it shows, in the n-th select after a label. */
    pick(label, optionText, n = 0) {
      const el = this.field(label, n);
      if (!el || el.tagName !== 'SELECT') return false;
      const opt = [...el.options].find(o => norm(o.textContent) === optionText);
      return opt ? this.setEl(el, opt.value) : false;
    },
    /** Choose an option by its text in the n-th select on the screen. */
    pickN(n, optionText) {
      const el = document.querySelectorAll('select')[n];
      const opt = el && [...el.options].find(o => norm(o.textContent) === optionText);
      return opt ? this.setEl(el, opt.value) : false;
    }
  };
  return true;
})()`;

/** Read the database straight from IndexedDB, not through the app. */
const DUMP = `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(DB_NAME)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = s => new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const out = { version: db.version, stores: [...db.objectStoreNames] };
  for (const s of out.stores) out[s] = await all(s);
  db.close();
  return out;
})()`;

const DATABASES = `indexedDB.databases().then(l => l.map(d => d.name).sort())`;

/* ── scenario 1: a phone that ran the earlier protocols ───────────────────── */

console.log('\nEscenario 1 — teléfono con la base de los protocolos anteriores');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    await b.evaluate(`(async () => {
      await new Promise((res, rej) => {
        const r = indexedDB.open('tryento', 4);
        r.onupgradeneeded = () => { const db = r.result;
          db.createObjectStore('bandeja', { keyPath: 'id' }); db.createObjectStore('outbox', { keyPath: 'id' }); };
        r.onsuccess = () => { const db = r.result; const tx = db.transaction(['bandeja', 'outbox'], 'readwrite');
          tx.objectStore('bandeja').put({ id: 'b1', id_bandeja: '2009.1.1' });
          tx.objectStore('outbox').put({ id: 'o1', op: 'upsert', table: 'bandeja', status: 'pending' });
          tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); };
        r.onerror = () => rej(r.error);
      });
      localStorage.setItem('tryento.operator', 'Maria');
    })()`);
    check((await b.evaluate(DATABASES)).includes('tryento'), 'la base vieja existe antes de abrir la app');

    await b.navigate(`${ORIGIN}/index.html`);
    const booted = await waitFor(b, `(async () => { const api = window.__BSF_DATA_CLIENT__; if (!api) return null;
      try { await api.ready(); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
    check(booted === 'ok', 'la app arranca', booted || 'no respondió');
    const dbs = await waitFor(b, `${DATABASES}.then(l => !l.includes('tryento') && l.join(','))`, 8000);
    check(dbs === DB_NAME, 'la base vieja se borró; queda la nueva', String(dbs));
    const d = await b.evaluate(DUMP);
    check(d.version === DB_VERSION && d.stores.includes('incubadora') && !d.stores.includes('bandeja'),
          'base nueva con los almacenes de los protocolos nuevos', 'v' + d.version);
    const home = await waitFor(b, `(t => t.includes('Para empezar') && t)(document.body.innerText)`);
    check(Boolean(home), 'el inicio pide los primeros registros (racks, contenedores, jaulas)');
    await b.shot('01-inicio-vacio');
    const errs = b.logs.filter(l => !/service worker|sin conexión|backend/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 1', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 2: the local database cannot open ───────────────────────────── */

console.log('\nEscenario 2 — la base local no se puede abrir');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    // A database from a NEWER build: this one cannot open it (VersionError).
    await b.evaluate(`new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(DB_NAME)}, ${DB_VERSION + 5});
      r.onupgradeneeded = () => r.result.createObjectStore('meta', { keyPath: 'key' });
      r.onsuccess = () => { r.result.close(); localStorage.setItem('tryento.operator', 'Maria'); res(true); };
      r.onerror = () => rej(r.error); })`);
    await b.navigate(`${ORIGIN}/index.html`);
    const text = await waitFor(b, `(t => t.includes('No se pudieron abrir') && t)(document.body.innerText)`);
    check(Boolean(text), 'aparece el aviso "No se pudieron abrir los datos de este teléfono"');
    check(Boolean(text) && text.includes('Reintentar'), 'con botón Reintentar');
    await b.shot('02-base-no-abre');
  } catch (e) {
    bad('escenario 2', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 3: the whole cycle, on screen ──────────────────────────────── */

console.log('\nEscenario 3 — el ciclo completo, en la pantalla');
{
  const b = await launch();
  // innerText follows text-transform: badges read "MADURANDO". Compare as words, not case.
  const T = () => b.evaluate('__t.text().toLowerCase()');
  const ve = (txt, ms = 8000) => waitFor(b, `__t.text().toLowerCase().includes(${JSON.stringify(txt.toLowerCase())})`, ms);
  // Waits for the button: a screen can show before its data has loaded (the
  // name screen is up before the list of names arrives).
  const tap = async (txt, n = 0) => {
    const r = await waitFor(b, `__t.click(${JSON.stringify(txt)}, ${n})`, 6000);
    if (!r) throw new Error('no encuentro el botón «' + txt + '»');
    await new Promise(res => setTimeout(res, 120));
  };
  /** A tab, from wherever: the tab bar only shows on the tab screens, so go back first. */
  const tab = async name => {
    for (let i = 0; i < 8; i++) {
      if (await b.evaluate(`__t.click(${JSON.stringify(name)})`)) { await new Promise(res => setTimeout(res, 200)); return; }
      if (!(await b.evaluate(`__t.click('←')`))) break;
      await new Promise(res => setTimeout(res, 250));
    }
    throw new Error('no llego a la pestaña «' + name + '»');
  };
  const set = async (label, value, n = 0) => {
    if (!(await b.evaluate(`__t.set(${JSON.stringify(label)}, ${JSON.stringify(value)}, ${n})`))) throw new Error('no encuentro el campo «' + label + '»');
  };
  const setPh = async (ph, value) => {
    if (!(await b.evaluate(`__t.setPh(${JSON.stringify(ph)}, ${JSON.stringify(value)})`))) throw new Error('no encuentro «' + ph + '»');
  };
  const pickN = async (n, opt) => {
    if (!(await b.evaluate(`__t.pickN(${n}, ${JSON.stringify(opt)})`))) throw new Error('no encuentro la opción «' + opt + '»');
  };
  const settle = () => new Promise(res => setTimeout(res, 350));
  /** A step: do it, then expect a text on screen. */
  const paso = async (label, fn, espera) => {
    try {
      await fn();
      const visto = espera ? await ve(espera) : true;
      check(Boolean(visto), label, visto ? '' : 'no apareció «' + espera + '»');
      return Boolean(visto);
    } catch (e) { bad(label, e.message); return false; }
  };
  /** Save a form: its confirmation, then the form gone (back on the page it came from). */
  const guardar = async (boton, toast) => {
    await tap(boton);
    if (!(await ve(toast))) throw new Error('no se confirmó «' + toast + '»: ' + (await T()).slice(-300));
    // Every form has its time box or its note; no list or page has either.
    const cerrado = await waitFor(b, `!document.querySelector('textarea, input[type=time]')`, 8000);
    if (!cerrado) throw new Error('el formulario no se cerró');
    await settle();
  };
  /** Confirm an in-app dialog, then its confirmation. */
  const confirmar = async (boton, toast) => {
    await tap(boton);
    if (!(await ve(toast))) throw new Error('no se confirmó «' + toast + '»');
    await settle();
  };
  const abrir = async (boton, espera) => {
    await tap(boton);
    if (!(await ve(espera))) throw new Error('no se abrió «' + boton + '»');
    await settle();
  };
  const HOY = ddmm(new Date());
  try {
    await b.navigate(`${ORIGIN}/index.html`);
    await waitFor(b, `(async () => { const api = window.__BSF_DATA_CLIENT__; if (!api) return null; await api.ready(); return true; })()`);
    await b.evaluate(HELPERS);
    await ve('Toca tu nombre');
    await b.shot('03-nombre');

    await paso('elegir el nombre', () => tap('Maria'), 'Para empezar');
    await paso('abrir racks y contenedores', () => abrir('Racks, contenedores y jaulas', 'Agregar rack'), 'Agregar rack');
    await paso('registrar el rack R1', async () => { await tap('Agregar rack'); await setPh('R1', 'r1'); await confirmar('Registrar', 'Rack registrado'); }, 'Rack R1');
    await paso('registrar el rack R2', async () => { await tap('Agregar rack'); await setPh('R1', 'R2'); await confirmar('Registrar', 'Rack registrado'); }, 'Rack R2');
    await paso('registrar el contenedor S2', async () => { await tap('Agregar contenedor'); await setPh('S2', 'S2'); await confirmar('Registrar', 'Contenedor registrado'); }, 'Contenedor S2');
    await b.shot('04-racks');
    await paso('registrar la jaula ICA (F7, con moscas)', async () => {
      await abrir('Ver y registrar jaulas', 'Registrar jaula');
      await abrir('Registrar jaula', 'LETRA EN LOS CÓDIGOS');
      await set('NOMBRE', 'ICA'); await set('LETRA EN LOS CÓDIGOS', 'A'); await set('LUGAR', 'Galpón 1');
      await set('GENERACIÓN QUE TIENE HOY', '7'); await tap('Con moscas');
      await b.shot('05-nueva-jaula');
      await guardar('Registrar jaula', 'Jaula registrada');
    }, 'ICA · A');

    // Food in.
    await paso('recepción de 100 kg de bagazo', async () => {
      await tab('Alimento'); await ve('Nuevo ensilado'); await abrir('Recepción', 'PESO RECIBIDO');
      await tap('Bagazo de cerveza (BSG)'); await set('PESO RECIBIDO', '100');
      await guardar('Guardar recepción', 'Recepción guardada');
    }, 'quedan 100 kg sin ensilar');
    await paso('ensilado de 80 kg en S2', async () => {
      await abrir('Nuevo ensilado', 'QUÉ ENTRA'); await tap('S2'); await set('KG AL ENSILADO', '80');
      await b.shot('06-ensilado');
      await guardar('Guardar ensilado', 'Ensilado guardado');
    }, `S2-${HOY}`);
    check((await T()).includes('madurando'), 'el ensilado queda madurando');

    // The recolecta.
    await paso('recolecta de ICA en el rack R1: F7A-1', async () => {
      await tab('Inicio'); await abrir('Nueva recolecta', 'PESO INICIAL');
      await tap('R1'); await set('PESO INICIAL (HUEVOS / LARVAS)', '12,5'); await set('ALIMENTO INICIAL', '2');
      if (!(await ve('Código: F7A-1'))) throw new Error('no muestra el código F7A-1');
      await b.shot('07-recolecta');
      await guardar('Guardar recolecta', 'Recolecta guardada');
    });

    // Chequeo día 3 and distribución, from the incubadora's page.
    await paso('la incubadora F7A-1 y lo que sigue', async () => { await tab('Larvas'); await ve('EN INCUBADORA'); await abrir('F7A-1', 'QUÉ SIGUE'); }, 'Chequeo día 3');
    await b.shot('08-incubadora');
    await paso('chequeo del día 3', async () => {
      await abrir('Chequeo día 3', 'HUMEDAD · %');
      await set('HUMEDAD · %', '68'); await set('TEMP. · °C', '29,5'); await set('PESO · G', '40');
      await guardar('Guardar chequeo', 'Chequeo del día 3 guardado');
    }, '68 % · 29,5 °C · 40 g');
    await paso('tamizado, pesado y distribución en 2 cajas', async () => {
      await abrir('Tamizado, pesado y distribución', 'LARVAS TAMIZADAS');
      await set('LARVAS TAMIZADAS (TOTAL)', '1,8'); await set('PESO · KG', '0,9', 0);
      await tap('Agregar caja'); await ve('F7A-1-02'); await set('PESO · KG', '0,9', 1);
      await b.shot('09-distribucion');
      await guardar('Guardar distribución', 'Distribución guardada');
    }, '1,8 kg tamizados · 2 cajas');
    check((await T()).includes('distribuida'), 'la incubadora queda distribuida (inactiva)');

    // A caja: chequeo día 10, then carga 2, then separación.
    await paso('la caja F7A-1-01', () => abrir('F7A-1-01', 'QUÉ SIGUE'), 'Carga 2');
    await b.shot('10-caja');
    check(await b.evaluate(`[...document.querySelectorAll('button')].some(x => x.disabled && x.innerText.includes('Carga 2'))`),
          'la carga 2 espera el chequeo del día 10');
    await paso('chequeo del día 10', async () => {
      await abrir('Chequeo día 10', 'PESO · KG');
      await set('HUMEDAD · %', '62'); await set('TEMP. · °C', '31'); await set('PESO · KG', '2,3');
      await guardar('Guardar chequeo', 'Chequeo del día 10 guardado');
    }, '62 % · 31 °C · 2,3 kg');
    await paso('carga 2 como dice el plan', async () => {
      await abrir('Carga 2', 'Guardar carga 2'); await guardar('Guardar carga 2', 'Carga 2 guardada');
    }, '2 kg ·');
    await paso('separación: 10 kg', async () => {
      await abrir('Separación', 'PESO TOTAL · KG'); await set('PESO TOTAL · KG', '10');
      if (!(await ve('9,8 kg al horno · 0,2 kg al insectario'))) throw new Error('no muestra el reparto 98/2');
      await b.shot('11-separacion');
      await guardar('Guardar separación', 'Separación guardada');
    }, 'Separada');

    // The oven, from the home list.
    await paso('«98 % esperando el horno» en el inicio', () => tab('Inicio'), '98 % esperando el horno · 9,8 kg');
    await b.shot('12-para-hoy');
    await paso('nueva cochada con todo el 98 %, desde su línea', async () => {
      await abrir('98 % esperando el horno', 'KG A LA COCHADA');
      await tap('Todo'); await set('PESO INICIAL (PESADO)', '9,8');
      await guardar('Al horno', 'Cochada al horno');
    });
    await paso('la cochada en el horno', async () => { await tab('Horno'); await ve('EN EL HORNO'); await abrir(`H-${HOY}-1`, 'QUÉ SIGUE'); }, 'Temperatura a mitad del horno');
    await paso('temperatura a mitad del horno', async () => {
      await tap('Temperatura a mitad del horno'); await setPh('°C', '92'); await confirmar('Guardar', 'Temperatura guardada');
    }, '92 °C');
    await paso('temperatura y peso final', async () => {
      await abrir('Temperatura y peso final', 'TEMPERATURA FINAL');
      await set('TEMPERATURA FINAL', '105'); await set('PESO FINAL', '3,1');
      await guardar('Guardar salida del horno', 'Salida del horno guardada');
    }, 'Lista para empacar');
    await b.shot('13-cochada');

    // The insectario: cierre, limpieza, repopulate with the 2 %.
    await paso('la jaula ICA', async () => { await tab('Insectarios'); await ve('ICA · A'); await abrir('ICA · A', 'REGISTROS'); }, 'Cerrar la jaula');
    await paso('cierre', async () => { await tap('Cerrar la jaula'); await confirmar('Registrar cierre', 'Cierre registrado'); }, 'Limpieza de la jaula');
    await paso('limpieza', async () => { await tap('Limpieza de la jaula'); await confirmar('Registrar limpieza', 'Limpieza registrada'); }, 'Repoblar con el 2 %');
    await paso('repoblar con 0,2 kg del 2 %: la jaula será F8', async () => {
      await abrir('Repoblar con el 2 %', 'LARVAS DEL 2 %');
      await set('LARVAS DEL 2 % (PESADAS)', '0,2');
      if (!(await ve('la jaula queda F8'))) throw new Error('no muestra la generación de la jaula');
      await pickN(0, 'R1');
      await b.shot('14-ingreso');
      await guardar('Repoblar la jaula', 'Jaula repoblada');
    }, 'F8');

    await paso('recolecta de la nueva generación: F8A-1', async () => {
      await tab('Inicio'); await abrir('Nueva recolecta', 'Código: F8A-1');
      await tap('R2'); await set('PESO INICIAL (HUEVOS / LARVAS)', '11'); await set('ALIMENTO INICIAL', '2');
      await guardar('Guardar recolecta', 'Recolecta guardada');
    });

    // A correction, and what it leaves to review.
    await paso('corregir la separación: eran 12 kg', async () => {
      await tab('Larvas'); await ve('Ver también las terminadas'); await tap('Ver también las terminadas');
      await ve('F7A-1-01'); await abrir('F7A-1-01', 'REGISTROS');
      await abrir('Separación', 'PESO TOTAL');
      await set('PESO TOTAL', '12');
      await b.shot('15-corregir');
      await guardar('Guardar corrección', 'Corrección guardada');
    }, '12 kg → 11,76 kg al horno');
    await paso('el inicio avisa lo que hay que revisar', () => tab('Inicio'), 'para revisar');
    await paso('la lista de revisar', () => abrir('Revisar', 'Ingreso en ICA'), 'Cambió una separación anterior');
    await b.shot('16-revisar');

    const d = await b.evaluate(DUMP);
    const codigos = (d.incubadora || []).map(i => i.codigo).sort().join(', ');
    check(codigos === 'F7A-1, F8A-1', 'incubadoras guardadas', codigos);
    check((d.caja || []).map(c => c.codigo).sort().join(', ') === 'F7A-1-01, F7A-1-02', 'cajas guardadas');
    const sep = (d.separacion || [])[0];
    check(sep && sep.peso_total_kg === 12 && sep.valores_editados_at && sep.editado_por === 'Maria', 'la corrección quedó, con quién y cuándo');
    check((d.ingreso || [])[0]?.generacion === 8 && (d.bandeja_pupacion || []).length === 1, 'ingreso F8 con su bandeja');
    check((d.jaula_evento || []).map(e => e.tipo).sort().join(',') === 'cierre,limpieza', 'cierre y limpieza registrados');
    const rpcs = (d.outbox || []).sort((a, b) => a.seq - b.seq).map(i => i.rpc || i.table);
    for (const r of ['rack', 'contenedor', 'jaula', 'recepcion', 'crear_ensilado', 'incubadora', 'chequeo', 'distribuir',
                     'alimentacion', 'separacion', 'crear_cochada', 'cochada_lectura', 'jaula_evento', 'ingresar', 'editar']) {
      check(rpcs.includes(r), 'en la cola para el servidor: ' + r);
    }
    check((d.outbox || []).every(i => i.status === 'pending'), 'todo queda pendiente de enviar (sincronización apagada)');
    check((d.outbox || []).every(i => (i.payload?.registrado_por ?? i.payload?.p_por ?? i.payload?.p_cochada?.registrado_por ??
      i.payload?.p_distribucion?.registrado_por ?? i.payload?.p_ingreso?.registrado_por ?? i.payload?.p_ensilado?.registrado_por ?? 'Maria') === 'Maria'),
      'todo registrado como Maria');

    const errs = b.logs.filter(l => !/service worker|sin conexión|backend|never resolved/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 3', e.message);
  } finally {
    await b.close();
  }
}

server.close();
console.log(`\n${pass} ok, ${fail} fallas.`);
process.exitCode = fail ? 1 : 0;
