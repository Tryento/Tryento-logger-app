/**
 * time.js — all date/time handling, resolved against the FARM's timezone.
 *
 * ── The bug this replaces ───────────────────────────────────────────────────
 * The prototype mixed two different clocks:
 *
 *   dataClient.js:22   today()  -> new Date().toISOString().slice(0,10)   // UTC
 *   dataClient.js:27   ddmm()   -> new Date(str + 'T00:00')              // device-local
 *
 * At UTC-4 those disagree after 20:00 local: `today()` already returns
 * tomorrow. `marcarAtractante`/`marcarCierre` stamped tomorrow's date, the
 * 180-day `fecha_vencimiento` was a day out, and tray labels (DDMM) were wrong.
 * Nine months of live data already carry this.
 *
 * ── The rule here ───────────────────────────────────────────────────────────
 * Every calendar decision resolves against FARM_TZ, never the device's zone. A
 * phone left on the wrong timezone — or travelling — still writes the correct
 * farm-local day. Every instant is serialised WITH an explicit offset, so
 * Postgres `timestamptz` can never silently reinterpret a naive string as UTC.
 */
import { FARM_TZ, CLOCK_SKEW_WARN_MS } from './config.js';

const pad = n => String(n).padStart(2, '0');

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;
const HAS_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Offset of `tz` at a given instant, in minutes, using the SIGN CONVENTION OF
 * ISO-8601 — UTC-4 is -240.
 *
 * Note this is the opposite sign to Date.prototype.getTimezoneOffset(), which
 * returns +240 for UTC-4. Mixing the two is a classic source of 8-hour errors.
 */
export function tzOffsetMinutes(date, tz = FARM_TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  const asUtc = Date.UTC(
    +parts.year, +parts.month - 1, +parts.day,
    +parts.hour, +parts.minute, +parts.second
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Shift an instant so the UTC getters read farm-local wall-clock values. */
function localParts(date, tz = FARM_TZ) {
  return new Date(date.getTime() + tzOffsetMinutes(date, tz) * 60000);
}

/**
 * Interpret a naive `YYYY-MM-DDTHH:mm` (what `<input type="datetime-local">`
 * produces) as farm-local wall-clock time and return the true instant.
 *
 * Two passes: the first guesses the offset from the naive value read as UTC,
 * the second re-checks at the resolved instant. Venezuela has no DST so one
 * pass would do today, but a single-pass version is wrong on any DST boundary
 * and this must not quietly break if the farm ever runs a second site.
 */
export function naiveToDate(naive, tz = FARM_TZ) {
  const m = NAIVE_RE.exec(String(naive).trim());
  if (!m) return null;
  const [, Y, Mo, D, H = '00', Mi = '00', S = '00'] = m;
  const guess = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const off1 = tzOffsetMinutes(new Date(guess), tz);
  let instant = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(instant), tz);
  if (off2 !== off1) instant = guess - off2 * 60000;
  return new Date(instant);
}

/** Accept a Date, epoch ms, an ISO string with a zone, or a naive local string. */
export function asDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return new Date(v);
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (NAIVE_RE.test(s) && !HAS_ZONE_RE.test(s)) return naiveToDate(s);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Serialise an instant as ISO-8601 with the farm's explicit offset, e.g.
 * `2026-09-22T08:30:00-04:00`. Always send this to Postgres — a naive string
 * would be read as UTC and land four hours off.
 */
export function toIso(v = new Date(), tz = FARM_TZ) {
  const d = asDate(v);
  if (!d) return null;
  const off = tzOffsetMinutes(d, tz);
  const abs = Math.abs(off);
  const sign = off < 0 ? '-' : '+';
  const l = localParts(d, tz);
  return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}` +
         `T${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}:${pad(l.getUTCSeconds())}` +
         `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The canonical STORED form of an instant: UTC with a `Z`.
 *
 * Everything persisted uses this one format, deliberately. Lists sort events
 * with a plain string compare, and that is only chronological if every value
 * shares a format — mixing `...Z` with `...-04:00` would silently misorder the
 * timeline. Postgres reads either unambiguously; the display layer converts to
 * farm-local on the way out.
 */
export function utcIso(v = new Date()) {
  const d = asDate(v);
  return d ? d.toISOString() : null;
}

export const nowIso = () => new Date().toISOString();

/** Farm-local calendar day, `YYYY-MM-DD`. Replaces the UTC-based `today()`. */
export function farmDay(v = new Date(), tz = FARM_TZ) {
  const d = asDate(v);
  if (!d) return null;
  const l = localParts(d, tz);
  return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}`;
}

/** `DDMM` for tray labels — farm-local, matching the marker on the tray. */
export function ddmm(v = new Date(), tz = FARM_TZ) {
  const d = asDate(v);
  if (!d) return null;
  const l = localParts(d, tz);
  return `${pad(l.getUTCDate())}${pad(l.getUTCMonth() + 1)}`;
}

/** Value for `<input type="datetime-local">`, in farm-local wall-clock time. */
export function toNaiveLocal(v = new Date(), tz = FARM_TZ) {
  const d = asDate(v);
  if (!d) return null;
  const l = localParts(d, tz);
  return `${l.getUTCFullYear()}-${pad(l.getUTCMonth() + 1)}-${pad(l.getUTCDate())}` +
         `T${pad(l.getUTCHours())}:${pad(l.getUTCMinutes())}`;
}

/** Calendar arithmetic on a `YYYY-MM-DD` day string — no timezone involved. */
export function addDays(day, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function daysBetween(a, b) {
  const da = asDate(a), db = asDate(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86_400_000);
}

/* ── clock skew ─────────────────────────────────────────────────────────────
 * Every `fecha` originates on a device clock. A tablet with a dead RTC writes
 * timestamps that sort to the bottom forever and silently corrupt every
 * cycle-time metric, with nothing on screen to suggest anything is wrong. The
 * server's `Date` response header is the one trustworthy reference we get for
 * free on every sync.
 */
let _skewMs = 0;
let _skewSeenAt = null;

export function recordServerDate(headerValue) {
  if (!headerValue) return;
  const server = new Date(headerValue);
  if (Number.isNaN(server.getTime())) return;
  _skewMs = Date.now() - server.getTime();
  _skewSeenAt = Date.now();
}

export const getClockSkewMs = () => _skewMs;
export const isClockSkewed = () => Math.abs(_skewMs) > CLOCK_SKEW_WARN_MS;
export const clockSkewCheckedAt = () => _skewSeenAt;

/** Test seam. */
export function __resetClockSkew() { _skewMs = 0; _skewSeenAt = null; }
