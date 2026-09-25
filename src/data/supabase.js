/**
 * supabase.js — the network client.
 *
 * Nothing in the capture path may import from here. If Supabase is
 * unconfigured or unreachable the app still works completely against
 * IndexedDB; this module only ever affects whether and when data leaves the
 * device.
 */
import { SUPABASE_URL, SUPABASE_ANON_KEY, DB_SCHEMA, STORAGE_BUCKET, isBackendConfigured } from './config.js';
import { recordServerDate } from './time.js';

let _client = null;

export function getClient() {
  if (_client) return _client;
  if (!isBackendConfigured()) return null;

  const lib = globalThis.supabase;
  if (!lib?.createClient) {
    console.warn('[tryento] vendor/supabase.js no cargado; la app funciona sólo localmente');
    return null;
  }

  _client = lib.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storageKey: 'tryento.auth'
    },
    db: { schema: DB_SCHEMA },
    global: {
      // Every response carries the server's clock for free. It is the only
      // trustworthy time reference we get, and a device with a bad RTC would
      // otherwise corrupt every cycle-time metric with nothing on screen to
      // suggest a problem.
      fetch: async (url, opts) => {
        const res = await fetch(url, opts);
        try { recordServerDate(res.headers.get('date')); } catch { /* opaque response */ }
        return res;
      }
    }
  });
  return _client;
}

export const isOnline = () =>
  typeof navigator === 'undefined' || navigator.onLine !== false;

export const canSync = () => Boolean(getClient()) && isOnline();

/**
 * Turn a supabase-js `{ error }` into a throwable carrying the SQLSTATE, so the
 * outbox's taxonomy can tell a unique violation (never retry) from a 503
 * (always retry).
 */
export function toError(error, fallbackMessage = 'Error del servidor') {
  const e = new Error(error?.message || fallbackMessage);
  if (error?.code) e.code = error.code;
  if (error?.details) e.details = error.details;
  if (error?.hint) e.hint = error.hint;
  const status = error?.status ?? error?.statusCode;
  if (status) e.status = Number(status);
  // PostgREST reports constraint violations as 409 with the SQLSTATE in .code.
  if (!e.status && typeof e.code === 'string' && e.code.startsWith('23')) e.status = 409;
  return e;
}

/**
 * Anonymous sign-in: a real Supabase user with `is_anonymous: true`, carrying
 * the `authenticated` role.
 *
 * This is the whole trick behind a login-free demo that is not wide open. The
 * alternative — granting the `anon` role write access — means anyone who finds
 * the URL can write with no session, no per-device attribution, and no way to
 * revoke. Here every write still has an auth.uid(), the existing RLS policies
 * apply unchanged, and moving to real accounts later is a config flip rather
 * than a migration.
 *
 * Requires "Allow anonymous sign-ins" in Supabase -> Authentication -> Providers.
 */
export async function signInAnonymously() {
  const c = getClient();
  if (!c) return { ok: false, error: 'Backend no configurado' };
  if (typeof c.auth.signInAnonymously !== 'function') {
    return { ok: false, error: 'Esta versión de supabase-js no soporta sesiones anónimas' };
  }
  const { data, error } = await c.auth.signInAnonymously();
  if (error) {
    // The most common cause by far is the provider being disabled.
    return { ok: false, error: error.message, needsProviderEnabled: /anonymous/i.test(error.message || '') };
  }
  return { ok: true, session: data?.session || null };
}

export async function signInWithGoogle(redirectTo) {
  const c = getClient();
  if (!c) return { ok: false, error: 'Backend no configurado' };
  const { error } = await c.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: redirectTo || globalThis.location?.origin }
  });
  return error ? { ok: false, error: error.message } : { ok: true };
}

export async function signOut() {
  const c = getClient();
  if (c) await c.auth.signOut();
}

/**
 * Current session, or null. ONLY for the sync path and the login screen —
 * never for capture, where it could hang with no network.
 */
export async function fetchSession() {
  const c = getClient();
  if (!c) return null;
  try {
    const { data } = await c.auth.getSession();
    return data?.session || null;
  } catch {
    return null;
  }
}

export async function refreshSession() {
  const c = getClient();
  if (!c) return null;
  try {
    const { data, error } = await c.auth.refreshSession();
    return error ? null : data?.session || null;
  } catch {
    return null;
  }
}

export const storageBucket = () => {
  const c = getClient();
  return c ? c.storage.from(STORAGE_BUCKET) : null;
};
