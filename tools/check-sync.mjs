/**
 * check-sync.mjs — does the APP actually move data to the database?
 *
 *   npm run check:sync
 *
 * check-backend.mjs proves the DATABASE works, using plain supabase-js calls.
 * This proves the APP works, by running its real data layer — the outbox, the
 * push, the pull, the RPC payload shapes — against the live project. A bug in
 * toWire(), in an RPC argument name, or in the pull cursor would sail past
 * check-backend and still mean nothing ever reaches the server.
 *
 * It records a whole cycle the way a phone does (offline, queued), syncs it,
 * verifies it arrived, then WIPES the local database and pulls from scratch to
 * prove a second phone sees the same. Everything it creates is registered as
 * "check-sync" and marked deleted at the end (tools/qa.mjs).
 *
 * The test suite runs `probar` against a local Postgres too.
 */
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, marcarQa } from './qa.mjs';

const POR = 'check-sync';

/**
 * @param api      the data client (dataClient.js)
 * @param sync     () => one forced sync pass
 * @param borrarLocal  () => wipe this phone's database
 * @param db       a client to look at the server directly
 * @param t        { ok(label, extra), bad(label, why, fix) }
 */
export async function probar({ api, sync, borrarLocal, db, t }) {
  const ok = (r, que) => { if (!r || !r.ok) throw new Error(`${que}: ${r?.error?.message || 'sin respuesta'}`); return r.data; };
  const sello = Date.now().toString(36).toUpperCase();
  const S = {};

  await api.ready();
  t.ok('la app arrancó', 'base local lista');
  // Who registers, without adding the name to the shared list.
  ok(await api.setOperator(POR), 'nombre');

  /* ── a whole cycle, offline, exactly as a phone records it ── */
  try {
    S.rack = ok(await api.registrarRack({ codigo: 'ZZTEST-R' + sello }), 'rack').id;
    S.cont = ok(await api.registrarContenedor({ codigo: 'ZZTEST-S' + sello }), 'contenedor').id;
    for (let i = 0; i < 4 && !S.jaula; i++) {
      const r = await api.registrarJaula({ nombre: 'ZZTEST-' + sello, letra: 'Z' + String(Math.floor(Math.random() * 100)).padStart(2, '0'),
                                           lugar: 'prueba', generacion: 7, fase: 'activa' });
      if (r.ok) S.jaula = r.data.id;
    }
    if (!S.jaula) throw new Error('jaula: no se pudo registrar');
    S.rec = ok(await api.registrarRecepcion({ material: 'Otro', kg: 10 }), 'recepción').id;
    S.ens = ok(await api.crearEnsilado({ contenedor_id: S.cont, insumos: [{ recepcion_id: S.rec, kg: 10 }] }), 'ensilado').ensilado.id;
    const inc = ok(await api.registrarRecolecta({ jaula_id: S.jaula, rack_id: S.rack, peso_inicial_g: '12,5', alimento_inicial_kg: 2 }), 'recolecta');
    S.inc = inc.id;
    ok(await api.registrarChequeos({ objeto: 'incubadora', dia: 3, items: [{ id: S.inc, humedad_pct: 68, temperatura_c: 29, peso: 40 }] }), 'chequeo día 3');
    const d = ok(await api.distribuir({ incubadora_id: S.inc, peso_total_kg: 1, cajas: [{ peso_inicial_kg: 1, rack_id: S.rack }] }), 'distribución');
    S.caja = d.cajas[0].id;
    ok(await api.registrarChequeos({ objeto: 'caja', dia: 10, items: [{ id: S.caja, humedad_pct: 60, temperatura_c: 31, peso: 2 }] }), 'chequeo día 10');
    ok(await api.registrarCargas({ carga: 2, items: [{ caja_id: S.caja }] }), 'carga 2');
    S.sep = ok(await api.registrarSeparaciones({ items: [{ caja_id: S.caja, peso_total_kg: 10 }] }), 'separación')[0].id;
    S.co = ok(await api.crearCochada({ peso_inicial_kg: 9.8, origenes: [{ separacion_id: S.sep, kg: 9.8 }] }), 'cochada').cochada.id;
    ok(await api.registrarLectura({ cochada_id: S.co, momento: 'final', temperatura_c: 105, peso_kg: 3 }), 'lectura final');
    ok(await api.registrarEventoJaula({ jaula_id: S.jaula, tipo: 'cierre' }), 'cierre');
    await new Promise(r => setTimeout(r, 20));
    ok(await api.registrarEventoJaula({ jaula_id: S.jaula, tipo: 'limpieza' }), 'limpieza');
    await new Promise(r => setTimeout(r, 20));
    S.ing = ok(await api.registrarIngreso({ jaula_id: S.jaula, kg_larvas: 0.2, bandejas: [{ peso_kg: 4.7, rack_id: S.rack }] }), 'ingreso').ingreso.id;
    await new Promise(r => setTimeout(r, 20));
    ok(await api.editarRegistro({ tabla: 'separacion', id: S.sep, cambios: { peso_total_kg: '12' } }), 'corrección');
    ok(await api.marcarRevisado({ tabla: 'ingreso', id: S.ing }), 'revisado');
    t.ok('captura sin conexión', 'un ciclo completo en la cola');
  } catch (e) {
    t.bad('captura sin conexión', e.message);
    return S;
  }

  /* ── to the server ── */
  await sync();
  const est = await api.getSyncStatus();
  if (est.pending === 0 && est.conflicts === 0) t.ok('todo enviado', 'cola vacía, sin conflictos');
  else {
    const conf = (await api.listConflicts({})).data || [];
    t.bad('todo enviado', `${est.pending} pendientes, ${est.conflicts} conflictos: ${conf.map(c => c.explanation).join(' | ')}`,
          'Si dice que no encuentra una función: falta correr 0010_ciclo_nuevo.sql.');
  }

  const fila = async (tabla, id, cols) => (await db.from(tabla).select(cols).eq('id', id)).data?.[0] || null;
  const inc = await fila('incubadora', S.inc, 'estado, registrado_por');
  const sep = await fila('separacion', S.sep, 'coccion_kg, valores_editados_at');
  const jaula = await fila('jaula', S.jaula, 'fase, generacion');
  const co = await fila('cochada', S.co, 'estado');
  if (inc?.estado === 'inactivo' && inc?.registrado_por === POR) t.ok('en el servidor: la incubadora distribuida, con su autor');
  else t.bad('en el servidor: la incubadora', JSON.stringify(inc));
  if (sep && Number(sep.coccion_kg) === 11.76 && sep.valores_editados_at) t.ok('en el servidor: la corrección recalculó el 98 %', '11,76 kg');
  else t.bad('en el servidor: la corrección', JSON.stringify(sep));
  if (jaula?.fase === 'activa' && jaula?.generacion === 8) t.ok('en el servidor: la jaula repoblada, F8');
  else t.bad('en el servidor: la jaula', JSON.stringify(jaula));
  if (co?.estado === 'inactivo') t.ok('en el servidor: la cochada salió del horno');
  else t.bad('en el servidor: la cochada', JSON.stringify(co));

  /* ── a second phone: nothing local, everything from the server ── */
  await borrarLocal();
  await api.ready();
  await sync();
  const larvas = (await api.listCajas({ inactivas: true })).data || [];
  const jaulas = (await api.listJaulas()).data?.jaulas || [];
  if (larvas.some(c => c.id === S.caja) && jaulas.some(j => j.id === S.jaula && j.generacion === 8 && j.fase === 'activa')) {
    t.ok('otro teléfono lo ve igual', 'desde cero, con la jaula en F8');
  } else t.bad('otro teléfono lo ve igual', `cajas ${larvas.length}, jaulas ${jaulas.map(j => j.nombre + ':' + j.fase).join(',')}`);
  return S;
}

/* ── command line ────────────────────────────────────────────────────────── */

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pass = 0, fail = 0;
  const t = {
    ok: (l, x) => { pass++; console.log('  ok    ' + l + (x ? '   ' + x : '')); },
    bad: (l, why, fix) => { fail++; console.log('  FAIL  ' + l); console.log('        ' + why); if (fix) console.log('        -> ' + fix); }
  };

  // Stand in for a browser: only what the data layer touches.
  await import('fake-indexeddb/auto');
  const { createClient } = await import('@supabase/supabase-js');
  const cfgSrc = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
  const store = new Map();
  globalThis.window = globalThis;
  globalThis.addEventListener = () => {};
  globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' };
  // Node 24 defines `navigator` as a getter-only global: redefine, not assign.
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { onLine: true, storage: { persist: async () => true, persisted: async () => true,
                                      estimate: async () => ({ usage: 0, quota: 1e9 }) } }
  });
  globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null),
                              setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  new Function('window', cfgSrc)(globalThis);
  globalThis.supabase = { createClient };

  const cfg = globalThis.__TRYENTO_CONFIG__ || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    t.bad('configuración', 'app-config.js no tiene supabaseUrl / supabaseAnonKey.', 'Sin esto la app corre en modo local y nunca sincroniza.');
  } else {
    t.ok('configuración', cfg.supabaseUrl);
    const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      db: { schema: cfg.dbSchema || 'app' }, auth: { persistSession: false, autoRefreshToken: false }
    });
    const api = (await import('../dataClient.js')).default;
    const { syncNow, stopSync } = await import('../src/data/sync/loop.js');
    const { __closeDb } = await import('../src/data/idb/open.js');
    const { DB_NAME } = await import('../src/data/idb/schema.js');
    const { invalidarSnapshot } = await import('../src/data/snapshot.js');
    const borrarLocal = async () => {
      stopSync();
      __closeDb();
      await new Promise(r => { const q = indexedDB.deleteDatabase(DB_NAME); q.onsuccess = q.onerror = q.onblocked = () => r(); });
      invalidarSnapshot();
    };
    try {
      await probar({ api, sync: () => syncNow({ force: true }), borrarLocal, db, t });
    } catch (e) {
      t.bad('error inesperado', e.message);
    } finally {
      const quedan = await marcarQa(db, [POR]).catch(() => -1);
      if (quedan === 0) t.ok('limpieza', 'filas de prueba marcadas como borradas');
      else t.bad('limpieza', 'quedaron filas de prueba', 'Corre: node tools/cleanup-qa.mjs --delete');
      stopSync();
    }
  }
  console.log('\n' + pass + ' ok, ' + fail + ' con problemas.');
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
