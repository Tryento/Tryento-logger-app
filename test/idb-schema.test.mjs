/**
 * The phone's database: a fresh install is exactly the schema declared, and
 * the database of the earlier protocols is deleted (nothing in it can sync:
 * 0010 rebuilt every table it names).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, __closeDb } from './helpers/env.mjs';
import { STORE_DEFS, SYNCED_STORES, LOCAL_STORES, DB_NAME, DB_VERSION, LEGACY_DB_NAMES } from '../src/data/idb/schema.js';
import { deleteLegacyDbs } from '../src/data/idb/open.js';

const forma = db => {
  const tx = db.transaction([...db.objectStoreNames], 'readonly');
  const out = {};
  for (const name of db.objectStoreNames) {
    const s = tx.objectStore(name);
    out[name] = {
      keyPath: s.keyPath,
      indexes: [...s.indexNames].map(i => [i, s.index(i).keyPath]).sort((a, b) => a[0].localeCompare(b[0]))
    };
  }
  return out;
};

test('a fresh install is exactly STORE_DEFS', async () => {
  const db = await freshDb();
  assert.equal(db.name, 'tryento-ciclo');
  assert.equal(db.version, DB_VERSION);
  const esperado = {};
  for (const [name, def] of Object.entries(STORE_DEFS)) {
    esperado[name] = { keyPath: def.keyPath,
                       indexes: def.indexes.map(([i, k]) => [i, k]).sort((a, b) => a[0].localeCompare(b[0])) };
  }
  assert.deepEqual(forma(db), esperado);
  assert.deepEqual(Object.keys(STORE_DEFS).sort(), [...SYNCED_STORES, ...LOCAL_STORES].sort());
  for (const s of SYNCED_STORES) {
    assert.ok(STORE_DEFS[s].indexes.some(([i]) => i === 'by_updated'), `${s} needs by_updated: the reads list by it`);
  }
});

test('the database of the earlier protocols is deleted at start; this one is not', async () => {
  // A phone that ran the earlier version: its database is still there.
  await new Promise((resolve, reject) => {
    const req = indexedDB.open('tryento', 4);
    req.onupgradeneeded = () => req.result.createObjectStore('bandeja', { keyPath: 'id' });
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  await freshDb();
  const antes = (await indexedDB.databases()).map(d => d.name).sort();
  assert.deepEqual(antes, ['tryento', 'tryento-ciclo']);

  assert.deepEqual(await deleteLegacyDbs(), LEGACY_DB_NAMES);
  const despues = (await indexedDB.databases()).map(d => d.name);
  assert.deepEqual(despues, [DB_NAME]);
  __closeDb();
});
