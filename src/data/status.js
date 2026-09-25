/**
 * status.js — observable sync state for the UI.
 *
 * The operator must be able to tell, at a glance, whether their work has left
 * the device. Offline capture without a visible pending count is how a phone
 * ends up drowned in a shed carrying a day of records nobody knew were still
 * on it.
 */
import { openDb } from './idb/open.js';
import { outboxStats } from './outbox.js';
import { countUnresolved } from './conflicts.js';
import { blobStats } from './sync/blobs.js';
import { isOnline, getClient } from './supabase.js';
import { hasSession, isTokenExpired } from './session.js';
import { isClockSkewed, getClockSkewMs } from './time.js';
import { storageEstimate } from './idb/open.js';
import { PENDING_WARN_MS, isBackendConfigured, AUTH_MODE } from './config.js';

const listeners = new Set();
let _last = null;
let _syncing = false;
let _lastSyncAt = null;
let _lastError = null;

export function onChange(cb) {
  if (typeof cb !== 'function') return () => {};
  listeners.add(cb);
  if (_last) { try { cb(_last); } catch { /* listener's problem */ } }
  return () => listeners.delete(cb);
}

function notify(status) {
  _last = status;
  for (const cb of listeners) {
    try { cb(status); } catch (e) { console.warn('[tryento] listener de estado falló', e); }
  }
}

export const setSyncing = v => { _syncing = v; };
export const markSynced = () => { _lastSyncAt = Date.now(); _lastError = null; };
export const markSyncError = e => { _lastError = e?.message || String(e || ''); };

export async function getSyncStatus() {
  const db = await openDb();
  const [ob, conflicts, blobs, storage] = await Promise.all([
    outboxStats(db),
    countUnresolved(db),
    blobStats(db),
    storageEstimate()
  ]);

  const online = isOnline();
  const configured = isBackendConfigured() && Boolean(getClient());
  // With no auth there is nothing to sign in to, so treat it as satisfied
  // rather than nagging the operator about a login that does not exist.
  const signedIn = AUTH_MODE === 'none' ? true : hasSession();
  const pendingAgeMs = ob.oldestPendingAt ? Date.now() - ob.oldestPendingAt : 0;

  // "Paused" is not "broken". Capture keeps working; only the upload waits.
  const paused = configured && signedIn && isTokenExpired() && !online;

  return {
    online,
    configured,
    signedIn,
    syncing: _syncing,
    paused,
    pending: ob.unsynced,
    stuck: ob.stuck,
    conflicts,
    pendingPhotos: blobs.pending,
    pendingPhotoBytes: blobs.pendingBytes,
    pendingAgeMs,
    // Escalates once work has been sitting long enough that losing the device
    // would actually hurt.
    pendingWarning: pendingAgeMs > PENDING_WARN_MS,
    lastSyncAt: _lastSyncAt,
    lastError: _lastError,
    clockSkewed: isClockSkewed(),
    clockSkewMs: getClockSkewMs(),
    storage: storage ? { ...storage, low: storage.ratio > 0.8 } : null
  };
}

/** Recompute and broadcast. Called after every write and every sync pass. */
export async function refreshStatus() {
  const s = await getSyncStatus();
  notify(s);
  return s;
}

/** Short Spanish label + tone for the header chip. */
export function statusLabel(s) {
  if (!s) return { text: '...', tone: 'idle' };
  if (!s.configured) return { text: 'Sólo local', tone: 'warn' };
  if (s.conflicts > 0) return { text: `${s.conflicts} conflicto${s.conflicts > 1 ? 's' : ''}`, tone: 'error' };
  if (s.stuck > 0) return { text: `${s.stuck} sin enviar`, tone: 'error' };
  if (!s.online) return { text: s.pending ? `${s.pending} en espera` : 'Sin conexión', tone: 'warn' };
  if (s.syncing) return { text: 'Sincronizando...', tone: 'busy' };
  if (!s.signedIn) return { text: 'Inicia sesión', tone: 'warn' };
  if (s.pending > 0) return { text: `${s.pending} en espera`, tone: 'warn' };
  return { text: 'Al día', tone: 'ok' };
}
