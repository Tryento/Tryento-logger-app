/**
 * registros.js — what can be corrected in each record, and how a typed value
 * becomes a stored one.
 *
 * MIRRORS app.editar in supabase/esquema/0011: the same tables and the same
 * fields. A field listed here and not there is refused by the server; a test
 * keeps the two lists equal. Codes are never editable: they are what is
 * written on the container.
 *
 * Each field: [column, kind, label]. The kinds say how a typed value is read
 * and checked; the edit form uses them to show the right input.
 */
import { num, str } from './envelope.js';
import { utcIso } from './time.js';

export const EDITABLE = {
  contenedor:       { titulo: 'Contenedor', campos: [['codigo', 'codigo', 'Código']] },
  jaula:            { titulo: 'Insectario', campos: [
                        ['nombre', 'codigo', 'Nombre'], ['letra', 'letra', 'Letra del código'],
                        ['lugar', 'texto', 'Lugar'], ['generacion_inicial', 'generacion', 'Generación al registrarlo'],
                        ['fase_inicial', 'fase', 'Estado al registrarlo']] },
  recepcion:        { titulo: 'Recepción', campos: [
                        ['fecha', 'fecha', 'Fecha'], ['material', 'material', 'Material'], ['kg', 'kg', 'Peso']] },
  ensilado:         { titulo: 'Ensilado', campos: [
                        ['ensilado_at', 'fecha', 'Fecha del ensilado'], ['abierto_at', 'fecha', 'Apertura']] },
  ensilado_insumo:  { titulo: 'Material del ensilado', campos: [['kg', 'kg', 'Peso']] },
  incubadora:       { titulo: 'Recolecta', campos: [
                        ['jaula_id', 'jaula', 'Insectario'], ['generacion', 'generacion', 'Generación'],
                        ['recolecta_at', 'fecha', 'Fecha de la recolecta'],
                        ['peso_inicial_g', 'g', 'Peso inicial (huevos/larvas)'],
                        ['n_bandejas', 'bandejas', 'Bandejas'],
                        ['alimento_inicial_kg', 'kg', 'Alimento inicial, en total']] },
  distribucion:     { titulo: 'Distribución', campos: [
                        ['fecha', 'fecha', 'Fecha'], ['peso_total_kg', 'kg', 'Larvas tamizadas']] },
  caja:             { titulo: 'Caja de engorde', campos: [['peso_inicial_kg', 'kg', 'Peso inicial']] },
  chequeo:          { titulo: 'Chequeo', campos: [
                        ['fecha', 'fecha', 'Fecha'], ['humedad_pct', 'pct', 'Humedad del sustrato'],
                        ['temperatura_c', 'temp', 'Temperatura del sustrato'],
                        ['peso_g', 'g', 'Peso'], ['peso_kg', 'kg', 'Peso']] },
  alimentacion:     { titulo: 'Carga', campos: [['fecha', 'fecha', 'Fecha'], ['kg', 'kg', 'Peso']] },
  separacion:       { titulo: 'Separación', campos: [['fecha', 'fecha', 'Fecha'], ['peso_total_kg', 'kg', 'Peso total']] },
  cochada:          { titulo: 'Cochada', campos: [
                        ['horno_at', 'fecha', 'Al horno'], ['peso_inicial_kg', 'kg', 'Peso inicial']] },
  cochada_origen:   { titulo: 'Origen de la cochada', campos: [['kg', 'kg', 'Peso']] },
  cochada_lectura:  { titulo: 'Lectura del horno', campos: [
                        ['fecha', 'fecha', 'Fecha'], ['temperatura_c', 'horno', 'Temperatura'], ['peso_kg', 'kg', 'Peso final']] },
  ingreso:          { titulo: 'Ingreso al insectario', campos: [
                        ['fecha', 'fecha', 'Fecha'], ['kg_larvas', 'kg', 'Larvas del 2 %'],
                        ['generacion', 'generacion', 'Generación del insectario']] },
  bandeja_pupacion: { titulo: 'Bandeja de pupación', campos: [['peso_kg', 'kg', 'Peso']] },
  jaula_evento:     { titulo: 'Cierre o limpieza', campos: [['fecha', 'fecha', 'Fecha']] }
};

/** Always editable, on every record: they are not values ("revisar" ignores them). */
export const SIEMPRE = ['nota', 'foto_key'];

/** The fields of a table the edit form shows: a chequeo shows the weight in
 *  the unit of its object; an ensilado's apertura only once it was opened —
 *  opening is the button's job, which records who did it and keeps día 21. */
export function camposDe(tabla, row) {
  const def = EDITABLE[tabla];
  if (!def) return [];
  return def.campos.filter(([col]) => {
    if (tabla === 'ensilado' && col === 'abierto_at') return Boolean(row?.abierto_at);
    if (tabla !== 'chequeo') return true;
    if (col === 'peso_g') return Boolean(row?.incubadora_id);
    if (col === 'peso_kg') return Boolean(row?.caja_id);
    return true;
  });
}

/** Typed value → stored value, or { error }. `ctx` knows the lists to check
 *  against (insectarios, materials). */
export function leerCampo(kind, v, ctx = {}) {
  const n = num(v);
  switch (kind) {
    case 'codigo':
    case 'texto': {
      const s = str(v);
      if (kind === 'codigo' && !s) return { error: 'No puede quedar vacío.' };
      return { value: s };
    }
    case 'letra': {
      const s = str(v).toUpperCase();
      if (!/^[A-Z0-9]{1,3}$/.test(s)) return { error: 'De 1 a 3 letras o números.' };
      return { value: s };
    }
    case 'generacion':
      if (n === null || !Number.isInteger(n) || n < 0) return { error: 'Un número entero (la F).' };
      return { value: n };
    case 'bandejas':
      if (n === null || !Number.isInteger(n) || n < 1) return { error: 'Un número entero, desde 1.' };
      return { value: n };
    case 'fase':
      if (!['activa', 'limpia'].includes(v)) return { error: 'Con moscas o limpio.' };
      return { value: v };
    case 'kg':
    case 'g':
      if (n === null || n < 0) return { error: `Escribe un peso en ${kind}.` };
      return { value: n };
    case 'pct':
      if (n === null || n < 0 || n > 100) return { error: 'Entre 0 y 100 %.' };
      return { value: n };
    case 'temp':
      if (n === null || n < -10 || n > 90) return { error: 'Una temperatura entre -10 y 90 °C.' };
      return { value: n };
    case 'horno':
      if (n === null || n < -10 || n > 400) return { error: 'Una temperatura entre -10 y 400 °C.' };
      return { value: n };
    case 'fecha': {
      if (v === null || v === '') return { value: null };
      const iso = utcIso(v);
      return iso ? { value: iso } : { error: 'Fecha no válida.' };
    }
    case 'jaula':
      if (!(ctx.jaulas || []).some(j => j.id === v)) return { error: 'Elige un insectario.' };
      return { value: v };
    case 'material':
      if (!(ctx.materiales || []).includes(v)) return { error: 'Elige un material de la lista.' };
      return { value: v };
    default:
      return { error: 'Campo desconocido.' };
  }
}
