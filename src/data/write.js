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
import { commitWrite, rowById, allRows, rowsByIndex } from './store.js';
import { uuid, uuidFromString, deviceId, insectarioCodigo, bandejaLabel, cochadaCodigo, nextRecolectaOrdinal } from './ids.js';
import { nowIso, utcIso, farmDay, addDays } from './time.js';
import { currentUserId } from './session.js';
import { metaGet, metaSet } from './idb/tx.js';
import { attachPhoto } from './photo.js';
import { OVEN_CAPACITY } from './config.js';

/**
 * Fields stamped on every row we originate.
 *
 * `registrado_por` is the name as typed — plain text, no lookup, no foreign
 * key. Nothing here can fail because a device has not synced a roster yet.
 */
async function provenance(operatorName) {
  return {
    registrado_por: str(operatorName) || null,
    created_by: currentUserId(),      // null until real logins exist
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

  const next = { ...row, [field]: value, updated_at: nowIso() };
  await commitWrite(db, {
    writes: [{ store: 'insectario', row: next }],
    outbox: {
      op: 'cas',
      rpc: field === 'fecha_ovipositores' ? 'marcar_atractante' : 'marcar_cierre',
      rowId: id,
      payload: { p_id: id, p_fecha: value },
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
  if (!tray) return { error: fail(CODES.NOT_FOUND, 'Bandeja no encontrada.') };
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

export async function logAlimentacion(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  if (!data.tipo_alimento) return fail(CODES.VALIDATION, 'Tipo de alimento es obligatorio.');
  const db = await openDb();
  const { error, row } = await eventBase(db, data, {
    tipo_alimento: data.tipo_alimento,
    cantidad_kg: num(data.cantidad_kg) ?? 0,
    origen: 'individual',
    grupal_id: null
  });
  if (error) return error;
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
  const trays = await allRows(db, 'bandeja');
  const known = new Set(trays.map(t => t.id));
  const unknown = ids.filter(id => !known.has(id));
  if (unknown.length) return fail(CODES.NOT_FOUND, `Bandeja no encontrada: ${unknown.join(', ')}`);

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

export async function logAyuno(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  const pi = num(data.peso_inicial_kg);
  if (pi === null || pi <= 0) return fail(CODES.VALIDATION, 'Peso inicial es obligatorio.');

  const db = await openDb();
  const { error, row } = await eventBase(db, data, {
    peso_inicial_kg: pi,
    horas_ayuno: num(data.horas_ayuno) ?? 24,
    peso_final_kg: num(data.peso_final_kg),
    cerrado_at: num(data.peso_final_kg) !== null ? nowIso() : null
  });
  if (error) return error;
  return commitEvent(db, 'ayuno', row, { blobId: data.blob_id });
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
  if (pf === null || pf < 0) return fail(CODES.VALIDATION, 'Peso final es obligatorio.');

  const db = await openDb();
  const row = await rowById(db, 'ayuno', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Ayuno no encontrado.');
  if (row.peso_final_kg !== null && row.peso_final_kg !== undefined) {
    return fail(CODES.CONFLICT, 'Este ayuno ya fue cerrado.');
  }
  if (pf > row.peso_inicial_kg) {
    return fail(CODES.VALIDATION, 'El peso final no puede superar el peso inicial.');
  }

  const cerrado = nowIso();
  const next = { ...row, peso_final_kg: pf, cerrado_at: cerrado, updated_at: cerrado };

  await commitWrite(db, {
    writes: [{ store: 'ayuno', row: next }],
    outbox: {
      op: 'cas', rpc: 'cerrar_ayuno', rowId: id,
      payload: { p_id: id, p_peso: pf, p_at: cerrado },
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

export async function logSeparacion(data) {
  if (!data?.bandeja_id) return fail(CODES.VALIDATION, 'Bandeja es obligatoria.');
  const g = num(data.larva_limpia_g);
  if (g === null || g < 0) return fail(CODES.VALIDATION, 'Larva limpia (g) es obligatoria.');

  const db = await openDb();
  // Advisory: catches the common case where THIS device already knows. Offline,
  // another device may have separated the same tray and we cannot tell — the
  // unique index decides and the loser goes to the conflict inbox.
  const existing = await rowsByIndex(db, 'separacion', 'by_bandeja', data.bandeja_id);
  if (existing.length) {
    return fail(CODES.CONFLICT, 'Esta bandeja ya tiene una separación registrada.');
  }

  const { error, row } = await eventBase(db, data, { larva_limpia_g: g });
  if (error) return error;
  return commitEvent(db, 'separacion', row, { blobId: data.blob_id });
}

/* ── cochada ────────────────────────────────────────────────────────────── */

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
  if (unknown.length) return fail(CODES.NOT_FOUND, `Separación no encontrada: ${unknown.join(', ')}`);

  const links = await allRows(db, 'cochada_separacion');
  const pooled = new Set(links.map(l => l.separacion_id));
  const already = sepIds.filter(id => pooled.has(id));
  if (already.length) return fail(CODES.CONFLICT, `Ya está en otra cochada: ${already.join(', ')}`);

  const fecha = isoOrNow(data.fecha);
  const prov = await provenance(data.operator_name);
  const id = uuid();

  const cochada = {
    id,
    codigo: cochadaCodigo(fecha),
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
    cochada_id: id, separacion_id,
    created_at: prov.created_at, updated_at: prov.updated_at
  }));

  const trays = seps.filter(s => sepIds.includes(s.id)).map(s => s.bandeja_id);

  await commitWrite(db, {
    writes: [
      { store: 'cochada', row: cochada },
      ...linkRows.map(row => ({ store: 'cochada_separacion', row }))
    ],
    // One RPC, so a cochada and its links can never land apart. The old Lotes
    // table pointed at nothing precisely because those were separate writes.
    outbox: {
      op: 'rpc', rpc: 'crear_cochada', rowId: id,
      payload: { p_cochada: cochada, p_separacion_ids: sepIds },
      dependsOn: sepIds,
      createdBy: prov.created_by, dispositivoId: prov.dispositivo_id
    },
    refreshTrays: trays
  });

  const { getLoteDetail } = await import('./read.js');
  const d = await getLoteDetail(id);
  return d.ok ? ok(d.data.lote) : ok(cochada);
}

async function patchCochada(id, patch, outbox) {
  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  const next = { ...row, ...patch, updated_at: nowIso() };
  await commitWrite(db, { writes: [{ store: 'cochada', row: next }], outbox });
  const { getLoteDetail } = await import('./read.js');
  const d = await getLoteDetail(id);
  return d.ok ? ok(d.data.lote) : ok(next);
}

export async function updateLoteQC(id, data) {
  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  if (row.despachado_at || row.rechazado_at) {
    return fail(CODES.CONFLICT, 'Esta cochada ya está cerrada.');
  }

  const patch = {};
  if (data.tiempo_secado_horas !== undefined) patch.tiempo_secado_horas = num(data.tiempo_secado_horas);
  if (data.peso_final_kg !== undefined) patch.peso_final_kg = num(data.peso_final_kg);
  if (data.qc_color_dorado !== undefined) patch.qc_color_dorado = data.qc_color_dorado;
  if (data.qc_prueba_crujiente !== undefined) patch.qc_prueba_crujiente = str(data.qc_prueba_crujiente);
  // Explicit decision rather than a side effect of typing a weight.
  if (data.qc_aprobado !== undefined) patch.qc_aprobado = data.qc_aprobado;

  // Preserve the prototype's foto -> qc_foto mapping (dataClient.js:345); the
  // differing field name is easy to lose in a rewrite.
  const blobIds = [];
  if (data.blob_id) {
    patch.qc_foto_key = await attachPhoto(db, data.blob_id, 'cochada', id);
    blobIds.push(data.blob_id);
  }

  return patchCochada(id, patch, {
    op: 'cas', rpc: 'actualizar_qc_cochada', rowId: id,
    blobIds,
    payload: {
      p_id: id,
      p_tiempo: patch.tiempo_secado_horas ?? null,
      p_peso_final: patch.peso_final_kg ?? null,
      p_color: patch.qc_color_dorado ?? null,
      p_prueba: patch.qc_prueba_crujiente ?? null,
      p_aprobado: patch.qc_aprobado ?? null,
      p_foto_key: patch.qc_foto_key ?? null
    },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

export async function marcarEmpacado(id, data) {
  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  if (row.qc_aprobado !== true) {
    return fail(CODES.VALIDATION, 'Primero aprueba el control de calidad.');
  }
  if (row.empacado_at) return ok(row);

  return patchCochada(id, {
    empacado_at: nowIso(),
    fecha_vencimiento: data?.fecha_vencimiento || addDays(farmDay(), 180)
  }, {
    op: 'cas', rpc: 'marcar_empacado', rowId: id,
    payload: { p_id: id, p_vencimiento: data?.fecha_vencimiento || null },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

export async function marcarDespachado(id) {
  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  // The prototype could dispatch before packing (dataClient.js:359).
  if (!row.empacado_at) return fail(CODES.VALIDATION, 'Primero marca la cochada como empacada.');
  if (row.despachado_at) return ok(row);

  return patchCochada(id, { despachado_at: nowIso() }, {
    op: 'cas', rpc: 'marcar_despachado', rowId: id, payload: { p_id: id },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}

/** QC failure — mold, over-toasting, a failed crunch test. Terminal. */
export async function rechazarCochada(id, motivo) {
  const reason = str(motivo);
  if (!reason) return fail(CODES.VALIDATION, 'Indica el motivo del rechazo.');

  const db = await openDb();
  const row = await rowById(db, 'cochada', id);
  if (!row) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  if (row.despachado_at) return fail(CODES.CONFLICT, 'Esta cochada ya fue despachada.');
  if (row.rechazado_at) return ok(row);

  return patchCochada(id, { rechazado_at: nowIso(), rechazo_motivo: reason, qc_aprobado: false }, {
    op: 'cas', rpc: 'rechazar_cochada', rowId: id,
    payload: { p_id: id, p_motivo: reason },
    createdBy: currentUserId(), dispositivoId: deviceId()
  });
}
