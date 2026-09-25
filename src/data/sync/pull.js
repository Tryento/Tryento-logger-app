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
  'cerrado_at', 'empacado_at', 'despachado_at', 'rechazado_at', 'resuelto_at'
]);

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

async function pullTable(db, client, table) {
  const cursor = await metaGet(db, cursorKey(table), EPOCH);
  const from = new Date(Math.max(0, Date.parse(cursor) - PULL_OVERLAP_MS)).toISOString();

  let since = from;
  let total = 0, skipped = 0;
  let maxSeen = cursor;
  const trays = new Set();

  // Page until a short read. Ordering by updated_at ascending makes paging
  // stable even while the server is being written to.
  for (let page = 0; page < 100; page++) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .gt('updated_at', since)
      .order('updated_at', { ascending: true })
      .limit(PULL_PAGE_SIZE);

    if (error) throw toError(error);
    if (!data?.length) break;

    const rows = data.map(normalizeRow);
    const res = await applyServerRows(db, table, rows);
    total += res.applied;
    skipped += res.skipped;
    for (const t of res.trays) trays.add(t);

    const last = rows[rows.length - 1].updated_at;
    if (last && last > maxSeen) maxSeen = last;

    if (data.length < PULL_PAGE_SIZE) break;
    if (last === since) break;   // guard against a stalled cursor
    since = last;
  }

  // Only ever advance to a timestamp the SERVER produced.
  if (maxSeen > cursor) await metaSet(db, cursorKey(table), maxSeen);

  return { table, applied: total, skipped, trays: [...trays] };
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
