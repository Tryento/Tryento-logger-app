/**
 * read.js — every read the UI performs, served from IndexedDB.
 *
 * CONTRACT: the shapes returned here must match what the prototype's mock
 * returned, field for field, because the template destructures them at ~40
 * sites. Where the backend renamed something (lote -> lote, id -> codigo)
 * the rename is absorbed HERE, so the UI keeps its vocabulary.
 *
 * Everything is local, so these resolve in single-digit milliseconds with no
 * network and no artificial latency.
 */
import { ok, fail, CODES, deepCopy, str } from './envelope.js';
import { openDb } from './idb/open.js';
import { metaGet } from './idb/tx.js';
import { ayunoAbierto } from './idb/schema.js';
import { allRows, rowById, rowsByIndex } from './store.js';
import { allCache, getCache } from './cache.js';
import { daysBetween, farmDay, addDays } from './time.js';
import {
  mergeProtocolo, v2Vigente, diaCiclo, siguientePaso, pasoIncubadora, pasoLabel, cuandoLabel,
  ensilajeEstado, kgCargasProximas
} from './protocolo.js';

/** The protocol settings this device has, over the built-in defaults. */
export async function loadProtocolo(db) {
  return mergeProtocolo(await allRows(db, 'parametro'));
}

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

/** Lote state, derived the same way the Postgres generated column does so
 *  an offline device and the server never disagree. */
export function loteEstado(row) {
  if (row.rechazado_at) return 'rechazado';
  if (row.despachado_at || row.despachado) return 'despachado';
  if (row.empacado_at || row.empacado) return 'empacado';
  if (row.qc_aprobado !== null && row.qc_aprobado !== undefined) return 'en_qc';
  return 'secando';
}

function decorateLote(row, nBandejas = 0) {
  return Object.assign(deepCopy(row), {
    estado: loteEstado(row),
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
    abierto: ayunoAbierto(row)
  });
}

/* ── joins ──────────────────────────────────────────────────────────────── */

async function buildIndex(db) {
  const [insectarios, recolecciones, links, lotes, incubadoras, parametros] = await Promise.all([
    allRows(db, 'insectario'),
    allRows(db, 'recoleccion'),
    allRows(db, 'lote_separacion'),
    allRows(db, 'lote'),
    allRows(db, 'incubadora'),
    allRows(db, 'parametro')
  ]);
  return {
    insectarioById: new Map(insectarios.map(r => [r.id, r])),
    recoleccionById: new Map(recolecciones.map(r => [r.id, r])),
    loteBySeparacion: new Map(links.map(l => [l.separacion_id, l.lote_id])),
    loteById: new Map(lotes.map(c => [c.id, c])),
    incubadoraById: new Map(incubadoras.map(i => [i.id, i])),
    incubadoraByRecoleccion: new Map(incubadoras.map(i => [i.recoleccion_id, i])),
    cfg: mergeProtocolo(parametros),
    hoy: farmDay()
  };
}

/**
 * Where a v2 tray is in its cycle. Explicit records only — the loads it got,
 * whether it fasted, whether it was harvested — never inferred from blanks.
 */
function cicloBandeja(row, c, idx) {
  const protocolo = row.protocolo || 'v1';
  const inc = row.incubadora_id ? idx.incubadoraById.get(row.incubadora_id) || null : null;
  if (protocolo !== 'v2' || !inc) {
    return { protocolo, incubadora_codigo: inc ? inc.codigo : null, dia_ciclo: null,
             cargas_dadas: [], n_cargas: 0, siguiente_paso: null };
  }
  const estado = c?.estado ?? row.estado;
  const tray = {
    dia_ciclo: diaCiclo(inc.fecha_inicio, idx.hoy),
    cargas_dadas: c?.cargas_dadas || [],
    tiene_ayuno: Boolean(c?.tiene_ayuno) || estado === 'en_ayuno',
    cosechada: estado === 'cosechada'
  };
  const paso = siguientePaso(tray, idx.cfg);
  return {
    protocolo,
    incubadora_codigo: inc.codigo,
    dia_ciclo: tray.dia_ciclo,
    cargas_dadas: tray.cargas_dadas,
    n_cargas: tray.cargas_dadas.length,
    siguiente_paso: paso ? { ...paso, label: pasoLabel(paso), cuando: cuandoLabel(paso) } : null
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
    lote_id: c?.lote_id ?? null,
    tiene_ayuno_abierto: Boolean(c?.tiene_ayuno_abierto),
    ayuno_abierto_id: c?.ayuno_abierto_id ?? null,
    kg_alimento_total: c?.kg_alimento_total ?? 0,
    n_alimentaciones: c?.n_alimentaciones ?? 0,
    last_evento: c?.last_evento_tipo ? { tipo: c.last_evento_tipo, fecha: c.last_evento_fecha } : null,
    ...cicloBandeja(row, c, idx)
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
  const incs = new Map((await allRows(db, 'incubadora')).map(i => [i.recoleccion_id, i]));
  const recolecciones = (await rowsByIndex(db, 'recoleccion', 'by_insectario', id))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))
    .map(r => Object.assign(deepCopy(r), {
      protocolo: r.protocolo || 'v1',
      incubadora_id: incs.get(r.id)?.id ?? null,
      incubadora_codigo: incs.get(r.id)?.codigo ?? null
    }));
  return ok({ insectario: decorateInsectario(row), recolecciones });
}

export async function listRecolecciones(filters = {}) {
  const db = await openDb();
  const idx = await buildIndex(db);
  let rows = await allRows(db, 'recoleccion');
  if (filters.insectario_id) rows = rows.filter(r => r.insectario_id === filters.insectario_id);
  if (filters.protocolo) rows = rows.filter(r => (r.protocolo || 'v1') === filters.protocolo);
  rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok(rows.map(r => {
    const ins = idx.insectarioById.get(r.insectario_id);
    const inc = idx.incubadoraByRecoleccion.get(r.id);
    return Object.assign(deepCopy(r), {
      protocolo: r.protocolo || 'v1',
      insectario_nombre: ins ? ins.nombre_insectario : null,
      insectario_codigo: ins ? ins.codigo : null,
      incubadora_id: inc ? inc.id : null,
      incubadora_codigo: inc ? inc.codigo : null
    });
  }));
}

/* ── protocolo v2 ───────────────────────────────────────────────────────── */

/** Settings plus today's farm day, for the screens that show the plan. */
export async function getProtocolo() {
  const db = await openDb();
  const cfg = await loadProtocolo(db);
  const hoy = farmDay();
  return ok({ ...cfg, hoy, v2_vigente: v2Vigente(cfg, hoy) });
}

function decorateIncubadora(inc, idx, nBandejas = 0) {
  const rec = idx.recoleccionById.get(inc.recoleccion_id) || null;
  const ins = rec ? idx.insectarioById.get(rec.insectario_id) || null : null;
  const paso = pasoIncubadora(inc, idx.cfg, idx.hoy);
  return Object.assign(deepCopy(inc), {
    estado: inc.distribuida_at ? 'distribuida' : 'incubando',
    dia_ciclo: diaCiclo(inc.fecha_inicio, idx.hoy),
    recolecta: rec ? rec.recolecta : null,
    recoleccion_fecha: rec ? rec.fecha : null,
    peso_ovipositores_g: rec ? rec.peso_ovipositores_g ?? null : null,
    insectario_id: ins ? ins.id : null,
    insectario_codigo: ins ? ins.codigo : null,
    insectario_nombre: ins ? ins.nombre_insectario : null,
    n_bandejas: nBandejas,
    siguiente_paso: paso ? { ...paso, label: pasoLabel(paso), cuando: cuandoLabel(paso) } : null
  });
}

export async function listIncubadoras(filters = {}) {
  const db = await openDb();
  const idx = await buildIndex(db);
  const trays = await allRows(db, 'bandeja');
  const counts = new Map();
  for (const t of trays) if (t.incubadora_id) counts.set(t.incubadora_id, (counts.get(t.incubadora_id) || 0) + 1);

  let rows = [...idx.incubadoraById.values()].map(i => decorateIncubadora(i, idx, counts.get(i.id) || 0));
  if (filters.estado) rows = rows.filter(r => r.estado === filters.estado);
  rows.sort((a, b) => String(b.fecha_inicio).localeCompare(String(a.fecha_inicio)) ||
                      String(a.codigo).localeCompare(String(b.codigo)));
  return ok(rows);
}

/* ── alimento ───────────────────────────────────────────────────────────── */

const round2 = v => Math.round(Number(v || 0) * 100) / 100;

export async function listRecepciones(filters = {}) {
  const db = await openDb();
  let rows = (await allRows(db, 'recepcion_alimento'))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  if (filters.limit) rows = rows.slice(0, filters.limit);
  return ok(deepCopy(rows));
}

/** Everything the food screens derive, from stored rows only. */
async function alimentoIndex(db) {
  const [ens, insumos, lecturas, feeds, parametros] = await Promise.all([
    allRows(db, 'ensilaje'), allRows(db, 'ensilaje_insumo'), allRows(db, 'ensilaje_lectura'),
    allRows(db, 'alimentacion'), allRows(db, 'parametro')
  ]);
  const consumo = new Map();
  for (const a of feeds) {
    if (!a.ensilaje_id) continue;
    const c = consumo.get(a.ensilaje_id) || { kg: 0, n: 0 };
    c.kg += Number(a.cantidad_kg) || 0; c.n += 1;
    consumo.set(a.ensilaje_id, c);
  }
  const ultimas = new Map();
  for (const l of lecturas) {
    const prev = ultimas.get(l.ensilaje_id);
    if (!prev || String(l.fecha) > String(prev.fecha)) ultimas.set(l.ensilaje_id, l);
  }
  return { ens, insumos, lecturas, feeds, consumo, ultimas, cfg: mergeProtocolo(parametros), hoy: farmDay() };
}

function decorateEnsilaje(e, idx) {
  const estado = ensilajeEstado(e);
  const diaSellado = e.sellado_at ? farmDay(e.sellado_at) : null;
  const listoPrevisto = diaSellado ? addDays(diaSellado, idx.cfg.dias_fermentacion) : null;
  const c = idx.consumo.get(e.id) || { kg: 0, n: 0 };
  const ult = idx.ultimas.get(e.id) || null;
  return Object.assign(deepCopy(e), {
    estado,
    dias_fermentando: diaSellado ? daysBetween(diaSellado, idx.hoy) : null,
    listo_previsto: listoPrevisto,
    // Days until it should be ready: negative once that date has passed.
    listo_en: listoPrevisto && !e.listo_at ? daysBetween(idx.hoy, listoPrevisto) : null,
    kg_consumido: round2(c.kg),
    n_cargas: c.n,
    kg_disponible: e.kg_inicial == null ? null : round2(Number(e.kg_inicial) - c.kg),
    ultima_temperatura_c: ult ? ult.temperatura_c : null,
    ultima_lectura: ult ? ult.fecha : null
  });
}

export async function listEnsilajes(filters = {}) {
  const db = await openDb();
  const idx = await alimentoIndex(db);
  const orden = { en_uso: 0, listo: 1, fermentando: 2, armado: 3, agotado: 4 };
  let rows = idx.ens.map(e => decorateEnsilaje(e, idx));
  if (filters.activos) rows = rows.filter(r => r.estado !== 'agotado');
  rows.sort((a, b) => (orden[a.estado] - orden[b.estado]) ||
                      String(b.fecha_armado).localeCompare(String(a.fecha_armado)));
  return ok(rows);
}

export async function getEnsilajeDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'ensilaje', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Ensilaje no encontrado.');
  const idx = await alimentoIndex(db);
  const porDia = new Map();
  for (const a of idx.feeds.filter(f => f.ensilaje_id === id)) {
    const d = farmDay(a.fecha);
    porDia.set(d, round2((porDia.get(d) || 0) + (Number(a.cantidad_kg) || 0)));
  }
  return ok({
    ensilaje: decorateEnsilaje(row, idx),
    insumos: deepCopy(idx.insumos.filter(i => i.ensilaje_id === id)),
    lecturas: deepCopy(idx.lecturas.filter(l => l.ensilaje_id === id)
      .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)))),
    consumo_por_dia: [...porDia].sort((a, b) => b[0].localeCompare(a[0])).map(([dia, kg]) => ({ dia, kg }))
  });
}

/**
 * The whole food picture: raw material in store, ensilaje usable now and
 * fermenting, what the trays eat per day, how long the stock lasts, and
 * whether it covers the loads due in the next days.
 */
export async function getStockAlimento({ dias = 3 } = {}) {
  const db = await openDb();
  const [idx, recepciones, bidx, cache] = await Promise.all([
    alimentoIndex(db), allRows(db, 'recepcion_alimento'), buildIndex(db), allCache(db)
  ]);

  const mats = new Map();
  const mat = m => { if (!mats.has(m)) mats.set(m, { material: m, recibido_kg: 0, usado_kg: 0, ultima_recepcion: null }); return mats.get(m); };
  for (const r of recepciones) {
    const x = mat(r.material);
    x.recibido_kg += Number(r.kg) || 0;
    if (!x.ultima_recepcion || String(r.fecha) > String(x.ultima_recepcion)) x.ultima_recepcion = r.fecha;
  }
  const vivos = new Set(idx.ens.map(e => e.id));
  for (const i of idx.insumos) if (vivos.has(i.ensilaje_id)) mat(i.material).usado_kg += Number(i.kg) || 0;
  const materiales = [...mats.values()].map(x => ({
    ...x, recibido_kg: round2(x.recibido_kg), usado_kg: round2(x.usado_kg),
    disponible_kg: round2(x.recibido_kg - x.usado_kg)
  })).sort((a, b) => a.material.localeCompare(b.material, 'es'));

  const ens = idx.ens.map(e => decorateEnsilaje(e, idx));
  const usable = ens.filter(e => e.estado === 'en_uso' || e.estado === 'listo');
  const enUso = ens.filter(e => e.estado === 'en_uso')
    .sort((a, b) => String(a.en_uso_at).localeCompare(String(b.en_uso_at)))[0] || null;
  const disponible = round2(usable.reduce((s, e) => s + Math.max(0, e.kg_disponible || 0), 0));
  const fermentando = round2(ens.filter(e => e.estado === 'fermentando' || e.estado === 'armado')
    .reduce((s, e) => s + (Number(e.kg_inicial) || 0), 0));

  // What the new-protocol trays actually ate in the last 7 farm days.
  const desde = addDays(idx.hoy, -6);
  const consumo7 = round2(idx.feeds
    .filter(a => (a.protocolo || 'v1') === 'v2' && farmDay(a.fecha) >= desde)
    .reduce((s, a) => s + (Number(a.cantidad_kg) || 0), 0));
  const diario = round2(consumo7 / 7);

  // And what they will need soon, from the plan.
  const trays = (await allRows(db, 'bandeja')).filter(b => b.protocolo === 'v2' && !b.cerrada_admin_at)
    .map(b => {
      const c = cache.get(b.id);
      const inc = bidx.incubadoraById.get(b.incubadora_id);
      const estado = c?.estado ?? b.estado;
      return { dia_ciclo: inc ? diaCiclo(inc.fecha_inicio, bidx.hoy) : null, cargas_dadas: c?.cargas_dadas || [],
               tiene_ayuno: Boolean(c?.tiene_ayuno) || estado === 'en_ayuno', cosechada: estado === 'cosechada' };
    });
  const proximas = kgCargasProximas(trays, idx.cfg, dias);

  return ok({
    materiales,
    ensilaje_en_uso: enUso,
    ensilaje_disponible_kg: disponible,
    ensilaje_fermentando_kg: fermentando,
    consumo_7d_kg: consumo7,
    consumo_diario_kg: diario,
    dias_restantes: diario > 0 ? Math.floor(disponible / diario) : null,
    kg_cargas_proximas: proximas,
    dias_prevision: dias,
    alcanza: disponible >= proximas
  });
}

export async function getIncubadoraDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'incubadora', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Incubadora no encontrada.');
  const [idx, cache] = await Promise.all([buildIndex(db), allCache(db)]);
  const bandejas = (await rowsByIndex(db, 'bandeja', 'by_incubadora', id))
    .map(b => joinBandeja(b, idx, cache.get(b.id)))
    .sort((a, b) => (a.no_bandeja ?? 0) - (b.no_bandeja ?? 0));
  return ok({ incubadora: decorateIncubadora(row, idx, bandejas.length), bandejas });
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
    const c = idx.loteById.get(bandeja.lote_id);
    if (c) lote = decorateLote(c);
  }

  return ok({ bandeja, lote, eventos });
}

export async function listSeparacionesDisponibles() {
  const db = await openDb();
  const [seps, links, trays] = await Promise.all([
    allRows(db, 'separacion'),
    allRows(db, 'lote_separacion'),
    allRows(db, 'bandeja')
  ]);
  const pooled = new Set(links.map(l => l.separacion_id));
  const trayById = new Map(trays.map(t => [t.id, t]));

  const rows = seps
    .filter(s => !pooled.has(s.id))
    .map(s => Object.assign(deepCopy(s), {
      bandeja_label: trayById.get(s.bandeja_id)?.id_bandeja || '(bandeja sin sincronizar)'
    }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  return ok(rows);
}

export async function listLotes(filters = {}) {
  const db = await openDb();
  const [lotes, links] = await Promise.all([
    allRows(db, 'lote'),
    allRows(db, 'lote_separacion')
  ]);
  const counts = new Map();
  for (const l of links) counts.set(l.lote_id, (counts.get(l.lote_id) || 0) + 1);

  let rows = lotes.map(c => decorateLote(c, counts.get(c.id) || 0));
  if (filters.estado) rows = rows.filter(r => r.estado === filters.estado);
  rows.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok(rows);
}

export async function getLoteDetail(id) {
  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');

  const links = await rowsByIndex(db, 'lote_separacion', 'by_lote', id);
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

  return ok({ lote: decorateLote(row, separaciones.length), separaciones });
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
                     'bandeja', 'insectario', 'recoleccion', 'lote'];

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
    .filter(ayunoAbierto)
    .map(a => Object.assign(decorateAyuno(a), {
      bandeja_label: trayById.get(a.bandeja_id)?.id_bandeja || '(bandeja sin sincronizar)',
      protocolo: trayById.get(a.bandeja_id)?.protocolo || 'v1'
    }))
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  return ok(rows);
}

/**
 * Catalogue values, replacing the frozen module-level arrays.
 *
 * Each value once. A phone seeds the lists before its first sync so the
 * pickers work offline; the server's copies of the same values arrive later
 * with different ids. Without this every option showed twice, and both copies
 * lit up together because they share one form value.
 */
export async function listCatalogo(tipo) {
  const db = await openDb();
  const rows = (await rowsByIndex(db, 'catalogo', 'by_tipo', tipo))
    .filter(c => c.activo !== false)
    // Server rows first, so they win the de-duplication below.
    .sort((a, b) => Number(Boolean(a._seeded)) - Number(Boolean(b._seeded)));
  const byValue = new Map();
  for (const c of rows) {
    const k = String(c.valor ?? '').trim().toLowerCase();
    if (k && !byValue.has(k)) byValue.set(k, c);
  }
  const unique = [...byValue.values()]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.valor).localeCompare(String(b.valor)));
  return ok(unique.map(c => c.valor));
}
