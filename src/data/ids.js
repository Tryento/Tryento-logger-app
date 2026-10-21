/**
 * ids.js — identifier generation.
 *
 * Two kinds of identity, and conflating them is what breaks offline capture:
 *
 *  - MACHINE identity (`id`): a client-generated UUIDv4. Generated on the
 *    device so a write needs no server round-trip, and used as the idempotency
 *    key for `ON CONFLICT (id) DO NOTHING`. Two devices can never collide.
 *
 *  - HUMAN identity (`codigo`): what someone writes on a container with a
 *    marker and reads aloud across the shed. These are derived from counters
 *    and dates, so two offline devices CAN produce the same one.
 *    UUIDv4 does nothing for this. The database enforces uniqueness and the
 *    rare collision surfaces in the conflict inbox rather than silently
 *    duplicating — which is the behaviour the farm actually wants, because a
 *    duplicate label means two physical trays are wearing the same number.
 */
import { ddmm } from './time.js';

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

/* ── the lab's codes (October 2026) ──────────────────────────────────────────
 * What gets written on the container. A code is given once and NEVER changes:
 * correcting the cage, the generation or a date of what it came from corrects
 * the data, not the label. So the next number always continues from the codes
 * already given, whatever happened to them since.
 */

/** Highest `n` among codes shaped `${prefix}${n}`. */
function maxNumero(codigos, prefix) {
  let max = 0;
  for (const c of codigos || []) {
    const s = String(c || '');
    if (!s.startsWith(prefix)) continue;
    const n = Number(s.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/** `F8A-12` — generation, the cage's letter, and its recolecta number in that
 *  generation (it starts again at 1 with each generation). */
export const incubadoraPrefijo = (generacion, letra) =>
  `F${Number(generacion)}${String(letra || '').trim().toUpperCase()}-`;

export function siguienteIncubadora(generacion, letra, codigos) {
  const prefijo = incubadoraPrefijo(generacion, letra);
  const numero = maxNumero(codigos, prefijo) + 1;
  return { codigo: `${prefijo}${numero}`, numero };
}

/** `F8A-12-03` — the third caja de engorde out of incubadora F8A-12. */
export const cajaCodigo = (incubadoraCodigo, n) => `${incubadoraCodigo}-${String(n).padStart(2, '0')}`;

/** `H-2810-1` — the first cochada into the oven on 28 Oct (farm day). Counted
 *  among that day's cochadas only, so next year's 28 Oct starts at 1 again. */
export function siguienteCochada(fecha, codigosDelDia) {
  const prefijo = `H-${ddmm(fecha)}-`;
  return `${prefijo}${maxNumero(codigosDelDia, prefijo) + 1}`;
}

/** `S2-2810` — container S2, ensiled on 28 Oct (farm day). */
export const ensiladoCodigo = (contenedorCodigo, fecha) =>
  `${String(contenedorCodigo || '').trim().toUpperCase()}-${ddmm(fecha)}`;

/** `F7-B2810-1` — a bandeja de pupación of generation-7 larvae made on 28 Oct.
 *  `desde` is the first number to use: trays of one ingreso are numbered on. */
export function bandejaPupacionPrefijo(generacion, fecha) {
  return `F${Number(generacion)}-B${ddmm(fecha)}-`;
}

export function siguientesBandejas(generacion, fecha, n, codigos) {
  const prefijo = bandejaPupacionPrefijo(generacion, fecha);
  const desde = maxNumero(codigos, prefijo) + 1;
  return Array.from({ length: n }, (_, i) => ({ codigo: `${prefijo}${desde + i}`, numero: desde + i }));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = v => typeof v === 'string' && UUID_RE.test(v);
