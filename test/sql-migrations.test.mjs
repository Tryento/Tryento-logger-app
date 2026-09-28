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
import { freshPg, liveReplica, readSql, overloads, tableExists } from './helpers/pg.mjs';

const MIG = n => readSql(`supabase/migrations/${n}`);
const R0005 = '0005_renombrar_lote.sql';
const R0006 = '0006_sobrecargas.sql';

/** Functions the app calls; each must exist exactly once. */
const APP_FUNCTIONS = [
  'marcar_atractante', 'marcar_cierre', 'cerrar_ayuno', 'actualizar_qc_lote',
  'marcar_empacado', 'marcar_despachado', 'rechazar_lote', 'crear_lote',
  'log_alimentacion_grupal'
];
const VIEWS = [
  'v_rendimiento_bandeja', 'v_fcr_bandeja', 'v_tiempos_ciclo',
  'v_productividad_insectario', 'v_rendimiento_lote', 'v_actividad_operario',
  'v_consumo_alimento', 'v_calidad_datos', 'v_bandejas_activas',
  'v_insectarios_activos', 'v_lotes_activos', 'v_estado_drift', 'v_nombres_registrados'
];

async function assertOneOverloadEach(db) {
  for (const fn of APP_FUNCTIONS) {
    const sigs = await overloads(db, fn);
    assert.equal(sigs.length, 1, `${fn} debe existir una sola vez; hay: ${sigs.join(' | ') || '(ninguna)'}`);
  }
}

async function assertViewsQueryable(db) {
  for (const v of VIEWS) {
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
  await assertOneOverloadEach(db);
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

  await assertViewsQueryable(db);
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

test('0005 and 0006 are safe to run twice', async () => {
  const db = await liveReplica();
  for (let i = 0; i < 2; i++) {
    await db.exec(await MIG(R0005));
    await db.exec(await MIG(R0006));
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
