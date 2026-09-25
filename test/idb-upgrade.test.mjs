/**
 * Upgrading a device that already has the old local database.
 *
 * The bug this exists to prevent: renaming cochada -> lote changed INDEXEDDB
 * STORE NAMES without bumping DB_VERSION. A phone that had already opened the
 * app kept the old stores, the new code opened a transaction on `lote`, and
 * IndexedDB threw NotFoundError. That aborted start-up, so the sync status
 * never loaded — and the screen rendered that as "no hay servidor configurado",
 * which looks like a backend problem and is not one.
 *
 * Any future change to store names or indexes needs a new MIGRATIONS entry and
 * a case here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { DB_NAME, DB_VERSION, MIGRATIONS } from '../src/data/idb/schema.js';
import { openDb, __closeDb } from '../src/data/idb/open.js';

const del = name => new Promise(r => {
  const q = indexedDB.deleteDatabase(name);
  q.onsuccess = q.onerror = q.onblocked = r;
});

/** Recreate the v1 database exactly as it shipped, old store names and all. */
function createLegacyV1(name) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      const plain = ['catalogo', 'insectario', 'recoleccion', 'bandeja',
                     'alimentacion', 'ayuno', 'revision', 'separacion',
                     'bandeja_cache', 'blobs', 'conflicts'];
      for (const n of plain) db.createObjectStore(n, { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('outbox', { keyPath: 'id' });
      // The stores that no longer exist under these names.
      db.createObjectStore('cochada', { keyPath: 'id' });
      db.createObjectStore('cochada_separacion', { keyPath: ['cochada_id', 'separacion_id'] });
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('outbox', 'readwrite');
      // Queued work that must survive the upgrade and be retargeted.
      tx.objectStore('outbox').put({
        id: 'q1', seq: 1, op: 'upsert', table: 'cochada',
        row_id: 'c1', payload: { id: 'c1', codigo: 'CO-1' }, status: 'pending'
      });
      tx.objectStore('outbox').put({
        id: 'q2', seq: 2, op: 'rpc', rpc: 'crear_cochada', row_id: 'c2',
        payload: { p_cochada: { id: 'c2' }, p_separacion_ids: ['s1'] }, status: 'pending'
      });
      tx.objectStore('outbox').put({
        id: 'q3', seq: 3, op: 'upsert', table: 'bandeja',
        row_id: 'b1', payload: { id: 'b1' }, status: 'pending'
      });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

test('the version is bumped whenever migrations are added', () => {
  assert.equal(DB_VERSION, MIGRATIONS.length,
    'DB_VERSION se deriva de MIGRATIONS.length; no lo fijes a mano');
  assert.ok(DB_VERSION >= 2, 'el renombrado cochada -> lote necesita una migracion v2');
});

test('REGRESSION: a phone with the old database upgrades instead of crashing', async () => {
  __closeDb();
  await del(DB_NAME);
  await createLegacyV1(DB_NAME);

  // This is the call that threw NotFoundError before the fix.
  const db = await openDb();
  const names = [...db.objectStoreNames];

  assert.ok(names.includes('lote'), 'falta el almacen lote');
  assert.ok(names.includes('lote_separacion'), 'falta el almacen lote_separacion');
  assert.ok(!names.includes('cochada'), 'el almacen viejo debe desaparecer');
  assert.ok(!names.includes('cochada_separacion'), 'el almacen puente viejo debe desaparecer');
  assert.equal(db.version, DB_VERSION);
});

test('REGRESSION: a transaction on the renamed store actually works', async () => {
  // The precise operation that aborted start-up.
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(['lote', 'lote_separacion'], 'readwrite');
    tx.objectStore('lote').put({ id: 'x1', codigo: 'CO-TEST' });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
});

test('queued work survives the upgrade and targets the new names', async () => {
  const db = await openDb();
  const rows = await new Promise((resolve, reject) => {
    const req = db.transaction('outbox', 'readonly').objectStore('outbox').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  assert.equal(rows.length, 3, 'no se puede perder trabajo encolado en una actualizacion');

  const q1 = rows.find(r => r.id === 'q1');
  assert.equal(q1.table, 'lote', 'la tabla destino debe renombrarse');

  const q2 = rows.find(r => r.id === 'q2');
  assert.equal(q2.rpc, 'crear_lote');
  assert.ok(q2.payload.p_lote, 'el argumento del RPC debe renombrarse');
  assert.equal(q2.payload.p_cochada, undefined);

  const q3 = rows.find(r => r.id === 'q3');
  assert.equal(q3.table, 'bandeja', 'lo que no cambio debe quedar intacto');

  __closeDb();
  await del(DB_NAME);
});
