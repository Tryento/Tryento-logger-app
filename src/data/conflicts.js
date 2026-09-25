/**
 * conflicts.js — the inbox for writes the server refused.
 *
 * WHY THIS MUST EXIST BEFORE OFFLINE CAPTURE SHIPS: an optimistic write tells
 * the operator "Guardado" the instant they tap. If the server later rejects it
 * and nothing surfaces that, the app has lied — and the operator has no way to
 * find out, which is strictly worse than the AppSheet behaviour being replaced.
 *
 * Two genuine cases produce conflicts, both physical:
 *   - the same tray was separated on two devices
 *   - the same harvest was pooled into two different oven runs
 * In both the database is right and something already went wrong on the floor,
 * so the resolution is a human decision, never an automatic merge.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';
import { uuid } from './ids.js';
import { requeue, discard } from './outbox.js';
import { ok, fail, CODES } from './envelope.js';

const LABELS = {
  insectario: 'insectario',
  recoleccion: 'recolección',
  bandeja: 'bandeja',
  alimentacion: 'alimentación',
  ayuno: 'ayuno',
  revision: 'revisión',
  separacion: 'separación',
  lote: 'lote',
  lote_separacion: 'lote',
  log_alimentacion_grupal: 'alimentación grupal',
  crear_lote: 'lote',
  cerrar_ayuno: 'cierre de ayuno',
  marcar_atractante: 'atractante',
  marcar_cierre: 'cierre de insectario',
  marcar_empacado: 'empacado',
  marcar_despachado: 'despacho',
  rechazar_lote: 'rechazo de lote',
  actualizar_qc_lote: 'control de calidad'
};

/** Plain-language explanation. The operator is standing in a shed, not reading
 *  a SQLSTATE. */
export function explain(item, err) {
  const what = LABELS[item.table] || LABELS[item.rpc] || 'registro';
  const code = err?.code || null;

  if (code === '23505') {
    if (item.table === 'separacion') {
      return `Otra persona ya registró la separación de esta bandeja. Sólo puede haber una.`;
    }
    if (item.rpc === 'crear_lote' || item.table === 'lote_separacion') {
      return `Al menos una de esas separaciones ya fue usada en otro lote. Revisa cuál corresponde.`;
    }
    if (item.table === 'bandeja') {
      return `Ya existe una bandeja con ese número en la misma recolección.`;
    }
    if (item.table === 'insectario') {
      return `Ya existe un insectario con ese código.`;
    }
    return `Ya existe un registro de ${what} igual en el servidor.`;
  }
  if (code === '23503') return `La ${what} depende de un registro que no existe en el servidor.`;
  if (code === '23514') return `La ${what} no cumple una regla del proceso (por ejemplo, despachar sin empacar).`;
  if (code === '42501' || err?.status === 403) return `No tienes permiso para guardar esta ${what}.`;
  if (err?.status === 401) return `Tu sesión expiró. Inicia sesión otra vez para sincronizar.`;
  if (err?.status === 424) return err.message;
  return `No se pudo guardar la ${what}: ${err?.message || 'error desconocido'}`;
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

/**
 * Resolve one conflict.
 *   'retry'   — the cause was fixed; put it back in the queue.
 *   'discard' — the other device's version is correct; drop this one. The local
 *               row is soft-deleted so the device stops showing data the server
 *               does not have.
 */
export async function resolveConflict(db, id, action) {
  if (!['retry', 'discard'].includes(action)) {
    return fail(CODES.VALIDATION, 'Acción inválida.');
  }
  const row = await withTx(db, 'conflicts', 'readonly', s => reqToPromise(s.conflicts.get(id)));
  if (!row) return fail(CODES.NOT_FOUND, 'Conflicto no encontrado.');
  if (row.resuelto_at) return ok(row);

  if (action === 'retry') {
    await requeue(db, row.outbox_id);
  } else {
    await discard(db, row.outbox_id);
    if (row.table && row.row_id) {
      await withTx(db, row.table, 'readwrite', async s => {
        const local = await reqToPromise(s[row.table].get(row.row_id));
        if (local) {
          await reqToPromise(s[row.table].put({ ...local, deleted_at: new Date().toISOString() }));
        }
      }).catch(() => { /* store may not hold this row; nothing to clean up */ });
    }
  }

  const next = {
    ...row,
    resuelto_at: new Date().toISOString(),
    resolucion: action,
    _resuelto: 1
  };
  await withTx(db, 'conflicts', 'readwrite', s => reqToPromise(s.conflicts.put(next)));
  return ok(next);
}
