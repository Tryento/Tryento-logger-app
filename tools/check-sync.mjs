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
 * It captures records the way a phone does (offline, queued), syncs them,
 * verifies they arrived, then WIPES the local database and pulls from scratch
 * to prove a second device sees the same data. Everything it creates is
 * deleted at the end.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import 'fake-indexeddb/auto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const ok = (l, x) => { pass++; console.log('  ok    ' + l + (x ? '   ' + x : '')); };
const bad = (l, why, fix) => {
  fail++;
  console.log('  FAIL  ' + l);
  console.log('        ' + why);
  if (fix) console.log('        -> ' + fix);
};

/* Stand in for a browser: only what the data layer touches. Anything that
 * needs more than this belongs in the UI, not in the data layer. */
const cfgSrc = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
const store = new Map();
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener: () => {}, visibilityState: 'visible' };
// Node 24 defines `navigator` as a getter-only global, so it has to be
// redefined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    onLine: true,
    storage: {
      persist: async () => true,
      persisted: async () => true,
      estimate: async () => ({ usage: 0, quota: 1e9 })
    }
  }
});
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k)
};
new Function('window', cfgSrc)(globalThis);
globalThis.supabase = { createClient };

const cfg = globalThis.__TRYENTO_CONFIG__ || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  bad('configuracion', 'app-config.js no tiene supabaseUrl / supabaseAnonKey.',
      'Sin esto la app corre en modo local y nunca sincroniza.');
  console.log('\n' + pass + ' ok, ' + fail + ' con problemas.');
  process.exit(1);
}
ok('configuracion', cfg.supabaseUrl);

/* A separate client, used to check the server independently of the app. */
const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  db: { schema: cfg.dbSchema || 'app' },
  auth: { persistSession: false, autoRefreshToken: false }
});

const api = await import('../dataClient.js');
const { syncNow, stopSync } = await import('../src/data/sync/loop.js');
const { openDb, __closeDb } = await import('../src/data/idb/open.js');
const { outboxStats, listStuck } = await import('../src/data/outbox.js');
const { DB_NAME } = await import('../src/data/idb/schema.js');

const ids = { insectario: [], recoleccion: [], bandeja: [], ayuno: [], separacion: [], cochada: [] };
const OP = 'Maria';

try {
  await api.ready();
  ok('la app arranco', 'base local lista');

  /* ── capture, exactly as a phone does ─────────────────────────────────── */
  const ins = await api.createInsectario({
    nombre_insectario: 'ICB', fecha_inicio: '2026-05-01', generacion_moscas: 'F6',
    biomasa_kg: 3.1, proyeccion_cierre: '2026-05-22', operator_name: OP
  });
  if (!ins.ok) throw new Error('createInsectario: ' + ins.error.message);
  ids.insectario.push(ins.data.id);

  const rec = await api.createRecoleccion({ insectario_id: ins.data.id, huevos_g: 0.62, operator_name: OP });
  if (!rec.ok) throw new Error('createRecoleccion: ' + rec.error.message);
  ids.recoleccion.push(rec.data.id);

  const b1 = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 1, operator_name: OP });
  const b2 = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 2, operator_name: OP });
  if (!b1.ok || !b2.ok) throw new Error('createBandeja failed');
  ids.bandeja.push(b1.data.id, b2.data.id);

  await api.logAlimentacion({ bandeja_id: b1.data.id, tipo_alimento: 'Bagazo', cantidad_kg: 1.3, operator_name: OP });
  const bulk = await api.logAlimentacionGrupal({
    bandeja_ids: [b1.data.id, b2.data.id], tipo_alimento: 'Afrecho', cantidad_kg: 0.9, operator_name: OP
  });
  const ay = await api.logAyuno({ bandeja_id: b1.data.id, peso_inicial_kg: 1.2, operator_name: OP });
  ids.ayuno.push(ay.data.id);
  await api.logAyunoFin(ay.data.id, { peso_final_kg: 1.05 });
  const sep = await api.logSeparacion({ bandeja_id: b1.data.id, larva_limpia_g: 410, operator_name: OP });
  ids.separacion.push(sep.data.id);
  const lote = await api.createLote({ separacion_ids: [sep.data.id], peso_inicial_kg: 0.41, operator_name: OP });
  ids.cochada.push(lote.data.id);
  await api.updateLoteQC(lote.data.id, { peso_final_kg: 0.11, tiempo_secado_horas: 14, qc_aprobado: true });
  await api.marcarEmpacado(lote.data.id, {});
  await api.marcarAtractante(ins.data.id);

  const before = await outboxStats(await openDb());
  ok('captura sin conexion', before.pending + ' operaciones en cola');

  /* ── sync ─────────────────────────────────────────────────────────────── */
  await syncNow({ force: true });
  const after = await outboxStats(await openDb());

  if (after.pending === 0 && after.stuck === 0) {
    ok('cola vaciada', before.pending + ' enviadas, 0 atascadas');
  } else {
    const stuck = await listStuck(await openDb());
    const first = stuck[0];
    bad('cola vaciada',
        'quedan ' + after.pending + ' pendientes y ' + after.stuck + ' atascadas',
        first ? ('primera: ' + (first.table || first.rpc) + ' -- ' +
                 (first.last_error && first.last_error.message)) : null);
  }

  /* ── did it actually land on the server? ──────────────────────────────── */
  const r1 = await db.from('insectario')
    .select('codigo, poblacion_estimada, estado, fecha_ovipositores, registrado_por')
    .eq('id', ins.data.id).single();
  const sIns = r1.data;
  if (sIns && sIns.poblacion_estimada === 155000) ok('insectario en el servidor', sIns.codigo);
  else bad('insectario en el servidor', 'no llego o llego mal: ' + JSON.stringify(sIns || r1.error));
  if (sIns && sIns.registrado_por === OP) ok('nombre guardado como texto', OP);
  else bad('nombre guardado como texto', 'registrado_por = ' + (sIns && sIns.registrado_por));
  if (sIns && sIns.fecha_ovipositores) ok('accion de un toque sincronizada', 'atractante');
  else bad('accion de un toque sincronizada', 'fecha_ovipositores sigue vacia en el servidor');

  const r2 = await db.from('alimentacion')
    .select('id, fecha, tipo_alimento, cantidad_kg, grupal_id')
    .eq('grupal_id', bulk.data.grupal_id);
  const sAlim = r2.data || [];
  if (sAlim.length === 2 && sAlim.every(r => r.fecha && r.tipo_alimento && r.cantidad_kg)) {
    ok('alimentacion grupal', '2 filas completas, ninguna a medias');
  } else {
    bad('alimentacion grupal', 'llegaron ' + sAlim.length + ' filas; alguna incompleta',
        'Es el bug de AppSheet: filas con bandeja pero sin fecha/tipo/cantidad.');
  }

  const r3 = await db.from('bandeja').select('estado, id_bandeja').eq('id', b1.data.id).single();
  if (r3.data && r3.data.estado === 'cosechada') {
    ok('estado calculado por el servidor', r3.data.id_bandeja + ' -> cosechada');
  } else {
    bad('estado calculado por el servidor', 'estado = ' + (r3.data && r3.data.estado));
  }

  const r4 = await db.from('ayuno').select('peso_final_kg, merma_pct').eq('id', ay.data.id).single();
  if (r4.data && r4.data.merma_pct !== null && Math.abs(r4.data.merma_pct - 12.5) < 0.01) {
    ok('cierre de ayuno', 'merma ' + r4.data.merma_pct + '%');
  } else {
    bad('cierre de ayuno', 'merma_pct = ' + (r4.data && r4.data.merma_pct));
  }

  const r5 = await db.from('cochada').select('estado, rendimiento_pct').eq('id', lote.data.id).single();
  if (r5.data && r5.data.estado === 'empacado') {
    ok('ciclo de cochada', 'empacado, rendimiento ' + r5.data.rendimiento_pct + '%');
  } else {
    bad('ciclo de cochada', 'estado = ' + (r5.data && r5.data.estado));
  }

  const r6 = await db.from('cochada_separacion').select('separacion_id').eq('cochada_id', lote.data.id);
  if (r6.data && r6.data.length === 1) ok('cochada vinculada a su separacion', 'nunca apunta a nada');
  else bad('cochada vinculada a su separacion', ((r6.data && r6.data.length) || 0) + ' vinculos');

  /* ── a second device: wipe everything local and pull from scratch ─────── */
  // Settle first. Every write called nudge(), so a background pass may still be
  // touching the database; wiping it underneath one throws InvalidStateError.
  // A forced sync now waits for any in-flight pass before returning.
  stopSync();
  await syncNow({ force: true });
  __closeDb();
  await new Promise(r => {
    const q = indexedDB.deleteDatabase(DB_NAME);
    q.onsuccess = q.onerror = q.onblocked = r;
  });
  store.clear();

  const { initialPull, resetCursors } = await import('../src/data/sync/pull.js');
  const db2 = await openDb();
  await resetCursors(db2);
  await initialPull(db2);

  const fresh = await api.listBandejas({});
  const got = fresh.data.find(b => b.id === b1.data.id);
  if (got) ok('un segundo equipo ve los datos', got.id_bandeja + ' -- ' + got.estado);
  else bad('un segundo equipo ve los datos', 'la bandeja no volvio en la descarga',
           'Revisa el cursor de pull o los permisos de lectura.');

  const detail = await api.getBandejaDetail(b1.data.id);
  if (detail.ok && detail.data.eventos.length >= 4) {
    ok('historial completo tras descargar', detail.data.eventos.length + ' eventos');
  } else {
    bad('historial completo tras descargar',
        (detail.ok ? detail.data.eventos.length : 0) + ' eventos, se esperaban 4+');
  }

  const names = await api.listOperators();
  if (names.data.includes(OP)) ok('nombres disponibles tras descargar', names.data.join(', '));
  else bad('nombres disponibles tras descargar', 'lista: ' + (names.data.join(', ') || '(vacia)'));

} catch (e) {
  bad('error inesperado', e.message);
  if (process.env.DEBUG) console.error(e);
} finally {
  /* ── clean up the server ──────────────────────────────────────────────── */
  try {
    if (ids.bandeja.length) await db.from('alimentacion').delete().in('bandeja_id', ids.bandeja);
    for (const t of ['cochada', 'separacion', 'ayuno', 'revision', 'bandeja', 'recoleccion', 'insectario']) {
      if (ids[t] && ids[t].length) await db.from(t).delete().in('id', ids[t]);
    }
    const left = await db.from('insectario').select('id').in('id', ids.insectario);
    if (!left.data || !left.data.length) ok('limpieza', 'no queda nada de prueba en la base');
    else bad('limpieza', left.data.length + ' filas quedaron');
  } catch (e) {
    bad('limpieza', e.message);
  }

  stopSync();
  console.log('\n' + pass + ' ok, ' + fail + ' con problemas.');
  if (fail) {
    console.log('\nLa app NO esta guardando bien en el servidor.');
    process.exitCode = 1;
  } else {
    console.log('\nLa app guarda y recupera correctamente desde Supabase.');
  }
  setTimeout(() => process.exit(process.exitCode || 0), 200);
}
