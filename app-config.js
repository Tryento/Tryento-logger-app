/**
 * app-config.js — deployment configuration.
 *
 * A plain script, not a bundled constant, so the same build can be deployed to
 * staging and production by swapping this one file.
 *
 * The anon key is PUBLIC by design — it ships inside the page and anyone can
 * read it. In THIS demo the database policies are open, so that key is enough
 * to read and write everything; that is the accepted trade-off for having no
 * login. Never put the service_role key here under any configuration.
 *
 * supabaseUrl is the PROJECT url — https://xxxx.supabase.co — NOT the REST
 * endpoint that ends in /rest/v1/. Supabase shows both; only the short one
 * works here.
 *
 * With supabaseUrl blank the app runs fully, offline, against IndexedDB alone
 * and simply never syncs. That is the intended behaviour for a demo or a
 * misconfigured deploy: a missing setting must not cost an operator their work.
 */
window.__TRYENTO_CONFIG__ = {
  // From Supabase -> Project Settings -> API. Use the "anon / public" key,
  // NEVER the service_role key — that one bypasses row-level security entirely
  // and this file is downloadable by anyone who opens the site.
  supabaseUrl: 'https://roxgnhrdrgcrfybaevov.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJveGduaHJkcmdjcmZ5YmFldm92Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMDYyNjMsImV4cCI6MjEwNTg4MjI2M30.rtjVYoL0UpJda7Bu9aw7wcLYJ3MzNa6NW8bPqdd9Nos',   // <-- PEGA AQUÍ la clave anon/public (empieza con eyJ...)

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
