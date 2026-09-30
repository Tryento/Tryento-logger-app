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

const ids = { insectario: [], recoleccion: [], incubadora: [], bandeja: [], ayuno: [], separacion: [], lote: [],
              ensilaje_lectura: [], ensilaje_insumo: [], ensilaje: [], recepcion_alimento: [] };
const OP = 'Maria';

try {
  await api.ready();
  ok('la app arranco', 'base local lista');

  // The name screen sets this; every write must pick it up from here.
  await api.rememberOperator(OP);

  /* ── capture, exactly as a phone does ─────────────────────────────────── */
  // ZZTEST, never a real colony name: these rows live in production until the
  // cleanup below marks them deleted.
  const ins = await api.createInsectario({
    nombre_insectario: 'ZZTEST', fecha_inicio: '2026-05-01', generacion_moscas: 'F6',
    biomasa_kg: 3.1, proyeccion_cierre: '2026-05-22'   // sin operator_name: a proposito
  });
  if (!ins.ok) throw new Error('createInsectario: ' + ins.error.message);
  ids.insectario.push(ins.data.id);

  const rec = await api.createRecoleccion({ insectario_id: ins.data.id, huevos_g: 0.62 });
  if (!rec.ok) throw new Error('createRecoleccion: ' + rec.error.message);
  ids.recoleccion.push(rec.data.id);

  const b1 = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 1 });
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
  ids.lote.push(lote.data.id);
  await api.updateLoteQC(lote.data.id, { peso_final_kg: 0.11, tiempo_secado_horas: 14, qc_aprobado: true });
  await api.marcarEmpacado(lote.data.id, {});
  await api.marcarAtractante(ins.data.id);

  // Protocolo v2, only if the server has 0007 (otherwise say so plainly).
  const tieneV2 = !(await db.from('parametro').select('clave').limit(1)).error;
  // Alimento, only if it also has 0008.
  const tieneAlimento = !(await db.from('ensilaje').select('id').limit(0)).error;
  let v2 = null;
  let food = null;
  let v2Temps = null;
  if (tieneV2) {
    const r = await api.createRecoleccionV2({ insectario_id: ins.data.id, peso_ovipositores_g: 320,
                                             atrayente_cambiado: true, starter_kg: 2, operator_name: OP });
    if (!r.ok) throw new Error('createRecoleccionV2: ' + r.error.message);
    ids.recoleccion.push(r.data.recoleccion.id);
    ids.incubadora.push(r.data.incubadora.id);
    const d = await api.distribuirIncubadora(r.data.incubadora.id, { n_bandejas: 2, operator_name: OP });
    if (!d.ok) throw new Error('distribuirIncubadora: ' + d.error.message);
    const trays = d.data.bandejas.map(b => b.id);
    ids.bandeja.push(...trays);
    // A reception and a batch put in use BEFORE carga 2, so the load is taken
    // from a batch — all of it still queued, as on a phone with no signal.
    if (tieneAlimento) {
      const rc = await api.createRecepcion({ material: 'ZZTEST material', kg: 25, proveedor: 'check-sync', operator_name: OP });
      if (!rc.ok) throw new Error('createRecepcion: ' + rc.error.message);
      const en = await api.createEnsilaje({ silo: 'ZZTEST', operator_name: OP,
        insumos: [{ material: 'ZZTEST material', kg: 25, recepcion_id: rc.data.id }] });
      if (!en.ok) throw new Error('createEnsilaje: ' + en.error.message);
      const pasos = [await api.avanzarEnsilaje(en.data.id, 'sellado', { operator_name: OP }),
                     await api.logLecturaEnsilaje(en.data.id, { temperatura_c: '30,5', operator_name: OP }),
                     await api.avanzarEnsilaje(en.data.id, 'en_uso', { operator_name: OP })];
      const fallo = pasos.find(p => !p.ok);
      if (fallo) throw new Error('ensilaje: ' + fallo.error.message);
      food = { rec: rc.data.id, ens: en.data.id, lectura: pasos[1].data.id };
      ids.recepcion_alimento.push(rc.data.id);
      ids.ensilaje.push(en.data.id);
      ids.ensilaje_insumo.push(...en.data.insumos.map(i => i.id));
      ids.ensilaje_lectura.push(pasos[1].data.id);
    } else {
      console.log('  --    alimento (0008): todavía no aplicado; se revisa cuando corras 0008_alimento.sql');
    }
    const c2 = await api.logCarga({ bandeja_ids: trays, carga: 2, tamizado: true, operator_name: OP });
    if (!c2.ok) throw new Error('logCarga: ' + c2.error.message);
    // A real batch in use since before this run is older, so the load names it.
    // That is right for the app; the cleanup below takes the load back out.
    if (food) food.cargaEns = c2.data.ensilaje ? c2.data.ensilaje.id : null;
    // Bed temperature (0009), before the fast; typed with a decimal comma.
    if (!(await db.from('v_temperatura_cama').select('id').limit(0)).error) {
      const tc = await api.logTemperaturaCama({ operator_name: OP, lecturas: [
        { bandeja_id: trays[0], temperatura_c: '34,5' }, { bandeja_id: trays[1], temperatura_c: '37' }] });
      if (!tc.ok) throw new Error('logTemperaturaCama: ' + tc.error.message);
      v2Temps = tc.data.rows.map(x => x.id);
    }
    const ay2 = await api.logAyunoGrupal({ bandeja_ids: trays, operator_name: OP });
    if (!ay2.ok) throw new Error('logAyunoGrupal: ' + ay2.error.message);
    ids.ayuno.push(...ay2.data.rows.map(a => a.id));
    const s2 = await api.logSeparacion({ bandeja_id: trays[0], larva_limpia_g: 4900, reserva_cria_g: 100, operator_name: OP });
    if (!s2.ok) throw new Error('logSeparacion v2: ' + s2.error.message);
    ids.separacion.push(s2.data.id);
    v2 = { inc: r.data.incubadora.id, trays, sep: s2.data.id };
  } else {
    bad('protocolo v2', 'el servidor no tiene 0007 todavía', 'Corre supabase/migrations/0007_protocolo_v2.sql en el SQL Editor.');
  }

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

  // QA: every record was landing with registrado_por null while the header
  // showed a name. Check the whole chain, including the rows whose forms never
  // passed one.
  const rAttr = await db.from('bandeja').select('id, registrado_por').in('id', ids.bandeja);
  const rAttr2 = await db.from('recoleccion').select('id, registrado_por').in('id', ids.recoleccion);
  const anon = []
    .concat((rAttr.data || []).filter(r => !r.registrado_por).map(() => 'bandeja'))
    .concat((rAttr2.data || []).filter(r => !r.registrado_por).map(() => 'recoleccion'));
  if (!anon.length) ok('todo queda atribuido', 'insectario, recoleccion y bandejas con nombre');
  else bad('todo queda atribuido', 'sin autor: ' + anon.join(', '),
           'provenance() debe caer de vuelta al operador seleccionado.');

  // QA: atractante and cierre recorded only the date, never who pressed them.
  // That is a different person from whoever created the colony weeks earlier.
  const rAcc = await db.from('insectario')
    .select('fecha_ovipositores_por, cierre_real_por').eq('id', ins.data.id).single();
  if (rAcc.data && rAcc.data.fecha_ovipositores_por === OP) {
    ok('accion de un toque atribuida', 'atractante por ' + rAcc.data.fecha_ovipositores_por);
  } else {
    bad('accion de un toque atribuida',
        'fecha_ovipositores_por = ' + JSON.stringify(rAcc.data || rAcc.error),
        'Corre supabase/migrations/0004_atribucion_acciones.sql.');
  }

  const rQc = await db.from('lote')
    .select('qc_por, empacado_por').eq('id', lote.data.id).single();
  if (rQc.data && rQc.data.qc_por === OP && rQc.data.empacado_por === OP) {
    ok('QC y empacado atribuidos', OP);
  } else {
    bad('QC y empacado atribuidos', JSON.stringify(rQc.data || rQc.error));
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

  const r5 = await db.from('lote').select('estado, rendimiento_pct').eq('id', lote.data.id).single();
  if (r5.data && r5.data.estado === 'empacado') {
    ok('ciclo de lote', 'empacado, rendimiento ' + r5.data.rendimiento_pct + '%');
  } else {
    bad('ciclo de lote', 'estado = ' + (r5.data && r5.data.estado));
  }

  const r6 = await db.from('lote_separacion').select('separacion_id').eq('lote_id', lote.data.id);
  if (r6.data && r6.data.length === 1) ok('lote vinculada a su separacion', 'nunca apunta a nada');
  else bad('lote vinculada a su separacion', ((r6.data && r6.data.length) || 0) + ' vinculos');

  if (v2) {
    const inc = (await db.from('incubadora').select('estado, distribuida_por').eq('id', v2.inc).single()).data;
    const trays = (await db.from('bandeja').select('id, protocolo').in('id', v2.trays)).data || [];
    const feeds = (await db.from('alimentacion').select('carga, protocolo, tamizado').in('bandeja_id', v2.trays)).data || [];
    const fasts = (await db.from('ayuno').select('protocolo, cerrado_at, cerrado_por').in('bandeja_id', v2.trays)).data || [];
    const sep = (await db.from('separacion').select('protocolo, reserva_cria_g').eq('id', v2.sep).single()).data;
    if (inc && inc.estado === 'distribuida' && inc.distribuida_por === OP) ok('protocolo v2: incubadora distribuida', 'por ' + OP);
    else bad('protocolo v2: incubadora distribuida', JSON.stringify(inc));
    if (trays.length === 2 && trays.every(t => t.protocolo === 'v2')) ok('protocolo v2: bandejas', '2 bandejas v2');
    else bad('protocolo v2: bandejas', JSON.stringify(trays));
    const c1 = feeds.filter(f => f.carga === 1).length, c2n = feeds.filter(f => f.carga === 2 && f.tamizado).length;
    if (c1 === 2 && c2n === 2 && feeds.every(f => f.protocolo === 'v2')) ok('protocolo v2: cargas 1 y 2', '4 filas, tamizado en la 2');
    else bad('protocolo v2: cargas 1 y 2', JSON.stringify(feeds));
    const cerrado = fasts.find(a => a.cerrado_at);
    if (fasts.length === 2 && cerrado && cerrado.cerrado_por === OP) ok('protocolo v2: la cosecha cierra el ayuno', 'sin pesar, atribuido');
    else bad('protocolo v2: la cosecha cierra el ayuno', JSON.stringify(fasts));
    if (sep && sep.protocolo === 'v2' && Number(sep.reserva_cria_g) === 100) ok('protocolo v2: 2 % al laboratorio', '100 g');
    else bad('protocolo v2: 2 % al laboratorio', JSON.stringify(sep));
  }

  if (v2Temps) {
    const t = (await db.from('v_temperatura_cama').select('temperatura_c, sobre_maximo').in('id', v2Temps)).data || [];
    const got = t.map(x => `${Number(x.temperatura_c)}:${x.sobre_maximo}`).sort().join(',');
    if (got === '34.5:false,37:true') ok('temperatura de cama', '"34,5" y 37 °C; la de 37 marcada sobre el máximo');
    else bad('temperatura de cama', got || JSON.stringify(t));
  } else if (v2) {
    console.log('  --    temperatura de cama (0009): todavía no aplicado; se revisa cuando corras 0009_monitor.sql');
  }

  if (food) {
    const rec = (await db.from('recepcion_alimento').select('kg, registrado_por').eq('id', food.rec).single()).data;
    const ens = (await db.from('ensilaje').select('estado, sellado_por, en_uso_por, listo_at').eq('id', food.ens).single()).data;
    const insu = (await db.from('ensilaje_insumo').select('kg, recepcion_id').eq('ensilaje_id', food.ens)).data || [];
    const lec = (await db.from('ensilaje_lectura').select('temperatura_c, registrado_por').eq('id', food.lectura).single()).data;
    const c2s = (await db.from('alimentacion').select('ensilaje_id').in('bandeja_id', v2.trays).eq('carga', 2)).data || [];
    if (rec && Number(rec.kg) === 25 && rec.registrado_por === OP) ok('alimento: recepción', '25 kg, por ' + OP);
    else bad('alimento: recepción', JSON.stringify(rec));
    if (ens && ens.estado === 'en_uso' && ens.listo_at && ens.sellado_por === OP && ens.en_uso_por === OP &&
        insu.length === 1 && insu[0].recepcion_id === food.rec) {
      ok('alimento: ensilaje, su material y sus pasos', 'sellado → en uso, atribuidos, en orden');
    } else bad('alimento: ensilaje, su material y sus pasos', JSON.stringify({ ens, insu }));
    if (lec && Number(lec.temperatura_c) === 30.5 && lec.registrado_por === OP) ok('alimento: lectura de temperatura', '"30,5" llegó como 30.5 °C');
    else bad('alimento: lectura de temperatura', JSON.stringify(lec));
    if (food.cargaEns && c2s.length === 2 && c2s.every(f => f.ensilaje_id === food.cargaEns)) {
      ok('alimento: la carga dice de qué ensilaje salió',
         food.cargaEns === food.ens ? 'del ensilaje de prueba' : 'de un ensilaje real en uso (la limpieza la retira)');
    } else bad('alimento: la carga dice de qué ensilaje salió', JSON.stringify({ esperado: food.cargaEns, c2s }));
  }

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
  // Marked deleted, never hard-deleted: a hard DELETE is invisible to the
  // phones' pull, and a phone that had already pulled these rows would keep
  // them — and have anything recorded under them rejected by a foreign key.
  // `node tools/cleanup-qa.mjs --purge` removes them for good later.
  try {
    const now = new Date().toISOString();
    if (ids.bandeja.length) {
      await db.from('alimentacion').update({ deleted_at: now }).in('bandeja_id', ids.bandeja);
      await db.from('revision').update({ deleted_at: now }).in('bandeja_id', ids.bandeja);
    }
    for (const t of ['lote', 'separacion', 'ayuno', 'bandeja', 'incubadora', 'recoleccion', 'insectario',
                     'ensilaje_lectura', 'ensilaje_insumo', 'ensilaje', 'recepcion_alimento']) {
      if (ids[t] && ids[t].length) await db.from(t).update({ deleted_at: now }).in('id', ids[t]);
    }
    const left = await db.from('insectario').select('id').in('id', ids.insectario).is('deleted_at', null);
    if (!left.data || !left.data.length) ok('limpieza', 'filas de prueba marcadas como borradas');
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
