/**
 * dataClient.js — the single data access layer for the TryEnto production app.
 * Every screen calls through here; no screen touches storage directly.
 *
 * This file used to be an in-memory mock. It is now a thin barrel over
 * `src/data/*`, which is offline-first: reads are served from IndexedDB, writes
 * apply locally and queue for Supabase, and a background loop reconciles the
 * two. The PUBLIC SURFACE IS UNCHANGED — same 28 names, same
 * `{ok,data}` / `{ok,error:{code,message}}` envelope — so the UI template did
 * not have to be rewritten around the new backend.
 *
 * New names are additive: sync status, the conflict inbox, photo capture, and
 * `logAyunoFin` (closing a fast, which the mock had no way to express at all).
 */
import { openDb, requestPersistentStorage } from './src/data/idb/open.js';
import { putLocal, allRows } from './src/data/store.js';
import { loadCachedSession } from './src/data/session.js';
import { uuid } from './src/data/ids.js';
import { nowIso } from './src/data/time.js';
import { isBackendConfigured } from './src/data/config.js';
import { startSync, syncNow, nudge } from './src/data/sync/loop.js';
import { refreshStatus, getSyncStatus, onChange, statusLabel } from './src/data/status.js';
import * as reads from './src/data/read.js';
import * as writes from './src/data/write.js';
import { listConflicts as _listConflicts, resolveConflict as _resolveConflict } from './src/data/conflicts.js';
import { capturePhoto, attachPhoto, localPhotoUrl } from './src/data/photo.js';
import { signInWithGoogle, signOut, fetchSession } from './src/data/supabase.js';
import { openDb as _openDb } from './src/data/idb/open.js';

/* ── catalogues ─────────────────────────────────────────────────────────────
 * The template reads these synchronously off the module (dc.html:1283-1284,
 * 1375, 1425), so they must stay plain arrays. They are populated from the
 * `catalogo` table and MUTATED IN PLACE on every refresh — a static export with
 * dynamic contents. Adding a fifth cage is then a data row, not a redeploy.
 */
export const NOMBRES_INSECTARIO = [];
export const TIPO_INICIADOR = [];
export const TIPO_ALIMENTO = [];
export const QC_COLOR_DORADO = [];
export const EVENTO_TIPOS = ['alimentacion', 'ayuno', 'revision', 'separacion'];

const CATALOGOS = {
  nombre_insectario: NOMBRES_INSECTARIO,
  tipo_iniciador: TIPO_INICIADOR,
  tipo_alimento: TIPO_ALIMENTO,
  qc_color_dorado: QC_COLOR_DORADO
};

/** Values the operation already used, seeded only when the table is empty so a
 *  brand-new or fully-offline install is still usable. The server copy wins as
 *  soon as one arrives. */
const CATALOGO_DEFAULTS = {
  nombre_insectario: ['ICA', 'ICB', 'ICC', 'JN3A'],
  tipo_iniciador: ['Bagazo', 'Afrecho', 'Yogurt', 'Otro'],
  tipo_alimento: ['Bagazo', 'Yogurt', 'Afrecho', 'Mezcla'],
  qc_color_dorado: ['Blando', 'Poco Crujiente', 'Muy Crujiente', 'Tostado'],
  // The registered roster. Mirrors 0003_seed.sql so the name screen is usable
  // before the first sync, and on a device with no backend at all.
  operario: ['Maria', 'Ricardo']
};

async function seedIfEmpty(db) {
  const existing = await allRows(db, 'catalogo');
  if (!existing.length) {
    const rows = [];
    for (const [tipo, valores] of Object.entries(CATALOGO_DEFAULTS)) {
      valores.forEach((valor, orden) => rows.push({
        id: uuid(), tipo, valor, orden, activo: true,
        created_at: nowIso(), updated_at: nowIso(), _seeded: true
      }));
    }
    await putLocal(db, 'catalogo', rows);
  }

  // Nothing to seed for people: `registrado_por` is plain text, so names come
  // from whatever has been typed or from existing records. Nothing can be out
  // of step and no write can be rejected for referencing an unknown person.
}

async function refreshCatalogos() {
  for (const [tipo, target] of Object.entries(CATALOGOS)) {
    const res = await reads.listCatalogo(tipo);
    if (!res.ok) continue;
    const next = res.data.length ? res.data : (CATALOGO_DEFAULTS[tipo] || []);
    // In place: the template holds a reference to this exact array.
    target.length = 0;
    target.push(...next);
  }
}

/* ── initialisation ─────────────────────────────────────────────────────── */

let _ready = null;

async function init() {
  const db = await openDb();
  await loadCachedSession(db);
  await seedIfEmpty(db);
  await refreshCatalogos();
  requestPersistentStorage().catch(() => {});
  await refreshStatus();
  if (isBackendConfigured()) startSync().catch(e => console.warn('[tryento] sync no inició', e));
  return db;
}

export function ready() {
  if (!_ready) _ready = init();
  return _ready;
}

/** Wrap a public function so callers never race initialisation, and so every
 *  write nudges the sync loop without ever waiting on it. */
function guard(fn, { isWrite = false } = {}) {
  return async (...args) => {
    await ready();
    const res = await fn(...args);
    if (isWrite) { await refreshStatus(); nudge(); }
    return res;
  };
}

/* ── reads (unchanged signatures) ───────────────────────────────────────── */

export const listInsectarios = guard(reads.listInsectarios);
export const getInsectarioDetail = guard(reads.getInsectarioDetail);
export const listRecolecciones = guard(reads.listRecolecciones);
export const listBandejas = guard(reads.listBandejas);
export const getBandejaDetail = guard(reads.getBandejaDetail);
export const listSeparacionesDisponibles = guard(reads.listSeparacionesDisponibles);
export const listLotes = guard(reads.listLotes);
export const getLoteDetail = guard(reads.getLoteDetail);
export const listOperators = guard(reads.listOperators);

/* ── writes (unchanged signatures) ──────────────────────────────────────── */

export const createInsectario = guard(writes.createInsectario, { isWrite: true });
export const marcarAtractante = guard(writes.marcarAtractante, { isWrite: true });
export const marcarCierre = guard(writes.marcarCierre, { isWrite: true });
export const createRecoleccion = guard(writes.createRecoleccion, { isWrite: true });
export const createBandeja = guard(writes.createBandeja, { isWrite: true });
export const logAlimentacion = guard(writes.logAlimentacion, { isWrite: true });
export const logAlimentacionGrupal = guard(writes.logAlimentacionGrupal, { isWrite: true });
export const logAyuno = guard(writes.logAyuno, { isWrite: true });
export const logRevision = guard(writes.logRevision, { isWrite: true });
export const logSeparacion = guard(writes.logSeparacion, { isWrite: true });
export const createLote = guard(writes.createLote, { isWrite: true });
export const updateLoteQC = guard(writes.updateLoteQC, { isWrite: true });
export const marcarEmpacado = guard(writes.marcarEmpacado, { isWrite: true });
export const marcarDespachado = guard(writes.marcarDespachado, { isWrite: true });

/* ── additions ──────────────────────────────────────────────────────────── */

/** Close a fast. Without this `merma_pct` can never be computed, because a
 *  fast is two visits and the mock only ever recorded the first. */
export const logAyunoFin = guard(writes.logAyunoFin, { isWrite: true });
export const listAyunosAbiertos = guard(reads.listAyunosAbiertos);
export const rechazarLote = guard(writes.rechazarLote, { isWrite: true });
/** Remember a typed name so it comes back as a chip. Local convenience only. */
export const rememberOperator = guard(writes.rememberOperator);

export { getSyncStatus, onChange, statusLabel };
export const sync = () => syncNow({ force: true });

export const listConflicts = guard(async opts => {
  const db = await openDb();
  return { ok: true, data: await _listConflicts(db, opts) };
});

export const resolveConflict = guard(async (id, action) => {
  const db = await openDb();
  const res = await _resolveConflict(db, id, action);
  await refreshStatus();
  nudge();
  return res;
}, { isWrite: true });

export { capturePhoto, localPhotoUrl };
export const attachPhotoToRow = guard(async (blobId, table, rowId) => {
  const db = await openDb();
  return { ok: true, data: { key: await attachPhoto(db, blobId, table, rowId) } };
});

export const signIn = () => signInWithGoogle();
export const signOutUser = async () => { await signOut(); await refreshStatus(); };
export const getSession = fetchSession;

/* ── window handoff ─────────────────────────────────────────────────────────
 * `loadApi()` (dc.html:865-871) polls for this global and only falls back to a
 * dynamic import after a 2000 ms timeout. Nothing ever assigned it, so EVERY
 * launch paid the full two seconds before showing any data. Assigning it here
 * removes that entirely.
 */
const api = {
  NOMBRES_INSECTARIO, TIPO_INICIADOR, TIPO_ALIMENTO, QC_COLOR_DORADO, EVENTO_TIPOS,
  listInsectarios, getInsectarioDetail, listRecolecciones, listBandejas,
  getBandejaDetail, listSeparacionesDisponibles, listLotes, getLoteDetail, listOperators,
  createInsectario, marcarAtractante, marcarCierre, createRecoleccion, createBandeja,
  logAlimentacion, logAlimentacionGrupal, logAyuno, logRevision, logSeparacion,
  createLote, updateLoteQC, marcarEmpacado, marcarDespachado,
  logAyunoFin, listAyunosAbiertos, rechazarLote, rememberOperator,
  getSyncStatus, onChange, statusLabel, sync,
  listConflicts, resolveConflict,
  capturePhoto, localPhotoUrl, attachPhotoToRow,
  signIn, signOutUser, getSession, ready
};

if (typeof window !== 'undefined') {
  window.__BSF_DATA_CLIENT__ = api;
  ready().catch(e => console.error('[tryento] fallo al inicializar', e));
}

export default api;
