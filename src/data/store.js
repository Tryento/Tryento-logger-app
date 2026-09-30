/**
 * store.js — local persistence: applying rows, and the atomic write path.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';
import { withIndexMirrors, EVENT_STORES } from './idb/schema.js';
import { refreshBandeja, REFRESH_STORES } from './cache.js';
import { enqueue, rowsOf, OPEN_STATUSES, STUCK_STATUSES } from './outbox.js';

/** The primary key of `row` in `store`, whatever its keyPath shape. */
export function keyOf(store, row) {
  const kp = store.keyPath;
  return Array.isArray(kp) ? kp.map(k => row[k]) : row[kp];
}

/** Local bookkeeping that is not part of what an operator did. */
const NOT_A_CHANGE = new Set(['updated_at', 'synced_at', '_abierto', '_resuelto']);

/** Fields that differ between two versions of a row, as {field: [before, after]}. */
function diffFields(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before || {}), ...Object.keys(after || {})])) {
    if (NOT_A_CHANGE.has(k)) continue;
    const a = before?.[k] ?? null, b = after?.[k] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = [a, b];
  }
  return out;
}

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
    // What this write did, so "Descartar" can take back exactly that and
    // nothing else: rows it created are removed, fields it changed go back.
    const created = [], changed = [];
    for (const { store, row } of writes) {
      const key = keyOf(s[store], row);
      const before = key === undefined ? undefined : await reqToPromise(s[store].get(key));
      const next = withIndexMirrors(store, row);
      await reqToPromise(s[store].put(next));
      if (!before) created.push({ store, key });
      else {
        const fields = diffFields(before, next);
        if (Object.keys(fields).length) changed.push({ store, key, fields });
      }
    }
    let item = null;
    if (outbox) {
      const createdIds = created.map(c => c.key).filter(k => typeof k === 'string');
      item = await enqueue(s, {
        ...outbox,
        rowIds: [...(outbox.rowIds || []), ...createdIds],
        undo: { created, changed }
      });
    }
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
  if (!rows?.length) return { applied: 0, changed: 0, skipped: 0, trays: [] };

  const open = (await getAllByIndex(db, 'outbox', 'by_status'))
    .filter(it => OPEN_STATUSES.includes(it.status) || STUCK_STATUSES.includes(it.status));
  const guarded = new Set(open.flatMap(rowsOf));

  const trays = new Set();
  // `changed` leaves out rows this phone already had exactly as they are: every
  // pull re-reads its overlap window, and that is not news for the screens.
  let applied = 0, changed = 0, skipped = 0;

  const names = new Set([store]);
  const isEvent = EVENT_STORES.includes(store) || store === 'lote_separacion';
  if (isEvent || store === 'bandeja') for (const s of REFRESH_STORES) names.add(s);

  await withTx(db, [...names], 'readwrite', async s => {
    for (const row of rows) {
      const key = store === 'lote_separacion'
        ? `${row.lote_id}:${row.separacion_id}`
        : row.id;
      if (guarded.has(key) || guarded.has(row.id)) { skipped++; continue; }
      const cur = await reqToPromise(s[store].get(
        store === 'lote_separacion' ? [row.lote_id, row.separacion_id] : row.id));
      if (!cur || cur.updated_at !== row.updated_at || (cur.deleted_at || null) !== (row.deleted_at || null)) changed++;
      await reqToPromise(s[store].put(withIndexMirrors(store, row)));
      applied++;
      if (row.bandeja_id) trays.add(row.bandeja_id);
      if (store === 'bandeja') trays.add(row.id);

      // A value seeded on this phone before the first sync gives way to the
      // server's copy of the same value. The two have different ids, so without
      // this every picker showed each option twice.
      if (store === 'catalogo' && row.tipo) {
        const locals = await reqToPromise(s.catalogo.index('by_tipo').getAll(row.tipo));
        const same = String(row.valor ?? '').trim().toLowerCase();
        for (const l of locals) {
          if (l._seeded && l.id !== row.id && String(l.valor ?? '').trim().toLowerCase() === same) {
            await reqToPromise(s.catalogo.delete(l.id));
          }
        }
      }
    }
    if (names.has('bandeja_cache')) {
      for (const id of trays) await refreshBandeja(s, id);
    }
  });

  return { applied, changed, skipped, trays: [...trays] };
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
