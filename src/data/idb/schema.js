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
  'lote',
  'lote_separacion'
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
  lote:       { keyPath: 'id', indexes: [['by_estado', 'estado'], ['by_updated', 'updated_at']] },
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
  },
  // ── v2: cochada -> lote ───────────────────────────────────────────────────
  //
  // The rename changed STORE NAMES. A device that had already opened the app
  // still carries `cochada` / `cochada_separacion`, and the new code opens
  // transactions on `lote` / `lote_separacion` — which throws NotFoundError,
  // aborts start-up, and leaves the app looking like it has no backend at all.
  //
  // Store names cannot be renamed in IndexedDB, so the new ones are created and
  // the old ones dropped. Losing the local copies is harmless: lotes re-arrive
  // on the next pull. Queued WRITES are not lost — the outbox is untouched, and
  // its rows are rewritten below so they target the new table names.
  (db, tx) => {
    for (const name of ['lote', 'lote_separacion']) {
      if (db.objectStoreNames.contains(name)) continue;
      const def = STORE_DEFS[name];
      const store = db.createObjectStore(name, { keyPath: def.keyPath, autoIncrement: false });
      for (const [idxName, keyPath] of def.indexes) {
        store.createIndex(idxName, keyPath, { unique: false });
      }
    }

    // Anything still queued must point at the new names or it will 404.
    if (tx && db.objectStoreNames.contains('outbox')) {
      const outbox = tx.objectStore('outbox');
      const req = outbox.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const it = cur.value;
        let dirty = false;
        if (it.table === 'cochada') { it.table = 'lote'; dirty = true; }
        if (it.table === 'cochada_separacion') { it.table = 'lote_separacion'; dirty = true; }
        if (typeof it.rpc === 'string' && it.rpc.includes('cochada')) {
          it.rpc = it.rpc.replace('crear_cochada', 'crear_lote')
                         .replace('rechazar_cochada', 'rechazar_lote')
                         .replace('actualizar_qc_cochada', 'actualizar_qc_lote');
          dirty = true;
        }
        if (it.payload && it.payload.p_cochada) {
          it.payload = { ...it.payload, p_lote: it.payload.p_cochada };
          delete it.payload.p_cochada;
          dirty = true;
        }
        if (dirty) cur.update(it);
        cur.continue();
      };
    }

    for (const name of ['cochada', 'cochada_separacion']) {
      if (db.objectStoreNames.contains(name)) db.deleteObjectStore(name);
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
