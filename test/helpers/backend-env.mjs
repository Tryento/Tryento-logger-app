/**
 * Makes the app believe a backend is configured, and lets a test decide what
 * that backend is (normally pgClient over PGlite).
 *
 * MUST be the first import of a test file: src/data/config.js reads
 * __TRYENTO_CONFIG__ once, when it is first imported.
 *
 * Deliberately does NOT define `window`: fake-indexeddb and PGlite both check
 * for it and switch to browser behaviour, which breaks both under Node.
 */
globalThis.__TRYENTO_CONFIG__ = {
  supabaseUrl: 'http://pglite.test',
  supabaseAnonKey: 'test-anon-key',
  authMode: 'none'
};

let target = null;

// supabase.js caches the client it creates, so hand it a stand-in that always
// forwards to whichever backend the current test chose.
globalThis.supabase = {
  createClient: () => new Proxy({}, {
    get(_, key) {
      if (!target) throw new Error('backend-env: ningún backend elegido (useBackend)');
      const v = target[key];
      return typeof v === 'function' ? v.bind(target) : v;
    }
  })
};

export function useBackend(client) {
  target = client;
}
