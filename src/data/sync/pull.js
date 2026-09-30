/**
 * pull.js — bring server changes down.
 *
 * ── The overlap is not optional ─────────────────────────────────────────────
 * `updated_at` is set with now(), which in Postgres is TRANSACTION-START time.
 * A transaction that begins before your cursor but commits after it writes rows
 * whose updated_at is already in the cursor's past. A bare `> last_sync` cursor
 * therefore skips them PERMANENTLY — the classic timestamp-sync data-loss bug,
 * and one that is nearly impossible to notice because the rows simply never
 * appear.
 *
 * Two defences, both required:
 *   1. query from (cursor - PULL_OVERLAP_MS), so a late commit is re-read
 *   2. advance the cursor to the max updated_at ACTUALLY RETURNED, never to the
 *      client's wall clock (which may be skewed, and is not the server's)
 * Re-reading is free because local upsert is idempotent.
 */
import { getClient, toError, canSync } from '../supabase.js';
import { SYNCED_STORES } from '../idb/schema.js';
import { PULL_OVERLAP_MS, PULL_PAGE_SIZE } from '../config.js';
import { metaGet, metaSet } from '../idb/tx.js';
import { applyServerRows } from '../store.js';
import { rebuildAll } from '../cache.js';

const cursorKey = table => `pull_cursor:${table}`;
const EPOCH = '1970-01-01T00:00:00.000Z';

/** Columns holding an instant, normalised to the canonical stored form. */
const INSTANT_FIELDS = new Set([
  'fecha', 'created_at', 'updated_at', 'synced_at', 'deleted_at',
  'cerrado_at', 'empacado_at', 'despachado_at', 'rechazado_at', 'resuelto_at',
  'distribuida_at', 'fecha_armado', 'sellado_at', 'listo_at', 'en_uso_at', 'agotado_at'
]);

/** Tables without an `id` column (composite key). They page on time alone. */
const SIN_ID = new Set(['lote_separacion']);

/**
 * A server timestamp as microseconds, for comparing cursors. The server sends
 * `…12:30:00.123456+00:00`; older cursors were stored as `…12:30:00.123Z`. A
 * plain string compare of the two formats gets the order wrong.
 */
export function tsMicros(s) {
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return -Infinity;
  const m = /\.(\d+)/.exec(String(s));
  const frac = m ? Number(m[1].padEnd(6, '0').slice(0, 6)) : 0;
  return Math.floor(ms / 1000) * 1e6 + frac;
}

const FULL_ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * PostgREST returns `2026-09-22T12:30:00+00:00`; we store `...Z`. Lists sort
 * dates with a plain string compare, so a mix of formats would silently
 * misorder the timeline.
 *
 * DATE columns (`fecha_inicio`, `cierre_real`, `fecha_vencimiento`, the
 * projections) are calendar facts and are deliberately left as `YYYY-MM-DD`.
 */
export function normalizeRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'string' && INSTANT_FIELDS.has(k) && FULL_ISO.test(v)) {
      const d = new Date(v);
      out[k] = Number.isNaN(d.getTime()) ? v : d.toISOString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Page through one table from its cursor.
 *
 * Pages are ordered by (updated_at, id). When a full page ends inside a group
 * of rows that share one updated_at — a bulk load writes thousands of rows in
 * one transaction, and they all get the same now() — the rest of that group is
 * read by id before moving past it. Paging on time alone skipped every row of
 * such a group beyond the first page, silently and for good.
 *
 * Cursors are kept in the server's own format, with microseconds, so the
 * equality used to finish a group is exact.
 */
async function pullTable(db, client, table) {
  const cursor = await metaGet(db, cursorKey(table), EPOCH);
  const from = new Date(Math.max(0, Date.parse(cursor) - PULL_OVERLAP_MS)).toISOString();
  const hasId = !SIN_ID.has(table);

  let since = from;
  let groupAfterId = null;       // set while finishing a group of equal updated_at
  let total = 0, skipped = 0;
  let maxSeen = cursor;
  const trays = new Set();

  for (let page = 0; page < 1000; page++) {
    let q = client.from(table).select('*');
    q = groupAfterId !== null
      ? q.eq('updated_at', since).gt('id', groupAfterId).order('id', { ascending: true })
      : hasId
        ? q.gt('updated_at', since).order('updated_at', { ascending: true }).order('id', { ascending: true })
        : q.gt('updated_at', since).order('updated_at', { ascending: true });
    const { data, error } = await q.limit(PULL_PAGE_SIZE);

    if (error) throw toError(error);

    if (data?.length) {
      const res = await applyServerRows(db, table, data.map(normalizeRow));
      total += res.applied;
      skipped += res.skipped;
      for (const t of res.trays) trays.add(t);
    }

    if (groupAfterId !== null) {
      // Still inside the group: carry on by id until it runs out, then resume
      // with everything strictly after the group's timestamp.
      groupAfterId = data?.length === PULL_PAGE_SIZE ? data[data.length - 1].id : null;
      continue;
    }

    if (!data?.length) break;
    const lastRaw = data[data.length - 1].updated_at;
    if (tsMicros(lastRaw) > tsMicros(maxSeen)) maxSeen = lastRaw;
    if (data.length < PULL_PAGE_SIZE) break;

    if (hasId) {
      since = lastRaw;
      groupAfterId = data[data.length - 1].id;
    } else {
      if (tsMicros(lastRaw) <= tsMicros(since)) break;   // guard against a stalled cursor
      since = lastRaw;
    }
  }

  // Only ever advance to a timestamp the SERVER produced.
  if (tsMicros(maxSeen) > tsMicros(cursor)) await metaSet(db, cursorKey(table), maxSeen);

  return { table, applied: total, skipped, trays: [...trays] };
}

/**
 * Fetch specific rows again, e.g. after "Descartar" took back a local change:
 * the server may hold another phone's version, older than this table's cursor,
 * which a delta pull would never bring back.
 */
export async function refetchRows(db, refs) {
  const client = getClient();
  if (!client || !canSync() || !refs?.length) return 0;
  const byStore = new Map();
  for (const { store, id } of refs) {
    if (!SYNCED_STORES.includes(store) || SIN_ID.has(store)) continue;
    if (!byStore.has(store)) byStore.set(store, new Set());
    byStore.get(store).add(id);
  }
  let n = 0;
  for (const [store, ids] of byStore) {
    const { data, error } = await client.from(store).select('*').in('id', [...ids]);
    if (error) throw toError(error);
    if (data?.length) n += (await applyServerRows(db, store, data.map(normalizeRow))).applied;
  }
  return n;
}

export async function pullOnce(db, { tables = SYNCED_STORES } = {}) {
  const summary = { tables: [], applied: 0, skipped: 0, errors: [] };
  const client = getClient();
  if (!client || !canSync()) return summary;

  // Parent-first, so a child never lands before the row it references.
  for (const table of tables) {
    try {
      const r = await pullTable(db, client, table);
      summary.tables.push(r);
      summary.applied += r.applied;
      summary.skipped += r.skipped;
    } catch (err) {
      summary.errors.push({ table, message: err.message, code: err.code || null });
      // Keep going: one unreadable table must not block the rest.
    }
  }
  return summary;
}

/**
 * First-run hydration. Identical mechanics to a delta pull (cursors start at
 * the epoch), then one full cache rebuild — cheaper than maintaining the
 * rollup incrementally across thousands of seeded rows.
 */
export async function initialPull(db) {
  const summary = await pullOnce(db);
  await rebuildAll(db);
  await metaSet(db, 'initial_pull_at', new Date().toISOString());
  return summary;
}

export const hasInitialPull = async db =>
  Boolean(await metaGet(db, 'initial_pull_at', null));

/** Force a full re-read, e.g. after a schema change or suspected drift. */
export async function resetCursors(db) {
  for (const t of SYNCED_STORES) await metaSet(db, cursorKey(t), EPOCH);
  await metaSet(db, 'initial_pull_at', null);
}
