/**
 * alimento.js — the food cycle, worked out from what was recorded.
 *
 *   recepción → ensilado → 21 días de maduración → apertura (día 21)
 *   → 72 h de consumo → lo que sobra se da por descartado
 *
 * Nothing here is stored. Every feeding — the incubadora's initial food at the
 * recolecta and every carga of a caja — takes its kilos from the OLDEST
 * ensilado open at that moment, and from the next one if that runs out. A
 * feeding with no open ensilado is still a feeding: it is recorded and shown
 * as "sin ensilado". Because all of it is recomputed, correcting a weight or a
 * date moves every number that depended on it, with nothing to keep in step.
 *
 * Pure: the clock is passed in.
 */
import { farmDay, addDays } from './time.js';
import { kg3, PROTOCOLO_DEFAULTS } from './protocolo.js';

const HORA = 3600 * 1000;
const ms = v => Date.parse(v);
const vivo = r => r && !r.deleted_at;
const porFecha = (a, b) => String(a.fecha).localeCompare(String(b.fecha)) ||
                           String(a.id).localeCompare(String(b.id));

/**
 * Every ensilado's state and use, and where each feeding took its food from.
 *
 *   consumos: [{ id, tabla: 'incubadora' | 'alimentacion', fecha, kg }]
 *
 * @returns {{ ensilados: Map<string, object>, consumos: Map<string, {partes, sin_ensilado_kg}> }}
 */
export function cicloAlimento({ ensilados = [], insumos = [], consumos = [] } = {},
                              cfg = PROTOCOLO_DEFAULTS, ahora = Date.now()) {
  const kgDe = new Map();
  for (const i of insumos.filter(vivo)) {
    kgDe.set(i.ensilado_id, kg3((kgDe.get(i.ensilado_id) || 0) + Number(i.kg)));
  }

  const info = new Map();
  for (const e of ensilados.filter(vivo)) {
    const dia0 = e.dia0 || farmDay(e.ensilado_at);
    const venceAt = e.abierto_at ? new Date(ms(e.abierto_at) + cfg.horas_consumo * HORA).toISOString() : null;
    info.set(e.id, {
      id: e.id, codigo: e.codigo, contenedor_id: e.contenedor_id,
      ensilado_at: e.ensilado_at, dia0,
      apertura_prevista: addDays(dia0, cfg.dias_maduracion),
      abierto_at: e.abierto_at || null, vence_at: venceAt,
      kg_total: kgDe.get(e.id) || 0, kg_usado: 0
    });
  }

  // Oldest first: by the day it was made, then the moment, then its code.
  const abiertos = [...info.values()]
    .filter(e => e.abierto_at)
    .sort((a, b) => a.dia0.localeCompare(b.dia0) ||
                    String(a.ensilado_at).localeCompare(String(b.ensilado_at)) ||
                    String(a.codigo).localeCompare(String(b.codigo)));

  const porConsumo = new Map();
  for (const c of consumos.filter(c => c && Number(c.kg) > 0).sort(porFecha)) {
    let resta = kg3(c.kg);
    const partes = [];
    const t = ms(c.fecha);
    for (const e of abiertos) {
      if (resta <= 0) break;
      if (t < ms(e.abierto_at) || t >= ms(e.vence_at)) continue;
      const libre = kg3(e.kg_total - e.kg_usado);
      if (libre <= 0) continue;
      const toma = Math.min(libre, resta);
      e.kg_usado = kg3(e.kg_usado + toma);
      resta = kg3(resta - toma);
      partes.push({ ensilado_id: e.id, codigo: e.codigo, kg: toma });
    }
    porConsumo.set(c.id, { tabla: c.tabla, partes, sin_ensilado_kg: resta });
  }

  for (const e of info.values()) {
    e.estado = !e.abierto_at ? 'madurando' : ahora < ms(e.vence_at) ? 'abierto' : 'vencido';
    const sobra = kg3(e.kg_total - e.kg_usado);
    e.kg_restante = e.estado === 'vencido' ? 0 : sobra;
    e.kg_descartado = e.estado === 'vencido' ? sobra : 0;
  }
  return { ensilados: info, consumos: porConsumo };
}

/**
 * The feedings of the larvae cycle as consumptions of food: each incubadora's
 * initial food at its recolecta, and every carga.
 */
export function consumosDe({ incubadoras = [], alimentaciones = [] } = {}) {
  return [
    ...incubadoras.filter(vivo).map(i => ({ id: i.id, tabla: 'incubadora', fecha: i.recolecta_at,
                                            kg: Number(i.alimento_inicial_kg) || 0 })),
    ...alimentaciones.filter(vivo).map(a => ({ id: a.id, tabla: 'alimentacion', fecha: a.fecha,
                                               kg: Number(a.kg) || 0 }))
  ];
}

/**
 * Raw material in store: per material, what was received minus what went into
 * ensilados; and per recepción, the kilos still available to ensilar.
 */
export function stockMaterial({ recepciones = [], insumos = [] } = {}) {
  const usado = new Map();
  for (const i of insumos.filter(vivo)) {
    usado.set(i.recepcion_id, kg3((usado.get(i.recepcion_id) || 0) + Number(i.kg)));
  }
  const porRecepcion = new Map();
  const porMaterial = new Map();
  for (const r of recepciones.filter(vivo)) {
    const u = usado.get(r.id) || 0;
    porRecepcion.set(r.id, { id: r.id, material: r.material, fecha: r.fecha, kg: Number(r.kg),
                             kg_usado: u, kg_disponible: kg3(Number(r.kg) - u) });
    const m = porMaterial.get(r.material) || { material: r.material, kg_recibido: 0, kg_ensilado: 0 };
    m.kg_recibido = kg3(m.kg_recibido + Number(r.kg));
    m.kg_ensilado = kg3(m.kg_ensilado + u);
    porMaterial.set(r.material, m);
  }
  for (const m of porMaterial.values()) m.kg_disponible = kg3(m.kg_recibido - m.kg_ensilado);
  return { porRecepcion, porMaterial };
}
