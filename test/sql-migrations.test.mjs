/**
 * Migrations, run in a REAL Postgres (PGlite).
 *
 * Syntax checking passed every file that ever broke production. What matters
 * is what happens when they run — against a fresh database AND against a
 * replica of the live one, built from the migrations exactly as they were when
 * they were applied (test/helpers/pg.mjs).
 *
 * 0010 rebuilds the schema for the lab's new protocols; 0001–0009 stay in the
 * folder as history. So, now:
 *   - a fresh install (SETUP_COMPLETO.sql, which starts at 0010) works;
 *   - 0010 over production as it is today keeps the people's names and
 *     removes everything else;
 *   - running it again deletes nothing new;
 *   - every trigger and call the app relies on behaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uid } from 'node:crypto';
import { freshPg, liveReplica, readSql, overloads, tableExists } from './helpers/pg.mjs';

const MIG = n => readSql(`supabase/migrations/${n}`);
const R0010 = '0010_ciclo_nuevo.sql';
/** Run in production after the replica's starting point and before 0010. */
const SINCE_REPLICA = ['0005_renombrar_lote.sql', '0006_sobrecargas.sql', '0007_protocolo_v2.sql',
                       '0008_alimento.sql', '0009_monitor.sql'];

const TABLES = [
  'catalogo', 'parametro', 'rack', 'contenedor', 'jaula', 'recepcion', 'ensilado',
  'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
  'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
  'bandeja_pupacion', 'jaula_evento', 'movimiento'
];
const OLD_TABLES = [
  'insectario', 'recoleccion', 'bandeja', 'ayuno', 'revision', 'lote', 'lote_separacion',
  'ayuno_huerfano', 'migracion_log', 'recepcion_alimento', 'ensilaje', 'ensilaje_insumo',
  'ensilaje_lectura'
];
/** Functions the app calls; each must exist exactly once. */
const RPCS = ['distribuir', 'crear_cochada', 'ingresar', 'crear_ensilado', 'abrir_ensilado',
              'cerrar_objeto', 'editar', 'marcar_revisado'];

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const count = async (db, sql, params) => (await one(db, sql, params)).n;
const json = v => JSON.stringify(v);
const code = c => err => err.code === c;

/** Production today: the live replica plus every file run there since. */
async function productionToday() {
  const db = await liveReplica();
  for (const f of SINCE_REPLICA) await db.exec(await MIG(f));
  return db;
}

async function fresh() {
  const db = await freshPg();
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  return db;
}

async function assertOneOverloadEach(db) {
  for (const fn of RPCS) {
    const sigs = await overloads(db, fn);
    assert.equal(sigs.length, 1, `${fn} debe existir una sola vez; hay: ${sigs.join(' | ') || '(ninguna)'}`);
  }
}

/* ── small builders, in the shape the app sends ─────────────────────────── */

async function rack(db, codigo) {
  const id = uid();
  await db.query(`insert into app.rack (id, codigo) values ($1, $2)`, [id, codigo]);
  return id;
}

async function jaula(db, { letra = 'A', nombre = 'ICA', gen = 7, fase = 'activa' } = {}) {
  const id = uid();
  await db.query(`insert into app.jaula (id, nombre, letra, lugar, generacion_inicial, fase_inicial, registrado_por)
                  values ($1, $2, $3, 'Galpón 1', $4, $5, 'Maria')`, [id, nombre, letra, gen, fase]);
  return id;
}

async function incubadora(db, { jaulaId, codigo = 'F7A-1', gen = 7, numero = 1,
                                at = '2026-10-20T03:30:00Z', rackId = null } = {}) {
  const id = uid();
  await db.query(`insert into app.incubadora (id, codigo, jaula_id, generacion, numero, recolecta_at, rack_id,
                    peso_inicial_g, alimento_inicial_kg, registrado_por)
                  values ($1, $2, $3, $4, $5, $6, $7, 12.5, 2, 'Maria')`,
                 [id, codigo, jaulaId, gen, numero, at, rackId]);
  return id;
}

/** distribución with n cajas and their carga 1. */
function distribucionDe(incId, n = 2, { rackId = null } = {}) {
  const dist = { id: uid(), incubadora_id: incId, fecha: '2026-10-26T13:00:00Z',
                 peso_total_kg: 0.9 * n, registrado_por: 'Ricardo' };
  const cajas = Array.from({ length: n }, (_, i) => ({
    id: uid(), codigo: `F7A-1-0${i + 1}`, numero: i + 1, rack_id: rackId, peso_inicial_kg: 0.9
  }));
  const cargas = cajas.map(c => ({ id: uid(), caja_id: c.id, carga: 1, fecha: dist.fecha,
                                   kg: 1.5, kg_plan: 1.5, dia_plan: 7 }));
  return { dist, cajas, cargas };
}

const distribuir = (db, { dist, cajas, cargas }) =>
  db.query(`select app.distribuir($1::jsonb, $2::jsonb, $3::jsonb)`, [json(dist), json(cajas), json(cargas)]);

/* ── fresh install ─────────────────────────────────────────────────────── */

test('fresh install: SETUP_COMPLETO builds the new schema and seeds it', async () => {
  const db = await fresh();
  for (const t of TABLES) assert.ok(await tableExists(db, t), `falta la tabla ${t}`);
  for (const t of OLD_TABLES) assert.ok(!(await tableExists(db, t)), `${t} es del protocolo anterior`);
  await assertOneOverloadEach(db);

  const claves = (await db.query(`select clave from app.parametro order by clave`)).rows.map(r => r.clave);
  assert.deepEqual(claves, [
    'alimento_inicial_incubadora_kg', 'cargas', 'dia_chequeo_incubadora', 'dia_distribucion',
    'dia_inicio_ayuno', 'dia_separacion', 'dias_chequeo_caja', 'dias_ciclo_jaula', 'dias_maduracion',
    'dias_recolecta', 'horas_consumo', 'kg_bandeja_pupacion', 'pct_coccion'
  ]);
  const cargas = (await one(db, `select valor from app.parametro where clave = 'cargas'`)).valor;
  assert.deepEqual(cargas, [{ n: 1, dia: 7, kg: 1.5 }, { n: 2, dia: 10, kg: 2 }, { n: 3, dia: 13, kg: 2 }]);
  assert.equal((await one(db, `select valor from app.parametro where clave = 'alimento_inicial_incubadora_kg'`)).valor,
               null, 'por definir antes del arranque');

  const listas = (await db.query(`select tipo, valor from app.catalogo order by tipo, orden`)).rows;
  assert.deepEqual(listas.map(r => `${r.tipo}:${r.valor}`), [
    'material_alimento:Bagazo de cerveza (BSG)', 'material_alimento:Desecho de panadería',
    'material_alimento:Desecho de fruta', 'material_alimento:Otro',
    'operario:Maria', 'operario:Ricardo'
  ]);
  assert.equal(await count(db, `select count(*)::int n from storage.buckets where id = 'fotos' and public`), 1);
  assert.equal(await count(db, `select count(*)::int n from pg_namespace where nspname = 'historico'`), 1);
});

test('SETUP_COMPLETO run again on the new schema deletes nothing and duplicates nothing', async () => {
  const db = await fresh();
  const ja = await jaula(db);
  const before = await count(db, `select count(*)::int n from app.catalogo`);
  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  assert.equal(await count(db, `select count(*)::int n from app.jaula where id = $1`, [ja]), 1);
  assert.equal(await count(db, `select count(*)::int n from app.catalogo`), before);
  assert.equal(await count(db, `select count(*)::int n from app.parametro`), 13);
  await assertOneOverloadEach(db);
});

/* ── production ────────────────────────────────────────────────────────── */

/** Old-protocol rows of every kind production may hold. */
async function seedOld(db) {
  const q = (s, p) => db.query(s, p);
  const ins = (await q(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio)
                        values (gen_random_uuid(), 'OLD-INS', 'ICA', '2026-09-01') returning id`)).rows[0].id;
  const rec = (await q(`insert into app.recoleccion (id, insectario_id, recolecta, fecha)
                        values (gen_random_uuid(), $1, '1', now()) returning id`, [ins])).rows[0].id;
  const ban = (await q(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha)
                        values (gen_random_uuid(), $1, 1, 'OLD.1', now()) returning id`, [rec])).rows[0].id;
  await q(`insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g)
           values (gen_random_uuid(), $1, now(), 410)`, [ban]);
  await q(`insert into app.recepcion_alimento (id, fecha, material, kg)
           values (gen_random_uuid(), now(), 'Bagazo de cerveza (BSG)', 50)`);
}

test('0010 over production: keeps the people, removes everything else', async () => {
  const db = await productionToday();
  const jose = uid();
  await db.query(`insert into app.catalogo (id, tipo, valor, orden, activo) values ($1, 'operario', 'Jose', 3, false)`, [jose]);
  const maria = (await one(db, `select id from app.catalogo where tipo = 'operario' and valor = 'Maria'`)).id;
  await seedOld(db);

  await db.exec(await MIG(R0010));

  for (const t of OLD_TABLES) assert.ok(!(await tableExists(db, t)), `${t} debió desaparecer`);
  for (const t of TABLES) assert.ok(await tableExists(db, t), `falta la tabla ${t}`);
  assert.equal(await count(db, `select count(*)::int n from pg_views where schemaname = 'app'`), 0,
    'las vistas del protocolo anterior desaparecen con él');
  assert.deepEqual(await overloads(db, 'crear_lote'), []);
  await assertOneOverloadEach(db);

  const personas = (await db.query(`select id, valor, orden, activo from app.catalogo
                                     where tipo = 'operario' order by orden`)).rows;
  assert.deepEqual(personas.map(p => p.valor), ['Maria', 'Ricardo', 'Jose']);
  assert.equal(personas.find(p => p.valor === 'Maria').id, maria, 'mismo id que antes');
  assert.deepEqual(personas.find(p => p.valor === 'Jose'), { id: jose, valor: 'Jose', orden: 3, activo: false });
  assert.deepEqual((await db.query(`select distinct tipo from app.catalogo order by 1`)).rows.map(r => r.tipo),
                   ['material_alimento', 'operario'], 'las listas viejas desaparecen');
  assert.equal(await count(db, `select count(*)::int n from app.parametro where clave = 'dias_incubacion'`), 0);
  assert.equal(await count(db, `select count(*)::int n from app.parametro`), 13);
});

test('0010 run twice over production deletes nothing new', async () => {
  const db = await productionToday();
  await db.exec(await MIG(R0010));
  const ja = await jaula(db);
  const inc = await incubadora(db, { jaulaId: ja });
  const listas = await count(db, `select count(*)::int n from app.catalogo`);

  await db.exec(await MIG(R0010));

  assert.equal(await count(db, `select count(*)::int n from app.incubadora where id = $1`, [inc]), 1);
  assert.equal(await count(db, `select count(*)::int n from app.catalogo`), listas);
  assert.equal(await count(db, `select count(*)::int n from app.parametro`), 13);
  await assertOneOverloadEach(db);
});

/* ── the larvae cycle ───────────────────────────────────────────────────── */

test('recolecta: día 0 is the farm day, and only the code is unique', async () => {
  const db = await fresh();
  const ja = await jaula(db), jb = await jaula(db, { letra: 'B', nombre: 'ICB' });
  // 23:30 in Caracas on the 19th is already the 20th in UTC.
  const inc = await incubadora(db, { jaulaId: ja, at: '2026-10-20T03:30:00Z' });
  assert.deepEqual(await one(db, `select dia0::text, estado, excepcion from app.incubadora where id = $1`, [inc]),
                   { dia0: '2026-10-19', estado: 'activo', excepcion: false });

  await assert.rejects(incubadora(db, { jaulaId: ja, codigo: 'F7A-1' }),
    err => err.code === '23505' && /ux_incubadora_codigo/.test(err.message));
  // Codes never change, so an incubadora corrected to another cage keeps its
  // number, and the other cage's own #1 must not collide with it.
  await incubadora(db, { jaulaId: jb, codigo: 'F7B-1' });
  await db.query(`select app.editar('incubadora', $1, $2::jsonb, 'Ricardo', now())`, [inc, json({ jaula_id: jb })]);
  assert.equal((await one(db, `select codigo from app.incubadora where id = $1`, [inc])).codigo, 'F7A-1');
});

test('chequeo: grams in an incubadora, kilos in a caja, one per scheduled day', async () => {
  const db = await fresh();
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const chequeo = (objeto, id, dia, peso, valor, humedad = 68) => db.query(
    `insert into app.chequeo (id, ${objeto}_id, dia, fecha, humedad_pct, temperatura_c, ${peso})
     values ($1, $2, $3, now(), $4, 29.5, $5)`, [uid(), id, dia, humedad, valor]);

  await chequeo('incubadora', inc, 3, 'peso_g', 40);
  await assert.rejects(chequeo('incubadora', inc, 3, 'peso_g', 41), code('23505'));
  await assert.rejects(chequeo('incubadora', inc, 4, 'peso_kg', 0.04), code('23514'), 'gramos, no kilos');
  await assert.rejects(chequeo('incubadora', inc, 5, 'peso_g', 40, 140), code('23514'), 'humedad fuera de 0–100');

  const d = distribucionDe(inc, 1);
  await distribuir(db, d);
  const caja = d.cajas[0].id;
  await chequeo('caja', caja, 10, 'peso_kg', 2.3);
  await chequeo('caja', caja, 14, 'peso_kg', 4.1);
  await assert.rejects(chequeo('caja', caja, 12, 'peso_g', 2300), code('23514'), 'kilos, no gramos');
  await assert.rejects(db.query(`insert into app.chequeo (id, dia, fecha, humedad_pct, temperatura_c, peso_kg)
                                 values ($1, 10, now(), 68, 29.5, 1)`, [uid()]), code('23514'),
    'un chequeo es de una incubadora o de una caja');
});

test('distribución: the cajas and their carga 1 land together, once', async () => {
  const db = await fresh();
  const r1 = await rack(db, 'R1');
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const d = distribucionDe(inc, 2, { rackId: r1 });

  // Validated BEFORE writing: an empty call leaves nothing behind.
  await assert.rejects(distribuir(db, { ...d, cajas: [] }), code('22023'));
  assert.equal(await count(db, `select count(*)::int n from app.distribucion`), 0);

  await distribuir(db, d);
  await distribuir(db, d);                                   // a replay after a lost reply
  assert.equal(await count(db, `select count(*)::int n from app.caja`), 2);
  assert.equal(await count(db, `select count(*)::int n from app.alimentacion`), 2);
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc])).estado, 'inactivo');
  const cajas = (await db.query(`select estado, registrado_por, rack_id from app.caja order by numero`)).rows;
  assert.deepEqual(cajas, [
    { estado: 'activo', registrado_por: 'Ricardo', rack_id: r1 },
    { estado: 'activo', registrado_por: 'Ricardo', rack_id: r1 }
  ]);

  // Another phone distributing the same incubadora.
  const otra = distribucionDe(inc, 1);
  otra.cajas[0].codigo = 'F7A-1-09';
  await assert.rejects(distribuir(db, otra),
    err => err.code === '23505' && /ya fue distribuida/.test(err.message));
});

test('separación: 98 % to the oven and 2 % back, recomputed when the weight is corrected', async () => {
  const db = await fresh();
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const d = distribucionDe(inc, 2);
  await distribuir(db, d);
  const sep = uid();
  await db.query(`insert into app.separacion (id, caja_id, fecha, peso_total_kg, registrado_por)
                  values ($1, $2, '2026-11-04T13:00:00Z', 10, 'Maria')`, [sep, d.cajas[0].id]);

  const reparto = () => one(db, `select coccion_kg::text, retorno_kg::text from app.separacion where id = $1`, [sep]);
  assert.deepEqual(await reparto(), { coccion_kg: '9.800', retorno_kg: '0.200' });
  assert.equal((await one(db, `select estado from app.caja where id = $1`, [d.cajas[0].id])).estado, 'inactivo');
  assert.equal((await one(db, `select estado from app.caja where id = $1`, [d.cajas[1].id])).estado, 'activo');

  await db.query(`select app.editar('separacion', $1, '{"peso_total_kg": 12.5}'::jsonb, 'Ricardo', now())`, [sep]);
  assert.deepEqual(await reparto(), { coccion_kg: '12.250', retorno_kg: '0.250' });

  await assert.rejects(db.query(`insert into app.separacion (id, caja_id, fecha, peso_total_kg)
                                 values ($1, $2, now(), 3)`, [uid(), d.cajas[0].id]), code('23505'),
    'una separación por caja');
});

test('cochada: from several separaciones, done at the final reading', async () => {
  const db = await fresh();
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const d = distribucionDe(inc, 2);
  await distribuir(db, d);
  const seps = [];
  for (const c of d.cajas) {
    const id = uid();
    await db.query(`insert into app.separacion (id, caja_id, fecha, peso_total_kg) values ($1, $2, now(), 10)`, [id, c.id]);
    seps.push(id);
  }
  const co = { id: uid(), codigo: 'H-0411-1', horno_at: '2026-11-04T15:00:00Z', peso_inicial_kg: 14.7,
               registrado_por: 'Maria' };
  // One separación's 98 % split across cochadas: 4.9 here, the rest later.
  const origenes = [{ id: uid(), separacion_id: seps[0], kg: 9.8 }, { id: uid(), separacion_id: seps[1], kg: 4.9 }];
  const crear = () => db.query(`select app.crear_cochada($1::jsonb, $2::jsonb)`, [json(co), json(origenes)]);

  await assert.rejects(db.query(`select app.crear_cochada($1::jsonb, '[]'::jsonb)`, [json(co)]), code('22023'));
  await crear();
  await crear();
  assert.equal(await count(db, `select count(*)::int n from app.cochada_origen where cochada_id = $1`, [co.id]), 2);

  const estado = async () => (await one(db, `select estado from app.cochada where id = $1`, [co.id])).estado;
  assert.equal(await estado(), 'activo');
  await db.query(`insert into app.cochada_lectura (id, cochada_id, momento, fecha, temperatura_c)
                  values ($1, $2, 'media', now(), 92)`, [uid(), co.id]);
  assert.equal(await estado(), 'activo');
  await assert.rejects(db.query(`insert into app.cochada_lectura (id, cochada_id, momento, fecha, temperatura_c)
                                 values ($1, $2, 'final', now(), 105)`, [uid(), co.id]), code('23514'),
    'la lectura final lleva el peso final');
  await db.query(`insert into app.cochada_lectura (id, cochada_id, momento, fecha, temperatura_c, peso_kg)
                  values ($1, $2, 'final', now(), 105, 4.1)`, [uid(), co.id]);
  assert.equal(await estado(), 'inactivo');

  // H-0411-1 is unique on its farm day: two phones giving it out the same day
  // collide, next year's does not.
  const otra = (horno_at, extra = {}) => db.query(`select app.crear_cochada($1::jsonb, $2::jsonb)`, [
    json({ ...co, id: uid(), horno_at, ...extra }),
    json([{ id: uid(), separacion_id: seps[1], kg: 1 }])]);
  await assert.rejects(otra('2026-11-05T02:00:00Z'), code('23505'), '22:00 del 4 en la granja');
  await otra('2027-11-04T15:00:00Z');
});

test('cerrar_objeto: early close with a written reason, nothing deleted', async () => {
  const db = await fresh();
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  await assert.rejects(db.query(`select app.cerrar_objeto('incubadora', $1, '  ', null, 'Maria')`, [inc]), code('22023'));
  await assert.rejects(db.query(`select app.cerrar_objeto('rack', $1, 'x', null, 'Maria')`, [inc]), code('22023'));

  await db.query(`select app.cerrar_objeto('incubadora', $1, ' contaminación ', '2026-10-21T15:00:00Z', 'Maria')`, [inc]);
  await db.query(`select app.cerrar_objeto('incubadora', $1, 'otra vez', now(), 'Ricardo')`, [inc]);
  const r = await one(db, `select estado, motivo_cierre, cerrado_por, cerrado_at = '2026-10-21T15:00:00Z' as fecha_ok
                             from app.incubadora where id = $1`, [inc]);
  assert.deepEqual(r, { estado: 'inactivo', motivo_cierre: 'contaminación', cerrado_por: 'Maria', fecha_ok: true },
    'el primer cierre queda; repetirlo no lo cambia');
});

/* ── the insectario ─────────────────────────────────────────────────────── */

test('ingreso: only into a cage that was closed and then cleaned', async () => {
  const db = await fresh();
  const ja = await jaula(db, { gen: 7, fase: 'activa' });
  const ingreso = (extra = {}) => ({ id: uid(), jaula_id: ja, fecha: '2026-11-05T14:00:00Z', kg_larvas: 1.2,
                                     generacion: 8, registrado_por: 'Maria', ...extra });
  const bandejas = () => [1, 2].map(n => ({ id: uid(), codigo: `F7-B0511-${n}`, numero: n, peso_kg: 4.7 }));
  const ingresar = (i, b) => db.query(`select app.ingresar($1::jsonb, $2::jsonb)`, [json(i), json(b)]);
  const fase = () => one(db, `select fase, estado, generacion, ciclo_desde::text from app.jaula where id = $1`, [ja]);
  const evento = (tipo, fecha) => db.query(
    `insert into app.jaula_evento (id, jaula_id, tipo, fecha, registrado_por) values ($1, $2, $3, $4, 'Maria')`,
    [uid(), ja, tipo, fecha]);

  await assert.rejects(ingresar(ingreso(), bandejas()),
    err => err.code === '23514' && /ya está poblada\./.test(err.message));
  await evento('cierre', '2026-11-03T14:00:00Z');
  assert.deepEqual(await fase(), { fase: 'cerrada', estado: 'inactivo', generacion: 7, ciclo_desde: null });
  await assert.rejects(ingresar(ingreso(), bandejas()),
    err => err.code === '23514' && /falta la limpieza\./.test(err.message));
  await evento('limpieza', '2026-11-04T14:00:00Z');
  assert.equal((await fase()).fase, 'limpia');

  await assert.rejects(ingresar(ingreso(), []), code('22023'));
  const i = ingreso(), b = bandejas();
  await ingresar(i, b);
  await ingresar(i, b);                                      // a replay after a lost reply
  assert.deepEqual(await fase(), { fase: 'activa', estado: 'activo', generacion: 8, ciclo_desde: '2026-11-05' });
  const trays = (await db.query(`select estado, jaula_id, registrado_por from app.bandeja_pupacion order by numero`)).rows;
  assert.deepEqual(trays, [
    { estado: 'inactivo', jaula_id: ja, registrado_por: 'Maria' },
    { estado: 'inactivo', jaula_id: ja, registrado_por: 'Maria' }
  ], 'entran a la jaula el mismo día');

  // The generation the cage got is corrected on its ingreso.
  await db.query(`select app.editar('ingreso', $1, '{"generacion": 9}'::jsonb, 'Ricardo', now())`, [i.id]);
  assert.equal((await fase()).generacion, 9);

  // Withdrawing the ingreso puts the cage back where its last event left it.
  await db.query(`update app.ingreso set deleted_at = now() where id = $1`, [i.id]);
  assert.deepEqual(await fase(), { fase: 'limpia', estado: 'inactivo', generacion: 7, ciclo_desde: null });
});

test('a cage registered clean is repopulated at once; its starting generation can be corrected', async () => {
  const db = await fresh();
  const limpia = await jaula(db, { letra: 'C', nombre: 'ICC', gen: 5, fase: 'limpia' });
  await db.query(`select app.ingresar($1::jsonb, $2::jsonb)`, [
    json({ id: uid(), jaula_id: limpia, fecha: '2026-11-05T14:00:00Z', kg_larvas: 0.6, generacion: 6 }),
    json([{ id: uid(), codigo: 'F5-B0511-1', numero: 1, peso_kg: 4.7 }])
  ]);
  assert.equal((await one(db, `select generacion from app.jaula where id = $1`, [limpia])).generacion, 6);

  const otra = await jaula(db, { letra: 'D', nombre: 'ICD', gen: 3, fase: 'activa' });
  await db.query(`select app.editar('jaula', $1, '{"generacion_inicial": 4}'::jsonb, 'Maria', now())`, [otra]);
  assert.deepEqual(await one(db, `select generacion, fase from app.jaula where id = $1`, [otra]),
                   { generacion: 4, fase: 'activa' });
  // With an ingreso on record, the cage's generation is the ingreso's.
  await db.query(`select app.editar('jaula', $1, '{"generacion_inicial": 2}'::jsonb, 'Maria', now())`, [limpia]);
  assert.equal((await one(db, `select generacion from app.jaula where id = $1`, [limpia])).generacion, 6);
});

/* ── food ───────────────────────────────────────────────────────────────── */

test('ensilado: from receptions, día 0 on the farm calendar, opened once', async () => {
  const db = await fresh();
  const s2 = uid(), rec = uid();
  await db.query(`insert into app.contenedor (id, codigo) values ($1, 'S2')`, [s2]);
  await db.query(`insert into app.recepcion (id, fecha, material, kg) values ($1, now(), 'Bagazo de cerveza (BSG)', 100)`, [rec]);
  // 22:00 in Caracas on the 27th.
  const ens = { id: uid(), codigo: 'S2-2710', contenedor_id: s2, ensilado_at: '2026-10-28T02:00:00Z',
                registrado_por: 'Maria' };
  const insumos = [{ id: uid(), recepcion_id: rec, kg: 80 }];
  const crear = () => db.query(`select app.crear_ensilado($1::jsonb, $2::jsonb)`, [json(ens), json(insumos)]);

  await assert.rejects(db.query(`select app.crear_ensilado($1::jsonb, '[]'::jsonb)`, [json(ens)]), code('22023'));
  await crear();
  await crear();
  assert.equal((await one(db, `select dia0::text from app.ensilado where id = $1`, [ens.id])).dia0, '2026-10-27');
  assert.equal(await count(db, `select count(*)::int n from app.ensilado_insumo`), 1);
  // S2-2710 is unique on its day; the same container a year later is not a clash.
  const igual = ensilado_at => db.query(`select app.crear_ensilado($1::jsonb, $2::jsonb)`, [
    json({ ...ens, id: uid(), ensilado_at }), json([{ id: uid(), recepcion_id: rec, kg: 1 }])]);
  await assert.rejects(igual('2026-10-27T15:00:00Z'), code('23505'));
  await igual('2027-10-27T15:00:00Z');

  await db.query(`select app.abrir_ensilado($1, '2026-11-17T12:00:00Z', 'Maria')`, [ens.id]);
  await db.query(`select app.abrir_ensilado($1, '2026-11-18T12:00:00Z', 'Ricardo')`, [ens.id]);
  assert.deepEqual(await one(db, `select abierto_at = '2026-11-17T12:00:00Z' as primero, abierto_por
                                    from app.ensilado where id = $1`, [ens.id]),
                   { primero: true, abierto_por: 'Maria' }, 'el primero que llega gana');

  await db.query(`select app.editar('ensilado', $1, '{"ensilado_at": "2026-10-29T15:00:00Z"}'::jsonb, 'Maria', now())`, [ens.id]);
  assert.deepEqual(await one(db, `select dia0::text, codigo from app.ensilado where id = $1`, [ens.id]),
                   { dia0: '2026-10-29', codigo: 'S2-2710' }, 'la fecha se corrige; el código no cambia');
});

/* ── editing ────────────────────────────────────────────────────────────── */

test('editar: listed fields only; a note or photo is not a value change', async () => {
  const db = await fresh();
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const editar = (tabla, id, cambios, por = 'Ricardo', at = null) =>
    db.query(`select app.editar($1, $2, $3::jsonb, $4, $5)`, [tabla, id, json(cambios), por, at]);
  const marcas = () => one(db, `select editado_at::text, editado_por, valores_editados_at::text,
                                       revisado_at::text, dia0::text, peso_inicial_g::text
                                  from app.incubadora where id = $1`, [inc]);

  await editar('incubadora', inc, { recolecta_at: '2026-10-18T14:00:00Z', peso_inicial_g: 11 }, 'Ricardo',
               '2026-10-21T10:00:00Z');
  let m = await marcas();
  assert.equal(m.dia0, '2026-10-18', 'el día 0 sigue a la fecha corregida');
  assert.equal(m.peso_inicial_g, '11.00');
  assert.equal(m.editado_por, 'Ricardo');
  assert.equal(m.valores_editados_at, m.editado_at);

  await editar('incubadora', inc, { nota: 'tapa rota' }, 'Maria', '2026-10-22T10:00:00Z');
  const tras = await marcas();
  assert.notEqual(tras.editado_at, m.editado_at);
  assert.equal(tras.editado_por, 'Maria');
  assert.equal(tras.valores_editados_at, m.valores_editados_at, 'una nota no marca «revisar» a nadie');
  await editar('incubadora', inc, { foto_key: 'incubadora/x/y.jpg' }, 'Maria', '2026-10-23T10:00:00Z');
  assert.equal((await marcas()).valores_editados_at, m.valores_editados_at, 'una foto tampoco');

  await assert.rejects(editar('incubadora', inc, { codigo: 'F9Z-1' }),
    err => err.code === '22023' && /no se puede editar/.test(err.message), 'el código no cambia nunca');
  await assert.rejects(editar('incubadora', inc, { estado: 'activo' }), code('22023'));
  await assert.rejects(editar('lote', inc, { nota: 'x' }), code('22023'));
  await assert.rejects(editar('incubadora', inc, {}), code('22023'));

  await db.query(`select app.marcar_revisado('incubadora', $1, '2026-10-24T10:00:00Z', 'Maria')`, [inc]);
  m = await marcas();
  assert.equal(m.revisado_at.slice(0, 10), '2026-10-24');
  assert.equal(m.valores_editados_at, tras.valores_editados_at, 'revisar no es editar');
  await assert.rejects(db.query(`select app.marcar_revisado('catalogo', $1, null, null)`, [inc]), code('22023'));
});

test('every write moves updated_at, which is what the phones pull by', async () => {
  const db = await fresh();
  const r = await rack(db, 'R1');
  const antes = (await one(db, `select updated_at from app.rack where id = $1`, [r])).updated_at;
  await new Promise(res => setTimeout(res, 5));
  await db.query(`select app.editar('rack', $1, '{"codigo": "R1-B"}'::jsonb, 'Maria', null)`, [r]);
  const despues = (await one(db, `select updated_at from app.rack where id = $1`, [r])).updated_at;
  assert.ok(despues > antes);

  // A registry that changes its object's state moves the object too.
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const i0 = (await one(db, `select updated_at from app.incubadora where id = $1`, [inc])).updated_at;
  await new Promise(res => setTimeout(res, 5));
  await distribuir(db, distribucionDe(inc, 1));
  const i1 = (await one(db, `select updated_at, estado from app.incubadora where id = $1`, [inc]));
  assert.ok(i1.updated_at > i0 && i1.estado === 'inactivo');
});

/* ── access ─────────────────────────────────────────────────────────────── */

test('access: every table open to the app through RLS; historico is not exposed', async () => {
  const db = await fresh();
  for (const t of TABLES) {
    const rls = await one(db, `select relrowsecurity from pg_class where oid = ('app.' || $1)::regclass`, [t]);
    assert.equal(rls.relrowsecurity, true, `RLS apagado en ${t}`);
    assert.equal(await count(db, `select count(*)::int n from pg_policies
                                   where schemaname = 'app' and tablename = $1 and policyname = 'demo_abierto'`, [t]), 1);
    assert.equal((await one(db, `select has_table_privilege('anon', 'app.' || $1, 'insert') ok`, [t])).ok, true);
  }
  for (const fn of RPCS) {
    const ok = await one(db, `select bool_and(has_function_privilege('anon', p.oid, 'execute')) ok
                                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'app' and p.proname = $1`, [fn]);
    assert.equal(ok.ok, true, `anon no puede llamar ${fn}`);
  }
  assert.equal((await one(db, `select has_schema_privilege('anon', 'historico', 'usage') ok`)).ok, false);
});
