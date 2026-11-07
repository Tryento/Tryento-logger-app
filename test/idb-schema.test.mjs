/**
 * The phone's database: a fresh install and an upgrade are exactly the schema
 * declared, an upgrade keeps the queue, and the database of the earlier protocols
 * is deleted (nothing in it can sync: 0010 rebuilt every table it names).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, __closeDb } from './helpers/env.mjs';
import { STORE_DEFS, SYNCED_STORES, LOCAL_STORES, DB_NAME, DB_VERSION, LEGACY_DB_NAMES, MIGRATIONS } from '../src/data/idb/schema.js';
import { deleteLegacyDbs, openDb } from '../src/data/idb/open.js';

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

const declarado = () => {
  const out = {};
  for (const [name, def] of Object.entries(STORE_DEFS)) {
    out[name] = { keyPath: def.keyPath,
                  indexes: def.indexes.map(([i, k]) => [i, k]).sort((a, b) => a[0].localeCompare(b[0])) };
  }
  return out;
};

test('a fresh install is exactly STORE_DEFS', async () => {
  const db = await freshDb();
  assert.equal(db.name, 'tryento-ciclo');
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(forma(db), declarado());
  assert.deepEqual(Object.keys(STORE_DEFS).sort(), [...SYNCED_STORES, ...LOCAL_STORES].sort());
  for (const s of SYNCED_STORES) {
    assert.ok(STORE_DEFS[s].indexes.some(([i]) => i === 'by_updated'), `${s} needs by_updated: the reads list by it`);
  }
});

test('v1 to v2: the racks go, and the queue keeps everything that can still land', async () => {
  // A phone on v1, with work queued.
  __closeDb();
  await new Promise(resolve => { const q = indexedDB.deleteDatabase(DB_NAME); q.onsuccess = q.onerror = q.onblocked = () => resolve(); });
  const v1 = await new Promise((resolve, reject) => {
    const q = indexedDB.open(DB_NAME, 1);
    q.onupgradeneeded = () => MIGRATIONS[0](q.result, q.transaction);
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const item = (id, seq, extra) => ({ id, seq, status: 'pending', op: 'rpc', row_ids: [], ...extra });
  const cola = [
    item('o-rack', 1, { op: 'upsert', table: 'rack', payload: { id: 'r1', codigo: 'R1' } }),
    item('o-inc', 2, { op: 'upsert', table: 'incubadora', payload: { id: 'i1', codigo: 'F7A-1', rack_id: 'r1' }, depends_on: ['j1', 'r1'],
                       undo: { created: [{ store: 'incubadora', key: 'i1' }], changed: [] } }),
    item('o-mov', 3, { op: 'upsert', table: 'movimiento', payload: { id: 'm1', objeto_id: 'i1', rack_hasta: 'r1' } }),
    item('o-solo-rack', 4, { rpc: 'editar', payload: { p_tabla: 'incubadora', p_id: 'i1', p_cambios: { rack_id: 'r2' } } }),
    item('o-edita', 5, { rpc: 'editar', payload: { p_tabla: 'incubadora', p_id: 'i1', p_cambios: { rack_id: 'r2', nota: 'tapa rota' } } }),
    item('o-edita-rack', 6, { rpc: 'editar', payload: { p_tabla: 'rack', p_id: 'r1', p_cambios: { nota: 'x' } } }),
    item('o-revisa', 7, { rpc: 'marcar_revisado', payload: { p_tabla: 'movimiento', p_id: 'm1' } }),
    item('o-borra', 8, { rpc: 'borrar_registros', payload: { p_filas: [{ tabla: 'caja', id: 'c1' }, { tabla: 'movimiento', id: 'm1' }] },
                         undo: { created: [], changed: [{ store: 'caja', key: 'c1', fields: {} }, { store: 'movimiento', key: 'm1', fields: {} }] } }),
    item('o-borra-rack', 9, { rpc: 'borrar_registros', payload: { p_filas: [{ tabla: 'rack', id: 'r1' }] } }),
    item('o-dist', 10, { rpc: 'distribuir', payload: { p_cajas: [{ id: 'c1', rack_id: 'r1' }] } })
  ];
  await new Promise((resolve, reject) => {
    const tx = v1.transaction(['rack', 'incubadora', 'outbox', 'conflicts'], 'readwrite');
    tx.objectStore('rack').put({ id: 'r1', codigo: 'R1' });
    tx.objectStore('incubadora').put({ id: 'i1', codigo: 'F7A-1', rack_id: 'r1' });
    for (const it of cola) tx.objectStore('outbox').put(it);
    tx.objectStore('conflicts').put({ id: 'c-rack', outbox_id: 'o-rack', table: 'rack', _resuelto: 0, created_at: 'x' });
    tx.objectStore('conflicts').put({ id: 'c-inc', outbox_id: 'o-inc', table: 'incubadora', _resuelto: 0, created_at: 'x' });
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  v1.close();

  const db = await openDb();
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(forma(db), declarado());

  const leer = store => new Promise((resolve, reject) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => resolve(q.result);
    q.onerror = () => reject(q.error);
  });
  const quedan = Object.fromEntries((await leer('outbox')).map(i => [i.id, i]));
  assert.deepEqual(Object.keys(quedan).sort(), ['o-borra', 'o-dist', 'o-edita', 'o-inc']);
  assert.deepEqual(quedan['o-inc'].payload, { id: 'i1', codigo: 'F7A-1' });
  assert.deepEqual(quedan['o-edita'].payload.p_cambios, { nota: 'tapa rota' });
  assert.deepEqual(quedan['o-borra'].payload.p_filas, [{ tabla: 'caja', id: 'c1' }]);
  assert.deepEqual(quedan['o-borra'].undo.changed.map(c => c.store), ['caja'], '«Descartar» no busca un almacén que ya no existe');
  assert.deepEqual(quedan['o-dist'].payload, { p_cajas: [{ id: 'c1', rack_id: 'r1' }] }, 'la función lee sólo lo que necesita');
  assert.deepEqual((await leer('conflicts')).map(c => c.id), ['c-inc']);
  assert.deepEqual((await leer('incubadora')).map(i => i.id), ['i1'], 'los datos se quedan');
  __closeDb();
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
