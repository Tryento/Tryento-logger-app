/**
 * tx.js — promisified IndexedDB helpers.
 *
 * TRANSACTION LIFETIME: an IndexedDB transaction auto-commits as soon as the
 * event loop has no more requests queued against it. Awaiting a promise that
 * settles from an IDB success event is safe, because it resolves in a microtask
 * while the transaction is still live. Awaiting ANYTHING ELSE inside `withTx`
 * — a fetch, a timer, a blob read — lets the transaction commit underneath you
 * and every subsequent write silently targets a dead transaction. Do the async
 * work first, then open the transaction.
 */

export function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('idb request failed'));
  });
}

export function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('idb transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('idb transaction error'));
  });
}

/**
 * Run `fn` inside one transaction over `stores` and resolve only once it has
 * actually committed.
 *
 * Committing matters: a local write and its outbox entry must land together or
 * not at all. If the row were written and the queue entry lost, the device
 * would show data that can never reach the server and nothing would ever say so.
 */
export async function withTx(db, stores, mode, fn) {
  const names = Array.isArray(stores) ? stores : [stores];
  const tx = db.transaction(names, mode);
  const api = Object.fromEntries(names.map(n => [n, tx.objectStore(n)]));
  const done = txDone(tx);
  let result;
  try {
    result = await fn(api, tx);
  } catch (e) {
    try { tx.abort(); } catch { /* already finished */ }
    throw e;
  }
  await done;
  return result;
}

export const get = (db, store, key) =>
  withTx(db, store, 'readonly', s => reqToPromise(s[store].get(key)));

export const getAll = (db, store, query = null, count = undefined) =>
  withTx(db, store, 'readonly', s => reqToPromise(s[store].getAll(query, count)));

export const getAllByIndex = (db, store, index, query = null, count = undefined) =>
  withTx(db, store, 'readonly', s => reqToPromise(s[store].index(index).getAll(query, count)));

export const countAll = (db, store) =>
  withTx(db, store, 'readonly', s => reqToPromise(s[store].count()));

export const put = (db, store, value) =>
  withTx(db, store, 'readwrite', s => reqToPromise(s[store].put(value)));

export const del = (db, store, key) =>
  withTx(db, store, 'readwrite', s => reqToPromise(s[store].delete(key)));

export const clear = (db, store) =>
  withTx(db, store, 'readwrite', s => reqToPromise(s[store].clear()));

/** Bulk put into one store in a single transaction. */
export async function putAll(db, store, rows) {
  if (!rows || !rows.length) return 0;
  return withTx(db, store, 'readwrite', async s => {
    for (const r of rows) await reqToPromise(s[store].put(r));
    return rows.length;
  });
}

/**
 * Walk an index and collect rows matching `predicate`, stopping at `limit`.
 * Used where a full getAll would pull more into memory than needed.
 */
export async function scanIndex(db, store, index, { query = null, direction = 'next', limit = Infinity, predicate } = {}) {
  return withTx(db, store, 'readonly', async s => {
    const out = [];
    const req = s[store].index(index).openCursor(query, direction);
    await new Promise((resolve, reject) => {
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur || out.length >= limit) return resolve();
        if (!predicate || predicate(cur.value)) out.push(cur.value);
        cur.continue();
      };
    });
    return out;
  });
}

/* ── meta store: small durable key/value (sync cursors, cached session) ───── */

export const metaGet = async (db, key, fallback = null) => {
  const row = await get(db, 'meta', key);
  return row === undefined || row === null ? fallback : row.value;
};

export const metaSet = (db, key, value) =>
  put(db, 'meta', { key, value, updated_at: new Date().toISOString() });
