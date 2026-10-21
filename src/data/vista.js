/**
 * vista.js — the lab as the screens see it, worked out from the rows.
 *
 * One pass over everything the phone holds gives the state, age, rack and next
 * steps of every object, the food cycle, the 2 % and 98 % waiting, the raw
 * material in store, and what needs a second look. Pure — read.js loads the
 * rows and the clock is passed in — so every rule is tested without storage.
 *
 * States are WORKED OUT from the registries, by the same rules the database's
 * triggers apply (0010). The phone never has to wait for the server to learn
 * that an incubadora it just distributed is no longer active, and a state can
 * never flip back and forth between what this phone did and what the last
 * pull said.
 */
import { farmDay } from './time.js';
import {
  PROTOCOLO_DEFAULTS, diaCiclo, repartoSeparacion, kg3, timing,
  pasosIncubadora, pasosCaja, estadoJaula, pasosJaula, pasosCochada
} from './protocolo.js';
import { cicloAlimento, consumosDe, stockMaterial } from './alimento.js';
import { pool2, pendienteHorno } from './pool.js';
import { revisiones } from './revisar.js';

/** The stores a vista is built from, by the name the snapshot uses. */
export const STORES_VISTA = [
  'parametro', 'catalogo', 'rack', 'contenedor', 'jaula', 'recepcion', 'ensilado',
  'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
  'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
  'bandeja_pupacion', 'jaula_evento', 'movimiento'
];

const cronologico = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) ||
                              String(a.created_at).localeCompare(String(b.created_at));

function agrupar(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key];
    if (k === null || k === undefined) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/**
 * @param s    { [store]: rows } — rows as stored, deleted ones included
 * @param cfg  the protocol settings (mergeProtocolo)
 */
export function construirVista(s, cfg = PROTOCOLO_DEFAULTS, { hoy = farmDay(), ahora = Date.now() } = {}) {
  const v = k => (s[k] || []).filter(r => r && !r.deleted_at);
  const racks = v('rack'), contenedores = v('contenedor'), jaulas = v('jaula');
  const incubadoras = v('incubadora'), distribuciones = v('distribucion'), cajas = v('caja');
  const chequeos = v('chequeo'), alimentaciones = v('alimentacion'), separaciones = v('separacion');
  const cochadas = v('cochada'), origenes = v('cochada_origen'), lecturas = v('cochada_lectura');
  const ingresos = v('ingreso'), bandejas = v('bandeja_pupacion'), eventos = v('jaula_evento');
  const movimientos = v('movimiento'), recepciones = v('recepcion'), ensilados = v('ensilado');
  const insumos = v('ensilado_insumo');

  const rackPor = new Map(racks.map(r => [r.id, r]));
  const contPor = new Map(contenedores.map(c => [c.id, c]));
  const jaulaPor = new Map(jaulas.map(j => [j.id, j]));

  // The rack an object is on: its last move, or where it started.
  const movsPor = agrupar([...movimientos].sort(cronologico), 'objeto_id');
  const rackDe = obj => {
    const ms = movsPor.get(obj.id);
    const id = ms?.length ? ms[ms.length - 1].rack_hasta : obj.rack_id;
    return id ? { id, codigo: rackPor.get(id)?.codigo || '?' } : null;
  };

  /* ── incubadoras ─────────────────────────────────────────────────────── */
  const distPor = new Map(distribuciones.map(d => [d.incubadora_id, d]));
  const chequeosInc = agrupar(chequeos.filter(c => c.incubadora_id), 'incubadora_id');
  const incs = incubadoras.map(i => {
    const dia0 = i.dia0 || farmDay(i.recolecta_at);
    const distribucion = distPor.get(i.id) || null;
    const estado = distribucion || i.cerrado_at ? 'inactivo' : 'activo';
    const ch = chequeosInc.get(i.id) || [];
    const base = { ...i, dia0, estado };
    return {
      ...base,
      jaula: jaulaPor.get(i.jaula_id) || null,
      dia: diaCiclo(dia0, hoy),
      distribucion,
      chequeos: ch,
      rack: rackDe(i),
      pasos: pasosIncubadora(base, { chequeos: ch }, cfg, hoy)
    };
  });
  const incPor = new Map(incs.map(i => [i.id, i]));

  /* ── cajas de engorde ────────────────────────────────────────────────── */
  const sepPor = new Map(separaciones.map(x => [x.caja_id, x]));
  const chequeosCaja = agrupar(chequeos.filter(c => c.caja_id), 'caja_id');
  const cargasCaja = agrupar(alimentaciones, 'caja_id');
  const cajasV = cajas.map(c => {
    const inc = incPor.get(c.incubadora_id);
    const separacion = sepPor.get(c.id) || null;
    const estado = separacion || c.cerrado_at ? 'inactivo' : 'activo';
    const ch = chequeosCaja.get(c.id) || [];
    const ca = (cargasCaja.get(c.id) || []).sort((a, b) => a.carga - b.carga);
    const base = { ...c, estado };
    return {
      ...base,
      incubadora_codigo: inc?.codigo || '',
      generacion: inc ? Number(inc.generacion) : null,
      dia0: inc?.dia0 || null,
      dia: diaCiclo(inc?.dia0, hoy),
      separacion,
      reparto: separacion ? repartoSeparacion(separacion.peso_total_kg, separacion.pct_coccion ?? cfg.pct_coccion) : null,
      chequeos: ch,
      cargas: ca,
      en_ayuno: !separacion && ch.some(x => Number(x.dia) === cfg.dia_inicio_ayuno),
      rack: rackDe(c),
      pasos: pasosCaja(base, { dia0: inc?.dia0, chequeos: ch, cargas: ca, separada: Boolean(separacion) }, cfg, hoy)
    };
  });
  const cajaPor = new Map(cajasV.map(c => [c.id, c]));

  /* ── the 2 % and the insectario ──────────────────────────────────────── */
  const pool = pool2({ separaciones, cajas, incubadoras: incs, ingresos }, cfg);
  const ingPor = agrupar(ingresos, 'jaula_id');
  const evPor = agrupar(eventos, 'jaula_id');
  const conRecolectaHoy = new Set(incs.filter(i => i.dia0 === hoy).map(i => i.jaula_id));
  const jaulasV = jaulas.map(j => {
    const ing = (ingPor.get(j.id) || []).sort(cronologico);
    const ev = (evPor.get(j.id) || []).sort(cronologico);
    const est = estadoJaula(j, { ingresos: ing, eventos: ev });
    return {
      ...j,
      fase: est.fase, estado: est.estado, generacion: est.generacion, ciclo_desde: est.ciclo_desde,
      dia_ciclo: est.ciclo_desde ? diaCiclo(est.ciclo_desde, hoy) : null,
      ingresos: ing, eventos: ev,
      pasos: pasosJaula(j, est, { recolectasHoy: conRecolectaHoy.has(j.id), poolKg: pool.kg_pendiente }, cfg, hoy)
    };
  });
  const ingresosV = ingresos.map(i => ({
    ...i, jaula: jaulaPor.get(i.jaula_id) || null, larvas: pool.usos.get(i.id) || null,
    bandejas: bandejas.filter(b => b.ingreso_id === i.id).sort((a, b) => a.numero - b.numero)
  }));
  const ingresoPor = new Map(ingresosV.map(i => [i.id, i]));
  const bandejasV = bandejas.map(b => ({
    ...b, estado: 'inactivo', ingreso: ingresoPor.get(b.ingreso_id) || null,
    jaula: jaulaPor.get(b.jaula_id) || null, rack: rackDe(b)
  }));

  /* ── the oven ────────────────────────────────────────────────────────── */
  const horno = pendienteHorno({ separaciones, origenes }, cfg);
  const lectPor = agrupar(lecturas, 'cochada_id');
  const origPor = agrupar(origenes, 'cochada_id');
  const cochadasV = cochadas.map(co => {
    const ls = lectPor.get(co.id) || [];
    const final = ls.find(l => l.momento === 'final') || null;
    const estado = final || co.cerrado_at ? 'inactivo' : 'activo';
    const og = (origPor.get(co.id) || []).map(o => {
      const sep = separaciones.find(x => x.id === o.separacion_id);
      return { ...o, caja: sep ? cajaPor.get(sep.caja_id) || null : null };
    });
    return {
      ...co, estado,
      media: ls.find(l => l.momento === 'media') || null,
      final, lecturas: ls,
      origenes: og,
      kg_origen: kg3(og.reduce((x, o) => x + Number(o.kg), 0)),
      pasos: pasosCochada({ ...co, estado }, { lecturas: ls }, hoy)
    };
  });

  /* ── food ────────────────────────────────────────────────────────────── */
  const alimento = cicloAlimento({ ensilados, insumos, consumos: consumosDe({ incubadoras, alimentaciones }) },
                                 cfg, ahora);
  const insumosPor = agrupar(insumos, 'ensilado_id');
  const recPor = new Map(recepciones.map(r => [r.id, r]));
  const ensiladosV = ensilados.map(e => {
    const a = alimento.ensilados.get(e.id);
    const pasos = [];
    if (a.estado === 'madurando') pasos.push({ paso: 'apertura', ...timing(a.apertura_prevista, hoy), aviso: true });
    // Open, it is today's business every day until it runs out or expires.
    if (a.estado === 'abierto') {
      pasos.push({ paso: 'consumo', vence: farmDay(a.vence_at), dias: 0, estado: 'hoy', aviso: true,
                   vence_at: a.vence_at, horas: Math.max(0, Math.floor((Date.parse(a.vence_at) - ahora) / 3600000)) });
    }
    return {
      ...e, ...a,
      contenedor: contPor.get(e.contenedor_id) || null,
      insumos: (insumosPor.get(e.id) || []).map(i => ({ ...i, recepcion: recPor.get(i.recepcion_id) || null })),
      pasos
    };
  });
  const stock = stockMaterial({ recepciones, insumos });

  /* ── what needs a second look ────────────────────────────────────────── */
  const revisar = revisiones({
    incubadoras: incs, chequeos, distribuciones, cajas, separaciones, ingresos,
    origenes, recepciones, insumos, ensilados, jaulas
  }, cfg, pool);

  return {
    hoy, cfg,
    racks, contenedores, recepciones,
    jaulas: jaulasV, incubadoras: incs, cajas: cajasV,
    cochadas: cochadasV, ingresos: ingresosV, bandejas: bandejasV,
    ensilados: ensiladosV, movimientos, eventos,
    chequeos, alimentaciones, separaciones, origenes, lecturas, insumos, distribuciones,
    pool, horno, alimento, stock, revisar,
    por: { jaula: jaulaPor, incubadora: incPor, caja: cajaPor, rack: rackPor, contenedor: contPor, ingreso: ingresoPor }
  };
}

/** The review reasons of one record, or []. */
export const motivosRevisar = (vista, tabla, id) => vista?.revisar?.get(`${tabla}:${id}`) || [];
