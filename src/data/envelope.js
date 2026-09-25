/**
 * envelope.js — the result contract every public data function returns.
 *
 *   success -> { ok: true,  data }
 *   failure -> { ok: false, error: { code, message } }
 *
 * This shape is load-bearing: the UI destructures it at ~40 call sites and must
 * not change during the backend swap.
 */

export const ok = data => ({ ok: true, data });
export const fail = (code, message, extra) =>
  ({ ok: false, error: { code, message, ...(extra ? { extra } : {}) } });

/** Error codes the UI is allowed to branch on. */
export const CODES = {
  VALIDATION: 'validation_error',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  OFFLINE: 'offline',
  AUTH: 'auth_required',
  INTERNAL: 'internal_error'
};

/**
 * Deep copy that preserves Blob, File, Date, Map and ArrayBuffer.
 *
 * The prototype used `JSON.parse(JSON.stringify(v))` (dataClient.js:19). That
 * silently turns a Blob into `{}` and a Date into a string — it would eat every
 * photo the moment real capture was wired up. structuredClone is the only
 * correct choice here.
 */
export function deepCopy(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof structuredClone === 'function') return structuredClone(v);
  // Node <17 / very old browsers. Still Blob-safe: blobs pass by reference
  // rather than being destroyed.
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof Blob !== 'undefined' && v instanceof Blob) return v;
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepCopy(v[k]);
  return out;
}

/** Coerce a form value to a number, treating blank as "absent" rather than 0.
 *  Returns null for anything non-numeric so a typo never becomes a silent 0. */
export function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Trim to a string, never null — matches the NOT NULL DEFAULT '' text columns. */
export const str = v => (v === null || v === undefined ? '' : String(v).trim());
