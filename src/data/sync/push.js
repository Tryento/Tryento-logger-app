/**
 * push.js — drain the outbox to Supabase.
 *
 * The highest-risk file in the project. Its whole job is to move queued work to
 * the server without ever losing a row and without ever getting stuck.
 *
 * Invariants:
 *  - A terminal failure NEVER stops the drain. It is parked in the conflict
 *    inbox and the loop continues with the next item.
 *  - A retryable failure backs off; after MAX_ATTEMPTS it is quarantined rather
 *    than retried forever.
 *  - An item is pushed under the identity that ENQUEUED it. With per-operator
 *    logins, pushing user A's rows under user B's token would have RLS reject
 *    them and A's work would be gone.
 */
import { getClient, toError, canSync } from '../supabase.js';
import {
  claimBatch, markInflight, markDone, markRetry, markConflict,
  classifyError, rowsOf, STATUS
} from '../outbox.js';
import { recordConflict } from '../conflicts.js';
import { currentUserId, isTokenExpired } from '../session.js';
import { PUSH_BATCH_SIZE } from '../config.js';
import { uploadBlobsFor } from './blobs.js';

/**
 * Columns that must never be sent, for EVERY table.
 *
 *  - `estado`, which the SERVER owns: generated on jaula, kept by trigger on
 *    incubadora, caja and cochada from their registries (0010). The phone works
 *    it out from the same registries, so it never needs to send it.
 *
 *  - `updated_at` / `synced_at`, which the SERVER must own. This one matters:
 *    the pull cursor is a range over `updated_at`. A device offline for two
 *    days would otherwise insert rows stamped two days ago — already behind
 *    every other device's cursor — and nobody would ever pull them. Letting the
 *    server default them makes a late arrival land ahead of every cursor.
 *    `created_at` is kept: it is genuinely "when the operator entered this".
 *
 *  - Local index mirrors (`_resuelto`).
 */
const STRIP_ALWAYS = new Set([
  '_resuelto',
  'estado',
  'updated_at', 'synced_at'
]);

/**
 * Columns to strip only from SPECIFIC tables, because the same name is a real
 * column somewhere else.
 *
 * This exists because of a bug worth remembering: `insectario_id` and
 * `recolecta` were joined onto tray rows for display, but they were genuine
 * NOT NULL columns of another table. Stripping them globally made every
 * collection fail with a not-null violation — and since the failure was
 * terminal, everything behind it was blocked too. One over-eager entry in a
 * shared deny-list broke the entire sync chain below the first table.
 */
const STRIP_PER_TABLE = {
  // GENERATED ALWAYS: Postgres rejects an insert that supplies them.
  separacion: new Set(['coccion_kg', 'retorno_kg']),
  // Kept by the server from the cage's ingresos, cierres and limpiezas. Not
  // `generacion` everywhere: it is a real column of incubadora and ingreso.
  jaula: new Set(['fase', 'generacion', 'ciclo_desde'])
};

export function toWire(table, row) {
  // Tolerate the old single-argument shape so a stale caller fails loudly
  // rather than silently sending everything.
  if (row === undefined) throw new Error('toWire(table, row): falta el nombre de la tabla');

  const extra = STRIP_PER_TABLE[table];
  const out = {};
  for (const [k, v] of Object.entries(row || {})) {
    if (STRIP_ALWAYS.has(k)) continue;
    if (extra && extra.has(k)) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function execute(client, item) {
  if (item.op === 'upsert') {
    // onConflict:'id' + ignoreDuplicates makes a replayed item a no-op, while
    // a DIFFERENT unique index (one separación per caja, one chequeo per day,
    // an incubadora code) still raises 23505 — which is exactly what we want it
    // to do, because that means two devices recorded the same physical event.
    const { error } = await client
      .from(item.table)
      .upsert(toWire(item.table, item.payload), { onConflict: 'id', ignoreDuplicates: true });
    if (error) throw toError(error);
    return;
  }

  if (item.op === 'rpc' || item.op === 'cas') {
    // The calls read each field they need by name, so the payload goes as built.
    const { error } = await client.rpc(item.rpc, item.payload);
    if (error) throw toError(error);
    return;
  }

  throw Object.assign(new Error(`operación desconocida: ${item.op}`), { status: 400 });
}

/**
 * One drain pass.
 * @returns {{pushed:number, conflicts:number, retried:number, skipped:number}}
 */
export async function pushOnce(db, { limit = PUSH_BATCH_SIZE } = {}) {
  const result = { pushed: 0, conflicts: 0, retried: 0, skipped: 0, blocked: 0 };
  const client = getClient();
  if (!client || !canSync()) return result;

  const { ready, blocked } = await claimBatch(db, { limit });

  // A child whose parent will never land must be surfaced too, or it sits
  // pending forever behind a foreign key that cannot appear.
  for (const { item, parent } of blocked) {
    const err = Object.assign(
      new Error(`Depende de un registro que no se pudo guardar (${parent.table || parent.rpc}).`),
      { status: 424 });
    await markConflict(db, item, err, 'dependencia');
    await recordConflict(db, item, err, 'dependencia');
    result.blocked++;
  }

  const me = currentUserId();

  // Rows whose operation failed earlier in THIS batch. Anything queued behind
  // them is left pending rather than sent: it would fail with a foreign-key
  // violation, which the taxonomy correctly treats as terminal, and a
  // perfectly good row would be parked in the conflict inbox for a problem
  // that was never its own.
  const failedRows = new Set();

  for (const item of ready) {
    // Never push another operator's queued work under this token.
    if (item.created_by && me && item.created_by !== me) { result.skipped++; continue; }

    const waitingOnFailure =
      (item.depends_on || []).some(d => failedRows.has(d)) ||
      rowsOf(item).some(r => failedRows.has(r));
    if (waitingOnFailure) { result.skipped++; continue; }

    await markInflight(db, item.id);
    try {
      await execute(client, item);

      // Rows first, blobs second — always. A 300-byte row must never be stuck
      // behind a 4 MB photo on a rural link.
      if (item.blob_ids?.length) await uploadBlobsFor(db, item.blob_ids).catch(() => {});

      await markDone(db, item.id);
      result.pushed++;
    } catch (err) {
      const { retryable, reason } = classifyError(err, { sessionRefreshable: isTokenExpired() });
      if (retryable) {
        await markRetry(db, item, err, reason);
        result.retried++;
      } else {
        await markConflict(db, item, err, reason);
        await recordConflict(db, item, err, reason);
        result.conflicts++;
      }
      // Either way these rows did not land, so hold back anything behind them.
      for (const r of rowsOf(item)) failedRows.add(r);
      // Loop continues either way. This is the line that stops one poison item
      // from silently stalling every write behind it.
    }
  }

  return result;
}

/** Drain repeatedly until nothing more is ready, bounded so a pathological
 *  queue cannot spin the loop forever. */
export async function pushAll(db, { maxPasses = 20 } = {}) {
  const total = { pushed: 0, conflicts: 0, retried: 0, skipped: 0, blocked: 0 };
  for (let i = 0; i < maxPasses; i++) {
    const r = await pushOnce(db);
    for (const k of Object.keys(total)) total[k] += r[k];
    if (!r.pushed && !r.conflicts && !r.blocked) break;
  }
  return total;
}

export { STATUS };
