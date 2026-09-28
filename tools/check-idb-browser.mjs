/**
 * check-idb-browser.mjs — rehearse a local-database upgrade in REAL Chrome.
 *
 *   npm run build && npm run check:idb-browser
 *
 * The unit tests run IndexedDB through fake-indexeddb. Real browsers differ in
 * the one place an upgrade can go wrong: when an upgrade transaction commits
 * while a step is still awaiting. So before any push that changes the local
 * schema, this builds a phone's old database in headless Chrome, opens the
 * built app (dist/) on top of it, and reports what is actually stored and what
 * is actually on screen.
 *
 * SYNC IS OFF: app-config.js is replaced with an empty config, so nothing this
 * does can reach the production database.
 *
 * Scenarios:
 *   1. a phone on the pre-rename build (cochada stores, queued lote work)
 *   2. a phone whose database cannot be upgraded -> the error banner, and the
 *      old data left untouched
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
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'idb', 'schema-v1-antes-del-renombrado.mjs');

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
  if (rel === '/__fixture.mjs') return send(await readFile(FIXTURE, 'utf8'), 'text/javascript');
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

  const navigate = async url => {
    const loaded = new Promise(r => listeners.push(m => { if (m.method === 'Page.loadEventFired') r(); }));
    await send('Page.navigate', { url });
    await loaded;
  };
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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
  return { navigate, evaluate, close, logs };
}

/** Poll an expression in the page until it is truthy. */
async function waitFor(b, expression, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await b.evaluate(expression).catch(() => null);
    if (v) return v;
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/* ── page-side snippets ───────────────────────────────────────────────────── */

const SEED_PRE_RENAME = `(async () => {
  const fx = await import('/__fixture.mjs');
  const T0 = '2026-09-20T14:00:00.000Z';
  const u = () => crypto.randomUUID();
  const ID = { ins: u(), rec: u(), b1: u(), b2: u(), s1: u(), s2: u(), synced: u(), local: u(), dev: u() };
  const prov = s => ({ registrado_por: 'Maria', created_by: null, dispositivo_id: ID.dev,
                       created_at: T0, updated_at: T0, synced_at: s ? T0 : null, deleted_at: null });
  const lote = (id, codigo, s) => ({ id, codigo, fecha: T0, peso_inicial_kg: 0.41, tiempo_secado_horas: null,
    peso_final_kg: null, qc_color_dorado: null, qc_prueba_crujiente: '', qc_aprobado: null, qc_foto_key: null,
    bandejas_metalicas_usadas: 1, empacado_at: null, fecha_vencimiento: null, despachado_at: null,
    rechazado_at: null, rechazo_motivo: null, notas: null, estado: 'secando', ...prov(s) });
  const q = (seq, f) => ({ id: u(), seq, table: null, rpc: null, depends_on: [], blob_ids: [], created_at: T0,
    created_by: null, dispositivo_id: ID.dev, attempts: 0, next_attempt_at: 0, status: 'pending', last_error: null, ...f });
  const LOCAL = lote(ID.local, 'CO-2009-L', false);
  const rows = {
    insectario: [{ id: ID.ins, codigo: 'ICA-0109', nombre_insectario: 'ICA', fecha_inicio: '2026-09-01', ...prov(true) }],
    recoleccion: [{ id: ID.rec, insectario_id: ID.ins, recolecta: '1', fecha: T0, ...prov(true) }],
    bandeja: [
      { id: ID.b1, recoleccion_id: ID.rec, no_bandeja: 1, id_bandeja: '2009.1.1', fecha: T0, estado: 'cosechada', ...prov(true) },
      { id: ID.b2, recoleccion_id: ID.rec, no_bandeja: 2, id_bandeja: '2009.1.2', fecha: T0, estado: 'cosechada', ...prov(true) }],
    separacion: [
      { id: ID.s1, bandeja_id: ID.b1, fecha: T0, larva_limpia_g: 410, ...prov(true) },
      { id: ID.s2, bandeja_id: ID.b2, fecha: T0, larva_limpia_g: 395, ...prov(true) }],
    cochada: [lote(ID.synced, 'CO-2009-S', true), LOCAL],
    cochada_separacion: [
      { cochada_id: ID.synced, separacion_id: ID.s1, created_at: T0, updated_at: T0, synced_at: T0 },
      { cochada_id: ID.local, separacion_id: ID.s2, created_at: T0, updated_at: T0 }],
    bandeja_cache: [
      { bandeja_id: ID.b1, cochada_id: ID.synced, last_evento_tipo: 'separacion', last_evento_fecha: T0 },
      { bandeja_id: ID.b2, cochada_id: ID.local, last_evento_tipo: 'separacion', last_evento_fecha: T0 }],
    outbox: [
      q(1, { op: 'rpc', rpc: 'crear_cochada', row_id: ID.local, payload: { p_cochada: LOCAL, p_separacion_ids: [ID.s2] }, depends_on: [ID.s2] }),
      q(2, { op: 'cas', rpc: 'actualizar_qc_cochada', row_id: ID.local, payload: { p_id: ID.local, p_tiempo: 14, p_peso_final: 0.11,
             p_color: 'Muy Crujiente', p_prueba: 'quiebre limpio', p_aprobado: true, p_foto_key: null, p_por: 'Maria' } }),
      q(3, { op: 'cas', rpc: 'rechazar_cochada', row_id: ID.synced, payload: { p_id: ID.synced, p_motivo: 'humedad', p_por: 'Ricardo' } })],
    conflicts: [{ id: 'conf-1', table: 'cochada', rpc: null, row_id: ID.local, _resuelto: 0, created_at: T0, payload: { id: ID.local } }],
    meta: [{ key: 'pull_cursor:cochada', value: T0 }, { key: 'operador_actual', value: 'Maria' }]
  };
  await new Promise((res, rej) => {
    const r = indexedDB.open('tryento', 1);
    r.onupgradeneeded = () => fx.MIGRATIONS[0](r.result, r.transaction);
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction(Object.keys(rows), 'readwrite');
      for (const [s, list] of Object.entries(rows)) for (const row of list) tx.objectStore(s).put(row);
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  localStorage.setItem('tryento.operator', 'Maria');
  return ID;
})()`;

const SEED_BROKEN = `(async () => {
  await new Promise((res, rej) => {
    const r = indexedDB.open('tryento', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('cochada', { keyPath: 'id' });
      r.result.createObjectStore('cochada_separacion', { keyPath: ['cochada_id', 'separacion_id'] });
    };
    r.onsuccess = () => {
      const db = r.result;
      const tx = db.transaction('cochada', 'readwrite');
      tx.objectStore('cochada').put({ id: crypto.randomUUID(), codigo: 'CO-SOLO-AQUI' });
      tx.oncomplete = () => { db.close(); res(); };
      tx.onerror = () => rej(tx.error);
    };
    r.onerror = () => rej(r.error);
  });
  localStorage.setItem('tryento.operator', 'Maria');
  return true;
})()`;

/** Read the database straight from IndexedDB, not through the app. */
const DUMP = `(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('tryento'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const all = s => new Promise((res, rej) => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const names = [...db.objectStoreNames];
  const out = { version: db.version, stores: names };
  for (const s of ['cochada', 'lote', 'lote_separacion', 'outbox', 'conflicts', 'bandeja_cache', 'meta']) {
    if (names.includes(s)) out[s] = await all(s);
  }
  db.close();
  return out;
})()`;

/* ── scenario 1: pre-rename phone ─────────────────────────────────────────── */

console.log('\nEscenario 1 — teléfono con la base de ANTES del renombrado');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    const ID = await b.evaluate(SEED_PRE_RENAME);
    ok('base v1 creada con el código que se publicó (cochada)');

    await b.navigate(`${ORIGIN}/index.html`);
    const booted = await waitFor(b, `(async () => {
      const api = window.__BSF_DATA_CLIENT__; if (!api) return null;
      try { await api.ready(); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
    check(booted === 'ok', 'la app arranca sobre la base vieja', booted || 'no respondió');

    const d = await b.evaluate(DUMP);
    check(d.version === 2, 'versión local', 'v' + d.version);
    check(!d.stores.includes('cochada') && !d.stores.includes('cochada_separacion'), 'almacenes viejos retirados');
    const codes = (d.lote || []).map(l => l.codigo).sort().join(', ');
    check(codes === 'CO-2009-L, CO-2009-S', 'los dos lotes siguen en el teléfono', codes);
    const local = (d.lote || []).find(l => l.id === ID.local);
    check(local && local.synced_at === null, 'el lote no sincronizado sigue marcado como pendiente');
    check((d.lote_separacion || []).length === 2 && d.lote_separacion.every(l => l.lote_id && !('cochada_id' in l)),
      'bandejas del lote conservadas, columna renombrada');
    const rpcs = (d.outbox || []).sort((a, b) => a.seq - b.seq).map(i => i.rpc).join(' > ');
    check(rpcs === 'crear_lote > actualizar_qc_lote > rechazar_lote', 'cola de envío con los nombres nuevos, mismo orden', rpcs);
    const crear = (d.outbox || []).find(i => i.rpc === 'crear_lote');
    check(crear && crear.payload.p_lote && !('p_cochada' in crear.payload), 'argumento p_cochada -> p_lote');
    check((d.conflicts || [])[0]?.table === 'lote', 'conflicto apunta a la tabla nueva');
    check((d.bandeja_cache || []).every(c => !('cochada_id' in c)), 'resumen por bandeja renombrado');
    check(!(d.meta || []).some(m => m.key === 'pull_cursor:cochada'), 'cursor viejo borrado');

    // Through the app, then on screen.
    const lotes = await b.evaluate(`window.__BSF_DATA_CLIENT__.listLotes({}).then(r => r.ok ? r.data.map(l => l.codigo + ':' + l.n_bandejas).sort().join(', ') : 'ERR ' + r.error.message)`);
    check(lotes === 'CO-2009-L:1, CO-2009-S:1', 'listLotes los devuelve', lotes);

    const home = await waitFor(b, `document.body.innerText.includes('bandejas activas') && document.body.innerText`);
    check(home && !home.includes('No se pudieron abrir'), 'pantalla de inicio carga, sin error');
    await b.evaluate(`(() => { const el = [...document.querySelectorAll('button, [role=button], div, span')].reverse().find(e => e.children.length === 0 && /^\\s*Lotes\\s*$/.test(e.textContent)); if (el) el.click(); return !!el; })()`);
    const shown = await waitFor(b, `(t => t.includes('CO-2009-L') && t.includes('CO-2009-S') && t)(document.body.innerText)`, 5000);
    check(Boolean(shown), 'los dos lotes aparecen en la pestaña Lotes');

    const errs = b.logs.filter(l => !/service worker|sin conexión|backend/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 1', e.message);
  } finally {
    await b.close();
  }
}

/* ── scenario 2: upgrade cannot finish ────────────────────────────────────── */

console.log('\nEscenario 2 — la actualización no puede terminar');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/__setup.html`);
    await b.evaluate(SEED_BROKEN);
    await b.navigate(`${ORIGIN}/index.html`);
    const text = await waitFor(b, `(t => t.includes('No se pudieron abrir') && t)(document.body.innerText)`);
    check(Boolean(text), 'aparece el aviso "No se pudieron abrir los datos de este teléfono"');
    check(Boolean(text) && text.includes('Reintentar'), 'con botón Reintentar');

    const d = await b.evaluate(DUMP);
    check(d.version === 1, 'la base NO avanzó de versión', 'v' + d.version);
    check((d.cochada || []).some(c => c.codigo === 'CO-SOLO-AQUI'), 'el dato viejo sigue intacto');
  } catch (e) {
    bad('escenario 2', e.message);
  } finally {
    await b.close();
  }
}

server.close();
console.log(`\n${pass} ok, ${fail} con problemas.`);
process.exitCode = fail ? 1 : 0;
