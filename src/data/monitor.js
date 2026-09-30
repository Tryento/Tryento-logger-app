/**
 * monitor.js — what the plan says is due, for the home screen.
 *
 * One list: what is late, what is due today, and what comes in the next days,
 * each item one tap from the form that does it. Trays that need the same thing
 * on the same day are one item, done in one action.
 *
 * Pure: no storage and no clock. `hoy` is a FARM day (YYYY-MM-DD, from
 * time.js farmDay), passed in, so the same rows always give the same list —
 * including between 20:00 and midnight in Caracas, when the UTC date is
 * already tomorrow.
 *
 * Inputs (read.js getMonitor builds them from the phone's own rows):
 *   bandejas     [{ id, id_bandeja, protocolo, estado, cerrada_admin_at,
 *                   fecha_inicio (día 0 of its incubadora), cargas_dadas, tiene_ayuno }]
 *   incubadoras  [{ id, codigo, fecha_inicio, distribuida_at, insectario_codigo }]
 *   ensilajes    [{ id, codigo, sellado_at, listo_at, en_uso_at, agotado_at }]
 *   revisiones   [{ bandeja_id, fecha, temperatura_c }]
 *   stock        read.js getStockAlimento() data, or null
 */
import { farmDay, addDays, daysBetween } from './time.js';
import {
  PROTOCOLO_DEFAULTS, diaCiclo, siguientePaso, pasoIncubadora, ensilajeEstado, cuandoLabel
} from './protocolo.js';

/** Most urgent first. `alerta` is something wrong now (a hot bed, no feed). */
const RANK = { alerta: 0, atrasado: 1, hoy: 2, proximo: 3 };
const TIPO_ORDEN = ['temperatura_alta', 'stock', 'distribucion', 'carga', 'temperatura', 'ayuno', 'cosecha',
                    'sin_ensilaje', 'ensilaje'];

const num = n => String(Math.round(Number(n) * 100) / 100).replace('.', ',');
const cuantas = n => `${n} ${n === 1 ? 'bandeja' : 'bandejas'}`;

/** "F7AR1-01, F7AR1-02 y 3 más" */
function etiquetas(trays, max = 3) {
  const names = trays.map(t => t.id_bandeja || '—');
  return names.length <= max ? names.join(', ') : `${names.slice(0, max).join(', ')} y ${names.length - max} más`;
}

const porCodigo = (a, b) => String(a.id_bandeja).localeCompare(String(b.id_bandeja));

/** "ahora", "hoy", "mañana", "en 2 días", "atrasado 1 día". */
export function cuandoItem(it) {
  return it.estado === 'alerta' ? 'ahora' : cuandoLabel(it);
}

export function monitor({
  bandejas = [], incubadoras = [], ensilajes = [], revisiones = [], stock = null,
  cfg = PROTOCOLO_DEFAULTS, hoy = farmDay(), horizonte = 2
} = {}) {
  const items = [];
  // Upcoming steps only as far as the horizon: tomorrow and the day after.
  const visible = p => Boolean(p) && (p.estado !== 'proximo' || -p.dias <= horizonte);

  /* día 7: incubadoras to split into trays */
  for (const i of incubadoras) {
    if (i.deleted_at) continue;
    const p = pasoIncubadora(i, cfg, hoy);
    if (!visible(p)) continue;
    items.push({
      tipo: 'distribucion', estado: p.estado, dias: p.dias, incubadora_id: i.id,
      titulo: `Distribuir ${i.codigo} en bandejas`,
      detalle: [`día ${p.dia_objetivo + p.dias}`, i.insectario_codigo].filter(Boolean).join(' · ')
    });
  }

  /* the trays: loads, fast, harvest — grouped by step and by how late */
  const activas = bandejas
    .filter(b => !b.deleted_at && (b.protocolo || 'v1') === 'v2' && b.estado !== 'cosechada' && !b.cerrada_admin_at)
    .map(b => ({ ...b, dia_ciclo: diaCiclo(b.fecha_inicio, hoy) }))
    .filter(b => b.dia_ciclo !== null);
  const grupos = new Map();
  for (const b of activas) {
    const p = siguientePaso({ dia_ciclo: b.dia_ciclo, cargas_dadas: b.cargas_dadas,
                              tiene_ayuno: b.tiene_ayuno, cosechada: false }, cfg);
    if (!visible(p)) continue;
    const key = `${p.paso}:${p.carga ?? ''}:${p.dias}`;
    if (!grupos.has(key)) grupos.set(key, { p, trays: [] });
    grupos.get(key).trays.push(b);
  }
  for (const { p, trays } of grupos.values()) {
    trays.sort(porCodigo);
    const n = trays.length;
    const base = { estado: p.estado, dias: p.dias, bandeja_ids: trays.map(t => t.id) };
    const dia = `día ${trays[0].dia_ciclo}`;
    if (p.paso === 'carga') {
      items.push({ ...base, tipo: 'carga', carga: p.carga, kg: Math.round(p.kg * n * 100) / 100,
                   titulo: `Carga ${p.carga} · ${cuantas(n)}`,
                   detalle: `${etiquetas(trays)} · ${dia} · ${num(p.kg * n)} kg` });
    } else if (p.paso === 'ayuno') {
      items.push({ ...base, tipo: 'ayuno', titulo: `Iniciar ayuno · ${cuantas(n)}`,
                   detalle: `${etiquetas(trays)} · ${dia}` });
    } else if (p.paso === 'cosecha') {
      items.push({ ...base, tipo: 'cosecha', titulo: `Cosechar · ${cuantas(n)}`,
                   detalle: `${etiquetas(trays)} · ${dia}` });
    }
  }

  /* bed temperature: who still needs measuring today, and any bed too hot */
  const max = cfg.temperatura_cama_max_c;
  const diasControl = new Set((cfg.dias_control_temperatura || []).map(Number));
  const medidaHoy = new Map();
  for (const r of revisiones) {
    if (r.deleted_at || r.temperatura_c === null || r.temperatura_c === undefined) continue;
    if (farmDay(r.fecha) !== hoy) continue;
    const prev = medidaHoy.get(r.bandeja_id);
    if (!prev || String(r.fecha) > String(prev.fecha)) medidaHoy.set(r.bandeja_id, r);
  }
  const aMedir = activas.filter(b => diasControl.has(b.dia_ciclo) && !b.tiene_ayuno && !medidaHoy.has(b.id))
    .sort(porCodigo);
  if (aMedir.length) {
    items.push({ tipo: 'temperatura', estado: 'hoy', dias: 0, bandeja_ids: aMedir.map(b => b.id),
                 titulo: `Temperatura de cama · ${cuantas(aMedir.length)}`,
                 detalle: `${etiquetas(aMedir)} · máximo ${num(max)} °C` });
  }
  const altas = activas.filter(b => medidaHoy.has(b.id) && Number(medidaHoy.get(b.id).temperatura_c) > max)
    .sort(porCodigo);
  if (altas.length) {
    items.push({ tipo: 'temperatura_alta', estado: 'alerta', dias: 0, bandeja_ids: altas.map(b => b.id),
                 titulo: `Cama sobre ${num(max)} °C · ${cuantas(altas.length)}`,
                 detalle: altas.map(b => `${b.id_bandeja} ${num(medidaHoy.get(b.id).temperatura_c)} °C`).join(', ') });
  }

  /* ensilaje due to be ready */
  for (const e of ensilajes) {
    if (e.deleted_at || ensilajeEstado(e) !== 'fermentando' || !e.sellado_at) continue;
    const previsto = addDays(farmDay(e.sellado_at), cfg.dias_fermentacion);
    const faltan = daysBetween(hoy, previsto);
    if (faltan === null || faltan > horizonte) continue;
    items.push({
      tipo: 'ensilaje', estado: faltan <= 0 ? 'hoy' : 'proximo', dias: faltan <= 0 ? 0 : -faltan,
      ensilaje_id: e.id, listo_previsto: previsto,
      titulo: `${e.codigo} listo para usar`,
      detalle: faltan < 0 ? `Según el plan, desde hace ${faltan === -1 ? '1 día' : `${-faltan} días`}`
             : 'Según los días de fermentación del plan'
    });
  }

  /* does the feed at hand cover the loads coming? */
  if (stock) {
    const debidas = items.some(i => i.tipo === 'carga' && i.estado !== 'proximo');
    const usaAlimento = ensilajes.some(e => !e.deleted_at);
    if (usaAlimento && stock.kg_cargas_proximas > 0 && !stock.alcanza) {
      const falta = Math.round((stock.kg_cargas_proximas - stock.ensilaje_disponible_kg) * 100) / 100;
      items.push({ tipo: 'stock', estado: 'alerta', dias: 0,
                   titulo: 'El ensilaje listo no alcanza',
                   detalle: `Cargas de los próximos ${stock.dias_prevision} días: ${num(stock.kg_cargas_proximas)} kg; ` +
                            `listos ${num(stock.ensilaje_disponible_kg)} kg (faltan ${num(falta)})` });
    } else if (!stock.ensilaje_en_uso && debidas) {
      // Not a fault: the trays still get fed. It only means the stock will not move.
      items.push({ tipo: 'sin_ensilaje', estado: 'hoy', dias: 0,
                   titulo: 'Ningún ensilaje en uso',
                   detalle: 'Las cargas de hoy no descontarán del stock: marca en Alimento cuál se usa.' });
    }
  }

  items.sort((a, b) => (RANK[a.estado] - RANK[b.estado]) || (b.dias - a.dias) ||
                       (TIPO_ORDEN.indexOf(a.tipo) - TIPO_ORDEN.indexOf(b.tipo)));
  for (const it of items) it.cuando = cuandoItem(it);

  const resumen = { alerta: 0, atrasado: 0, hoy: 0, proximo: 0 };
  for (const it of items) resumen[it.estado]++;
  resumen.pendientes = resumen.alerta + resumen.atrasado + resumen.hoy;
  return { hoy, items, resumen };
}
