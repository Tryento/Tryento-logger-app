/**
 * Migrations, run in a REAL Postgres (PGlite).
 *
 * Syntax checking passed every one of these files while production was broken
 * by them. What matters is what happens when they run — against a fresh
 * database AND against a replica of the live one, built from the migrations
 * exactly as they were when they were applied (test/helpers/pg.mjs).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uid } from 'node:crypto';
import { freshPg, liveReplica, readSql, overloads, tableExists } from './helpers/pg.mjs';

const MIG = n => readSql(`supabase/migrations/${n}`);
const R0005 = '0005_renombrar_lote.sql';
const R0006 = '0006_sobrecargas.sql';
const R0007 = '0007_protocolo_v2.sql';

/** Functions the app calls; each must exist exactly once. */
const APP_FUNCTIONS = [
  'marcar_atractante', 'marcar_cierre', 'cerrar_ayuno', 'actualizar_qc_lote',
  'marcar_empacado', 'marcar_despachado', 'rechazar_lote', 'crear_lote',
  'log_alimentacion_grupal', 'crear_recoleccion_v2', 'distribuir_incubadora'
];
const VIEWS = [
  'v_rendimiento_bandeja', 'v_fcr_bandeja', 'v_tiempos_ciclo',
  'v_productividad_insectario', 'v_rendimiento_lote', 'v_actividad_operario',
  'v_consumo_alimento', 'v_calidad_datos', 'v_bandejas_activas',
  'v_insectarios_activos', 'v_lotes_activos', 'v_estado_drift', 'v_nombres_registrados',
  'v_incubadoras_activas'
];

/** Production as it will be once the user runs the pending files, in order. */
async function productionAfterRelease1() {
  const db = await liveReplica();
  await db.exec(await MIG(R0005));
  await db.exec(await MIG(R0006));
  await db.exec(await MIG(R0007));
  return db;
}

/** What exists once 0005 + 0006 ran, before 0007 adds the v2 functions. */
const LOTE_FUNCTIONS = APP_FUNCTIONS.filter(f => !['crear_recoleccion_v2', 'distribuir_incubadora'].includes(f));

async function assertOneOverloadEach(db, fns = APP_FUNCTIONS) {
  for (const fn of fns) {
    const sigs = await overloads(db, fn);
    assert.equal(sigs.length, 1, `${fn} debe existir una sola vez; hay: ${sigs.join(' | ') || '(ninguna)'}`);
  }
}

async function assertViewsQueryable(db, views = VIEWS) {
  for (const v of views) {
    await db.query(`select * from app.${v} limit 1`)
      .catch(e => assert.fail(`la vista ${v} no se puede consultar: ${e.message}`));
  }
}

/** Seed a minimal chain up to one separated tray, returning ids. */
async function seedChain(db, prefix) {
  const q = (s, p) => db.query(s, p);
  const ins = (await q(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio)
                        values (gen_random_uuid(), $1, 'ICA', '2026-09-01') returning id`, [prefix + '-INS'])).rows[0].id;
  const rec = (await q(`insert into app.recoleccion (id, insectario_id, recolecta, fecha)
                        values (gen_random_uuid(), $1, '1', now()) returning id`, [ins])).rows[0].id;
  const ban = (await q(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha)
                        values (gen_random_uuid(), $1, 1, $2, now()) returning id`, [rec, prefix + '.1'])).rows[0].id;
  const sep = (await q(`insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g)
                        values (gen_random_uuid(), $1, now(), 410) returning id`, [ban])).rows[0].id;
  return { ins, rec, ban, sep };
}

async function runLoteLifecycle(db, sepId, codigo) {
  const id = (await db.query(`select gen_random_uuid() as id`)).rows[0].id;
  await db.query(`select app.crear_lote($1::jsonb, $2::uuid[])`,
    [JSON.stringify({ id, codigo, fecha: new Date().toISOString(), peso_inicial_kg: 0.41 }), [sepId]]);
  await db.query(`select app.actualizar_qc_lote($1, 14, 0.11, 'Muy Crujiente', 'quiebre limpio', true, null, 'Maria')`, [id]);
  await db.query(`select app.marcar_empacado($1, null, 'Maria')`, [id]);
  await db.query(`select app.marcar_despachado($1, 'Ricardo')`, [id]);
  const r = (await db.query(`select estado, qc_por, empacado_por, despachado_por, qc_prueba_crujiente
                               from app.lote where id = $1`, [id])).rows[0];
  return { id, ...r };
}

/* ── fresh install ─────────────────────────────────────────────────────── */

test('fresh install: SETUP_COMPLETO applies on an empty database', async () => {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  assert.ok(await tableExists(db, 'lote'));
  assert.ok(await tableExists(db, 'lote_separacion'));
  assert.ok(!await tableExists(db, 'cochada'));
});

test('fresh install: every function the app calls exists exactly once', async () => {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  await assertOneOverloadEach(db);
});

test('fresh install: the whole lote lifecycle works, with attribution', async () => {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  const { sep } = await seedChain(db, 'F');
  const lote = await runLoteLifecycle(db, sep, 'CO-FRESH');
  assert.equal(lote.estado, 'despachado');
  assert.equal(lote.qc_por, 'Maria');
  assert.equal(lote.empacado_por, 'Maria');
  assert.equal(lote.despachado_por, 'Ricardo');
  assert.equal(lote.qc_prueba_crujiente, 'quiebre limpio', 'las notas de la prueba crujiente se guardan');
  await assertViewsQueryable(db);
});

test('SETUP_COMPLETO is for EMPTY databases only (never tell anyone to re-run it)', async () => {
  // The old 0005 instructions said to re-run it on production. It fails on its
  // first statement, which is why 0005 now recreates everything itself.
  const db = await liveReplica();
  await assert.rejects(db.exec(await readSql('supabase/SETUP_COMPLETO.sql')), /already exists/);
});

/* ── the live database ─────────────────────────────────────────────────── */

test('live replica reproduces the production defects (so the fix is tested against them)', async () => {
  const db = await liveReplica();
  assert.ok(await tableExists(db, 'cochada'), 'la replica debe tener los nombres viejos');
  assert.equal((await overloads(db, 'marcar_despachado')).length, 2, 'la replica debe tener la sobrecarga duplicada');
  await assert.rejects(
    db.query(`select app.marcar_despachado('00000000-0000-4000-8000-000000000000'::uuid)`),
    /is not unique/, 'la llamada sin p_por es ambigua en producción hoy');
});

test('0005 + 0006 on the live replica: data kept, names changed, functions work', async () => {
  const db = await liveReplica();

  // Data that exists before the fix, created with the production functions.
  const { sep } = await seedChain(db, 'L');
  const cid = (await db.query(`select gen_random_uuid() as id`)).rows[0].id;
  await db.query(`select app.crear_cochada($1::jsonb, $2::uuid[])`,
    [JSON.stringify({ id: cid, codigo: 'CO-LIVE', fecha: new Date().toISOString(), peso_inicial_kg: 0.41 }), [sep]]);

  await db.exec(await MIG(R0005));
  await db.exec(await MIG(R0006));

  // Names.
  assert.ok(await tableExists(db, 'lote'));
  assert.ok(await tableExists(db, 'lote_separacion'));
  assert.ok(!await tableExists(db, 'cochada'));
  assert.ok(!await tableExists(db, 'cochada_separacion'));

  // Data survived and the join column was renamed.
  const lote = (await db.query(`select codigo from app.lote where id = $1`, [cid])).rows[0];
  assert.equal(lote.codigo, 'CO-LIVE');
  const link = (await db.query(`select lote_id from app.lote_separacion where separacion_id = $1`, [sep])).rows[0];
  assert.equal(link.lote_id, cid);

  // Functions: exactly one of each, none left pointing at cochada.
  await assertOneOverloadEach(db, LOTE_FUNCTIONS);
  const stale = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and (p.prosrc ilike '%cochada%' or p.proname ilike '%cochada%')`);
  assert.deepEqual(stale.rows, [], 'ninguna función puede seguir mencionando cochada');

  // The migrated lote goes through the rest of its life.
  await db.query(`select app.actualizar_qc_lote($1, 14, 0.11, null, null, true, null, 'Maria')`, [cid]);
  await db.query(`select app.marcar_empacado($1, null, 'Maria')`, [cid]);
  await db.query(`select app.marcar_despachado($1, 'Ricardo')`, [cid]);
  const after = (await db.query(`select estado, despachado_por from app.lote where id = $1`, [cid])).rows[0];
  assert.equal(after.estado, 'despachado');
  assert.equal(after.despachado_por, 'Ricardo');

  // And new lotes can be created.
  const { sep: sep2 } = await seedChain(db, 'L2');
  const fresh = await runLoteLifecycle(db, sep2, 'CO-NEW');
  assert.equal(fresh.estado, 'despachado');

  await assertViewsQueryable(db, VIEWS.filter(v => v !== 'v_incubadoras_activas'));
  const cols = await db.query(`select column_name from information_schema.columns
                                where table_schema = 'app' and table_name = 'v_tiempos_ciclo'`);
  assert.ok(cols.rows.some(r => r.column_name === 'dias_separacion_a_lote'));
});

test('after 0006, calls WITHOUT p_por work again (older phones)', async () => {
  const db = await liveReplica();
  await db.exec(await MIG(R0005));
  await db.exec(await MIG(R0006));
  const NOBODY = '00000000-0000-4000-8000-000000000000';
  await db.query(`select app.marcar_despachado($1::uuid)`, [NOBODY]);
  await db.query(`select app.marcar_atractante($1::uuid, current_date)`, [NOBODY]);
  await db.query(`select app.marcar_empacado($1::uuid, null::date)`, [NOBODY]);
});

test('0005, 0006 and 0007 are safe to run twice', async () => {
  const db = await liveReplica();
  for (let i = 0; i < 2; i++) {
    await db.exec(await MIG(R0005));
    await db.exec(await MIG(R0006));
    await db.exec(await MIG(R0007));
  }
  await assertOneOverloadEach(db);
  await assertViewsQueryable(db);
});

test('0005 run by mistake on a NEW database changes nothing and breaks nothing', async () => {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  await db.exec(await MIG(R0005));
  await db.exec(await MIG(R0006));
  await assertOneOverloadEach(db);
  const { sep } = await seedChain(db, 'M');
  const lote = await runLoteLifecycle(db, sep, 'CO-MISTAKE');
  assert.equal(lote.estado, 'despachado');
  await assertViewsQueryable(db);
});

/* ── 0007: protocolo v2 ────────────────────────────────────────────────── */

const T0 = '2026-09-01T14:00:00.000Z';
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];

/**
 * The whole v2 cycle through the functions the app calls:
 * recolecta + incubadora → distribución (3 bandejas + carga 1) → carga 2.
 */
async function v2Chain(db, { codigo = 'F7AR9', recolecta = '9', nombre = 'ICA' } = {}) {
  const ins = uid(), rec = uid(), inc = uid();
  await db.query(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio, generacion_moscas)
                  values ($1, $2, $3, '2026-08-01', 'F7')`, [ins, `${nombre}-${codigo}`, nombre]);

  await db.query(`select app.crear_recoleccion_v2($1::jsonb, $2::jsonb)`, [
    JSON.stringify({ id: rec, insectario_id: ins, recolecta, fecha: T0, peso_ovipositores_g: 350,
                     atrayente_cambiado: true, registrado_por: 'Maria', created_at: T0 }),
    JSON.stringify({ id: inc, codigo, fecha_inicio: '2026-09-01', starter_kg: 2, registrado_por: 'Maria' })
  ]);

  const bandejas = [1, 2, 3].map(n => ({ id: uid(), no_bandeja: n, id_bandeja: `${codigo}-0${n}`, individuos: 25000 }));
  const grupal = uid();
  const carga1 = bandejas.map(b => ({ id: uid(), bandeja_id: b.id, cantidad_kg: 1.5, carga: 1,
                                      tipo_alimento: 'Ensilaje', grupal_id: grupal }));
  const distribucion = { incubadora_id: inc, fecha: '2026-09-08T13:00:00.000Z',
                         registrado_por: 'Ricardo', individuos_total: 75000 };
  await db.query(`select app.distribuir_incubadora($1::jsonb, $2::jsonb, $3::jsonb)`,
    [JSON.stringify(distribucion), JSON.stringify(bandejas), JSON.stringify(carga1)]);

  const grupal2 = uid();
  const carga2 = bandejas.map(b => ({ id: uid(), bandeja_id: b.id, fecha: '2026-09-11T13:00:00.000Z',
    tipo_alimento: 'Ensilaje', cantidad_kg: 2.0, carga: 2, tamizado: true, grupal_id: grupal2,
    registrado_por: 'Maria', created_at: '2026-09-11T13:00:05.000Z' }));
  await db.query(`select app.log_alimentacion_grupal($1::jsonb)`, [JSON.stringify(carga2)]);

  return { ins, rec, inc, bandejas, distribucion, carga1 };
}

test('0007 on production: existing rows become v1 without being re-downloaded', async () => {
  const db = await liveReplica();
  const { ins, rec, ban, sep } = await seedChain(db, 'OLD');
  const alim = uid(), ay = uid();
  await db.query(`insert into app.alimentacion (id, bandeja_id, fecha, tipo_alimento, cantidad_kg)
                  values ($1, $2, now(), 'Bagazo', 1.2)`, [alim, ban]);
  await db.query(`insert into app.ayuno (id, bandeja_id, fecha, peso_inicial_kg) values ($1, $2, now(), 3.1)`, [ay, ban]);
  const stamp = async () => (await db.query(`
    select 'r' k, updated_at from app.recoleccion where id = $1 union all
    select 'b', updated_at from app.bandeja      where id = $2 union all
    select 'a', updated_at from app.alimentacion where id = $3 union all
    select 'y', updated_at from app.ayuno        where id = $4 union all
    select 's', updated_at from app.separacion   where id = $5 order by 1`, [rec, ban, alim, ay, sep])).rows;
  const before = await stamp();

  await db.exec(await MIG(R0005));
  await db.exec(await MIG(R0006));
  await db.exec(await MIG(R0007));

  assert.deepEqual(await stamp(), before, 'agregar columnas no debe tocar updated_at: los teléfonos bajarían todo otra vez');
  for (const [t, id] of [['recoleccion', rec], ['bandeja', ban], ['alimentacion', alim], ['ayuno', ay], ['separacion', sep]]) {
    assert.equal((await one(db, `select protocolo from app.${t} where id = $1`, [id])).protocolo, 'v1', `${t} queda v1`);
  }
  assert.ok(ins);
  await assertOneOverloadEach(db);
  await assertViewsQueryable(db);
});

test('0007: the full v2 cycle, with attribution, on production after Release 1', async () => {
  const db = await productionAfterRelease1();
  const c = await v2Chain(db);

  const rec = await one(db, `select protocolo, peso_ovipositores_g, atrayente_cambiado, huevos_g from app.recoleccion where id = $1`, [c.rec]);
  assert.equal(rec.protocolo, 'v2');
  assert.equal(Number(rec.peso_ovipositores_g), 350);
  assert.equal(rec.atrayente_cambiado, true);
  assert.equal(rec.huevos_g, null, 'en v2 no se pesan huevos');

  const inc = await one(db, `select estado, distribuida_por, individuos_total, codigo from app.incubadora where id = $1`, [c.inc]);
  assert.equal(inc.estado, 'distribuida');
  assert.equal(inc.distribuida_por, 'Ricardo');
  assert.equal(inc.individuos_total, 75000);

  const trays = (await db.query(`select protocolo, recoleccion_id, incubadora_id, estado, individuos, registrado_por
                                   from app.bandeja where incubadora_id = $1 order by no_bandeja`, [c.inc])).rows;
  assert.equal(trays.length, 3);
  for (const t of trays) {
    assert.equal(t.protocolo, 'v2');
    assert.equal(t.recoleccion_id, c.rec, 'la bandeja v2 sigue unida a su recolecta');
    assert.equal(t.estado, 'en_crecimiento');
    assert.equal(t.individuos, 25000);
    assert.equal(t.registrado_por, 'Ricardo');
  }

  const feeds = (await db.query(`select a.carga, a.protocolo, a.cantidad_kg, a.tamizado, a.registrado_por, a.created_at
                                   from app.alimentacion a join app.bandeja b on b.id = a.bandeja_id
                                  where b.incubadora_id = $1 order by a.carga`, [c.inc])).rows;
  assert.equal(feeds.length, 6);
  assert.deepEqual(feeds.map(f => f.carga), [1, 1, 1, 2, 2, 2]);
  assert.ok(feeds.every(f => f.protocolo === 'v2'), 'el protocolo del evento es el de su bandeja');
  assert.ok(feeds.filter(f => f.carga === 2).every(f => f.tamizado === true));
  assert.ok(feeds.filter(f => f.carga === 1).every(f => f.registrado_por === 'Ricardo'));
  assert.equal(new Date(feeds[5].created_at).toISOString(), '2026-09-11T13:00:05.000Z', 'se guarda cuándo se anotó');

  // Days 14–15: a one-tap fast, no scale.
  const tray = c.bandejas[0].id;
  const ay = uid();
  await db.query(`insert into app.ayuno (id, bandeja_id, fecha, horas_ayuno, registrado_por)
                  values ($1, $2, '2026-09-15T12:00:00Z', 48, 'Maria')`, [ay, tray]);
  assert.equal((await one(db, `select estado from app.bandeja where id = $1`, [tray])).estado, 'en_ayuno');
  const ayRow = await one(db, `select protocolo, peso_inicial_kg from app.ayuno where id = $1`, [ay]);
  assert.equal(ayRow.protocolo, 'v2');
  assert.equal(ayRow.peso_inicial_kg, null);

  // Day 16: the harvest closes the fast, again without weights.
  await db.query(`select app.cerrar_ayuno($1, null, '2026-09-17T12:00:00Z', 'Maria')`, [ay]);
  const closed = await one(db, `select cerrado_at, cerrado_por, peso_final_kg from app.ayuno where id = $1`, [ay]);
  assert.ok(closed.cerrado_at);
  assert.equal(closed.cerrado_por, 'Maria');
  assert.equal(closed.peso_final_kg, null);

  const sep = uid();
  await db.query(`insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g, reserva_cria_g, registrado_por)
                  values ($1, $2, '2026-09-17T12:30:00Z', 4900, 100, 'Maria')`, [sep, tray]);
  assert.equal((await one(db, `select protocolo from app.separacion where id = $1`, [sep])).protocolo, 'v2');
  assert.equal((await one(db, `select estado from app.bandeja where id = $1`, [tray])).estado, 'cosechada');

  // The 98 % goes on to baking exactly as before.
  const lote = await runLoteLifecycle(db, sep, 'CO-V2');
  assert.equal(lote.estado, 'despachado');

  const prod = await one(db, `select n_recolecciones_v2, peso_ovipositores_g_total, kg_larva_v2, kg_reserva_cria_total
                                from app.v_productividad_insectario where id = $1`, [c.ins]);
  assert.equal(Number(prod.n_recolecciones_v2), 1);
  assert.equal(Number(prod.peso_ovipositores_g_total), 350);
  assert.equal(Number(prod.kg_larva_v2), 4.9);
  assert.equal(Number(prod.kg_reserva_cria_total), 0.1);

  const ciclo = await one(db, `select dia_ciclo_cosecha, protocolo from app.v_tiempos_ciclo where bandeja_id = $1`, [tray]);
  assert.equal(ciclo.dia_ciclo_cosecha, 16, 'la cosecha cae en el día 16 del ciclo');
  await assertViewsQueryable(db);
});

test('0007: a v1 fast still needs its weights', async () => {
  const db = await productionAfterRelease1();
  const { ban } = await seedChain(db, 'W');
  await assert.rejects(
    db.query(`insert into app.ayuno (id, bandeja_id, fecha) values ($1, $2, now())`, [uid(), ban]),
    /ck_ayuno_peso_v1/);
  const ay = uid();
  await db.query(`insert into app.ayuno (id, bandeja_id, fecha, peso_inicial_kg) values ($1, $2, now(), 3)`, [ay, ban]);
  await assert.rejects(db.query(`select app.cerrar_ayuno($1, null, now())`, [ay]), /ck_ayuno_cierre/,
    'cerrar un ayuno v1 exige peso final, como siempre');
  await db.query(`select app.cerrar_ayuno($1, 2.8, now())`, [ay]);
  assert.equal(Number((await one(db, `select merma_pct from app.ayuno where id = $1`, [ay])).merma_pct).toFixed(3), '6.667');
});

test('0007: calls from phones on the previous build keep working', async () => {
  const db = await productionAfterRelease1();
  const { ban } = await seedChain(db, 'OLDAPP');
  const ay = uid();
  await db.query(`insert into app.ayuno (id, bandeja_id, fecha, peso_inicial_kg) values ($1, $2, now(), 3)`, [ay, ban]);
  // Three arguments, no p_por: exactly what the previous build sends.
  await db.query(`select app.cerrar_ayuno(p_id => $1, p_peso => 2.9, p_at => now())`, [ay]);
  assert.equal(Number((await one(db, `select peso_final_kg from app.ayuno where id = $1`, [ay])).peso_final_kg), 2.9);

  const row = { id: uid(), bandeja_id: ban, fecha: new Date().toISOString(), tipo_alimento: 'Bagazo',
                cantidad_kg: 1, grupal_id: uid(), notas: '', registrado_por: 'Maria' };
  await db.query(`select app.log_alimentacion_grupal($1::jsonb)`, [JSON.stringify([row])]);
  const a = await one(db, `select carga, tamizado, protocolo from app.alimentacion where id = $1`, [row.id]);
  assert.deepEqual(a, { carga: null, tamizado: false, protocolo: 'v1' });
});

test('0007: a distribution is all-or-nothing, and happens once', async () => {
  const db = await productionAfterRelease1();
  const c = await v2Chain(db);

  // Same call again (the phone never got the answer): nothing duplicated.
  await db.query(`select app.distribuir_incubadora($1::jsonb, $2::jsonb, $3::jsonb)`,
    [JSON.stringify(c.distribucion), JSON.stringify(c.bandejas), JSON.stringify(c.carga1)]);
  assert.equal(Number((await one(db, `select count(*) n from app.bandeja where incubadora_id = $1`, [c.inc])).n), 3);

  // A second phone distributing the same incubadora with its own trays.
  const other = [{ id: uid(), no_bandeja: 1, id_bandeja: 'F7AR9-01' }];
  await assert.rejects(
    db.query(`select app.distribuir_incubadora($1::jsonb, $2::jsonb, '[]'::jsonb)`,
      [JSON.stringify(c.distribucion), JSON.stringify(other)]),
    err => err.code === '23505' && /ya fue distribuida/.test(err.message));

  // A bad tray in the batch: nothing is written and the incubadora is untouched.
  const c2 = await v2Chain(db, { codigo: 'F7AR10', recolecta: '10', nombre: 'ICB' });
  const inc3 = uid(), rec3 = uid();
  await db.query(`select app.crear_recoleccion_v2($1::jsonb, $2::jsonb)`, [
    JSON.stringify({ id: rec3, insectario_id: c2.ins, recolecta: '11', fecha: T0 }),
    JSON.stringify({ id: inc3, codigo: 'F7BR11', fecha_inicio: '2026-09-01' })]);
  const bad = [{ id: uid(), no_bandeja: 1, id_bandeja: 'F7BR11-01' }, { id: uid(), no_bandeja: 0, id_bandeja: 'F7BR11-00' }];
  await assert.rejects(db.query(`select app.distribuir_incubadora($1::jsonb, $2::jsonb, '[]'::jsonb)`,
    [JSON.stringify({ incubadora_id: inc3 }), JSON.stringify(bad)]));
  assert.equal(Number((await one(db, `select count(*) n from app.bandeja where incubadora_id = $1`, [inc3])).n), 0);
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc3])).estado, 'incubando');
});

test('0007: every new function validates before writing (safe to probe)', async () => {
  const db = await productionAfterRelease1();
  await assert.rejects(db.query(`select app.crear_recoleccion_v2('{}'::jsonb, '{}'::jsonb)`), err => err.code === '22023');
  await assert.rejects(db.query(`select app.distribuir_incubadora('{}'::jsonb, '[]'::jsonb, '[]'::jsonb)`), err => err.code === '22023');
  assert.equal(Number((await one(db, `select count(*) n from app.recoleccion`)).n), 0);
  assert.equal(Number((await one(db, `select count(*) n from app.incubadora`)).n), 0);
});

test('0007: a recolecta number or an incubadora code cannot be used twice', async () => {
  const db = await productionAfterRelease1();
  const c = await v2Chain(db);
  // Another phone, same insectario, same recolecta number.
  await assert.rejects(db.query(`select app.crear_recoleccion_v2($1::jsonb, $2::jsonb)`, [
    JSON.stringify({ id: uid(), insectario_id: c.ins, recolecta: '9', fecha: T0 }),
    JSON.stringify({ id: uid(), codigo: 'F7AR9-otro', fecha_inicio: '2026-09-01' })]),
    err => err.code === '23505' && /ux_recoleccion_ordinal/.test(err.message));
  // Same code on a different recolecta.
  await assert.rejects(db.query(`select app.crear_recoleccion_v2($1::jsonb, $2::jsonb)`, [
    JSON.stringify({ id: uid(), insectario_id: c.ins, recolecta: '12', fecha: T0 }),
    JSON.stringify({ id: uid(), codigo: 'F7AR9', fecha_inicio: '2026-09-01' })]),
    err => err.code === '23505' && /ux_incubadora_codigo/.test(err.message));
  // Neither attempt left half a record behind.
  assert.equal(Number((await one(db, `select count(*) n from app.recoleccion where insectario_id = $1`, [c.ins])).n), 1);
});

test('0007: an old app cannot label v2 work as v1', async () => {
  const db = await productionAfterRelease1();
  const c = await v2Chain(db);
  const id = uid();
  await db.query(`insert into app.alimentacion (id, bandeja_id, fecha, tipo_alimento, cantidad_kg, protocolo)
                  values ($1, $2, now(), 'Bagazo', 1, 'v1')`, [id, c.bandejas[1].id]);
  assert.equal((await one(db, `select protocolo from app.alimentacion where id = $1`, [id])).protocolo, 'v2');
  // And a v2 tray without its incubadora is refused outright.
  await assert.rejects(db.query(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha, protocolo)
                                 values ($1, $2, 9, 'X', now(), 'v2')`, [uid(), c.rec]), /ck_bandeja_v2_incubadora/);
});

test('0007: egg grams are counted once per recolecta, not once per tray', async () => {
  const db = await productionAfterRelease1();
  const { ins, rec } = await seedChain(db, 'FAN');
  await db.query(`update app.recoleccion set huevos_g = 10 where id = $1`, [rec]);
  for (const n of [2, 3]) {
    await db.query(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha)
                    values ($1, $2, $3, $4, now())`, [uid(), rec, n, `FAN.${n}`]);
  }
  const p = await one(db, `select huevos_g_total, n_bandejas from app.v_productividad_insectario where id = $1`, [ins]);
  assert.equal(Number(p.n_bandejas), 3);
  assert.equal(Number(p.huevos_g_total), 10, 'antes daba 30: 10 g por cada una de las 3 bandejas');
});

test('0007: the data-quality view flags a carga logged twice', async () => {
  const db = await productionAfterRelease1();
  const c = await v2Chain(db);
  const again = [{ id: uid(), bandeja_id: c.bandejas[0].id, fecha: new Date().toISOString(),
                   tipo_alimento: 'Ensilaje', cantidad_kg: 2, carga: 2, grupal_id: uid() }];
  await db.query(`select app.log_alimentacion_grupal($1::jsonb)`, [JSON.stringify(again)]);
  const q = await one(db, `select n from app.v_calidad_datos where problema = 'carga_repetida'`);
  assert.equal(Number(q.n), 1);
});

test('fresh install: SETUP_COMPLETO runs the v2 cycle and seeds the protocol settings', async () => {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  const c = await v2Chain(db);
  assert.equal(Number((await one(db, `select count(*) n from app.bandeja where incubadora_id = $1`, [c.inc])).n), 3);
  const keys = (await db.query(`select clave from app.parametro order by clave`)).rows.map(r => r.clave);
  for (const k of ['cargas', 'dia_cosecha', 'dia_inicio_ayuno', 'dias_incubacion', 'fecha_corte',
                   'horas_ayuno', 'individuos_por_bandeja', 'letras_insectario', 'reserva_cria_pct']) {
    assert.ok(keys.includes(k), `falta el parámetro ${k}`);
  }
  const cargas = (await one(db, `select valor from app.parametro where clave = 'cargas'`)).valor;
  assert.deepEqual(cargas.map(x => [x.dia, x.kg]), [[7, 1.5], [10, 2], [13, 2]]);
  await assertOneOverloadEach(db);
});
