/**
 * ids.js — identifier generation.
 *
 * Two kinds of identity, and conflating them is what breaks offline capture:
 *
 *  - MACHINE identity (`id`): a client-generated UUIDv4. Generated on the
 *    device so a write needs no server round-trip, and used as the idempotency
 *    key for `ON CONFLICT (id) DO NOTHING`. Two devices can never collide.
 *
 *  - HUMAN identity (`id_bandeja`, `codigo`, `recolecta`): what someone writes
 *    on a tray with a marker and reads aloud across the shed. These are derived
 *    from counters and dates, so two offline devices CAN produce the same one.
 *    UUIDv4 does nothing for this. The database enforces uniqueness and the
 *    rare collision surfaces in the conflict inbox rather than silently
 *    duplicating — which is the behaviour the farm actually wants, because a
 *    duplicate label means two physical trays are wearing the same number.
 */
import { ddmm, farmDay } from './time.js';

const HEX = '0123456789abcdef';

/** RFC-4122 v4. Uses crypto.randomUUID where available, falls back to
 *  getRandomValues, and only then to Math.random (older WebViews). */
export function uuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;   // version 4
  b[8] = (b[8] & 0x3f) | 0x80;   // variant 10
  const h = [...b].map(x => HEX[x >> 4] + HEX[x & 15]).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Short, unambiguous suffix for human codes. Excludes I/O/0/1 so a code read
 *  aloud or copied off a tray cannot be misheard. */
export function shortCode(n = 4) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const c = globalThis.crypto;
  const b = new Uint8Array(n);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map(x => A[x % A.length]).join('');
}

/**
 * A UUID derived deterministically from a string.
 *
 * Used so two phones typing the same new name produce the SAME row id. Without
 * it both would insert a different id carrying the same value, the
 * unique(tipo, valor) constraint would reject the second with a 23505, and
 * adding a name would land in the conflict inbox — absurd friction for typing
 * "Jose". With it, the second insert is an idempotent no-op.
 *
 * Not cryptographic, and does not need to be: the input is a handful of names.
 */
export function uuidFromString(seed) {
  const s = String(seed);
  // cyrb128 — four independent 32-bit hashes, enough to fill a UUID.
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  const bytes = [];
  for (const h of [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0]) {
    bytes.push((h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;   // name-derived, v5-shaped
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // variant 10
  const hex = bytes.map(b => HEX[b >> 4] + HEX[b & 15]).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const DEVICE_KEY = 'tryento.dispositivo';

/**
 * Stable per-device id, stamped on every row. You will want this the first time
 * you debug a sync anomaly and need to know which phone wrote what.
 */
export function deviceId() {
  try {
    let v = localStorage.getItem(DEVICE_KEY);
    if (!v) { v = uuid(); localStorage.setItem(DEVICE_KEY, v); }
    return v;
  } catch {
    // Private mode / storage blocked. A per-session id still beats null.
    if (!deviceId._fallback) deviceId._fallback = uuid();
    return deviceId._fallback;
  }
}

/** `ICA-0326` — colony name plus the farm-local DDMM it started. */
export function insectarioCodigo(nombre, fechaInicio) {
  return `${String(nombre || '').trim()}-${ddmm(fechaInicio || farmDay())}`;
}

/**
 * `2609.104.3` — DDMM of the tray date, the colony's recolecta ordinal, and the
 * tray number within that batch. Matches what is written on the physical tray.
 *
 * `noBandeja` is TYPED by the operator, never auto-computed: the farm labels the
 * tray with a marker first and then enters it, so the human assigns the number
 * and the app must not invent a different one.
 */
export function bandejaLabel(fecha, recolecta, noBandeja) {
  return `${ddmm(fecha)}.${recolecta}.${noBandeja}`;
}

/**
 * `CO-260922-K7QM` — oven run. Date plus a random suffix rather than a counter,
 * because a global counter cannot be assigned offline without collisions and a
 * cochada is a physical event that must never be merged with another.
 */
export function cochadaCodigo(fecha) {
  const d = farmDay(fecha) || farmDay();
  return `CO-${d.slice(2).replace(/-/g, '')}-${shortCode(4)}`;
}

/**
 * Next per-colony recolecta ordinal. Scoped to the colony, not global: the
 * prototype's `'REC-' + (length + 101)` (dataClient.js:221) was a single global
 * counter that two offline devices would both advance to the same value.
 *
 * Scoping makes a collision near-impossible in practice (one person harvests
 * one cage) while keeping the constraint that surfaces the rare real one.
 */
export function nextRecolectaOrdinal(existingForColony) {
  let max = 0;
  for (const r of existingForColony || []) {
    const n = parseInt(String(r.recolecta ?? '').replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
