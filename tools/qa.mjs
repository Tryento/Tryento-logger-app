/**
 * qa.mjs — the rows the checks write into the live database, and how they go.
 *
 * check-backend and check-sync register everything under their own name
 * (registrado_por), and a call's child rows inherit it, so a test row is
 * simply one registered by a name no person uses. cleanup-qa uses the same
 * list and order.
 *
 * Rows are MARKED deleted (deleted_at), never erased at once: phones pull
 * changes by updated_at, and an erased row leaves nothing to pull, so a phone
 * that had it would keep it forever. `cleanup-qa --purge` erases them a week
 * later, when every phone has seen the mark.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Names the checks register under. */
export const NOMBRES_QA = ['check-backend', 'check-sync'];

/** Children before parents, so nothing alive ever points at a deleted row. */
export const ORDEN = [
  'cochada_lectura', 'cochada_origen', 'cochada', 'movimiento', 'separacion', 'alimentacion',
  'chequeo', 'caja', 'distribucion', 'bandeja_pupacion', 'ingreso', 'jaula_evento', 'incubadora',
  'ensilado_insumo', 'ensilado', 'recepcion', 'jaula', 'contenedor', 'rack'
];

export async function loadConfig() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    return { supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
             dbSchema: 'app', storageBucket: 'fotos' };
  }
  const src = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.__TRYENTO_CONFIG__ || {};
}

/** Every row registered by these names, per table: { tabla: [{ id, deleted_at }] }. */
export async function filasQa(db, nombres = NOMBRES_QA) {
  const out = {};
  for (const t of ORDEN) {
    const { data, error } = await db.from(t).select('id, deleted_at').in('registrado_por', nombres);
    out[t] = error ? [] : (data || []);
  }
  return out;
}

/** Mark them deleted, children first. Returns how many could not be marked. */
export async function marcarQa(db, nombres = NOMBRES_QA) {
  const filas = await filasQa(db, nombres);
  const now = new Date().toISOString();
  let quedan = 0;
  for (const t of ORDEN) {
    const ids = filas[t].filter(r => !r.deleted_at).map(r => r.id);
    if (!ids.length) continue;
    const { error } = await db.from(t).update({ deleted_at: now }).in('id', ids);
    if (error) { quedan += ids.length; console.log(`        no se pudo marcar ${t}: ${error.message}`); }
  }
  return quedan;
}
