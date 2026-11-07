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
 *   2. a phone on the previous version of this database, with racks and work
 *      queued: it upgrades, keeps the queue, and the app opens
 *   3. a local database that cannot open -> the error banner, with Reintentar
 *   4. the whole cycle on screen, in protected mode: a container, a cage, food
 *      in, a recolecta and its bandejas, its chequeo and distribución, a caja's
 *      chequeo, carga and separación, the oven, closing / cleaning / repopulating
 *      the cage with the 2 %, the next generation's recolecta, the Laboratorio
 *      tab with its filter and toggle, a correction and its "revisar", the
 *      Resumen tab's numbers (also on a 360 px phone) — then IndexedDB read
 *      directly
 *   5. open mode, as a new database starts: late dates, deleting a record, and
 *      the two pages opened from home, with and without signal
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
  const viewport = width => send('Emulation.setDeviceMetricsOverride', { width, height: 915, deviceScaleFactor: 1, mobile: true });
  await viewport(412);

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
  return { navigate, evaluate, close, logs, shot, viewport };
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
    setPh(ph, value) { return this.setEl(document.querySelector('input[placeholder="' + ph + '"]'), value); }
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

/** Protected mode, as a pull of the settings would leave it (sync is off here). */
const MODO_PROTEGIDO = `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open(${JSON.stringify(DB_NAME)}); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  await new Promise((res, rej) => {
    const tx = db.transaction('parametro', 'readwrite');
    tx.objectStore('parametro').put({ id: 'modo', clave: 'reglas_estrictas', valor: true, updated_at: new Date().toISOString() });
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  db.close();
  return true;
})()`;

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
    check(Boolean(home), 'el inicio pide los primeros registros (insectarios y contenedores)');
    await b.shot('01-inicio-vacio');
    const errs = b.logs.filter(l => !/service worker|sin conexión|backend/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 1', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 2: the previous version of this database, with work queued ──── */

console.log('\nEscenario 2 — teléfono con la versión anterior de la base: racks y trabajo en cola');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    // Version 1 as it shipped: its step is frozen in the app's own code.
    await b.evaluate(`(async () => {
      const { DB_NAME, MIGRATIONS } = await import('./src/data/idb/schema.js');
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open(DB_NAME, 1);
        q.onupgradeneeded = () => MIGRATIONS[0](q.result, q.transaction);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      const hoy = new Date().toISOString();
      await new Promise((res, rej) => {
        const tx = db.transaction(['rack', 'jaula', 'incubadora', 'movimiento', 'outbox'], 'readwrite');
        tx.objectStore('rack').put({ id: 'r1', codigo: 'R1', updated_at: hoy });
        tx.objectStore('jaula').put({ id: 'j1', nombre: 'ICA', letra: 'A', generacion_inicial: 7, fase_inicial: 'activa', updated_at: hoy, created_at: hoy });
        tx.objectStore('incubadora').put({ id: 'i1', codigo: 'F7A-1', jaula_id: 'j1', generacion: 7, numero: 1, recolecta_at: hoy, rack_id: 'r1',
                                           peso_inicial_g: 12, alimento_inicial_kg: 2, updated_at: hoy, created_at: hoy });
        tx.objectStore('movimiento').put({ id: 'm1', objeto: 'incubadora', objeto_id: 'i1', rack_hasta: 'r1', fecha: hoy, updated_at: hoy });
        const cola = tx.objectStore('outbox');
        cola.put({ id: 'o1', seq: 1, status: 'pending', op: 'upsert', table: 'rack', row_id: 'r1', row_ids: ['r1'], payload: { id: 'r1' }, created_at: hoy });
        cola.put({ id: 'o2', seq: 2, status: 'pending', op: 'upsert', table: 'incubadora', row_id: 'i1', row_ids: ['i1'], created_at: hoy,
                   payload: { id: 'i1', codigo: 'F7A-1', rack_id: 'r1' }, depends_on: ['j1', 'r1'] });
        cola.put({ id: 'o3', seq: 3, status: 'pending', op: 'upsert', table: 'movimiento', row_id: 'm1', row_ids: ['m1'], payload: { id: 'm1' }, created_at: hoy });
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      });
      db.close();
      localStorage.setItem('tryento.operator', 'Maria');
    })()`);

    await b.navigate(`${ORIGIN}/index.html`);
    const booted = await waitFor(b, `(async () => { const api = window.__BSF_DATA_CLIENT__; if (!api) return null;
      try { await api.ready(); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
    check(booted === 'ok', 'la app arranca sobre la base anterior', booted || 'no respondió');
    const d = await b.evaluate(DUMP);
    check(d.version === DB_VERSION && !d.stores.includes('rack') && !d.stores.includes('movimiento'), 'la base se actualizó, sin racks', 'v' + d.version);
    check(d.outbox.length === 1 && d.outbox[0].id === 'o2' && !('rack_id' in d.outbox[0].payload), 'la cola conserva lo que todavía puede llegar, sin el rack',
          JSON.stringify(d.outbox.map(i => i.id)));
    check(d.incubadora.length === 1, 'los datos siguen');
    await b.evaluate(HELPERS);
    await waitFor(b, `__t.click('Laboratorio')`, 6000);
    check(Boolean(await waitFor(b, `document.body.innerText.includes('F7A-1') && document.body.innerText.includes('1 bandeja')`)),
          'la recolecta de antes aparece, con una bandeja');
    const errs = b.logs.filter(l => !/service worker|sin conexión|backend/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 2', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 3: the local database cannot open ───────────────────────────── */

console.log('\nEscenario 3 — la base local no se puede abrir');
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
    bad('escenario 3', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 4: the whole cycle, on screen, in protected mode ───────────── */

console.log('\nEscenario 4 — el ciclo completo, en la pantalla, en modo protegido');
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
  /**
   * Save a form: its confirmation, then the form gone (back on the page it
   * came from). The whole cycle happens today, so a scheduled step is days
   * early and the app asks «¿Guardar igual?» first: `pregunta` is what that
   * question must say; it is answered "Guardar igual".
   */
  let preguntas = 0;
  const guardar = async (boton, toast, pregunta = null) => {
    await tap(boton);
    const visto = await waitFor(b, `(t => t.includes('¿guardar igual?') || t.includes(${JSON.stringify(toast.toLowerCase())}))(__t.text().toLowerCase())`, 8000);
    if (!visto) throw new Error('no pasó nada al tocar «' + boton + '»');
    if (await b.evaluate(`__t.text().toLowerCase().includes('¿guardar igual?')`)) {
      if (pregunta && !(await ve(pregunta))) throw new Error('la pregunta no dice «' + pregunta + '»');
      preguntas++;
      await tap('Guardar igual');
    } else if (pregunta) {
      throw new Error('guardó sin preguntar');
    }
    if (!(await ve(toast))) throw new Error('no se confirmó «' + toast + '»: ' + (await T()).slice(-300));
    // Every form has its date box or its note; no list or page has either.
    const cerrado = await waitFor(b, `!document.querySelector('textarea, input[type=datetime-local]')`, 8000);
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
    const listo = `(async () => { const api = window.__BSF_DATA_CLIENT__; if (!api) return null; await api.ready(); return true; })()`;
    await b.navigate(`${ORIGIN}/index.html`);
    await waitFor(b, listo);
    await b.evaluate(MODO_PROTEGIDO);
    await b.navigate(`${ORIGIN}/index.html`);
    await waitFor(b, listo);
    await b.evaluate(HELPERS);
    await ve('Toca tu nombre');
    await b.shot('03-nombre');

    await paso('elegir el nombre', () => tap('Maria'), 'Para empezar');
    await b.shot('04-para-empezar');
    await paso('registrar el contenedor S2', async () => { await tap('Registrar contenedor'); await setPh('S2', 'S2'); await confirmar('Registrar', 'Contenedor registrado'); }, 'Para empezar');
    await paso('registrar el insectario ICA (F7, con moscas)', async () => {
      await abrir('Registrar insectario', 'LETRA EN LOS CÓDIGOS');
      await set('NOMBRE', 'ICA'); await set('LETRA EN LOS CÓDIGOS', 'A'); await set('LUGAR', 'Galpón 1');
      await set('GENERACIÓN QUE TIENE HOY', '7'); await tap('Con moscas');
      await b.shot('05-nuevo-insectario');
      await guardar('Registrar insectario', 'Insectario registrado');
    }, 'Nueva recolecta');
    check(!(await T()).includes('para empezar'), 'con un insectario y un contenedor, «Para empezar» se va');
    await b.shot('05b-inicio');

    // Food in: one button on the home page, everything in its tab.
    const inicio = await T();
    check(!inicio.includes('recepción de material') && !inicio.includes('nuevo ensilado'), 'el inicio ya no tiene recepción ni ensilado por separado');
    await paso('recepción de 100 kg de bagazo, desde el botón Alimento', async () => {
      await abrir('Alimento', 'Nuevo ensilado'); await ve('Contenedor S2'); await abrir('Recepción', 'PESO RECIBIDO');
      await tap('Bagazo de cerveza (BSG)'); await set('PESO RECIBIDO', '100');
      await guardar('Guardar recepción', 'Recepción guardada');
    }, 'quedan 100 kg sin ensilar');
    await paso('ensilado de 80 kg en S2', async () => {
      await abrir('Nuevo ensilado', 'QUÉ ENTRA'); await tap('S2'); await set('KG AL ENSILADO', '80');
      await b.shot('06-ensilado');
      await guardar('Guardar ensilado', 'Ensilado guardado');
    }, `S2-${HOY}`);
    check((await T()).includes('madurando'), 'el ensilado queda madurando');
    await b.shot('06b-alimento');

    // The recolecta.
    const bandejas = () => b.evaluate(`__t.field('BANDEJAS A ARMAR').value`);
    await paso('recolecta de ICA: F7A-1, la app propone las bandejas', async () => {
      await tab('Inicio'); await abrir('Nueva recolecta', 'PESO INICIAL');
      if (!(await ve('Escribe el peso y la app calcula las bandejas: 2–5 g por bandeja'))) throw new Error('no explica las bandejas');
      await set('PESO INICIAL (HUEVOS / LARVAS)', '12,5');
      if (!(await ve('12,5 g: entre 3 y 6 bandejas (2–5 g por bandeja)'))) throw new Error('no calcula el rango');
      if (await bandejas() !== '4') throw new Error('propuso ' + await bandejas());
      if (!(await ve('Con 4 son 3,13 g cada una'))) throw new Error('no dice los gramos por bandeja');
      if (await b.evaluate(`__t.field('ALIMENTO INICIAL POR BANDEJA').value`) !== '400') throw new Error('el alimento no empieza en 400 g');
      if (!(await ve('4 bandejas × 400 g = 1,6 kg en total'))) throw new Error('no dice el alimento total');
      if (!(await ve('Código: F7A-1'))) throw new Error('no muestra el código F7A-1');
      await b.shot('07-recolecta');
      // A number the person chooses is theirs: the weight no longer moves it.
      await tap('+'); if (await bandejas() !== '5') throw new Error('«+» dejó ' + await bandejas());
      await tap('−'); await tap('−'); if (await bandejas() !== '3') throw new Error('«−» dejó ' + await bandejas());
      await set('PESO INICIAL (HUEVOS / LARVAS)', '12');
      if (await bandejas() !== '3') throw new Error('el peso cambió las bandejas elegidas');
      // Out of the range: shown as it is typed, and in protected mode it asks.
      await set('BANDEJAS A ARMAR', '9');
      if (!(await ve('Con 9 bandejas son 1,33 g por bandeja; el protocolo pide 2–5 g'))) throw new Error('no avisa fuera del rango');
      await b.shot('07b-recolecta-fuera-de-rango');
      await tap('Guardar recolecta');
      if (!(await ve('¿Guardar igual?'))) throw new Error('modo protegido: no preguntó por el rango');
      await tap('Cancelar');
      await set('BANDEJAS A ARMAR', '3'); await set('PESO INICIAL (HUEVOS / LARVAS)', '12,5');
      await guardar('Guardar recolecta', 'Recolecta guardada');
    });

    // Chequeo día 3 and distribución, from the incubadora's page.
    await paso('la incubadora F7A-1 y lo que sigue', async () => { await tab('Laboratorio'); await ve('F7A-1'); await abrir('F7A-1', 'QUÉ SIGUE'); }, 'Chequeo día 3');
    await b.shot('08-incubadora');
    await paso('chequeo del día 3, en el día 0: pregunta, y «Cancelar» no guarda nada', async () => {
      await abrir('Chequeo día 3', 'HUMEDAD · %');
      await set('HUMEDAD · %', '68'); await set('TEMP. · °C', '29,5'); await set('PESO · G', '40');
      await tap('Guardar chequeo');
      if (!(await ve('Esto es del chequeo del día 3 y la incubadora F7A-1 va en el día 0'))) throw new Error('no preguntó');
      await b.shot('09a-guardar-igual');
      await tap('Cancelar');
      if (!(await waitFor(b, `!!document.querySelector('input[type=datetime-local]')`, 4000))) throw new Error('el formulario se cerró');
      await guardar('Guardar chequeo', 'Chequeo del día 3 guardado', 'va en el día 0');
    }, '68 % · 29,5 °C · 40 g');
    await paso('tamizado, pesado y distribución en 2 cajas', async () => {
      await abrir('Tamizado, pesado y distribución', 'LARVAS TAMIZADAS');
      await set('LARVAS TAMIZADAS (TOTAL)', '1,8'); await set('PESO · KG', '0,9', 0);
      await tap('Agregar caja'); await ve('F7A-1-02'); await set('PESO · KG', '0,9', 1);
      await b.shot('09-distribucion');
      await guardar('Guardar distribución', 'Distribución guardada', 'del día 7 y la incubadora F7A-1 va en el día 0');
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
      await guardar('Guardar chequeo', 'Chequeo del día 10 guardado', 'la caja F7A-1-01 va en el día 0');
    }, '62 % · 31 °C · 2,3 kg');
    await paso('carga 2 como dice el plan', async () => {
      await abrir('Carga 2', 'Guardar carga 2'); await guardar('Guardar carga 2', 'Carga 2 guardada', 'carga 2 (día 10)');
    }, '2 kg ·');
    await paso('separación: 10 kg', async () => {
      await abrir('Separación', 'PESO TOTAL · KG'); await set('PESO TOTAL · KG', '10');
      if (!(await ve('9,8 kg al horno · 0,2 kg al insectario'))) throw new Error('no muestra el reparto 98/2');
      await b.shot('11-separacion');
      await guardar('Guardar separación', 'Separación guardada', 'La separación es hacia el día 16');
    }, 'Separada');
    check(preguntas === 5, 'cada paso días antes de tiempo preguntó antes de guardarse', String(preguntas));

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
    await paso('el insectario ICA', async () => { await tab('Laboratorio'); await ve('ICA · A'); await abrir('ICA · A', 'REGISTROS'); }, 'Cerrar el insectario');
    await paso('cierre', async () => { await tap('Cerrar el insectario'); await confirmar('Registrar cierre', 'Cierre registrado'); }, 'Limpieza del insectario');
    await paso('limpieza', async () => { await tap('Limpieza del insectario'); await confirmar('Registrar limpieza', 'Limpieza registrada'); }, 'Repoblar con el 2 %');
    await paso('repoblar con 0,2 kg del 2 %: el insectario será F8', async () => {
      await abrir('Repoblar con el 2 %', 'LARVAS DEL 2 %');
      await set('LARVAS DEL 2 % (PESADAS)', '0,2');
      if (!(await ve('el insectario queda F8'))) throw new Error('no muestra la generación del insectario');
      await b.shot('14-ingreso');
      await guardar('Repoblar el insectario', 'Insectario repoblado');
    }, 'F8');

    await paso('recolecta de la nueva generación: F8A-1', async () => {
      await tab('Inicio'); await abrir('Nueva recolecta', 'Código: F8A-1');
      await set('PESO INICIAL (HUEVOS / LARVAS)', '11');
      await guardar('Guardar recolecta', 'Recolecta guardada');
    });

    // The whole lab on one screen: only what is active, unless asked.
    await paso('Laboratorio: de entrada, sólo lo activo', () => tab('Laboratorio'), 'Ocultar inactivos');
    await b.shot('15-laboratorio');
    let lab = await T();
    check(await b.evaluate(`document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true'`), 'el interruptor empieza encendido');
    check(lab.includes('ica · a') && lab.includes('f8a-1') && lab.includes('f7a-1-02'), 'muestra el insectario y las bandejas activas');
    check(!lab.includes('f7a-1-01'), 'oculta la bandeja ya separada y la incubadora ya distribuida');
    check(lab.includes('día 0 · 3 bandejas · ica'), 'una recolecta dice cuántas bandejas ocupa');
    check(lab.includes('bandejas · 4') && lab.includes('insectarios · 1'), 'cuenta las bandejas de verdad: 3 de la recolecta y 1 caja');
    check(lab.includes('ocultos: 4 bandejas'), 'dice cuánto hay oculto');
    // Polled: the toast of the last recolecta also says F8A-1 for a few seconds.
    const sale = txt => waitFor(b, `!__t.text().toLowerCase().includes(${JSON.stringify(txt)})`, 6000);
    await paso('filtro: sólo insectarios', async () => {
      await tap('Insectarios · 1');
      if (!(await sale('f8a-1')) || !(await ve('ICA · A'))) throw new Error('el filtro no filtró');
    });
    await paso('filtro: sólo bandejas', async () => {
      await tap('Bandejas · 4');
      if (!(await sale('ica · a')) || !(await ve('F8A-1'))) throw new Error('el filtro no filtró');
    });
    await tap('Todo');
    await paso('apagar el interruptor muestra lo inactivo', () => tap('Ocultar inactivos'), 'F7A-1-01');
    check((await T()).includes('bandejas · 8'), 'con lo inactivo, 8 bandejas');
    await b.shot('15b-laboratorio-todo');

    // A correction, and what it leaves to review.
    await paso('corregir la separación: eran 12 kg', async () => {
      await abrir('F7A-1-01', 'REGISTROS');
      await abrir('Separación', 'PESO TOTAL');
      await set('PESO TOTAL', '12');
      if ((await T()).includes('borrar este registro')) throw new Error('modo protegido: ofrece borrar');
      await b.shot('15c-corregir');
      await guardar('Guardar corrección', 'Corrección guardada');
    }, '12 kg → 11,76 kg al horno');
    await paso('el inicio avisa lo que hay que revisar', () => tab('Inicio'), 'para revisar');
    await paso('la lista de revisar', () => abrir('Revisar', 'Ingreso en ICA'), 'Cambió una separación anterior');
    await b.shot('16-revisar');

    // The lab in numbers, from what was just done.
    await paso('la pestaña Resumen', () => tab('Resumen'), 'ÚLTIMAS 8 SEMANAS');
    await b.shot('17-resumen');
    const r = await T();
    check(r.includes('2 registros para revisar'), 'resumen: avisa lo que hay que revisar (el ingreso y la cochada)');
    check(r.includes('1,96 kg') && r.includes('98 % esperando el horno'), 'resumen: el 98 % que espera el horno (11,76 − 9,8)');
    check(r.includes('esta semana (en curso): 23,5 g en 2 recolectas'), 'resumen: lo recolectado esta semana');
    check(r.includes('esta semana (en curso): 12 kg de 1 caja'), 'resumen: lo separado esta semana');
    check(r.includes('separaciones: 1 caja · 12 kg → 11,76 kg al horno y 0,24 kg al insectario'), 'resumen: las separaciones del periodo');
    check(r.includes('23,5 g · 2 recolectas'), 'resumen: lo recolectado por jaula');
    check(r.includes('32 %') && r.includes('rendimiento del horno'), 'resumen: el rendimiento del horno (3,1 de 9,8 kg)');
    const columnas = await b.evaluate(`(() => {
      const x = [...document.querySelectorAll('button[aria-label]')].filter(e => e.getAttribute('aria-label').startsWith('Semana del'));
      if (x.length) x[0].click();
      return x.length;
    })()`);
    check(columnas === 14, 'resumen: cada semana anterior es una columna que se toca (7 por gráfica)', String(columnas));
    check(Boolean(await ve(': 0 g en 0 recolectas')), 'resumen: tocar una columna lee su semana');
    await paso('resumen: los números de cada semana', () => tap('Ver los números de cada semana'), 'KG SEP.');
    await paso('resumen: los últimos 7 días', () => tap('7 días'), 'Últimos 7 días · desde el');
    // The tabs and the tiles on a narrow phone: nothing runs over, nothing scrolls sideways.
    await b.viewport(360);
    await settle();
    const ancho = await b.evaluate(`(() => {
      const tabs = [...document.querySelectorAll('button')].filter(e => ['Inicio', 'Laboratorio', 'Horno', 'Alimento', 'Resumen'].includes(e.innerText.trim()));
      const corta = tabs.filter(e => [...e.children].some(c => c.scrollWidth > e.clientWidth + 1)).map(e => e.innerText.trim());
      return { tabs: tabs.length, corta, scroll: document.documentElement.scrollWidth };
    })()`);
    check(ancho.tabs === 5 && !ancho.corta.length, 'a 360 px las cinco pestañas caben', ancho.corta.join(', '));
    check(ancho.scroll <= 360, 'a 360 px no hay desplazamiento lateral', ancho.scroll + ' px');
    await b.shot('18-resumen-360');
    // Every screen staff land on often, at that width.
    const sinDesborde = `(() => {
      const cortados = [...document.querySelectorAll('button')].filter(e => e.scrollWidth > e.clientWidth + 1 && !e.querySelector('[style*="ellipsis"]')).map(e => e.innerText.trim().slice(0, 30));
      return { scroll: document.documentElement.scrollWidth, cortados };
    })()`;
    await tab('Laboratorio'); await tap('Insectarios ·');
    await settle();
    await b.shot('18b-laboratorio-360');
    let medida = await b.evaluate(sinDesborde);
    check(medida.scroll <= 360 && !medida.cortados.length, 'a 360 px el Laboratorio cabe', JSON.stringify(medida));
    await tap('Todo');
    await tab('Inicio');
    await settle();
    await b.shot('18c-inicio-360');
    medida = await b.evaluate(sinDesborde);
    check(medida.scroll <= 360 && !medida.cortados.length, 'a 360 px el inicio cabe, con sus dos páginas', JSON.stringify(medida));
    await abrir('Nueva recolecta', 'BANDEJAS A ARMAR');
    await set('PESO INICIAL (HUEVOS / LARVAS)', '12');
    await settle();
    await b.shot('18d-recolecta-360');
    medida = await b.evaluate(sinDesborde);
    check(medida.scroll <= 360 && !medida.cortados.length, 'a 360 px la recolecta cabe', JSON.stringify(medida));
    await tap('←');
    await b.viewport(412);

    const d = await b.evaluate(DUMP);
    const codigos = (d.incubadora || []).map(i => i.codigo).sort().join(', ');
    check(codigos === 'F7A-1, F8A-1', 'incubadoras guardadas', codigos);
    const f7 = (d.incubadora || []).find(i => i.codigo === 'F7A-1');
    check(f7?.n_bandejas === 3 && f7?.alimento_inicial_kg === 1.2 && f7?.peso_inicial_g === 12.5, 'una recolecta, un código: 3 bandejas y 1,2 kg en total',
          JSON.stringify([f7?.n_bandejas, f7?.alimento_inicial_kg, f7?.peso_inicial_g]));
    check((d.incubadora || []).find(i => i.codigo === 'F8A-1')?.n_bandejas === 3, 'la siguiente propone 3 bandejas para 11 g');
    check(!d.stores.includes('rack') && !d.stores.includes('movimiento'), 'ni rastro de racks en el teléfono');
    check((d.caja || []).map(c => c.codigo).sort().join(', ') === 'F7A-1-01, F7A-1-02', 'cajas guardadas');
    // «Cancelar» saved nothing: one chequeo on día 3, one on día 10.
    check((d.chequeo || []).map(c => c.dia).sort((x, y) => x - y).join(',') === '3,10', 'chequeos guardados, sin duplicados',
          (d.chequeo || []).map(c => c.dia).join(','));
    // "Todo" fills the box with "9,8": what is stored must be the number.
    check((d.cochada_origen || [])[0]?.kg === 9.8, 'la cochada guardó los kg que tomó del 98 %', String((d.cochada_origen || [])[0]?.kg));
    const sep = (d.separacion || [])[0];
    check(sep && sep.peso_total_kg === 12 && sep.valores_editados_at && sep.editado_por === 'Maria', 'la corrección quedó, con quién y cuándo');
    check((d.ingreso || [])[0]?.generacion === 8 && (d.bandeja_pupacion || []).length === 1, 'ingreso F8 con su bandeja');
    check((d.jaula_evento || []).map(e => e.tipo).sort().join(',') === 'cierre,limpieza', 'cierre y limpieza registrados');
    const rpcs = (d.outbox || []).sort((a, b) => a.seq - b.seq).map(i => i.rpc || i.table);
    for (const r of ['contenedor', 'jaula', 'recepcion', 'crear_ensilado', 'incubadora', 'chequeo', 'distribuir',
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
    bad('escenario 4', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 5: open mode, and the two pages, with and without signal ─────── */

console.log('\nEscenario 5 — modo abierto; las dos páginas, desde el inicio y sin señal');
{
  const b = await launch();
  const hay = (txt, ms = 8000) => waitFor(b, `document.body.innerText.includes(${JSON.stringify(txt)})`, ms);
  const GUIA = 'Cómo usar la app de producción';
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    await b.evaluate(`localStorage.setItem('tryento.operator', 'Maria')`);
    await b.navigate(`${ORIGIN}/index.html`);
    await b.evaluate(HELPERS);
    check(Boolean(await hay('Cómo usar la app')) && Boolean(await hay('Protocolo')), 'el inicio ofrece «Protocolo» y «Cómo usar la app»');
    // Late is allowed: a recolecta of three days ago, its chequeo dated yesterday, nothing asked.
    const ayer = new Date(Date.now() - 864e5 - 4 * 36e5).toISOString().slice(0, 10) + 'T09:00';
    const pulsa = async t => { if (!(await waitFor(b, `__t.click(${JSON.stringify(t)})`, 6000))) throw new Error('no encuentro «' + t + '»'); await new Promise(r => setTimeout(r, 300)); };
    const dato = async (l, v, n = 0) => { if (!(await waitFor(b, `__t.set(${JSON.stringify(l)}, ${JSON.stringify(v)}, ${n})`, 6000))) throw new Error('no encuentro «' + l + '»'); };
    await pulsa('Registrar insectario');
    await dato('NOMBRE', 'ICA'); await dato('LETRA EN LOS CÓDIGOS', 'A'); await dato('GENERACIÓN QUE TIENE HOY', '7');
    await pulsa('Con moscas'); await pulsa('Registrar insectario'); await hay('Insectario registrado');
    await waitFor(b, `!document.querySelector('textarea')`, 6000);
    await new Promise(r => setTimeout(r, 400));
    await pulsa('Nueva recolecta');
    await dato('PESO INICIAL (HUEVOS / LARVAS)', '12');
    // Out of the range in open mode: the form says so, and nothing asks.
    await dato('BANDEJAS A ARMAR', '1');
    check(Boolean(await hay('Con 1 bandeja son 12 g por bandeja')), 'fuera del rango, el formulario lo dice');
    await pulsa('Es de hoy · toca si fue otro día');
    await dato('FECHA', new Date(Date.now() - 3 * 864e5 - 4 * 36e5).toISOString().slice(0, 10) + 'T09:00');
    await pulsa('Guardar recolecta'); check(Boolean(await hay('Recolecta guardada')), 'recolecta guardada');
    await new Promise(r => setTimeout(r, 400));
    await b.evaluate(`__t.click('Laboratorio')`); await pulsa('F7A-1'); await pulsa('Chequeo día 3');
    await dato('HUMEDAD · %', '50'); await dato('TEMP. · °C', '30'); await dato('PESO · G', '1'); await dato('FECHA Y HORA', ayer);
    await pulsa('Guardar chequeo');
    const nada = await waitFor(b, `(t => t.includes('¿Guardar igual?') ? 'pregunta' : t.includes('guardado') && 'ok')(document.body.innerText)`, 6000);
    check(nada === 'ok', 'un chequeo con fecha de ayer se guarda sin preguntar', String(nada));
    const d = await b.evaluate(DUMP);
    check((d.chequeo || [])[0]?.fecha?.slice(0, 10) === ayer.slice(0, 10), 'guardado con la fecha escrita', (d.chequeo || [])[0]?.fecha);
    await waitFor(b, `!document.querySelector('input[type=datetime-local]')`, 6000);
    await new Promise(r => setTimeout(r, 400));
    // Any record can be deleted, after a warning.
    await pulsa('Chequeo día 3'); await pulsa('Borrar este registro');
    check(Boolean(await hay('Deja de verse en todos los teléfonos')), 'borrar avisa antes');
    await pulsa('Borrar');
    check(Boolean(await hay('Borrado')), 'el registro se borra');
    const d2 = await b.evaluate(DUMP);
    check(Boolean((d2.chequeo || [])[0]?.deleted_at) && (d2.outbox || []).some(i => i.rpc === 'borrar_registros'), 'marcado, y en la cola para el servidor');
    await b.navigate(`${ORIGIN}/index.html`);
    await b.evaluate(HELPERS);
    await hay('Cómo usar la app');
    await b.shot('19-inicio-paginas');

    // Precached, and this page under the worker's control, before going on.
    check(Boolean(await waitFor(b, `navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)`)), 'el service worker controla la app');

    await b.evaluate(`__t.click('Cómo usar la app')`);
    check(Boolean(await hay(GUIA)), 'el botón abre la guía');
    await b.shot('20-guia');
    await b.evaluate(`[...document.querySelectorAll('a')].find(a => a.textContent.includes('Volver a la app')).click()`);
    check(Boolean(await hay('Nueva recolecta')), '«Volver a la app» vuelve al inicio');
    await b.evaluate(HELPERS);
    await hay('Protocolo');
    await b.evaluate(`__t.click('Protocolo')`);
    check(Boolean(await hay('Cómo trabaja el laboratorio')), 'el botón abre el protocolo');
    await b.shot('21-protocolo');
    await b.evaluate(`[...document.querySelectorAll('a')].find(a => a.textContent.includes('Volver a la app')).click()`);
    check(Boolean(await hay('Nueva recolecta')), 'y desde el protocolo también se vuelve');

    // With no signal: the guide, the protocol it links to, and still the app.
    await new Promise(res => { server.close(res); server.closeAllConnections(); });
    await b.navigate(`${ORIGIN}/guia-app.html`);
    check(Boolean(await hay(GUIA)), 'sin señal, la guía abre');
    await b.navigate(`${ORIGIN}/protocolo.html`);
    check(Boolean(await hay('Cómo trabaja el laboratorio')), 'sin señal, el protocolo abre');
    await b.navigate(`${ORIGIN}/index.html`);
    check(Boolean(await hay('Nueva recolecta')), 'sin señal, la app sigue abriendo en la app, no en la guía');
  } catch (e) {
    bad('escenario 5', e.message);
  } finally {
    await b.close();
  }
}

server.close();
console.log(`\n${pass} ok, ${fail} fallas.`);
process.exitCode = fail ? 1 : 0;
