/**
 * Upgrading a phone that already has the app's local database.
 *
 * What went wrong: renaming cochada -> lote changed INDEXEDDB STORE NAMES
 * without bumping the version. A phone that had already opened the app kept
 * the old stores, the new code opened a transaction on `lote`, IndexedDB threw
 * NotFoundError, start-up aborted, and the screen said "no hay servidor
 * configurado". The first fix (a9a9d80) bumped the version but DROPPED the old
 * stores — throwing away any lote recorded offline and not yet synced.
 *
 * Two different v1 databases exist on phones today (see schema.js), so both
 * are built here from the code exactly as it shipped (test/fixtures/idb), and
 * both must end on the same schema with nothing lost. Then the upgraded queue
 * is pushed into a real Postgres copy of the live database, to prove the
 * renamed work actually lands.
 *
 * Any future change to store names or indexes needs a new MIGRATIONS entry and
 * a case here.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { DB_NAME, DB_VERSION, MIGRATIONS, STORE_DEFS } from '../src/data/idb/schema.js';
import { openDb, __closeDb } from '../src/data/idb/open.js';
import * as SHIPPED_BEFORE_RENAME from './fixtures/idb/schema-v1-antes-del-renombrado.mjs';
import * as SHIPPED_AFTER_RENAME from './fixtures/idb/schema-v1-despues-del-renombrado.mjs';
import * as SHIPPED_RELEASE_1 from './fixtures/idb/schema-v3.mjs';
import * as SHIPPED_LIVE from './fixtures/idb/schema-v2.mjs';
import { liveReplica, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

/* ── local-database helpers ───────────────────────────────────────────────── */

const del = name => new Promise(r => {
  const q = indexedDB.deleteDatabase(name);
  q.onsuccess = q.onerror = q.onblocked = r;
});

async function reset() {
  __closeDb();
  await del(DB_NAME);
}

/** A database built by code that actually shipped (at that build's version,
 *  running that build's own steps), then filled. */
function buildShipped(fixture, rows = {}) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, fixture.DB_VERSION);
    req.onupgradeneeded = ev => {
      const db = req.result, tx = req.transaction;
      (async () => {
        for (let v = ev.oldVersion || 0; v < fixture.DB_VERSION; v++) await fixture.MIGRATIONS[v](db, tx);
      })().catch(err => { try { tx.abort(); } catch { /* done */ } reject(err); });
    };
    req.onsuccess = () => {
      const db = req.result;
      const stores = Object.keys(rows);
      if (!stores.length) { db.close(); return resolve(); }
      const tx = db.transaction(stores, 'readwrite');
      for (const [store, list] of Object.entries(rows)) {
        for (const row of list) tx.objectStore(store).put(row);
      }
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

/** A database with deliberately missing stores, to force the upgrade to fail. */
function buildBrokenV1(rows) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('cochada', { keyPath: 'id' });
      db.createObjectStore('cochada_separacion', { keyPath: ['cochada_id', 'separacion_id'] });
      // no bandeja_cache, no outbox: v2 cannot finish on this.
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('cochada', 'readwrite');
      for (const r of rows) tx.objectStore('cochada').put(r);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

const getAll = (db, store) => new Promise((resolve, reject) => {
  const q = db.transaction(store, 'readonly').objectStore(store).getAll();
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => reject(q.error);
});

const getOne = (db, store, key) => new Promise((resolve, reject) => {
  const q = db.transaction(store, 'readonly').objectStore(store).get(key);
  q.onsuccess = () => resolve(q.result);
  q.onerror = () => reject(q.error);
});

/** Store names, key paths and indexes — everything that defines the schema. */
function schemaOf(db) {
  const names = [...db.objectStoreNames].sort();
  const tx = db.transaction(names, 'readonly');
  const out = {};
  for (const n of names) {
    const s = tx.objectStore(n);
    out[n] = {
      keyPath: s.keyPath,
      indexes: [...s.indexNames].sort().map(i => {
        const ix = s.index(i);
        return [i, ix.keyPath, ix.unique];
      })
    };
  }
  return out;
}

const expectedSchema = (defs = STORE_DEFS) => Object.fromEntries(
  Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)).map(([n, d]) => [n, {
    keyPath: d.keyPath,
    indexes: [...d.indexes].sort(([a], [b]) => a.localeCompare(b)).map(([i, kp]) => [i, kp, false])
  }]));

/* ── one farm, as a phone on the pre-rename build holds it ────────────────── */

const ID = {
  ins: randomUUID(), rec: randomUUID(),
  b1: randomUUID(), b2: randomUUID(),
  s1: randomUUID(), s2: randomUUID(),
  synced: randomUUID(),       // lote already on the server
  local: randomUUID(),        // lote recorded offline, only on this phone
  device: randomUUID()        // deviceId() is a UUID; the server column is uuid
};
const T0 = '2026-09-20T14:00:00.000Z';

const prov = synced => ({
  registrado_por: 'Maria', created_by: null, dispositivo_id: ID.device,
  created_at: T0, updated_at: T0, synced_at: synced ? T0 : null, deleted_at: null
});

const loteRow = (id, codigo, synced) => ({
  id, codigo, fecha: T0, peso_inicial_kg: 0.41,
  tiempo_secado_horas: null, peso_final_kg: null, qc_color_dorado: null,
  qc_prueba_crujiente: '', qc_aprobado: null, qc_foto_key: null,
  bandejas_metalicas_usadas: 1, empacado_at: null, fecha_vencimiento: null,
  despachado_at: null, rechazado_at: null, rechazo_motivo: null, notas: null,
  estado: 'secando',
  ...prov(synced)
});

const queued = (seq, fields) => ({
  id: randomUUID(), seq, table: null, rpc: null, depends_on: [], blob_ids: [],
  created_at: T0, created_by: null, dispositivo_id: ID.device,
  attempts: 0, next_attempt_at: 0, status: 'pending', last_error: null,
  ...fields
});

const LOCAL_LOTE = loteRow(ID.local, 'CO-2009-L', false);

const Q = {
  crear: queued(1, {
    op: 'rpc', rpc: 'crear_cochada', row_id: ID.local,
    payload: { p_cochada: LOCAL_LOTE, p_separacion_ids: [ID.s2] }, depends_on: [ID.s2]
  }),
  qc: queued(2, {
    op: 'cas', rpc: 'actualizar_qc_cochada', row_id: ID.local,
    payload: { p_id: ID.local, p_tiempo: 14, p_peso_final: 0.11, p_color: 'Muy Crujiente',
               p_prueba: 'quiebre limpio', p_aprobado: true, p_foto_key: null, p_por: 'Maria' }
  }),
  rechazo: queued(3, {
    op: 'cas', rpc: 'rechazar_cochada', row_id: ID.synced,
    payload: { p_id: ID.synced, p_motivo: 'humedad', p_por: 'Ricardo' }
  }),
  otro: queued(4, {
    op: 'upsert', table: 'catalogo', row_id: randomUUID(),
    payload: { tipo: 'operario', valor: 'Jose' }
  })
};
Q.otro.payload.id = Q.otro.row_id;

const PRE_RENAME_PHONE = {
  insectario: [{ id: ID.ins, codigo: 'ICA-0109', nombre_insectario: 'ICA', fecha_inicio: '2026-09-01', ...prov(true) }],
  recoleccion: [{ id: ID.rec, insectario_id: ID.ins, recolecta: '1', fecha: T0, ...prov(true) }],
  bandeja: [
    { id: ID.b1, recoleccion_id: ID.rec, no_bandeja: 1, id_bandeja: '2009.1.1', fecha: T0, estado: 'cosechada', ...prov(true) },
    { id: ID.b2, recoleccion_id: ID.rec, no_bandeja: 2, id_bandeja: '2009.1.2', fecha: T0, estado: 'cosechada', ...prov(true) }
  ],
  separacion: [
    { id: ID.s1, bandeja_id: ID.b1, fecha: T0, larva_limpia_g: 410, ...prov(true) },
    { id: ID.s2, bandeja_id: ID.b2, fecha: T0, larva_limpia_g: 395, ...prov(true) }
  ],
  cochada: [loteRow(ID.synced, 'CO-2009-S', true), LOCAL_LOTE],
  cochada_separacion: [
    { cochada_id: ID.synced, separacion_id: ID.s1, created_at: T0, updated_at: T0, synced_at: T0 },
    { cochada_id: ID.local, separacion_id: ID.s2, created_at: T0, updated_at: T0 }
  ],
  bandeja_cache: [
    { bandeja_id: ID.b1, cochada_id: ID.synced, last_evento_tipo: 'separacion', last_evento_fecha: T0 },
    { bandeja_id: ID.b2, cochada_id: ID.local, last_evento_tipo: 'separacion', last_evento_fecha: T0 }
  ],
  outbox: Object.values(Q),
  conflicts: [
    { id: 'conf-rpc', rpc: 'crear_cochada', table: null, row_id: ID.local, _resuelto: 0, created_at: T0,
      payload: { p_cochada: { id: ID.local }, p_separacion_ids: [ID.s2] } },
    { id: 'conf-tabla', rpc: null, table: 'cochada', row_id: ID.local, _resuelto: 0, created_at: T0,
      payload: { id: ID.local } }
  ],
  blobs: [
    { id: 'foto-1', key: `cochada/${ID.local}/foto-1.jpg`, table: 'cochada', row_id: ID.local, status: 'done', bytes: 10 }
  ],
  meta: [
    { key: 'pull_cursor:cochada', value: T0 },
    { key: 'pull_cursor:cochada_separacion', value: T0 },
    { key: 'pull_cursor:bandeja', value: T0 },
    { key: 'operador_actual', value: 'Maria' }
  ]
};

/* ── the version itself ───────────────────────────────────────────────────── */

test('the version is derived from the migrations, and the rename is v2', () => {
  assert.equal(DB_VERSION, MIGRATIONS.length, 'DB_VERSION se deriva de MIGRATIONS.length; no lo fijes a mano');
  assert.ok(DB_VERSION >= 2, 'el renombrado cochada -> lote necesita una migración v2');
});

test('a new phone ends on exactly the schema STORE_DEFS describes', async () => {
  await reset();
  const db = await openDb();
  assert.deepEqual(schemaOf(db), expectedSchema(),
    'si cambias STORE_DEFS, agrega un paso a MIGRATIONS que produzca ese cambio');
  await reset();
});

/* ── a phone from before the rename (the case that lost data) ─────────────── */

test('pre-rename phone: upgrades instead of crashing, onto the same schema as a new phone', async () => {
  await reset();
  await buildShipped(SHIPPED_BEFORE_RENAME, PRE_RENAME_PHONE);

  const db = await openDb();          // threw NotFoundError before the fix
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(schemaOf(db), expectedSchema());
  assert.ok(!db.objectStoreNames.contains('cochada'));
  assert.ok(!db.objectStoreNames.contains('cochada_separacion'));
});

test('pre-rename phone: BOTH lotes survive — the synced one and the one only this phone has', async () => {
  const db = await openDb();
  const lotes = await getAll(db, 'lote');
  assert.deepEqual(lotes.map(l => l.codigo).sort(), ['CO-2009-L', 'CO-2009-S']);

  const local = lotes.find(l => l.id === ID.local);
  assert.equal(local.synced_at, null, 'sigue marcado como no sincronizado');
  assert.equal(local.registrado_por, 'Maria');

  const links = await getAll(db, 'lote_separacion');
  assert.equal(links.length, 2);
  for (const l of links) {
    assert.ok(l.lote_id, 'la columna puente se renombra a lote_id');
    assert.equal(l.cochada_id, undefined);
  }
  assert.deepEqual(
    links.map(l => `${l.lote_id}:${l.separacion_id}`).sort(),
    [`${ID.synced}:${ID.s1}`, `${ID.local}:${ID.s2}`].sort());
});

test('pre-rename phone: the lotes are on screen (read through the app, not the raw store)', async () => {
  const { listLotes, getLoteDetail, listBandejas } = await import('../src/data/read.js');

  const list = await listLotes();
  assert.ok(list.ok, JSON.stringify(list.error));
  assert.deepEqual(list.data.map(l => l.codigo).sort(), ['CO-2009-L', 'CO-2009-S']);
  for (const l of list.data) assert.equal(l.n_bandejas, 1, `${l.codigo} conserva su bandeja`);

  const detail = await getLoteDetail(ID.local);
  assert.ok(detail.ok, JSON.stringify(detail.error));
  assert.equal(detail.data.separaciones.length, 1);
  assert.equal(detail.data.separaciones[0].separacion_id, ID.s2);
  assert.equal(detail.data.separaciones[0].bandeja_label, '2009.1.2');

  const trays = await listBandejas({});
  assert.ok(trays.ok, JSON.stringify(trays.error));
  const t2 = trays.data.find(b => b.id === ID.b2);
  assert.equal(t2.lote_id, ID.local, 'la bandeja sabe a qué lote fue');
});

test('pre-rename phone: queued work, conflicts, photos and cursors are retargeted — nothing else', async () => {
  const db = await openDb();

  const q = await getAll(db, 'outbox');
  assert.equal(q.length, 4, 'no se puede perder trabajo encolado');
  const byId = new Map(q.map(i => [i.id, i]));

  const crear = byId.get(Q.crear.id);
  assert.equal(crear.rpc, 'crear_lote');
  assert.equal(crear.payload.p_lote.id, ID.local);
  assert.equal(crear.payload.p_cochada, undefined);
  assert.deepEqual(crear.payload.p_separacion_ids, [ID.s2]);
  assert.equal(crear.seq, 1, 'el orden de la cola no cambia');
  assert.equal(crear.status, 'pending');

  assert.equal(byId.get(Q.qc.id).rpc, 'actualizar_qc_lote');
  assert.equal(byId.get(Q.qc.id).payload.p_por, 'Maria');
  assert.equal(byId.get(Q.rechazo.id).rpc, 'rechazar_lote');
  assert.deepEqual(byId.get(Q.otro.id), Q.otro, 'lo que no nombraba cochada queda idéntico');

  const conf = new Map((await getAll(db, 'conflicts')).map(c => [c.id, c]));
  assert.equal(conf.get('conf-rpc').rpc, 'crear_lote');
  assert.ok(conf.get('conf-rpc').payload.p_lote);
  assert.equal(conf.get('conf-tabla').table, 'lote', '"Descartar" abre una transacción sobre row.table');

  const foto = await getOne(db, 'blobs', 'foto-1');
  assert.equal(foto.table, 'lote');
  assert.equal(foto.key, `cochada/${ID.local}/foto-1.jpg`, 'la ruta en Storage NO cambia: el lote apunta a ella');

  const cache = await getOne(db, 'bandeja_cache', ID.b1);
  assert.equal(cache.lote_id, ID.synced);
  assert.equal(cache.cochada_id, undefined);

  assert.equal(await getOne(db, 'meta', 'pull_cursor:cochada'), undefined);
  assert.equal(await getOne(db, 'meta', 'pull_cursor:cochada_separacion'), undefined);
  assert.equal(await getOne(db, 'meta', 'pull_cursor:lote'), undefined, 'lote se descarga completo');
  assert.equal((await getOne(db, 'meta', 'pull_cursor:bandeja')).value, T0, 'los demás cursores se conservan');
  assert.equal((await getOne(db, 'meta', 'operador_actual')).value, 'Maria');
});

/* ── pushing that queue to the server ─────────────────────────────────────── */

/** The live database as it is today, plus the farm rows the phone already synced. */
async function serverWithSyncedLote() {
  const pg = await liveReplica();
  await pg.query(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio) values ($1, 'ICA-0109', 'ICA', '2026-09-01')`, [ID.ins]);
  await pg.query(`insert into app.recoleccion (id, insectario_id, recolecta, fecha) values ($1, $2, '1', $3)`, [ID.rec, ID.ins, T0]);
  for (const [b, n, s, g] of [[ID.b1, 1, ID.s1, 410], [ID.b2, 2, ID.s2, 395]]) {
    await pg.query(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha) values ($1, $2, $3, $4, $5)`,
      [b, ID.rec, n, `2009.1.${n}`, T0]);
    await pg.query(`insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g) values ($1, $2, $3, $4)`, [s, b, T0, g]);
  }
  // Created by the production build, under the production function name.
  await pg.query(`select app.crear_cochada($1::jsonb, $2::uuid[])`,
    [JSON.stringify({ id: ID.synced, codigo: 'CO-2009-S', fecha: T0, peso_inicial_kg: 0.41 }), [ID.s1]]);
  return pg;
}

test('ORDER MATTERS: pushed before 0005 is run, the renamed calls are rejected', async () => {
  const pg = await serverWithSyncedLote();          // SQL not yet applied
  const client = pgClient(pg);
  const res = await client.rpc('crear_lote', Q.crear.payload);
  assert.equal(res.error?.code, 'PGRST202',
    'por eso el SQL va ANTES del push: sin él, cada lote nuevo termina en conflictos');
});

test('after 0005 + 0006, the upgraded queue lands on the server, in order, with attribution', async () => {
  const pg = await serverWithSyncedLote();
  await pg.exec(await readSql('supabase/migrations/0005_renombrar_lote.sql'));
  await pg.exec(await readSql('supabase/migrations/0006_sobrecargas.sql'));

  const client = pgClient(pg);
  useBackend(client);
  const { pushAll } = await import('../src/data/sync/push.js');

  const db = await openDb();
  const r = await pushAll(db);
  assert.deepEqual({ pushed: r.pushed, conflicts: r.conflicts, blocked: r.blocked },
                   { pushed: 4, conflicts: 0, blocked: 0 },
                   `llamadas: ${JSON.stringify(client.calls.map(c => c.name || c.table))}`);

  // FIFO: the lote is created before its QC is recorded.
  const rpcs = client.calls.filter(c => c.kind === 'rpc').map(c => c.name);
  assert.ok(rpcs.indexOf('crear_lote') < rpcs.indexOf('actualizar_qc_lote'));

  const local = (await pg.query(
    `select codigo, qc_por, qc_prueba_crujiente, qc_aprobado from app.lote where id = $1`, [ID.local])).rows[0];
  assert.equal(local?.codigo, 'CO-2009-L', 'el lote que sólo existía en el teléfono llegó al servidor');
  assert.equal(local.qc_por, 'Maria');
  assert.equal(local.qc_prueba_crujiente, 'quiebre limpio');
  assert.equal(local.qc_aprobado, true);

  const link = (await pg.query(`select lote_id from app.lote_separacion where separacion_id = $1`, [ID.s2])).rows[0];
  assert.equal(link?.lote_id, ID.local);

  const synced = (await pg.query(
    `select estado, rechazado_por, rechazo_motivo from app.lote where id = $1`, [ID.synced])).rows[0];
  assert.equal(synced.estado, 'rechazado');
  assert.equal(synced.rechazado_por, 'Ricardo');

  const left = (await getAll(db, 'outbox')).filter(i => i.status !== 'done');
  assert.deepEqual(left, [], 'la cola queda vacía');
  await reset();
});

/* ── a phone from after the rename ────────────────────────────────────────── */

test('post-rename phone: keeps its lotes and its lote cursor, same final schema', async () => {
  await reset();
  await buildShipped(SHIPPED_AFTER_RENAME, {
    lote: [loteRow(ID.synced, 'CO-2009-S', true)],
    lote_separacion: [{ lote_id: ID.synced, separacion_id: ID.s1, created_at: T0, updated_at: T0, synced_at: T0 }],
    outbox: [queued(1, { op: 'rpc', rpc: 'crear_lote', row_id: ID.local,
                         payload: { p_lote: LOCAL_LOTE, p_separacion_ids: [ID.s2] } })],
    meta: [{ key: 'pull_cursor:lote', value: T0 }]
  });

  const db = await openDb();
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(schemaOf(db), expectedSchema());
  assert.equal((await getAll(db, 'lote')).length, 1);
  assert.equal((await getAll(db, 'lote_separacion')).length, 1);
  const [item] = await getAll(db, 'outbox');
  assert.equal(item.rpc, 'crear_lote');
  assert.ok(item.payload.p_lote);
  assert.equal((await getOne(db, 'meta', 'pull_cursor:lote')).value, T0,
    'el almacén ya existía y estaba al día: no hace falta descargarlo otra vez');
  await reset();
});

/* ── a phone on the live build (v2, 3eb549a): lotes, no protocolo v2 yet ──── */

const L = {
  ins: randomUUID(), rec: randomUUID(), b1: randomUUID(), s1: randomUUID(), lote: randomUUID(), dev: randomUUID()
};
const T2 = '2026-09-28T19:00:00.000Z';
const provL = synced => ({ registrado_por: 'Ricardo', created_by: null, dispositivo_id: L.dev,
                           created_at: T2, updated_at: T2, synced_at: synced ? T2 : null, deleted_at: null });
const LIVE_LOTE = { ...loteRow(L.lote, 'CO-2809-L', false), ...provL(false) };
const LIVE_PHONE = {
  insectario: [{ id: L.ins, codigo: 'ICC-0109', nombre_insectario: 'ICC', fecha_inicio: '2026-09-01', ...provL(true) }],
  recoleccion: [{ id: L.rec, insectario_id: L.ins, recolecta: '4', fecha: T2, huevos_g: 0.6, ...provL(true) }],
  bandeja: [{ id: L.b1, recoleccion_id: L.rec, no_bandeja: 1, id_bandeja: '2809.4.1', fecha: T2, estado: 'cosechada', ...provL(true) }],
  separacion: [{ id: L.s1, bandeja_id: L.b1, fecha: T2, larva_limpia_g: 420, ...provL(true) }],
  lote: [LIVE_LOTE],
  lote_separacion: [{ lote_id: L.lote, separacion_id: L.s1, created_at: T2, updated_at: T2 }],
  bandeja_cache: [{ bandeja_id: L.b1, estado: 'cosechada', last_evento_tipo: 'separacion', last_evento_fecha: T2,
                    separacion_id: L.s1, larva_limpia_g: 420, lote_id: L.lote, updated_at: T2 }],
  // Queued by the live build: no row_ids and no undo log (they came later).
  outbox: [queued(1, { op: 'rpc', rpc: 'crear_lote', row_id: L.lote, dispositivo_id: L.dev,
                       payload: { p_lote: LIVE_LOTE, p_separacion_ids: [L.s1] }, depends_on: [L.s1] })],
  meta: [{ key: 'pull_cursor:lote', value: T2 }, { key: 'outbox_seq', value: 1 }, { key: 'operador_actual', value: 'Ricardo' }]
};

test('live-build phone (v2): upgrades through v3 and v4; its lote and queued work stay as they were', async () => {
  await reset();
  await buildShipped(SHIPPED_LIVE, LIVE_PHONE);

  const db = await openDb();
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(schemaOf(db), expectedSchema());
  for (const [store, rows] of Object.entries(LIVE_PHONE)) {
    if (store === 'meta') continue;
    assert.deepEqual(asSet(await getAll(db, store)), asSet(rows), `${store} queda idéntico`);
  }
  for (const m of LIVE_PHONE.meta) assert.deepEqual(await getOne(db, 'meta', m.key), m);
  for (const s of ['parametro', 'incubadora', 'recepcion_alimento', 'ensilaje', 'ensilaje_insumo', 'ensilaje_lectura']) {
    assert.deepEqual(await getAll(db, s), [], `${s} empieza vacío`);
    assert.equal(await getOne(db, 'meta', `pull_cursor:${s}`), undefined, `${s} se descarga completo`);
  }
  const { listLotes } = await import('../src/data/read.js');
  assert.deepEqual((await listLotes()).data.map(l => l.codigo), ['CO-2809-L']);
});

test('live-build phone → Release 1 exactly as it ships (frozen v3 code): nothing moves', async () => {
  await reset();
  await buildShipped(SHIPPED_LIVE, LIVE_PHONE);
  await buildShipped(SHIPPED_RELEASE_1);      // Release 1 opening it: runs only its v3 step
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    assert.equal(db.version, 3);
    assert.deepEqual(schemaOf(db), expectedSchema(SHIPPED_RELEASE_1.STORE_DEFS));
    for (const [store, rows] of Object.entries(LIVE_PHONE)) {
      if (store === 'meta') continue;
      assert.deepEqual(asSet(await getAll(db, store)), asSet(rows), `${store} queda idéntico`);
    }
  } finally {
    db.close();
  }
  await reset();
});

test('live-build phone: its queued lote lands on the server after 0007 and 0008', async () => {
  await reset();
  await buildShipped(SHIPPED_LIVE, LIVE_PHONE);
  const pg = await liveReplica();
  await pg.exec(await readSql('supabase/migrations/0005_renombrar_lote.sql'));
  await pg.exec(await readSql('supabase/migrations/0006_sobrecargas.sql'));
  await pg.query(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio) values ($1, 'ICC-0109', 'ICC', '2026-09-01')`, [L.ins]);
  await pg.query(`insert into app.recoleccion (id, insectario_id, recolecta, fecha) values ($1, $2, '4', $3)`, [L.rec, L.ins, T2]);
  await pg.query(`insert into app.bandeja (id, recoleccion_id, no_bandeja, id_bandeja, fecha) values ($1, $2, 1, '2809.4.1', $3)`, [L.b1, L.rec, T2]);
  await pg.query(`insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g) values ($1, $2, $3, 420)`, [L.s1, L.b1, T2]);
  await pg.exec(await readSql('supabase/migrations/0007_protocolo_v2.sql'));
  await pg.exec(await readSql('supabase/migrations/0008_alimento.sql'));

  useBackend(pgClient(pg));
  const { pushAll } = await import('../src/data/sync/push.js');
  const r = await pushAll(await openDb());
  assert.deepEqual({ pushed: r.pushed, conflicts: r.conflicts, blocked: r.blocked }, { pushed: 1, conflicts: 0, blocked: 0 });
  const lote = (await pg.query(`select codigo, registrado_por from app.lote where id = $1`, [L.lote])).rows[0];
  assert.deepEqual([lote?.codigo, lote?.registrado_por], ['CO-2809-L', 'Ricardo']);
  const link = (await pg.query(`select lote_id from app.lote_separacion where separacion_id = $1`, [L.s1])).rows[0];
  assert.equal(link?.lote_id, L.lote);
  await reset();
});

/* ── a phone on Release 1 (v3): protocolo v2, no food stores yet ──────────── */

const R1 = {
  ins: randomUUID(), rec: randomUUID(), inc: randomUUID(), par: randomUUID(),
  b1: randomUUID(), b2: randomUUID(),
  a1: randomUUID(), a2: randomUUID(), g1: randomUUID(),      // carga 1, synced
  c1: randomUUID(), c2: randomUUID(), g2: randomUUID()       // carga 2, only on the phone
};
const DIA7 = '2026-09-26T13:00:00.000Z';
const DIA10 = '2026-09-29T13:00:00.000Z';

const r1Tray = (id, n) => ({
  id, recoleccion_id: R1.rec, incubadora_id: R1.inc, no_bandeja: n, id_bandeja: `F7BR3-0${n}`,
  fecha: DIA7, individuos: 25000, gramos_huevos: null, iniciador_g: null, tipo_iniciador: null,
  notas: '', estado: 'en_crecimiento', cerrada_admin_at: null, cerrada_admin_motivo: null,
  protocolo: 'v2', ...prov(true)
});
// A load exactly as the Release-1 build writes it: no ensilaje_id.
const r1Carga = (id, bandeja_id, n, fecha, grupal_id, synced) => ({
  id, bandeja_id, fecha, tipo_alimento: 'Ensilaje', cantidad_kg: n === 1 ? 1.5 : 2, origen: 'grupal',
  grupal_id, carga: n, tamizado: n === 2, notas: '', foto_key: null, protocolo: 'v2', ...prov(synced)
});
const R1_CARGA2 = [r1Carga(R1.c1, R1.b1, 2, DIA10, R1.g2, false), r1Carga(R1.c2, R1.b2, 2, DIA10, R1.g2, false)];

const RELEASE_1_PHONE = {
  parametro: [{ id: R1.par, clave: 'dia_cosecha', valor: 16, descripcion: 'Día de la cosecha',
                created_at: T0, updated_at: T0 }],
  insectario: [{ id: R1.ins, codigo: 'ICB-0109', nombre_insectario: 'ICB', fecha_inicio: '2026-09-01',
                 generacion_moscas: 'F7', ...prov(true) }],
  recoleccion: [{ id: R1.rec, insectario_id: R1.ins, recolecta: '3', fecha: '2026-09-19T13:00:00.000Z',
                  peso_ovipositores_g: 300, atrayente_cambiado: true, protocolo: 'v2', ...prov(true) }],
  incubadora: [{ id: R1.inc, recoleccion_id: R1.rec, codigo: 'F7BR3', fecha_inicio: '2026-09-19',
                 starter_kg: 1.2, individuos_total: 50000, notas: '', distribuida_at: DIA7,
                 distribuida_por: 'Maria', estado: 'distribuida', ...prov(true) }],
  bandeja: [r1Tray(R1.b1, 1), r1Tray(R1.b2, 2)],
  alimentacion: [r1Carga(R1.a1, R1.b1, 1, DIA7, R1.g1, true), r1Carga(R1.a2, R1.b2, 1, DIA7, R1.g1, true),
                 ...R1_CARGA2],
  bandeja_cache: [R1.b1, R1.b2].map(bandeja_id => ({
    bandeja_id, estado: 'en_crecimiento', last_evento_tipo: 'alimentacion', last_evento_fecha: DIA10,
    n_alimentaciones: 2, kg_alimento_total: 3.5, n_revisiones: 0, cargas_dadas: [1, 2],
    tiene_ayuno: 0, tiene_ayuno_abierto: 0, ayuno_abierto_id: null, separacion_id: null,
    larva_limpia_g: null, lote_id: null, updated_at: DIA10
  })),
  outbox: [queued(1, {
    op: 'rpc', rpc: 'log_alimentacion_grupal', row_id: R1.g2, row_ids: [R1.g2, R1.c1, R1.c2],
    depends_on: [R1.b1, R1.b2],
    undo: { created: R1_CARGA2.map(c => ({ store: 'alimentacion', key: c.id })), changed: [] },
    payload: { p_rows: R1_CARGA2 }
  })],
  meta: [
    { key: 'pull_cursor:alimentacion', value: T0 },
    { key: 'pull_cursor:incubadora', value: T0 },
    { key: 'pull_cursor:parametro', value: T0 },
    { key: 'outbox_seq', value: 1 },
    { key: 'operador_actual', value: 'Maria' }
  ]
};

const asSet = rows => rows.map(r => JSON.stringify(r)).sort();

test('Release-1 phone (v3): the food stores arrive, and nothing it had moves', async () => {
  await reset();
  await buildShipped(SHIPPED_RELEASE_1, RELEASE_1_PHONE);

  const db = await openDb();
  assert.equal(db.version, DB_VERSION);
  assert.deepEqual(schemaOf(db), expectedSchema());

  for (const [store, rows] of Object.entries(RELEASE_1_PHONE)) {
    if (store === 'meta') continue;
    assert.deepEqual(asSet(await getAll(db, store)), asSet(rows), `${store} queda idéntico`);
  }
  for (const m of RELEASE_1_PHONE.meta) assert.deepEqual(await getOne(db, 'meta', m.key), m);

  for (const s of ['recepcion_alimento', 'ensilaje', 'ensilaje_insumo', 'ensilaje_lectura']) {
    assert.deepEqual(await getAll(db, s), [], `${s} empieza vacío`);
    assert.equal(await getOne(db, 'meta', `pull_cursor:${s}`), undefined, `${s} se descarga completo`);
  }

  // Read through the app, not the raw stores.
  const { listBandejas, getStockAlimento, getIncubadoraDetail } = await import('../src/data/read.js');
  const trays = (await listBandejas({})).data.filter(b => [R1.b1, R1.b2].includes(b.id));
  assert.equal(trays.length, 2);
  for (const t of trays) {
    assert.equal(t.protocolo, 'v2');
    assert.equal(t.incubadora_codigo, 'F7BR3');
    assert.deepEqual(t.cargas_dadas, [1, 2]);
    assert.ok(t.siguiente_paso, 'la bandeja sabe qué le toca');
  }
  assert.equal((await getIncubadoraDetail(R1.inc)).data.bandejas.length, 2);
  const st = await getStockAlimento();
  assert.ok(st.ok, JSON.stringify(st.error));
  assert.deepEqual(st.data.materiales, []);
  assert.equal(st.data.ensilaje_en_uso, null);
});

test('Release-1 phone: its queued load lands on a server with 0008 — same RPC, same payload', async () => {
  const pg = await liveReplica();
  for (const f of ['0005_renombrar_lote.sql', '0006_sobrecargas.sql', '0007_protocolo_v2.sql', '0008_alimento.sql']) {
    await pg.exec(await readSql(`supabase/migrations/${f}`));
  }
  await pg.query(`insert into app.insectario (id, codigo, nombre_insectario, fecha_inicio, generacion_moscas)
                  values ($1, 'ICB-0109', 'ICB', '2026-09-01', 'F7')`, [R1.ins]);
  await pg.query(`insert into app.recoleccion (id, insectario_id, recolecta, fecha, protocolo,
                                               peso_ovipositores_g, atrayente_cambiado)
                  values ($1, $2, '3', '2026-09-19T13:00:00Z', 'v2', 300, true)`, [R1.rec, R1.ins]);
  await pg.query(`insert into app.incubadora (id, recoleccion_id, codigo, fecha_inicio, distribuida_at, distribuida_por)
                  values ($1, $2, 'F7BR3', '2026-09-19', $3, 'Maria')`, [R1.inc, R1.rec, DIA7]);
  for (const [b, n, a] of [[R1.b1, 1, R1.a1], [R1.b2, 2, R1.a2]]) {
    await pg.query(`insert into app.bandeja (id, recoleccion_id, incubadora_id, no_bandeja, id_bandeja, fecha,
                                             individuos, protocolo)
                    values ($1, $2, $3, $4, $5, $6, 25000, 'v2')`, [b, R1.rec, R1.inc, n, `F7BR3-0${n}`, DIA7]);
    await pg.query(`insert into app.alimentacion (id, bandeja_id, fecha, tipo_alimento, cantidad_kg, carga, grupal_id)
                    values ($1, $2, $3, 'Ensilaje', 1.5, 1, $4)`, [a, b, DIA7, R1.g1]);
  }

  const client = pgClient(pg);
  useBackend(client);
  const { pushAll } = await import('../src/data/sync/push.js');
  const db = await openDb();
  const r = await pushAll(db);
  assert.deepEqual({ pushed: r.pushed, conflicts: r.conflicts, blocked: r.blocked },
                   { pushed: 1, conflicts: 0, blocked: 0 });

  const rows = (await pg.query(
    `select carga, cantidad_kg, protocolo, ensilaje_id, registrado_por from app.alimentacion where grupal_id = $1`,
    [R1.g2])).rows;
  assert.equal(rows.length, 2);
  for (const x of rows) {
    assert.deepEqual([x.carga, Number(x.cantidad_kg), x.protocolo, x.ensilaje_id, x.registrado_por],
                     [2, 2, 'v2', null, 'Maria']);
  }
  await reset();
});

/* ── a failed upgrade must not half-migrate ───────────────────────────────── */

test('if the upgrade fails, the phone keeps its old database untouched', async () => {
  await reset();
  await buildBrokenV1([loteRow(ID.local, 'CO-2009-L', false)]);

  await assert.rejects(openDb(), 'la apertura debe fallar en vez de quedar a medias');

  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  assert.equal(db.version, 1, 'la versión no avanzó');
  assert.ok(db.objectStoreNames.contains('cochada'), 'el almacén viejo sigue ahí');
  assert.equal((await getAll(db, 'cochada')).length, 1, 'y sus filas también');
  db.close();
  await reset();
});
