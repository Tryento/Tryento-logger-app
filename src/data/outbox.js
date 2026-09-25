/**
 * outbox.js — the durable write queue.
 *
 * Every write the operator makes lands here in the same transaction as the
 * local row, and is drained to Supabase later. This is the component that
 * makes "works in a shed with no signal" true, and it is the one most likely
 * to lose data if it is written casually.
 *
 * Three rules it exists to enforce:
 *
 *  1. ONE POISON ITEM MUST NEVER STALL THE QUEUE. The classic hand-rolled-sync
 *     bug is a FIFO drain that hits a permanently-rejected row and stops, so
 *     everything behind it silently never syncs while the pending counter
 *     climbs. Terminal failures are moved aside and the drain continues.
 *
 *  2. RETRYABLE AND TERMINAL FAILURES ARE NOT THE SAME. Treating them alike
 *     gives you either infinite retries against a 23505 that will never
 *     succeed, or a dropped row on a momentary network blip.
 *
 *  3. A WRITE IS NEVER SILENTLY LOST. Anything that cannot be applied ends up
 *     in the conflict inbox where a human sees it. Telling the operator
 *     "Guardado" and then discarding the row is worse than the AppSheet bug
 *     this replaces.
 */
import { MAX_ATTEMPTS } from './config.js';
import { reqToPromise, withTx, getAllByIndex, scanIndex } from './idb/tx.js';
import { uuid } from './ids.js';

export const STATUS = {
  PENDING: 'pending',
  INFLIGHT: 'inflight',
  DONE: 'done',
  CONFLICT: 'conflict',
  QUARANTINED: 'quarantined'
};

/** Statuses that mean "still owes the server something". */
export const OPEN_STATUSES = [STATUS.PENDING, STATUS.INFLIGHT];
/** Statuses that mean "will never land without human action". */
export const STUCK_STATUSES = [STATUS.CONFLICT, STATUS.QUARANTINED];

const SEQ_KEY = 'outbox_seq';

/**
 * Allocate the next sequence number INSIDE the caller's transaction, so the
 * counter and the item commit together.
 */
async function nextSeq(stores) {
  const row = await reqToPromise(stores.meta.get(SEQ_KEY));
  const next = (row?.value ?? 0) + 1;
  await reqToPromise(stores.meta.put({ key: SEQ_KEY, value: next }));
  return next;
}

/**
 * Enqueue one operation. MUST be called inside the same transaction as the
 * local row write — see the note in tx.js on why the two cannot be split.
 *
 * @param stores  the object-store map from withTx (needs `outbox` and `meta`)
 */
export async function enqueue(stores, {
  op, table = null, rpc = null, rowId = null, payload,
  dependsOn = [], blobIds = [], createdBy = null, dispositivoId = null, createdAt
}) {
  if (!['upsert', 'rpc', 'cas'].includes(op)) throw new Error(`outbox: op inválido "${op}"`);

  const item = {
    id: uuid(),
    seq: await nextSeq(stores),
    op,
    table,
    rpc,
    row_id: rowId,
    payload,
    depends_on: dependsOn.filter(Boolean),
    blob_ids: blobIds.filter(Boolean),
    created_at: createdAt || new Date().toISOString(),
    // Stamped at ENQUEUE, not at drain. With per-operator logins, user B must
    // never push A's queued rows under B's token: RLS would reject them and A's
    // work would be lost with no way back.
    created_by: createdBy,
    dispositivo_id: dispositivoId,
    attempts: 0,
    next_attempt_at: 0,
    status: STATUS.PENDING,
    last_error: null
  };

  await reqToPromise(stores.outbox.put(item));
  return item;
}

/* ── error taxonomy ─────────────────────────────────────────────────────── */

/** Postgres SQLSTATEs that will never succeed on retry. */
const TERMINAL_PG = new Set([
  '23505', // unique_violation      — e.g. two devices separated the same tray
  '23503', // foreign_key_violation — parent row does not exist server-side
  '23514', // check_violation       — violates a lifecycle CHECK
  '23502', // not_null_violation
  '22P02', // invalid_text_representation
  '42501'  // insufficient_privilege / RLS denial
]);

const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Decide whether a failure is worth retrying.
 * `sessionRefreshable` lets a 401 be retried once the token has been renewed,
 * while a 401 with no way to refresh is terminal for this item.
 */
export function classifyError(err, { sessionRefreshable = false } = {}) {
  if (!err) return { retryable: true, reason: 'desconocido' };

  // No network at all — always worth retrying.
  if (err.name === 'TypeError' || err.isNetworkError || err.message === 'Failed to fetch') {
    return { retryable: true, reason: 'red' };
  }
  if (err.name === 'AbortError') return { retryable: true, reason: 'cancelado' };

  const pg = err.code || err.pgCode;
  if (pg && TERMINAL_PG.has(String(pg))) {
    return { retryable: false, reason: 'restriccion', pgCode: String(pg) };
  }

  const status = err.status || err.httpStatus;
  if (status === 401 || status === 403) {
    return { retryable: Boolean(sessionRefreshable), reason: 'autenticacion' };
  }
  if (status && RETRYABLE_HTTP.has(status)) return { retryable: true, reason: 'servidor' };
  if (status && status >= 400 && status < 500) return { retryable: false, reason: 'rechazado' };
  if (status && status >= 500) return { retryable: true, reason: 'servidor' };

  // Unknown shape: retry, but attempts are capped so it cannot spin forever.
  return { retryable: true, reason: 'desconocido' };
}

/** Exponential backoff, capped, with jitter so many devices reconnecting after
 *  the same outage do not stampede the server in lockstep. */
export function backoffMs(attempts) {
  const base = Math.min(2 ** attempts * 1000, 5 * 60 * 1000);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.round(base + jitter));
}

/* ── draining ───────────────────────────────────────────────────────────── */

/**
 * Items ready to attempt now, oldest first.
 *
 * Dependency handling: an item whose parent has not landed yet is SKIPPED, not
 * blocked on — the rest of the queue keeps moving. An item whose parent is
 * permanently stuck is surfaced rather than left to retry against a foreign key
 * that will never exist.
 */
export async function claimBatch(db, { limit = 50, now = Date.now() } = {}) {
  // Query the plain status index and order in JS. A compound [status, seq]
  // range would need +/-Infinity bounds, whose validity as IndexedDB keys is
  // not worth relying on across engines for a queue this small.
  const all = await getAllByIndex(db, 'outbox', 'by_status');
  const pending = all
    .filter(it => it.status === STATUS.PENDING && (it.next_attempt_at || 0) <= now)
    .sort((a, b) => a.seq - b.seq);

  // Rows that still owe the server something, and rows that will never land.
  const owing = new Set();
  const stuckByRow = new Map();
  for (const it of all) {
    if (!it.row_id) continue;
    if (OPEN_STATUSES.includes(it.status)) owing.add(it.row_id);
    if (STUCK_STATUSES.includes(it.status)) stuckByRow.set(it.row_id, it);
  }

  const ready = [];
  const blocked = [];
  // Rows whose earlier operation is going out in THIS batch. Items are executed
  // in seq order, so a later item may rely on one already queued ahead of it.
  const satisfied = new Set();
  // Rows whose earlier operation was held back. Nothing for that row may
  // overtake it.
  const held = new Set();

  for (const item of pending) {
    let skip = false;

    // ── per-row FIFO ────────────────────────────────────────────────────────
    // An operation must never overtake an earlier one on the SAME row.
    //
    // This is what made `cerrar_ayuno` and `actualizar_qc_lote` fail
    // silently: they carry no dependency of their own, so when the INSERT of
    // the row they update was held back waiting for its parent, the CAS ran
    // first, updated zero rows, reported success, and the weight was lost with
    // nothing queued, nothing stuck and nothing to see.
    if (item.row_id && held.has(item.row_id)) skip = true;

    // ── declared dependencies ───────────────────────────────────────────────
    if (!skip) {
      for (const dep of item.depends_on || []) {
        if (satisfied.has(dep)) continue;              // goes out earlier in this batch
        if (stuckByRow.has(dep)) {                     // will never land
          blocked.push({ item, parent: stuckByRow.get(dep) });
          skip = true;
          break;
        }
        if (owing.has(dep)) { skip = true; break; }    // still queued: try next pass
      }
    }

    if (skip) {
      if (item.row_id) held.add(item.row_id);
      continue;
    }

    ready.push(item);
    if (item.row_id) satisfied.add(item.row_id);
    if (ready.length >= limit) break;
  }

  return { ready, blocked };
}

async function patch(db, id, changes) {
  return withTx(db, 'outbox', 'readwrite', async s => {
    const cur = await reqToPromise(s.outbox.get(id));
    if (!cur) return null;
    const next = { ...cur, ...changes };
    await reqToPromise(s.outbox.put(next));
    return next;
  });
}

export const markInflight = (db, id) => patch(db, id, { status: STATUS.INFLIGHT });

export const markDone = (db, id) =>
  patch(db, id, { status: STATUS.DONE, last_error: null, completed_at: new Date().toISOString() });

/** Schedule another attempt, or give up and quarantine once capped. */
export async function markRetry(db, item, err, reason) {
  const attempts = (item.attempts || 0) + 1;
  const last_error = {
    reason,
    message: err?.message || String(err || ''),
    code: err?.code || null,
    status: err?.status || null,
    at: new Date().toISOString()
  };
  if (attempts >= MAX_ATTEMPTS) {
    return patch(db, item.id, { attempts, status: STATUS.QUARANTINED, last_error });
  }
  return patch(db, item.id, {
    attempts,
    status: STATUS.PENDING,
    next_attempt_at: Date.now() + backoffMs(attempts),
    last_error
  });
}

/** Terminal rejection: parked for a human, queue keeps draining. */
export async function markConflict(db, item, err, reason) {
  return patch(db, item.id, {
    status: STATUS.CONFLICT,
    attempts: (item.attempts || 0) + 1,
    last_error: {
      reason,
      message: err?.message || String(err || ''),
      code: err?.code || null,
      status: err?.status || null,
      at: new Date().toISOString()
    }
  });
}

/** Put a conflicted/quarantined item back in line, e.g. after the operator
 *  resolves the underlying problem. */
export const requeue = (db, id) =>
  patch(db, id, { status: STATUS.PENDING, attempts: 0, next_attempt_at: 0, last_error: null });

export const discard = (db, id) =>
  patch(db, id, { status: STATUS.DONE, discarded: true, completed_at: new Date().toISOString() });

/* ── status for the UI ──────────────────────────────────────────────────── */

export async function outboxStats(db) {
  const all = await getAllByIndex(db, 'outbox', 'by_status');
  const stats = { pending: 0, inflight: 0, conflict: 0, quarantined: 0, done: 0, oldestPendingAt: null };
  for (const it of all) {
    if (it.status in stats) stats[it.status]++;
    if (it.status === STATUS.PENDING || it.status === STATUS.INFLIGHT) {
      const t = Date.parse(it.created_at);
      if (Number.isFinite(t) && (stats.oldestPendingAt === null || t < stats.oldestPendingAt)) {
        stats.oldestPendingAt = t;
      }
    }
  }
  stats.unsynced = stats.pending + stats.inflight;
  stats.stuck = stats.conflict + stats.quarantined;
  return stats;
}

/** Items still owed to the server, for "you have unsynced work" warnings. */
export const listOpen = async db =>
  (await getAllByIndex(db, 'outbox', 'by_status'))
    .filter(it => OPEN_STATUSES.includes(it.status))
    .sort((a, b) => a.seq - b.seq);

export const listStuck = async db =>
  (await getAllByIndex(db, 'outbox', 'by_status'))
    .filter(it => STUCK_STATUSES.includes(it.status))
    .sort((a, b) => a.seq - b.seq);

/** Housekeeping: drop completed items so the store does not grow without
 *  bound. Only touches DONE rows, never anything still owed or stuck. */
export async function pruneDone(db, { olderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - olderThanMs;
  const all = await getAllByIndex(db, 'outbox', 'by_status');
  const kill = all.filter(it =>
    it.status === STATUS.DONE && Date.parse(it.completed_at || it.created_at) < cutoff);
  if (!kill.length) return 0;
  await withTx(db, 'outbox', 'readwrite', async s => {
    for (const it of kill) await reqToPromise(s.outbox.delete(it.id));
  });
  return kill.length;
}
