/**
 * The home screen's "what is due" list.
 *
 * First the pure function (monitor.js) on a pinned farm day, then the whole
 * path on a phone: rows written through the app, read back by getMonitor, and
 * the bed temperatures pushed to a real Postgres with 0009.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { randomUUID as uid } from 'node:crypto';
import { freshDb, openDb } from './helpers/env.mjs';
import { liveReplica, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const { monitor } = await import('../src/data/monitor.js');
const { PROTOCOLO_DEFAULTS } = await import('../src/data/protocolo.js');
const { farmDay, addDays } = await import('../src/data/time.js');

const HOY = '2026-09-29';
const cfg = JSON.parse(JSON.stringify(PROTOCOLO_DEFAULTS));
const dia0 = dia => addDays(HOY, -dia);   // the día 0 that makes today día `dia`

/** v2 trays of one incubadora, at `dia`, with the loads already given. */
const trays = (prefix, dia, cargas = [], extra = {}) => [1, 2, 3].slice(0, extra.n || 3).map(n => ({
  id: `${prefix}-${n}`, id_bandeja: `${prefix}-0${n}`, protocolo: 'v2', estado: 'en_crecimiento',
  fecha_inicio: dia0(dia), cargas_dadas: cargas, tiene_ayuno: false, ...extra
}));

/* ── the pure function, on a pinned day ─────────────────────────────────── */

test('trays that need the same load on the same day are ONE item, one tap', () => {
  const { items, resumen } = monitor({ bandejas: trays('F7AR1', 10, [1]), cfg, hoy: HOY });
  assert.equal(items.length, 1);
  const [it] = items;
  assert.equal(it.tipo, 'carga');
  assert.equal(it.carga, 2);
  assert.equal(it.estado, 'hoy');
  assert.equal(it.kg, 6);
  assert.deepEqual(it.bandeja_ids, ['F7AR1-1', 'F7AR1-2', 'F7AR1-3']);
  assert.equal(it.titulo, 'Carga 2 · 3 bandejas');
  assert.match(it.detalle, /F7AR1-01, F7AR1-02, F7AR1-03 · día 10 · 6 kg/);
  assert.equal(it.cuando, 'hoy');
  assert.equal(resumen.pendientes, 1);
});

test('late first, then today, then the next two days; nothing further ahead', () => {
  const { items } = monitor({
    bandejas: [...trays('LATE', 11, [1]), ...trays('HOY', 10, [1]), ...trays('MAN', 12, [1, 2]),
               ...trays('LEJOS', 7, [1])],            // carga 2 in 3 days: beyond the horizon
    incubadoras: [{ id: 'i1', codigo: 'F7BR4', fecha_inicio: dia0(6) }],   // distribución mañana
    cfg, hoy: HOY
  });
  const pares = items.map(i => `${i.tipo}:${i.cuando}`);
  assert.deepEqual(pares.filter(p => !p.startsWith('temperatura')),
    ['carga:atrasado 1 día', 'carga:hoy', 'distribucion:mañana', 'carga:mañana']);
  assert.ok(!items.some(i => i.bandeja_ids?.includes('LEJOS-1')));
});

test('a load missed before día 14 is not chased: the fast is next', () => {
  const { items } = monitor({ bandejas: trays('F7AR2', 14, [1, 2]), cfg, hoy: HOY });
  assert.deepEqual(items.map(i => [i.tipo, i.estado]), [['ayuno', 'hoy']]);
  const cosecha = monitor({ bandejas: trays('F7AR3', 17, [1, 2, 3], { tiene_ayuno: true, estado: 'en_ayuno' }), cfg, hoy: HOY });
  assert.deepEqual(cosecha.items.map(i => [i.tipo, i.cuando]), [['cosecha', 'atrasado 1 día']]);
});

test('harvested, administratively closed and old-protocol trays are not on the list', () => {
  const { items } = monitor({ bandejas: [
    ...trays('COS', 10, [1], { estado: 'cosechada' }),
    ...trays('ADM', 10, [1], { cerrada_admin_at: '2026-09-01T00:00:00Z' }),
    ...trays('V1', 10, [1], { protocolo: 'v1' })
  ], cfg, hoy: HOY });
  assert.deepEqual(items, []);
});

test('bed temperature on días 11–12: who still needs measuring, and a bed too hot comes first', () => {
  const bandejas = trays('T', 11, [1, 2]);
  const lectura = (id, t, fecha = `${HOY}T15:00:00.000Z`) => ({ bandeja_id: id, fecha, temperatura_c: t });

  let r = monitor({ bandejas, cfg, hoy: HOY });
  const med = r.items.find(i => i.tipo === 'temperatura');
  assert.deepEqual(med.bandeja_ids, ['T-1', 'T-2', 'T-3']);
  assert.match(med.detalle, /máximo 36 °C/);

  r = monitor({ bandejas, cfg, hoy: HOY, revisiones: [lectura('T-1', 35.5), lectura('T-2', 37.5),
                                                       lectura('T-3', 34, `${addDays(HOY, -1)}T15:00:00.000Z`)] });
  assert.equal(r.items[0].tipo, 'temperatura_alta', 'a bed over the maximum is the first thing on screen');
  assert.equal(r.items[0].estado, 'alerta');
  assert.equal(r.items[0].cuando, 'ahora');
  assert.equal(r.items[0].detalle, 'T-02 37,5 °C');
  assert.deepEqual(r.items.find(i => i.tipo === 'temperatura').bandeja_ids, ['T-3'],
    'measured yesterday is not measured today');
  assert.equal(r.resumen.alerta, 1);

  // The maximum is a setting.
  const tibio = monitor({ bandejas, cfg: { ...cfg, temperatura_cama_max_c: 35 }, hoy: HOY,
                          revisiones: [lectura('T-1', 35.5)] });
  assert.equal(tibio.items[0].tipo, 'temperatura_alta');
});

test('between 20:00 and midnight in Caracas it is still the same farm day', () => {
  // 21:30 in Caracas on the 29th is 01:30 UTC on the 30th.
  const hoy = farmDay(new Date('2026-09-30T01:30:00.000Z'));
  assert.equal(hoy, '2026-09-29');
  const bandejas = [{ id: 'N-1', id_bandeja: 'N-01', protocolo: 'v2', estado: 'en_crecimiento',
                      fecha_inicio: '2026-09-18', cargas_dadas: [1, 2], tiene_ayuno: false }];
  // Measured at 20:30 Caracas = 00:30 UTC on the 30th: that is TODAY's reading.
  const r = monitor({ bandejas, cfg, hoy, revisiones: [{ bandeja_id: 'N-1', fecha: '2026-09-30T00:30:00.000Z', temperatura_c: 33 }] });
  assert.ok(!r.items.some(i => i.tipo === 'temperatura'), 'ya se midió hoy (en hora de la granja)');
  const carga = r.items.find(i => i.tipo === 'carga');
  assert.equal(carga.carga, 3);
  assert.equal(carga.cuando, 'en 2 días', 'día 11, no día 12: the UTC date is not the farm day');
});

test('an ensilaje due to be ready, from its sealing day and the plan', () => {
  const sello = d => ({ id: `E${d}`, codigo: `ENS-${d}`, sellado_at: `${addDays(HOY, -d)}T14:00:00.000Z` });
  const { items } = monitor({ ensilajes: [sello(14), sello(13), sello(10), { ...sello(20), listo_at: 'x' }], cfg, hoy: HOY });
  assert.deepEqual(items.map(i => [i.tipo, i.ensilaje_id, i.cuando]),
                   [['ensilaje', 'E14', 'hoy'], ['ensilaje', 'E13', 'mañana']]);
  const tarde = monitor({ ensilajes: [sello(16)], cfg, hoy: HOY }).items[0];
  assert.match(tarde.detalle, /desde hace 2 días/);
});

test('the stock: an alert when what is ready does not cover the loads coming', () => {
  const bandejas = trays('S', 10, [1]);
  const stock = { kg_cargas_proximas: 12, ensilaje_disponible_kg: 5, alcanza: false, dias_prevision: 3,
                  ensilaje_en_uso: { id: 'E1' } };
  const r = monitor({ bandejas, stock, ensilajes: [{ id: 'E1', codigo: 'ENS-1', en_uso_at: 'x', sellado_at: 'x' }], cfg, hoy: HOY });
  assert.equal(r.items[0].tipo, 'stock');
  assert.equal(r.items[0].estado, 'alerta');
  assert.match(r.items[0].detalle, /12 kg; listos 5 kg \(faltan 7\)/);

  // Before the lab records any ensilaje there is no stock to warn about — only
  // that the loads are not being counted.
  const sin = monitor({ bandejas, stock: { ...stock, ensilaje_en_uso: null }, ensilajes: [], cfg, hoy: HOY });
  assert.deepEqual(sin.items.map(i => i.tipo), ['carga', 'sin_ensilaje']);
});

/* ── on a phone: written through the app, read back, pushed ─────────────── */

const MIG = f => readSql(`supabase/migrations/${f}`);
const pg = await liveReplica();
for (const f of ['0005_renombrar_lote.sql', '0006_sobrecargas.sql', '0007_protocolo_v2.sql', '0008_alimento.sql', '0009_monitor.sql']) {
  await pg.exec(await MIG(f));
}
useBackend(pgClient(pg));
await freshDb();
const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { pushAll } = await import('../src/data/sync/push.js');
const S = {};

test('getMonitor on a phone: día 11 asks for carga 2 (late) and the bed temperature', async () => {
  const ins = await w.createInsectario({ nombre_insectario: 'ICA', fecha_inicio: '2026-08-01', generacion_moscas: 'F8' });
  const rec = await w.createRecoleccionV2({ insectario_id: ins.data.id, peso_ovipositores_g: 300, atrayente_cambiado: true,
                                            fecha_inicio: addDays(farmDay(), -11) });
  const dis = await w.distribuirIncubadora(rec.data.incubadora.id, { n_bandejas: 2 });
  S.trays = dis.data.bandejas.map(b => b.id);

  const m = (await r.getMonitor()).data;
  assert.equal(m.hoy, farmDay());
  const carga = m.items.find(i => i.tipo === 'carga');
  assert.deepEqual([carga.carga, carga.estado, carga.bandeja_ids.length], [2, 'atrasado', 2]);
  assert.deepEqual(m.items.find(i => i.tipo === 'temperatura').bandeja_ids.sort(), [...S.trays].sort());
});

test('logTemperaturaCama: one round, a revisión per tray; the hot bed is reported', async () => {
  assert.equal((await w.logTemperaturaCama({ lecturas: [] })).ok, false);
  assert.equal((await w.logTemperaturaCama({ lecturas: [{ bandeja_id: S.trays[0], temperatura_c: 'mucho' }] })).ok, false);
  const res = await w.logTemperaturaCama({ operator_name: 'Maria', lecturas: [
    { bandeja_id: S.trays[0], temperatura_c: '34,5' }, { bandeja_id: S.trays[1], temperatura_c: '37' }] });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.created, 2);
  assert.deepEqual(res.data.altas.map(a => a.temperatura_c), [37]);

  const m = (await r.getMonitor()).data;
  assert.ok(!m.items.some(i => i.tipo === 'temperatura'), 'measured today: off the list');
  assert.equal(m.items[0].tipo, 'temperatura_alta');
  const ev = (await r.getBandejaDetail(S.trays[1])).data.eventos.find(e => e.tipo === 'revision');
  assert.equal(ev.temperatura_c, 37);
  assert.equal(ev.registrado_por, 'Maria');
});

test('a revisión without temperature sends no temperature field at all', async () => {
  const res = await w.logRevision({ bandeja_id: S.trays[0], notas: 'todo bien' });
  assert.ok(res.ok);
  assert.ok(!('temperatura_c' in res.data), 'works on a server without 0009, like every earlier build');
  assert.equal((await w.logRevision({ bandeja_id: S.trays[0], temperatura_c: '120' })).ok, false);
});

test('push: the readings land, and the server flags the same bed', async () => {
  const out = await pushAll(await openDb());
  assert.equal(out.conflicts, 0);
  const rows = (await pg.query(`select id_bandeja, temperatura_c, sobre_maximo from app.v_temperatura_cama order by id_bandeja`)).rows;
  assert.deepEqual(rows.map(x => [Number(x.temperatura_c), x.sobre_maximo]), [[34.5, false], [37, true]]);
  const q = (await pg.query(`select n from app.v_calidad_datos where problema = 'cama_sobre_maximo_7d'`)).rows[0];
  assert.equal(Number(q.n), 1);
});
