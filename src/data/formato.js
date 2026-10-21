/**
 * formato.js — numbers and dates as the lab reads them: a decimal comma, and
 * the FARM's clock whatever the phone's time zone says.
 */
import { farmDay, toNaiveLocal } from './time.js';

/** 1.5 → "1,5"; up to three decimals, none if whole. */
export function kgTxt(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Math.round(Number(v) * 1000) / 1000;
  return Number.isFinite(n) ? String(n).replace('.', ',') : '—';
}

/** "2026-10-20" → "20/10". */
export function diaTxt(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dia || ''));
  return m ? `${m[3]}/${m[2]}` : '—';
}

/** An instant → "20/10 14:30", in farm time. */
export function fechaHoraTxt(iso) {
  const naive = iso ? toNaiveLocal(iso) : null;
  if (!naive) return '—';
  return `${diaTxt(naive.slice(0, 10))} ${naive.slice(11, 16)}`;
}

/** An instant → "hoy 14:30", "ayer 09:10" or "18/10 14:30". */
export function cuandoTxt(iso, hoy = farmDay()) {
  const naive = iso ? toNaiveLocal(iso) : null;
  if (!naive) return '—';
  const dia = naive.slice(0, 10), hora = naive.slice(11, 16);
  if (dia === hoy) return `hoy ${hora}`;
  const ayer = new Date(Date.parse(`${hoy}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (dia === ayer) return `ayer ${hora}`;
  return `${diaTxt(dia)} ${hora}`;
}

/** The weekday, "lun"…"dom", of a farm day. */
export function semanaTxt(dia) {
  try {
    return new Intl.DateTimeFormat('es-VE', { timeZone: 'UTC', weekday: 'short' })
      .format(new Date(`${dia}T12:00:00Z`)).replace('.', '');
  } catch { return ''; }
}
