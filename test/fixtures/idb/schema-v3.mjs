// FROZEN FIXTURE — src/data/idb/schema.js exactly as committed for Release 1 (5923baf, DB v3).
// Used to build a local database the way a phone running that build has it.
// Never edit: the point is that it matches what will really be on devices.

/**
 * schema.js — IndexedDB stores, indexes and versioned migrations.
 *
 * MIGRATIONS ARE APPEND-ONLY. To change the local schema, add a step to the end
 * of MIGRATIONS and update STORE_DEFS to the shape it produces — DB_VERSION is
 * derived from the array length. NEVER EDIT A STEP THAT HAS SHIPPED: phones in
 * the field have already run it, and they will never run it again.
 *
 * A step must be written against the literal store names and indexes of its own
 * moment, never against SYNCED_STORES or STORE_DEFS. Those describe the schema
 * TODAY; a step that reads them silently changes meaning the next time they
 * change, which is exactly how the cochada -> lote rename broke start-up.
 *
 * A device may be carrying hundreds of unsynced outbox rows when it picks up a
 * new version of the app, and losing them means losing a day of somebody's
 * work. No step may drop or recreate `outbox`, `blobs` or `conflicts`, and a
 * step that retires a store COPIES its rows before dropping it.
 *
 * Steps may be async, but may only await IndexedDB requests on the upgrade
 * transaction they are given. Awaiting anything else (a timer, fetch) lets the
 * transaction auto-commit halfway through the step.
 *
 * Index notes:
 *  - IndexedDB cannot index a boolean (valid keys are number, string, Date,
 *    binary and arrays of those). Anything conceptually boolean is stored as a
 *    0/1 `_`-prefixed mirror field, maintained on write.
 *  - Local indexes are deliberately NON-unique even where Postgres enforces
 *    uniqueness. A ConstraintError during a pull would abort the whole
 *    transaction and stall sync permanently; uniqueness is the server's job and
 *    violations belong in the conflict inbox.
 */

export const DB_NAME = 'tryento';

/** Domain stores that mirror Postgres tables, in parent-first order. Pull and
 *  local upsert both walk this list so foreign keys always land in order. */
export const SYNCED_STORES = [
  'parametro',
  'catalogo',
  'insectario',
  'recoleccion',
  'incubadora',
  'bandeja',
  'alimentacion',
  'ayuno',
  'revision',
  'separacion',
  'lote',
  'lote_separacion'
];

/** Stores that are purely local machinery and never pulled from the server. */
export const LOCAL_STORES = ['bandeja_cache', 'outbox', 'blobs', 'conflicts', 'meta'];

/** Event stores keyed to a tray, used by the timeline and the cache rebuild. */
export const EVENT_STORES = ['alimentacion', 'ayuno', 'revision', 'separacion'];

/**
 * The schema the LATEST migration produces. Not read by any migration — a test
 * checks that a fresh install and every upgrade path end up exactly here, so
 * changing it without adding a step fails the build.
 */
export const STORE_DEFS = {
  // Protocol settings (days, kg, larvae per tray). Pulled, never written here.
  parametro:     { keyPath: 'id', indexes: [['by_clave', 'clave'], ['by_updated', 'updated_at']] },
  catalogo:      { keyPath: 'id', indexes: [['by_tipo', 'tipo'], ['by_updated', 'updated_at']] },
  insectario:    { keyPath: 'id', indexes: [['by_updated', 'updated_at'], ['by_estado', 'estado']] },
  recoleccion:   { keyPath: 'id', indexes: [['by_insectario', 'insectario_id'], ['by_updated', 'updated_at']] },
  // v2: one per recolecta, días 0–7, then split into bandejas.
  incubadora:    { keyPath: 'id', indexes: [
                     ['by_recoleccion', 'recoleccion_id'],
                     ['by_estado', 'estado'],
                     ['by_updated', 'updated_at']] },
  bandeja:       { keyPath: 'id', indexes: [
                     ['by_recoleccion', 'recoleccion_id'],
                     ['by_estado', 'estado'],
                     ['by_updated', 'updated_at'],
                     ['by_incubadora', 'incubadora_id']] },
  alimentacion:  { keyPath: 'id', indexes: [
                     ['by_bandeja', 'bandeja_id'],
                     ['by_grupal', 'grupal_id'],
                     ['by_updated', 'updated_at']] },
  ayuno:         { keyPath: 'id', indexes: [
                     ['by_bandeja', 'bandeja_id'],
                     ['by_abierto', '_abierto'],        // 1 = no peso_final yet
                     ['by_updated', 'updated_at']] },
  revision:      { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_updated', 'updated_at']] },
  separacion:    { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_updated', 'updated_at']] },
  lote:          { keyPath: 'id', indexes: [['by_estado', 'estado'], ['by_updated', 'updated_at']] },
  lote_separacion: {
                   keyPath: ['lote_id', 'separacion_id'],
                   indexes: [
                     ['by_lote', 'lote_id'],
                     ['by_separacion', 'separacion_id'],
                     ['by_updated', 'updated_at']] },

  // Denormalised per-tray rollup. Without it `listBandejas` re-scans all four
  // event stores per tray — O(trays x events), which is instant against the
  // mock and a multi-second freeze against a year of real data on a cheap
  // phone. Maintained incrementally on every local write and every pulled row.
  bandeja_cache: { keyPath: 'bandeja_id', indexes: [['by_last_fecha', 'last_evento_fecha']] },

  outbox:        { keyPath: 'id', indexes: [
                     ['by_status', 'status'],
                     ['by_seq', 'seq'],
                     ['by_status_seq', ['status', 'seq']],
                     ['by_row', 'row_id'],
                     ['by_user', 'created_by']] },
  blobs:         { keyPath: 'id', indexes: [['by_status', 'status']] },
  conflicts:     { keyPath: 'id', indexes: [['by_resolved', '_resuelto'], ['by_created', 'created_at']] },
  meta:          { keyPath: 'key', indexes: [] }
};

/* ── helpers for migration steps ──────────────────────────────────────────── */

function createStore(db, name, def) {
  const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: false });
  for (const [idxName, keyPath] of def.indexes) {
    store.createIndex(idxName, keyPath, { unique: false });
  }
  return store;
}

const done = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Rewrite every row of a store in place; `fix` returns the new row or null. */
async function rewriteAll(store, fix) {
  const rows = await done(store.getAll());
  const writes = [];
  for (const row of rows) {
    const next = fix(row);
    if (next) writes.push(done(store.put(next)));
  }
  await Promise.all(writes);
  return writes.length;
}

/* ── v1, frozen ───────────────────────────────────────────────────────────── */

/**
 * v1 exactly as it is running in production (commit a05e4f7). Written out in
 * full so a later edit to STORE_DEFS can never change what v1 means.
 *
 * Phones in the field hold one of TWO v1 databases, because the rename changed
 * this step without bumping the version: installs from before a05e4f7 have
 * `cochada` / `cochada_separacion` (keyed on cochada_id); installs from after
 * it have `lote` / `lote_separacion`. v2 converges both.
 */
const V1_STORES = {
  catalogo:        { keyPath: 'id', indexes: [['by_tipo', 'tipo'], ['by_updated', 'updated_at']] },
  insectario:      { keyPath: 'id', indexes: [['by_updated', 'updated_at'], ['by_estado', 'estado']] },
  recoleccion:     { keyPath: 'id', indexes: [['by_insectario', 'insectario_id'], ['by_updated', 'updated_at']] },
  bandeja:         { keyPath: 'id', indexes: [['by_recoleccion', 'recoleccion_id'], ['by_estado', 'estado'], ['by_updated', 'updated_at']] },
  alimentacion:    { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_grupal', 'grupal_id'], ['by_updated', 'updated_at']] },
  ayuno:           { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_abierto', '_abierto'], ['by_updated', 'updated_at']] },
  revision:        { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_updated', 'updated_at']] },
  separacion:      { keyPath: 'id', indexes: [['by_bandeja', 'bandeja_id'], ['by_updated', 'updated_at']] },
  lote:            { keyPath: 'id', indexes: [['by_estado', 'estado'], ['by_updated', 'updated_at']] },
  lote_separacion: { keyPath: ['lote_id', 'separacion_id'], indexes: [['by_lote', 'lote_id'], ['by_separacion', 'separacion_id'], ['by_updated', 'updated_at']] },
  bandeja_cache:   { keyPath: 'bandeja_id', indexes: [['by_last_fecha', 'last_evento_fecha']] },
  outbox:          { keyPath: 'id', indexes: [['by_status', 'status'], ['by_seq', 'seq'], ['by_status_seq', ['status', 'seq']], ['by_row', 'row_id'], ['by_user', 'created_by']] },
  blobs:           { keyPath: 'id', indexes: [['by_status', 'status']] },
  conflicts:       { keyPath: 'id', indexes: [['by_resolved', '_resuelto'], ['by_created', 'created_at']] },
  meta:            { keyPath: 'key', indexes: [] }
};

/* ── v2, the cochada -> lote rename ───────────────────────────────────────── */

/** Stores v2 guarantees, as they were defined at v2. */
const V2_LOTE_STORES = {
  lote:            V1_STORES.lote,
  lote_separacion: V1_STORES.lote_separacion
};

/**
 * Every name the app has ever queued under the old vocabulary, taken from git
 * history (every commit of src/data/write.js from 7c5a71f to e929a7c). Explicit
 * on purpose: a substring replace would also rewrite names nobody meant.
 */
const V2_TABLES = { cochada: 'lote', cochada_separacion: 'lote_separacion' };
const V2_RPCS = {
  crear_cochada: 'crear_lote',
  rechazar_cochada: 'rechazar_lote',
  actualizar_qc_cochada: 'actualizar_qc_lote'
};

/** Rename the old vocabulary in a queued item or a conflict row. */
function v2RetargetItem(item) {
  let changed = false;
  const next = { ...item };

  if (V2_TABLES[next.table]) {
    next.table = V2_TABLES[next.table];
    changed = true;
  }
  if (V2_RPCS[next.rpc]) {
    next.rpc = V2_RPCS[next.rpc];
    changed = true;
  } else if (typeof next.rpc === 'string' && next.rpc.includes('cochada')) {
    // Not in the list above, so no build ever sent it. Left alone: it fails on
    // push and lands in the conflict inbox where a person can see it.
    console.warn(`[tryento] v2: RPC desconocido en cola, sin cambiar: ${next.rpc}`);
  }

  if (next.payload && typeof next.payload === 'object') {
    const p = { ...next.payload };
    if ('p_cochada' in p) { p.p_lote = p.p_cochada; delete p.p_cochada; changed = true; }
    if ('cochada_id' in p) { p.lote_id = p.cochada_id; delete p.cochada_id; changed = true; }
    next.payload = p;
  }
  return changed ? next : null;
}

export const V2_RENAMES = { tables: V2_TABLES, rpcs: V2_RPCS };

/* ── v3, the protocolo v2 stores ──────────────────────────────────────────── */

/** Stores v3 adds, as they were defined at v3. */
const V3_STORES = {
  parametro:  { keyPath: 'id', indexes: [['by_clave', 'clave'], ['by_updated', 'updated_at']] },
  incubadora: { keyPath: 'id', indexes: [['by_recoleccion', 'recoleccion_id'], ['by_estado', 'estado'],
                                         ['by_updated', 'updated_at']] }
};

/**
 * Append-only list of upgrade steps. Index N implements version N+1.
 * Each step is (db, tx) => void | Promise<void>.
 */
export const MIGRATIONS = [
  // ── v1: initial schema (frozen; see V1_STORES) ───────────────────────────
  (db) => {
    for (const [name, def] of Object.entries(V1_STORES)) createStore(db, name, def);
  },

  // ── v2: cochada -> lote ─────────────────────────────────────────────────
  //
  // Store names cannot be renamed in IndexedDB, so the new stores are created,
  // every row is COPIED across, and only then are the old stores dropped. A lote
  // recorded offline and not yet synced exists nowhere but here; dropping it and
  // waiting for the pull to bring it back would lose it. All of this runs in the
  // single upgrade transaction: if any part fails, the whole upgrade rolls back
  // and the phone keeps its v1 database intact.
  async (db, tx) => {
    const has = name => db.objectStoreNames.contains(name);
    const createdNow = [];
    for (const [name, def] of Object.entries(V2_LOTE_STORES)) {
      if (has(name)) continue;
      createStore(db, name, def);
      createdNow.push(name);
    }

    const lote = tx.objectStore('lote');
    const loteSep = tx.objectStore('lote_separacion');

    // 1. cochada -> lote. A row already present in `lote` is newer; keep it.
    if (has('cochada')) {
      const rows = await done(tx.objectStore('cochada').getAll());
      const existing = new Set(await done(lote.getAllKeys()));
      await Promise.all(rows.filter(r => !existing.has(r.id)).map(r => done(lote.put(r))));
    }

    // 2. cochada_separacion -> lote_separacion, renaming the key column.
    if (has('cochada_separacion')) {
      const rows = await done(tx.objectStore('cochada_separacion').getAll());
      const existing = new Set((await done(loteSep.getAllKeys())).map(k => k.join('\u0000')));
      const moved = rows.map(({ cochada_id, ...rest }) => ({ ...rest, lote_id: cochada_id }))
                        .filter(r => !existing.has([r.lote_id, r.separacion_id].join('\u0000')));
      await Promise.all(moved.map(r => done(loteSep.put(r))));
    }

    // 3. The per-tray rollup names the lote a tray went into.
    await rewriteAll(tx.objectStore('bandeja_cache'), row => {
      if (!('cochada_id' in row)) return null;
      const { cochada_id, ...rest } = row;
      return { ...rest, lote_id: rest.lote_id ?? cochada_id };
    });

    // 4. Queued writes and conflict rows must name tables and RPCs that exist.
    //    A conflict row naming `cochada` would throw on "Descartar", which
    //    opens a transaction on row.table.
    await rewriteAll(tx.objectStore('outbox'), v2RetargetItem);
    await rewriteAll(tx.objectStore('conflicts'), v2RetargetItem);

    // 5. Photos: only the bookkeeping name. `key` is NOT touched — it is the
    //    storage path that lote.qc_foto_key already points at.
    await rewriteAll(tx.objectStore('blobs'), row =>
      V2_TABLES[row.table] ? { ...row, table: V2_TABLES[row.table] } : null);

    // 6. Pull cursors. The old ones name tables that no longer exist. If the lote
    //    stores were created just now, they start empty locally, so make sure
    //    their cursor starts from the beginning and the full list downloads.
    const meta = tx.objectStore('meta');
    const stale = ['pull_cursor:cochada', 'pull_cursor:cochada_separacion',
                   ...createdNow.map(n => `pull_cursor:${n}`)];
    await Promise.all(stale.map(k => done(meta.delete(k))));

    // 7. Only now, with every row copied, retire the old stores.
    for (const name of ['cochada', 'cochada_separacion']) {
      if (has(name)) db.deleteObjectStore(name);
    }
  },

  // ── v3: protocolo v2 (0007_protocolo_v2.sql) ────────────────────────────
  //
  // Only ADDS: two stores and one index. Nothing existing is touched. The new
  // stores have no pull cursor yet, so their first pull downloads everything.
  (db, tx) => {
    for (const [name, def] of Object.entries(V3_STORES)) {
      if (!db.objectStoreNames.contains(name)) createStore(db, name, def);
    }
    const bandeja = tx.objectStore('bandeja');
    if (!bandeja.indexNames.contains('by_incubadora')) {
      bandeja.createIndex('by_incubadora', 'incubadora_id', { unique: false });
    }
  }
];

export const DB_VERSION = MIGRATIONS.length;

/** A fast is open until it is closed: no close time and no final weight. In v1
 *  a close always carries a weight, so this matches the old rule there; in v2
 *  the cosecha closes the fast without one. */
export const ayunoAbierto = row =>
  (row?.peso_final_kg === null || row?.peso_final_kg === undefined) && !row?.cerrado_at;

/** Derived 0/1 mirrors for fields IndexedDB cannot index directly. */
export function withIndexMirrors(store, row) {
  if (store === 'ayuno') {
    return { ...row, _abierto: ayunoAbierto(row) ? 1 : 0 };
  }
  if (store === 'conflicts') {
    return { ...row, _resuelto: row.resuelto_at ? 1 : 0 };
  }
  return row;
}
