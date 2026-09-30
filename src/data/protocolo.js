/**
 * protocolo.js — the v2 production protocol: its settings, and what is due.
 *
 * The lab's protocol is a fixed recipe on a fixed calendar ("Régimen de
 * alimentación optimizado, ciclo de 16 días"). Día 0 is the day the incubadora
 * starts:
 *
 *   día 7        distribución en bandejas + carga 1 (1,5 kg)
 *   día 10       carga 2 (2 kg) + tamizado de control
 *   día 13       carga 3 (2 kg)
 *   días 14–15   ayuno
 *   día 16       cosecha
 *
 * Every number lives in the `parametro` table so the lab can change the
 * protocol without a new version of the app. The defaults below are the SAME
 * values 0007_protocolo_v2.sql seeds, so a phone that has not pulled yet still
 * does the right thing.
 *
 * Everything here is pure: no storage, no clock unless one is passed in. The
 * cycle day comes from `time.js`, i.e. the FARM's calendar day, never the
 * phone's time zone.
 */
import { farmDay, daysBetween } from './time.js';

export const PROTOCOLO_DEFAULTS = Object.freeze({
  dias_incubacion: 7,
  cargas: [
    { n: 1, dia: 7, kg: 1.5 },
    { n: 2, dia: 10, kg: 2.0, tamizado: true },
    { n: 3, dia: 13, kg: 2.0 }
  ],
  dia_inicio_ayuno: 14,
  horas_ayuno: 48,
  dia_cosecha: 16,
  individuos_por_bandeja: 25000,
  reserva_cria_pct: 2,
  letras_insectario: { ICA: 'A', ICB: 'B', ICC: 'C', JN3A: 'J' },
  fecha_corte: null
});

/** What v2 feeding records as the food, so NOT NULL and existing views hold. */
export const ALIMENTO_V2 = 'Ensilaje';

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isDay = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** A settings value is only used if it has the right shape; otherwise the
 *  default stands. A typo in the Supabase table editor must not break feeding. */
const VALIDATORS = {
  dias_incubacion: v => isNum(v) && v >= 0,
  cargas: v => Array.isArray(v) && v.length > 0 &&
    v.every(c => c && isNum(c.n) && isNum(c.dia) && isNum(c.kg) && c.kg >= 0),
  dia_inicio_ayuno: v => isNum(v) && v >= 0,
  horas_ayuno: v => isNum(v) && v >= 1 && v <= 168,
  dia_cosecha: v => isNum(v) && v >= 0,
  individuos_por_bandeja: v => isNum(v) && v >= 0,
  reserva_cria_pct: v => isNum(v) && v >= 0 && v <= 100,
  letras_insectario: v => v && typeof v === 'object' && !Array.isArray(v),
  fecha_corte: v => v === null || isDay(v)
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
    if (typeof v === 'string' && r.clave !== 'fecha_corte') {
      try { v = JSON.parse(v); } catch { continue; }
    }
    if (VALIDATORS[r.clave](v)) out[r.clave] = v;
  }
  out.cargas = [...out.cargas].sort((a, b) => a.n - b.n);
  return out;
}

/** Whether new recolectas follow v2 today. No cutover date means it already applies. */
export function v2Vigente(cfg, hoy = farmDay()) {
  return !cfg?.fecha_corte || String(hoy) >= String(cfg.fecha_corte);
}

/** Day of the cycle, counted from the incubadora's día 0, in farm days. */
export function diaCiclo(fechaInicio, hoy = farmDay()) {
  if (!fechaInicio) return null;
  const d = daysBetween(String(fechaInicio).slice(0, 10), String(hoy).slice(0, 10));
  return d === null ? null : d;
}

export const cargaDef = (cfg, n) => (cfg?.cargas || []).find(c => c.n === Number(n)) || null;

/**
 * How a due date relates to today: 'proximo' (in the future), 'hoy', or
 * 'atrasado', plus the distance in days (positive = late).
 */
function timing(dia, diaObjetivo) {
  const delta = dia - diaObjetivo;
  return { dia_objetivo: diaObjetivo, dias: delta,
           estado: delta < 0 ? 'proximo' : delta === 0 ? 'hoy' : 'atrasado' };
}

/**
 * The next step for a v2 bandeja, or null when there is nothing left to do.
 *
 *   tray: { dia_ciclo, cargas_dadas: number[], tiene_ayuno: bool, cosechada: bool }
 *
 * A missed carga stops being actionable once the fast is due: the protocol
 * fasts on día 14 regardless, so from then on the next step is the fast.
 */
export function siguientePaso(tray, cfg = PROTOCOLO_DEFAULTS) {
  if (!tray || tray.cosechada) return null;
  const dia = tray.dia_ciclo;
  if (dia === null || dia === undefined) return null;

  const dadas = new Set((tray.cargas_dadas || []).map(Number));

  if (!tray.tiene_ayuno && dia < cfg.dia_inicio_ayuno) {
    const pendiente = cfg.cargas.find(c => !dadas.has(c.n));
    if (pendiente) {
      return { paso: 'carga', carga: pendiente.n, kg: pendiente.kg,
               tamizado: Boolean(pendiente.tamizado), ...timing(dia, pendiente.dia) };
    }
  }
  if (!tray.tiene_ayuno) {
    return { paso: 'ayuno', ...timing(dia, cfg.dia_inicio_ayuno) };
  }
  return { paso: 'cosecha', ...timing(dia, cfg.dia_cosecha) };
}

/** When an incubadora is due to be split into bandejas. */
export function pasoIncubadora(inc, cfg = PROTOCOLO_DEFAULTS, hoy = farmDay()) {
  if (!inc || inc.distribuida_at) return null;
  const dia = diaCiclo(inc.fecha_inicio, hoy);
  if (dia === null) return null;
  return { paso: 'distribucion', ...timing(dia, cfg.dias_incubacion) };
}

/** Short Spanish label for a step, e.g. "Carga 2 · 2 kg". */
export function pasoLabel(p) {
  if (!p) return '';
  const kg = v => String(v).replace('.', ',');
  if (p.paso === 'carga') return `Carga ${p.carga} · ${kg(p.kg)} kg`;
  if (p.paso === 'ayuno') return 'Iniciar ayuno';
  if (p.paso === 'cosecha') return 'Cosechar';
  if (p.paso === 'distribucion') return 'Distribuir en bandejas';
  return '';
}

/** "hoy", "en 2 días", "atrasado 1 día". */
export function cuandoLabel(p) {
  if (!p) return '';
  const n = Math.abs(p.dias);
  const d = n === 1 ? 'día' : 'días';
  if (p.estado === 'hoy') return 'hoy';
  if (p.estado === 'proximo') return n === 1 ? 'mañana' : `en ${n} ${d}`;
  return `atrasado ${n} ${d}`;
}
