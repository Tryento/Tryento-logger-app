/**
 * config.js — runtime configuration.
 *
 * Values come from `window.__TRYENTO_CONFIG__`, set by `app-config.js`, which is
 * a plain script tag rather than a bundled constant so the same build can be
 * deployed to staging and production by swapping one file.
 *
 * If Supabase is not configured the app still runs, fully, against IndexedDB
 * alone — it just never syncs. That is a deliberate degradation: a
 * misconfiguration must not cost an operator their day's capture.
 */

const cfg = (typeof window !== 'undefined' && window.__TRYENTO_CONFIG__) || {};

export const SUPABASE_URL = cfg.supabaseUrl || '';
export const SUPABASE_ANON_KEY = cfg.supabaseAnonKey || '';

/** The farm's timezone. Every calendar-day decision resolves against THIS, not
 *  the device clock's zone, so a phone left on the wrong timezone still writes
 *  the correct farm-local day. */
export const FARM_TZ = cfg.farmTz || 'America/Caracas';

/** Postgres schema exposed through PostgREST. Must match the "Exposed schemas"
 *  setting in the Supabase dashboard or every request 404s. */
export const DB_SCHEMA = cfg.dbSchema || 'app';

/**
 * How a device gets a session.
 *
 *   'anonymous' — Supabase anonymous sign-in. No login screen at all, but every
 *                 device still gets a REAL auth.uid(), so the row-level
 *                 security policies work exactly as written and every row is
 *                 attributable to a device session. This is what makes a
 *                 no-login demo safe to put on the internet rather than
 *                 requiring wide-open `anon` policies.
 *   'google'    — real per-operator accounts. Switching to this later needs no
 *                 schema change; see DEPLOY.md.
 *   'none'      — never authenticate. Local-only; sync stays off.
 */
export const AUTH_MODE = cfg.authMode || (cfg.supabaseUrl ? 'anonymous' : 'none');

export const STORAGE_BUCKET = cfg.storageBucket || 'fotos';

/** Overlap subtracted from the pull cursor. Non-negotiable: `updated_at` is set
 *  from transaction-START time, so a transaction that begins before the cursor
 *  and commits after it writes rows already in the cursor's past. A bare
 *  `> last_sync` cursor loses them permanently. */
export const PULL_OVERLAP_MS = cfg.pullOverlapMs ?? 5 * 60 * 1000;

export const PULL_PAGE_SIZE = cfg.pullPageSize ?? 500;
export const PUSH_BATCH_SIZE = cfg.pushBatchSize ?? 50;

/** Attempts before an item is quarantined rather than retried forever. */
export const MAX_ATTEMPTS = cfg.maxAttempts ?? 8;

export const SYNC_INTERVAL_MS = cfg.syncIntervalMs ?? 60_000;

/** Warn the operator when unsynced work has been sitting this long. A lost or
 *  broken phone takes its outbox with it, so silence here is dangerous. */
export const PENDING_WARN_MS = cfg.pendingWarnMs ?? 12 * 60 * 60 * 1000;

/** Device clock disagreeing with the server by more than this is flagged. Every
 *  `fecha` originates on the device; a tablet with a dead RTC writes timestamps
 *  that silently corrupt every cycle-time metric. */
export const CLOCK_SKEW_WARN_MS = cfg.clockSkewWarnMs ?? 5 * 60 * 1000;

export const PHOTO_MAX_EDGE = cfg.photoMaxEdge ?? 1600;
export const PHOTO_QUALITY = cfg.photoQuality ?? 0.8;

export const OVEN_CAPACITY = cfg.ovenCapacidad ?? 8;

export const isBackendConfigured = () => Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
