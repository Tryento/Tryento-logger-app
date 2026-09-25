/**
 * open.js — database handle, upgrades, and durable-storage acquisition.
 */
import { DB_NAME, DB_VERSION, MIGRATIONS } from './schema.js';

let _dbPromise = null;

export function openDb() {
  if (_dbPromise) return _dbPromise;

  _dbPromise = new Promise((resolve, reject) => {
    const idb = globalThis.indexedDB;
    if (!idb) return reject(new Error('IndexedDB no disponible en este navegador'));

    const req = idb.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = ev => {
      const db = req.result;
      const from = ev.oldVersion || 0;
      // Apply only the steps this device has not seen. A phone carrying queued
      // outbox rows upgrades in place; nothing is dropped and nothing is
      // recreated.
      for (let v = from; v < DB_VERSION; v++) {
        MIGRATIONS[v](db, req.transaction, ev);
      }
    };

    req.onsuccess = () => {
      const db = req.result;
      // Another tab opened a newer version. Close so it is not blocked, and
      // force a reload rather than running against a schema we do not know.
      db.onversionchange = () => {
        db.close();
        _dbPromise = null;
        if (typeof location !== 'undefined' && typeof location.reload === 'function') {
          location.reload();
        }
      };
      resolve(db);
    };

    req.onerror = () => reject(req.error || new Error('no se pudo abrir la base local'));
    req.onblocked = () => {
      // Resolution still happens once the other tab closes; surfacing it beats
      // an unexplained hang.
      console.warn('[tryento] actualización de base local bloqueada por otra pestaña');
    };
  });

  return _dbPromise;
}

/**
 * Ask the browser to make this origin's storage durable.
 *
 * WHY THIS IS NOT OPTIONAL: without it, storage is "best-effort" and the
 * browser may evict it under pressure — and iOS clears site data after 7 days
 * of non-use unless the app is installed to the home screen. An evicted
 * database takes every unsynced capture with it, silently. This one call plus
 * "install to home screen" in the provisioning checklist is the whole defence.
 */
export async function requestPersistentStorage() {
  try {
    const s = navigator?.storage;
    if (!s) return { supported: false, persisted: false };
    if (typeof s.persisted === 'function' && await s.persisted()) {
      return { supported: true, persisted: true, alreadyGranted: true };
    }
    if (typeof s.persist !== 'function') return { supported: false, persisted: false };
    const persisted = await s.persist();
    return { supported: true, persisted };
  } catch {
    return { supported: false, persisted: false };
  }
}

/** Remaining quota, so the operator can be warned before writes start failing. */
export async function storageEstimate() {
  try {
    const s = navigator?.storage;
    if (!s || typeof s.estimate !== 'function') return null;
    const { usage = 0, quota = 0 } = await s.estimate();
    return { usage, quota, ratio: quota > 0 ? usage / quota : 0 };
  } catch {
    return null;
  }
}

/** Test seam — drops the handle so the next openDb() reopens. */
export function __closeDb() {
  const p = _dbPromise;
  _dbPromise = null;
  if (p) p.then(db => { try { db.close(); } catch { /* noop */ } }).catch(() => {});
}
