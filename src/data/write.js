/**
 * write.js — every write the UI performs.
 *
 * Each one does the same three things, atomically:
 *   1. build the rows with CLIENT-generated UUIDs
 *   2. apply them locally and enqueue them for the server in ONE transaction
 *   3. return ok() immediately — the operator never waits for the network
 *
 * The write classes, and why they differ:
 *
 *   APPEND      insert-only, idempotent via ON CONFLICT (id) DO NOTHING:
 *               recolecta, chequeo, carga, separación, lectura, cierre y
 *               limpieza, cambio de rack, recepción, and registering racks,
 *               contenedores and jaulas. Two devices never collide on a UUID.
 *
 *   ATOMIC      several rows that must land together or not at all, through
 *               one call that validates before writing and is safe to replay:
 *               distribuir, crear_cochada, ingresar, crear_ensilado.
 *
 *   CAS         "first write wins" stamps: abrir_ensilado, cerrar_objeto. The
 *               server guards with `WHERE col IS NULL`, so a replay out of
 *               order is a no-op rather than an overwrite.
 *
 *   EDIT        editar and marcar_revisado: the last edit overwrites, keeping
 *               who and when.
 *
 * A UNIQUE rule the phone cannot see (another phone separated the same caja
 * offline) is the server's to enforce; the loser lands in the conflict inbox
 * rather than being silently dropped.
 *
 * Dates: today, with the time adjustable; only a recolecta may carry a past
 * date, and then only with the excepción switch. Corrections are free.
 */
import { ok, fail, CODES, num, str, deepCopy } from './envelope.js';
import { openDb } from './idb/open.js';
import { commitWrite, rowById, allRows } from './store.js';
import {
  uuid, uuidFromString, deviceId, siguienteIncubadora, cajaCodigo, siguienteCochada,
  ensiladoCodigo, siguientesBandejas
} from './ids.js';
import { nowIso, utcIso, farmDay, ddmm } from './time.js';
import { currentUserId } from './session.js';
import { metaGet, metaSet } from './idb/tx.js';
import { attachPhoto } from './photo.js';
import { cargaDef, cargaDistribucion, kg3 } from './protocolo.js';
import { pool2 } from './pool.js';
import { generacionDeJaula } from './revisar.js';
import { EDITABLE, SIEMPRE, camposDe, leerCampo } from './registros.js';
import { vistaActual, invalidarSnapshot } from './snapshot.js';

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
 * trusting each form to pass one. QA once found every record of three forms
 * saving `registrado_por: null` while the header said "registrando como
 * Ricardo": the forms never seeded the name. The default lives here, where a
 * new form cannot skip it.
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

/** Columns every record carries, empty on creation. */
const NUEVO = { nota: '', foto_key: null, editado_at: null, editado_por: null,
                valores_editados_at: null, revisado_at: null, deleted_at: null };

const invalido = msg => fail(CODES.VALIDATION, msg);

/**
 * The moment a record is dated. `<input type="datetime-local">` gives naive
 * wall-clock text, read as FARM-local time (time.js). It must be today: the
 * time can be moved, the day cannot — unless `pasado` (a recolecta with the
 * excepción switch). Never a future day.
 */
function fechaDe(v, { pasado = false } = {}) {
  const iso = v ? utcIso(v) : nowIso();
  if (!iso) return { error: 'Fecha no válida.' };
  const dia = farmDay(iso), hoy = farmDay();
  if (dia > hoy) return { error: 'La fecha no puede ser de un día que no ha llegado.' };
  if (!pasado && dia !== hoy) return { error: 'Se registra con la fecha de hoy; sólo la hora se puede cambiar.' };
  return { iso };
}

/** Commit, then forget the cached picture of the lab: it just changed. */
async function guardar(db, args) {
  const item = await commitWrite(db, args);
  invalidarSnapshot();
  return item;
}

/** A photo taken in the form becomes the record's photo. */
async function conFoto(db, row, tabla, blobId) {
  if (!blobId) return [];
  row.foto_key = await attachPhoto(db, blobId, tabla, row.id);
  return [blobId];
}

const outboxDe = (row, extra = {}) => ({
  createdBy: row.created_by, dispositivoId: row.dispositivo_id, ...extra
});

/* ── who is registering ─────────────────────────────────────────────────── */

/**
 * Remember a name locally so it comes back as a one-tap chip, and add it to
 * the shared list so it appears on every phone.
 *
 * The id is derived from the name, so two people typing "Jose" at the same
 * time produce the same row instead of a conflict.
 */
export async function rememberOperator(nombre) {
  const n = str(nombre);
  if (!n) return invalido('Escribe tu nombre.');
  if (n.length > 60) return invalido('El nombre es demasiado largo.');

  const db = await openDb();
  await metaSet(db, OPERADOR_KEY, n);

  const list = (await metaGet(db, 'nombres_usados', [])) || [];
  const rest = list.filter(r => String(r?.nombre || '').toLowerCase() !== n.toLowerCase());
  await metaSet(db, 'nombres_usados', [{ nombre: n, lastUsed: nowIso() }, ...rest].slice(0, 30));

  const all = await allRows(db, 'catalogo');
  const already = all.some(c => c.tipo === 'operario' && String(c.valor).toLowerCase() === n.toLowerCase());
  if (!already) {
    const row = {
      id: uuidFromString('operario:' + n.toLowerCase()),
      tipo: 'operario', valor: n, orden: 100, activo: true,
      created_at: nowIso(), updated_at: nowIso()
    };
    await guardar(db, {
      writes: [{ store: 'catalogo', row }],
      outbox: { op: 'upsert', table: 'catalogo', rowId: row.id, payload: row,
                createdBy: currentUserId(), dispositivoId: deviceId() }
    });
  }
  return ok({ nombre: n });
}

/* ── objects registered once ────────────────────────────────────────────── */

async function registrarSimple(tabla, row, data, { dependsOn = [] } = {}) {
  const db = await openDb();
  const blobIds = await conFoto(db, row, tabla, data.blob_id);
  await guardar(db, {
    writes: [{ store: tabla, row }],
    outbox: outboxDe(row, { op: 'upsert', table: tabla, rowId: row.id, payload: row, dependsOn, blobIds })
  });
  return ok(deepCopy(row));
}

const mismoTexto = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

export async function registrarRack(data = {}) {
  const codigo = str(data.codigo).toUpperCase();
  if (!codigo) return invalido('Escribe el código del rack.');
  const v = await vistaActual(await openDb());
  if (v.racks.some(r => mismoTexto(r.codigo, codigo))) return invalido(`Ya existe el rack ${codigo}.`);
  const row = { id: uuid(), codigo, estado: 'activo', ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  return registrarSimple('rack', row, data);
}

export async function registrarContenedor(data = {}) {
  const codigo = str(data.codigo).toUpperCase();
  if (!codigo) return invalido('Escribe el código del contenedor.');
  const v = await vistaActual(await openDb());
  if (v.contenedores.some(c => mismoTexto(c.codigo, codigo))) return invalido(`Ya existe el contenedor ${codigo}.`);
  const row = { id: uuid(), codigo, estado: 'activo', ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  return registrarSimple('contenedor', row, data);
}

/**
 * A cage, once: its name, the letter its incubadoras carry, where it is, the
 * generation it has now, and whether it has flies or is clean.
 */
export async function registrarJaula(data = {}) {
  const nombre = str(data.nombre).toUpperCase();
  const letra = leerCampo('letra', data.letra);
  const gen = leerCampo('generacion', data.generacion);
  if (!nombre) return invalido('Escribe el nombre de la jaula.');
  if (letra.error) return invalido(`Letra: ${letra.error}`);
  if (gen.error) return invalido(`Generación: ${gen.error}`);
  if (!['activa', 'limpia'].includes(data.fase)) return invalido('Indica si tiene moscas o está limpia.');
  const v = await vistaActual(await openDb());
  if (v.jaulas.some(j => mismoTexto(j.nombre, nombre))) return invalido(`Ya existe la jaula ${nombre}.`);
  const otra = v.jaulas.find(j => mismoTexto(j.letra, letra.value));
  if (otra) return invalido(`La letra ${letra.value} ya es de la jaula ${otra.nombre}.`);
  const row = {
    id: uuid(), nombre, letra: letra.value, lugar: str(data.lugar),
    generacion_inicial: gen.value, fase_inicial: data.fase,
    ...NUEVO, nota: str(data.nota), ...(await provenance(data.operator_name))
  };
  return registrarSimple('jaula', row, data);
}

/* ── the larvae cycle ───────────────────────────────────────────────────── */

/**
 * Recolecta: creates the incubadora, día 0. F{gen}{letra}-{n}.
 *
 *   { jaula_id, rack_id, peso_inicial_g, alimento_inicial_kg, fecha?, excepcion? }
 *
 * Its food is taken from the open ensilado (alimento.js works that out).
 */
export async function registrarRecolecta(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const jaula = v.por.jaula.get(data.jaula_id);
  if (!jaula) return invalido('Elige la jaula.');
  const jv = v.jaulas.find(j => j.id === jaula.id);
  if (jv.fase !== 'activa') return invalido(`La jaula ${jaula.nombre} no tiene moscas (${jv.fase === 'cerrada' ? 'está cerrada' : 'está limpia'}).`);
  if (!v.por.rack.get(data.rack_id)) return invalido('Elige el rack.');
  const peso = num(data.peso_inicial_g);
  if (peso === null || peso < 0) return invalido('Escribe el peso inicial en gramos.');
  const alimento = num(data.alimento_inicial_kg);
  if (alimento === null || alimento < 0) return invalido('Escribe los kg de alimento inicial.');
  const excepcion = data.excepcion === true;
  const f = fechaDe(data.fecha, { pasado: excepcion });
  if (f.error) return invalido(f.error);

  // The cage's generation at that moment (a late recolecta may predate its
  // last repopulation).
  const generacion = generacionDeJaula(jaula.id, f.iso, { jaulas: v.jaulas, ingresos: v.ingresos });
  const { codigo, numero } = siguienteIncubadora(generacion, jaula.letra, v.incubadoras.map(i => i.codigo));

  const row = {
    id: uuid(), codigo, jaula_id: jaula.id, generacion, numero,
    recolecta_at: f.iso, dia0: farmDay(f.iso), excepcion,
    rack_id: data.rack_id, peso_inicial_g: peso, alimento_inicial_kg: alimento,
    estado: 'activo', cerrado_at: null, cerrado_por: null, motivo_cierre: null,
    ...NUEVO, nota: str(data.nota), ...(await provenance(data.operator_name))
  };
  const blobIds = await conFoto(db, row, 'incubadora', data.blob_id);
  await guardar(db, {
    writes: [{ store: 'incubadora', row }],
    outbox: outboxDe(row, { op: 'upsert', table: 'incubadora', rowId: row.id, payload: row,
                            dependsOn: [jaula.id, data.rack_id], blobIds })
  });
  return ok(deepCopy(row));
}

/**
 * Chequeos of one scheduled day: substrate humidity and temperature, and the
 * weight — grams in an incubadora (día 3), kilos in a caja (días 10 y 14).
 *
 *   { objeto: 'incubadora' | 'caja', dia, fecha?, items: [{ id, humedad_pct, temperatura_c, peso }] }
 */
export async function registrarChequeos(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const enCaja = data.objeto === 'caja';
  const dia = Number(data.dia);
  const dias = enCaja ? v.cfg.dias_chequeo_caja : [v.cfg.dia_chequeo_incubadora];
  if (!dias.includes(dia)) return invalido(`No hay chequeo de ${enCaja ? 'caja' : 'incubadora'} el día ${data.dia}.`);
  const items = (data.items || []).filter(Boolean);
  if (!items.length) return invalido('Elige al menos una.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const prov = await provenance(data.operator_name);

  const rows = [];
  for (const it of items) {
    const obj = enCaja ? v.por.caja.get(it.id) : v.por.incubadora.get(it.id);
    if (!obj) return invalido('Una de las elegidas ya no existe en este teléfono.');
    if (obj.estado !== 'activo') return invalido(`${obj.codigo} ya no está activa.`);
    if (obj.chequeos.some(c => Number(c.dia) === dia)) return invalido(`${obj.codigo} ya tiene el chequeo del día ${dia}.`);
    const hum = leerCampo('pct', it.humedad_pct);
    const tem = leerCampo('temp', it.temperatura_c);
    const peso = leerCampo(enCaja ? 'kg' : 'g', it.peso);
    if (hum.error || tem.error || peso.error) {
      return invalido(`${obj.codigo}: ${hum.error ? `humedad — ${hum.error}` : tem.error ? `temperatura — ${tem.error}` : `peso — ${peso.error}`}`);
    }
    rows.push({
      id: uuid(), incubadora_id: enCaja ? null : obj.id, caja_id: enCaja ? obj.id : null,
      dia, fecha: f.iso, humedad_pct: hum.value, temperatura_c: tem.value,
      peso_g: enCaja ? null : peso.value, peso_kg: enCaja ? peso.value : null,
      ...NUEVO, ...prov
    });
  }
  for (const row of rows) {
    await guardar(db, {
      writes: [{ store: 'chequeo', row }],
      outbox: outboxDe(row, { op: 'upsert', table: 'chequeo', rowId: row.id, payload: row,
                              dependsOn: [row.incubadora_id || row.caja_id] })
    });
  }
  return ok(deepCopy(rows));
}

/**
 * Tamizado, pesado y distribución: the total sieved, then each caja with its
 * weight, rack and carga 1. The incubadora becomes inactive; its cajas are
 * {incubadora}-01, -02… All of it lands together or not at all.
 *
 *   { incubadora_id, peso_total_kg, fecha?, cajas: [{ peso_inicial_kg, rack_id, carga_kg }] }
 */
export async function distribuir(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const inc = v.por.incubadora.get(data.incubadora_id);
  if (!inc) return invalido('Incubadora no encontrada.');
  if (inc.estado !== 'activo') return invalido(`La incubadora ${inc.codigo} ya fue ${inc.distribucion ? 'distribuida' : 'cerrada'}.`);
  const total = num(data.peso_total_kg);
  if (total === null || total < 0) return invalido('Escribe los kg de larvas tamizadas.');
  const cajasIn = (data.cajas || []).filter(Boolean);
  if (!cajasIn.length) return invalido('Agrega al menos una caja.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const plan = cargaDistribucion(v.cfg);
  const prov = await provenance(data.operator_name);

  const dist = { id: uuid(), incubadora_id: inc.id, fecha: f.iso, peso_total_kg: total,
                 ...NUEVO, nota: str(data.nota), ...prov };
  const cajas = [], cargas = [];
  for (const [i, c] of cajasIn.entries()) {
    const n = i + 1;
    const peso = num(c.peso_inicial_kg);
    if (peso === null || peso < 0) return invalido(`Caja ${n}: escribe su peso en kg.`);
    if (!v.por.rack.get(c.rack_id)) return invalido(`Caja ${n}: elige su rack.`);
    const kg = num(c.carga_kg ?? plan?.kg);
    if (kg === null || kg < 0) return invalido(`Caja ${n}: escribe los kg de la carga ${plan?.n ?? 1}.`);
    const caja = {
      id: uuid(), codigo: cajaCodigo(inc.codigo, n), incubadora_id: inc.id, distribucion_id: dist.id,
      numero: n, rack_id: c.rack_id, peso_inicial_kg: peso,
      estado: 'activo', cerrado_at: null, cerrado_por: null, motivo_cierre: null, ...NUEVO, ...prov
    };
    cajas.push(caja);
    cargas.push({ id: uuid(), caja_id: caja.id, carga: plan?.n ?? 1, fecha: f.iso, kg,
                  kg_plan: plan?.kg ?? null, dia_plan: plan?.dia ?? null, ...NUEVO, ...prov });
  }
  const blobIds = await conFoto(db, dist, 'distribucion', data.blob_id);

  // The call reads each field it needs by name (0010); these are those fields.
  const wire = r => { const { updated_at, estado, ...rest } = r; return rest; };
  await guardar(db, {
    writes: [{ store: 'distribucion', row: dist },
             ...cajas.map(row => ({ store: 'caja', row })),
             ...cargas.map(row => ({ store: 'alimentacion', row }))],
    outbox: outboxDe(dist, {
      op: 'rpc', rpc: 'distribuir', rowId: dist.id,
      payload: { p_distribucion: wire(dist), p_cajas: cajas.map(wire), p_cargas: cargas.map(wire) },
      dependsOn: [inc.id, ...new Set(cajas.map(c => c.rack_id))], blobIds
    })
  });
  return ok(deepCopy({ distribucion: dist, cajas, cargas }));
}

/**
 * Cargas 2 y 3, confirmed as planned or with the kilos changed. A carga on a
 * chequeo day waits for that chequeo; once the día-14 chequeo starts the
 * ayuno there are no more.
 *
 *   { carga, fecha?, items: [{ caja_id, kg }] }
 */
export async function registrarCargas(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const def = cargaDef(v.cfg, data.carga);
  if (!def || def.dia === v.cfg.dia_distribucion) return invalido('Esa carga no está en el plan.');
  const items = (data.items || []).filter(Boolean);
  if (!items.length) return invalido('Elige al menos una caja.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const prov = await provenance(data.operator_name);

  const rows = [];
  for (const it of items) {
    const caja = v.por.caja.get(it.caja_id);
    if (!caja) return invalido('Una de las cajas ya no existe en este teléfono.');
    if (caja.estado !== 'activo') return invalido(`La caja ${caja.codigo} ya no está activa.`);
    if (caja.en_ayuno) return invalido(`La caja ${caja.codigo} está en ayuno: no se alimenta hasta la separación.`);
    if (caja.cargas.some(c => Number(c.carga) === def.n)) return invalido(`La caja ${caja.codigo} ya tiene la carga ${def.n}.`);
    if (v.cfg.dias_chequeo_caja.includes(def.dia) && !caja.chequeos.some(c => Number(c.dia) === def.dia)) {
      return invalido(`La caja ${caja.codigo}: primero el chequeo del día ${def.dia}, después la carga.`);
    }
    const kg = num(it.kg ?? def.kg);
    if (kg === null || kg < 0) return invalido(`La caja ${caja.codigo}: escribe los kg.`);
    rows.push({ id: uuid(), caja_id: caja.id, carga: def.n, fecha: f.iso, kg,
                kg_plan: def.kg, dia_plan: def.dia, ...NUEVO, ...prov });
  }
  for (const row of rows) {
    await guardar(db, {
      writes: [{ store: 'alimentacion', row }],
      outbox: outboxDe(row, { op: 'upsert', table: 'alimentacion', rowId: row.id, payload: row, dependsOn: [row.caja_id] })
    });
  }
  return ok(deepCopy(rows));
}

/**
 * Separación, caja by caja: the total weight. The split (98 % horno, 2 %
 * retorno) is the database's to compute, from the percentage in force.
 *
 *   { fecha?, items: [{ caja_id, peso_total_kg }] }
 */
export async function registrarSeparaciones(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const items = (data.items || []).filter(Boolean);
  if (!items.length) return invalido('Elige al menos una caja.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const prov = await provenance(data.operator_name);

  const rows = [];
  for (const it of items) {
    const caja = v.por.caja.get(it.caja_id);
    if (!caja) return invalido('Una de las cajas ya no existe en este teléfono.');
    if (caja.separacion) return invalido(`La caja ${caja.codigo} ya fue separada.`);
    if (caja.estado !== 'activo') return invalido(`La caja ${caja.codigo} ya no está activa.`);
    const peso = num(it.peso_total_kg);
    if (peso === null || peso < 0) return invalido(`La caja ${caja.codigo}: escribe el peso total en kg.`);
    rows.push({ id: uuid(), caja_id: caja.id, fecha: f.iso, peso_total_kg: peso,
                pct_coccion: v.cfg.pct_coccion, ...NUEVO, ...prov });
  }
  for (const row of rows) {
    await guardar(db, {
      writes: [{ store: 'separacion', row }],
      outbox: outboxDe(row, { op: 'upsert', table: 'separacion', rowId: row.id, payload: row, dependsOn: [row.caja_id] })
    });
  }
  return ok(deepCopy(rows));
}

/* ── the oven ───────────────────────────────────────────────────────────── */

/**
 * A cochada: the kilos taken from each separación's 98 % (one 98 % may be
 * split across cochadas), and the weight that went into the oven. H-{ddmm}-{n}.
 *
 *   { fecha?, peso_inicial_kg, origenes: [{ separacion_id, kg }] }
 */
export async function crearCochada(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const origenesIn = (data.origenes || []).filter(o => o && num(o.kg) > 0);
  if (!origenesIn.length) return invalido('Elige de qué separaciones sale y cuántos kg de cada una.');
  const peso = num(data.peso_inicial_kg);
  if (peso === null || peso <= 0) return invalido('Escribe el peso inicial en kg.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const pendiente = new Map(v.horno.map(h => [h.separacion_id, h]));
  for (const o of origenesIn) {
    const h = pendiente.get(o.separacion_id);
    if (!h) return invalido('Una de las separaciones ya no existe en este teléfono.');
    if (kg3(o.kg) > h.kg_pendiente) {
      const caja = v.cajas.find(c => c.id === h.caja_id);
      return invalido(`De ${caja ? caja.codigo : 'esa separación'} quedan ${h.kg_pendiente} kg del 98 %.`);
    }
  }
  const prov = await provenance(data.operator_name);
  const hoyCodigos = v.cochadas.filter(c => farmDay(c.horno_at) === farmDay(f.iso)).map(c => c.codigo);
  const cochada = {
    id: uuid(), codigo: siguienteCochada(f.iso, hoyCodigos), horno_at: f.iso, peso_inicial_kg: peso,
    estado: 'activo', cerrado_at: null, cerrado_por: null, motivo_cierre: null,
    ...NUEVO, nota: str(data.nota), ...prov
  };
  const origenes = origenesIn.map(o => ({ id: uuid(), cochada_id: cochada.id, separacion_id: o.separacion_id,
                                          kg: kg3(o.kg), ...NUEVO, ...prov }));
  const blobIds = await conFoto(db, cochada, 'cochada', data.blob_id);
  const wire = r => { const { updated_at, estado, ...rest } = r; return rest; };
  await guardar(db, {
    writes: [{ store: 'cochada', row: cochada }, ...origenes.map(row => ({ store: 'cochada_origen', row }))],
    outbox: outboxDe(cochada, {
      op: 'rpc', rpc: 'crear_cochada', rowId: cochada.id,
      payload: { p_cochada: wire(cochada), p_origenes: origenes.map(wire) },
      dependsOn: origenes.map(o => o.separacion_id), blobIds
    })
  });
  return ok(deepCopy({ cochada, origenes }));
}

/**
 * The oven readings: the temperature half way, then the temperature and the
 * weight at the end — which leaves the cochada ready for packing (inactive).
 *
 *   { cochada_id, momento: 'media' | 'final', temperatura_c, peso_kg?, fecha? }
 */
export async function registrarLectura(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const co = v.cochadas.find(c => c.id === data.cochada_id);
  if (!co) return invalido('Cochada no encontrada.');
  if (co.estado !== 'activo') return invalido(`La cochada ${co.codigo} ya salió del horno.`);
  if (!['media', 'final'].includes(data.momento)) return invalido('¿A mitad o al final?');
  if (data.momento === 'media' && co.media) return invalido('Ya tiene la temperatura de la mitad.');
  const tem = leerCampo('horno', data.temperatura_c);
  if (tem.error) return invalido(tem.error);
  let peso = null;
  if (data.momento === 'final') {
    peso = num(data.peso_kg);
    if (peso === null || peso < 0) return invalido('Escribe el peso final en kg.');
  }
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const row = { id: uuid(), cochada_id: co.id, momento: data.momento, fecha: f.iso,
                temperatura_c: tem.value, peso_kg: peso, ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  const blobIds = await conFoto(db, row, 'cochada_lectura', data.blob_id);
  await guardar(db, {
    writes: [{ store: 'cochada_lectura', row }],
    outbox: outboxDe(row, { op: 'upsert', table: 'cochada_lectura', rowId: row.id, payload: row,
                            dependsOn: [co.id], blobIds })
  });
  return ok(deepCopy(row));
}

/* ── the insectario ─────────────────────────────────────────────────────── */

/**
 * Repopulate a closed and cleaned cage: the kilos of larvae taken from the 2 %
 * (oldest first), assembled with conditioning into trays of ~4,7 kg that go
 * in the same day. The cage takes the larvae's generation + 1.
 *
 *   { jaula_id, kg_larvas, fecha?, bandejas: [{ peso_kg, rack_id }],
 *     generacion_larvas? — only when the 2 % has no record to tell it }
 */
export async function registrarIngreso(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const jaula = v.jaulas.find(j => j.id === data.jaula_id);
  if (!jaula) return invalido('Elige la jaula.');
  if (jaula.fase !== 'limpia') {
    return invalido(`La jaula ${jaula.nombre} no está lista para repoblar: ${jaula.fase === 'activa' ? 'ya está poblada' : 'falta la limpieza'}.`);
  }
  const kg = num(data.kg_larvas);
  if (kg === null || kg <= 0) return invalido('Escribe los kg de larvas del 2 %.');
  const bandejasIn = (data.bandejas || []).filter(Boolean);
  if (!bandejasIn.length) return invalido('Agrega al menos una bandeja.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const ultimo = [...jaula.eventos, ...jaula.ingresos].map(x => x.fecha).sort().pop();
  if (ultimo && f.iso < ultimo) return invalido('El ingreso no puede ser anterior a la limpieza.');

  const vista = pool2({ separaciones: v.separaciones, cajas: v.cajas, incubadoras: v.incubadoras,
                        ingresos: v.ingresos }, v.cfg, { fecha: f.iso, kg_larvas: kg }).nuevo;
  let genLarvas = vista.generacion_larvas;
  if (genLarvas === null) {
    const g = leerCampo('generacion', data.generacion_larvas);
    if (g.error) return invalido('El 2 % no dice de qué generación son estas larvas: escríbela.');
    genLarvas = g.value;
  }

  const prov = await provenance(data.operator_name);
  const ingreso = { id: uuid(), jaula_id: jaula.id, fecha: f.iso, kg_larvas: kg, generacion: genLarvas + 1,
                    ...NUEVO, nota: str(data.nota), ...prov };
  const codigos = siguientesBandejas(genLarvas, f.iso, bandejasIn.length, v.bandejas.map(b => b.codigo));
  const bandejas = [];
  for (const [i, b] of bandejasIn.entries()) {
    const peso = num(b.peso_kg);
    if (peso === null || peso <= 0) return invalido(`Bandeja ${i + 1}: escribe su peso en kg.`);
    if (!v.por.rack.get(b.rack_id)) return invalido(`Bandeja ${i + 1}: elige su rack.`);
    bandejas.push({ id: uuid(), codigo: codigos[i].codigo, numero: codigos[i].numero, ingreso_id: ingreso.id,
                    jaula_id: jaula.id, rack_id: b.rack_id, peso_kg: peso, estado: 'inactivo',
                    cerrado_at: null, cerrado_por: null, motivo_cierre: null, ...NUEVO, ...prov });
  }
  const blobIds = await conFoto(db, ingreso, 'ingreso', data.blob_id);
  const wire = r => { const { updated_at, estado, ...rest } = r; return rest; };
  await guardar(db, {
    writes: [{ store: 'ingreso', row: ingreso }, ...bandejas.map(row => ({ store: 'bandeja_pupacion', row }))],
    outbox: outboxDe(ingreso, {
      op: 'rpc', rpc: 'ingresar', rowId: ingreso.id,
      payload: { p_ingreso: wire(ingreso), p_bandejas: bandejas.map(wire) },
      dependsOn: [jaula.id, ...new Set(bandejas.map(b => b.rack_id))], blobIds
    })
  });
  return ok(deepCopy({ ingreso, bandejas, larvas: vista }));
}

/**
 * Cierre (a cage with flies, ~14 days into its cycle) and limpieza (after the
 * cierre). Only then can it be repopulated.
 *
 *   { jaula_id, tipo: 'cierre' | 'limpieza', fecha? }
 */
export async function registrarEventoJaula(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const jaula = v.jaulas.find(j => j.id === data.jaula_id);
  if (!jaula) return invalido('Elige la jaula.');
  if (data.tipo === 'cierre' && jaula.fase !== 'activa') return invalido(`La jaula ${jaula.nombre} no tiene moscas: no hay nada que cerrar.`);
  if (data.tipo === 'limpieza' && jaula.fase !== 'cerrada') {
    return invalido(jaula.fase === 'activa' ? `La jaula ${jaula.nombre} se cierra antes de limpiarla.` : `La jaula ${jaula.nombre} ya está limpia.`);
  }
  if (!['cierre', 'limpieza'].includes(data.tipo)) return invalido('¿Cierre o limpieza?');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const ultimo = [...jaula.eventos, ...jaula.ingresos].map(x => x.fecha).sort().pop();
  if (ultimo && f.iso < ultimo) return invalido('No puede ser anterior al último registro de la jaula.');
  const row = { id: uuid(), jaula_id: jaula.id, tipo: data.tipo, fecha: f.iso, ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  const blobIds = await conFoto(db, row, 'jaula_evento', data.blob_id);
  await guardar(db, {
    writes: [{ store: 'jaula_evento', row }],
    outbox: outboxDe(row, { op: 'upsert', table: 'jaula_evento', rowId: row.id, payload: row,
                            dependsOn: [jaula.id], blobIds })
  });
  return ok(deepCopy(row));
}

/* ── racks and early closing ────────────────────────────────────────────── */

const MOVIBLES = { incubadora: 'incubadoras', caja: 'cajas', bandeja_pupacion: 'bandejas' };

/** An incubadora, caja or tray changes rack. { objeto, objeto_id, rack_hasta, fecha? } */
export async function registrarMovimiento(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  if (!MOVIBLES[data.objeto]) return invalido('Sólo incubadoras, cajas y bandejas cambian de rack.');
  const obj = v[MOVIBLES[data.objeto]].find(x => x.id === data.objeto_id);
  if (!obj) return invalido('No encontrado.');
  if (!v.por.rack.get(data.rack_hasta)) return invalido('Elige el rack nuevo.');
  if (obj.rack?.id === data.rack_hasta) return invalido(`Ya está en el rack ${obj.rack.codigo}.`);
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const row = { id: uuid(), objeto: data.objeto, objeto_id: obj.id, rack_desde: obj.rack?.id || null,
                rack_hasta: data.rack_hasta, fecha: f.iso, ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  await guardar(db, {
    writes: [{ store: 'movimiento', row }],
    outbox: outboxDe(row, { op: 'upsert', table: 'movimiento', rowId: row.id, payload: row,
                            dependsOn: [obj.id, data.rack_hasta] })
  });
  return ok(deepCopy(row));
}

const CERRABLES = { incubadora: 'incubadoras', caja: 'cajas', bandeja_pupacion: 'bandejas', cochada: 'cochadas' };

/** Close an object early (loss, contamination…), with the reason written.
 *  Nothing is deleted: it becomes inactive. { tabla, id, motivo } */
export async function cerrarObjeto(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  if (!CERRABLES[data.tabla]) return invalido('Eso no se cierra.');
  const obj = v[CERRABLES[data.tabla]].find(x => x.id === data.id);
  if (!obj) return invalido('No encontrado.');
  if (obj.cerrado_at) return invalido(`${obj.codigo} ya fue cerrada.`);
  if (data.tabla !== 'bandeja_pupacion' && obj.estado !== 'activo') return invalido(`${obj.codigo} ya no está activa.`);
  const motivo = str(data.motivo);
  if (!motivo) return invalido('Escribe el motivo del cierre.');
  const at = nowIso();
  const por = str(data.operator_name) || (await getCurrentOperator()) || null;
  const row = await rowById(db, data.tabla, obj.id);
  const next = { ...row, cerrado_at: at, cerrado_por: por, motivo_cierre: motivo, estado: 'inactivo', updated_at: at };
  await guardar(db, {
    writes: [{ store: data.tabla, row: next }],
    outbox: { op: 'cas', rpc: 'cerrar_objeto', rowId: obj.id,
              payload: { p_tabla: data.tabla, p_id: obj.id, p_motivo: motivo, p_at: at, p_por: por },
              createdBy: currentUserId(), dispositivoId: deviceId() }
  });
  return ok(deepCopy(next));
}

/* ── food ───────────────────────────────────────────────────────────────── */

/** Material that came in. { material, kg, fecha? } */
export async function registrarRecepcion(data = {}) {
  const db = await openDb();
  const materiales = (await allRows(db, 'catalogo')).filter(c => c.tipo === 'material_alimento').map(c => c.valor);
  const m = leerCampo('material', data.material, { materiales });
  if (m.error) return invalido(m.error);
  const kg = num(data.kg);
  if (kg === null || kg <= 0) return invalido('Escribe los kg recibidos.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  const row = { id: uuid(), fecha: f.iso, material: m.value, kg, ...NUEVO, nota: str(data.nota),
                ...(await provenance(data.operator_name)) };
  return registrarSimple('recepcion', row, data);
}

/**
 * An ensilado: the container, and how many kilos of which receptions went in.
 * {contenedor}-{ddmm}. It matures 21 days and opens on the 21st.
 *
 *   { contenedor_id, fecha?, insumos: [{ recepcion_id, kg }] }
 */
export async function crearEnsilado(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const cont = v.por.contenedor.get(data.contenedor_id);
  if (!cont) return invalido('Elige el contenedor.');
  const insumosIn = (data.insumos || []).filter(i => i && num(i.kg) > 0);
  if (!insumosIn.length) return invalido('Indica qué recepciones entran y cuántos kg de cada una.');
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  for (const i of insumosIn) {
    const r = v.stock.porRecepcion.get(i.recepcion_id);
    if (!r) return invalido('Una de las recepciones ya no existe en este teléfono.');
    if (kg3(i.kg) > r.kg_disponible) return invalido(`De la recepción de ${r.material} quedan ${r.kg_disponible} kg.`);
  }
  const codigo = ensiladoCodigo(cont.codigo, f.iso);
  if (v.ensilados.some(e => e.codigo === codigo && e.dia0 === farmDay(f.iso))) {
    return invalido(`Ya existe el ensilado ${codigo}: ese contenedor ya se llenó hoy.`);
  }
  const prov = await provenance(data.operator_name);
  const ens = { id: uuid(), codigo, contenedor_id: cont.id, ensilado_at: f.iso, dia0: farmDay(f.iso),
                abierto_at: null, abierto_por: null, ...NUEVO, nota: str(data.nota), ...prov };
  const insumos = insumosIn.map(i => ({ id: uuid(), ensilado_id: ens.id, recepcion_id: i.recepcion_id,
                                        kg: kg3(i.kg), ...NUEVO, ...prov }));
  const blobIds = await conFoto(db, ens, 'ensilado', data.blob_id);
  const wire = r => { const { updated_at, ...rest } = r; return rest; };
  await guardar(db, {
    writes: [{ store: 'ensilado', row: ens }, ...insumos.map(row => ({ store: 'ensilado_insumo', row }))],
    outbox: outboxDe(ens, {
      op: 'rpc', rpc: 'crear_ensilado', rowId: ens.id,
      payload: { p_ensilado: wire(ens), p_insumos: insumos.map(wire) },
      dependsOn: [cont.id, ...insumos.map(i => i.recepcion_id)], blobIds
    })
  });
  return ok(deepCopy({ ensilado: ens, insumos }));
}

/** Open an ensilado: on día 21 of its maturing, not before. From then it is
 *  consumed within 72 h. { ensilado_id, fecha? } */
export async function abrirEnsilado(data = {}) {
  const db = await openDb();
  const v = await vistaActual(db);
  const e = v.ensilados.find(x => x.id === data.ensilado_id);
  if (!e) return invalido('Ensilado no encontrado.');
  if (e.abierto_at) return invalido(`El ensilado ${e.codigo} ya está abierto.`);
  const f = fechaDe(data.fecha);
  if (f.error) return invalido(f.error);
  if (farmDay(f.iso) < e.apertura_prevista) {
    return invalido(`El ensilado ${e.codigo} sigue madurando: se abre el ${ddmm(e.apertura_prevista).replace(/(\d\d)(\d\d)/, '$1/$2')}.`);
  }
  const por = str(data.operator_name) || (await getCurrentOperator()) || null;
  const row = await rowById(db, 'ensilado', e.id);
  const next = { ...row, abierto_at: f.iso, abierto_por: por, updated_at: nowIso() };
  await guardar(db, {
    writes: [{ store: 'ensilado', row: next }],
    outbox: { op: 'cas', rpc: 'abrir_ensilado', rowId: e.id,
              payload: { p_id: e.id, p_at: f.iso, p_por: por },
              createdBy: currentUserId(), dispositivoId: deviceId() }
  });
  return ok(deepCopy(next));
}

/* ── corrections, notes, photos, reviews ────────────────────────────────── */

/** NOT NULL on the server; everything else may be emptied. */
const PUEDE_VACIARSE = new Set(['abierto_at', 'lugar', 'nota', 'foto_key']);

/**
 * Correct a record: values and dates, its note, its photo. The last edit
 * overwrites, keeping who edited and when. What was computed from it is
 * recomputed on the next read, and what was built on it is marked "revisar"
 * (revisar.js) — except for a note or a photo, which are not values.
 *
 *   { tabla, id, cambios: { campo: valor }, blob_id? }
 */
export async function editarRegistro(data = {}) {
  const db = await openDb();
  const { tabla, id } = data;
  if (!EDITABLE[tabla]) return invalido('Ese registro no se puede corregir.');
  const row = await rowById(db, tabla, id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Registro no encontrado.');

  const v = await vistaActual(db);
  const materiales = (await allRows(db, 'catalogo')).filter(c => c.tipo === 'material_alimento').map(c => c.valor);
  const ctx = { racks: v.racks, jaulas: v.jaulas, materiales };
  const campos = new Map(camposDe(tabla, row).map(([col, kind, label]) => [col, { kind, label }]));
  const cambios = {};
  for (const [col, raw] of Object.entries(data.cambios || {})) {
    if (col === 'nota') { cambios.nota = str(raw); continue; }
    const c = campos.get(col);
    if (!c) return invalido(`«${col}» no se puede corregir aquí.`);
    const r = leerCampo(c.kind, raw, ctx);
    if (r.error) return invalido(`${c.label}: ${r.error}`);
    if (r.value === null && !PUEDE_VACIARSE.has(col)) return invalido(`${c.label}: no puede quedar vacío.`);
    if (JSON.stringify(r.value) !== JSON.stringify(row[col] ?? null)) cambios[col] = r.value;
  }
  const blobIds = [];
  if (data.blob_id) {
    cambios.foto_key = await attachPhoto(db, data.blob_id, tabla, id);
    blobIds.push(data.blob_id);
  }
  if (!Object.keys(cambios).length) return invalido('No hay cambios que guardar.');

  if (tabla === 'jaula' && cambios.letra) {
    const otra = v.jaulas.find(j => j.id !== id && mismoTexto(j.letra, cambios.letra));
    if (otra) return invalido(`La letra ${cambios.letra} ya es de la jaula ${otra.nombre}.`);
  }

  const at = nowIso();
  const por = (await getCurrentOperator()) || null;
  const esValor = Object.keys(cambios).some(k => !SIEMPRE.includes(k));
  const next = { ...row, ...cambios, editado_at: at, editado_por: por, updated_at: at,
                 ...(esValor ? { valores_editados_at: at } : {}) };
  // What the server's triggers keep, kept here too until the next pull.
  if (cambios.recolecta_at) next.dia0 = farmDay(cambios.recolecta_at);
  if (cambios.ensilado_at) next.dia0 = farmDay(cambios.ensilado_at);

  await guardar(db, {
    writes: [{ store: tabla, row: next }],
    outbox: { op: 'rpc', rpc: 'editar', rowId: id,
              payload: { p_tabla: tabla, p_id: id, p_cambios: cambios, p_por: por, p_at: at },
              blobIds, createdBy: currentUserId(), dispositivoId: deviceId() }
  });
  return ok(deepCopy(next));
}

/** A record marked "revisar" was checked. Not an edit, so nothing built on it
 *  is marked in turn. { tabla, id } */
export async function marcarRevisado(data = {}) {
  const db = await openDb();
  const { tabla, id } = data;
  if (!EDITABLE[tabla] || ['rack', 'contenedor'].includes(tabla)) return invalido('Ese registro no se revisa.');
  const row = await rowById(db, tabla, id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Registro no encontrado.');
  const at = nowIso();
  const por = (await getCurrentOperator()) || null;
  const next = { ...row, revisado_at: at, updated_at: at };
  await guardar(db, {
    writes: [{ store: tabla, row: next }],
    outbox: { op: 'rpc', rpc: 'marcar_revisado', rowId: id,
              payload: { p_tabla: tabla, p_id: id, p_at: at, p_por: por },
              createdBy: currentUserId(), dispositivoId: deviceId() }
  });
  return ok(deepCopy(next));
}
