/**
 * Test environment: a real IndexedDB implementation in Node, plus a clean
 * database per test.
 */
import 'fake-indexeddb/auto';
import { openDb, __closeDb } from '../../src/data/idb/open.js';
import { DB_NAME } from '../../src/data/idb/schema.js';

export async function freshDb() {
  __closeDb();
  await new Promise(resolve => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
  return openDb();
}

export { openDb, __closeDb };

/** Build a throwaway error shaped like the ones supabase-js surfaces. */
export function pgError(code, message = 'boom') {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function httpError(status, message = 'http') {
  const e = new Error(message);
  e.status = status;
  return e;
}

export function networkError() {
  const e = new TypeError('Failed to fetch');
  return e;
}
