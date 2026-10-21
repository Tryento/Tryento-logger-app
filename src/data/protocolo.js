/**
 * protocolo.js — the lab's protocols (October 2026): their settings, the day
 * count, and what each object needs next.
 *
 *   día 0        recolecta → incubadora
 *   día 3        chequeo de la incubadora
 *   día 7        tamizado, pesado y distribución en cajas + carga 1
 *   día 10       chequeo, y después la carga 2
 *   día 13       carga 3
 *   día 14       chequeo; empieza el ayuno (no más cargas)
 *   día 16       separación (orientativa): 98 % al horno, 2 % de vuelta
 *
 *   insectario   repoblado → recolectas lun/mié/vie → cierre (~14 días)
 *                → limpieza → repoblado
 *   alimento     ensilado → 21 días de maduración → apertura → 72 h de consumo
 *
 * Every number lives in the `parametro` table so the lab can change the
 * protocol without a new version of the app. The defaults below are the SAME
 * values 0010_ciclo_nuevo.sql seeds, so a phone that has not pulled yet still
 * does the right thing.
 *
 * Everything here is pure: no storage, no clock unless one is passed in. Days
 * are the FARM's calendar days (time.js), never the phone's time zone.
 */
import { farmDay, daysBetween, addDays } from './time.js';

export const PROTOCOLO_DEFAULTS = Object.freeze({
  dia_chequeo_incubadora: 3,
  dia_distribucion: 7,
  dias_chequeo_caja: [10, 14],
  cargas: [
    { n: 1, dia: 7, kg: 1.5 },
    { n: 2, dia: 10, kg: 2 },
    { n: 3, dia: 13, kg: 2 }
  ],
  dia_inicio_ayuno: 14,
  dia_separacion: 16,
  pct_coccion: 98,
  kg_bandeja_pupacion: 4.7,
  dias_ciclo_jaula: 14,
  dias_recolecta: [1, 3, 5],
  dias_maduracion: 21,
  horas_consumo: 72,
  alimento_inicial_incubadora_kg: null
});

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isDia = v => isNum(v) && Number.isInteger(v) && v >= 0 && v <= 365;

/** A settings value is only used if it has the right shape; otherwise the
 *  default stands. A typo in the Supabase table editor must not break a form. */
const VALIDATORS = {
  dia_chequeo_incubadora: isDia,
  dia_distribucion: isDia,
  dias_chequeo_caja: v => Array.isArray(v) && v.every(isDia),
  cargas: v => Array.isArray(v) && v.length > 0 &&
    v.every(c => c && isNum(c.n) && isDia(c.dia) && isNum(c.kg) && c.kg >= 0),
  dia_inicio_ayuno: isDia,
  dia_separacion: isDia,
  pct_coccion: v => isNum(v) && v >= 0 && v <= 100,
  kg_bandeja_pupacion: v => isNum(v) && v > 0 && v < 100,
  dias_ciclo_jaula: isDia,
  dias_recolecta: v => Array.isArray(v) && v.every(d => Number.isInteger(d) && d >= 1 && d <= 7),
  dias_maduracion: isDia,
  horas_consumo: v => isNum(v) && v > 0 && v <= 24 * 30,
  alimento_inicial_incubadora_kg: v => v === null || (isNum(v) && v >= 0 && v < 1000)
};

/**
 * Settings from `parametro` rows ({clave, valor}), over the defaults.
 * Unknown keys are ignored; malformed values fall back to the default.
 */
export function mergeProtocolo(rows = []) {
  const out = JSON.parse(JSON.stringify(PROTOCOLO_DEFAULTS));
  for (const r of rows || []) {
    if (!r || r.deleted_at || !(r.clave in VALIDATORS)) continue;
    let v = r.valor;
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch { continue; }
    }
    if (v === undefined) continue;
    if (VALIDATORS[r.clave](v)) out[r.clave] = v;
  }
  out.cargas = [...out.cargas].sort((a, b) => a.n - b.n);
  out.dias_chequeo_caja = [...out.dias_chequeo_caja].sort((a, b) => a - b);
  return out;
}

/* ── numbers ──────────────────────────────────────────────────────────────── */

/**
 * A separación's split, exactly as the database computes it
 * (round(peso * pct / 100, 3)). In whole grams, so the phone never shows a
 * gram the server rounds the other way: 0.125 kg at 98 % is 0.1225, which
 * Postgres rounds up and floating point would round down.
 */
export function repartoSeparacion(pesoKg, pct = PROTOCOLO_DEFAULTS.pct_coccion) {
  const g = Math.round(Number(pesoKg) * 1000);
  const p = Math.round(Number(pct) * 100);
  if (!Number.isFinite(g) || !Number.isFinite(p)) return { coccion_kg: null, retorno_kg: null };
  const coccionG = Math.floor((g * p + 5000) / 10000);
  return { coccion_kg: coccionG / 1000, retorno_kg: (g - coccionG) / 1000 };
}

/** Kilos, rounded to the gram, without floating-point dust (0.1 + 0.2). */
export const kg3 = v => Math.round(Number(v || 0) * 1000) / 1000;

/* ── days ─────────────────────────────────────────────────────────────────── */

/** Days since día 0, in farm days. */
export function diaCiclo(dia0, hoy = farmDay()) {
  if (!dia0) return null;
  return daysBetween(String(dia0).slice(0, 10), String(hoy).slice(0, 10));
}

/** 1 = Monday … 7 = Sunday, for a `YYYY-MM-DD` farm day. */
export function diaSemana(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dia));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay() || 7;
}

/**
 * How a due day relates to today: 'proximo' (in the future), 'hoy' or
 * 'atrasado', with the distance in days (positive = late).
 */
export function timing(vence, hoy = farmDay()) {
  const dias = daysBetween(vence, hoy);
  return { vence, dias, estado: dias < 0 ? 'proximo' : dias === 0 ? 'hoy' : 'atrasado' };
}

export const cargaDef = (cfg, n) => (cfg?.cargas || []).find(c => c.n === Number(n)) || null;

/** The cargas that are steps of their own: all but the one given with the
 *  distribución (día 7). */
export const cargasDeCaja = cfg =>
  (cfg?.cargas || []).filter(c => c.dia !== cfg.dia_distribucion);

/** The carga given with the distribución, if the plan has one that day. */
export const cargaDistribucion = cfg =>
  (cfg?.cargas || []).find(c => c.dia === cfg.dia_distribucion) || null;

/* ── next steps ───────────────────────────────────────────────────────────── */

/**
 * Steps of an incubadora still to do, in order. Each is
 *   { paso, dia, vence, dias, estado, aviso }
 * where `aviso` says whether "para hoy" should chase it. A step due before the
 * incubadora was entered (a recolecta registered late, with the excepción
 * switch) is not chased; the distribución stays doable from its page anyway.
 *
 *   inc:      { dia0, created_at, estado }
 *   chequeos: the incubadora's chequeos
 */
export function pasosIncubadora(inc, { chequeos = [] } = {}, cfg = PROTOCOLO_DEFAULTS, hoy = farmDay()) {
  if (!inc || inc.estado === 'inactivo' || inc.cerrado_at || !inc.dia0) return [];
  const entrada = farmDay(inc.created_at) || inc.dia0;
  const out = [];
  const paso = (p, dia, extra = {}) => {
    const vence = addDays(inc.dia0, dia);
    out.push({ paso: p, dia, ...timing(vence, hoy), aviso: vence >= entrada, ...extra });
  };
  const hechos = new Set(chequeos.filter(c => !c.deleted_at).map(c => Number(c.dia)));
  const diaChequeo = cfg.dia_chequeo_incubadora;
  if (!hechos.has(diaChequeo) && addDays(inc.dia0, diaChequeo) >= entrada) paso('chequeo', diaChequeo);
  paso('distribucion', cfg.dia_distribucion);
  return out;
}

/**
 * Steps of a caja de engorde still to do, in order, on its incubadora's
 * calendar. Rules:
 *   - a carga on a chequeo day waits for that chequeo (día 10: chequeo first);
 *   - the chequeo on `dia_inicio_ayuno` starts the ayuno: no cargas after it;
 *   - a chequeo stops being asked once a later one, or the separación, is in;
 *   - steps due before the caja was entered are not asked at all.
 *
 *   caja:  { estado, created_at }
 *   dia0:  its incubadora's día 0
 *   chequeos, cargas: the caja's own
 */
export function pasosCaja(caja, { dia0, chequeos = [], cargas = [], separada = false } = {},
                          cfg = PROTOCOLO_DEFAULTS, hoy = farmDay()) {
  if (!caja || caja.estado === 'inactivo' || caja.cerrado_at || separada || !dia0) return [];
  const entrada = farmDay(caja.created_at) || hoy;
  const vence = dia => addDays(dia0, dia);
  const chequeados = new Set(chequeos.filter(c => !c.deleted_at).map(c => Number(c.dia)));
  const dadas = new Set(cargas.filter(c => !c.deleted_at).map(c => Number(c.carga)));
  const ultimoChequeo = Math.max(-1, ...chequeados);
  const enAyuno = chequeados.has(cfg.dia_inicio_ayuno);

  const pasos = [];
  for (const dia of cfg.dias_chequeo_caja) {
    if (chequeados.has(dia) || dia < ultimoChequeo || vence(dia) < entrada) continue;
    pasos.push({ paso: 'chequeo', dia, orden: dia * 2,
                 ayuno: dia === cfg.dia_inicio_ayuno });
  }
  if (!enAyuno) {
    for (const c of cargasDeCaja(cfg)) {
      if (dadas.has(c.n) || c.dia >= cfg.dia_inicio_ayuno || vence(c.dia) < entrada) continue;
      const espera = cfg.dias_chequeo_caja.includes(c.dia) && !chequeados.has(c.dia);
      pasos.push({ paso: 'carga', dia: c.dia, carga: c.n, kg: c.kg, orden: c.dia * 2 + 1,
                   bloqueado: espera ? 'chequeo' : null });
    }
  }
  pasos.push({ paso: 'separacion', dia: cfg.dia_separacion, orden: cfg.dia_separacion * 2 + 1 });

  return pasos
    .sort((a, b) => a.orden - b.orden)
    .map(({ orden, ...p }) => ({ ...p, ...timing(vence(p.dia), hoy), aviso: !p.bloqueado }));
}

/**
 * A cage's phase and generation from its own registries — the same rule as
 * app.recalcular_jaula in 0010, so a phone and the server never disagree:
 * the latest ingreso, cierre or limpieza decides; with none, how the cage was
 * registered.
 */
export function estadoJaula(jaula, { ingresos = [], eventos = [] } = {}) {
  if (!jaula) return null;
  const vivos = [
    ...ingresos.filter(i => !i.deleted_at).map(i => ({ fase: 'activa', fecha: i.fecha, created_at: i.created_at, ingreso: i })),
    ...eventos.filter(e => !e.deleted_at).map(e => ({
      fase: e.tipo === 'cierre' ? 'cerrada' : 'limpia', fecha: e.fecha, created_at: e.created_at, evento: e }))
  ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)) ||
                   String(b.created_at).localeCompare(String(a.created_at)));
  const ultimoIngreso = vivos.find(v => v.ingreso)?.ingreso || null;
  const fase = vivos[0]?.fase || jaula.fase_inicial;
  return {
    fase,
    estado: fase === 'activa' ? 'activo' : 'inactivo',
    generacion: ultimoIngreso ? Number(ultimoIngreso.generacion) : Number(jaula.generacion_inicial),
    ciclo_desde: ultimoIngreso ? farmDay(ultimoIngreso.fecha) : null,
    ultimo: vivos[0] || null
  };
}

/**
 * Steps of a cage. With flies: the recolecta on its weekdays (today's, and the
 * next one coming), and the cierre ~14 days into a cycle the app saw begin — a
 * cage that already had flies when the app started gets its cierre reminder
 * from its next cycle. Closed: the limpieza. Clean: repopulate, when there is
 * 2 % waiting.
 *
 *   recolectasHoy: whether this cage already gave a recolecta today
 */
export function pasosJaula(jaula, est, { recolectasHoy = false, poolKg = 0 } = {},
                           cfg = PROTOCOLO_DEFAULTS, hoy = farmDay()) {
  if (!jaula || !est) return [];
  const out = [];
  if (est.fase === 'activa') {
    const dias = cfg.dias_recolecta || [];
    for (let k = 0; k <= 2; k++) {
      const dia = addDays(hoy, k);
      if (!dias.includes(diaSemana(dia))) continue;
      if (k === 0 && recolectasHoy) continue;
      out.push({ paso: 'recolecta', ...timing(dia, hoy), aviso: true });
      break;
    }
    if (est.ciclo_desde) {
      out.push({ paso: 'cierre', ...timing(addDays(est.ciclo_desde, cfg.dias_ciclo_jaula), hoy), aviso: true });
    }
  } else if (est.fase === 'cerrada') {
    out.push({ paso: 'limpieza', ...timing(farmDay(est.ultimo?.fecha) || hoy, hoy), aviso: true });
  } else if (est.fase === 'limpia') {
    out.push({ paso: 'repoblado', ...timing(hoy, hoy), aviso: poolKg > 0 });
  }
  return out;
}

/** What is left of a cochada: the mid reading, then the final one. */
export function pasosCochada(cochada, { lecturas = [] } = {}, hoy = farmDay()) {
  if (!cochada || cochada.estado === 'inactivo' || cochada.cerrado_at) return [];
  const hechas = new Set(lecturas.filter(l => !l.deleted_at).map(l => l.momento));
  if (hechas.has('final')) return [];
  const dia = farmDay(cochada.horno_at) || hoy;
  const out = [];
  if (!hechas.has('media')) out.push({ paso: 'lectura_media', ...timing(dia, hoy), aviso: true });
  out.push({ paso: 'lectura_final', ...timing(dia, hoy), aviso: hechas.has('media') });
  return out;
}

/* ── words ────────────────────────────────────────────────────────────────── */

const kgTxt = v => String(v).replace('.', ',');

/** Short Spanish label for a step, e.g. "Carga 2 · 2 kg". */
export function pasoLabel(p) {
  if (!p) return '';
  switch (p.paso) {
    case 'chequeo': return `Chequeo día ${p.dia}${p.ayuno ? ' (inicia el ayuno)' : ''}`;
    case 'distribucion': return 'Tamizado, pesado y distribución';
    case 'carga': return `Carga ${p.carga} · ${kgTxt(p.kg)} kg${p.bloqueado ? ' (después del chequeo)' : ''}`;
    case 'separacion': return 'Separación';
    case 'recolecta': return 'Recolecta';
    case 'cierre': return 'Cierre de la jaula';
    case 'limpieza': return 'Limpieza de la jaula';
    case 'repoblado': return 'Repoblar con el 2 %';
    case 'lectura_media': return 'Temperatura a mitad del horno';
    case 'lectura_final': return 'Temperatura y peso final';
    case 'apertura': return 'Abrir el ensilado';
    case 'consumo': return 'Consumir el ensilado abierto';
    default: return '';
  }
}

/** "hoy", "mañana", "en 2 días", "atrasado 1 día". */
export function cuandoLabel(p) {
  if (!p) return '';
  const n = Math.abs(p.dias);
  const d = n === 1 ? 'día' : 'días';
  if (p.estado === 'hoy') return 'hoy';
  if (p.estado === 'proximo') return n === 1 ? 'mañana' : `en ${n} ${d}`;
  return `atrasado ${n} ${d}`;
}
