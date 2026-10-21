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

/**
 * The protocols of October 2026 (0010_ciclo_nuevo.sql) rebuilt every table, so
 * they start a NEW database rather than migrating the old one: nothing in the
 * old one can sync any more, because the tables it names are gone.
 */
export const DB_NAME = 'tryento-ciclo';

/** Databases of earlier protocols, deleted at start (idb/open.js). */
export const LEGACY_DB_NAMES = ['tryento'];

/** Domain stores that mirror Postgres tables, in parent-first order. Pull and
 *  local upsert both walk this list so foreign keys always land in order. */
export const SYNCED_STORES = [
  'parametro',
  'catalogo',
  'rack',
  'contenedor',
  'jaula',
  'recepcion',
  'ensilado',
  'ensilado_insumo',
  'incubadora',
  'distribucion',
  'caja',
  'chequeo',
  'alimentacion',
  'separacion',
  'cochada',
  'cochada_origen',
  'cochada_lectura',
  'ingreso',
  'bandeja_pupacion',
  'jaula_evento',
  'movimiento'
];

/** Stores that are purely local machinery and never pulled from the server. */
export const LOCAL_STORES = ['outbox', 'blobs', 'conflicts', 'meta'];

const UPD = ['by_updated', 'updated_at'];

/**
 * The schema the LATEST migration produces. Not read by any migration — a test
 * checks that a fresh install and every upgrade path end up exactly here, so
 * changing it without adding a step fails the build.
 */
export const STORE_DEFS = {
  // Protocol settings (days, kg, %). Pulled, never written here.
  parametro:        { keyPath: 'id', indexes: [['by_clave', 'clave'], UPD] },
  catalogo:         { keyPath: 'id', indexes: [['by_tipo', 'tipo'], UPD] },

  // Objects registered once.
  rack:             { keyPath: 'id', indexes: [UPD] },
  contenedor:       { keyPath: 'id', indexes: [UPD] },
  jaula:            { keyPath: 'id', indexes: [UPD] },

  // Food: received material, ensilados and what went into them.
  recepcion:        { keyPath: 'id', indexes: [UPD] },
  ensilado:         { keyPath: 'id', indexes: [['by_contenedor', 'contenedor_id'], UPD] },
  ensilado_insumo:  { keyPath: 'id', indexes: [['by_ensilado', 'ensilado_id'], ['by_recepcion', 'recepcion_id'], UPD] },

  // The larvae cycle.
  incubadora:       { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], ['by_estado', 'estado'], UPD] },
  distribucion:     { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], UPD] },
  caja:             { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], ['by_estado', 'estado'], UPD] },
  chequeo:          { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], ['by_caja', 'caja_id'], UPD] },
  alimentacion:     { keyPath: 'id', indexes: [['by_caja', 'caja_id'], UPD] },
  separacion:       { keyPath: 'id', indexes: [['by_caja', 'caja_id'], UPD] },

  // The oven.
  cochada:          { keyPath: 'id', indexes: [['by_estado', 'estado'], UPD] },
  cochada_origen:   { keyPath: 'id', indexes: [['by_cochada', 'cochada_id'], ['by_separacion', 'separacion_id'], UPD] },
  cochada_lectura:  { keyPath: 'id', indexes: [['by_cochada', 'cochada_id'], UPD] },

  // The 2 % back to the insectario, and the cage's own cycle.
  ingreso:          { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], UPD] },
  bandeja_pupacion: { keyPath: 'id', indexes: [['by_ingreso', 'ingreso_id'], ['by_jaula', 'jaula_id'], UPD] },
  jaula_evento:     { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], UPD] },
  movimiento:       { keyPath: 'id', indexes: [['by_objeto', 'objeto_id'], UPD] },

  outbox:           { keyPath: 'id', indexes: [
                        ['by_status', 'status'],
                        ['by_seq', 'seq'],
                        ['by_status_seq', ['status', 'seq']],
                        ['by_row', 'row_id'],
                        ['by_user', 'created_by']] },
  blobs:            { keyPath: 'id', indexes: [['by_status', 'status']] },
  conflicts:        { keyPath: 'id', indexes: [['by_resolved', '_resuelto'], ['by_created', 'created_at']] },
  meta:             { keyPath: 'key', indexes: [] }
};

/* ── helpers for migration steps ──────────────────────────────────────────── */

function createStore(db, name, def) {
  const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: false });
  for (const [idxName, keyPath] of def.indexes) {
    store.createIndex(idxName, keyPath, { unique: false });
  }
  return store;
}

/* ── v1, frozen ───────────────────────────────────────────────────────────── */

/**
 * v1 of this database exactly as it first shipped. Written out in full, apart
 * from STORE_DEFS, so a later edit to STORE_DEFS can never change what v1 means.
 */
const V1_STORES = {
  parametro:        { keyPath: 'id', indexes: [['by_clave', 'clave'], ['by_updated', 'updated_at']] },
  catalogo:         { keyPath: 'id', indexes: [['by_tipo', 'tipo'], ['by_updated', 'updated_at']] },
  rack:             { keyPath: 'id', indexes: [['by_updated', 'updated_at']] },
  contenedor:       { keyPath: 'id', indexes: [['by_updated', 'updated_at']] },
  jaula:            { keyPath: 'id', indexes: [['by_updated', 'updated_at']] },
  recepcion:        { keyPath: 'id', indexes: [['by_updated', 'updated_at']] },
  ensilado:         { keyPath: 'id', indexes: [['by_contenedor', 'contenedor_id'], ['by_updated', 'updated_at']] },
  ensilado_insumo:  { keyPath: 'id', indexes: [['by_ensilado', 'ensilado_id'], ['by_recepcion', 'recepcion_id'],
                                                ['by_updated', 'updated_at']] },
  incubadora:       { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], ['by_estado', 'estado'],
                                                ['by_updated', 'updated_at']] },
  distribucion:     { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], ['by_updated', 'updated_at']] },
  caja:             { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], ['by_estado', 'estado'],
                                                ['by_updated', 'updated_at']] },
  chequeo:          { keyPath: 'id', indexes: [['by_incubadora', 'incubadora_id'], ['by_caja', 'caja_id'],
                                                ['by_updated', 'updated_at']] },
  alimentacion:     { keyPath: 'id', indexes: [['by_caja', 'caja_id'], ['by_updated', 'updated_at']] },
  separacion:       { keyPath: 'id', indexes: [['by_caja', 'caja_id'], ['by_updated', 'updated_at']] },
  cochada:          { keyPath: 'id', indexes: [['by_estado', 'estado'], ['by_updated', 'updated_at']] },
  cochada_origen:   { keyPath: 'id', indexes: [['by_cochada', 'cochada_id'], ['by_separacion', 'separacion_id'],
                                                ['by_updated', 'updated_at']] },
  cochada_lectura:  { keyPath: 'id', indexes: [['by_cochada', 'cochada_id'], ['by_updated', 'updated_at']] },
  ingreso:          { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], ['by_updated', 'updated_at']] },
  bandeja_pupacion: { keyPath: 'id', indexes: [['by_ingreso', 'ingreso_id'], ['by_jaula', 'jaula_id'],
                                                ['by_updated', 'updated_at']] },
  jaula_evento:     { keyPath: 'id', indexes: [['by_jaula', 'jaula_id'], ['by_updated', 'updated_at']] },
  movimiento:       { keyPath: 'id', indexes: [['by_objeto', 'objeto_id'], ['by_updated', 'updated_at']] },
  outbox:           { keyPath: 'id', indexes: [['by_status', 'status'], ['by_seq', 'seq'],
                                                ['by_status_seq', ['status', 'seq']], ['by_row', 'row_id'],
                                                ['by_user', 'created_by']] },
  blobs:            { keyPath: 'id', indexes: [['by_status', 'status']] },
  conflicts:        { keyPath: 'id', indexes: [['by_resolved', '_resuelto'], ['by_created', 'created_at']] },
  meta:             { keyPath: 'key', indexes: [] }
};

/**
 * Append-only list of upgrade steps. Index N implements version N+1.
 * Each step is (db, tx) => void | Promise<void>.
 */
export const MIGRATIONS = [
  // ── v1: the protocols of October 2026 (frozen; see V1_STORES) ───────────
  (db) => {
    for (const [name, def] of Object.entries(V1_STORES)) createStore(db, name, def);
  }
];

export const DB_VERSION = MIGRATIONS.length;

/** Derived 0/1 mirrors for fields IndexedDB cannot index directly. */
export function withIndexMirrors(store, row) {
  if (store === 'conflicts') {
    return { ...row, _resuelto: row.resuelto_at ? 1 : 0 };
  }
  return row;
}
