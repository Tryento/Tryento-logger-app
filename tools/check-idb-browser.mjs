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
 *   3. the v2 protocol screens, driven like a person would: feed carga 2 from
 *      the plan, register a recolecta, distribute its incubadora — then read
 *      IndexedDB to confirm what was stored
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
const { DB_VERSION } = await import('../src/data/idb/schema.js');
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
    await new Promise(r => setTimeout(r, 250));
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
    check(d.version === DB_VERSION, 'versión local', 'v' + d.version + ' (esperada v' + DB_VERSION + ')');
    check(d.stores.includes('incubadora') && d.stores.includes('parametro'), 'almacenes del protocolo v2 creados');
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

/* ── scenario 3: the v2 screens ───────────────────────────────────────────── */

/** Click the first visible button whose text starts with `label`. */
const click = label => `(() => {
  const el = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && b.textContent.trim().startsWith(${JSON.stringify(label)}));
  if (el) el.click();
  return !!el;
})()`;
/** Type into the n-th visible input matching `selector`, the way React sees it. */
const type = (selector, value, n = 0) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.offsetParent !== null);
  const el = els[${n}];
  if (!el) return false;
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;
const bodyHas = text => `document.body.innerText.includes(${JSON.stringify(text)}) && document.body.innerText`;

console.log('\nEscenario 3 — pantallas del protocolo nuevo');
{
  const b = await launch();
  try {
    await b.navigate(`${ORIGIN}/index.html`);
    const api = `window.__BSF_DATA_CLIENT__`;
    const booted = await waitFor(b, `(async () => { const a = ${api}; if (!a) return null; await a.ready(); return 'ok'; })()`);
    check(booted === 'ok', 'la app arranca en una base nueva', booted || 'no respondió');

    // Name screen: a person taps their name.
    check(Boolean(await waitFor(b, bodyHas('Maria'))), 'pantalla de nombre');
    await b.evaluate(click('Maria'));

    // A colony and an incubadora distributed 10 days ago (día 10: toca carga 2).
    const setup = await b.evaluate(`(async () => {
      const a = ${api};
      const ins = await a.createInsectario({ nombre_insectario: 'ICA', fecha_inicio: a.fechas.addDays(a.fechas.farmDay(), -30), generacion_moscas: 'F7' });
      const rec = await a.createRecoleccionV2({ insectario_id: ins.data.id, peso_ovipositores_g: 350, atrayente_cambiado: true,
                                                fecha_inicio: a.fechas.addDays(a.fechas.farmDay(), -10) });
      const dis = await a.distribuirIncubadora(rec.data.incubadora.id, { n_bandejas: 3 });
      return { ok: ins.ok && rec.ok && dis.ok, codigo: rec.data.incubadora.codigo, trays: dis.data.bandejas.map(x => x.id) };
    })()`);
    check(setup.ok && setup.codigo === 'F7AR1', 'preparación: insectario, recolecta v2, 3 bandejas', setup.codigo);

    // Reload, so the screens start from what is stored — like opening the app.
    await b.navigate(`${ORIGIN}/index.html`);
    const home = await waitFor(b, bodyHas('para hoy'));
    check(Boolean(home), 'inicio avisa lo que toca hoy', home ? (home.match(/\d+ para hoy/) || [''])[0] : '');
    await b.shot('1-inicio');

    // Alimentar: carga 2 is suggested and the three trays come preselected.
    check(await b.evaluate(click('Alimentar')), 'botón Alimentar');
    const cargas = await waitFor(b, bodyHas('Dar carga 2 a 3 bandejas'));
    check(Boolean(cargas), 'Alimentar propone la carga 2 con las 3 bandejas del día 10',
          cargas ? (cargas.match(/Dar carga[^\n]*/) || [''])[0] : '');
    await b.shot('2-alimentar');
    check(await b.evaluate(click('Tamizado de control')), 'casilla de tamizado en la carga 2');
    check(await b.evaluate(click('Dar carga 2')), 'confirmar con un toque');
    check(Boolean(await waitFor(b, bodyHas('Carga 2 registrada'))), 'aviso "Carga 2 registrada"');
    const feeds = await b.evaluate(`(async () => {
      const a = ${api}; const ids = ${JSON.stringify(setup.trays)};
      const out = [];
      for (const id of ids) { const d = await a.getBandejaDetail(id); out.push(d.data.eventos.filter(e => e.tipo === 'alimentacion').map(e => e.carga + ':' + e.cantidad_kg + ':' + e.tamizado).sort().join(',')); }
      return out;
    })()`);
    check(feeds.every(f => f === '1:1.5:false,2:2:true'), 'guardado: carga 1 (1,5 kg) y carga 2 (2 kg, tamizado) en cada bandeja', feeds.join(' | '));

    // Nueva recolecta through the form, then distribute its incubadora.
    await b.navigate(`${ORIGIN}/index.html`);
    await waitFor(b, bodyHas('Nueva recolecta'));
    check(await b.evaluate(click('Nueva recolecta')), 'botón Nueva recolecta');
    await waitFor(b, bodyHas('PESO DE LOS OVIPOSITORES'));
    await b.evaluate(click('ICA-'));
    check(await b.evaluate(type('input[inputmode=decimal]', '410', 0)), 'escribir el peso de los ovipositores');
    const bloqueado = await waitFor(b, bodyHas('Confirma el cambio de atrayente'), 3000);
    check(Boolean(bloqueado), 'sin confirmar el atrayente no deja guardar');
    await b.shot('3-nueva-recolecta');
    await b.evaluate(click('Se cambió el atrayente'));
    const preview = await waitFor(b, bodyHas('F7AR2'), 3000);
    check(Boolean(preview), 'muestra el código de la incubadora que va a crear', 'F7AR2');
    check(await b.evaluate(click('Guardar y crear incubadora')), 'guardar la recolecta');
    check(Boolean(await waitFor(b, bodyHas('DISTRIBUIR EN BANDEJAS'))), 'abre la incubadora nueva, lista para distribuir');
    check(await b.evaluate(type('input[inputmode=numeric]', '2', 0)), 'escribir el número de bandejas');
    check(Boolean(await waitFor(b, bodyHas('Distribuir en 2 bandejas'), 3000)), 'el botón dice cuántas');
    await b.shot('4-distribuir');
    await b.evaluate(click('Distribuir en 2 bandejas'));
    // The list header, not the codes: the "saved" toast also names the trays.
    const dist = await waitFor(b, bodyHas('BANDEJAS · 2'));
    check(Boolean(dist) && dist.includes('F7AR2-01') && dist.includes('F7AR2-02'), 'bandejas F7AR2-01 y F7AR2-02 en la incubadora');
    await b.shot('5-incubadora');

    // A v2 tray: día del ciclo, its loads, and the protocol's next step.
    check(await b.evaluate(click('F7AR2-01')), 'abrir la bandeja F7AR2-01');
    // "EN BANDEJA DESDE" exists only on the tray page (the incubadora page also
    // says "DÍA DEL CICLO").
    const tray = await waitFor(b, bodyHas('EN BANDEJA DESDE'));
    check(Boolean(tray) && tray.includes('DÍA DEL CICLO') && tray.includes('Carga 2 · 2 kg'),
          'la bandeja muestra el día del ciclo y la siguiente carga');
    check(Boolean(tray) && !tray.includes('Iniciar ayuno'), 'en el día 0 no ofrece ayuno ni cosecha');
    await b.shot('6-bandeja');
    // An off-plan harvest goes through the home screen's Cosecha tile.
    await b.navigate(`${ORIGIN}/index.html`);
    await waitFor(b, bodyHas('Cosecha'));
    await b.evaluate(click('Cosecha'));
    await waitFor(b, bodyHas('TIPO DE EVENTO'));
    await b.evaluate(click('F7AR2-01'));
    const cosecha = await waitFor(b, bodyHas('PARA EL LABORATORIO'));
    check(Boolean(cosecha) && cosecha.includes('LARVA PARA HORNEADO'), 'cosecha pide horno y laboratorio por separado');
    await b.evaluate(type('input[inputmode=decimal]', '4900', 0));
    await b.evaluate(type('input[inputmode=decimal]', '100', 1));
    check(Boolean(await waitFor(b, bodyHas('Es el 2 % de la cosecha'), 3000)), 'calcula el % para el laboratorio');
    await b.shot('7-cosecha');

    const d = await b.evaluate(`(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('tryento'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      const all = s => new Promise(res => { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
      const [incs, trays, feeds, outbox, recs] = await Promise.all([all('incubadora'), all('bandeja'), all('alimentacion'), all('outbox'), all('recoleccion')]);
      db.close();
      const inc2 = incs.find(i => i.codigo === 'F7AR2');
      const rec2 = recs.find(r => r.id === (inc2 && inc2.recoleccion_id));
      return {
        inc2: inc2 ? { estado: inc2.estado, por: inc2.distribuida_por } : null,
        rec2: rec2 ? { peso: rec2.peso_ovipositores_g, atr: rec2.atrayente_cambiado, por: rec2.registrado_por } : null,
        trays2: trays.filter(t => inc2 && t.incubadora_id === inc2.id).map(t => t.id_bandeja).sort(),
        carga1: feeds.filter(f => f.carga === 1).length,
        rpcs: outbox.map(i => i.rpc || i.table)
      };
    })()`);
    check(d.rec2 && d.rec2.peso === 410 && d.rec2.atr === true && d.rec2.por === 'Maria', 'IndexedDB: recolecta con peso, atrayente y quién', JSON.stringify(d.rec2));
    check(d.inc2 && d.inc2.estado === 'distribuida' && d.inc2.por === 'Maria', 'IndexedDB: incubadora distribuida, con quién', JSON.stringify(d.inc2));
    check(d.trays2.join(',') === 'F7AR2-01,F7AR2-02', 'IndexedDB: las 2 bandejas nuevas', d.trays2.join(','));
    check(d.carga1 === 5, 'IndexedDB: carga 1 de las 5 bandejas', String(d.carga1));
    check(d.rpcs.filter(r => r === 'distribuir_incubadora').length === 2 && d.rpcs.includes('crear_recoleccion_v2'),
          'cola de envío con las operaciones v2', d.rpcs.join(', '));

    const errs = b.logs.filter(l => !/service worker|sin conexión|backend/i.test(l));
    check(errs.length === 0, 'sin errores en la consola', errs.slice(0, 3).join(' | '));
  } catch (e) {
    bad('escenario 3', e.message);
  } finally {
    await b.close();
  }
}

server.close();
console.log(`\n${pass} ok, ${fail} con problemas.`);
process.exitCode = fail ? 1 : 0;
