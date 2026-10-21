/**
 * tools/check-sync.mjs, run against a local Postgres built from
 * SETUP_COMPLETO.sql through the real sync engine — so its verdict on the
 * live project can be trusted.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './helpers/env.mjs';
import { freshPg, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const pg = await freshPg();
await pg.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
const servidor = pgClient(pg);
useBackend(servidor);
await freshDb();

const { probar } = await import('../tools/check-sync.mjs');
const { marcarQa, filasQa, ORDEN } = await import('../tools/qa.mjs');
const api = (await import('../dataClient.js')).default;
const { syncNow, stopSync } = await import('../src/data/sync/loop.js');
const { invalidarSnapshot } = await import('../src/data/snapshot.js');

test('check-sync: a whole cycle offline, synced, and seen from a fresh phone', async () => {
  const fallas = [], oks = [];
  try {
    await probar({
      api, db: servidor,
      sync: () => syncNow({ force: true }),
      borrarLocal: async () => { stopSync(); await freshDb(); invalidarSnapshot(); },
      t: { ok: l => oks.push(l), bad: (l, why) => fallas.push(`${l}: ${why}`) }
    });
  } finally {
    stopSync();
  }
  assert.deepEqual(fallas, []);
  assert.ok(oks.includes('otro teléfono lo ve igual'), oks.join(' | '));

  assert.equal(await marcarQa(servidor, ['check-sync']), 0);
  const filas = await filasQa(servidor, ['check-sync']);
  assert.deepEqual(ORDEN.flatMap(t => filas[t].filter(r => !r.deleted_at).map(() => t)), [], 'nada queda vivo');
  // The name was used, never added to the shared list.
  const nombres = (await pg.query(`select valor from app.catalogo where tipo = 'operario'`)).rows.map(r => r.valor);
  assert.ok(!nombres.includes('check-sync'));
});
