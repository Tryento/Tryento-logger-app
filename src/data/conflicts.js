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
import { withIndexMirrors } from './idb/schema.js';
import { uuid } from './ids.js';
import { requeue, discard, rowsOf, STATUS, OPEN_STATUSES, STUCK_STATUSES } from './outbox.js';
import { refreshMany } from './cache.js';
import { ok, fail, CODES } from './envelope.js';

const LABELS = {
  insectario: 'insectario',
  recoleccion: 'recolección',
  incubadora: 'incubadora',
  bandeja: 'bandeja',
  alimentacion: 'alimentación',
  ayuno: 'ayuno',
  revision: 'revisión',
  separacion: 'separación',
  lote: 'lote',
  lote_separacion: 'lote',
  log_alimentacion_grupal: 'alimentación grupal',
  crear_lote: 'lote',
  crear_recoleccion_v2: 'recolecta',
  distribuir_incubadora: 'distribución',
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
  const msg = String(err?.message || '');

  if (code === '23505') {
    if (item.table === 'separacion') {
      return `Otra persona ya registró la separación de esta bandeja. Sólo puede haber una.`;
    }
    if (item.rpc === 'crear_lote' || item.table === 'lote_separacion') {
      return `Al menos una de esas separaciones ya fue usada en otro lote. Revisa cuál corresponde.`;
    }
    if (item.rpc === 'crear_recoleccion_v2') {
      const rec = item.payload?.p_recoleccion?.recolecta;
      const cod = item.payload?.p_incubadora?.codigo;
      if (/ux_incubadora_codigo/.test(msg)) {
        return `Ya existe una incubadora ${cod || 'con ese código'}. Otro teléfono registró esa recolecta: revisa cuál corresponde y descarta la otra.`;
      }
      return `Otro teléfono ya registró la recolecta ${rec || ''} de este insectario. Revisa cuál corresponde y descarta la otra.`;
    }
    if (item.rpc === 'distribuir_incubadora') {
      return msg || 'Esta incubadora ya fue distribuida desde otro teléfono.';
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
  if (code === 'PGRST202' || err?.status === 404) {
    return `El servidor todavía no tiene la actualización para guardar esta ${what}. Avisa a quien administra la base de datos.`;
  }
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
 * Returns the trays whose rollup must be recomputed and the rows whose true
 * value should be fetched from the server again.
 */
async function undoLocal(db, item) {
  const trays = new Set();
  const refetch = [];
  const now = new Date().toISOString();

  const u = item.undo;
  if (!u) {
    // Legacy item: the only thing known is its table and row.
    if (item.table && item.row_id && item.op !== 'cas') {
      await withTx(db, item.table, 'readwrite', async s => {
        const local = await reqToPromise(s[item.table].get(item.row_id));
        if (local && !local.deleted_at) {
          await reqToPromise(s[item.table].put({ ...local, deleted_at: now }));
          if (local.bandeja_id) trays.add(local.bandeja_id);
          if (item.table === 'bandeja') trays.add(local.id);
        }
      }).catch(() => { /* store may not hold this row; nothing to clean up */ });
    }
    return { trays, refetch };
  }

  const stores = [...new Set([...u.created, ...u.changed].map(c => c.store))];
  if (!stores.length) return { trays, refetch };
  const sepIds = [];

  await withTx(db, [...new Set([...stores, 'separacion'])], 'readwrite', async s => {
    for (const c of u.created) {
      const row = await reqToPromise(s[c.store].get(c.key));
      if (!row || row.deleted_at) continue;
      await reqToPromise(s[c.store].put(withIndexMirrors(c.store, { ...row, deleted_at: now })));
      if (row.bandeja_id) trays.add(row.bandeja_id);
      if (c.store === 'bandeja') trays.add(row.id);
      if (c.store === 'lote_separacion') sepIds.push(row.separacion_id);
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
      if (row.bandeja_id) trays.add(row.bandeja_id);
      if (c.store === 'bandeja') trays.add(row.id);
      if (typeof c.key === 'string') refetch.push({ store: c.store, id: c.key });
    }
    for (const id of sepIds) {
      const sep = await reqToPromise(s.separacion.get(id));
      if (sep?.bandeja_id) trays.add(sep.bandeja_id);
    }
  });
  return { trays, refetch };
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
 * queued against the rows it created. A tray created by a discarded
 * distribución takes its feedings with it; otherwise they would sit in the
 * queue failing forever against a tray the server never got.
 */
async function discardCascade(db, item, seen = new Set()) {
  if (!item || seen.has(item.id)) return { trays: new Set(), refetch: [], n: 0 };
  seen.add(item.id);

  await discard(db, item.id);
  const { trays, refetch } = await undoLocal(db, item);
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
      for (const t of r.trays) trays.add(t);
      refetch.push(...r.refetch);
      n += r.n;
      await markResolved(db, dep.id, 'discard');
    }
  }
  return { trays, refetch, n };
}

/** Items parked only because this one had not landed ("dependencia"). */
async function blockedBy(db, item) {
  const mine = new Set(rowsOf(item));
  const all = await getAllByIndex(db, 'outbox', 'by_status');
  return all.filter(it => it.seq > item.seq && it.status === STATUS.CONFLICT &&
    it.last_error?.reason === 'dependencia' &&
    (it.depends_on || []).some(d => mine.has(d)));
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
    await refreshMany(db, [...r.trays]);
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
