/**
 * snapshot.js — every synced row the phone holds, read once and reused.
 *
 * All the screens' reads start from the same picture of the lab (vista.js).
 * Reading twenty stores for each of them would be wasted work, so the rows are
 * kept until something changes them: a write on this phone (write.js and the
 * conflict inbox call invalidarSnapshot) or a pull that brought news
 * (status.js counts those).
 */
import { allRows } from './store.js';
import { STORES_VISTA, construirVista } from './vista.js';
import { mergeProtocolo } from './protocolo.js';
import { dataGeneration } from './status.js';
import { farmDay } from './time.js';

let _cache = null;
let _local = 0;

/** Something on this phone changed the rows: read them again next time. */
export function invalidarSnapshot() { _local++; }

/** { [store]: live rows } for every store a vista is built from. */
export async function filas(db) {
  const gen = dataGeneration();
  const local = _local;
  if (_cache && _cache.gen === gen && _cache.local === local) return _cache.rows;
  const rows = {};
  await Promise.all(STORES_VISTA.map(async st => { rows[st] = await allRows(db, st); }));
  _cache = { gen, local, rows };
  return rows;
}

/** The protocol settings this phone has, over the built-in defaults. */
export async function protocolo(db) {
  return mergeProtocolo((await filas(db)).parametro);
}

/** The lab as of now. */
export async function vistaActual(db, { hoy = farmDay(), ahora = Date.now() } = {}) {
  const rows = await filas(db);
  return construirVista(rows, mergeProtocolo(rows.parametro), { hoy, ahora });
}
