/**
 * write.js — every write the UI performs.
 *
 * Each one does the same three things, atomically:
 *   1. build the row with a CLIENT-generated UUID
 *   2. apply it locally and enqueue it for the server in ONE transaction
 *   3. return ok() immediately — the operator never waits for the network
 *
 * The write classes, and why they differ:
 *
 *   APPEND      insert-only, idempotent via ON CONFLICT (id) DO NOTHING.
 *               Two devices can never collide on a UUID, so these are
 *               unconditionally safe offline.
 *
 *   CAS         "first write wins" stamps (atractante, cierre, empacado,
 *               despachado, cerrar ayuno). The server guards with
 *               `WHERE col IS NULL`, so replaying them out of order is a no-op
 *               rather than an overwrite.
 *
 *   UNIQUE      logSeparacion and createLote carry cross-row invariants that
 *               append-only CANNOT protect. Two offline devices both pass the
 *               local check and both sync; Postgres rejects one. The local
 *               check stays as an early warning, but the authoritative answer
 *               is the server's and the loser lands in the conflict inbox. It
 *               is not softened to ON CONFLICT DO NOTHING — silently dropping a
 *               recorded harvest would be worse than the bug being replaced.
 */
import { ok, fail, CODES, num, str, deepCopy } from './envelope.js';
import { openDb } from './idb/open.js';
import { ayunoAbierto } from './idb/schema.js';
import { commitWrite, rowById, allRows, rowsByIndex } from './store.js';
import {
  uuid, uuidFromString, deviceId, insectarioCodigo, bandejaLabel, loteCodigo,
  nextRecolectaOrdinal, incubadoraCodigo, bandejaV2Codigo
} from './ids.js';
import { nowIso, utcIso, farmDay, addDays } from './time.js';
import { currentUserId } from './session.js';
import { metaGet, metaSet } from './idb/tx.js';
import { attachPhoto } from './photo.js';
import { OVEN_CAPACITY } from './config.js';
import { mergeProtocolo, cargaDef, ALIMENTO_V2 } from './protocolo.js';

/** The protocol settings this device has, over the built-in defaults. */
async function protocolo(db) {
  return mergeProtocolo(await allRows(db, 'parametro'));
}

const esV2 = row => (row?.protocolo || 'v1') === 'v2';

/** Tray labels for a message, never raw ids. */
const etiquetas = (trays, ids) =>
  ids.map(id => trays.get(id)?.id_bandeja || '(sin etiqueta)').join(', ');

/** Who is registering right now, remembered in the local `meta` store. */
const OPERADOR_KEY = 'operador_actual';

export async function setCurrentOperator(nombre) {
  const n = str(nombre);
  if (!n) return null;
  await metaSet(await openDb(), OPERADOR_KEY, n);
  return n;
}

export async function getCurrentOperator() {
  return (await metaGet(await openDb(), OPERADOR_KEY, null)) || null;
}

/**
 * Fields stamped on every row we originate.
 *
 * `registrado_por` is the name as typed — plain text, no lookup, no foreign
 * key. Nothing here can fail because a device has not synced a roster yet.
 *
 * IT FALLS BACK to the operator selected on the name screen, rather than
 * trusting each form to pass one. QA found every insectario, recolección and
 * bandeja saving `registrado_por: null`: the header said "registrando como
 * Ricardo" the whole time, but three of the six forms simply never seeded
 * `operator_name`, so the name was displayed and never written. Requiring six
 * separate places to remember the same thing is a guarantee that one of them
 * will not — so the default lives here, where a new form cannot skip it.
 */
async function provenance(operatorName) {
  const nombre = str(operatorName) || (await getCurrentOperator()) || null;
  return {
    registrado_por: nombre,
    created_by: currentUserId(),      // null until real logins exist — by design
    dispositivo_id: deviceId(),
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

/**
 * Normalise an incoming date field to the canonical stored form (UTC `Z`).
 *
 * The value arriving from `<input type="datetime-local">` is naive wall-clock
 * text with no zone. `asDate` interprets it as FARM-local — not device-local
 * and not UTC — so an operator typing 08:30 gets 08:30 at the farm regardless
 * of how the phone's timezone is set.
 */
function isoOrNow(v) {
  if (!v) return nowIso();
  return utcIso(v) || nowIso();
}

/* ── who is registering ─────────────────────────────────────────────────── */

/**
 * Remember a name locally so it comes back as a one-tap chip.
 *
 * Purely a convenience store — it is never synced and nothing depends on it.
 * The authoritative record of who did what is `registrado_por` on each row.
 * If this list is lost the app keeps working; the names simply reappear from
 * existing records instead.
 */
export async function rememberOperator(nombre) {
  const n = str(nombre);
  if (!n) return fail(CODES.VALIDATION, 'Escribe tu nombre.');
  if (n.length > 60) return fail(CODES.VALIDATION, 'El nombre es demasiado largo.');

  const db = await openDb();

  // This is the selection the whole app registers under from now on.
  await metaSet(db, OPERADOR_KEY, n);

  // Local recency, so this device puts the person who just used it on top.
  const list = (await metaGet(db, 'nombres_usados', [])) || [];
  const rest = list.filter(r => String(r?.nombre || '').toLowerCase() !== n.toLowerCase());
  await metaSet(db, 'nombres_usados', [{ nombre: n, lastUsed: nowIso() }, ...rest].slice(0, 30));

  // Then add it to the SHARED list, so a name typed on one phone appears as a
  // chip on everyone else's. The id is derived from the name, so two people
  // typing "Jose" at the same time produce the same row instead of a conflict.
  const all = await allRows(db, 'catalogo');
  const already = all.some(c =>
    c.tipo === 'operario' && String(c.valor).toLowerCase() === n.toLowerCase());

  if (!already) {
    const row = {
      id: uuidFromString('operario:' + n.toLowerCase()),
      tipo: 'operario',
      valor: n,
      orden: 100,           // after the pre-registered names
      activo: true,
      created_at: nowIso(),
      updated_at: nowIso()
    };
    await commitWrite(db, {
      writes: [{ store: 'catalogo', row }],
      outbox: {
        op: 'upsert', table: 'catalogo', rowId: row.id, payload: row,
        createdBy: currentUserId(), dispositivoId: deviceId()
      }
    });
  }

  return ok({ nombre: n });
}

/* ── insectario ─────────────────────────────────────────────────────────── */

export async function createInsectario(data) {
  if (!data?.nombre_insectario || !data?.fecha_inicio) {
    return fail(CODES.VALIDATION, 'Nombre y fecha de inicio son obligatorios.');
  }
  const db = await openDb();
  const prov = await provenance(data.operator_name);

  const row = {
    id: uuid(),
    // The prototype appended "-2" on a local collision (dataClient.js:191).
    // That is meaningless offline — the other device cannot be consulted — so
    // the code is built cleanly and a genuine duplicate surfaces as a conflict.
    codigo: insectarioCodigo(data.nombre_insectario, data.fecha_inicio),
    nombre_insectario: data.nombre_insectario,
    fecha_inicio: data.fecha_inicio,
    generacion_moscas: str(data.generacion_moscas),
    biomasa_kg: num(data.biomasa_kg),
    proyeccion_ovipositores: data.proyeccion_ovipositores || null,
    proyeccion_cierre: data.proyeccion_cierre || null,
    fecha_ovipositores: null,
    cierre_real: null,
    notas: str(data.notas),
    deleted_at: null,
    ...prov
  };

  await commitWrite(db, {
    writes: [{ store: 'insectario', row }],
    outbox: { op: 'upsert', table: 'insectario', rowId: row.id, payload: row,
              createdBy: row.created_by, dispositivoId: row.dispositivo_id }
  });

  const { listInsectarios } = await import('./read.js');
  const all = await listInsectarios();
  return ok(all.data.find(r => r.id === row.id) || row);
}

/** CAS stamp — first date to reach the server wins; replays are no-ops. */
async function stampInsectario(id, field, value) {
  const db = await openDb();
  const row = await rowById(db, 'insectario', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Insectario no encontrado.');
  if (row[field]) {
    const { getInsectarioDetail } = await import('./read.js');
    const d = await getInsectarioDetail(id);
    return d.ok ? ok(d.data.insectario) : d;
  }

  // Who pressed the button, which is often NOT who created the colony weeks
  // earlier. `registrado_por` on the row answers "who started this"; these
  // answer "who marked it".
  const por = await getCurrentOperator();
  const next = { ...row, [field]: value, [field + '_por']: por, updated_at: nowIso() };
  await commitWrite(db, {
    writes: [{ store: 'insectario', row: next }],
    outbox: {
      op: 'cas',
      rpc: field === 'fecha_ovipositores' ? 'marcar_atractante' : 'marcar_cierre',
      rowId: id,
      payload: { p_id: id, p_fecha: value, p_por: por },
      createdBy: currentUserId(), dispositivoId: deviceId()
    }
  });

  const { getInsectarioDetail } = await import('./read.js');
  const d = await getInsectarioDetail(id);
  return d.ok ? ok(d.data.insectario) : d;
}

export const marcarAtractante = id => stampInsectario(id, 'fecha_ovipositores', farmDay());
export const marcarCierre = id => stampInsectario(id, 'cierre_real', farmDay());

/* ── recoleccion ────────────────────────────────────────────────────────── */

export async function createRecoleccion(data) {
  if (!data?.insectario_id) return fail(CODES.VALIDATION, 'Insectario es obligatorio.');
  const db = await openDb();

  const ins = await rowById(db, 'insectario', data.insectario_id);
  if (!ins) return fail(CODES.NOT_FOUND, 'Insectario no encontrado.');

  // Per-colony ordinal, not a global counter: the prototype's
  // 'REC-' + (length + 101) advanced identically on two offline devices.
  const existing = await rowsByIndex(db, 'recoleccion', 'by_insectario', data.insectario_id);
  const prov = await provenance(data.operator_name);

  const row = {
    id: uuid(),
    insectario_id: data.insectario_id,
    recolecta: data.recolecta ? String(data.recolecta) : nextRecolectaOrdinal(existing),
    fecha: isoOrNow(data.fecha),
    huevos_g: num(data.huevos_g),
    notas: str(data.notas),
    deleted_at: null,
    ...prov
  };

  await commitWrite(db, {
    writes: [{ store: 'recoleccion', row }],
    outbox: { op: 'upsert', table: 'recoleccion', rowId: row.id, payload: row,
              dependsOn: [data.insectario_id],
              createdBy: row.created_by, dispositivoId: row.dispositivo_id }
  });

  return ok(Object.assign(deepCopy(row), {
    insectario_nombre: ins.nombre_insectario,
    insectario_codigo: ins.codigo
  }));
}

/* ── bandeja ────────────────────────────────────────────────────────────── */

export async function createBandeja(data) {
  if (!data?.recoleccion_id) return fail(CODES.VALIDATION, 'Recolección es obligatoria.');
  // The farm labels the physical tray with a marker BEFORE entering it, so the
  // number is typed by the operator and the app must not invent one.
  const no = num(data.no_bandeja);
  if (no === null || no <= 0) {
    return fail(CODES.VALIDATION, 'Número de bandeja es obligatorio (el que está escrito en la bandeja).');
  }

  const db = await openDb();
  const rec = await rowById(db, 'recoleccion', data.recoleccion_id);
  if (!rec) return fail(CODES.NOT_FOUND, 'Recolección no encontrada.');

  // Early warning only — the authoritative check is the unique index.
  const siblings = await rowsByIndex(db, 'bandeja', 'by_recoleccion', data.recoleccion_id);
  if (siblings.some(b => Number(b.no_bandeja) === no)) {
    return fail(CODES.CONFLICT, `Ya existe la bandeja Nº ${no} en esa recolección.`);
  }

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);

  const row = {
    id: uuid(),
    recoleccion_id: rec.id,
    no_bandeja: no,
    id_bandeja: bandejaLabel(fecha, rec.recolecta, no),
    fecha,
    gramos_huevos: num(data.gramos_huevos) ?? 0.5,
    iniciador_g: num(data.iniciador_g) ?? 300,
    tipo_iniciador: data.tipo_iniciador || 'Bagazo',
    notas: str(data.notas),
    estado: 'en_crecimiento',
    cerrada_admin_at: null,
    cerrada_admin_motivo: null,
    deleted_at: null,
    ...prov
  };

  await commitWrite(db, {
    writes: [{ store: 'bandeja', row }],
    outbox: { op: 'upsert', table: 'bandeja', rowId: row.id, payload: row,
              dependsOn: [rec.id],
              createdBy: row.created_by, dispositivoId: row.dispositivo_id },
    refreshTrays: [row.id]
  });

  const { getBandejaDetail } = await import('./read.js');
  const d = await getBandejaDetail(row.id);
  return d.ok ? ok(d.data.bandeja) : ok(row);
}

/* ── tray events ────────────────────────────────────────────────────────── */

async function eventBase(db, data, extra = {}) {
  const tray = await rowById(db, 'bandeja', data.bandeja_id);
  if (!tray || tray.deleted_at) return { error: fail(CODES.NOT_FOUND, 'Bandeja no encontrada.') };
  const prov = await provenance(data.operator_name);
  return {
    tray,
    row: {
      id: uuid(),
      bandeja_id: data.bandeja_id,
      fecha: isoOrNow(data.fecha),
      notas: str(data.notas),
      foto_key: null,
      deleted_at: null,
      // Local only (push never sends it): the server gives an event its tray's
      // protocol by trigger. Kept here so this phone shows the right one now.
      protocolo: tray.protocolo || 'v1',
      ...prov,
      ...extra
    }
  };
}

/**
 * The photo key is computed HERE because this is where the row's UUID exists.
 * It is deterministic (`table/rowId/blobId.jpg`) so the upload can use
 * `upsert: true` and a retry after a lost acknowledgement overwrites the same
 * object instead of orphaning a second copy in storage.
 */
async function commitEvent(db, store, row, { blobId = null } = {}) {
  const blobIds = [];
  if (blobId) {
    row.foto_key = await attachPhoto(db, blobId, store, row.id);
    blobIds.push(blobId);
  }
  await commitWrite(db, {
    writes: [{ store, row }],
    outbox: { op: 'upsert', table: store, rowId: row.id, payload: row,
              dependsOn: [row.bandeja_id], blobIds,
              createdBy: row.created_by, dispositivoId: row.dispositivo_id },
    refreshTrays: [row.bandeja_id]
  });
  return ok(deepCopy(row));
}

/** v1 trays keep the old feeding form. A v2 tray is fed with logCarga: its
 *  diet and quantities are fixed by the protocol, so there is nothing to type. */
const SOLO_V1 = 'Esta bandeja es del protocolo nuevo: se alimenta con «Alimentar» (carga del plan).';

export async function logAlimentacion(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  if (!data.tipo_alimento) return fail(CODES.VALIDATION, 'Tipo de alimento es obligatorio.');
  const db = await openDb();
  const { error, row, tray } = await eventBase(db, data, {
    tipo_alimento: data.tipo_alimento,
    cantidad_kg: num(data.cantidad_kg) ?? 0,
    origen: 'individual',
    grupal_id: null
  });
  if (error) return error;
  if (esV2(tray)) return fail(CODES.VALIDATION, SOLO_V1);
  return commitEvent(db, 'alimentacion', row, { blobId: data.blob_id });
}

/**
 * Bulk feed — ONE atomic server operation, not N independent queue items.
 *
 * This is the AppSheet bug being fixed. There, a bot fanned out N rows and
 * back-filled each from `LOOKUP(MAXROW(...))`; the race left ~20 rows in the
 * live sheet with a valid tray reference but blank fecha, tipo and cantidad.
 * Splitting this into N outbox items would reintroduce exactly that partial
 * fan-out, so the whole set travels as a single RPC that either lands
 * completely or not at all.
 */
export async function logAlimentacionGrupal(data) {
  const ids = Array.isArray(data?.bandeja_ids) ? data.bandeja_ids.filter(Boolean) : [];
  if (!ids.length) return fail(CODES.VALIDATION, 'Selecciona al menos una bandeja.');
  if (!data.tipo_alimento) return fail(CODES.VALIDATION, 'Tipo de alimento es obligatorio.');

  const db = await openDb();
  const trays = new Map((await allRows(db, 'bandeja')).map(t => [t.id, t]));
  const unknown = ids.filter(id => !trays.has(id));
  if (unknown.length) {
    return fail(CODES.NOT_FOUND, `${unknown.length} bandeja(s) ya no existen en este teléfono. Vuelve a elegirlas.`);
  }
  const v2 = ids.filter(id => esV2(trays.get(id)));
  if (v2.length) return fail(CODES.VALIDATION, `${SOLO_V1} (${etiquetas(trays, v2)})`);

  const grupalId = uuid();
  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);

  const rows = ids.map(bandeja_id => ({
    id: uuid(),
    bandeja_id,
    fecha,
    tipo_alimento: data.tipo_alimento,
    cantidad_kg: num(data.cantidad_kg) ?? 0,
    origen: 'grupal',
    grupal_id: grupalId,
    notas: str(data.notas),
    foto_key: null,
    deleted_at: null,
    ...prov
  }));

  await commitWrite(db, {
    writes: rows.map(row => ({ store: 'alimentacion', row })),
    outbox: {
      op: 'rpc', rpc: 'log_alimentacion_grupal', rowId: grupalId,
      payload: { p_rows: rows },
      dependsOn: ids,
      createdBy: prov.created_by, dispositivoId: prov.dispositivo_id
    },
    refreshTrays: ids
  });

  return ok({ grupal_id: grupalId, created: rows.length, rows: deepCopy(rows) });
}

/**
 * Start a fast.
 *
 *   v1 (old protocol): weighed in, as always. The weight is required.
 *   v2 (días 14–15):   one tap. Weighing is optional; the cosecha closes it.
 */
export async function logAyuno(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  const pi = num(data.peso_inicial_kg);
  const pf = num(data.peso_final_kg);

  const db = await openDb();
  const tray = await rowById(db, 'bandeja', data.bandeja_id);
  if (!tray || tray.deleted_at) return fail(CODES.NOT_FOUND, 'Bandeja no encontrada.');

  if (esV2(tray)) {
    if (pi !== null && pi <= 0) return fail(CODES.VALIDATION, 'El peso inicial debe ser mayor que cero.');
    const previos = await rowsByIndex(db, 'ayuno', 'by_bandeja', tray.id);
    if (previos.length) return fail(CODES.CONFLICT, `La bandeja ${tray.id_bandeja} ya está en ayuno.`);
    if (tray.estado === 'cosechada') return fail(CODES.CONFLICT, `La bandeja ${tray.id_bandeja} ya fue cosechada.`);
    const cfg = await protocolo(db);
    const { error, row } = await eventBase(db, data, {
      peso_inicial_kg: pi,
      horas_ayuno: num(data.horas_ayuno) ?? cfg.horas_ayuno,
      peso_final_kg: null,
      cerrado_at: null
    });
    if (error) return error;
    return commitEvent(db, 'ayuno', row, { blobId: data.blob_id });
  }

  if (pi === null || pi <= 0) return fail(CODES.VALIDATION, 'Peso inicial es obligatorio.');
  const { error, row } = await eventBase(db, data, {
    peso_inicial_kg: pi,
    horas_ayuno: num(data.horas_ayuno) ?? 24,
    peso_final_kg: pf,
    cerrado_at: pf !== null ? nowIso() : null
  });
  if (error) return error;
  return commitEvent(db, 'ayuno', row, { blobId: data.blob_id });
}

/**
 * Start the fast of several v2 trays at once (día 14 is the same day for a
 * whole distribución). Every tray is checked BEFORE anything is saved, so the
 * operator never ends up with half the trays in ayuno and a vague error.
 * Each fast is its own record, exactly as if it had been tapped one by one.
 */
export async function logAyunoGrupal(data) {
  const ids = [...new Set(Array.isArray(data?.bandeja_ids) ? data.bandeja_ids.filter(Boolean) : [])];
  if (!ids.length) return fail(CODES.VALIDATION, 'Selecciona al menos una bandeja.');

  const db = await openDb();
  const trays = new Map((await allRows(db, 'bandeja')).map(t => [t.id, t]));
  const unknown = ids.filter(id => !trays.has(id));
  if (unknown.length) {
    return fail(CODES.NOT_FOUND, `${unknown.length} bandeja(s) ya no existen en este teléfono. Vuelve a elegirlas.`);
  }
  const v1 = ids.filter(id => !esV2(trays.get(id)));
  if (v1.length) {
    return fail(CODES.VALIDATION, `Estas bandejas son del protocolo anterior y se pesan al ayunar: ${etiquetas(trays, v1)}.`);
  }
  const conAyuno = new Set((await allRows(db, 'ayuno')).map(a => a.bandeja_id));
  const yaEn = ids.filter(id => conAyuno.has(id));
  if (yaEn.length) return fail(CODES.CONFLICT, `Ya están en ayuno: ${etiquetas(trays, yaEn)}.`);
  const cosechadas = ids.filter(id => trays.get(id).estado === 'cosechada');
  if (cosechadas.length) return fail(CODES.CONFLICT, `Ya fueron cosechadas: ${etiquetas(trays, cosechadas)}.`);

  const fecha = isoOrNow(data.fecha);
  const creados = [];
  for (const id of ids) {
    const r = await logAyuno({ bandeja_id: id, fecha, operator_name: data.operator_name, notas: data.notas });
    if (!r.ok) return fail(r.error.code, `${r.error.message} (se guardaron ${creados.length} de ${ids.length})`);
    creados.push(r.data);
  }
  return ok({ created: creados.length, rows: creados });
}

/**
 * Close a fast — the write the prototype simply did not have.
 *
 * A fast is physically two visits: weigh in, wait ~24 h, weigh out. The
 * prototype modelled only the first (there was no update path for `ayuno`
 * anywhere in its 28 exports), so `peso_final_kg` could never be filled and
 * `merma_pct` — one of the three named computed values in the spec — had no
 * reachable input.
 */
export async function logAyunoFin(id, data) {
  const pf = num(data?.peso_final_kg);
  if (pf !== null && pf < 0) return fail(CODES.VALIDATION, 'El peso final no puede ser negativo.');

  const db = await openDb();
  const row = await rowById(db, 'ayuno', id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Ayuno no encontrado.');
  if (!ayunoAbierto(row)) return fail(CODES.CONFLICT, 'Este ayuno ya fue cerrado.');

  const tray = await rowById(db, 'bandeja', row.bandeja_id);
  // v1 closes with a weight, as always. v2 may close without one.
  if (!esV2(tray) && pf === null) return fail(CODES.VALIDATION, 'Peso final es obligatorio.');
  if (pf !== null && row.peso_inicial_kg != null && pf > row.peso_inicial_kg) {
    return fail(CODES.VALIDATION, 'El peso final no puede superar el peso inicial.');
  }

  const cerrado = data?.at ? isoOrNow(data.at) : nowIso();
  const por = str(data?.operator_name) || (await getCurrentOperator());
  const next = { ...row, peso_final_kg: pf, cerrado_at: cerrado, cerrado_por: por, updated_at: nowIso() };

  await commitWrite(db, {
    writes: [{ store: 'ayuno', row: next }],
    outbox: {
      op: 'cas', rpc: 'cerrar_ayuno', rowId: id,
      payload: { p_id: id, p_peso: pf, p_at: cerrado, p_por: por },
      createdBy: currentUserId(), dispositivoId: deviceId()
    },
    refreshTrays: [row.bandeja_id]
  });

  return ok(deepCopy(next));
}

export async function logRevision(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  const db = await openDb();
  const { error, row } = await eventBase(db, data);
  if (error) return error;
  return commitEvent(db, 'revision', row, { blobId: data.blob_id });
}

/**
 * Separación / cosecha.
 *
 * `larva_limpia_g` is what goes on to the oven (it is what a Lote adds up). In
 * v2 the ≈2 % that goes to the lab to become flies is weighed separately into
 * `reserva_cria_g`, and the cosecha closes the tray's fast.
 */
export async function logSeparacion(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  const g = num(data.larva_limpia_g);
  if (g === null || g < 0) return fail(CODES.VALIDATION, 'Larva limpia (g) es obligatoria.');
  const reserva = num(data.reserva_cria_g);
  if (reserva !== null && reserva < 0) return fail(CODES.VALIDATION, 'Los gramos para el laboratorio no pueden ser negativos.');

  const db = await openDb();
  // Advisory: catches the common case where THIS device already knows. Offline,
  // another device may have separated the same tray and we cannot tell — the
  // unique index decides and the loser goes to the conflict inbox.
  const existing = await rowsByIndex(db, 'separacion', 'by_bandeja', data.bandeja_id);
  if (existing.length) {
    return fail(CODES.CONFLICT, 'Esta bandeja ya tiene una separación registrada.');
  }

  const tray = await rowById(db, 'bandeja', data.bandeja_id);
  const v2 = esV2(tray);
  // v2-only fields are only put on v2 rows, so an old-protocol separación sends
  // exactly what it always did.
  const { error, row } = await eventBase(db, data,
    v2 ? { larva_limpia_g: g, reserva_cria_g: reserva } : { larva_limpia_g: g });
  if (error) return error;
  const res = await commitEvent(db, 'separacion', row, { blobId: data.blob_id });

  if (res.ok && v2) {
    const abiertos = (await rowsByIndex(db, 'ayuno', 'by_bandeja', data.bandeja_id)).filter(ayunoAbierto);
    for (const a of abiertos) {
      await logAyunoFin(a.id, { at: row.fecha, operator_name: data.operator_name });
    }
  }
  return res;
}

/* ── lote ────────────────────────────────────────────────────────────── */

export async function createLote(data) {
  const sepIds = Array.isArray(data?.separacion_ids) ? data.separacion_ids.filter(Boolean) : [];
  if (!sepIds.length) return fail(CODES.VALIDATION, 'Selecciona al menos una separación.');
  if (sepIds.length > OVEN_CAPACITY) {
    return fail(CODES.VALIDATION, `El horno admite ${OVEN_CAPACITY} bandejas metálicas.`);
  }

  const db = await openDb();
  const seps = await allRows(db, 'separacion');
  const known = new Set(seps.map(s => s.id));
  const unknown = sepIds.filter(id => !known.has(id));
  if (unknown.length) {
    return fail(CODES.NOT_FOUND, `${unknown.length} separación(es) ya no existen en este teléfono. Vuelve a elegirlas.`);
  }

  const links = await allRows(db, 'lote_separacion');
  const pooled = new Set(links.map(l => l.separacion_id));
  const already = sepIds.filter(id => pooled.has(id));
  if (already.length) {
    const trays = new Map((await allRows(db, 'bandeja')).map(t => [t.id, t]));
    const sepById = new Map(seps.map(s => [s.id, s]));
    return fail(CODES.CONFLICT,
      `Ya está en otro lote: ${etiquetas(trays, already.map(id => sepById.get(id)?.bandeja_id))}`);
  }

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);
  const id = uuid();

  const lote = {
    id,
    codigo: loteCodigo(fecha),
    fecha,
    peso_inicial_kg: num(data.peso_inicial_kg),
    tiempo_secado_horas: null,
    peso_final_kg: null,
    qc_color_dorado: null,
    qc_prueba_crujiente: '',
    qc_aprobado: null,
    qc_foto_key: null,
    bandejas_metalicas_usadas: num(data.bandejas_metalicas_usadas) ?? sepIds.length,
    empacado_at: null,
    fecha_vencimiento: null,
    despachado_at: null,
    rechazado_at: null,
    rechazo_motivo: null,
    notas: str(data.notas),
    deleted_at: null,
    ...prov
  };

  const linkRows = sepIds.map(separacion_id => ({
    lote_id: id, separacion_id,
    created_at: prov.created_at, updated_at: prov.updated_at
  }));

  const trays = seps.filter(s => sepIds.includes(s.id)).map(s => s.bandeja_id);

  await commitWrite(db, {
    writes: [
      { store: 'lote', row: lote },
      ...linkRows.map(row => ({ store: 'lote_separacion', row }))
    ],
    // One RPC, so a lote and its links can never land apart. The old Lotes
    // table pointed at nothing precisely because those were separate writes.
    outbox: {
      op: 'rpc', rpc: 'crear_lote', rowId: id,
      payload: { p_lote: lote, p_separacion_ids: sepIds },
      dependsOn: sepIds,
      createdBy: prov.created_by, dispositivoId: prov.dispositivo_id
    },
    refreshTrays: trays
  });

  const { getLoteDetail } = await import('./read.js');
  const d = await getLoteDetail(id);
  return d.ok ? ok(d.data.lote) : ok(lote);
}

async function patchLote(id, patch, outbox) {
  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');
  const next = { ...row, ...patch, updated_at: nowIso() };
  await commitWrite(db, { writes: [{ store: 'lote', row: next }], outbox });
  const { getLoteDetail } = await import('./read.js');
  const d = await getLoteDetail(id);
  return d.ok ? ok(d.data.lote) : ok(next);
}

export async function updateLoteQC(id, data) {
  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');
  if (row.despachado_at || row.rechazado_at) {
    return fail(CODES.CONFLICT, 'Este lote ya está cerrado.');
  }

  const patch = {};
  if (data.tiempo_secado_horas !== undefined) patch.tiempo_secado_horas = num(data.tiempo_secado_horas);
  if (data.peso_final_kg !== undefined) patch.peso_final_kg = num(data.peso_final_kg);
  if (data.qc_color_dorado !== undefined) patch.qc_color_dorado = data.qc_color_dorado;
  if (data.qc_prueba_crujiente !== undefined) patch.qc_prueba_crujiente = str(data.qc_prueba_crujiente);
  // Explicit decision rather than a side effect of typing a weight.
  if (data.qc_aprobado !== undefined) patch.qc_aprobado = data.qc_aprobado;
  patch.qc_por = await getCurrentOperator();

  // Preserve the prototype's foto -> qc_foto mapping (dataClient.js:345); the
  // differing field name is easy to lose in a rewrite.
  const blobIds = [];
  if (data.blob_id) {
    patch.qc_foto_key = await attachPhoto(db, data.blob_id, 'lote', id);
    blobIds.push(data.blob_id);
  }

  return patchLote(id, patch, {
    op: 'cas', rpc: 'actualizar_qc_lote', rowId: id,
    blobIds,
    payload: {
      p_id: id,
      p_tiempo: patch.tiempo_secado_horas ?? null,
      p_peso_final: patch.peso_final_kg ?? null,
      p_color: patch.qc_color_dorado ?? null,
      p_prueba: patch.qc_prueba_crujiente ?? null,
      p_aprobado: patch.qc_aprobado ?? null,
      p_foto_key: patch.qc_foto_key ?? null,
      p_por: await getCurrentOperator()
    },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

export async function marcarEmpacado(id, data) {
  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');
  if (row.qc_aprobado !== true) {
    return fail(CODES.VALIDATION, 'Primero aprueba el control de calidad.');
  }
  if (row.empacado_at) return ok(row);

  const porEmp = await getCurrentOperator();
  return patchLote(id, {
    empacado_at: nowIso(),
    empacado_por: porEmp,
    fecha_vencimiento: data?.fecha_vencimiento || addDays(farmDay(), 180)
  }, {
    op: 'cas', rpc: 'marcar_empacado', rowId: id,
    payload: { p_id: id, p_vencimiento: data?.fecha_vencimiento || null, p_por: porEmp },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

export async function marcarDespachado(id) {
  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');
  // The prototype could dispatch before packing (dataClient.js:359).
  if (!row.empacado_at) return fail(CODES.VALIDATION, 'Primero marca el lote como empacado.');
  if (row.despachado_at) return ok(row);

  const porDesp = await getCurrentOperator();
  return patchLote(id, { despachado_at: nowIso(), despachado_por: porDesp }, {
    op: 'cas', rpc: 'marcar_despachado', rowId: id, payload: { p_id: id, p_por: porDesp },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

/** QC failure — mold, over-toasting, a failed crunch test. Terminal. */
export async function rechazarLote(id, motivo) {
  const reason = str(motivo);
  if (!reason) return fail(CODES.VALIDATION, 'Indica el motivo del rechazo.');

  const db = await openDb();
  const row = await rowById(db, 'lote', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Lote no encontrado.');
  if (row.despachado_at) return fail(CODES.CONFLICT, 'Este lote ya fue despachado.');
  if (row.rechazado_at) return ok(row);

  const porRech = await getCurrentOperator();
  return patchLote(id, {
    rechazado_at: nowIso(), rechazo_motivo: reason, rechazado_por: porRech, qc_aprobado: false
  }, {
    op: 'cas', rpc: 'rechazar_lote', rowId: id,
    payload: { p_id: id, p_motivo: reason, p_por: porRech },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

/* ── protocolo v2: recolecta → incubadora → bandejas → cargas ──────────── */

const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * v2 recolecta. Creates its incubadora in the same save: one recolecta is one
 * incubadora, always, so there is no second form for anyone to forget.
 *
 * The atrayente is changed at every recolecta (fixed formula), so it is a
 * required confirmation here rather than a separate record. The ovipositors
 * are weighed as a set, per insectario — a reference value.
 */
export async function createRecoleccionV2(data) {
  if (!data?.insectario_id) return fail(CODES.VALIDATION, 'Insectario es obligatorio.');
  if (data.atrayente_cambiado !== true) {
    return fail(CODES.VALIDATION, 'Confirma que se cambió el atrayente.');
  }
  const peso = num(data.peso_ovipositores_g);
  if (peso === null || peso <= 0) {
    return fail(CODES.VALIDATION, 'El peso de los ovipositores (g) es obligatorio.');
  }
  const starter = num(data.starter_kg);
  if (starter !== null && starter < 0) return fail(CODES.VALIDATION, 'Los kg de starter no pueden ser negativos.');
  if (data.fecha_inicio && !DIA_RE.test(String(data.fecha_inicio))) {
    return fail(CODES.VALIDATION, 'El día 0 debe ser una fecha (AAAA-MM-DD).');
  }

  const db = await openDb();
  const ins = await rowById(db, 'insectario', data.insectario_id);
  if (!ins || ins.deleted_at) return fail(CODES.NOT_FOUND, 'Insectario no encontrado.');

  const cfg = await protocolo(db);
  const existing = await rowsByIndex(db, 'recoleccion', 'by_insectario', ins.id);
  const recolecta = nextRecolectaOrdinal(existing);
  const codigo = incubadoraCodigo({
    generacion: ins.generacion_moscas, nombreInsectario: ins.nombre_insectario,
    recolecta, letras: cfg.letras_insectario
  });
  // Early warning only: the server's unique index is what decides. The code is
  // written on the trays on día 7, so a collision surfaces long before that.
  if ((await allRows(db, 'incubadora')).some(i => i.codigo === codigo)) {
    return fail(CODES.CONFLICT,
      `Ya existe la incubadora ${codigo}. Revisa la generación del insectario ${ins.codigo}.`);
  }

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);
  const recoleccion = {
    id: uuid(),
    insectario_id: ins.id,
    recolecta,
    fecha,
    huevos_g: null,
    peso_ovipositores_g: peso,
    atrayente_cambiado: true,
    notas: str(data.notas),
    protocolo: 'v2',
    deleted_at: null,
    ...prov
  };
  const incubadora = {
    id: uuid(),
    recoleccion_id: recoleccion.id,
    codigo,
    // Día 0. Defaults to the recolecta's farm day; editable because the lab has
    // yet to confirm whether día 0 is the recolecta or the hatching.
    fecha_inicio: data.fecha_inicio || farmDay(fecha),
    starter_kg: starter,
    individuos_total: null,
    notas: '',
    distribuida_at: null,
    distribuida_por: null,
    estado: 'incubando',
    deleted_at: null,
    ...prov
  };

  await commitWrite(db, {
    writes: [{ store: 'recoleccion', row: recoleccion }, { store: 'incubadora', row: incubadora }],
    outbox: {
      op: 'rpc', rpc: 'crear_recoleccion_v2', rowId: recoleccion.id,
      payload: { p_recoleccion: recoleccion, p_incubadora: incubadora },
      dependsOn: [ins.id],
      createdBy: prov.created_by, dispositivoId: prov.dispositivo_id
    }
  });

  return ok({
    recoleccion: Object.assign(deepCopy(recoleccion), {
      insectario_nombre: ins.nombre_insectario, insectario_codigo: ins.codigo
    }),
    incubadora: deepCopy(incubadora)
  });
}

/**
 * Día 7: the incubadora is split into N bandejas, which get carga 1 in the
 * same action ("Transferencia y primera carga"). All of it is ONE server call,
 * so the trays and their first feeding can never land apart.
 */
export async function distribuirIncubadora(id, data = {}) {
  const n = num(data.n_bandejas);
  if (n === null || !Number.isInteger(n) || n < 1 || n > 99) {
    return fail(CODES.VALIDATION, 'Número de bandejas: entre 1 y 99.');
  }

  const db = await openDb();
  const inc = await rowById(db, 'incubadora', id);
  if (!inc || inc.deleted_at) return fail(CODES.NOT_FOUND, 'Incubadora no encontrada.');
  if (inc.distribuida_at) return fail(CODES.CONFLICT, `La incubadora ${inc.codigo} ya fue distribuida.`);
  const rec = await rowById(db, 'recoleccion', inc.recoleccion_id);
  if (!rec || rec.deleted_at) return fail(CODES.NOT_FOUND, 'La recolecta de esta incubadora no está en el teléfono.');

  const cfg = await protocolo(db);
  const porBandeja = num(data.individuos_por_bandeja) ?? cfg.individuos_por_bandeja;
  if (porBandeja < 0) return fail(CODES.VALIDATION, 'Las larvas por bandeja no pueden ser negativas.');
  const total = num(data.individuos_total) ?? porBandeja * n;

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);

  const bandejas = Array.from({ length: n }, (_, i) => ({
    id: uuid(),
    recoleccion_id: rec.id,
    incubadora_id: inc.id,
    no_bandeja: i + 1,
    id_bandeja: bandejaV2Codigo(inc.codigo, i + 1),
    fecha,
    individuos: porBandeja,
    gramos_huevos: null,
    iniciador_g: null,
    tipo_iniciador: null,
    notas: '',
    estado: 'en_crecimiento',
    cerrada_admin_at: null,
    cerrada_admin_motivo: null,
    protocolo: 'v2',
    deleted_at: null,
    ...prov
  }));

  const c1 = cargaDef(cfg, 1);
  const grupal = uuid();
  const cargas = data.carga1 === false || !c1 ? [] : bandejas.map(b => ({
    id: uuid(),
    bandeja_id: b.id,
    fecha,
    tipo_alimento: ALIMENTO_V2,
    cantidad_kg: c1.kg,
    origen: 'grupal',
    grupal_id: grupal,
    carga: 1,
    tamizado: false,
    notas: '',
    foto_key: null,
    protocolo: 'v2',
    deleted_at: null,
    ...prov
  }));

  const next = {
    ...inc,
    distribuida_at: fecha,
    distribuida_por: prov.registrado_por,
    individuos_total: total,
    estado: 'distribuida',
    updated_at: nowIso()
  };

  await commitWrite(db, {
    writes: [
      { store: 'incubadora', row: next },
      ...bandejas.map(row => ({ store: 'bandeja', row })),
      ...cargas.map(row => ({ store: 'alimentacion', row }))
    ],
    outbox: {
      op: 'rpc', rpc: 'distribuir_incubadora', rowId: inc.id,
      payload: {
        p_distribucion: { incubadora_id: inc.id, fecha, registrado_por: prov.registrado_por,
                          individuos_total: total },
        p_bandejas: bandejas,
        p_cargas: cargas
      },
      // Waits for the recolecta + incubadora if they are still queued.
      dependsOn: [inc.id],
      createdBy: prov.created_by, dispositivoId: prov.dispositivo_id
    },
    refreshTrays: bandejas.map(b => b.id)
  });

  return ok({ incubadora: deepCopy(next), bandejas: deepCopy(bandejas), cargas: cargas.length });
}

/**
 * v2 feeding: one tap, nothing typed. The diet is fixed, so the load number
 * decides the kilos (carga 1 = 1,5 kg, 2 = 2 kg, 3 = 2 kg by default). Several
 * trays at once travel as ONE server call, like the old bulk feed.
 */
export async function logCarga(data) {
  const lista = Array.isArray(data?.bandeja_ids) ? data.bandeja_ids : [data?.bandeja_id];
  const ids = [...new Set(lista.filter(Boolean))];
  if (!ids.length) return fail(CODES.VALIDATION, 'Selecciona al menos una bandeja.');

  const db = await openDb();
  const cfg = await protocolo(db);
  const def = cargaDef(cfg, data.carga);
  if (!def) {
    return fail(CODES.VALIDATION, `Indica qué carga es (${cfg.cargas.map(c => c.n).join(', ')}).`);
  }

  const trays = new Map((await allRows(db, 'bandeja')).map(t => [t.id, t]));
  const unknown = ids.filter(id => !trays.has(id));
  if (unknown.length) {
    return fail(CODES.NOT_FOUND, `${unknown.length} bandeja(s) ya no existen en este teléfono. Vuelve a elegirlas.`);
  }
  const v1 = ids.filter(id => !esV2(trays.get(id)));
  if (v1.length) {
    return fail(CODES.VALIDATION,
      `Estas bandejas son del protocolo anterior y usan el formulario anterior: ${etiquetas(trays, v1)}.`);
  }
  const cerradas = ids.filter(id => ['en_ayuno', 'cosechada'].includes(trays.get(id).estado));
  if (cerradas.length) {
    return fail(CODES.CONFLICT, `Ya no se alimentan (ayuno o cosecha): ${etiquetas(trays, cerradas)}.`);
  }
  const dadas = new Set((await allRows(db, 'alimentacion'))
    .filter(a => Number(a.carga) === def.n && ids.includes(a.bandeja_id))
    .map(a => a.bandeja_id));
  if (dadas.size) {
    return fail(CODES.CONFLICT, `Ya recibieron la carga ${def.n}: ${etiquetas(trays, [...dadas])}.`);
  }

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);
  const grupal = ids.length > 1 ? uuid() : null;
  const rows = ids.map(bandeja_id => ({
    id: uuid(),
    bandeja_id,
    fecha,
    tipo_alimento: ALIMENTO_V2,
    cantidad_kg: def.kg,
    origen: grupal ? 'grupal' : 'individual',
    grupal_id: grupal,
    carga: def.n,
    tamizado: Boolean(data.tamizado),
    notas: str(data.notas),
    foto_key: null,
    protocolo: 'v2',
    deleted_at: null,
    ...prov
  }));

  const outbox = grupal
    ? { op: 'rpc', rpc: 'log_alimentacion_grupal', rowId: grupal, payload: { p_rows: rows } }
    : { op: 'upsert', table: 'alimentacion', rowId: rows[0].id, payload: rows[0] };

  await commitWrite(db, {
    writes: rows.map(row => ({ store: 'alimentacion', row })),
    outbox: { ...outbox, dependsOn: ids, createdBy: prov.created_by, dispositivoId: prov.dispositivo_id },
    refreshTrays: ids
  });

  return ok({ carga: def.n, kg: def.kg, created: rows.length, rows: deepCopy(rows) });
}
