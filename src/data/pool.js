/**
 * pool.js — the 2 % that goes back to the insectario.
 *
 * Each separación leaves its 2 % (retorno) waiting. A repopulation (ingreso)
 * takes the kilos the operator weighed, the OLDEST first, and only from what
 * had been separated by its own date. From the cajas it drew on come the
 * trays' ages (a range, and the simple average of the cajas) and their
 * generation (the most common one, counted by caja).
 *
 * Nothing here is stored but the generation the operator confirmed for the
 * cage, so correcting a separación moves every age that depended on it.
 * Pure: no storage, no clock.
 */
import { farmDay, daysBetween, addDays } from './time.js';
import { kg3, repartoSeparacion, PROTOCOLO_DEFAULTS } from './protocolo.js';

const vivo = r => r && !r.deleted_at;
const cronologico = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) ||
                              String(a.created_at).localeCompare(String(b.created_at)) ||
                              String(a.id).localeCompare(String(b.id));

/**
 * What a set of drawn kilos says about the larvae.
 *   usadas: [{ caja_id, caja_codigo, dia0, generacion, kg }]
 *   dia:    the farm day of the ingreso
 */
export function resumenLarvas(usadas, dia, faltanKg = 0) {
  const porCaja = new Map();
  for (const u of usadas) if (!porCaja.has(u.caja_id)) porCaja.set(u.caja_id, u);
  const cajas = [...porCaja.values()];

  const dias0 = cajas.map(c => c.dia0).filter(Boolean).sort();
  const edades = dias0.map(d => daysBetween(d, dia));
  const promedio = edades.length ? Math.round(edades.reduce((s, e) => s + e, 0) / edades.length) : null;

  // The most common generation by caja; a tie goes to the oldest caja's.
  const cuenta = new Map();
  for (const c of cajas) cuenta.set(c.generacion, (cuenta.get(c.generacion) || 0) + 1);
  let generacion = null, max = 0;
  for (const c of cajas) {
    const n = cuenta.get(c.generacion);
    if (n > max) { max = n; generacion = c.generacion; }
  }

  return {
    cajas: cajas.map(c => ({ caja_id: c.caja_id, codigo: c.caja_codigo, dia0: c.dia0,
                             generacion: c.generacion })),
    partes: usadas.map(u => ({ separacion_id: u.separacion_id, caja_id: u.caja_id, kg: u.kg })),
    kg: kg3(usadas.reduce((s, u) => s + u.kg, 0)),
    faltan_kg: kg3(faltanKg),
    edad_min: edades.length ? Math.min(...edades) : null,
    edad_max: edades.length ? Math.max(...edades) : null,
    edad_promedio: promedio,
    dia0_promedio: promedio === null ? null : addDays(dia, -promedio),
    generacion_larvas: generacion,
    generaciones: [...cuenta.keys()].sort((a, b) => a - b),
    mezcla: cuenta.size > 1
  };
}

/**
 * Run the 2 % oldest-first through every ingreso, in order.
 *
 *   separaciones, cajas, incubadoras, ingresos: rows
 *   nuevo: optionally a repopulation being typed ({ fecha, kg_larvas }), run
 *          after all the recorded ones — what the ingreso form previews
 *
 * @returns {{ usos: Map<ingresoId, resumen>, nuevo: resumen|null,
 *             pendientes: Array, kg_pendiente: number }}
 */
export function pool2({ separaciones = [], cajas = [], incubadoras = [], ingresos = [] } = {},
                      cfg = PROTOCOLO_DEFAULTS, nuevo = null) {
  const cajaPor = new Map(cajas.map(c => [c.id, c]));
  const incPor = new Map(incubadoras.map(i => [i.id, i]));

  const partes = separaciones.filter(vivo).sort(cronologico).map(s => {
    const caja = cajaPor.get(s.caja_id);
    const inc = caja && incPor.get(caja.incubadora_id);
    const { retorno_kg } = repartoSeparacion(s.peso_total_kg, s.pct_coccion ?? cfg.pct_coccion);
    return {
      separacion_id: s.id, caja_id: s.caja_id, caja_codigo: caja?.codigo || '',
      fecha: s.fecha, dia0: inc?.dia0 || null,
      generacion: inc ? Number(inc.generacion) : null,
      libre: retorno_kg || 0
    };
  });

  const tomar = (fecha, kg) => {
    let resta = kg3(kg);
    const usadas = [];
    for (const p of partes) {
      if (resta <= 0) break;
      if (String(p.fecha) > String(fecha)) break;          // not separated yet by then
      if (p.libre <= 0) continue;
      const toma = Math.min(p.libre, resta);
      p.libre = kg3(p.libre - toma);
      resta = kg3(resta - toma);
      usadas.push({ ...p, kg: toma });
    }
    return resumenLarvas(usadas, farmDay(fecha), resta);
  };

  const usos = new Map();
  for (const ing of ingresos.filter(vivo).sort(cronologico)) {
    usos.set(ing.id, tomar(ing.fecha, ing.kg_larvas));
  }
  const pendientes = partes.filter(p => p.libre > 0)
    .map(p => ({ separacion_id: p.separacion_id, caja_id: p.caja_id, caja_codigo: p.caja_codigo,
                 fecha: p.fecha, dia0: p.dia0, generacion: p.generacion, kg: p.libre }));
  const kgPendiente = kg3(pendientes.reduce((s, p) => s + p.kg, 0));
  const vistaNuevo = nuevo ? tomar(nuevo.fecha, nuevo.kg_larvas) : null;

  return { usos, nuevo: vistaNuevo, pendientes, kg_pendiente: kgPendiente };
}

/**
 * The 98 % waiting for the oven: per separación, its cocción minus what
 * cochadas already took. Never negative (an over-assigned separación is a
 * "revisar", not a debt).
 */
export function pendienteHorno({ separaciones = [], origenes = [] } = {}, cfg = PROTOCOLO_DEFAULTS) {
  const tomado = new Map();
  for (const o of origenes.filter(vivo)) {
    tomado.set(o.separacion_id, kg3((tomado.get(o.separacion_id) || 0) + Number(o.kg)));
  }
  const out = [];
  for (const s of separaciones.filter(vivo).sort(cronologico)) {
    const { coccion_kg } = repartoSeparacion(s.peso_total_kg, s.pct_coccion ?? cfg.pct_coccion);
    const t = tomado.get(s.id) || 0;
    out.push({ separacion_id: s.id, caja_id: s.caja_id, fecha: s.fecha, coccion_kg,
               kg_tomado: t, kg_pendiente: Math.max(0, kg3(coccion_kg - t)),
               excedido: t > coccion_kg });
  }
  return out;
}
