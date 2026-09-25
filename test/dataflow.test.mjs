/**
 * End-to-end exercise of the public data API, offline (no backend configured).
 * Tests share one database and run in order, mirroring a real day on the farm.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers/env.mjs';

await freshDb();
const api = await import('../dataClient.js');
await api.ready();

import { openDb } from '../src/data/idb/open.js';
import { outboxStats, listOpen } from '../src/data/outbox.js';
import { getCache } from '../src/data/cache.js';

const OP = 'Maria';
const state = {};

test('catalogues seed so the pickers are usable on a fresh install', () => {
  assert.deepEqual(api.NOMBRES_INSECTARIO, ['ICA', 'ICB', 'ICC', 'JN3A']);
  assert.deepEqual(api.TIPO_ALIMENTO, ['Bagazo', 'Yogurt', 'Afrecho', 'Mezcla']);
  assert.ok(api.QC_COLOR_DORADO.includes('Muy Crujiente'));
  // Same array identity the template captured at import time.
  assert.equal(api.NOMBRES_INSECTARIO.length, 4);
});

test('the registered roster is there before anyone types anything', async () => {
  const res = await api.listOperators();
  assert.ok(res.ok);
  assert.deepEqual(res.data, ['Maria', 'Ricardo'], 'shown in registered order');
});

test('a name that is not on the list can be typed, and joins the list', async () => {
  const added = await api.rememberOperator('  Jose  ');
  assert.ok(added.ok, JSON.stringify(added.error));
  assert.equal(added.data.nombre, 'Jose', 'trimmed');

  const names = await api.listOperators();
  assert.equal(names.data[0], 'Jose', 'the person who just registered is first');
  assert.ok(names.data.includes('Maria') && names.data.includes('Ricardo'));

  // It must SYNC, or the name only exists on one phone.
  const { openDb } = await import('../src/data/idb/open.js');
  const { listOpen } = await import('../src/data/outbox.js');
  const queued = await listOpen(await openDb());
  const item = queued.find(i => i.table === 'catalogo' && i.payload?.valor === 'Jose');
  assert.ok(item, 'a new name is queued for every other device');
  assert.equal(item.payload.tipo, 'operario');

  // Two phones typing the same name must produce the SAME row, or the
  // unique(tipo, valor) constraint would reject the second with a 23505 and
  // adding a name would land in the conflict inbox.
  const { uuidFromString } = await import('../src/data/ids.js');
  assert.equal(item.row_id, uuidFromString('operario:jose'));

  // Re-picking moves it up without duplicating.
  await api.rememberOperator('Maria');
  const after = await api.listOperators();
  assert.equal(after.data[0], 'Maria');
  assert.equal(new Set(after.data.map(n => n.toLowerCase())).size, after.data.length,
    'no duplicates regardless of case');

  const blank = await api.rememberOperator('   ');
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, 'validation_error');
});

test('create insectario -> human code, explicit state, null-safe deviations', async () => {
  const res = await api.createInsectario({
    nombre_insectario: 'ICB', fecha_inicio: '2026-05-01',
    generacion_moscas: 'F6', biomasa_kg: 3.1,
    proyeccion_ovipositores: '2026-05-15', proyeccion_cierre: '2026-05-22',
    operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  state.insectario = res.data;

  assert.equal(res.data.codigo, 'ICB-0105', 'codigo is nombre + farm-local DDMM');
  assert.match(res.data.id, /^[0-9a-f]{8}-/, 'PK is a client-generated UUID');
  assert.equal(res.data.estado, 'activo');
  assert.equal(res.data.poblacion_estimada, 155000);
  // THE BUG: AppSheet produced ~-20,676 here because a blank date read as epoch.
  assert.equal(res.data.desviacion_cierre_dias, null);
  assert.equal(res.data.desviacion_ovipositores_dias, null);
});

test('validation rejects an insectario with no name or date', async () => {
  const res = await api.createInsectario({ nombre_insectario: 'ICA' });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'validation_error');
});

test('atractante is a first-write-wins stamp and fills the deviation', async () => {
  const res = await api.marcarAtractante(state.insectario.id);
  assert.ok(res.ok);
  assert.ok(res.data.fecha_ovipositores, 'date is stamped');
  assert.equal(typeof res.data.desviacion_ovipositores_dias, 'number',
    'deviation appears only once the real date exists');

  // Replay must be a no-op, not an overwrite.
  const again = await api.marcarAtractante(state.insectario.id);
  assert.equal(again.data.fecha_ovipositores, res.data.fecha_ovipositores);
});

test('create recoleccion -> per-colony ordinal, not a global counter', async () => {
  const a = await api.createRecoleccion({ insectario_id: state.insectario.id, huevos_g: 0.62, operator_name: OP });
  assert.ok(a.ok, JSON.stringify(a.error));
  assert.equal(a.data.recolecta, '1');

  const b = await api.createRecoleccion({ insectario_id: state.insectario.id, huevos_g: 0.55, operator_name: OP });
  assert.equal(b.data.recolecta, '2', 'ordinal advances within the colony');
  state.recoleccion = b.data;
});

test('bandeja number must be TYPED — the marker goes on the tray first', async () => {
  const missing = await api.createBandeja({ recoleccion_id: state.recoleccion.id, operator_name: OP });
  assert.equal(missing.ok, false);
  assert.equal(missing.error.code, 'validation_error');
  assert.match(missing.error.message, /Número de bandeja/);
});

test('create bandeja -> label matches the marker, starts en_crecimiento', async () => {
  const res = await api.createBandeja({
    recoleccion_id: state.recoleccion.id, no_bandeja: 1,
    fecha: '2026-09-02T08:00', gramos_huevos: 0.5, iniciador_g: 300,
    tipo_iniciador: 'Bagazo', operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  state.bandeja = res.data;

  assert.equal(res.data.id_bandeja, '0209.2.1', 'DDMM.recolecta.n, farm-local');
  assert.equal(res.data.estado, 'en_crecimiento');
  assert.equal(res.data.insectario_codigo, 'ICB-0105');

  const second = await api.createBandeja({
    recoleccion_id: state.recoleccion.id, no_bandeja: 2, fecha: '2026-09-02T08:05', operator_name: OP
  });
  assert.ok(second.ok);
  state.bandeja2 = second.data;
});

test('duplicate tray number in the same recoleccion is caught locally', async () => {
  const dup = await api.createBandeja({
    recoleccion_id: state.recoleccion.id, no_bandeja: 1, operator_name: OP
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'conflict');
});

test('feeding does NOT advance tray state, but does update the rollup', async () => {
  const res = await api.logAlimentacion({
    bandeja_id: state.bandeja.id, tipo_alimento: 'Bagazo',
    cantidad_kg: 1.3, operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));

  const detail = await api.getBandejaDetail(state.bandeja.id);
  assert.equal(detail.data.bandeja.estado, 'en_crecimiento', 'feeding is not a state change');
  assert.equal(detail.data.bandeja.n_alimentaciones, 1);
  assert.equal(detail.data.bandeja.kg_alimento_total, 1.3);
  assert.equal(detail.data.bandeja.last_evento.tipo, 'alimentacion');
});

test('bulk feed fans out as ONE queue item, never N partial rows', async () => {
  const before = await outboxStats(await openDb());

  const res = await api.logAlimentacionGrupal({
    bandeja_ids: [state.bandeja.id, state.bandeja2.id],
    tipo_alimento: 'Afrecho', cantidad_kg: 0.9, operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.created, 2);
  assert.ok(res.data.rows.every(r => r.grupal_id === res.data.grupal_id));
  // Every row fully populated in the same pass — the AppSheet race wrote ~20
  // rows with a tray reference but blank fecha/tipo/cantidad.
  assert.ok(res.data.rows.every(r => r.fecha && r.tipo_alimento && r.cantidad_kg));

  const after = await outboxStats(await openDb());
  assert.equal(after.pending - before.pending, 1,
    'one atomic RPC, not one queue item per tray');
});

test('ayuno moves the tray to en_ayuno and leaves merma unresolved', async () => {
  const res = await api.logAyuno({
    bandeja_id: state.bandeja.id, peso_inicial_kg: 1.22,
    horas_ayuno: 24, operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  state.ayuno = res.data;

  const detail = await api.getBandejaDetail(state.bandeja.id);
  assert.equal(detail.data.bandeja.estado, 'en_ayuno');
  assert.equal(detail.data.bandeja.tiene_ayuno_abierto, true);

  const abiertos = await api.listAyunosAbiertos();
  assert.equal(abiertos.data.length, 1);
  assert.equal(abiertos.data[0].merma_pct, null, 'no final weight yet, so no merma');
});

test('THE GAP: closing a fast is now reachable and computes merma', async () => {
  const res = await api.logAyunoFin(state.ayuno.id, { peso_final_kg: 1.06 });
  assert.ok(res.ok, JSON.stringify(res.error));

  const detail = await api.getBandejaDetail(state.bandeja.id);
  const ayuno = detail.data.eventos.find(e => e.tipo === 'ayuno');
  assert.equal(ayuno.peso_final_kg, 1.06);
  assert.equal(ayuno.merma_pct, 13.1, '(1.22-1.06)/1.22 = 13.1%');

  const abiertos = await api.listAyunosAbiertos();
  assert.equal(abiertos.data.length, 0);

  // Closing twice must not silently overwrite.
  const again = await api.logAyunoFin(state.ayuno.id, { peso_final_kg: 0.9 });
  assert.equal(again.ok, false);
  assert.equal(again.error.code, 'conflict');
});

test('final weight above initial is rejected', async () => {
  const a = await api.logAyuno({ bandeja_id: state.bandeja2.id, peso_inicial_kg: 1.0, operator_name: OP });
  const bad = await api.logAyunoFin(a.data.id, { peso_final_kg: 1.5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'validation_error');
});

test('separacion harvests the tray and exposes it for pooling', async () => {
  const res = await api.logSeparacion({
    bandeja_id: state.bandeja.id, larva_limpia_g: 410, operator_name: OP
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  state.separacion = res.data;

  const detail = await api.getBandejaDetail(state.bandeja.id);
  assert.equal(detail.data.bandeja.estado, 'cosechada');
  assert.equal(detail.data.bandeja.separacion.larva_limpia_g, 410);

  const disp = await api.listSeparacionesDisponibles();
  assert.equal(disp.data.length, 1);
  assert.equal(disp.data[0].bandeja_label, '0209.2.1');
});

test('a tray cannot be separated twice', async () => {
  const dup = await api.logSeparacion({
    bandeja_id: state.bandeja.id, larva_limpia_g: 100, operator_name: OP
  });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'conflict');
});

test('estado is monotonic — a late feeding cannot un-harvest a tray', async () => {
  await api.logAlimentacion({
    bandeja_id: state.bandeja.id, tipo_alimento: 'Bagazo', cantidad_kg: 0.2, operator_name: OP
  });
  const detail = await api.getBandejaDetail(state.bandeja.id);
  assert.equal(detail.data.bandeja.estado, 'cosechada',
    'cosechada > en_ayuno > en_crecimiento, and nothing moves backwards');
});

test('lote pools separaciones and runs the full QC lifecycle', async () => {
  const created = await api.createLote({
    separacion_ids: [state.separacion.id], peso_inicial_kg: 0.41, operator_name: OP
  });
  assert.ok(created.ok, JSON.stringify(created.error));
  state.lote = created.data;
  assert.equal(created.data.estado, 'secando');
  assert.match(created.data.codigo, /^CO-\d{6}-[A-Z0-9]{4}$/);

  // Pooling the same harvest twice is refused.
  const dup = await api.createLote({ separacion_ids: [state.separacion.id], operator_name: OP });
  assert.equal(dup.ok, false);
  assert.equal(dup.error.code, 'conflict');

  // Entering a weight must NOT by itself advance the state — in the prototype
  // it did, which hid the form that edits the weight.
  const weighed = await api.updateLoteQC(state.lote.id, { peso_final_kg: 0.11, tiempo_secado_horas: 14 });
  assert.ok(weighed.ok, JSON.stringify(weighed.error));
  assert.equal(weighed.data.estado, 'secando', 'still secando until QC is explicitly decided');
  assert.equal(weighed.data.rendimiento_pct, 26.8);

  // Packing before approval is refused.
  const early = await api.marcarEmpacado(state.lote.id, {});
  assert.equal(early.ok, false);

  const approved = await api.updateLoteQC(state.lote.id, { qc_aprobado: true, qc_color_dorado: 'Muy Crujiente' });
  assert.equal(approved.data.estado, 'en_qc');

  // Dispatch before packing is refused — the prototype allowed it.
  const outOfOrder = await api.marcarDespachado(state.lote.id);
  assert.equal(outOfOrder.ok, false);

  const packed = await api.marcarEmpacado(state.lote.id, {});
  assert.equal(packed.data.estado, 'empacado');
  assert.ok(packed.data.fecha_vencimiento, '180-day shelf life is stamped');

  const shipped = await api.marcarDespachado(state.lote.id);
  assert.equal(shipped.data.estado, 'despachado');
});

test('a failed oven run can be rejected, with a mandatory reason', async () => {
  const sep = await api.logSeparacion({ bandeja_id: state.bandeja2.id, larva_limpia_g: 380, operator_name: OP });
  const lote = await api.createLote({ separacion_ids: [sep.data.id], peso_inicial_kg: 0.38, operator_name: OP });

  const noReason = await api.rechazarLote(lote.data.id, '  ');
  assert.equal(noReason.ok, false, 'a rejection without a reason is not a record');

  const rejected = await api.rechazarLote(lote.data.id, 'Moho en dos bandejas metálicas.');
  assert.ok(rejected.ok, JSON.stringify(rejected.error));
  assert.equal(rejected.data.estado, 'rechazado');
  assert.equal(rejected.data.qc_aprobado, false);
});

test('tray list filters and sorts by most recent activity', async () => {
  const all = await api.listBandejas({});
  assert.equal(all.data.length, 2);

  const cosechadas = await api.listBandejas({ estado: 'cosechada' });
  assert.equal(cosechadas.data.length, 2);

  const search = await api.listBandejas({ q: '0209.2.1' });
  assert.equal(search.data.length, 1);

  const byColony = await api.listBandejas({ insectario_id: state.insectario.id });
  assert.equal(byColony.data.length, 2);

  const none = await api.listBandejas({ q: 'no-existe' });
  assert.equal(none.data.length, 0);
});

test('every write is queued exactly once, in order, and nothing was lost', async () => {
  const db = await openDb();
  const open = await listOpen(db);
  assert.ok(open.length > 0, 'offline writes are all still queued');

  const seqs = open.map(i => i.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'queue preserves order');

  const stats = await outboxStats(db);
  assert.equal(stats.conflict, 0, 'no local conflicts without a server');
  assert.equal(stats.quarantined, 0);

  // Children carry their dependency so they can never be pushed before parents.
  const trayItem = open.find(i => i.table === 'bandeja');
  assert.ok(trayItem.depends_on.includes(state.recoleccion.id));
});

test('the name is stored on the record itself, as plain text', async () => {
  const detail = await api.getBandejaDetail(state.bandeja.id);
  for (const ev of detail.data.eventos) {
    assert.equal(typeof ev.registrado_por, 'string',
      'no lookup, no foreign key — just the name that was typed');
    assert.equal(ev.registrado_por, OP);
  }
  // And it comes back as a chip even though nothing was explicitly remembered
  // for those records.
  const names = await api.listOperators();
  assert.ok(names.data.includes(OP));
});

test('the per-tray cache stays consistent with the events', async () => {
  const db = await openDb();
  const cache = await getCache(db, state.bandeja.id);
  assert.equal(cache.estado, 'cosechada');
  assert.equal(cache.n_alimentaciones, 3);      // individual + grupal + late one
  assert.equal(cache.tiene_ayuno_abierto, 0);
  assert.equal(cache.larva_limpia_g, 410);
  assert.ok(cache.lote_id, 'links through to the oven run');
});

test('insectario detail carries its recolecciones', async () => {
  const res = await api.getInsectarioDetail(state.insectario.id);
  assert.ok(res.ok);
  assert.equal(res.data.recolecciones.length, 2);
  assert.equal(res.data.insectario.estado, 'activo');
});

test('cierre closes the colony', async () => {
  const res = await api.marcarCierre(state.insectario.id);
  assert.equal(res.data.estado, 'cerrado');
  assert.equal(typeof res.data.desviacion_cierre_dias, 'number');
});

test('missing records report not_found rather than throwing', async () => {
  for (const call of [
    api.getBandejaDetail('00000000-0000-4000-8000-000000000000'),
    api.getLoteDetail('00000000-0000-4000-8000-000000000000'),
    api.getInsectarioDetail('00000000-0000-4000-8000-000000000000')
  ]) {
    const res = await call;
    assert.equal(res.ok, false);
    assert.equal(res.error.code, 'not_found');
  }
});
