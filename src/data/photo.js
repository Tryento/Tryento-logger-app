/**
 * photo.js — capture, downscale, and queue an image for upload.
 *
 * What the prototype did: `onPhoto` (dc.html:1047) stored `file.name` and threw
 * the image away. The detail timeline then printed the literal word "foto".
 * No picture was ever kept, anywhere.
 *
 * What happens now: decode (honouring EXIF orientation), downscale, re-encode
 * as JPEG, and store the BLOB in IndexedDB so it survives offline, then upload
 * it after the rows have gone up.
 *
 * Sizing: 1600px long edge at q0.80 lands around 250-450 KB. At 20-30 photos a
 * day that is ~10 MB/day, so a five-day offline stretch is ~50 MB. Quota is not
 * the binding constraint — eviction and upload bandwidth on a rural link are.
 */
import { PHOTO_MAX_EDGE, PHOTO_QUALITY, STORAGE_BUCKET } from './config.js';
import { openDb } from './idb/open.js';
import { reqToPromise, withTx } from './idb/tx.js';
import { uuid } from './ids.js';
import { ok, fail, CODES } from './envelope.js';

export const BLOB_STATUS = { PENDING: 'pending', UPLOADING: 'uploading', DONE: 'done', FAILED: 'failed' };

/**
 * Decode with EXIF orientation applied.
 *
 * `imageOrientation: 'from-image'` is the whole reason this is not a plain
 * drawImage: without it every photo taken in portrait on an iPhone is stored
 * sideways, because the rotation lives in EXIF rather than in the pixels.
 */
async function decode(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // iOS "choose from library" can hand back HEIC, which canvas cannot
      // decode. Fall through and report it rather than storing a corrupt blob.
    }
  }
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('formato de imagen no soportado')); };
    img.src = url;
  });
}

function targetSize(w, h, maxEdge) {
  const long = Math.max(w, h);
  if (long <= maxEdge) return { w, h };
  const scale = maxEdge / long;
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

async function encodeJpeg(canvas, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * Turn a File from `<input type="file" capture="environment">` into a stored,
 * upload-ready blob.
 * @returns {{ok:true,data:{blob_id,bytes,width,height}}}
 */
export async function capturePhoto(file) {
  if (!file) return fail(CODES.VALIDATION, 'No se seleccionó ninguna foto.');

  let bitmap;
  try {
    bitmap = await decode(file);
  } catch (e) {
    return fail(CODES.VALIDATION,
      'No se pudo leer esa imagen. Toma la foto con la cámara en vez de elegirla de la galería.');
  }

  const srcW = bitmap.width || bitmap.naturalWidth;
  const srcH = bitmap.height || bitmap.naturalHeight;
  const { w, h } = targetSize(srcW, srcH, PHOTO_MAX_EDGE);

  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });

  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  if (bitmap.close) bitmap.close();

  const blob = await encodeJpeg(canvas, PHOTO_QUALITY);
  if (!blob) return fail(CODES.INTERNAL, 'No se pudo procesar la foto.');

  const id = uuid();
  const db = await openDb();
  await withTx(db, 'blobs', 'readwrite', s => reqToPromise(s.blobs.put({
    id,
    // Blob, never base64: base64 inflates by 33%, blocks the main thread on
    // large strings, and would be destroyed by any JSON round-trip.
    blob,
    bytes: blob.size,
    width: w,
    height: h,
    mime: 'image/jpeg',
    key: null,              // assigned when the owning row is created
    status: BLOB_STATUS.PENDING,
    attempts: 0,
    created_at: new Date().toISOString(),
    original_name: file.name || null
  })));

  return ok({ blob_id: id, bytes: blob.size, width: w, height: h });
}

/**
 * Bind a captured blob to the row that will own it and return the storage key.
 *
 * The key is DETERMINISTIC (`table/rowId/blobId.jpg`) so the upload can use
 * `upsert: true` and a retry after a lost acknowledgement overwrites the same
 * object instead of orphaning a second copy.
 */
export async function attachPhoto(db, blobId, table, rowId) {
  if (!blobId) return null;
  const key = `${table}/${rowId}/${blobId}.jpg`;
  await withTx(db, 'blobs', 'readwrite', async s => {
    const row = await reqToPromise(s.blobs.get(blobId));
    if (row) await reqToPromise(s.blobs.put({ ...row, key, table, row_id: rowId }));
  });
  return key;
}

/** Local object URL so the operator sees their photo before it ever uploads. */
export async function localPhotoUrl(blobId) {
  const db = await openDb();
  const row = await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.get(blobId)));
  if (!row?.blob) return null;
  return URL.createObjectURL(row.blob);
}

export async function pendingPhotoBytes(db) {
  const rows = await withTx(db, 'blobs', 'readonly', s => reqToPromise(s.blobs.getAll()));
  return rows
    .filter(r => r.status !== BLOB_STATUS.DONE)
    .reduce((sum, r) => sum + (r.bytes || 0), 0);
}

export const publicUrlFor = key =>
  key ? `${STORAGE_BUCKET}/${key}` : null;
