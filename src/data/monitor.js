/**
 * monitor.js — "para hoy": what the protocols say is late, due today, or
 * coming in the next two days, across the whole lab.
 *
 * Each line says what to do and to which objects, and carries what the screen
 * needs to open the form for it already filled in. The steps of the cajas of
 * one incubadora are done together, so they come as one line.
 *
 * Pure: it reads a vista (vista.js), nothing else.
 */
import { pasoLabel, cuandoLabel, kg3 } from './protocolo.js';
import { daysBetween } from './time.js';
import { FARM_TZ } from './config.js';

const ORDEN = { atrasado: 0, hoy: 1, proximo: 2 };
const kgTxt = v => String(kg3(v)).replace('.', ',');

/**
 * @returns {{ items: Array, resumen: { atrasado, hoy, proximo } }}
 *   item: { clave, grupo, paso, titulo, detalle, estado, dias, cuando, accion }
 */
export function paraHoy(vista, { ventana = 2 } = {}) {
  const items = [];
  const add = it => {
    if (it.estado === 'proximo' && -it.dias > ventana) return;
    items.push({ ...it, cuando: it.cuando ?? cuandoLabel(it) });
  };

  for (const j of vista.jaulas) {
    for (const p of j.pasos) {
      if (!p.aviso) continue;
      add({
        clave: `jaula:${j.id}:${p.paso}`, grupo: 'insectario', paso: p.paso,
        titulo: `${pasoLabel(p)} · ${j.nombre}`,
        detalle: p.paso === 'repoblado' ? `2 % esperando: ${kgTxt(vista.pool.kg_pendiente)} kg`
               : p.paso === 'cierre' ? `Día ${j.dia_ciclo} del ciclo F${j.generacion}`
               : `F${j.generacion} · ${j.lugar || ''}`.trim(),
        estado: p.estado, dias: p.dias,
        accion: { tipo: p.paso, jaula_id: j.id }
      });
    }
  }

  for (const i of vista.incubadoras) {
    for (const p of i.pasos) {
      if (!p.aviso) continue;
      add({
        clave: `incubadora:${i.id}:${p.paso}`, grupo: 'larvas', paso: p.paso,
        titulo: `${pasoLabel(p)} · ${i.codigo}`,
        detalle: `Día ${i.dia}${i.rack ? ` · rack ${i.rack.codigo}` : ''}`,
        estado: p.estado, dias: p.dias,
        accion: { tipo: p.paso, incubadora_id: i.id, dia: p.dia }
      });
    }
  }

  // The cajas of one incubadora share a calendar: one line per step.
  const grupos = new Map();
  for (const c of vista.cajas) {
    for (const p of c.pasos) {
      if (!p.aviso) continue;
      const k = `${c.incubadora_id}:${p.paso}:${p.dia}:${p.carga ?? ''}`;
      if (!grupos.has(k)) grupos.set(k, { p, incubadora_id: c.incubadora_id, codigo: c.incubadora_codigo, cajas: [] });
      grupos.get(k).cajas.push(c);
    }
  }
  for (const g of grupos.values()) {
    const cajas = g.cajas.sort((a, b) => a.numero - b.numero);
    add({
      clave: `cajas:${g.incubadora_id}:${g.p.paso}:${g.p.dia}:${g.p.carga ?? ''}`, grupo: 'larvas', paso: g.p.paso,
      titulo: `${pasoLabel(g.p)} · ${g.codigo}`,
      detalle: `${cajas.length === 1 ? '1 caja' : `${cajas.length} cajas`}: ${cajas.map(c => c.codigo.slice(g.codigo.length + 1)).join(', ')}`,
      estado: g.p.estado, dias: g.p.dias,
      accion: { tipo: g.p.paso, caja_ids: cajas.map(c => c.id), dia: g.p.dia, carga: g.p.carga ?? null }
    });
  }

  for (const co of vista.cochadas) {
    for (const p of co.pasos) {
      if (!p.aviso) continue;
      add({
        clave: `cochada:${co.id}:${p.paso}`, grupo: 'horno', paso: p.paso,
        titulo: `${pasoLabel(p)} · ${co.codigo}`,
        detalle: `${kgTxt(co.peso_inicial_kg)} kg al horno`,
        estado: p.estado, dias: p.dias,
        accion: { tipo: p.paso, cochada_id: co.id }
      });
    }
  }

  const kgHorno = kg3(vista.horno.reduce((x, h) => x + h.kg_pendiente, 0));
  if (kgHorno > 0) {
    const n = vista.horno.filter(h => h.kg_pendiente > 0).length;
    add({
      clave: 'horno:pendiente', grupo: 'horno', paso: 'cochada',
      titulo: `98 % esperando el horno · ${kgTxt(kgHorno)} kg`,
      detalle: `De ${n === 1 ? '1 separación' : `${n} separaciones`}`,
      estado: 'hoy', dias: 0, accion: { tipo: 'cochada' }
    });
  }

  if (vista.pool.kg_pendiente > 0 && !vista.jaulas.some(j => j.fase === 'limpia')) {
    add({
      clave: 'pool:pendiente', grupo: 'insectario', paso: 'pool',
      titulo: `2 % esperando una jaula limpia · ${kgTxt(vista.pool.kg_pendiente)} kg`,
      detalle: 'Se repuebla una jaula cerrada y limpia',
      estado: 'hoy', dias: 0, accion: { tipo: 'pool' }
    });
  }

  for (const e of vista.ensilados) {
    for (const p of e.pasos) {
      add({
        clave: `ensilado:${e.id}:${p.paso}`, grupo: 'alimento', paso: p.paso,
        titulo: `${pasoLabel(p)} · ${e.codigo}`,
        detalle: p.paso === 'consumo'
          ? `Quedan ${kgTxt(e.kg_restante)} kg · vence ${p.vence_at ? horaLocal(p.vence_at) : ''}`.trim()
          : `${kgTxt(e.kg_total)} kg · día ${daysBetween(e.dia0, vista.hoy)} de maduración`,
        estado: p.estado, dias: p.dias,
        ...(p.paso === 'consumo' ? { cuando: `quedan ${p.horas} h` } : {}),
        accion: { tipo: p.paso, ensilado_id: e.id }
      });
    }
  }

  const nRevisar = vista.revisar.size;
  if (nRevisar) {
    add({
      clave: 'revisar', grupo: 'revisar', paso: 'revisar',
      titulo: nRevisar === 1 ? '1 registro para revisar' : `${nRevisar} registros para revisar`,
      detalle: 'Algo de lo que dependían se corrigió',
      estado: 'hoy', dias: 0, accion: { tipo: 'revisar' }
    });
  }

  // Most late first; then today; then the soonest coming.
  items.sort((a, b) => ORDEN[a.estado] - ORDEN[b.estado] || b.dias - a.dias ||
                       a.titulo.localeCompare(b.titulo));
  const resumen = { atrasado: 0, hoy: 0, proximo: 0 };
  for (const it of items) resumen[it.estado]++;
  return { items, resumen };
}

/** "vie 14:00" in the farm's time. */
export function horaLocal(iso) {
  try {
    return new Intl.DateTimeFormat('es-VE', { timeZone: FARM_TZ, weekday: 'short',
                                              hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .format(new Date(iso)).replace('.', '');
  } catch { return ''; }
}
