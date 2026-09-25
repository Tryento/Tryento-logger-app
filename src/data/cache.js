/**
 * cache.js — the per-tray rollup, and local `estado` computation.
 *
 * ── Why the cache exists ────────────────────────────────────────────────────
 * The prototype's `listBandejas` called `lastEventoBandeja(id)` per row
 * (dataClient.js:410), and that function concatenated four filtered arrays. So
 * listing N trays over M events was O(N x M) — and `refreshLists()` ran it four
 * times per save (dc.html:891-894). Against the 13-row mock that is free;
 * against a year of real data (~360 trays, ~3,600 events) it is over a million
 * comparisons per save and the phone visibly locks up. This store keeps the
 * answer precomputed and updates it incrementally.
 *
 * ── Why estado is computed here too ─────────────────────────────────────────
 * Postgres maintains `bandeja.estado` with a trigger, but an offline device
 * must show the right state the instant an operator records an ayuno — long
 * before the server sees it. So the device computes estado from its OWN event
 * rows, which are a superset of the server's (server rows plus anything still
 * queued). Because the precedence is monotonic — cosechada > en_ayuno >
 * en_crecimiento, and no event ever moves a tray backwards — the local answer
 * is always at least as advanced as the server's, and a pull can never regress
 * the UI.
 */
import { reqToPromise, withTx, getAllByIndex } from './idb/tx.js';

export const ESTADO = {
  CRECIMIENTO: 'en_crecimiento',
  AYUNO: 'en_ayuno',
  COSECHADA: 'cosechada'
};

/** Higher wins. Encodes the monotonic invariant in one place. */
const RANK = { [ESTADO.CRECIMIENTO]: 0, [ESTADO.AYUNO]: 1, [ESTADO.COSECHADA]: 2 };
export const estadoRank = e => RANK[e] ?? 0;

const alive = r => r && !r.deleted_at;

/**
 * Recompute one tray's cache row and estado from local event data.
 * Runs inside the caller's transaction so a write and its derived state commit
 * together — never a row saved with a stale rollup.
 */
export async function refreshBandeja(stores, bandejaId) {
  if (!bandejaId) return null;

  const byBandeja = async store =>
    (await reqToPromise(stores[store].index('by_bandeja').getAll(bandejaId))).filter(alive);

  const [alims, ayunos, revs, seps] = await Promise.all([
    byBandeja('alimentacion'),
    byBandeja('ayuno'),
    byBandeja('revision'),
    byBandeja('separacion')
  ]);

  const estado = seps.length ? ESTADO.COSECHADA
               : ayunos.length ? ESTADO.AYUNO
               : ESTADO.CRECIMIENTO;

  // Latest event across all four kinds, for the list row subtitle.
  let last = null;
  const consider = (tipo, rows) => {
    for (const r of rows) {
      if (!last || String(r.fecha) > String(last.fecha)) last = { tipo, fecha: r.fecha, id: r.id };
    }
  };
  consider('alimentacion', alims);
  consider('ayuno', ayunos);
  consider('revision', revs);
  consider('separacion', seps);

  const abierto = ayunos.find(a => a.peso_final_kg === null || a.peso_final_kg === undefined) || null;
  const sep = seps[0] || null;

  let cochadaId = null;
  if (sep) {
    const links = await reqToPromise(stores.cochada_separacion.index('by_separacion').getAll(sep.id));
    cochadaId = links[0]?.cochada_id ?? null;
  }

  const cache = {
    bandeja_id: bandejaId,
    estado,
    last_evento_tipo: last?.tipo ?? null,
    last_evento_fecha: last?.fecha ?? null,
    n_alimentaciones: alims.length,
    kg_alimento_total: alims.reduce((s, a) => s + (Number(a.cantidad_kg) || 0), 0),
    n_revisiones: revs.length,
    tiene_ayuno_abierto: abierto ? 1 : 0,
    ayuno_abierto_id: abierto?.id ?? null,
    separacion_id: sep?.id ?? null,
    larva_limpia_g: sep ? Number(sep.larva_limpia_g) || 0 : null,
    cochada_id: cochadaId,
    updated_at: new Date().toISOString()
  };

  await reqToPromise(stores.bandeja_cache.put(cache));

  // Keep the tray row's own estado in step. Guarded so we do not rewrite (and
  // thereby dirty) a row that already agrees.
  const tray = await reqToPromise(stores.bandeja.get(bandejaId));
  if (tray && tray.estado !== estado) {
    await reqToPromise(stores.bandeja.put({ ...tray, estado }));
  }

  return cache;
}

/** Stores a transaction must include to call refreshBandeja. */
export const REFRESH_STORES = [
  'bandeja', 'bandeja_cache', 'alimentacion', 'ayuno', 'revision',
  'separacion', 'cochada_separacion'
];

/** Refresh several trays in one transaction. */
export async function refreshMany(db, bandejaIds) {
  const ids = [...new Set((bandejaIds || []).filter(Boolean))];
  if (!ids.length) return 0;
  await withTx(db, REFRESH_STORES, 'readwrite', async s => {
    for (const id of ids) await refreshBandeja(s, id);
  });
  return ids.length;
}

/**
 * Rebuild every tray's cache. Used after the first full pull and as the
 * recovery path if the cache is ever suspected of drifting — the local
 * equivalent of the server's recompute_all_bandeja_estados().
 */
export async function rebuildAll(db) {
  const trays = await getAllByIndex(db, 'bandeja', 'by_updated');
  const ids = trays.map(t => t.id);
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await refreshMany(db, ids.slice(i, i + CHUNK));
  }
  return ids.length;
}

export const getCache = async (db, bandejaId) => {
  const rows = await withTx(db, 'bandeja_cache', 'readonly', s =>
    reqToPromise(s.bandeja_cache.get(bandejaId)));
  return rows || null;
};

export const allCache = async db => {
  const rows = await getAllByIndex(db, 'bandeja_cache', 'by_last_fecha');
  return new Map(rows.map(r => [r.bandeja_id, r]));
};
