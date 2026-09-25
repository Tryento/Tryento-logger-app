/**
 * loop.js — sync orchestration.
 *
 * Order is push -> pull -> blobs, and that order matters:
 *   push first  so the operator's own work leaves the device at the first
 *               opportunity, which is the thing that is irreplaceable if the
 *               phone is lost
 *   pull second so the screen reflects other people's work
 *   blobs last  because a photo must never delay a row
 */
import { openDb } from '../idb/open.js';
import { canSync, isOnline, fetchSession, refreshSession, getClient, signInAnonymously } from '../supabase.js';
import { cacheSession, hasSession, isTokenExpired, loadCachedSession } from '../session.js';
import { AUTH_MODE } from '../config.js';
import { pushAll } from './push.js';
import { pullOnce, initialPull, hasInitialPull } from './pull.js';
import { uploadPending } from './blobs.js';
import { pruneDone } from '../outbox.js';
import { setSyncing, markSynced, markSyncError, refreshStatus } from '../status.js';
import { SYNC_INTERVAL_MS } from '../config.js';

const LOCK = 'tryento-sync';
let _timer = null;
let _inflight = null;
let _started = false;

/**
 * Run `fn` as the single sync leader across all open tabs.
 *
 * Without this, two tabs drain the same queue concurrently. Idempotent upserts
 * survive that, but an RPC (the bulk feed, creating a cochada) is not
 * guaranteed to, and neither are blob uploads.
 */
async function asLeader(fn) {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
  if (!locks?.request) return fn();                 // older browser: best effort
  return locks.request(LOCK, { ifAvailable: true }, async lock => {
    if (!lock) return null;                          // another tab is driving
    return fn();
  });
}

/** Keep the token fresh enough to push. Failure PAUSES sync; it never signs the
 *  operator out and never blocks capture. */
async function ensureSession(db) {
  if (!getClient()) return false;

  // DEMO: no auth at all. Requests go out with the public anon key and the
  // database's open policies accept them. Nothing to sign in to, so nothing
  // that can fail to sign in.
  if (AUTH_MODE === 'none') return true;

  if (!hasSession()) {
    let s = await fetchSession();

    // No stored session. In anonymous mode, create one silently — the operator
    // never sees a login screen, but the device still gets a real auth.uid()
    // so RLS applies and writes are attributable.
    if (!s && AUTH_MODE === 'anonymous') {
      const r = await signInAnonymously();
      if (!r.ok) {
        markSyncError(new Error(
          r.needsProviderEnabled
            ? 'Habilita "Allow anonymous sign-ins" en Supabase → Authentication → Providers'
            : r.error));
        return false;
      }
      s = r.session;
    }

    if (s) await cacheSession(db, s);
    return Boolean(s);
  }

  if (isTokenExpired()) {
    const s = await refreshSession();
    if (s) { await cacheSession(db, s); return true; }
    // Refresh token rotated out from under us (two devices, or a stale tab).
    // Start a fresh anonymous session rather than stalling sync forever.
    if (AUTH_MODE === 'anonymous') {
      const r = await signInAnonymously();
      if (r.ok && r.session) { await cacheSession(db, r.session); return true; }
    }
    return false;
  }
  return true;
}

/**
 * Run one sync pass.
 *
 * Concurrency, and why it is not just a boolean guard:
 *
 *   A background pass is nearly always in flight — every write calls nudge().
 *   The original guard returned immediately if one was running, which meant a
 *   FORCED sync (the operator tapping "Sincronizar ahora", or the last write of
 *   the day) could silently do nothing and the work would sit in the queue
 *   until the next timer tick. Worse, that was invisible: the queue count just
 *   did not move.
 *
 *   So: an opportunistic call still coalesces into the running pass, but a
 *   forced one WAITS for it and then runs its own, so the caller's request is
 *   actually honoured.
 */
export async function syncNow({ force = false } = {}) {
  if (_inflight) {
    if (!force) return { skipped: 'ya en curso' };
    await _inflight.catch(() => {});
  }
  _inflight = runSyncPass({ force });
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

async function runSyncPass({ force }) {
  const db = await openDb();

  if (!canSync()) {
    await refreshStatus();
    return { skipped: 'sin conexión' };
  }

  setSyncing(true);
  await refreshStatus();

  try {
    return await asLeader(async () => {
      const authed = await ensureSession(db);
      if (!authed) {
        markSyncError(new Error('sesión no disponible'));
        return { skipped: 'sin sesión' };
      }

      const pushed = await pushAll(db);

      const pulled = (await hasInitialPull(db))
        ? await pullOnce(db)
        : await initialPull(db);

      const photos = await uploadPending(db, { force });

      await pruneDone(db).catch(() => {});
      markSynced();
      return { pushed, pulled, photos };
    });
  } catch (err) {
    markSyncError(err);
    console.warn('[tryento] sync falló', err);
    return { error: err.message };
  } finally {
    setSyncing(false);
    await refreshStatus();
  }
}

/**
 * Start background sync.
 *
 * Triggers: app start, regaining connectivity, returning to the foreground, a
 * periodic timer, and explicitly after every write. A device that has been in a
 * pocket all morning syncs the moment it is woken in range rather than waiting
 * out a timer.
 */
export async function startSync() {
  if (_started) return;
  _started = true;

  const db = await openDb();
  await loadCachedSession(db);

  const client = getClient();
  if (client) {
    client.auth.onAuthStateChange(async (_event, session) => {
      await cacheSession(db, session);
      await refreshStatus();
      if (session) syncNow();
    });
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => syncNow());
    window.addEventListener('offline', () => refreshStatus());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncNow();
    });
    // Last chance to flush before the tab goes away.
    window.addEventListener('pagehide', () => { if (isOnline()) syncNow(); });
  }

  _timer = setInterval(() => syncNow(), SYNC_INTERVAL_MS);
  await syncNow();
}

export function stopSync() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}

/** Fire-and-forget nudge after a write. Never awaited by the UI — the whole
 *  point is that the operator does not wait for the network. */
export function nudge() {
  if (canSync()) Promise.resolve().then(() => syncNow()).catch(() => {});
}
