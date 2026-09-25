/**
 * blobs.js — the photo upload lane.
 *
 * Deliberately the lowest-priority thing sync does. Rows go first, always: a
 * 300-byte separación must never sit behind a 400 KB image on a link that may
 * only be good for a few seconds at a time. A row whose photo has not uploaded
 * yet is still complete and correct data; a photo with no row is useless.
 */
import { storageBucket, canSync } from '../supabase.js';
import { reqToPromise, withTx } from '../idb/tx.js';
import { BLOB_STATUS } from '../photo.js';

/** Only spend the operator's mobile data when the link can take it, unless
 *  they explicitly asked for it. */
export function connectionAllowsUpload({ force = false } = {}) {
  if (force) return true;
  const c = typeof navigator !== 'undefined' ? navigator.connection : null;
  if (!c) return true;                       // unknown: assume fine
  if (c.saveData) return false;              // operator asked to save data
  return !['slow-2g', '2g'].includes(c.effectiveType);
}

async function uploadOne(db, row, bucket) {
  if (!row?.blob || !row.key) return false;

  await withTx(db, 'blobs', 'readwrite', s =>
    reqToPromise(s.blobs.put({ ...row, status: BLOB_STATUS.UPLOADING })));

  // upsert:true + the deterministic key makes a replay after a lost ack
  // overwrite the same object rather than orphaning a duplicate.
  const { error } = await bucket.upload(row.key, row.blob, {
    contentType: row.mime || 'image/jpeg',
    upsert: true
  });

  const next = error
    ? { ...row, status: BLOB_STATUS.PENDING, attempts: (row.attempts || 0) + 1, last_error: error.message }
    : { ...row, status: BLOB_STATUS.DONE, uploaded_at: new Date().toISOString(), blob: undefined };

  // On success the local copy is dropped: it is durably in object storage and
  // keeping it would grow the device's footprint without bound.
  await withTx(db, 'blobs', 'readwrite', s => reqToPromise(s.blobs.put(next)));
  return !error;
}

/** Upload specific blobs — called right after their row lands. */
export async function uploadBlobsFor(db, blobIds) {
  const bucket = storageBucket();
  if (!bucket || !canSync() || !blobIds?.length) return 0;

  let done = 0;
  for (const id of blobIds) {
    const row = await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.get(id)));
    if (!row || row.status === BLOB_STATUS.DONE) continue;
    if (await uploadOne(db, row, bucket)) done++;
  }
  return done;
}

/** Sweep any stragglers — photos whose row synced but whose upload failed. */
export async function uploadPending(db, { force = false, limit = 10 } = {}) {
  const bucket = storageBucket();
  if (!bucket || !canSync()) return { uploaded: 0, skipped: 0 };
  if (!connectionAllowsUpload({ force })) return { uploaded: 0, skipped: -1 };

  const all = await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.getAll()));
  const pending = all
    .filter(r => r.status !== BLOB_STATUS.DONE && r.key && r.blob)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(0, limit);

  let uploaded = 0;
  for (const row of pending) if (await uploadOne(db, row, bucket)) uploaded++;
  return { uploaded, skipped: pending.length - uploaded };
}

export async function blobStats(db) {
  const all = await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.getAll()));
  const pending = all.filter(r => r.status !== BLOB_STATUS.DONE);
  return {
    total: all.length,
    pending: pending.length,
    pendingBytes: pending.reduce((s, r) => s + (r.bytes || 0), 0),
    // A photo attached to a row that never got a key would upload nowhere.
    orphaned: all.filter(r => !r.key && r.status !== BLOB_STATUS.DONE).length
  };
}
