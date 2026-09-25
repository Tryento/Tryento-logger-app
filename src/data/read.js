/**
 * read.js — every read the UI performs, served from IndexedDB.
 *
 * CONTRACT: the shapes returned here must match what the prototype's mock
 * returned, field for field, because the template destructures them at ~40
 * sites. Where the backend renamed something (lote -> cochada, id -> codigo)
 * the rename is absorbed HERE, so the UI keeps its vocabulary.
 *
 * Everything is local, so these resolve in single-digit milliseconds with no
 * network and no artificial latency.
 */
import { ok, fail, CODES, deepCopy, str } from './envelope.js';
import { openDb } from './idb/open.js';
import { metaGet } from './idb/tx.js';
import { allRows, rowById, rowsByIndex } from './store.js';
import { allCache, getCache } from './cache.js';
import { daysBetween } from './time.js';

const round1 = v => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

/* ── decorations: the computed values, all null-safe ─────────────────────── */

export function poblacionEstimada(biomasaKg) {
  return biomasaKg === null || biomasaKg === undefined ? null : Math.round(biomasaKg * 50000);
}

/**
 * Deviation in days, ABSENT until the real date exists.
 *
 * This is the one-line fix for the "-20,676 days" values in the live sheet:
 * AppSheet read a blank date as the epoch and produced a ~56-year deviation for
 * every colony still open. No date, no number.
 */
export function desviacionDias(real, proyectada) {
  if (!real || !proyectada) return null;
  return daysBetween(proyectada, real);
}

export function rendimientoPct(inicial, final) {
  if (!inicial || inicial <= 0 || final === null || final === undefined) return null;
  return round1((final / inicial) * 100);
}

export function mermaPct(inicial, final) {
  if (!inicial || inicial <= 0 || final === null || final === undefined) return null;
  return round1(((inicial - final) / inicial) * 100);
}

function decorateInsectario(row) {
  return Object.assign(deepCopy(row), {
    estado: row.cierre_real ? 'cerrado' : 'activo',
    poblacion_estimada: poblacionEstimada(row.biomasa_kg),
    desviacion_ovipositores_dias: desviacionDias(row.fecha_ovipositores, row.proyeccion_ovipositores),
    desviacion_cierre_dias: desviacionDias(row.cierre_real, row.proyeccion_cierre)
  });
}

/** Cochada state, derived the same way the Postgres generated column does so
 *  an offline device and the server never disagree. */
export function cochadaEstado(row) {
  if (row.rechazado_at) return 'rechazado';
  if (row.despachado_at || row.despachado) return 'despachado';
  if (row.empacado_at || row.empacado) return 'empacado';
  if (row.qc_aprobado !== null && row.qc_aprobado !== undefined) return 'en_qc';
  return 'secando';
}

function decorateCochada(row, nBandejas = 0) {
  return Object.assign(deepCopy(row), {
    estado: cochadaEstado(row),
    rendimiento_pct: rendimientoPct(row.peso_inicial_kg, row.peso_final_kg),
    n_bandejas: nBandejas,
    // UI vocabulary: the template still says "lote" and "despachado".
    despachado: row.despachado_at || null,
    empacado: Boolean(row.empacado_at)
  });
}

function decorateAyuno(row) {
  return Object.assign(deepCopy(row), {
    merma_pct: mermaPct(row.peso_inicial_kg, row.peso_final_kg),
    abierto: row.peso_final_kg === null || row.peso_final_kg === undefined
  });
}

/* ── joins ──────────────────────────────────────────────────────────────── */

async function buildIndex(db) {
  const [insectarios, recolecciones, links, cochadas] = await Promise.all([
    allRows(db, 'insectario'),
    allRows(db, 'recoleccion'),
    allRows(db, 'cochada_separacion'),
    allRows(db, 'cochada')
  ]);
  return {
    insectarioById: new Map(insectarios.map(r => [r.id, r])),
    recoleccionById: new Map(recolecciones.map(r => [r.id, r])),
    cochadaBySeparacion: new Map(links.map(l => [l.separacion_id, l.cochada_id])),
    cochadaById: new Map(cochadas.map(c => [c.id, c]))
  };
}

function joinBandeja(row, idx, cache) {
  const rec = idx.recoleccionById.get(row.recoleccion_id) || null;
  const ins = rec ? idx.insectarioById.get(rec.insectario_id) || null : null;
  const c = cache || null;
  return Object.assign(deepCopy(row), {
    estado: c?.estado ?? row.estado ?? 'en_crecimiento',
    recolecta: rec ? rec.recolecta : null,
    insectario_id: ins ? ins.id : null,
    // The UI prints these; `codigo` is the human-facing label now that the PK
    // is an opaque UUID.
    insectario_codigo: ins ? ins.codigo : null,
    insectario_nombre: ins ? ins.nombre_insectario : null,
    separacion: c?.separacion_id ? { id: c.separacion_id, larva_limpia_g: c.larva_limpia_g } : null,
    lote_id: c?.cochada_id ?? null,
    tiene_ayuno_abierto: Boolean(c?.tiene_ayuno_abierto),
    ayuno_abierto_id: c?.ayuno_abierto_id ?? null,
    kg_alimento_total: c?.kg_alimento_total ?? 0,
    n_alimentaciones: c?.n_alimentaciones ?? 0,
    last_evento: c?.last_evento_tipo ? { tipo: c.last_evento_tipo, fecha: c.last_evento_fecha } : null
  });
}

const sortKey = b => String(b.last_evento?.fecha || b.fecha || '');

/* ── public reads ───────────────────────────────────────────────────────── */

export async function listInsectarios(filters = {}) {
  const db = await openDb();
  let rows = (await allRows(db, 'insectario')).map(decorateInsectario);
  if (filters.estado) rows = rows.filter(r => r.estado === filters.estado);
  rows.sort((a, b) => String(b.fecha_inicio || '').localeCompare(String(a.fecha_inicio || '')));
  return ok(rows);
}

export async function getInsectarioDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'insectario', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Insectario no encontrado.');
  const recolecciones = (await rowsByIndex(db, 'recoleccion', 'by_insectario', id))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok({ insectario: decorateInsectario(row), recolecciones: deepCopy(recolecciones) });
}

export async function listRecolecciones(filters = {}) {
  const db = await openDb();
  const idx = await buildIndex(db);
  let rows = await allRows(db, 'recoleccion');
  if (filters.insectario_id) rows = rows.filter(r => r.insectario_id === filters.insectario_id);
  rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok(rows.map(r => {
    const ins = idx.insectarioById.get(r.insectario_id);
    return Object.assign(deepCopy(r), {
      insectario_nombre: ins ? ins.nombre_insectario : null,
      insectario_codigo: ins ? ins.codigo : null
    });
  }));
}

export async function listBandejas(filters = {}) {
  const db = await openDb();
  const [idx, cache] = await Promise.all([buildIndex(db), allCache(db)]);
  const f = filters || {};

  let rows = (await allRows(db, 'bandeja'))
    // Administratively closed trays are excluded everywhere. Without this the
    // home screen reads "347 bandejas activas" after migration, because nine
    // months of trays have no recorded harvest.
    .filter(b => !b.cerrada_admin_at)
    .map(b => joinBandeja(b, idx, cache.get(b.id)));

  if (f.q) {
    const q = String(f.q).toLowerCase();
    rows = rows.filter(b =>
      String(b.id_bandeja || '').toLowerCase().includes(q) ||
      String(b.insectario_codigo || '').toLowerCase().includes(q) ||
      String(b.recolecta || '').includes(q));
  }
  if (f.estado) rows = rows.filter(b => b.estado === f.estado);
  if (f.insectario_id) rows = rows.filter(b => b.insectario_id === f.insectario_id);
  if (f.from) rows = rows.filter(b => String(b.fecha) >= f.from);
  if (f.to) rows = rows.filter(b => String(b.fecha) <= f.to);

  rows.sort((a, b) => sortKey(b).localeCompare(sortKey(a)));
  if (f.limit) rows = rows.slice(0, f.limit);
  return ok(rows);
}

export async function getBandejaDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'bandeja', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Bandeja no encontrada.');

  const [idx, cache] = await Promise.all([buildIndex(db), getCache(db, id)]);
  const bandeja = joinBandeja(row, idx, cache);

  const [alims, ayunos, revs, seps] = await Promise.all([
    rowsByIndex(db, 'alimentacion', 'by_bandeja', id),
    rowsByIndex(db, 'ayuno', 'by_bandeja', id),
    rowsByIndex(db, 'revision', 'by_bandeja', id),
    rowsByIndex(db, 'separacion', 'by_bandeja', id)
  ]);

  const eventos = [
    ...alims.map(x => ({ tipo: 'alimentacion', ...deepCopy(x) })),
    ...ayunos.map(x => ({ tipo: 'ayuno', ...decorateAyuno(x) })),
    ...revs.map(x => ({ tipo: 'revision', ...deepCopy(x) })),
    ...seps.map(x => ({ tipo: 'separacion', ...deepCopy(x) }))
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

  let lote = null;
  if (bandeja.lote_id) {
    const c = idx.cochadaById.get(bandeja.lote_id);
    if (c) lote = decorateCochada(c);
  }

  return ok({ bandeja, lote, eventos });
}

export async function listSeparacionesDisponibles() {
  const db = await openDb();
  const [seps, links, trays] = await Promise.all([
    allRows(db, 'separacion'),
    allRows(db, 'cochada_separacion'),
    allRows(db, 'bandeja')
  ]);
  const pooled = new Set(links.map(l => l.separacion_id));
  const trayById = new Map(trays.map(t => [t.id, t]));

  const rows = seps
    .filter(s => !pooled.has(s.id))
    .map(s => Object.assign(deepCopy(s), {
      bandeja_label: trayById.get(s.bandeja_id)?.id_bandeja || s.bandeja_id
    }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  return ok(rows);
}

export async function listLotes(filters = {}) {
  const db = await openDb();
  const [cochadas, links] = await Promise.all([
    allRows(db, 'cochada'),
    allRows(db, 'cochada_separacion')
  ]);
  const counts = new Map();
  for (const l of links) counts.set(l.cochada_id, (counts.get(l.cochada_id) || 0) + 1);

  let rows = cochadas.map(c => decorateCochada(c, counts.get(c.id) || 0));
  if (filters.estado) rows = rows.filter(r => r.estado === filters.estado);
  rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok(rows);
}

export async function getLoteDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');

  const links = await rowsByIndex(db, 'cochada_separacion', 'by_cochada', id);
  const [seps, trays] = await Promise.all([allRows(db, 'separacion'), allRows(db, 'bandeja')]);
  const sepById = new Map(seps.map(s => [s.id, s]));
  const trayById = new Map(trays.map(t => [t.id, t]));

  const separaciones = links.map(l => {
    const sep = sepById.get(l.separacion_id) || null;
    const tray = sep ? trayById.get(sep.bandeja_id) : null;
    return {
      separacion_id: l.separacion_id,
      larva_limpia_g: sep ? sep.larva_limpia_g : null,
      bandeja_label: tray ? tray.id_bandeja : '—',
      fecha: sep ? sep.fecha : null
    };
  });

  return ok({ lote: decorateCochada(row, separaciones.length), separaciones });
}

/**
 * Names that have been used before, most recent first.
 *
 * There is no operator table. `registrado_por` is just the name the person
 * typed, which means nothing has to be seeded and no write can ever be rejected
 * because a device has not synced its roster yet — that foreign key was the one
 * thing capable of making a whole day's capture fail.
 *
 * The cost of free text is near-duplicates ("Maria" / "maria"). Two things keep
 * it in check: names already used come back as one-tap chips so almost nobody
 * types, and `app.v_nombres_registrados` lists the variants so a month of
 * reporting can be cleaned up with one UPDATE.
 *
 * Merged from two places — the names remembered locally (so one typed seconds
 * ago appears before any record exists) and the names on records already here
 * (so a freshly synced device shows everyone).
 */
const NAME_STORES = ['alimentacion', 'ayuno', 'revision', 'separacion',
                     'bandeja', 'insectario', 'recoleccion', 'cochada'];

export async function listOperators() {
  const db = await openDb();

  // Names actually picked on this device, in the order they were picked.
  //
  // The stored list is maintained most-recent-first, and that ORDER is the
  // source of truth rather than the timestamps on it: two names chosen in the
  // same millisecond carry identical timestamps, and sorting by them would
  // silently fall back to alphabetical.
  const picked = new Map();   // lowercased -> { nombre, rank }
  ((await metaGet(db, 'nombres_usados', [])) || []).forEach((r, i) => {
    const n = str(r?.nombre);
    if (n && !picked.has(n.toLowerCase())) picked.set(n.toLowerCase(), { nombre: n, rank: i });
  });

  // The shared, registered roster — seeded in 0003_seed.sql and added to
  // whenever anyone types a new name. Syncs to every device.
  const registered = new Map();
  for (const c of await allRows(db, 'catalogo')) {
    if (c.tipo !== 'operario' || c.activo === false) continue;
    const n = str(c.valor);
    if (!n || picked.has(n.toLowerCase())) continue;
    registered.set(n.toLowerCase(), { nombre: n, orden: c.orden ?? 0 });
  }

  // Names seen only on records — e.g. someone who registered before the shared
  // list existed, or data arriving from the migration.
  const derived = new Map();
  for (const store of NAME_STORES) {
    for (const row of await allRows(db, store)) {
      const n = str(row.registrado_por);
      if (!n) continue;
      const k = n.toLowerCase();
      if (picked.has(k) || registered.has(k)) continue;
      const last = String(row.fecha || row.created_at || '');
      const prev = derived.get(k);
      if (!prev || last > prev.last) derived.set(k, { nombre: n, last });
    }
  }

  // Whoever used this phone most recently comes first — they are the most
  // likely next tap — then the rest of the registered roster, then stragglers.
  return ok([
    ...[...picked.values()].sort((a, b) => a.rank - b.rank),
    ...[...registered.values()].sort((a, b) =>
      a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es')),
    ...[...derived.values()].sort((a, b) =>
      b.last.localeCompare(a.last) || a.nombre.localeCompare(b.nombre, 'es'))
  ].map(r => r.nombre));
}

/** Open fasts, for the "cerrar ayuno" action. The prototype had no way to reach
 *  these at all, which is why merma_pct was permanently null. */
export async function listAyunosAbiertos() {
  const db = await openDb();
  const [ayunos, trays] = await Promise.all([allRows(db, 'ayuno'), allRows(db, 'bandeja')]);
  const trayById = new Map(trays.map(t => [t.id, t]));
  const rows = ayunos
    .filter(a => a.peso_final_kg === null || a.peso_final_kg === undefined)
    .map(a => Object.assign(decorateAyuno(a), {
      bandeja_label: trayById.get(a.bandeja_id)?.id_bandeja || a.bandeja_id
    }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  return ok(rows);
}

/** Catalogue values, replacing the frozen module-level arrays. */
export async function listCatalogo(tipo) {
  const db = await openDb();
  const rows = (await rowsByIndex(db, 'catalogo', 'by_tipo', tipo))
    .filter(c => c.activo !== false)
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.valor).localeCompare(String(b.valor)));
  return ok(rows.map(c => c.valor));
}
