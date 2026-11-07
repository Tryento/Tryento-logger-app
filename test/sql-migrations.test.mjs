/**
 * The SQL, run in a REAL Postgres (PGlite).
 *
 * Syntax checking passed every file that ever broke production. What matters
 * is what happens when they run:
 *   - a fresh install (SETUP_COMPLETO.sql) works, and running it again changes
 *     nothing;
 *   - 0011 over production as 0010 left it removes the racks and keeps the rest;
 *   - every trigger and call the app relies on behaves;
 *   - the two modes do what they say, tried with the public key;
 *   - the full delete leaves the settings, the lists and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uid } from 'node:crypto';
import { freshPg, readSql, overloads, tableExists, comoAnon } from './helpers/pg.mjs';
import { mergeProtocolo, PROTOCOLO_DEFAULTS } from '../src/data/protocolo.js';

const R0010 = 'supabase/esquema/0010_ciclo_nuevo.sql';
const R0011 = 'supabase/esquema/0011_bandejas_y_reglas.sql';
const BORRAR = 'supabase/operaciones/borrar_todos_los_datos.sql';
const PERMITIR = 'supabase/operaciones/permitir_cambios.sql';
const PROTEGER = 'supabase/operaciones/proteger_datos.sql';

const DATOS = [
  'contenedor', 'jaula', 'recepcion', 'ensilado', 'ensilado_insumo', 'incubadora', 'distribucion',
  'caja', 'chequeo', 'alimentacion', 'separacion', 'cochada', 'cochada_origen', 'cochada_lectura',
  'ingreso', 'bandeja_pupacion', 'jaula_evento'
];
const TABLES = ['catalogo', 'parametro', ...DATOS];
const OLD_TABLES = [
  'insectario', 'recoleccion', 'bandeja', 'ayuno', 'revision', 'lote', 'lote_separacion',
  'ayuno_huerfano', 'migracion_log', 'recepcion_alimento', 'ensilaje', 'ensilaje_insumo',
  'ensilaje_lectura', 'rack', 'movimiento'
];
/** Functions the app calls; each must exist exactly once. */
const RPCS = ['distribuir', 'crear_cochada', 'ingresar', 'crear_ensilado', 'abrir_ensilado',
              'cerrar_objeto', 'editar', 'marcar_revisado', 'borrar_registros'];
const AJUSTES = [
  'alimento_bandeja_g', 'cargas', 'dia_chequeo_incubadora', 'dia_distribucion', 'dia_inicio_ayuno',
  'dia_separacion', 'dias_chequeo_caja', 'dias_ciclo_jaula', 'dias_maduracion', 'dias_recolecta',
  'horas_consumo', 'huevos_bandeja_max_g', 'huevos_bandeja_min_g', 'kg_bandeja_pupacion',
  'pct_coccion', 'reglas_estrictas'
];

const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const count = async (db, sql, params) => (await one(db, sql, params)).n;
const json = v => JSON.stringify(v);
const code = c => err => err.code === c;
const NADIE = '00000000-0000-4000-8000-000000000000';

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

async function contenedor(db, codigo = 'S2') {
  const id = uid();
  await db.query(`insert into app.contenedor (id, codigo) values ($1, $2)`, [id, codigo]);
  return id;
}

async function jaula(db, { letra = 'A', nombre = 'ICA', gen = 7, fase = 'activa' } = {}) {
  const id = uid();
  await db.query(`insert into app.jaula (id, nombre, letra, lugar, generacion_inicial, fase_inicial, registrado_por)
                  values ($1, $2, $3, 'Galpón 1', $4, $5, 'Maria')`, [id, nombre, letra, gen, fase]);
  return id;
}

async function incubadora(db, { jaulaId, codigo = 'F7A-1', gen = 7, numero = 1,
                                at = '2026-10-20T03:30:00Z', bandejas = 3 } = {}) {
  const id = uid();
  await db.query(`insert into app.incubadora (id, codigo, jaula_id, generacion, numero, recolecta_at, n_bandejas,
                    peso_inicial_g, alimento_inicial_kg, registrado_por)
                  values ($1, $2, $3, $4, $5, $6, $7, 12.5, 1.2, 'Maria')`,
                 [id, codigo, jaulaId, gen, numero, at, bandejas]);
  return id;
}

/** distribución with n cajas and their carga 1. */
function distribucionDe(incId, n = 2) {
  const dist = { id: uid(), incubadora_id: incId, fecha: '2026-10-26T13:00:00Z',
                 peso_total_kg: 0.9 * n, registrado_por: 'Ricardo' };
  const cajas = Array.from({ length: n }, (_, i) => ({
    id: uid(), codigo: `F7A-1-0${i + 1}`, numero: i + 1, peso_inicial_kg: 0.9
  }));
  const cargas = cajas.map(c => ({ id: uid(), caja_id: c.id, carga: 1, fecha: dist.fecha,
                                   kg: 1.5, kg_plan: 1.5, dia_plan: 7 }));
  return { dist, cajas, cargas };
}

const distribuir = (db, { dist, cajas, cargas }) =>
  db.query(`select app.distribuir($1::jsonb, $2::jsonb, $3::jsonb)`, [json(dist), json(cajas), json(cargas)]);

/* ── fresh install ─────────────────────────────────────────────────────── */

test('fresh install: SETUP_COMPLETO builds the schema and seeds it', async () => {
  const db = await fresh();
  for (const t of TABLES) assert.ok(await tableExists(db, t), `falta la tabla ${t}`);
  for (const t of OLD_TABLES) assert.ok(!(await tableExists(db, t)), `${t} ya no existe`);
  await assertOneOverloadEach(db);

  const claves = (await db.query(`select clave from app.parametro order by clave`)).rows.map(r => r.clave);
  assert.deepEqual(claves, AJUSTES);
  const ajuste = async c => (await one(db, `select valor from app.parametro where clave = $1`, [c])).valor;
  assert.deepEqual(await ajuste('cargas'), [{ n: 1, dia: 7, kg: 1.5 }, { n: 2, dia: 10, kg: 2 }, { n: 3, dia: 13, kg: 2 }]);
  assert.equal(await ajuste('huevos_bandeja_min_g'), 2);
  assert.equal(await ajuste('huevos_bandeja_max_g'), 5);
  assert.equal(await ajuste('alimento_bandeja_g'), 400);
  assert.equal(await ajuste('reglas_estrictas'), false, 'arranca en modo abierto');

  const listas = (await db.query(`select tipo, valor from app.catalogo order by tipo, orden`)).rows;
  assert.deepEqual(listas.map(r => `${r.tipo}:${r.valor}`), [
    'material_alimento:Bagazo de cerveza (BSG)', 'material_alimento:Desecho de panadería',
    'material_alimento:Desecho de fruta', 'material_alimento:Otro',
    'operario:Maria', 'operario:Ricardo'
  ]);
  assert.equal(await count(db, `select count(*)::int n from storage.buckets where id = 'fotos' and public`), 1);
  assert.equal(await count(db, `select count(*)::int n from pg_namespace where nspname = 'historico'`), 1);
});

test('the settings a new database seeds are the ones a phone assumes before its first sync', async () => {
  const db = await fresh();
  const filas = (await db.query(`select clave, valor from app.parametro`)).rows;
  assert.deepEqual(mergeProtocolo(filas), JSON.parse(JSON.stringify(PROTOCOLO_DEFAULTS)));
  assert.deepEqual(filas.map(r => r.clave).sort(), Object.keys(PROTOCOLO_DEFAULTS).sort());
});

test('SETUP_COMPLETO run again deletes nothing, duplicates nothing and opens nothing', async () => {
  const db = await fresh();
  const ja = await jaula(db);
  const inc = await incubadora(db, { jaulaId: ja });
  const before = await count(db, `select count(*)::int n from app.catalogo`);
  await db.exec(await readSql(PROTEGER));

  await db.exec(await readSql('supabase/SETUP_COMPLETO.sql'));

  assert.equal(await count(db, `select count(*)::int n from app.jaula where id = $1`, [ja]), 1);
  assert.equal((await one(db, `select n_bandejas from app.incubadora where id = $1`, [inc])).n_bandejas, 3);
  assert.equal(await count(db, `select count(*)::int n from app.catalogo`), before);
  assert.equal(await count(db, `select count(*)::int n from app.parametro`), AJUSTES.length);
  await assertOneOverloadEach(db);
  assert.equal(await tableExists(db, 'rack'), false);
  assert.equal(await estricto(db), true, 'sigue protegida');
  assert.equal((await acceso(db, 'incubadora')).update, false, 'sigue protegida');
});

/* ── production: 0011 over what 0010 left ─────────────────────────────── */

/** Production today: 0010 only, with rows that name racks. */
async function produccionHoy() {
  const db = await freshPg();
  await db.exec(await readSql(R0010));
  const rack = uid();
  await db.query(`insert into app.rack (id, codigo) values ($1, 'R1')`, [rack]);
  const ja = await jaula(db);
  const inc = uid();
  await db.query(`insert into app.incubadora (id, codigo, jaula_id, generacion, numero, recolecta_at, rack_id,
                    peso_inicial_g, alimento_inicial_kg)
                  values ($1, 'F7A-1', $2, 7, 1, now(), $3, 12.5, 2)`, [inc, ja, rack]);
  await db.query(`insert into app.movimiento (id, objeto, objeto_id, rack_hasta, fecha)
                  values ($1, 'incubadora', $2, $3, now())`, [uid(), inc, rack]);
  return { db, ja, inc };
}

test('0011 over production: racks gone, the rest kept, the setting replaced; twice is the same', async () => {
  const { db, ja, inc } = await produccionHoy();
  const antes = await acceso(db, 'separacion');
  assert.deepEqual([antes.pols, antes.delete], [['demo_abierto:ALL'], true], 'lo que dejó 0010');

  await db.exec(await readSql(R0011));
  await db.exec(await readSql(R0011));

  for (const t of ['rack', 'movimiento']) assert.equal(await tableExists(db, t), false, t);
  for (const t of ['incubadora', 'caja', 'bandeja_pupacion']) {
    assert.equal(await count(db, `select count(*)::int n from information_schema.columns
                                   where table_schema = 'app' and table_name = $1 and column_name = 'rack_id'`, [t]), 0, t);
  }
  assert.deepEqual(await one(db, `select codigo, n_bandejas, alimento_inicial_kg::text, jaula_id from app.incubadora where id = $1`, [inc]),
                   { codigo: 'F7A-1', n_bandejas: 1, alimento_inicial_kg: '2.000', jaula_id: ja }, 'una recolecta de antes ocupa una bandeja');
  assert.deepEqual((await db.query(`select clave from app.parametro order by clave`)).rows.map(r => r.clave), AJUSTES);
  await assertOneOverloadEach(db);
  for (const t of TABLES) assert.deepEqual(await acceso(db, t), t === 'parametro' ? SOLO_LEER : ABIERTO, t);
});

test('0011 leaves a mode alone, and does not overwrite a setting already changed', async () => {
  const db = await fresh();
  await db.query(`update app.parametro set valor = '500' where clave = 'alimento_bandeja_g'`);
  await db.exec(await readSql(R0011));
  assert.equal((await one(db, `select valor from app.parametro where clave = 'alimento_bandeja_g'`)).valor, 500);
  assert.equal(await estricto(db), false);
  assert.equal((await acceso(db, 'incubadora')).update, true);

  await db.exec(await readSql(PROTEGER));
  await db.exec(await readSql(R0011));
  assert.equal(await estricto(db), true);
  assert.equal((await acceso(db, 'incubadora')).update, false);
});

/* ── the larvae cycle ───────────────────────────────────────────────────── */

test('recolecta: día 0 is the farm day, one code however many bandejas', async () => {
  const db = await fresh();
  const ja = await jaula(db), jb = await jaula(db, { letra: 'B', nombre: 'ICB' });
  // 23:30 in Caracas on the 19th is already the 20th in UTC.
  const inc = await incubadora(db, { jaulaId: ja, at: '2026-10-20T03:30:00Z', bandejas: 3 });
  assert.deepEqual(await one(db, `select dia0::text, estado, excepcion, n_bandejas from app.incubadora where id = $1`, [inc]),
                   { dia0: '2026-10-19', estado: 'activo', excepcion: false, n_bandejas: 3 });

  await assert.rejects(incubadora(db, { jaulaId: ja, codigo: 'F7A-1' }),
    err => err.code === '23505' && /ux_incubadora_codigo/.test(err.message));
  await assert.rejects(incubadora(db, { jaulaId: ja, codigo: 'F7A-9', bandejas: 0 }), code('23514'), 'al menos una bandeja');
  // Codes never change, so an incubadora corrected to another cage keeps its
  // number, and the other cage's own #1 must not collide with it.
  await incubadora(db, { jaulaId: jb, codigo: 'F7B-1' });
  await db.query(`select app.editar('incubadora', $1, $2::jsonb, 'Ricardo', now())`, [inc, json({ jaula_id: jb, n_bandejas: 4 })]);
  assert.deepEqual(await one(db, `select codigo, n_bandejas from app.incubadora where id = $1`, [inc]), { codigo: 'F7A-1', n_bandejas: 4 });
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
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const d = distribucionDe(inc, 2);

  // Validated BEFORE writing: an empty call leaves nothing behind.
  await assert.rejects(distribuir(db, { ...d, cajas: [] }), code('22023'));
  assert.equal(await count(db, `select count(*)::int n from app.distribucion`), 0);

  await distribuir(db, d);
  await distribuir(db, d);                                   // a replay after a lost reply
  assert.equal(await count(db, `select count(*)::int n from app.caja`), 2);
  assert.equal(await count(db, `select count(*)::int n from app.alimentacion`), 2);
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc])).estado, 'inactivo');
  const cajas = (await db.query(`select estado, registrado_por from app.caja order by numero`)).rows;
  assert.deepEqual(cajas, [{ estado: 'activo', registrado_por: 'Ricardo' }, { estado: 'activo', registrado_por: 'Ricardo' }]);

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
  await assert.rejects(db.query(`select app.cerrar_objeto('contenedor', $1, 'x', null, 'Maria')`, [inc]), code('22023'));

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
    err => err.code === '23514' && /El insectario ICA no está listo para repoblar: ya está poblado\./.test(err.message));
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
  const s2 = await contenedor(db), rec = uid();
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
  await assert.rejects(editar('incubadora', inc, { rack_id: NADIE }), code('22023'), 'ya no hay racks');
  await assert.rejects(editar('rack', inc, { nota: 'x' }), code('22023'));
  await assert.rejects(editar('incubadora', inc, {}), code('22023'));

  await db.query(`select app.marcar_revisado('incubadora', $1, '2026-10-24T10:00:00Z', 'Maria')`, [inc]);
  m = await marcas();
  assert.equal(m.revisado_at.slice(0, 10), '2026-10-24');
  assert.equal(m.valores_editados_at, tras.valores_editados_at, 'revisar no es editar');
  await assert.rejects(db.query(`select app.marcar_revisado('catalogo', $1, null, null)`, [inc]), code('22023'));
});

test('every write moves updated_at, which is what the phones pull by', async () => {
  const db = await fresh();
  const c = await contenedor(db, 'S1');
  const antes = (await one(db, `select updated_at from app.contenedor where id = $1`, [c])).updated_at;
  await new Promise(res => setTimeout(res, 5));
  await db.query(`select app.editar('contenedor', $1, '{"codigo": "S1-B"}'::jsonb, 'Maria', null)`, [c]);
  const despues = (await one(db, `select updated_at from app.contenedor where id = $1`, [c])).updated_at;
  assert.ok(despues > antes);

  // A registry that changes its object's state moves the object too.
  const inc = await incubadora(db, { jaulaId: await jaula(db) });
  const i0 = (await one(db, `select updated_at from app.incubadora where id = $1`, [inc])).updated_at;
  await new Promise(res => setTimeout(res, 5));
  await distribuir(db, distribucionDe(inc, 1));
  const i1 = (await one(db, `select updated_at, estado from app.incubadora where id = $1`, [inc]));
  assert.ok(i1.updated_at > i0 && i1.estado === 'inactivo');
});

/* ── access: the public key, in each mode ───────────────────────────────── */

const estricto = async db => (await one(db, `select app.reglas_estrictas() as r`)).r;

/** What the public key may do on a table: its policies by command, and its privileges. */
async function acceso(db, t) {
  const pols = (await db.query(`select policyname, cmd from pg_policies where schemaname = 'app' and tablename = $1
                                order by policyname`, [t])).rows.map(p => `${p.policyname}:${p.cmd}`);
  const puede = async priv => (await one(db, `select has_table_privilege('anon', 'app.' || $1, $2) ok`, [t, priv])).ok;
  return { pols, select: await puede('select'), insert: await puede('insert'), update: await puede('update'),
           delete: await puede('delete'), truncate: await puede('truncate') };
}

const POLITICAS = ['app_agregar:INSERT', 'app_corregir:UPDATE', 'app_leer:SELECT'];
const ABIERTO = { pols: POLITICAS, select: true, insert: true, update: true, delete: false, truncate: false };
const PROTEGIDO = { ...ABIERTO, update: false };
const SOLO_LEER = { pols: ['app_leer:SELECT'], select: true, insert: false, update: false, delete: false, truncate: false };

test('access: the public key never deletes, in any mode; settings are read-only; historico is not exposed', async () => {
  const db = await fresh();
  for (const t of TABLES) {
    const rls = await one(db, `select relrowsecurity from pg_class where oid = ('app.' || $1)::regclass`, [t]);
    assert.equal(rls.relrowsecurity, true, `RLS apagado en ${t}`);
    assert.deepEqual(await acceso(db, t), t === 'parametro' ? SOLO_LEER : ABIERTO, t);
  }
  // Tried with the public key, a delete is refused, not quietly applied.
  const c = await contenedor(db);
  await assert.rejects(comoAnon(db, tx => tx.query('delete from app.contenedor where id = $1', [c])), code('42501'));
  assert.equal(await count(db, `select count(*)::int n from app.contenedor where id = $1`, [c]), 1);
  await assert.rejects(comoAnon(db, tx => tx.query(`update app.parametro set valor = 'true' where clave = 'reglas_estrictas'`)),
                       code('42501'), 'nadie cambia de modo con la llave pública');
  await assert.rejects(comoAnon(db, tx => tx.query(`insert into app.parametro (clave, valor) values ('x', '1')`)), code('42501'));
  await assert.rejects(comoAnon(db, tx => tx.query(`truncate app.contenedor cascade`)), code('42501'));
  await assert.rejects(comoAnon(db, tx => tx.query(`select app.recalcular_jaula($1)`, [NADIE])), code('42501'));

  const fotos = (await db.query(`select policyname, cmd from pg_policies where schemaname = 'storage' and tablename = 'objects'
                                 order by policyname`)).rows.map(p => `${p.policyname}:${p.cmd}`);
  assert.deepEqual(fotos, ['fotos_leer:SELECT', 'fotos_reemplazar:UPDATE', 'fotos_subir:INSERT']);
  for (const fn of RPCS) {
    const ok = await one(db, `select bool_and(has_function_privilege('anon', p.oid, 'execute')) ok
                                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'app' and p.proname = $1`, [fn]);
    assert.equal(ok.ok, true, `anon no puede llamar ${fn}`);
  }
  assert.equal((await one(db, `select has_schema_privilege('anon', 'historico', 'usage') ok`)).ok, false);
});

test('open mode: deleting marks the whole list, frees the state and the code, and is safe to replay', async () => {
  const db = await fresh();
  const j = await jaula(db);
  const inc = await incubadora(db, { jaulaId: j });
  const dist = distribucionDe(inc, 1);
  await distribuir(db, dist);
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc])).estado, 'inactivo');
  const filas = json([{ tabla: 'distribucion', id: dist.dist.id }, { tabla: 'caja', id: dist.cajas[0].id },
                      { tabla: 'alimentacion', id: dist.cargas[0].id }]);
  const borrar = (at, f = filas) => comoAnon(db, tx => tx.query(`select app.borrar_registros($1::jsonb, $2, 'Maria')`, [f, at]));
  await borrar('2026-11-05T12:00:00Z');
  await borrar('2026-11-06T12:00:00Z');
  const c = await one(db, `select deleted_at = '2026-11-05T12:00:00Z' as primero, editado_por from app.caja where id = $1`, [dist.cajas[0].id]);
  assert.deepEqual(c, { primero: true, editado_por: 'Maria' });
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc])).estado, 'activo', 'vuelve a estar activa');
  await distribuir(db, distribucionDe(inc, 1));   // the code F7A-1-01 is free again
  await assert.rejects(borrar(null, json([{ tabla: 'parametro', id: NADIE }])), code('22023'));
  await assert.rejects(borrar(null, json([{ tabla: 'rack', id: NADIE }])), code('22023'));
});

test('protected mode: no deleting, no direct changes, corrections with who and when, and the work goes on', async () => {
  const db = await fresh();
  const ja = await jaula(db);
  const inc = await incubadora(db, { jaulaId: ja });
  const c = await contenedor(db);
  const rec = uid();
  await db.query(`insert into app.recepcion (id, fecha, material, kg) values ($1, now(), 'Otro', 10)`, [rec]);

  await db.exec(await readSql(PROTEGER));
  await db.exec(await readSql(PROTEGER));           // any number of times
  assert.equal(await estricto(db), true);
  for (const t of TABLES) assert.deepEqual(await acceso(db, t), t === 'parametro' ? SOLO_LEER : PROTEGIDO, t);

  const anon = (sql, p) => comoAnon(db, tx => tx.query(sql, p));

  // No deleting of any kind, no direct changes.
  await assert.rejects(anon(`select app.borrar_registros($1::jsonb, null, 'Maria')`, [json([{ tabla: 'contenedor', id: c }])]),
    err => err.code === '42501' && /protegidos/.test(err.message));
  await assert.rejects(anon(`update app.incubadora set peso_inicial_g = 1 where id = $1`, [inc]), code('42501'));
  await assert.rejects(anon(`update app.contenedor set deleted_at = now() where id = $1`, [c]), code('42501'));
  await assert.rejects(anon(`delete from app.contenedor where id = $1`, [c]), code('42501'));

  // A correction goes through, and says who and when. Without a name, it does not.
  await anon(`select app.editar('incubadora', $1, '{"peso_inicial_g": 11}'::jsonb, 'Ricardo', '2026-11-06T10:00:00Z')`, [inc]);
  assert.deepEqual(await one(db, `select peso_inicial_g::text, editado_por, valores_editados_at = '2026-11-06T10:00:00Z' as cuando
                                    from app.incubadora where id = $1`, [inc]),
                   { peso_inicial_g: '11.00', editado_por: 'Ricardo', cuando: true });
  await assert.rejects(anon(`select app.editar('incubadora', $1, '{"nota": "x"}'::jsonb, '  ', null)`, [inc]), code('23514'));
  await anon(`select app.marcar_revisado('incubadora', $1, now(), 'Maria')`, [inc]);

  // Everything the day needs still works with the public key, triggers included:
  // these touch other tables on the way.
  const d = distribucionDe(inc, 1);
  await anon(`select app.distribuir($1::jsonb, $2::jsonb, $3::jsonb)`, [json(d.dist), json(d.cajas), json(d.cargas)]);
  assert.equal((await one(db, `select estado from app.incubadora where id = $1`, [inc])).estado, 'inactivo');
  await anon(`insert into app.separacion (id, caja_id, fecha, peso_total_kg) values ($1, $2, now(), 10)`, [uid(), d.cajas[0].id]);
  assert.equal((await one(db, `select estado from app.caja where id = $1`, [d.cajas[0].id])).estado, 'inactivo');
  await anon(`insert into app.jaula_evento (id, jaula_id, tipo, fecha) values ($1, $2, 'cierre', now())`, [uid(), ja]);
  assert.equal((await one(db, `select fase from app.jaula where id = $1`, [ja])).fase, 'cerrada');
  await anon(`select app.cerrar_objeto('incubadora', $1, 'prueba', null, 'Maria')`, [await incubadora(db, { jaulaId: ja, codigo: 'F7A-2' })]);
  const ens = { id: uid(), codigo: 'S2-0611', contenedor_id: c, ensilado_at: new Date().toISOString() };
  await anon(`select app.crear_ensilado($1::jsonb, $2::jsonb)`, [json(ens), json([{ id: uid(), recepcion_id: rec, kg: 10 }])]);
  await anon(`select app.abrir_ensilado($1, now(), 'Maria')`, [ens.id]);
  assert.ok((await one(db, `select abierto_at from app.ensilado where id = $1`, [ens.id])).abierto_at);
  // And a new name still joins the list.
  await anon(`insert into app.catalogo (id, tipo, valor) values ($1, 'operario', 'Jose')`, [uid()]);
});

test('protected mode refuses a date that has not arrived; open mode leaves it to the phone', async () => {
  const db = await fresh();
  const manana = new Date(Date.now() + 3 * 86400000).toISOString();
  const recepcion = fecha => db.query(`insert into app.recepcion (id, fecha, material, kg) values ($1, $2, 'Otro', 1)`, [uid(), fecha]);

  await recepcion(manana);                          // open: the phone asked, the person confirmed
  await db.exec(await readSql(PROTEGER));
  await assert.rejects(recepcion(manana), err => err.code === '23514' && /todavía no ha llegado/.test(err.message));
  await recepcion(new Date().toISOString());

  // The same through a correction, and on every dated table.
  const inc = await incubadora(db, { jaulaId: await jaula(db), at: new Date().toISOString() });
  await assert.rejects(db.query(`select app.editar('incubadora', $1, $2::jsonb, 'Maria', now())`, [inc, json({ recolecta_at: manana })]),
                       code('23514'));
  const fechadas = (await db.query(`select tgname from pg_trigger where not tgisinternal and tgname like '%\\_fecha' order by 1`)).rows;
  assert.equal(fechadas.length, 11);

  // A record already dated ahead can still be corrected in other ways.
  await db.exec(await readSql(PERMITIR));
  const adelantada = uid();
  await db.query(`insert into app.recepcion (id, fecha, material, kg) values ($1, $2, 'Otro', 1)`, [adelantada, manana]);
  await db.exec(await readSql(PROTEGER));
  await db.query(`select app.editar('recepcion', $1, '{"kg": 2}'::jsonb, 'Maria', now())`, [adelantada]);
  assert.equal((await one(db, `select kg::int from app.recepcion where id = $1`, [adelantada])).kg, 2);
});

test('open mode again: it all comes back, except deleting rows with the public key', async () => {
  const db = await fresh();
  const c = await contenedor(db);
  await db.exec(await readSql(PROTEGER));
  await db.exec(await readSql(PERMITIR));
  await db.exec(await readSql(PERMITIR));
  assert.equal(await estricto(db), false);
  for (const t of TABLES) assert.deepEqual(await acceso(db, t), t === 'parametro' ? SOLO_LEER : ABIERTO, t);

  await comoAnon(db, tx => tx.query(`update app.contenedor set nota = 'x' where id = $1`, [c]));
  await comoAnon(db, tx => tx.query(`select app.borrar_registros($1::jsonb, null, 'Maria')`, [json([{ tabla: 'contenedor', id: c }])]));
  assert.ok((await one(db, `select deleted_at from app.contenedor where id = $1`, [c])).deleted_at);
  await assert.rejects(comoAnon(db, tx => tx.query(`delete from app.contenedor where id = $1`, [c])), code('42501'));
});

test('the modes say what is missing on a database without 0011, and change nothing', async () => {
  const { db } = await produccionHoy();
  for (const archivo of [PERMITIR, PROTEGER]) {
    await assert.rejects(db.exec(await readSql(archivo)), /Primero corre supabase\/esquema\/0011/);
    await db.exec('rollback');
  }
  assert.equal((await acceso(db, 'incubadora')).pols[0], 'demo_abierto:ALL');
});

/* ── the full delete ────────────────────────────────────────────────────── */

test('borrar_todos_los_datos: every record gone for good; settings, materials and names stay', async () => {
  const db = await fresh();
  const ja = await jaula(db);
  const inc = await incubadora(db, { jaulaId: ja });
  const d = distribucionDe(inc, 1);
  await distribuir(db, d);
  await contenedor(db);
  await db.query(`insert into app.separacion (id, caja_id, fecha, peso_total_kg) values ($1, $2, now(), 10)`, [uid(), d.cajas[0].id]);
  await db.query(`update app.parametro set valor = '6' where clave = 'huevos_bandeja_max_g'`);
  await db.query(`insert into app.catalogo (id, tipo, valor) values ($1, 'operario', 'QA Claude')`, [uid()]);
  await db.exec(await readSql(PROTEGER));
  const listas = await count(db, `select count(*)::int n from app.catalogo`);

  await db.exec(await readSql(BORRAR));

  for (const t of DATOS) assert.equal(await count(db, `select count(*)::int n from app.${t}`), 0, t);
  assert.equal(await count(db, `select count(*)::int n from app.catalogo`), listas);
  assert.equal(await count(db, `select count(*)::int n from app.catalogo where tipo = 'operario' and activo`), 2, 'Maria y Ricardo');
  assert.equal((await one(db, `select valor from app.parametro where clave = 'huevos_bandeja_max_g'`)).valor, 6);
  assert.equal(await estricto(db), true, 'el modo no cambia');
  assert.equal((await acceso(db, 'incubadora')).update, false, 'el modo no cambia');

  // The mark the phones read, and its updated_at is what makes them pull it.
  const m1 = await one(db, `select valor, updated_at from app.parametro where clave = 'datos_vaciados_at'`);
  assert.ok(Number.isFinite(Date.parse(m1.valor)), String(m1.valor));

  // Run again later: a new mark, and it still works on empty tables.
  await new Promise(res => setTimeout(res, 5));
  await db.exec(await readSql(BORRAR));
  const m2 = await one(db, `select valor, updated_at from app.parametro where clave = 'datos_vaciados_at'`);
  assert.ok(Date.parse(m2.valor) >= Date.parse(m1.valor));
  assert.ok(m2.updated_at > m1.updated_at);
  await db.exec(await readSql(PERMITIR));

  // The same codes and letters are free again.
  await incubadora(db, { jaulaId: await jaula(db) });
});
