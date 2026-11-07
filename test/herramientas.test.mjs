/**
 * The tools that check production, run here against a local Postgres built
 * from SETUP_COMPLETO.sql — so after running the SQL their verdict can be
 * trusted, rather than debugged against the live database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshPg, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';
import { comprobar } from '../tools/check-sql-applied.mjs';
import { verificar, revisarConfig } from '../tools/check-backend.mjs';
import { filasQa, ORDEN } from '../tools/qa.mjs';

const nuevo = async () => {
  const pg = await freshPg();
  await pg.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
  return pg;
};

test('check-sql-applied: everything ok once the schema ran, and it changes nothing', async () => {
  const pg = await nuevo();
  const res = await comprobar(pgClient(pg));
  assert.deepEqual(res.filter(r => !r.ok).map(r => r.label), []);
  assert.ok(res.length >= 30);
  for (const t of ORDEN) {
    assert.equal((await pg.query(`select count(*)::int n from app.${t}`)).rows[0].n, 0, `${t} quedó con filas`);
  }
});

test('check-sql-applied: on production as it is today it says 0011 is missing, and only that', async () => {
  const pg = await freshPg();
  await pg.exec(await readSql('supabase/esquema/0010_ciclo_nuevo.sql'));
  const res = await comprobar(pgClient(pg));
  assert.deepEqual(res.filter(r => r.mig === '0010' && !r.ok).map(r => r.label), []);
  assert.ok(res.filter(r => r.mig === '0011').every(r => !r.ok), JSON.stringify(res.filter(r => r.mig === '0011')));
  assert.equal(res.filter(r => r.mig === '0011').length, 6);
});

test('check-sql-applied: in protected mode everything is still there', async () => {
  const pg = await nuevo();
  await pg.exec(await readSql('supabase/operaciones/proteger_datos.sql'));
  assert.deepEqual((await comprobar(pgClient(pg))).filter(r => !r.ok).map(r => r.label), []);
});

test('check-sql-applied: before any of it, it says what is missing', async () => {
  const pg = await freshPg();
  const res = await comprobar(pgClient(pg));
  assert.ok(res.every(r => !r.ok || r.label.includes('ya no existen')));
});

test('check-backend: the whole cycle passes, and every row it made ends marked deleted', async () => {
  const pg = await nuevo();
  const fallas = [], oks = [];
  await verificar(pgClient(pg), { ok: l => oks.push(l), bad: (l, why) => fallas.push(`${l}: ${why}`) });
  assert.deepEqual(fallas, []);
  assert.ok(oks.includes('limpieza') && oks.length >= 12, oks.join(' | '));

  const filas = await filasQa(pgClient(pg), ['check-backend']);
  const vivas = ORDEN.flatMap(t => filas[t].filter(r => !r.deleted_at).map(() => t));
  assert.deepEqual(vivas, [], 'nada de la prueba queda vivo');
  assert.ok(ORDEN.filter(t => filas[t].length).length >= 15, 'tocó casi todas las tablas');

  // Run again: the codes and letters of the first run do not get in the way.
  const otra = [];
  await verificar(pgClient(pg), { ok: () => {}, bad: (l, why) => otra.push(`${l}: ${why}`) });
  assert.deepEqual(otra, []);
});

test('check-backend: the configuration mistakes people actually make', () => {
  const ok = { supabaseUrl: 'https://abcdefgh.supabase.co', supabaseAnonKey: 'x.eyJyb2xlIjoiYW5vbiJ9.y' };
  assert.equal(revisarConfig(ok), null);
  assert.match(revisarConfig({ ...ok, supabaseUrl: 'https://abcdefgh.supabase.co/rest/v1/' })[0], /endpoint REST/);
  assert.match(revisarConfig({ ...ok, supabaseAnonKey: 'x.' + Buffer.from('{"role":"service_role"}').toString('base64') + '.y' })[0],
               /service_role/);
  assert.match(revisarConfig({ ...ok, supabaseAnonKey: '' })[0], /Falta supabaseAnonKey/);
});
