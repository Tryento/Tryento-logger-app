/**
 * The whole lab through the data layer, the way a phone does it: every action
 * offline into IndexedDB and the queue, then pushed by the real sync engine to
 * a real Postgres built from SETUP_COMPLETO.sql, then pulled back.
 *
 * The tests share one phone and one server and run in order, like a day in the
 * lab: register the cages, ensile food, collect, check, distribute, feed,
 * separate, bake, close and clean a cage, repopulate it, correct a weight —
 * and two phones recording the same separación.
 */
import { useBackend } from './helpers/backend-env.mjs';   // first: config is read on import
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { randomUUID as uid } from 'node:crypto';
import { freshDb, openDb } from './helpers/env.mjs';
import { freshPg, readSql } from './helpers/pg.mjs';
import { pgClient } from './helpers/pg-client.mjs';

const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { pushAll } = await import('../src/data/sync/push.js');
const { pullOnce } = await import('../src/data/sync/pull.js');
const { listOpen, outboxStats } = await import('../src/data/outbox.js');
const { listConflicts, resolveConflict } = await import('../src/data/conflicts.js');
const { markDataChanged } = await import('../src/data/status.js');
const { invalidarSnapshot } = await import('../src/data/snapshot.js');
const { reqToPromise, withTx } = await import('../src/data/idb/tx.js');
const { farmDay, addDays, ddmm } = await import('../src/data/time.js');

const pg = await freshPg();
await pg.exec(await readSql('supabase/SETUP_COMPLETO.sql'));
useBackend(pgClient(pg));

await freshDb();
const db = await openDb();

async function sync() {
  const pushed = await pushAll(db);
  const pulled = await pullOnce(db);
  if (pulled.changed) markDataChanged();
  return { pushed, pulled };
}
const one = async (sql, p) => (await pg.query(sql, p)).rows[0];
const pausa = () => new Promise(res => setTimeout(res, 5));
const okData = res => { assert.ok(res.ok, JSON.stringify(res.error)); return res.data; };
const falla = (res, re) => {
  assert.equal(res.ok, false, 'debía rechazarse');
  assert.match(res.error.message, re);
};

const HOY = farmDay();
const DDMM = ddmm(new Date());
const S = {};

test('a new phone: the first sync brings the lists and the settings', async () => {
  await w.setCurrentOperator('Maria');
  const { pulled } = await sync();
  assert.deepEqual(pulled.errors, []);
  assert.deepEqual(okData(await r.listCatalogo('material_alimento')),
    ['Bagazo de cerveza (BSG)', 'Desecho de panadería', 'Desecho de fruta', 'Otro']);
  assert.deepEqual(okData(await r.listOperators()), ['Maria', 'Ricardo']);
  assert.equal(okData(await r.getProtocolo()).pct_coccion, 98);
});

test('register racks, a container and the cages, once', async () => {
  S.r1 = okData(await w.registrarRack({ codigo: 'r1' })).id;
  S.r2 = okData(await w.registrarRack({ codigo: 'R2' })).id;
  falla(await w.registrarRack({ codigo: 'R1' }), /Ya existe el rack R1/);
  S.s2 = okData(await w.registrarContenedor({ codigo: 'S2' })).id;

  S.ica = okData(await w.registrarJaula({ nombre: 'ica', letra: 'a', lugar: 'Galpón 1', generacion: 7, fase: 'activa' })).id;
  S.icb = okData(await w.registrarJaula({ nombre: 'ICB', letra: 'B', lugar: 'Galpón 1', generacion: 6, fase: 'limpia' })).id;
  falla(await w.registrarJaula({ nombre: 'ICC', letra: 'A', generacion: 1, fase: 'activa' }), /ya es de la jaula ICA/);
  falla(await w.registrarJaula({ nombre: 'ICC', letra: 'C', generacion: 1 }), /moscas o está limpia/);

  const jaulas = okData(await r.listJaulas()).jaulas;
  assert.deepEqual(jaulas.map(j => [j.nombre, j.fase, j.generacion]), [['ICA', 'activa', 7], ['ICB', 'limpia', 6]]);
});

test('food: a recepción, an ensilado from it, opened on its día 21', async () => {
  S.rec = okData(await w.registrarRecepcion({ material: 'Bagazo de cerveza (BSG)', kg: '100' })).id;
  falla(await w.registrarRecepcion({ material: 'Arena', kg: 1 }), /material de la lista/);
  falla(await w.crearEnsilado({ contenedor_id: S.s2, insumos: [{ recepcion_id: S.rec, kg: 120 }] }), /quedan 100 kg/);
  // Typed on a Spanish phone: a decimal comma is still checked against what is left.
  falla(await w.crearEnsilado({ contenedor_id: S.s2, insumos: [{ recepcion_id: S.rec, kg: '100,5' }] }), /quedan 100 kg/);

  const e = okData(await w.crearEnsilado({ contenedor_id: S.s2, insumos: [{ recepcion_id: S.rec, kg: '80' }] }));
  S.ens = e.ensilado.id;
  assert.equal(e.ensilado.codigo, `S2-${DDMM}`);
  falla(await w.abrirEnsilado({ ensilado_id: S.ens }), /sigue madurando/);

  // It was really made 22 days ago: corrected, the date is free.
  okData(await w.editarRegistro({ tabla: 'ensilado', id: S.ens,
                                  cambios: { ensilado_at: `${addDays(HOY, -22)}T10:00` } }));
  okData(await w.abrirEnsilado({ ensilado_id: S.ens }));
  falla(await w.abrirEnsilado({ ensilado_id: S.ens }), /ya está abierto/);
  const alim = okData(await r.getAlimento());
  assert.deepEqual(alim.stock.map(m => [m.material, m.kg_disponible]), [['Bagazo de cerveza (BSG)', 20]]);
  assert.equal(alim.ensilados[0].estadoTxt, 'Abierto');
});

test('recolecta: the incubadora F7A-1, its food from the open ensilado', async () => {
  falla(await w.registrarRecolecta({ jaula_id: S.icb, rack_id: S.r1, peso_inicial_g: 10, alimento_inicial_kg: 2 }),
        /ICB no tiene moscas \(está limpia\)/);
  falla(await w.registrarRecolecta({ jaula_id: S.ica, peso_inicial_g: 10, alimento_inicial_kg: 2 }), /rack/);

  const inc = okData(await w.registrarRecolecta({ jaula_id: S.ica, rack_id: S.r1, peso_inicial_g: '12,5',
                                                  alimento_inicial_kg: 2 }));
  S.inc1 = inc.id;
  assert.deepEqual([inc.codigo, inc.generacion, inc.dia0, inc.registrado_por], ['F7A-1', 7, HOY, 'Maria']);

  const det = okData(await r.getIncubadora(S.inc1));
  assert.match(det.registros.find(x => x.tabla === 'incubadora').detalle, new RegExp(`2 kg de S2-${DDMM}`));
  assert.equal(det.sin_ensilado, false);

  // A past day only with the excepción switch.
  const ayer = `${addDays(HOY, -1)}T09:00`;
  falla(await w.registrarRecolecta({ jaula_id: S.ica, rack_id: S.r1, peso_inicial_g: 9, alimento_inicial_kg: 2, fecha: ayer }),
        /fecha de hoy/);
  const tarde = okData(await w.registrarRecolecta({ jaula_id: S.ica, rack_id: S.r1, peso_inicial_g: 9,
                                                    alimento_inicial_kg: 2, fecha: ayer, excepcion: true }));
  S.inc2 = tarde.id;
  assert.deepEqual([tarde.codigo, tarde.dia0, tarde.excepcion], ['F7A-2', addDays(HOY, -1), true]);
});

test('chequeo día 3, then tamizado, pesado y distribución into cajas with carga 1', async () => {
  falla(await w.registrarChequeos({ objeto: 'incubadora', dia: 4, items: [{ id: S.inc1 }] }), /No hay chequeo/);
  okData(await w.registrarChequeos({ objeto: 'incubadora', dia: 3,
    items: [{ id: S.inc1, humedad_pct: '68', temperatura_c: '29,5', peso: 40 }] }));
  falla(await w.registrarChequeos({ objeto: 'incubadora', dia: 3,
    items: [{ id: S.inc1, humedad_pct: 68, temperatura_c: 29, peso: 41 }] }), /ya tiene el chequeo del día 3/);

  falla(await w.distribuir({ incubadora_id: S.inc1, peso_total_kg: 1.8, cajas: [{ peso_inicial_kg: 0.9 }] }), /rack/);
  const d = okData(await w.distribuir({ incubadora_id: S.inc1, peso_total_kg: 1.8, cajas: [
    { peso_inicial_kg: 0.9, rack_id: S.r1 }, { peso_inicial_kg: '0,9', rack_id: S.r1, carga_kg: 1.4 }] }));
  S.c1 = d.cajas[0].id; S.c2 = d.cajas[1].id;
  assert.deepEqual(d.cajas.map(c => c.codigo), ['F7A-1-01', 'F7A-1-02']);
  assert.deepEqual(d.cargas.map(c => [c.carga, c.kg, c.kg_plan]), [[1, 1.5, 1.5], [1, 1.4, 1.5]]);
  falla(await w.distribuir({ incubadora_id: S.inc1, peso_total_kg: 1, cajas: [{ peso_inicial_kg: 1, rack_id: S.r1 }] }),
        /ya fue distribuida/);
  assert.equal(okData(await r.getIncubadora(S.inc1)).incubadora.estadoTxt, 'Distribuida');
});

test('cajas: chequeo before carga 2, carga 3, the ayuno, the separación', async () => {
  falla(await w.registrarCargas({ carga: 2, items: [{ caja_id: S.c1 }] }), /primero el chequeo del día 10/);
  falla(await w.registrarCargas({ carga: 1, items: [{ caja_id: S.c1 }] }), /no está en el plan/);
  okData(await w.registrarChequeos({ objeto: 'caja', dia: 10, items: [
    { id: S.c1, humedad_pct: 62, temperatura_c: 31, peso: '2,3' },
    { id: S.c2, humedad_pct: 63, temperatura_c: 31, peso: 2.2 }] }));
  const c2 = okData(await w.registrarCargas({ carga: 2, items: [{ caja_id: S.c1 }, { caja_id: S.c2, kg: '2,5' }] }));
  assert.deepEqual(c2.map(c => c.kg), [2, 2.5]);
  okData(await w.registrarCargas({ carga: 3, items: [{ caja_id: S.c1 }] }));

  // Caja 2 skips carga 3: the día-14 chequeo starts the ayuno.
  okData(await w.registrarChequeos({ objeto: 'caja', dia: 14, items: [{ id: S.c2, humedad_pct: 60, temperatura_c: 30, peso: 4 }] }));
  falla(await w.registrarCargas({ carga: 3, items: [{ caja_id: S.c2 }] }), /está en ayuno/);
  assert.equal(okData(await r.getCaja(S.c2)).caja.estadoTxt, 'En ayuno');

  const seps = okData(await w.registrarSeparaciones({ items: [{ caja_id: S.c1, peso_total_kg: 10 },
                                                               { caja_id: S.c2, peso_total_kg: '20' }] }));
  S.sep1 = seps[0].id; S.sep2 = seps[1].id;
  falla(await w.registrarSeparaciones({ items: [{ caja_id: S.c1, peso_total_kg: 1 }] }), /ya fue separada/);
  const caja = okData(await r.getCaja(S.c1));
  assert.equal(caja.caja.estadoTxt, 'Separada');
  assert.match(caja.registros.find(x => x.tabla === 'separacion').detalle, /9,8 kg al horno · 0,2 kg al insectario/);
});

test('the oven: a cochada from the 98 %, part of it, and its readings', async () => {
  const horno = okData(await r.getHorno());
  assert.equal(horno.kg_pendiente, 29.4);
  falla(await w.crearCochada({ peso_inicial_kg: 30, origenes: [{ separacion_id: S.sep1, kg: 10 }] }), /quedan 9.8 kg/);
  falla(await w.crearCochada({ peso_inicial_kg: 30, origenes: [{ separacion_id: S.sep1, kg: '9,9' }] }), /quedan 9.8 kg/);
  // The kilos as the form sends them: "Todo" writes "9,8".
  const co = okData(await w.crearCochada({ peso_inicial_kg: '19,8', origenes: [
    { separacion_id: S.sep1, kg: '9,8' }, { separacion_id: S.sep2, kg: '10' }] }));
  assert.deepEqual(co.origenes.map(o => o.kg), [9.8, 10]);
  S.co = co.cochada.id;
  assert.equal(co.cochada.codigo, `H-${DDMM}-1`);
  assert.equal(okData(await r.getHorno()).kg_pendiente, 9.6, 'what is left of the second 98 %');

  falla(await w.registrarLectura({ cochada_id: S.co, momento: 'final', temperatura_c: 105 }), /peso final/);
  okData(await w.registrarLectura({ cochada_id: S.co, momento: 'media', temperatura_c: 92 }));
  falla(await w.registrarLectura({ cochada_id: S.co, momento: 'media', temperatura_c: 93 }), /Ya tiene/);
  okData(await w.registrarLectura({ cochada_id: S.co, momento: 'final', temperatura_c: 105, peso_kg: '6,2' }));
  const det = okData(await r.getCochada(S.co));
  assert.equal(det.cochada.estadoTxt, 'Lista para empacar');
  falla(await w.registrarLectura({ cochada_id: S.co, momento: 'final', temperatura_c: 1, peso_kg: 1 }), /ya salió del horno/);
});

test('the insectario: cierre, limpieza, repopulate with the 2 %; the cage becomes F8', async () => {
  falla(await w.registrarIngreso({ jaula_id: S.ica, kg_larvas: 0.5, bandejas: [{ peso_kg: 4.7, rack_id: S.r1 }] }),
        /ya está poblada/);
  falla(await w.registrarEventoJaula({ jaula_id: S.ica, tipo: 'limpieza' }), /se cierra antes de limpiarla/);
  okData(await w.registrarEventoJaula({ jaula_id: S.ica, tipo: 'cierre' }));
  falla(await w.registrarIngreso({ jaula_id: S.ica, kg_larvas: 0.5, bandejas: [{ peso_kg: 4.7, rack_id: S.r1 }] }),
        /falta la limpieza/);
  await pausa();
  okData(await w.registrarEventoJaula({ jaula_id: S.ica, tipo: 'limpieza' }));
  await pausa();

  const vista = okData(await r.previewIngreso({ kg_larvas: '0,5', n_bandejas: 2 }));
  assert.deepEqual([vista.kg, vista.generacion_larvas, vista.generacion_jaula, vista.mezcla], [0.5, 7, 8, false]);
  assert.deepEqual(vista.codigos, [`F7-B${DDMM}-1`, `F7-B${DDMM}-2`]);

  const ing = okData(await w.registrarIngreso({ jaula_id: S.ica, kg_larvas: '0,5',
    bandejas: [{ peso_kg: '4,7', rack_id: S.r1 }, { peso_kg: 3.9, rack_id: S.r2 }] }));
  S.ingA = ing.ingreso.id;
  assert.equal(ing.ingreso.generacion, 8);
  assert.deepEqual(ing.bandejas.map(b => [b.codigo, b.estado]), [[`F7-B${DDMM}-1`, 'inactivo'], [`F7-B${DDMM}-2`, 'inactivo']]);

  // ICB was registered clean: straight in. Only 0.1 kg of the 2 % is left.
  const b = okData(await w.registrarIngreso({ jaula_id: S.icb, kg_larvas: 0.2, bandejas: [{ peso_kg: 4.7, rack_id: S.r1 }] }));
  S.ingB = b.ingreso.id;
  assert.deepEqual([b.larvas.kg, b.larvas.faltan_kg, b.ingreso.generacion], [0.1, 0.1, 8]);
  assert.deepEqual(b.bandejas.map(x => x.codigo), [`F7-B${DDMM}-3`]);

  const jaulas = okData(await r.listJaulas());
  assert.deepEqual(jaulas.jaulas.map(j => [j.nombre, j.fase, j.generacion, j.dia_ciclo]),
                   [['ICA', 'activa', 8, 0], ['ICB', 'activa', 8, 0]]);
  assert.equal(jaulas.pool_kg, 0);

  // A recolecta now carries the new generation.
  const inc = okData(await w.registrarRecolecta({ jaula_id: S.ica, rack_id: S.r2, peso_inicial_g: 11, alimento_inicial_kg: 2 }));
  S.inc3 = inc.id;
  assert.equal(inc.codigo, 'F8A-1');
});

test('moves, an early close, a correction and its "revisar", a note, a photo', async () => {
  okData(await w.registrarMovimiento({ objeto: 'incubadora', objeto_id: S.inc3, rack_hasta: S.r1 }));
  falla(await w.registrarMovimiento({ objeto: 'incubadora', objeto_id: S.inc3, rack_hasta: S.r1 }), /Ya está en el rack R1/);
  assert.match(okData(await r.getIncubadora(S.inc3)).facts.find(f => f[0] === 'Rack')[1], /R1/);

  falla(await w.cerrarObjeto({ tabla: 'incubadora', id: S.inc3, motivo: '  ' }), /motivo/);
  okData(await w.cerrarObjeto({ tabla: 'incubadora', id: S.inc3, motivo: 'Derrame' }));
  const cerrada = okData(await r.getIncubadora(S.inc3));
  assert.equal(cerrada.incubadora.estadoTxt, 'Cerrada');
  assert.match(cerrada.cierre, /Derrame/);

  // The first separación weighed 12 kg, not 10: the 98/2 moves; what was built
  // on it is flagged.
  await pausa();
  okData(await w.editarRegistro({ tabla: 'separacion', id: S.sep1, cambios: { peso_total_kg: '12' } }));
  falla(await w.editarRegistro({ tabla: 'separacion', id: S.sep1, cambios: { peso_total_kg: '12' } }), /No hay cambios/);
  falla(await w.editarRegistro({ tabla: 'incubadora', id: S.inc1, cambios: { codigo: 'X' } }), /no se puede corregir/);
  const revisar = okData(await r.getRevisar());
  assert.deepEqual(revisar.map(x => x.tabla).sort(), ['cochada_origen', 'ingreso', 'ingreso']);
  assert.ok(revisar.find(x => x.id === S.ingA).motivos[0].includes('separación anterior'));

  await pausa();
  okData(await w.editarRegistro({ tabla: 'ingreso', id: S.ingA, cambios: { nota: 'larvas activas' } }));
  assert.equal(okData(await r.getRevisar()).length, 3, 'a note reviews nothing');
  await pausa();
  okData(await w.marcarRevisado({ tabla: 'ingreso', id: S.ingA }));
  assert.equal(okData(await r.getRevisar()).length, 2);

  // A photo, added afterwards to the cochada.
  await withTx(db, 'blobs', 'readwrite', s => reqToPromise(s.blobs.put({
    id: 'foto-1', blob: new Uint8Array([1, 2, 3]), bytes: 3, mime: 'image/jpeg', key: null,
    status: 'pending', attempts: 0, created_at: new Date().toISOString() })));
  const conFoto = okData(await w.editarRegistro({ tabla: 'cochada', id: S.co, blob_id: 'foto-1' }));
  assert.equal(conFoto.foto_key, `cochada/${S.co}/foto-1.jpg`);
  const item = (await listOpen(db)).find(i => i.rpc === 'editar' && i.row_id === S.co);
  assert.deepEqual(item.blob_ids, ['foto-1']);
});

test('everything reaches the server in order, and nothing is refused', async () => {
  const { pushed } = await sync();
  assert.equal(pushed.conflicts, 0, JSON.stringify(await listConflicts(db)));
  assert.equal((await outboxStats(db)).unsynced, 0);

  const inc = (await pg.query(`select codigo, estado, generacion, dia0::text, excepcion, motivo_cierre
                                 from app.incubadora order by codigo`)).rows;
  assert.deepEqual(inc, [
    { codigo: 'F7A-1', estado: 'inactivo', generacion: 7, dia0: HOY, excepcion: false, motivo_cierre: null },
    { codigo: 'F7A-2', estado: 'activo', generacion: 7, dia0: addDays(HOY, -1), excepcion: true, motivo_cierre: null },
    { codigo: 'F8A-1', estado: 'inactivo', generacion: 8, dia0: HOY, excepcion: false, motivo_cierre: 'Derrame' }
  ]);
  assert.deepEqual((await pg.query(`select codigo, estado from app.caja order by codigo`)).rows,
                   [{ codigo: 'F7A-1-01', estado: 'inactivo' }, { codigo: 'F7A-1-02', estado: 'inactivo' }]);
  assert.deepEqual(await one(`select peso_total_kg::text, coccion_kg::text, retorno_kg::text,
                                     valores_editados_at is not null as corregida from app.separacion where id = $1`, [S.sep1]),
                   { peso_total_kg: '12.000', coccion_kg: '11.760', retorno_kg: '0.240', corregida: true });
  assert.deepEqual(await one(`select estado, foto_key from app.cochada where id = $1`, [S.co]),
                   { estado: 'inactivo', foto_key: `cochada/${S.co}/foto-1.jpg` });
  assert.deepEqual((await pg.query(`select nombre, fase, generacion, ciclo_desde::text from app.jaula order by nombre`)).rows,
                   [{ nombre: 'ICA', fase: 'activa', generacion: 8, ciclo_desde: HOY },
                    { nombre: 'ICB', fase: 'activa', generacion: 8, ciclo_desde: HOY }]);
  assert.deepEqual(await one(`select nota, revisado_at is not null as revisado from app.ingreso where id = $1`, [S.ingA]),
                   { nota: 'larvas activas', revisado: true });
  assert.equal((await one(`select count(*)::int n from app.bandeja_pupacion`)).n, 3);
  assert.equal((await one(`select count(*)::int n from app.chequeo`)).n, 4);
  assert.equal((await one(`select count(*)::int n from app.alimentacion`)).n, 5);
  assert.equal((await one(`select count(*)::int n from app.movimiento`)).n, 1);
  assert.ok((await one(`select abierto_at from app.ensilado`)).abierto_at);
  assert.deepEqual((await pg.query(`select registrado_por, count(*)::int n from app.chequeo group by 1`)).rows,
                   [{ registrado_por: 'Maria', n: 4 }], 'who did it travels with every record');
});

test('pulled back, the phone and the server tell the same story', async () => {
  const { pulled } = await sync();
  assert.deepEqual(pulled.errors, []);
  invalidarSnapshot();
  const local = okData(await r.listIncubadoras({ inactivas: true }));
  assert.deepEqual(local.map(i => [i.codigo, i.estado]).sort(),
                   [['F7A-1', 'inactivo'], ['F7A-2', 'activo'], ['F8A-1', 'inactivo']]);
  const inicio = okData(await r.getInicio());
  assert.equal(inicio.conteos.revisar, 2);
  assert.equal(inicio.horno_kg, kgHorno());
  function kgHorno() { return Math.round((11.76 - 9.8 + 19.6 - 10) * 1000) / 1000; }
});

test('two phones separate the same caja: the server keeps one, "Descartar" takes the other back', async () => {
  const d = okData(await w.distribuir({ incubadora_id: S.inc2, peso_total_kg: 1, cajas: [{ peso_inicial_kg: 1, rack_id: S.r1 }] }));
  const caja = d.cajas[0].id;
  await sync();

  // The other phone got there first.
  await pg.query(`insert into app.separacion (id, caja_id, fecha, peso_total_kg, registrado_por)
                  values ($1, $2, now(), 15, 'Ricardo')`, [uid(), caja]);
  okData(await w.registrarSeparaciones({ items: [{ caja_id: caja, peso_total_kg: 14 }] }));
  const { pushed } = await sync();
  assert.equal(pushed.conflicts, 1);

  const [conflicto] = await listConflicts(db);
  assert.equal(conflicto.explanation, 'Otra persona ya registró la separación de esta caja. Sólo puede haber una.');
  okData(await resolveConflict(db, conflicto.id, 'discard'));
  invalidarSnapshot();
  await sync();
  invalidarSnapshot();
  const sep = okData(await r.getCaja(caja)).registros.filter(x => x.tabla === 'separacion');
  assert.equal(sep.length, 1);
  assert.equal(sep[0].por, 'Ricardo', "the server's, not this phone's");
});
