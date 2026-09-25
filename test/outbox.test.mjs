import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDb, pgError, httpError, networkError } from './helpers/env.mjs';
import { withTx } from '../src/data/idb/tx.js';
import {
  enqueue, claimBatch, markDone, markRetry, markConflict, markInflight,
  requeue, discard, outboxStats, listStuck, pruneDone,
  classifyError, backoffMs, STATUS
} from '../src/data/outbox.js';
import { MAX_ATTEMPTS } from '../src/data/config.js';

const add = (db, over = {}) =>
  withTx(db, ['outbox', 'meta'], 'readwrite', s =>
    enqueue(s, { op: 'upsert', table: 'alimentacion', rowId: over.rowId ?? null, payload: {}, ...over }));

test('enqueue assigns strictly increasing sequence numbers', async () => {
  const db = await freshDb();
  const a = await add(db), b = await add(db), c = await add(db);
  assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
});

test('claimBatch returns only items whose backoff has elapsed, oldest first', async () => {
  const db = await freshDb();
  const a = await add(db);
  const b = await add(db);
  await markRetry(db, b, networkError(), 'red');      // pushes b into the future

  const { ready } = await claimBatch(db, { now: Date.now() });
  assert.deepEqual(ready.map(i => i.id), [a.id], 'backed-off item must not be claimed yet');

  const later = await claimBatch(db, { now: Date.now() + 10 * 60 * 1000 });
  assert.equal(later.ready.length, 2, 'both are claimable once the backoff passes');
});

test('REGRESSION: one poison item must not stall everything behind it', async () => {
  const db = await freshDb();
  const poison = await add(db, { rowId: 'row-poison' });
  const good1 = await add(db, { rowId: 'row-1' });
  const good2 = await add(db, { rowId: 'row-2' });

  // Terminal failure -> parked, not retried.
  await markConflict(db, poison, pgError('23505', 'duplicate key'), 'restriccion');

  const { ready } = await claimBatch(db);
  assert.deepEqual(ready.map(i => i.id), [good1.id, good2.id],
    'the queue must keep draining past a conflicted item');

  const stats = await outboxStats(db);
  assert.equal(stats.pending, 2);
  assert.equal(stats.conflict, 1);
  assert.equal(stats.stuck, 1);
});

test('a parent and its child go out together, parent first', async () => {
  const db = await freshDb();
  await add(db, { rowId: 'recoleccion-1' });
  await add(db, { rowId: 'bandeja-1', dependsOn: ['recoleccion-1'] });

  const { ready } = await claimBatch(db);
  // Both are claimed: items execute sequentially in seq order, so the parent
  // has already landed by the time the child is sent. Holding the child back
  // for a whole extra pass would make a five-level chain take five syncs.
  assert.deepEqual(ready.map(i => i.row_id), ['recoleccion-1', 'bandeja-1']);
});

test('REGRESSION: nothing overtakes an earlier operation on the same row', async () => {
  const db = await freshDb();
  // The shape that lost data: an INSERT held back waiting for its parent, and a
  // compare-and-set on the SAME row queued behind it. Without per-row FIFO the
  // CAS went first, updated zero rows, and reported success — the value was
  // gone with nothing pending and nothing stuck.
  await add(db, { rowId: 'bandeja-9' });                              // parent, not yet done
  await add(db, { rowId: 'ayuno-1', dependsOn: ['bandeja-9-missing'] });  // insert, held
  await add(db, { rowId: 'ayuno-1', op: 'cas', rpc: 'cerrar_ayuno' });    // CAS on same row

  // Make the insert's dependency unsatisfiable within this pass.
  await add(db, { rowId: 'bandeja-9-missing' });

  const { ready } = await claimBatch(db);
  const rows = ready.map(i => i.row_id);
  const insertAt = ready.findIndex(i => i.row_id === 'ayuno-1' && i.op === 'upsert');
  const casAt = ready.findIndex(i => i.row_id === 'ayuno-1' && i.op === 'cas');
  if (casAt !== -1) {
    assert.ok(insertAt !== -1 && insertAt < casAt,
      `CAS must never be sent before the insert for the same row (got ${JSON.stringify(rows)})`);
  }
});

test('a child of a permanently stuck parent is surfaced, not retried forever', async () => {
  const db = await freshDb();
  const parent = await add(db, { rowId: 'recoleccion-2' });
  await add(db, { rowId: 'bandeja-2', dependsOn: ['recoleccion-2'] });

  await markConflict(db, parent, pgError('23505'), 'restriccion');

  const { ready, blocked } = await claimBatch(db);
  assert.equal(ready.length, 0);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].item.row_id, 'bandeja-2');
  assert.equal(blocked[0].parent.row_id, 'recoleccion-2');
});

test('retries escalate to quarantine rather than spinning forever', async () => {
  const db = await freshDb();
  let item = await add(db);
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    item = await markRetry(db, item, networkError(), 'red');
  }
  assert.equal(item.status, STATUS.QUARANTINED);
  assert.equal(item.attempts, MAX_ATTEMPTS);

  const stuck = await listStuck(db);
  assert.equal(stuck.length, 1);
});

test('requeue revives a stuck item; discard retires it', async () => {
  const db = await freshDb();
  const a = await add(db);
  await markConflict(db, a, pgError('23505'), 'restriccion');

  const revived = await requeue(db, a.id);
  assert.equal(revived.status, STATUS.PENDING);
  assert.equal(revived.attempts, 0);
  assert.equal(revived.last_error, null);

  const b = await add(db);
  const gone = await discard(db, b.id);
  assert.equal(gone.status, STATUS.DONE);
  assert.equal(gone.discarded, true);
});

test('error taxonomy: constraint violations are terminal, transport is retryable', async () => {
  // These can never succeed on retry — retrying is how you get an infinite loop.
  for (const code of ['23505', '23503', '23514', '23502', '42501']) {
    assert.equal(classifyError(pgError(code)).retryable, false, `pg ${code} must be terminal`);
  }
  // These are transient.
  assert.equal(classifyError(networkError()).retryable, true);
  for (const s of [408, 429, 500, 502, 503, 504]) {
    assert.equal(classifyError(httpError(s)).retryable, true, `http ${s} must be retryable`);
  }
  // Client errors are terminal.
  assert.equal(classifyError(httpError(400)).retryable, false);
  assert.equal(classifyError(httpError(422)).retryable, false);

  // 401 depends on whether the session can still be refreshed.
  assert.equal(classifyError(httpError(401), { sessionRefreshable: true }).retryable, true);
  assert.equal(classifyError(httpError(401), { sessionRefreshable: false }).retryable, false);
});

test('backoff grows, stays capped, and is jittered', async () => {
  assert.ok(backoffMs(0) >= 1000);
  assert.ok(backoffMs(3) > backoffMs(1), 'later attempts wait longer');
  for (let i = 0; i < 40; i++) {
    assert.ok(backoffMs(20) <= 5 * 60 * 1000 * 1.2, 'must stay within the cap plus jitter');
  }
  const samples = new Set(Array.from({ length: 20 }, () => backoffMs(5)));
  assert.ok(samples.size > 1, 'jitter must vary so devices do not stampede in lockstep');
});

test('created_by is stamped at enqueue so another user cannot push your rows', async () => {
  const db = await freshDb();
  const item = await add(db, { createdBy: 'user-a', dispositivoId: 'phone-1' });
  assert.equal(item.created_by, 'user-a');
  assert.equal(item.dispositivo_id, 'phone-1');
});

test('pruneDone clears completed history but never open or stuck work', async () => {
  const db = await freshDb();
  const done = await add(db);
  const pending = await add(db);
  const conflicted = await add(db);
  await markDone(db, done.id);
  await markConflict(db, conflicted, pgError('23505'), 'restriccion');

  // Nothing is old enough yet.
  assert.equal(await pruneDone(db), 0);

  const removed = await pruneDone(db, { olderThanMs: -1 });
  assert.equal(removed, 1, 'only the DONE row is removed');

  const stats = await outboxStats(db);
  assert.equal(stats.pending, 1);
  assert.equal(stats.conflict, 1);
  assert.ok(pending.id && conflicted.id);
});

test('markInflight is visible to stats (a crashed drain is not invisible)', async () => {
  const db = await freshDb();
  const a = await add(db);
  await markInflight(db, a.id);
  const stats = await outboxStats(db);
  assert.equal(stats.inflight, 1);
  assert.equal(stats.unsynced, 1);
});
