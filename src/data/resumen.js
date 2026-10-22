/**
 * resumen.js — the lab in numbers: what there is now, the last weeks, and how
 * a period went.
 *
 * Read from the same picture of the lab every screen uses (vista.js), so a
 * number here never disagrees with a list. Every figure is a count, a sum or a
 * ratio of what was recorded: nothing is estimated and nothing is stored.
 *
 * A period is farm days, today included ("7 días" is today and the six days
 * before). A larvae cycle counts in the period it ENDED — when its last caja
 * was separated or closed — so its yield is never split between two periods.
 * Cycles closed early count too: they are part of what the recolectas yielded.
 *
 * Pure: the day comes with the vista.
 */
import { addDays, daysBetween, farmDay } from './time.js';
import { kg3, diaSemana, repartoSeparacion } from './protocolo.js';
import { paraHoy } from './monitor.js';

/** The periods the screen offers, in days; null is everything. */
export const PERIODOS = Object.freeze({ 7: 7, 30: 30, todo: null });

const num = v => Number(v) || 0;
const suma = (xs, f) => kg3(xs.reduce((s, x) => s + num(f(x)), 0));
const promedio = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const redondeo = (v, d = 1) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
/** a ÷ b, two decimals under 10 and one above: 1,06 · 4,89 · 12,3. */
const razon = (a, b) => (b > 0 ? redondeo(a / b, a / b < 10 ? 2 : 1) : null);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const rango = xs => (xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null);
const medidas = xs => (xs.length ? { prom: redondeo(promedio(xs)), ...rango(xs) } : null);
// A missing date must stay missing: farmDay(undefined) would be today.
const diaDe = v => (v ? farmDay(v) : null);
const ms = v => Date.parse(v);
const lunes = dia => addDays(dia, 1 - diaSemana(dia));

/**
 * @param v        a vista (construirVista)
 * @param periodo  '7' | '30' | 'todo'
 * @param semanas  how many weeks the weekly series cover, this one included
 */
export function resumenLab(v, { periodo = '30', semanas = 8 } = {}) {
  const clave = String(periodo) in PERIODOS ? String(periodo) : '30';
  const dias = PERIODOS[clave];
  const desde = dias ? addDays(v.hoy, -(dias - 1)) : null;
  const en = dia => Boolean(dia) && dia <= v.hoy && (!desde || dia >= desde);
  return {
    ahora: ahora(v),
    semanas: porSemana(v, semanas),
    periodo: {
      clave, dias, desde, hasta: v.hoy,
      ...insectario(v, en),
      larvas: ciclosLarvas(v, en),
      ...eventosLarvas(v, en),
      horno: horno(v, en),
      alimento: alimento(v, en)
    }
  };
}

/* ── now ──────────────────────────────────────────────────────────────────── */

function ahora(v) {
  const fase = f => v.jaulas.filter(j => j.fase === f).length;
  const gens = new Map();
  for (const j of v.jaulas.filter(x => x.fase === 'activa')) gens.set(j.generacion, (gens.get(j.generacion) || 0) + 1);
  const incs = v.incubadoras.filter(i => i.estado === 'activo');
  const cajas = v.cajas.filter(c => c.estado === 'activo');
  const dias = xs => rango(xs.map(x => x.dia).filter(d => d !== null && d !== undefined));
  const abiertos = v.ensilados.filter(e => e.estado === 'abierto')
    .sort((a, b) => String(a.vence_at).localeCompare(String(b.vence_at)));
  const madurando = v.ensilados.filter(e => e.estado === 'madurando')
    .sort((a, b) => String(a.apertura_prevista).localeCompare(String(b.apertura_prevista)));
  return {
    jaulas: {
      total: v.jaulas.length, con_moscas: fase('activa'), cerradas: fase('cerrada'), limpias: fase('limpia'),
      generaciones: [...gens].map(([generacion, n]) => ({ generacion, n })).sort((a, b) => a.generacion - b.generacion)
    },
    incubadoras: { activas: incs.length, dias: dias(incs) },
    cajas: { activas: cajas.length, en_ayuno: cajas.filter(c => c.en_ayuno).length, dias: dias(cajas) },
    cochadas_en_horno: v.cochadas.filter(c => c.estado === 'activo').length,
    horno_kg: suma(v.horno, h => h.kg_pendiente),
    pool_kg: v.pool.kg_pendiente,
    ensilado: {
      abiertos: abiertos.length, kg_restante: suma(abiertos, e => e.kg_restante),
      vence_at: abiertos[0]?.vence_at || null,
      madurando: madurando.length, proxima_apertura: madurando[0]?.apertura_prevista || null
    },
    // An over-drawn recepción is a "revisar", not negative stock.
    bodega_kg: suma([...v.stock.porMaterial.values()], m => Math.max(0, m.kg_disponible)),
    revisar: v.revisar.size,
    atrasados: paraHoy(v).resumen.atrasado
  };
}

/* ── the last weeks, Monday to Sunday ─────────────────────────────────────── */

function porSemana(v, n) {
  const actual = lunes(v.hoy);
  const out = [];
  for (let k = n - 1; k >= 0; k--) {
    const desde = addDays(actual, -7 * k);
    out.push({ desde, hasta: addDays(desde, 6), en_curso: k === 0,
               recolectas: 0, recolectado_g: 0, separaciones: 0, separado_kg: 0 });
  }
  const de = dia => (dia ? out.find(s => dia >= s.desde && dia <= s.hasta) : null);
  for (const i of v.incubadoras) {
    const s = de(i.dia0);
    if (s) { s.recolectas++; s.recolectado_g = kg3(s.recolectado_g + num(i.peso_inicial_g)); }
  }
  for (const x of v.separaciones) {
    const s = de(diaDe(x.fecha));
    if (s) { s.separaciones++; s.separado_kg = kg3(s.separado_kg + num(x.peso_total_kg)); }
  }
  return out;
}

/* ── the insectario ───────────────────────────────────────────────────────── */

function insectario(v, en) {
  const recolectas = v.incubadoras.filter(i => en(i.dia0));
  const porJaula = new Map();
  for (const i of recolectas) {
    const j = porJaula.get(i.jaula_id) || { jaula_id: i.jaula_id, nombre: i.jaula?.nombre || '?', recolectas: 0, g: 0 };
    j.recolectas++;
    j.g = kg3(j.g + num(i.peso_inicial_g));
    porJaula.set(i.jaula_id, j);
  }
  const g = suma(recolectas, i => i.peso_inicial_g);

  // A cage cycle runs from its repopulation to its cierre. One that began
  // before the app (a cage that already had flies) has no start to count from.
  const ciclos = [];
  for (const j of v.jaulas) {
    for (const ev of j.eventos) {
      if (ev.tipo !== 'cierre' || !en(diaDe(ev.fecha))) continue;
      const inicio = j.ingresos.filter(i => ms(i.fecha) <= ms(ev.fecha)).pop();
      if (!inicio) continue;
      const recs = v.incubadoras.filter(i => i.jaula_id === j.id &&
        ms(i.recolecta_at) >= ms(inicio.fecha) && ms(i.recolecta_at) <= ms(ev.fecha));
      ciclos.push({ jaula_id: j.id, nombre: j.nombre, generacion: Number(inicio.generacion),
                    dias: daysBetween(diaDe(inicio.fecha), diaDe(ev.fecha)),
                    recolectas: recs.length, g: suma(recs, i => i.peso_inicial_g) });
    }
  }

  const ingresos = v.ingresos.filter(i => en(diaDe(i.fecha)));
  return {
    recolectas: {
      n: recolectas.length, g, g_prom: recolectas.length ? redondeo(g / recolectas.length) : null,
      por_jaula: [...porJaula.values()]
        .map(j => ({ ...j, g_prom: redondeo(j.g / j.recolectas) }))
        .sort((a, b) => b.g - a.g || a.nombre.localeCompare(b.nombre, 'es'))
    },
    ciclos_jaula: {
      n: ciclos.length,
      dias_prom: redondeo(promedio(ciclos.map(c => c.dias))),
      recolectas_prom: redondeo(promedio(ciclos.map(c => c.recolectas))),
      g_prom: redondeo(promedio(ciclos.map(c => c.g))),
      lista: ciclos
    },
    repoblados: {
      n: ingresos.length, kg_larvas: suma(ingresos, i => i.kg_larvas),
      bandejas: ingresos.reduce((s, i) => s + i.bandejas.length, 0)
    }
  };
}

/* ── the larvae cycle ─────────────────────────────────────────────────────── */

/** The farm day an incubadora's cycle ended, or null while it is still going. */
function finDeCiclo(inc, cajas) {
  if (inc.estado === 'activo') return null;
  if (!inc.distribucion) return diaDe(inc.cerrado_at);          // closed in the incubadora
  if (cajas.some(c => c.estado === 'activo')) return null;      // cajas still growing
  const fines = cajas.map(c => diaDe(c.separacion ? c.separacion.fecha : c.cerrado_at)).filter(Boolean).sort();
  return fines.length ? fines[fines.length - 1] : diaDe(inc.distribucion.fecha);
}

function ciclosLarvas(v, en) {
  const cajasDe = new Map();
  for (const c of v.cajas) {
    if (!cajasDe.has(c.incubadora_id)) cajasDe.set(c.incubadora_id, []);
    cajasDe.get(c.incubadora_id).push(c);
  }
  const terminados = v.incubadoras
    .map(i => ({ i, cajas: cajasDe.get(i.id) || [] }))
    .filter(t => en(finDeCiclo(t.i, t.cajas)));
  const cajas = terminados.flatMap(t => t.cajas);
  const separadas = cajas.filter(c => c.separacion);
  const distribuidas = terminados.filter(t => t.i.distribucion);

  const g = suma(terminados, t => t.i.peso_inicial_g);
  const tamizado = suma(distribuidas, t => t.i.distribucion.peso_total_kg);
  const separado = suma(separadas, c => c.separacion.peso_total_kg);
  const alimentoKg = kg3(suma(terminados, t => t.i.alimento_inicial_kg) + suma(cajas.flatMap(c => c.cargas), a => a.kg));
  return {
    n: terminados.length,
    cerradas: { incubadoras: terminados.length - distribuidas.length, cajas: cajas.length - separadas.length },
    g_inicial: g, kg_tamizado: tamizado, kg_separado: separado, kg_alimento: alimentoKg,
    kg_por_g: razon(separado, g),
    multiplicacion: razon(separado, tamizado),
    fcr: razon(alimentoKg, separado),
    dia_distribucion: redondeo(promedio(distribuidas.map(t => daysBetween(t.i.dia0, diaDe(t.i.distribucion.fecha))))),
    dia_separacion: redondeo(promedio(separadas.map(c => daysBetween(c.dia0, diaDe(c.separacion.fecha))))),
    plan: { distribucion: v.cfg.dia_distribucion, separacion: v.cfg.dia_separacion }
  };
}

/** What happened to the larvae in the period, by the day it happened. */
function eventosLarvas(v, en) {
  const seps = v.separaciones.filter(x => en(diaDe(x.fecha)));
  const reparto = seps.map(x => repartoSeparacion(x.peso_total_kg, x.pct_coccion ?? v.cfg.pct_coccion));
  const chequeos = v.chequeos.filter(c => en(diaDe(c.fecha)));
  const valores = k => chequeos.map(c => c[k]).filter(x => x !== null && x !== undefined && x !== '' && Number.isFinite(Number(x))).map(Number);
  const cerradas = xs => xs.filter(o => en(diaDe(o.cerrado_at))).length;
  const cierres = {
    incubadoras: cerradas(v.incubadoras), cajas: cerradas(v.cajas),
    cochadas: cerradas(v.cochadas), bandejas: cerradas(v.bandejas)
  };
  return {
    separaciones: {
      n: seps.length, kg: suma(seps, x => x.peso_total_kg),
      coccion_kg: suma(reparto, r => r.coccion_kg), retorno_kg: suma(reparto, r => r.retorno_kg)
    },
    chequeos: { n: chequeos.length, humedad: medidas(valores('humedad_pct')), temperatura: medidas(valores('temperatura_c')) },
    cierres: { n: cierres.incubadoras + cierres.cajas + cierres.cochadas + cierres.bandejas, ...cierres }
  };
}

/* ── the oven ─────────────────────────────────────────────────────────────── */

function horno(v, en) {
  const alHorno = v.cochadas.filter(c => en(diaDe(c.horno_at)));
  const terminadas = v.cochadas.filter(c => c.final && en(diaDe(c.final.fecha)));
  const entrada = suma(terminadas, c => c.peso_inicial_kg);
  const salida = suma(terminadas, c => c.final.peso_kg);
  const porCochada = terminadas.filter(c => num(c.peso_inicial_kg) > 0)
    .map(c => Math.round((num(c.final.peso_kg) / num(c.peso_inicial_kg)) * 100));
  const conMedia = terminadas.filter(c => c.media);
  return {
    al_horno: { n: alHorno.length, kg: suma(alHorno, c => c.peso_inicial_kg) },
    terminadas: {
      n: terminadas.length, kg_entrada: entrada, kg_salida: salida,
      rendimiento_pct: pct(salida, entrada), rango_pct: rango(porCochada),
      temp_media: redondeo(promedio(conMedia.map(c => num(c.media.temperatura_c)))),
      temp_final: redondeo(promedio(terminadas.map(c => num(c.final.temperatura_c))))
    }
  };
}

/* ── food ─────────────────────────────────────────────────────────────────── */

function alimento(v, en) {
  const dados = [
    ...v.incubadoras.map(i => ({ id: i.id, fecha: i.recolecta_at, kg: i.alimento_inicial_kg })),
    ...v.alimentaciones.map(a => ({ id: a.id, fecha: a.fecha, kg: a.kg }))
  ].filter(c => num(c.kg) > 0 && en(diaDe(c.fecha)));
  const sin = dados.map(c => v.alimento.consumos.get(c.id)?.sin_ensilado_kg || 0);

  const recepciones = v.recepciones.filter(r => en(diaDe(r.fecha)));
  const porMaterial = new Map();
  for (const r of recepciones) porMaterial.set(r.material, kg3((porMaterial.get(r.material) || 0) + num(r.kg)));

  const hechos = v.ensilados.filter(e => en(e.dia0));
  // An ensilado is done when its 72 h are over: what was not eaten was discarded.
  const terminados = v.ensilados.filter(e => e.estado === 'vencido' && en(diaDe(e.vence_at)));
  const kgTerminados = suma(terminados, e => e.kg_total);
  const consumido = suma(terminados, e => e.kg_usado);
  return {
    dado_kg: suma(dados, c => c.kg),
    sin_ensilado_kg: suma(sin, x => x),
    sin_ensilado_n: sin.filter(x => x > 0).length,
    recibido: {
      kg: suma(recepciones, r => r.kg),
      por_material: [...porMaterial].map(([material, kg]) => ({ material, kg }))
        .sort((a, b) => b.kg - a.kg || a.material.localeCompare(b.material, 'es'))
    },
    ensilados_hechos: { n: hechos.length, kg: suma(hechos, e => e.kg_total) },
    ensilados_terminados: {
      n: terminados.length, kg: kgTerminados, consumido_kg: consumido,
      descartado_kg: suma(terminados, e => e.kg_descartado),
      consumido_pct: pct(consumido, kgTerminados)
    }
  };
}
