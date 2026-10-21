/**
 * conflicts.js — the inbox for writes the server refused.
 *
 * WHY THIS MUST EXIST BEFORE OFFLINE CAPTURE SHIPS: an optimistic write tells
 * the operator "Guardado" the instant they tap. If the server later rejects it
 * and nothing surfaces that, the app has lied — and the operator has no way to
 * find out, which is strictly worse than the AppSheet behaviour being replaced.
 *
 * The genuine cases are physical, and happen when two phones record the same
 * thing offline:
 *   - the same caja separated, or the same incubadora distributed, twice
 *   - two recolectas given the same code
 *   - a cage repopulated from two phones
 * In all of them the database is right and something already went wrong on the
 * floor, so the resolution is a human decision, never an automatic merge.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';
import { withIndexMirrors } from './idb/schema.js';
import { uuid } from './ids.js';
import { requeue, discard, rowsOf, STATUS, OPEN_STATUSES, STUCK_STATUSES } from './outbox.js';
import { ok, fail, CODES } from './envelope.js';

/** What a queued item saves, with its article, for sentences. */
const LABELS = {
  catalogo: 'el nombre',
  rack: 'el rack',
  contenedor: 'el contenedor',
  jaula: 'la jaula',
  recepcion: 'la recepción de material',
  ensilado: 'el ensilado',
  ensilado_insumo: 'el ensilado',
  incubadora: 'la recolecta',
  distribucion: 'la distribución',
  caja: 'la caja de engorde',
  chequeo: 'el chequeo',
  alimentacion: 'la carga de alimento',
  separacion: 'la separación',
  cochada: 'la cochada',
  cochada_origen: 'la cochada',
  cochada_lectura: 'la lectura del horno',
  ingreso: 'el ingreso al insectario',
  bandeja_pupacion: 'la bandeja de pupación',
  jaula_evento: 'el cierre o la limpieza de la jaula',
  movimiento: 'el cambio de rack',
  distribuir: 'la distribución',
  crear_cochada: 'la cochada',
  ingresar: 'el ingreso al insectario',
  crear_ensilado: 'el ensilado',
  abrir_ensilado: 'la apertura del ensilado',
  cerrar_objeto: 'el cierre',
  editar: 'la corrección',
  marcar_revisado: 'la revisión'
};

const codigoDe = item =>
  item.payload?.codigo || item.payload?.p_cochada?.codigo || item.payload?.p_ensilado?.codigo || '';

/** Plain-language explanation. The operator is standing in a shed, not reading
 *  a SQLSTATE. */
export function explain(item, err) {
  const what = LABELS[item.table] || LABELS[item.rpc] || 'el registro';
  const code = err?.code || null;
  const msg = String(err?.message || '');

  if (code === '23505') {
    // The calls word their own refusals for the operator.
    if (item.rpc === 'distribuir') return msg || 'Esta incubadora ya fue distribuida desde otro teléfono.';
    if (item.table === 'incubadora') {
      return `Ya existe una incubadora ${codigoDe(item) || 'con ese código'}. Otro teléfono registró esa recolecta: revisa cuál corresponde y descarta la otra.`;
    }
    if (item.table === 'separacion') return 'Otra persona ya registró la separación de esta caja. Sólo puede haber una.';
    if (item.table === 'chequeo') return 'Ese chequeo ya fue registrado desde otro teléfono. Sólo hay uno por día del plan.';
    if (item.table === 'alimentacion') return 'Esa carga ya fue registrada desde otro teléfono.';
    if (item.table === 'cochada_lectura') return 'Esa lectura del horno ya fue registrada desde otro teléfono.';
    if (item.rpc === 'crear_cochada') {
      return `Ya existe una cochada ${codigoDe(item)}. Descarta esta y vuelve a crearla: tendrá el número siguiente.`;
    }
    if (item.rpc === 'crear_ensilado') {
      return `Ya existe el ensilado ${codigoDe(item)}: ese contenedor ya se llenó ese día.`;
    }
    if (item.rpc === 'ingresar') return 'Ya existe una bandeja de pupación con ese código. Descarta este ingreso y vuelve a registrarlo.';
    if (item.table === 'rack' || item.table === 'contenedor') return `Ya existe ${what} con ese código.`;
    if (item.table === 'jaula') return 'Ya existe una jaula con ese nombre o esa letra.';
    return `Ya hay en el servidor un registro igual: ${what}.`;
  }
  if (code === '23514' && item.rpc === 'ingresar' && msg) return msg;
  if (code === '23503') return `No se pudo guardar ${what}: depende de un registro que no existe en el servidor.`;
  if (code === '23514') return `No se pudo guardar ${what}: no cumple una regla del proceso.`;
  if (code === '42501' || err?.status === 403) return `No tienes permiso para guardar ${what}.`;
  if (err?.status === 401) return 'Tu sesión expiró. Inicia sesión otra vez para sincronizar.';
  if (err?.status === 424) return err.message;
  if (code === 'PGRST202' || err?.status === 404) {
    return `El servidor todavía no tiene la actualización para guardar ${what}. Avisa a quien administra la base de datos.`;
  }
  return `No se pudo guardar ${what}: ${err?.message || 'error desconocido'}`;
}

export async function recordConflict(db, item, err, reason) {
  const row = {
    id: uuid(),
    outbox_id: item.id,
    op: item.op,
    table: item.table || null,
    rpc: item.rpc || null,
    row_id: item.row_id,
    payload: item.payload,
    reason,
    code: err?.code || null,
    status: err?.status || null,
    message: err?.message || '',
    explanation: explain(item, err),
    created_at: new Date().toISOString(),
    resuelto_at: null,
    resolucion: null,
    _resuelto: 0
  };
  await withTx(db, 'conflicts', 'readwrite', s => reqToPromise(s.conflicts.put(row)));
  return row;
}

export async function listConflicts(db, { includeResolved = false } = {}) {
  const rows = await getAllByIndex(db, 'conflicts', 'by_created');
  return rows
    .filter(r => includeResolved || !r.resuelto_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function countUnresolved(db) {
  const rows = await getAllByIndex(db, 'conflicts', 'by_resolved', 0);
  return rows.length;
}

/* ── undoing an item's local effect ──────────────────────────────────────── */

const outboxItem = (db, id) =>
  withTx(db, 'outbox', 'readonly', s => reqToPromise(s.outbox.get(id)));

/** Rows an item brought into existence (ids only). Items saved before the
 *  undo log existed fall back to what they were about. */
function createdIdsOf(item) {
  if (item.undo) return item.undo.created.map(c => c.key).filter(k => typeof k === 'string');
  return item.op === 'cas' ? [] : rowsOf(item);
}

/**
 * Take back what one item did on this phone:
 *   - rows it created are marked deleted, so they stop showing as real data;
 *   - fields it changed go back to their previous value, but only where
 *     nothing else changed them since.
 * Returns the rows whose true value should be fetched from the server again.
 */
async function undoLocal(db, item) {
  const refetch = [];
  const now = new Date().toISOString();

  const u = item.undo;
  if (!u) {
    // Legacy item: the only thing known is its table and row.
    if (item.table && item.row_id && item.op !== 'cas') {
      await withTx(db, item.table, 'readwrite', async s => {
        const local = await reqToPromise(s[item.table].get(item.row_id));
        if (local && !local.deleted_at) await reqToPromise(s[item.table].put({ ...local, deleted_at: now }));
      }).catch(() => { /* store may not hold this row; nothing to clean up */ });
    }
    return { refetch };
  }

  const stores = [...new Set([...u.created, ...u.changed].map(c => c.store))];
  if (!stores.length) return { refetch };

  await withTx(db, stores, 'readwrite', async s => {
    for (const c of u.created) {
      const row = await reqToPromise(s[c.store].get(c.key));
      if (!row || row.deleted_at) continue;
      await reqToPromise(s[c.store].put(withIndexMirrors(c.store, { ...row, deleted_at: now })));
    }
    for (const c of u.changed) {
      const row = await reqToPromise(s[c.store].get(c.key));
      if (!row) continue;
      const next = { ...row };
      let touched = false;
      for (const [k, [before, after]] of Object.entries(c.fields)) {
        if (JSON.stringify(row[k] ?? null) === JSON.stringify(after)) { next[k] = before; touched = true; }
      }
      if (!touched) continue;
      await reqToPromise(s[c.store].put(withIndexMirrors(c.store, next)));
      if (typeof c.key === 'string') refetch.push({ store: c.store, id: c.key });
    }
  });
  return { refetch };
}

async function markResolved(db, outboxId, resolucion) {
  await withTx(db, 'conflicts', 'readwrite', async s => {
    const rows = await reqToPromise(s.conflicts.index('by_resolved').getAll(0));
    for (const r of rows.filter(r => r.outbox_id === outboxId)) {
      await reqToPromise(s.conflicts.put({
        ...r, resuelto_at: new Date().toISOString(), resolucion, _resuelto: 1
      }));
    }
  });
}

/**
 * Discard an item AND everything that could only exist because of it: work
 * queued against the rows it created. The cajas of a discarded distribución
 * take their chequeos, cargas and separación with them; otherwise those would
 * sit in the queue failing forever against cajas the server never got.
 */
async function discardCascade(db, item, seen = new Set()) {
  if (!item || seen.has(item.id)) return { refetch: [], n: 0 };
  seen.add(item.id);

  await discard(db, item.id);
  const { refetch } = await undoLocal(db, item);
  let n = 1;

  const created = new Set(createdIdsOf(item));
  if (created.size) {
    const all = await getAllByIndex(db, 'outbox', 'by_status');
    const dependents = all
      .filter(it => it.seq > item.seq &&
        (OPEN_STATUSES.includes(it.status) || STUCK_STATUSES.includes(it.status)))
      .filter(it => (it.depends_on || []).some(d => created.has(d)) || rowsOf(it).some(r => created.has(r)))
      .sort((a, b) => a.seq - b.seq);
    for (const dep of dependents) {
      const r = await discardCascade(db, dep, seen);
      refetch.push(...r.refetch);
      n += r.n;
      await markResolved(db, dep.id, 'discard');
    }
  }
  return { refetch, n };
}

/** Items parked only because this one had not landed ("dependencia"): work
 *  that needed its rows, and later operations on those same rows. */
async function blockedBy(db, item) {
  const mine = new Set(rowsOf(item));
  const all = await getAllByIndex(db, 'outbox', 'by_status');
  return all.filter(it => it.seq > item.seq && it.status === STATUS.CONFLICT &&
    it.last_error?.reason === 'dependencia' &&
    ((it.depends_on || []).some(d => mine.has(d)) || rowsOf(it).some(r => mine.has(r))));
}

/**
 * Resolve one conflict.
 *   'retry'   — the cause was fixed; put it back in the queue, together with
 *               the items that were only waiting for it.
 *   'discard' — the other device's version is correct; drop this one. What it
 *               did on this phone is taken back, along with anything that
 *               depended on it, so the phone stops showing data the server
 *               does not have.
 */
export async function resolveConflict(db, id, action) {
  if (!['retry', 'discard'].includes(action)) {
    return fail(CODES.VALIDATION, 'Acción inválida.');
  }
  const row = await withTx(db, 'conflicts', 'readonly', s => reqToPromise(s.conflicts.get(id)));
  if (!row) return fail(CODES.NOT_FOUND, 'Conflicto no encontrado.');
  if (row.resuelto_at) return ok(row);

  const item = await outboxItem(db, row.outbox_id);
  let afectados = 0;

  if (action === 'retry') {
    await requeue(db, row.outbox_id);
    if (item) {
      for (const dep of await blockedBy(db, item)) {
        await requeue(db, dep.id);
        await markResolved(db, dep.id, 'retry');
        afectados++;
      }
    }
  } else if (item) {
    const r = await discardCascade(db, item);
    afectados = r.n - 1;
    // What another phone saved may differ from what this phone had before;
    // bring the server's copy back for rows whose change was taken back.
    if (r.refetch.length) {
      try {
        const { refetchRows } = await import('./sync/pull.js');
        await refetchRows(db, r.refetch);
      } catch { /* offline: the next pull will do */ }
    }
  } else {
    // The queue item is gone (pruned); the old behaviour is all that is left.
    await discard(db, row.outbox_id).catch(() => {});
    await undoLocal(db, { table: row.table, row_id: row.row_id, op: row.op });
  }

  const next = {
    ...row,
    resuelto_at: new Date().toISOString(),
    resolucion: action,
    afectados,
    _resuelto: 1
  };
  await withTx(db, 'conflicts', 'readwrite', s => reqToPromise(s.conflicts.put(next)));
  return ok(next);
}
