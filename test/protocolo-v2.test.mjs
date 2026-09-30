/**
 * The v2 production chain on a phone, end to end, against a REAL Postgres
 * (PGlite) holding production as it will be after Release 1
 * (0001–0004 as applied, then 0005, 0006, 0007).
 *
 *   recolecta → incubadora → día 7 distribución (+ carga 1) → carga 2 → carga 3
 *   → ayuno → cosecha (larva al horno + 2 % al laboratorio) → Lote
 *
 * Tests run in order and share one phone and one server, like a real cycle.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { randomUUID as uid } from 'node:crypto';
import { freshDb, openDb } from './helpers/env.mjs';
import { liveReplica, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { pushAll } = await import('../src/data/sync/push.js');
const { pullOnce } = await import('../src/data/sync/pull.js');
const { claimBatch, listOpen, listStuck } = await import('../src/data/outbox.js');
const { listConflicts, resolveConflict } = await import('../src/data/conflicts.js');
const { applyServerRows, putLocal, allRows } = await import('../src/data/store.js');
const { farmDay, addDays } = await import('../src/data/time.js');

const MIG = f => readSql(`supabase/migrations/${f}`);
const pg = await liveReplica();
for (const f of ['0005_renombrar_lote.sql', '0006_sobrecargas.sql', '0007_protocolo_v2.sql']) {
  await pg.exec(await MIG(f));
}
const server = pgClient(pg);
useBackend(server);

const one = async (sql, p) => (await pg.query(sql, p)).rows[0];
const count = async (sql, p) => Number((await one(sql, p)).n);

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

const S = {};
const HOY = farmDay();

await freshDb();

test('the phone gets the insectario and the protocol settings from the server', async () => {
  S.ins = uid();
  await pg.query(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio, generacion_moscas)
                  values ($1, 'ICA-0108', 'ICA', '2026-08-01', 'F7')`, [S.ins]);
  const res = await pullOnce(await openDb());
  assert.deepEqual(res.errors, [], JSON.stringify(res.errors));
  const cfg = await r.getProtocolo();
  assert.deepEqual(cfg.data.cargas.map(c => c.kg), [1.5, 2, 2], 'settings pulled from app.parametro');
  assert.equal(cfg.data.v2_vigente, true);
});

test('offline: recolecta v2 creates its incubadora, with the lab\'s code', async () => {
  assert.equal((await w.createRecoleccionV2({ insectario_id: S.ins, peso_ovipositores_g: 350 })).ok, false,
    'el atrayente cambiado es obligatorio');
  assert.equal((await w.createRecoleccionV2({ insectario_id: S.ins, atrayente_cambiado: true })).ok, false,
    'el peso de ovipositores es obligatorio');

  const res = await w.createRecoleccionV2({
    insectario_id: S.ins, peso_ovipositores_g: 350, atrayente_cambiado: true, starter_kg: 2,
    fecha_inicio: addDays(HOY, -7), operator_name: 'Maria'
  });
  assert.ok(res.ok, JSON.stringify(res.error));
  S.rec = res.data.recoleccion.id;
  S.inc = res.data.incubadora.id;
  assert.equal(res.data.incubadora.codigo, 'F7AR1', 'generación F7, insectario A, recolecta 1');

  const list = await r.listIncubadoras();
  const inc = list.data.find(i => i.id === S.inc);
  assert.equal(inc.dia_ciclo, 7);
  assert.equal(inc.siguiente_paso.paso, 'distribucion');
  assert.equal(inc.siguiente_paso.estado, 'hoy', 'día 7: toca distribuir');
});

test('offline: día 7 distribución makes the trays and gives carga 1', async () => {
  const res = await w.distribuirIncubadora(S.inc, { n_bandejas: 3, operator_name: 'Ricardo' });
  assert.ok(res.ok, JSON.stringify(res.error));
  S.trays = res.data.bandejas.map(b => b.id);
  assert.deepEqual(res.data.bandejas.map(b => b.id_bandeja), ['F7AR1-01', 'F7AR1-02', 'F7AR1-03']);
  assert.equal(res.data.cargas, 3);

  assert.equal((await w.distribuirIncubadora(S.inc, { n_bandejas: 3 })).ok, false, 'sólo una vez');

  const trays = (await r.listBandejas({})).data.filter(b => S.trays.includes(b.id));
  for (const t of trays) {
    assert.equal(t.protocolo, 'v2');
    assert.equal(t.dia_ciclo, 7);
    assert.deepEqual(t.cargas_dadas, [1]);
    assert.equal(t.siguiente_paso.paso, 'carga');
    assert.equal(t.siguiente_paso.carga, 2);
    assert.equal(t.siguiente_paso.cuando, 'en 3 días');
    assert.equal(t.insectario_codigo, 'ICA-0108', 'la bandeja v2 sigue mostrando su insectario');
    assert.equal(t.incubadora_codigo, 'F7AR1');
  }
});

test('offline: carga 2 for all trays in one tap; the kilos come from the plan', async () => {
  const bad = await w.logAlimentacion({ bandeja_id: S.trays[0], tipo_alimento: 'Bagazo', cantidad_kg: 3 });
  assert.equal(bad.ok, false, 'una bandeja v2 no acepta alimento a mano');

  const res = await w.logCarga({ bandeja_ids: S.trays, carga: 2, tamizado: true, operator_name: 'Maria' });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.kg, 2);
  assert.ok(res.data.rows.every(x => x.cantidad_kg === 2 && x.tipo_alimento === 'Ensilaje' && x.tamizado));

  const again = await w.logCarga({ bandeja_ids: [S.trays[0]], carga: 2 });
  assert.equal(again.ok, false, 'la misma carga dos veces se rechaza');
  assert.match(again.error.message, /F7AR1-01/, 'dice qué bandeja, no un id');
});

test('the offline chain goes out in order — nothing waits on itself', async () => {
  const db = await openDb();
  const { ready, blocked } = await claimBatch(db, { limit: 50 });
  const order = ready.map(i => i.rpc || i.table);
  assert.deepEqual(order, ['crear_recoleccion_v2', 'distribuir_incubadora', 'log_alimentacion_grupal']);
  assert.deepEqual(blocked, []);
});

test('push: the whole chain lands on the server, atomically and attributed', async () => {
  const db = await openDb();
  const res = await pushAll(db);
  assert.equal(res.conflicts, 0, JSON.stringify(await listStuck(db)));
  assert.deepEqual(await listOpen(db), []);

  const inc = await one(`select estado, codigo, distribuida_por, individuos_total from app.incubadora where id = $1`, [S.inc]);
  assert.deepEqual(inc, { estado: 'distribuida', codigo: 'F7AR1', distribuida_por: 'Ricardo', individuos_total: 75000 });
  assert.equal(await count(`select count(*) n from app.bandeja where incubadora_id = $1 and protocolo = 'v2'`, [S.inc]), 3);
  const feeds = (await pg.query(`select a.carga, a.cantidad_kg, a.protocolo, a.tamizado from app.alimentacion a
                                   join app.bandeja b on b.id = a.bandeja_id where b.incubadora_id = $1
                                  order by a.carga`, [S.inc])).rows;
  assert.deepEqual(feeds.map(f => [f.carga, Number(f.cantidad_kg), f.protocolo, f.tamizado]),
    [[1, 1.5, 'v2', false], [1, 1.5, 'v2', false], [1, 1.5, 'v2', false],
     [2, 2, 'v2', true], [2, 2, 'v2', true], [2, 2, 'v2', true]]);
  const rec = await one(`select protocolo, peso_ovipositores_g, atrayente_cambiado, registrado_por from app.recoleccion where id = $1`, [S.rec]);
  assert.deepEqual([rec.protocolo, Number(rec.peso_ovipositores_g), rec.atrayente_cambiado, rec.registrado_por],
                   ['v2', 350, true, 'Maria']);
});

test('REGRESSION: a distribución queued after its recolecta synced does not wait on itself', async () => {
  // The distribución's own row is the incubadora it depends on. Counting its
  // own claim on that row made it wait for itself, forever.
  const db = await openDb();
  const rec = await w.createRecoleccionV2({ insectario_id: S.ins, peso_ovipositores_g: 310,
                                            atrayente_cambiado: true, fecha_inicio: addDays(HOY, -7) });
  await pushAll(db);
  assert.deepEqual(await listOpen(db), [], 'la recolecta ya está en el servidor');
  const d = await w.distribuirIncubadora(rec.data.incubadora.id, { n_bandejas: 1 });
  assert.ok(d.ok);
  const { ready } = await claimBatch(db);
  assert.deepEqual(ready.map(i => i.rpc), ['distribuir_incubadora']);
  assert.equal((await pushAll(db)).conflicts, 0);
});

test('carga 3, then días 14–15 fast for the whole distribución in one tap', async () => {
  assert.ok((await w.logCarga({ bandeja_ids: S.trays, carga: 3 })).ok);
  const res = await w.logAyunoGrupal({ bandeja_ids: S.trays, operator_name: 'Ricardo' });
  assert.ok(res.ok, JSON.stringify(res.error));
  assert.equal(res.data.created, 3);
  const late = await w.logCarga({ bandeja_ids: [S.trays[0]], carga: 3 });
  assert.equal(late.ok, false, 'en ayuno ya no se alimenta');

  const t = (await r.getBandejaDetail(S.trays[0])).data.bandeja;
  assert.equal(t.estado, 'en_ayuno');
  assert.equal(t.siguiente_paso.paso, 'cosecha');

  const res2 = await pushAll(await openDb());
  assert.equal(res2.conflicts, 0, JSON.stringify(await listStuck(await openDb())));
  assert.equal(await count(`select count(*) n from app.ayuno a join app.bandeja b on b.id = a.bandeja_id
                            where b.incubadora_id = $1 and a.peso_inicial_kg is null and a.protocolo = 'v2'`, [S.inc]), 3);
});

test('día 16 cosecha: larva al horno + 2 % al laboratorio; it closes the fast', async () => {
  const res = await w.logSeparacion({ bandeja_id: S.trays[0], larva_limpia_g: 4900, reserva_cria_g: 100,
                                      operator_name: 'Maria' });
  assert.ok(res.ok, JSON.stringify(res.error));
  const detail = (await r.getBandejaDetail(S.trays[0])).data;
  assert.equal(detail.bandeja.estado, 'cosechada');
  assert.equal(detail.bandeja.siguiente_paso, null, 'nada más que hacer');
  const ay = detail.eventos.find(e => e.tipo === 'ayuno');
  assert.ok(ay.cerrado_at, 'la cosecha cierra el ayuno');
  assert.equal(ay.abierto, false);
  assert.ok(!(await r.listAyunosAbiertos()).data.some(a => a.id === ay.id));

  const res2 = await pushAll(await openDb());
  assert.equal(res2.conflicts, 0, JSON.stringify(await listStuck(await openDb())));
  const sep = await one(`select protocolo, reserva_cria_g, larva_limpia_g from app.separacion where bandeja_id = $1`, [S.trays[0]]);
  assert.deepEqual([sep.protocolo, Number(sep.reserva_cria_g), Number(sep.larva_limpia_g)], ['v2', 100, 4900]);
  const cierre = await one(`select cerrado_at, cerrado_por, peso_final_kg from app.ayuno where bandeja_id = $1`, [S.trays[0]]);
  assert.ok(cierre.cerrado_at);
  assert.equal(cierre.cerrado_por, 'Maria');
  assert.equal(cierre.peso_final_kg, null);

  // The 98 % goes on to the oven exactly as before.
  const lote = await w.createLote({ separacion_ids: [res.data.id], peso_inicial_kg: 4.9, operator_name: 'Maria' });
  assert.ok(lote.ok, JSON.stringify(lote.error));
  assert.equal((await pushAll(await openDb())).conflicts, 0);
});

test('another phone distributed first: Descartar takes back every row and what depended on them', async () => {
  const db = await openDb();
  const rec = await w.createRecoleccionV2({ insectario_id: S.ins, peso_ovipositores_g: 300,
                                            atrayente_cambiado: true, fecha_inicio: addDays(HOY, -7) });
  const incId = rec.data.incubadora.id;
  await pushAll(db);

  // Phone B distributes on the server before this phone syncs.
  const theirs = [{ id: uid(), no_bandeja: 1, id_bandeja: 'F7AR2-01' }, { id: uid(), no_bandeja: 2, id_bandeja: 'F7AR2-02' }];
  await pg.query(`select app.distribuir_incubadora($1::jsonb, $2::jsonb, '[]'::jsonb)`,
    [JSON.stringify({ incubadora_id: incId, registrado_por: 'Jose' }), JSON.stringify(theirs)]);

  // This phone, offline, distributes too and feeds carga 2.
  const mine = await w.distribuirIncubadora(incId, { n_bandejas: 3 });
  const mineIds = mine.data.bandejas.map(b => b.id);
  assert.ok((await w.logCarga({ bandeja_ids: mineIds, carga: 2 })).ok);

  await pushAll(db);
  const conflicts = await listConflicts(db);
  const main = conflicts.find(c => c.rpc === 'distribuir_incubadora');
  assert.ok(main, 'la distribución repetida llega a Conflictos');
  assert.match(main.explanation, /ya fue distribuida/);
  assert.ok(conflicts.some(c => c.rpc === 'log_alimentacion_grupal' && c.reason === 'dependencia'),
    'la carga que dependía de esas bandejas espera, no falla por su cuenta');

  const res = await resolveConflict(db, main.id, 'discard');
  assert.ok(res.ok);
  assert.equal(res.data.afectados, 1, 'también se descartó la carga que dependía');

  const trays = (await r.listBandejas({})).data;
  assert.ok(!trays.some(t => mineIds.includes(t.id)), 'las bandejas que nunca llegaron ya no aparecen');
  const feeds = await allRows(db, 'alimentacion');
  assert.ok(!feeds.some(f => mineIds.includes(f.bandeja_id)), 'ni sus cargas');
  assert.deepEqual(await listOpen(db), [], 'nada queda en la cola');
  assert.equal((await listConflicts(db)).length, 0, 'ni en Conflictos');

  // The server's version comes back: distributed by the other phone, with its trays.
  await pullOnce(db);
  const inc = (await r.getIncubadoraDetail(incId)).data;
  assert.equal(inc.incubadora.estado, 'distribuida');
  assert.equal(inc.incubadora.distribuida_por, 'Jose');
  assert.deepEqual(inc.bandejas.map(b => b.id_bandeja), ['F7AR2-01', 'F7AR2-02']);
});

test('Reintentar also releases the work that was only waiting for it', async () => {
  const db = await openDb();
  useBackend(failOnce(server, 'crear_recoleccion_v2', { code: '42501', message: 'permiso denegado' }));
  const rec = await w.createRecoleccionV2({ insectario_id: S.ins, peso_ovipositores_g: 280,
                                            atrayente_cambiado: true, fecha_inicio: addDays(HOY, -7) });
  const dist = await w.distribuirIncubadora(rec.data.incubadora.id, { n_bandejas: 2 });
  await pushAll(db);
  const c = (await listConflicts(db)).find(x => x.rpc === 'crear_recoleccion_v2');
  assert.ok(c);
  assert.ok((await listConflicts(db)).some(x => x.rpc === 'distribuir_incubadora' && x.reason === 'dependencia'));

  useBackend(server);
  const res = await resolveConflict(db, c.id, 'retry');
  assert.equal(res.data.afectados, 1);
  const out = await pushAll(db);
  assert.equal(out.conflicts, 0);
  assert.equal((await listConflicts(db)).length, 0);
  assert.equal(await count(`select count(*) n from app.bandeja where incubadora_id = $1`, [rec.data.incubadora.id]), 2);
  assert.ok(dist.ok);
});

test('pickers show each value once after the server copy arrives', async () => {
  const db = await openDb();
  await putLocal(db, 'catalogo', [{ id: uid(), tipo: 'qc_color_dorado', valor: 'Tostado', orden: 4, activo: true, _seeded: true }]);
  await applyServerRows(db, 'catalogo', [{ id: uid(), tipo: 'qc_color_dorado', valor: 'Tostado', orden: 4, activo: true }]);
  const vals = (await r.listCatalogo('qc_color_dorado')).data;
  assert.equal(vals.filter(v => v === 'Tostado').length, 1);
  assert.ok(!(await allRows(db, 'catalogo')).some(c => c._seeded && c.valor === 'Tostado'));
});

test('a bulk load sharing one timestamp downloads completely (not just the first page)', async () => {
  const db = await openDb();
  const tray = S.trays[2];
  await pg.query(`insert into app.alimentacion (id, bandeja_id, fecha, tipo_alimento, cantidad_kg)
                  select gen_random_uuid(), $1, now(), 'Historico', 0.1 from generate_series(1, 1200)`, [tray]);
  const same = await one(`select count(distinct updated_at) n from app.alimentacion where tipo_alimento = 'Historico'`);
  assert.equal(Number(same.n), 1, 'the test only means something if they really share one timestamp');
  await pullOnce(db, { tables: ['alimentacion'] });
  const local = (await allRows(db, 'alimentacion')).filter(a => a.tipo_alimento === 'Historico');
  assert.equal(local.length, 1200);
});

test('old-protocol trays keep working exactly as before', async () => {
  const rec = await w.createRecoleccion({ insectario_id: S.ins, huevos_g: 1.2 });
  const b = await w.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 1 });
  assert.ok(b.ok);
  assert.equal(b.data.protocolo, 'v1');
  assert.ok((await w.logAlimentacion({ bandeja_id: b.data.id, tipo_alimento: 'Bagazo', cantidad_kg: 1 })).ok);
  assert.equal((await w.logCarga({ bandeja_ids: [b.data.id], carga: 2 })).ok, false, 'no se mezclan');
  assert.equal((await w.logAyuno({ bandeja_id: b.data.id })).ok, false, 'el ayuno v1 exige peso');
  assert.ok((await w.logAyuno({ bandeja_id: b.data.id, peso_inicial_kg: 2 })).ok);
  const out = await pushAll(await openDb());
  assert.equal(out.conflicts, 0);
  assert.equal((await one(`select protocolo from app.bandeja where id = $1`, [b.data.id])).protocolo, 'v1');
});
