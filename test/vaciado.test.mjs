/**
 * The full delete (supabase/operaciones/borrar_todos_los_datos.sql), as a phone
 * lives it. An erased row never reaches a phone by pulling, so a phone that
 * already had the rows must learn it some other way, forget them, and not send
 * back what it had queued. Real SQL, the real sync pass.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb, openDb } from './helpers/env.mjs';
import { freshPg, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { syncNow, stopSync } = await import('../src/data/sync/loop.js');
const { outboxStats } = await import('../src/data/outbox.js');
const { listConflicts } = await import('../src/data/conflicts.js');
const { invalidarSnapshot } = await import('../src/data/snapshot.js');
const { reqToPromise, withTx } = await import('../src/data/idb/tx.js');

const pg = await freshPg();
await pg.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
useBackend(pgClient(pg));
await freshDb();
const db = await openDb();

const okData = res => { assert.ok(res.ok, JSON.stringify(res.error)); return res.data; };
const sync = async () => { const out = await syncNow({ force: true }); stopSync(); return out; };
const enServidor = async t => (await pg.query(`select count(*)::int n from app.${t}`)).rows[0].n;
const pausa = (ms = 5) => new Promise(res => setTimeout(res, ms));
const borrarTodo = async () => { await pg.exec(await readSql('supabase/operaciones/borrar_todos_los_datos.sql')); await pausa(); };

await w.setCurrentOperator('Maria');
await sync();
const S = {};

test('a phone with synced rows, queued work and a photo, then the full delete', async () => {
  S.cont = okData(await w.registrarContenedor({ codigo: 'S1' })).id;
  S.ica = okData(await w.registrarJaula({ nombre: 'ICA', letra: 'A', generacion: 7, fase: 'activa' })).id;
  S.inc = okData(await w.registrarRecolecta({ jaula_id: S.ica, peso_inicial_g: 12, n_bandejas: 3, alimento_bandeja_g: 400 })).id;
  await sync();
  assert.equal(await enServidor('incubadora'), 1);
  assert.equal((await outboxStats(db)).unsynced, 0);

  // Written with the signal gone: still on the phone when the delete happens.
  okData(await w.registrarChequeos({ objeto: 'incubadora', dia: 3, items: [{ id: S.inc, humedad_pct: 60, temperatura_c: 30, peso: 40 }] }));
  S.otra = okData(await w.registrarJaula({ nombre: 'ICB', letra: 'B', generacion: 7, fase: 'activa' })).id;
  okData(await w.rememberOperator('Jose'));
  await withTx(db, 'blobs', 'readwrite', s => reqToPromise(s.blobs.put({
    id: 'foto-vieja', blob: new Uint8Array([1]), bytes: 1, status: 'pending', key: 'jaula/x/foto-vieja.jpg', created_at: new Date().toISOString() })));
  assert.ok((await outboxStats(db)).unsynced >= 3);
  await pausa();

  await borrarTodo();
  assert.equal(await enServidor('incubadora'), 0);
  assert.equal(await enServidor('jaula'), 0);

  const { pushed } = await sync();
  assert.equal(pushed.conflicts, 0, JSON.stringify(await listConflicts(db)));

  // Nothing came back: what it had queued from before was not sent.
  assert.equal(await enServidor('jaula'), 0, 'lo que estaba en cola no vuelve al servidor');
  assert.equal(await enServidor('chequeo'), 0);
  assert.equal((await outboxStats(db)).unsynced, 0);

  // The phone forgot it all.
  invalidarSnapshot();
  const lab = okData(await r.getLaboratorio());
  assert.deepEqual([lab.insectarios.length, lab.bandejas.length], [0, 0]);
  assert.equal(okData(await r.listContenedores()).length, 0);
  assert.equal((await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.get('foto-vieja')))), undefined, 'ni la foto');

  // Settings, materials and names stay; a name queued before it still joined the list.
  assert.equal(okData(await r.getProtocolo()).alimento_bandeja_g, 400);
  assert.equal(okData(await r.listCatalogo('material_alimento')).length, 4);
  assert.ok(okData(await r.listOperators()).includes('Jose'));
  assert.equal((await pg.query(`select count(*)::int n from app.catalogo where valor = 'Jose'`)).rows[0].n, 1);
});

test('it happens once: what is registered afterwards stays and syncs', async () => {
  await pausa();
  const nueva = okData(await w.registrarJaula({ nombre: 'ICA', letra: 'A', generacion: 8, fase: 'activa' }));
  assert.equal(nueva.nombre, 'ICA', 'los nombres y las letras quedan libres');
  await sync();
  await sync();
  invalidarSnapshot();
  assert.equal(await enServidor('jaula'), 1);
  assert.deepEqual(okData(await r.getLaboratorio()).insectarios.map(j => j.id), [nueva.id]);
  S.ica = nueva.id;
});

test('work done after the delete on what it erased surfaces in Conflictos, not lost', async () => {
  // Registered, then the server emptied, then a recolecta on it before this phone hears.
  await pausa();
  await borrarTodo();
  await pausa();
  okData(await w.registrarRecolecta({ jaula_id: S.ica, peso_inicial_g: 12, n_bandejas: 3, alimento_bandeja_g: 400 }));
  const { pushed } = await sync();
  assert.equal(pushed.conflicts, 1);
  const [c] = await listConflicts(db);
  assert.match(c.explanation, /depende de un registro que no existe/);
});

test('a phone that never had anything just notes it, and a later delete counts again', async () => {
  await freshDb();
  const nuevo = await openDb();
  await w.setCurrentOperator('Ricardo');
  await sync();
  invalidarSnapshot();
  assert.equal(okData(await r.getProtocolo()).pct_coccion, 98);
  assert.deepEqual(okData(await r.getLaboratorio()).insectarios, []);

  const j = okData(await w.registrarJaula({ nombre: 'ICZ', letra: 'Z', generacion: 1, fase: 'activa' }));
  await sync();
  assert.equal(await enServidor('jaula'), 1);
  await pausa();
  await borrarTodo();
  await sync();
  invalidarSnapshot();
  assert.equal(await enServidor('jaula'), 0);
  assert.equal((await withTx(nuevo, 'jaula', 'readonly', s => reqToPromise(s.jaula.get(j.id)))), undefined);
});
