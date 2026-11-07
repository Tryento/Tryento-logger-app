/**
 * borrado.js — what deleting a record takes with it.
 *
 * In open mode staff can delete any record. What hangs off it goes too, because
 * a caja with no incubadora or a carga with no caja means nothing on any screen.
 * Rows are marked deleted (deleted_at), never erased: phones pull changes, and an
 * erased row would stay forever on a phone that already had it.
 *
 * Pure: it reads a vista (vista.js).
 */

const NOMBRES = {
  incubadora: ['incubadora', 'incubadoras'], distribucion: ['distribución', 'distribuciones'],
  caja: ['caja', 'cajas'], chequeo: ['chequeo', 'chequeos'], alimentacion: ['carga', 'cargas'],
  separacion: ['separación', 'separaciones'], cochada: ['cochada', 'cochadas'],
  cochada_origen: ['origen de cochada', 'orígenes de cochada'], cochada_lectura: ['lectura del horno', 'lecturas del horno'],
  ingreso: ['ingreso', 'ingresos'], bandeja_pupacion: ['bandeja de pupación', 'bandejas de pupación'],
  jaula_evento: ['cierre o limpieza', 'cierres o limpiezas'],
  ensilado: ['ensilado', 'ensilados'], ensilado_insumo: ['material de ensilado', 'materiales de ensilado']
};

function hijos(v, tabla, id) {
  const de = (t, rows, campo) => rows.filter(r => r[campo] === id).map(r => [t, r.id]);
  switch (tabla) {
    case 'jaula': return [...de('incubadora', v.incubadoras, 'jaula_id'), ...de('ingreso', v.ingresos, 'jaula_id'),
                          ...de('jaula_evento', v.eventos, 'jaula_id')];
    case 'incubadora': return [...de('chequeo', v.chequeos, 'incubadora_id'), ...de('distribucion', v.distribuciones, 'incubadora_id'),
                               ...de('caja', v.cajas, 'incubadora_id')];
    case 'distribucion': return de('caja', v.cajas, 'distribucion_id');
    case 'caja': return [...de('chequeo', v.chequeos, 'caja_id'), ...de('alimentacion', v.alimentaciones, 'caja_id'),
                         ...de('separacion', v.separaciones, 'caja_id')];
    case 'separacion': return de('cochada_origen', v.origenes, 'separacion_id');
    case 'cochada': return [...de('cochada_origen', v.origenes, 'cochada_id'), ...de('cochada_lectura', v.lecturas, 'cochada_id')];
    case 'ingreso': return de('bandeja_pupacion', v.bandejas, 'ingreso_id');
    case 'ensilado': return de('ensilado_insumo', v.insumos, 'ensilado_id');
    case 'recepcion': return de('ensilado_insumo', v.insumos, 'recepcion_id');
    default: return [];
  }
}

/** The record and everything that hangs off it: [{ tabla, id }], itself first. */
export function conDependientes(v, tabla, id) {
  const out = new Map();
  const add = (t, i) => {
    const k = `${t}:${i}`;
    if (out.has(k)) return;
    out.set(k, { tabla: t, id: i });
    for (const [ct, ci] of hijos(v, t, i)) add(ct, ci);
  };
  add(tabla, id);
  return [...out.values()];
}

/** The warning before deleting, in words. */
export function avisoBorrado(v, tabla, id) {
  const cuenta = new Map();
  for (const f of conDependientes(v, tabla, id).slice(1)) cuenta.set(f.tabla, (cuenta.get(f.tabla) || 0) + 1);
  const lista = [...cuenta].map(([t, n]) => `${n} ${NOMBRES[t]?.[n === 1 ? 0 : 1] || t}`);
  const partes = ['Deja de verse en todos los teléfonos.'];
  if (lista.length) partes.push(`También se borra: ${lista.join(', ')}.`);
  if (tabla === 'contenedor') {
    const n = v.ensilados.filter(e => e.contenedor_id === id && e.estado !== 'vencido').length;
    if (n) partes.push(`Tiene ${n === 1 ? 'un ensilado' : `${n} ensilados`} en uso.`);
  }
  return partes.join(' ');
}
