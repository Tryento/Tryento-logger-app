/**
 * store.js — local persistence: applying rows, and the atomic write path.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';
import { withIndexMirrors } from './idb/schema.js';
import { enqueue, rowsOf, OPEN_STATUSES, STUCK_STATUSES } from './outbox.js';

/** The primary key of `row` in `store`, whatever its keyPath shape. */
export function keyOf(store, row) {
  const kp = store.keyPath;
  return Array.isArray(kp) ? kp.map(k => row[k]) : row[kp];
}

/** Local bookkeeping that is not part of what an operator did. */
const NOT_A_CHANGE = new Set(['updated_at', 'synced_at', '_resuelto']);

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

/**
 * The write path: apply rows locally AND queue them for the server in ONE
 * transaction.
 *
 * These cannot be split. If the row were written and the queue entry lost, the
 * device would display data that can never reach the server, with nothing to
 * indicate it. If the queue entry were written and the row lost, the operator
 * would see their entry vanish and re-enter it, producing a duplicate.
 */
export async function commitWrite(db, { writes = [], outbox = null }) {
  const names = new Set(['outbox', 'meta']);
  for (const w of writes) names.add(w.store);

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
  if (!rows?.length) return { applied: 0, changed: 0, skipped: 0 };

  const open = (await getAllByIndex(db, 'outbox', 'by_status'))
    .filter(it => OPEN_STATUSES.includes(it.status) || STUCK_STATUSES.includes(it.status));
  const guarded = new Set(open.flatMap(rowsOf));

  // `changed` leaves out rows this phone already had exactly as they are: every
  // pull re-reads its overlap window, and that is not news for the screens.
  let applied = 0, changed = 0, skipped = 0;

  await withTx(db, [store], 'readwrite', async s => {
    for (const row of rows) {
      if (guarded.has(row.id)) { skipped++; continue; }
      const cur = await reqToPromise(s[store].get(row.id));
      if (!cur || cur.updated_at !== row.updated_at || (cur.deleted_at || null) !== (row.deleted_at || null)) changed++;
      await reqToPromise(s[store].put(withIndexMirrors(store, row)));
      applied++;

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
  });

  return { applied, changed, skipped };
}

/** Straight local upsert with no outbox entry — seeding and tests only. */
export async function putLocal(db, store, rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  await withTx(db, [store], 'readwrite', async s => {
    for (const row of list) await reqToPromise(s[store].put(withIndexMirrors(store, row)));
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
