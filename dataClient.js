/**
 * dataClient.js — the single data access layer for the TryEnto production app.
 * Every screen calls through here; no screen touches storage directly.
 *
 * A thin barrel over `src/data/*`, which is offline-first: reads are served
 * from IndexedDB, writes apply locally and queue for Supabase, and a background
 * loop reconciles the two. Every function answers with the same envelope:
 * `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
 *
 * The protocols of October 2026 (docs/protocolo.html) replaced every domain
 * function; the sync machinery under them did not change.
 */
import { openDb, requestPersistentStorage, deleteLegacyDbs } from './src/data/idb/open.js';
import { putLocal, allRows } from './src/data/store.js';
import { loadCachedSession } from './src/data/session.js';
import { uuidFromString } from './src/data/ids.js';
import { nowIso, farmDay, ddmm, toNaiveLocal, addDays } from './src/data/time.js';
import { isBackendConfigured } from './src/data/config.js';
import { startSync, syncNow, nudge } from './src/data/sync/loop.js';
import { refreshStatus, getSyncStatus, onChange, statusLabel } from './src/data/status.js';
import * as reads from './src/data/read.js';
import * as writes from './src/data/write.js';
import { listConflicts as _listConflicts, resolveConflict as _resolveConflict } from './src/data/conflicts.js';
import { capturePhoto, localPhotoUrl, photoUrlFor } from './src/data/photo.js';
import { signInWithGoogle, signOut, fetchSession } from './src/data/supabase.js';
import { invalidarSnapshot } from './src/data/snapshot.js';
import { repartoSeparacion } from './src/data/protocolo.js';
import { kgTxt, diaTxt, fechaHoraTxt, cuandoTxt } from './src/data/formato.js';

/* ── catalogues ─────────────────────────────────────────────────────────────
 * The template reads this one synchronously off the module, so it stays a
 * plain array, populated from the `catalogo` table and MUTATED IN PLACE on
 * every refresh. Adding a material is then a data row, not a redeploy.
 */
export const MATERIALES_ALIMENTO = [];

const CATALOGOS = { material_alimento: MATERIALES_ALIMENTO };

/** Values seeded only when the table is empty so a brand-new or fully-offline
 *  install is still usable. The server copy wins as soon as one arrives. */
const CATALOGO_DEFAULTS = {
  // Mirrors 0010_ciclo_nuevo.sql.
  material_alimento: ['Bagazo de cerveza (BSG)', 'Desecho de panadería', 'Desecho de fruta', 'Otro'],
  // The registered roster, so the name screen is usable before the first sync.
  operario: ['Maria', 'Ricardo']
};

async function seedIfEmpty(db) {
  const existing = await allRows(db, 'catalogo');
  if (existing.length) return;
  const rows = [];
  for (const [tipo, valores] of Object.entries(CATALOGO_DEFAULTS)) {
    // `_seeded` marks these as local stand-ins: the server's copy of the same
    // value replaces them when it arrives (store.js applyServerRows).
    valores.forEach((valor, orden) => rows.push({
      id: uuidFromString(`seed:${tipo}:${String(valor).toLowerCase()}`),
      tipo, valor, orden: orden + 1, activo: true,
      created_at: nowIso(), updated_at: nowIso(), _seeded: true
    }));
  }
  await putLocal(db, 'catalogo', rows);
  invalidarSnapshot();
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
const _initErrors = [];

/** Problems hit during start-up, surfaced on the sync screen. */
export const initErrors = () => _initErrors.slice();

/**
 * Boot the data layer.
 *
 * Every step is individually guarded so that refreshStatus() ALWAYS runs. If
 * start-up threw halfway — which is what a stale local database once did — the
 * status was never published, and the sync screen rendered "not loaded yet" as
 * "no hay servidor configurado": a backend problem that was not one.
 */
async function init() {
  const db = await openDb();

  const step = async (name, fn) => {
    try { await fn(); } catch (e) {
      console.error(`[tryento] fallo al iniciar (${name})`, e);
      _initErrors.push(`${name}: ${e.message}`);
    }
  };

  // The database of the protocols before October 2026: nothing in it can sync
  // any more (0010 rebuilt the tables). Never awaited past another tab.
  deleteLegacyDbs().catch(() => {});
  await step('sesión', () => loadCachedSession(db));
  await step('catálogos', () => seedIfEmpty(db));
  await step('listas', () => refreshCatalogos());
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

/* ── reads ──────────────────────────────────────────────────────────────── */

export const getInicio = guard(reads.getInicio);
export const getProtocolo = guard(reads.getProtocolo);
export const listOperators = guard(reads.listOperators);
export const listRacks = guard(reads.listRacks);
export const listContenedores = guard(reads.listContenedores);
export const listJaulas = guard(reads.listJaulas);
export const getJaula = guard(reads.getJaula);
export const listIncubadoras = guard(reads.listIncubadoras);
export const getIncubadora = guard(reads.getIncubadora);
export const listCajas = guard(reads.listCajas);
export const getCaja = guard(reads.getCaja);
export const getHorno = guard(reads.getHorno);
export const getCochada = guard(reads.getCochada);
export const getAlimento = guard(reads.getAlimento);
export const getEnsilado = guard(reads.getEnsilado);
export const getRevisar = guard(reads.getRevisar);
export const getRegistro = guard(reads.getRegistro);

/* What each form starts from. */
export const getFormRecolecta = guard(reads.getFormRecolecta);
export const previewRecolecta = guard(reads.previewRecolecta);
export const getFormChequeo = guard(reads.getFormChequeo);
export const getFormDistribucion = guard(reads.getFormDistribucion);
export const getFormCargas = guard(reads.getFormCargas);
export const getFormSeparacion = guard(reads.getFormSeparacion);
export const getFormCochada = guard(reads.getFormCochada);
export const getFormIngreso = guard(reads.getFormIngreso);
export const previewIngreso = guard(reads.previewIngreso);
export const getFormEnsilado = guard(reads.getFormEnsilado);

/* ── writes ─────────────────────────────────────────────────────────────── */

const W = fn => guard(fn, { isWrite: true });

/** Remember a typed name so it comes back as a chip, on every phone. */
export const rememberOperator = W(writes.rememberOperator);
/**
 * Who is registering. The screen keeps the chosen name across reloads; it MUST
 * hand it back here on start, or the one-tap actions record nobody.
 */
export const setOperator = guard(async nombre => {
  const n = await writes.setCurrentOperator(nombre);
  return n ? { ok: true, data: { nombre: n } } : { ok: false, error: { code: 'validation_error', message: 'Nombre vacío.' } };
});

export const registrarRack = W(writes.registrarRack);
export const registrarContenedor = W(writes.registrarContenedor);
export const registrarJaula = W(writes.registrarJaula);
export const registrarRecolecta = W(writes.registrarRecolecta);
export const registrarChequeos = W(writes.registrarChequeos);
export const distribuir = W(writes.distribuir);
export const registrarCargas = W(writes.registrarCargas);
export const registrarSeparaciones = W(writes.registrarSeparaciones);
export const crearCochada = W(writes.crearCochada);
export const registrarLectura = W(writes.registrarLectura);
export const registrarIngreso = W(writes.registrarIngreso);
export const registrarEventoJaula = W(writes.registrarEventoJaula);
export const registrarMovimiento = W(writes.registrarMovimiento);
export const cerrarObjeto = W(writes.cerrarObjeto);
export const registrarRecepcion = W(writes.registrarRecepcion);
export const crearEnsilado = W(writes.crearEnsilado);
export const abrirEnsilado = W(writes.abrirEnsilado);
export const editarRegistro = W(writes.editarRegistro);
export const marcarRevisado = W(writes.marcarRevisado);

/* ── helpers for the screens ───────────────────────────────────────────── */

/** Farm-calendar helpers, so a preview never disagrees with what is saved. */
export const fechas = { farmDay, ddmm, toNaiveLocal, addDays };
/** The same arithmetic and wording the data layer uses. */
export const calc = { repartoSeparacion, kgTxt, diaTxt, fechaHoraTxt, cuandoTxt };

export { getSyncStatus, onChange, statusLabel };
export const sync = () => syncNow({ force: true });

export const listConflicts = guard(async opts => {
  const db = await openDb();
  return { ok: true, data: await _listConflicts(db, opts) };
});

export const resolveConflict = guard(async (id, action) => {
  const db = await openDb();
  const res = await _resolveConflict(db, id, action);
  // "Descartar" takes rows back on this phone: the picture of the lab changed.
  invalidarSnapshot();
  await refreshStatus();
  nudge();
  return res;
}, { isWrite: true });

export { capturePhoto, localPhotoUrl, photoUrlFor };

export const signIn = () => signInWithGoogle();
export const signOutUser = async () => { await signOut(); await refreshStatus(); };
export const getSession = fetchSession;

/* ── window handoff ─────────────────────────────────────────────────────────
 * The template's `loadApi()` polls for this global and only falls back to a
 * dynamic import after a timeout; assigning it here means no launch waits.
 */
const api = {
  MATERIALES_ALIMENTO,
  getInicio, getProtocolo, listOperators, listRacks, listContenedores, listJaulas, getJaula,
  listIncubadoras, getIncubadora, listCajas, getCaja, getHorno, getCochada, getAlimento,
  getEnsilado, getRevisar, getRegistro,
  getFormRecolecta, previewRecolecta, getFormChequeo, getFormDistribucion, getFormCargas,
  getFormSeparacion, getFormCochada, getFormIngreso, previewIngreso, getFormEnsilado,
  rememberOperator, setOperator,
  registrarRack, registrarContenedor, registrarJaula, registrarRecolecta, registrarChequeos,
  distribuir, registrarCargas, registrarSeparaciones, crearCochada, registrarLectura,
  registrarIngreso, registrarEventoJaula, registrarMovimiento, cerrarObjeto,
  registrarRecepcion, crearEnsilado, abrirEnsilado, editarRegistro, marcarRevisado,
  fechas, calc,
  getSyncStatus, onChange, statusLabel, sync, initErrors,
  listConflicts, resolveConflict,
  capturePhoto, localPhotoUrl, photoUrlFor,
  signIn, signOutUser, getSession, ready
};

if (typeof window !== 'undefined') {
  window.__BSF_DATA_CLIENT__ = api;
  ready().catch(e => console.error('[tryento] fallo al inicializar', e));
}

export default api;
