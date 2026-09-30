/**
 * The food module on a phone, end to end, against a REAL Postgres (PGlite)
 * with every migration through 0008:
 *
 *   recepción (material, kg) → ensilaje (armado → sellado → listo → en uso
 *   → agotado, lecturas de temperatura) → each carga of the trays is taken
 *   from the ensilaje in use → stock and consumption.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb, openDb } from './helpers/env.mjs';
import { liveReplica, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { pushAll } = await import('../src/data/sync/push.js');
const { pullOnce } = await import('../src/data/sync/pull.js');
const { listStuck, listOpen, requeue } = await import('../src/data/outbox.js');
const { listConflicts, resolveConflict } = await import('../src/data/conflicts.js');
const { farmDay, addDays } = await import('../src/data/time.js');

const MIG = f => readSql(`supabase/migrations/${f}`);
async function server(upTo) {
  const pg = await liveReplica();
  for (const f of ['0005_renombrar_lote.sql', '0006_sobrecargas.sql', '0007_protocolo_v2.sql', '0008_alimento.sql']) {
    await pg.exec(await MIG(f));
    if (f.startsWith(upTo)) break;
  }
  return pg;
}

const pg = await server('0008');
useBackend(pgClient(pg));
const one = async (sql, p) => (await pg.query(sql, p)).rows[0];

const S = {};
const HOY = farmDay();
await freshDb();

test('recepción: what arrived, how much, from whom', async () => {
  assert.equal((await w.createRecepcion({ material: 'Bagazo de cerveza (BSG)' })).ok, false, 'sin kg no');
  assert.equal((await w.createRecepcion({ kg: 10 })).ok, false, 'sin material no');
  const res = await w.createRecepcion({ material: 'Bagazo de cerveza (BSG)', kg: 120, proveedor: 'Cervecería del valle',
                                        operator_name: 'Maria' });
  assert.ok(res.ok, JSON.stringify(res.error));
  S.recepcion = res.data.id;
  const list = await r.listRecepciones();
  assert.equal(list.data[0].kg, 120);
  assert.equal(list.data[0].proveedor, 'Cervecería del valle');
});

test('a phone set to Spanish types a decimal comma, and it is read as one', async () => {
  const { num } = await import('../src/data/envelope.js');
  assert.equal(num('1,5'), 1.5);
  assert.equal(num(' 2,25 '), 2.25);
  assert.equal(num('3.5'), 3.5);
  assert.equal(num('  '), null, 'blank is missing, not zero');
  assert.equal(num('1.500,5'), null, 'ambiguous: refused rather than guessed');
  const res = await w.createRecepcion({ material: 'Desecho de fruta', kg: '7,5' });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.kg, 7.5);
  S.fruta = res.data.id;
});

test('ensilaje: made from materials, then sealed, with temperature readings', async () => {
  assert.equal((await w.createEnsilaje({ silo: 'Silo 1', insumos: [] })).ok, false, 'sin materiales no');
  assert.equal((await w.createEnsilaje({ insumos: [{ material: 'Otro' }] })).ok, false, 'cada material con sus kg');

  const res = await w.createEnsilaje({
    silo: 'Silo 1', operator_name: 'Maria',
    insumos: [{ material: 'Bagazo de cerveza (BSG)', kg: 80, recepcion_id: S.recepcion }, { material: 'Desecho de fruta', kg: 20 }]
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  S.ens = res.data.id;
  assert.equal(res.data.kg_inicial, 100, 'sin kg escritos, la suma de los materiales');
  assert.equal(res.data.estado, 'armado');
  assert.match(res.data.codigo, /^ENS-\d{4}-[A-Z2-9]{3}$/);

  assert.equal((await w.avanzarEnsilaje(S.ens, 'listo')).ok, false, 'no está listo lo que no se selló');
  const s = await w.avanzarEnsilaje(S.ens, 'sellado', { fecha: addDays(HOY, -10) + 'T08:00', operator_name: 'Ricardo' });
  assert.ok(s.ok);
  assert.equal(s.data.estado, 'fermentando');
  assert.equal(s.data.sellado_por, 'Ricardo');

  assert.equal((await w.logLecturaEnsilaje(S.ens, { temperatura_c: 'caliente' })).ok, false);
  assert.ok((await w.logLecturaEnsilaje(S.ens, { temperatura_c: 32.5, operator_name: 'Maria' })).ok);

  const d = (await r.getEnsilajeDetail(S.ens)).data;
  assert.equal(d.ensilaje.dias_fermentando, 10);
  assert.equal(d.ensilaje.listo_previsto, addDays(HOY, 4), 'sellado + 14 días (provisional)');
  assert.equal(d.ensilaje.listo_en, 4);
  assert.equal(d.ensilaje.ultima_temperatura_c, 32.5);
  assert.equal(d.insumos.length, 2);
});

test('the loads of the trays come out of the ensilaje in use', async () => {
  // Nothing in use yet: the tray is still fed, no stock is touched.
  const ins = await w.createInsectario({ nombre_insectario: 'ICB', fecha_inicio: '2026-08-01', generacion_moscas: 'F7' });
  const rec = await w.createRecoleccionV2({ insectario_id: ins.data.id, peso_ovipositores_g: 300, atrayente_cambiado: true,
                                            fecha_inicio: addDays(HOY, -10) });
  const dis = await w.distribuirIncubadora(rec.data.incubadora.id, { n_bandejas: 2 });
  S.trays = dis.data.bandejas.map(b => b.id);
  const feeds1 = (await r.getBandejaDetail(S.trays[0])).data.eventos.filter(e => e.tipo === 'alimentacion');
  assert.equal(feeds1[0].ensilaje_id, undefined, 'carga 1 sin ensilaje en uso');

  assert.ok((await w.avanzarEnsilaje(S.ens, 'en_uso', { operator_name: 'Maria' })).ok);
  const c2 = await w.logCarga({ bandeja_ids: S.trays, carga: 2 });
  assert.ok(c2.ok);
  assert.equal(c2.data.ensilaje.id, S.ens, 'la carga dice de qué ensilaje salió');

  const e = (await r.getEnsilajeDetail(S.ens)).data.ensilaje;
  assert.equal(e.estado, 'en_uso');
  assert.equal(e.kg_consumido, 4, '2 bandejas × 2 kg');
  assert.equal(e.kg_disponible, 96);
});

test('stock: material in store, ensilaje at hand, days it lasts, and the loads coming', async () => {
  const st = (await r.getStockAlimento()).data;
  const bsg = st.materiales.find(m => m.material === 'Bagazo de cerveza (BSG)');
  assert.deepEqual([bsg.recibido_kg, bsg.usado_kg, bsg.disponible_kg], [120, 80, 40]);
  assert.equal(st.ensilaje_en_uso.id, S.ens);
  assert.equal(st.ensilaje_disponible_kg, 96);
  assert.equal(st.consumo_7d_kg, 1.5 * 2 + 2 * 2, 'lo que comieron las bandejas v2 esta semana');
  assert.ok(st.dias_restantes > 0);
  // Día 10 with carga 2 given: carga 3 (2 kg) is due on día 13, within 3 days.
  assert.equal(st.kg_cargas_proximas, 4, '2 bandejas × carga 3');
  assert.equal(st.alcanza, true);
});

test('push: everything lands on the server, and the server agrees on the stock', async () => {
  const out = await pushAll(await openDb());
  assert.equal(out.conflicts, 0, JSON.stringify(await listStuck(await openDb())));
  assert.deepEqual(await listOpen(await openDb()), []);
  const s = await one(`select v.estado, v.consumido_kg, v.disponible_kg, e.sellado_por, e.en_uso_por
                         from app.v_stock_ensilaje v join app.ensilaje e using (id) where id = $1`, [S.ens]);
  assert.equal(s.estado, 'en_uso');
  assert.equal(Number(s.consumido_kg), 4);
  assert.equal(Number(s.disponible_kg), 96);
  assert.equal(s.sellado_por, 'Ricardo');
  assert.equal(s.en_uso_por, 'Maria');
  const m = await one(`select disponible_kg from app.v_stock_material where material = 'Bagazo de cerveza (BSG)'`);
  assert.equal(Number(m.disponible_kg), 40);
  assert.equal(Number((await one(`select count(*) n from app.ensilaje_lectura where ensilaje_id = $1`, [S.ens])).n), 1);
});

test('agotado: the batch is finished; later loads take nothing from it', async () => {
  assert.ok((await w.avanzarEnsilaje(S.ens, 'agotado')).ok);
  const c3 = await w.logCarga({ bandeja_ids: S.trays, carga: 3 });
  assert.ok(c3.ok);
  assert.equal(c3.data.ensilaje, null);
  const st = (await r.getStockAlimento()).data;
  assert.equal(st.ensilaje_en_uso, null);
  assert.equal(st.ensilaje_disponible_kg, 0);
  assert.equal((await pushAll(await openDb())).conflicts, 0);
});

/** A client that fails one RPC once, the way a momentary server problem does. */
function failOnce(client, rpcName, error) {
  let armed = true;
  return new Proxy(client, {
    get(t, k) {
      if (k !== 'rpc') return t[k];
      return async (name, args) => {
        if (armed && name === rpcName) { armed = false; return { data: null, error }; }
        return t.rpc(name, args);
      };
    }
  });
}

test('REGRESSION: the steps of a batch never overtake the batch while it retries', async () => {
  const db = await openDb();
  const rec = await w.createRecepcion({ material: 'Desecho de panadería', kg: 25 });
  const ens = await w.createEnsilaje({ silo: 'Silo 2', insumos: [{ material: 'Desecho de panadería', kg: 25,
                                                                  recepcion_id: rec.data.id }] });
  await w.avanzarEnsilaje(ens.data.id, 'sellado', { operator_name: 'Ricardo' });

  // The server hiccups on the batch itself: it backs off and retries later.
  useBackend(failOnce(pgClient(pg), 'crear_ensilaje', { status: 503, message: 'Service Unavailable' }));
  await pushAll(db);
  const open = await listOpen(db);
  assert.deepEqual(open.map(i => i.rpc), ['crear_ensilaje', 'avanzar_ensilaje'],
    'sent before its batch existed, "sellado" would have updated nothing and counted as done');

  useBackend(pgClient(pg));
  for (const it of open) await requeue(db, it.id);        // the backoff is over
  assert.equal((await pushAll(db)).conflicts, 0);
  const e = await one(`select estado, sellado_por from app.ensilaje where id = $1`, [ens.data.id]);
  assert.deepEqual([e.estado, e.sellado_por], ['fermentando', 'Ricardo']);
});

test('Reintentar on a rejected batch also releases the steps queued behind it', async () => {
  const db = await openDb();
  const ens = await w.createEnsilaje({ silo: 'Silo 3', insumos: [{ material: 'Desecho de fruta', kg: 12 }] });
  await w.avanzarEnsilaje(ens.data.id, 'sellado');
  useBackend(failOnce(pgClient(pg), 'crear_ensilaje', { code: '42501', message: 'permiso denegado' }));
  await pushAll(db);
  const conflicts = await listConflicts(db);
  const main = conflicts.find(c => c.rpc === 'crear_ensilaje');
  assert.ok(main);
  assert.ok(conflicts.some(c => c.rpc === 'avanzar_ensilaje' && c.reason === 'dependencia'),
    'the step waits, visibly, instead of vanishing');

  useBackend(pgClient(pg));
  const res = await resolveConflict(db, main.id, 'retry');
  assert.equal(res.data.afectados, 1);
  assert.equal((await pushAll(db)).conflicts, 0);
  assert.equal((await listConflicts(db)).length, 0);
  assert.equal((await one(`select estado from app.ensilaje where id = $1`, [ens.data.id])).estado, 'fermentando');
});

test('a newer app against a server without 0008: the rest keeps syncing', async () => {
  const old = await server('0007');
  useBackend(pgClient(old));
  const res = await pullOnce(await openDb());
  const faltan = res.errors.map(e => e.table).sort();
  assert.deepEqual(faltan, ['ensilaje', 'ensilaje_insumo', 'ensilaje_lectura', 'recepcion_alimento'],
    'sólo las tablas nuevas faltan; todo lo demás se descarga igual');
  useBackend(pgClient(pg));
});
