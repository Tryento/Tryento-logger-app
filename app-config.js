/**
 * app-config.js — deployment configuration.
 *
 * A plain script, not a bundled constant, so the same build can be deployed to
 * staging and production by swapping this one file.
 *
 * The anon key is PUBLIC by design — it identifies the project, it does not
 * grant access. Every table has row-level security and nothing is readable
 * without a signed-in user. Never put a service-role key here.
 *
 * With supabaseUrl blank the app runs fully, offline, against IndexedDB alone
 * and simply never syncs. That is the intended behaviour for a demo or a
 * misconfigured deploy: a missing setting must not cost an operator their work.
 */
window.__TRYENTO_CONFIG__ = {
  // From Supabase -> Project Settings -> API. Use the "anon / public" key,
  // NEVER the service_role key — that one bypasses row-level security entirely
  // and this file is downloadable by anyone who opens the site.
  supabaseUrl: '',
  supabaseAnonKey: '',

  // 'none'      — DEMO: no login at all. The database policies are open, so
  //               anyone with this URL can read and write everything. Nothing
  //               to configure in the Supabase dashboard, nothing that can fail
  //               to sign in.
  // 'anonymous' — no login screen, but each device gets a real session so RLS
  //               can apply. Needs "Allow anonymous sign-ins" enabled.
  // 'google'    — real per-operator accounts. No schema change needed.
  authMode: 'none',

  // Must match "Exposed schemas" in Supabase -> Settings -> API, or every
  // request returns 404.
  dbSchema: 'app',
  storageBucket: 'fotos',

  // Every calendar day resolves against this, never the device's timezone.
  farmTz: 'America/Caracas',

  ovenCapacidad: 8
};
