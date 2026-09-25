/**
 * store.js — local persistence: applying rows, and the atomic write path.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';
import { withIndexMirrors, EVENT_STORES } from './idb/schema.js';
import { refreshBandeja, REFRESH_STORES } from './cache.js';
import { enqueue, OPEN_STATUSES, STUCK_STATUSES } from './outbox.js';

/** Stores touched when writing to `store`, so a transaction can be opened once
 *  over exactly the right set. */
export function storesFor(store, { withOutbox = true } = {}) {
  const set = new Set([store]);
  if (withOutbox) { set.add('outbox'); set.add('meta'); }
  if (EVENT_STORES.includes(store) || store === 'lote_separacion' || store === 'bandeja') {
    for (const s of REFRESH_STORES) set.add(s);
  }
  return [...set];
}

/**
 * The write path: apply rows locally AND queue them for the server in ONE
 * transaction.
 *
 * These cannot be split. If the row were written and the queue entry lost, the
 * device would display data that can never reach the server, with nothing to
 * indicate it. If the queue entry were written and the row lost, the operator
 * would see their entry vanish and re-enter it, producing a duplicate.
 */
export async function commitWrite(db, { writes = [], outbox = null, refreshTrays = [] }) {
  const names = new Set(['outbox', 'meta']);
  for (const w of writes) names.add(w.store);
  if (refreshTrays.length) for (const s of REFRESH_STORES) names.add(s);

  return withTx(db, [...names], 'readwrite', async s => {
    for (const { store, row } of writes) {
      await reqToPromise(s[store].put(withIndexMirrors(store, row)));
    }
    let item = null;
    if (outbox) item = await enqueue(s, outbox);
    for (const id of new Set(refreshTrays.filter(Boolean))) {
      await refreshBandeja(s, id);
    }
    return item;
  });
}

/**
 * Apply rows that came from the server.
 *
 * A row with unsynced local work is NOT overwritten. The device's copy carries
 * changes the server has not seen; clobbering it would discard the operator's
 * entry and make the app look like it silently dropped their input. The pull
 * leaves it alone and the next push reconciles it.
 */
export async function applyServerRows(db, store, rows) {
  if (!rows?.length) return { applied: 0, skipped: 0, trays: [] };

  const open = (await getAllByIndex(db, 'outbox', 'by_status'))
    .filter(it => OPEN_STATUSES.includes(it.status) || STUCK_STATUSES.includes(it.status));
  const guarded = new Set(open.map(it => it.row_id).filter(Boolean));

  const trays = new Set();
  let applied = 0, skipped = 0;

  const names = new Set([store]);
  const isEvent = EVENT_STORES.includes(store) || store === 'lote_separacion';
  if (isEvent || store === 'bandeja') for (const s of REFRESH_STORES) names.add(s);

  await withTx(db, [...names], 'readwrite', async s => {
    for (const row of rows) {
      const key = store === 'lote_separacion'
        ? `${row.lote_id}:${row.separacion_id}`
        : row.id;
      if (guarded.has(key) || guarded.has(row.id)) { skipped++; continue; }
      await reqToPromise(s[store].put(withIndexMirrors(store, row)));
      applied++;
      if (row.bandeja_id) trays.add(row.bandeja_id);
      if (store === 'bandeja') trays.add(row.id);
    }
    if (names.has('bandeja_cache')) {
      for (const id of trays) await refreshBandeja(s, id);
    }
  });

  return { applied, skipped, trays: [...trays] };
}

/** Straight local upsert with no outbox entry — seeding and tests only. */
export async function putLocal(db, store, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  const trays = new Set();
  const names = new Set([store]);
  if (EVENT_STORES.includes(store) || store === 'bandeja' || store === 'lote_separacion') {
    for (const s of REFRESH_STORES) names.add(s);
  }
  await withTx(db, [...names], 'readwrite', async s => {
    for (const row of list) {
      await reqToPromise(s[store].put(withIndexMirrors(store, row)));
      if (row.bandeja_id) trays.add(row.bandeja_id);
      if (store === 'bandeja') trays.add(row.id);
    }
    if (names.has('bandeja_cache')) for (const id of trays) await refreshBandeja(s, id);
  });
  return list.length;
}

export const allRows = async (db, store) => {
  const rows = await getAllByIndex(db, store, 'by_updated').catch(async () => {
    return withTx(db, store, 'readonly', s => reqToPromise(s[store].getAll()));
  });
  return rows.filter(r => !r.deleted_at);
};

export const rowById = (db, store, id) =>
  withTx(db, store, 'readonly', s => reqToPromise(s[store].get(id)));

export const rowsByIndex = async (db, store, index, value) =>
  (await getAllByIndex(db, store, index, value)).filter(r => !r.deleted_at);
