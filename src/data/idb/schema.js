/**
 * schema.js — IndexedDB stores, indexes and versioned migrations.
 *
 * MIGRATIONS ARE APPEND-ONLY. To change the local schema, add a function to the
 * end of MIGRATIONS and bump nothing else — DB_VERSION is derived from the
 * array length. A device in the field may be carrying hundreds of unsynced
 * outbox rows when it picks up a new version of the app, and losing them means
 * losing a day of somebody's work, so no migration may ever delete or recreate
 * the `outbox`, `blobs` or `conflicts` stores.
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
  'catalogo',
  'insectario',
  'recoleccion',
  'bandeja',
  'alimentacion',
  'ayuno',
  'revision',
  'separacion',
  'cochada',
  'cochada_separacion'
];

/** Stores that are purely local machinery and never pulled from the server. */
export const LOCAL_STORES = ['bandeja_cache', 'outbox', 'blobs', 'conflicts', 'meta'];

/** Event stores keyed to a tray, used by the timeline and the cache rebuild. */
export const EVENT_STORES = ['alimentacion', 'ayuno', 'revision', 'separacion'];

const STORE_DEFS = {
  catalogo:      { keyPath: 'id', indexes: [['by_tipo', 'tipo'], ['by_updated', 'updated_at']] },
  insectario:    { keyPath: 'id', indexes: [['by_updated', 'updated_at'], ['by_estado', 'estado']] },
  recoleccion:   { keyPath: 'id', indexes: [['by_insectario', 'insectario_id'], ['by_updated', 'updated_at']] },
  bandeja:       { keyPath: 'id', indexes: [
                     ['by_recoleccion', 'recoleccion_id'],
                     ['by_estado', 'estado'],
                     ['by_updated', 'updated_at']] },
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
  cochada:       { keyPath: 'id', indexes: [['by_estado', 'estado'], ['by_updated', 'updated_at']] },
  cochada_separacion: {
                   keyPath: ['cochada_id', 'separacion_id'],
                   indexes: [
                     ['by_cochada', 'cochada_id'],
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

/**
 * Append-only list of upgrade steps. Index N implements version N+1.
 */
export const MIGRATIONS = [
  // ── v1: initial schema ────────────────────────────────────────────────────
  (db) => {
    for (const name of [...SYNCED_STORES, ...LOCAL_STORES]) {
      const def = STORE_DEFS[name];
      const store = db.createObjectStore(name, {
        keyPath: def.keyPath,
        autoIncrement: false
      });
      for (const [idxName, keyPath] of def.indexes) {
        store.createIndex(idxName, keyPath, { unique: false });
      }
    }
  }
];

export const DB_VERSION = MIGRATIONS.length;

/** Derived 0/1 mirrors for fields IndexedDB cannot index directly. */
export function withIndexMirrors(store, row) {
  if (store === 'ayuno') {
    return { ...row, _abierto: row.peso_final_kg === null || row.peso_final_kg === undefined ? 1 : 0 };
  }
  if (store === 'conflicts') {
    return { ...row, _resuelto: row.resuelto_at ? 1 : 0 };
  }
  return row;
}
