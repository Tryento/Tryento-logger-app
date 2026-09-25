/**
 * session.js — who is signed in, readable synchronously and offline.
 *
 * RULE: `supabase.auth.getSession()` must never appear in the capture path. It
 * can hang or throw with no network, and an operator standing in a shed must be
 * able to record a feeding whether or not the auth server is reachable.
 *
 * So the session is cached in memory (and mirrored into `meta` for the next
 * cold start) at sign-in, and every write reads that copy. Auth gates SYNC.
 * It never gates capture.
 */
import { metaGet, metaSet } from './idb/tx.js';

const META_KEY = 'session';

let _session = null;   // { user_id, email, nombre, rol, expires_at }

export function setSessionMemory(s) { _session = s || null; }

export async function cacheSession(db, supabaseSession) {
  if (!supabaseSession?.user) {
    _session = null;
    await metaSet(db, META_KEY, null);
    return null;
  }
  const u = supabaseSession.user;
  const s = {
    user_id: u.id,
    email: u.email || null,
    nombre: u.user_metadata?.full_name || u.user_metadata?.name || u.email || null,
    rol: u.app_metadata?.rol || 'usuario',
    expires_at: supabaseSession.expires_at ? supabaseSession.expires_at * 1000 : null
  };
  _session = s;
  await metaSet(db, META_KEY, s);
  return s;
}

/** Restore at boot so a cold start with no network still knows who you are. */
export async function loadCachedSession(db) {
  _session = await metaGet(db, META_KEY, null);
  return _session;
}

export const getSession = () => _session;
export const currentUserId = () => _session?.user_id || null;
export const currentRole = () => _session?.rol || 'usuario';
export const isAdmin = () => currentRole() === 'admin';
export const hasSession = () => Boolean(_session?.user_id);

/**
 * Whether the ACCESS token is past its expiry. A stale token does not mean
 * "sign the operator out" — it means "pause sync until we can refresh". The
 * distinction is the whole point: the alternative is a login wall in a place
 * with no signal.
 */
export const isTokenExpired = () =>
  Boolean(_session?.expires_at && Date.now() >= _session.expires_at);

export async function clearSession(db) {
  _session = null;
  if (db) await metaSet(db, META_KEY, null);
}
