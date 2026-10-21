/**
 * revisar.js — which records need a second look ("revisar").
 *
 * When a correction changes something a later record was built on, the
 * numbers that are computed simply move (98/2, the 2 % waiting, the stock,
 * ages); what a person RECORDED or CONFIRMED cannot move by itself, so it is
 * flagged until someone checks it and taps "Revisado".
 *
 * A record is flagged when something it was built on:
 *   - had a value or a date corrected after the record was made or last
 *     reviewed, or
 *   - dated before it, was registered after it (a phone that synced late), or
 *   - now plainly disagrees with it (a 98 % given out twice, a generation that
 *     no longer matches).
 *
 * Nothing is stored. "Revisado" moves the record's own mark (revisado_at)
 * forward, and the time-based flags go; a disagreement stays until fixed.
 * A note or a photo is not a correction (valores_editados_at, 0010).
 */
import { kg3, repartoSeparacion, PROTOCOLO_DEFAULTS } from './protocolo.js';

const vivo = r => r && !r.deleted_at;
const max = (...v) => v.filter(Boolean).sort().pop() || '';

/** When a record was last made, corrected or reviewed. */
export const visto = r => max(r.created_at, r.valores_editados_at, r.revisado_at);

/** `input` changed, or arrived dated before `dep`, after `dep` was last seen. */
function cambioTras(input, dep, { fechaInput, fechaDep } = {}) {
  const v = visto(dep);
  if (input.valores_editados_at && input.valores_editados_at > v) return true;
  if (fechaInput && fechaDep && input.created_at > v && String(fechaInput) <= String(fechaDep)) return true;
  return false;
}

/**
 * @returns Map<"tabla:id", string[]> — the reasons, in Spanish, per record.
 */
export function revisiones(d = {}, cfg = PROTOCOLO_DEFAULTS, pool = null) {
  const out = new Map();
  const marcar = (tabla, id, motivo) => {
    const k = `${tabla}:${id}`;
    if (!out.has(k)) out.set(k, []);
    if (!out.get(k).includes(motivo)) out.get(k).push(motivo);
  };

  const incubadoras = (d.incubadoras || []).filter(vivo);
  const cajas = (d.cajas || []).filter(vivo);
  const separaciones = (d.separaciones || []).filter(vivo);
  const ingresos = (d.ingresos || []).filter(vivo);
  const incPor = new Map(incubadoras.map(i => [i.id, i]));
  const cajaPor = new Map(cajas.map(c => [c.id, c]));
  const sepPor = new Map(separaciones.map(s => [s.id, s]));

  // An incubadora corrected (date, cage, generation) → its chequeos and its
  // distribución, whose day numbers hang on it.
  for (const c of (d.chequeos || []).filter(vivo)) {
    const inc = c.incubadora_id && incPor.get(c.incubadora_id);
    if (inc && cambioTras(inc, c)) marcar('chequeo', c.id, `Se corrigió la incubadora ${inc.codigo}.`);
  }
  for (const x of (d.distribuciones || []).filter(vivo)) {
    const inc = incPor.get(x.incubadora_id);
    if (inc && cambioTras(inc, x)) marcar('distribucion', x.id, `Se corrigió la incubadora ${inc.codigo}.`);
  }

  // The cage's generation at each recolecta.
  for (const inc of incubadoras) {
    const esperada = generacionDeJaula(inc.jaula_id, inc.recolecta_at, d);
    if (esperada !== null && Number(inc.generacion) !== esperada) {
      marcar('incubadora', inc.id, `Su jaula era F${esperada} en esa recolecta; esta incubadora dice F${inc.generacion}.`);
    }
  }

  // The 98 %: a cochada took kilos of a separación that was then corrected,
  // or more than that separación has.
  const tomado = new Map();
  for (const o of (d.origenes || []).filter(vivo)) {
    tomado.set(o.separacion_id, kg3((tomado.get(o.separacion_id) || 0) + Number(o.kg)));
  }
  for (const o of (d.origenes || []).filter(vivo)) {
    const s = sepPor.get(o.separacion_id);
    if (!s) continue;
    const caja = cajaPor.get(s.caja_id);
    const nombre = caja ? `de la caja ${caja.codigo}` : '';
    if (cambioTras(s, o)) marcar('cochada_origen', o.id, `Se corrigió la separación ${nombre}.`);
    const { coccion_kg } = repartoSeparacion(s.peso_total_kg, s.pct_coccion ?? cfg.pct_coccion);
    if (tomado.get(s.id) > coccion_kg) {
      marcar('cochada_origen', o.id, `Al 98 % ${nombre} (${coccion_kg} kg) se le tomaron ${tomado.get(s.id)} kg.`);
    }
  }

  // The 2 %: an ingreso drew oldest-first, so any earlier separación or
  // ingreso that changed or arrived late moves what it drew.
  const ordenados = [...ingresos].sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));
  for (const ing of ordenados) {
    for (const s of separaciones) {
      if (String(s.fecha) > String(ing.fecha)) continue;
      if (cambioTras(s, ing, { fechaInput: s.fecha, fechaDep: ing.fecha })) {
        marcar('ingreso', ing.id, 'Cambió una separación anterior: revisa las larvas que tomó.');
        break;
      }
    }
    for (const prev of ordenados) {
      if (prev.id === ing.id || String(prev.fecha) > String(ing.fecha)) continue;
      if (cambioTras(prev, ing, { fechaInput: prev.fecha, fechaDep: ing.fecha })) {
        marcar('ingreso', ing.id, 'Cambió un ingreso anterior: revisa las larvas que tomó.');
        break;
      }
    }
    const uso = pool?.usos?.get(ing.id);
    if (uso) {
      for (const c of uso.cajas) {
        const caja = cajaPor.get(c.caja_id);
        const inc = caja && incPor.get(caja.incubadora_id);
        if (inc && cambioTras(inc, ing)) {
          marcar('ingreso', ing.id, `Se corrigió la incubadora ${inc.codigo}, de la que salieron sus larvas.`);
          break;
        }
      }
      if (uso.generacion_larvas !== null && Number(ing.generacion) !== uso.generacion_larvas + 1) {
        marcar('ingreso', ing.id, `Sus larvas son F${uso.generacion_larvas}: la jaula sería F${uso.generacion_larvas + 1}, no F${ing.generacion}.`);
      }
    }
  }

  // Raw material: an ensilado took from a recepción that was then corrected,
  // or that does not have that many kilos.
  const recPor = new Map((d.recepciones || []).filter(vivo).map(r => [r.id, r]));
  const usado = new Map();
  for (const i of (d.insumos || []).filter(vivo)) {
    usado.set(i.recepcion_id, kg3((usado.get(i.recepcion_id) || 0) + Number(i.kg)));
  }
  const ensPor = new Map((d.ensilados || []).filter(vivo).map(e => [e.id, e]));
  for (const i of (d.insumos || []).filter(vivo)) {
    const r = recPor.get(i.recepcion_id), e = ensPor.get(i.ensilado_id);
    if (!r || !e) continue;
    if (cambioTras(r, e)) marcar('ensilado', e.id, `Se corrigió la recepción de ${r.material}.`);
    if (usado.get(r.id) > Number(r.kg)) {
      marcar('ensilado', e.id, `De la recepción de ${r.material} (${Number(r.kg)} kg) se ensilaron ${usado.get(r.id)} kg.`);
    }
  }

  return out;
}

/** The generation a cage had at a moment: its last ingreso before it, or how
 *  it was registered. */
export function generacionDeJaula(jaulaId, momento, d = {}) {
  const jaula = (d.jaulas || []).find(j => j.id === jaulaId);
  if (!jaula) return null;
  const previos = (d.ingresos || []).filter(i => vivo(i) && i.jaula_id === jaulaId &&
                                                 String(i.fecha) <= String(momento))
    .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) ||
                    String(b.created_at).localeCompare(String(a.created_at)));
  return previos.length ? Number(previos[0].generacion) : Number(jaula.generacion_inicial);
}
