/**
 * The app in open mode (reglas_estrictas off, as a new database starts): staff
 * enter what they have, wrong or late, and delete records; only very odd things
 * ask first. flujo.test.mjs covers the same writes in protected mode. What the
 * database refuses is still refused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { freshDb } from './helpers/env.mjs';

const w = await import('../src/data/write.js');
const r = await import('../src/data/read.js');
const { putLocal } = await import('../src/data/store.js');
const { invalidarSnapshot } = await import('../src/data/snapshot.js');
const { farmDay, addDays } = await import('../src/data/time.js');

const HOY = farmDay();
const okData = res => { assert.ok(res.ok, JSON.stringify(res.error)); return res.data; };
const pide = (res, re) => {
  assert.equal(res.ok, false, 'debía preguntar');
  assert.equal(res.error.code, 'confirm_required', res.error.message);
  assert.match(res.error.message, re);
};
const SI = { confirmado: true };

const db = await freshDb();
await putLocal(db, 'catalogo', [{ id: 'm1', tipo: 'material_alimento', valor: 'Otro', orden: 1, activo: true,
                                  created_at: HOY, updated_at: HOY }]);
invalidarSnapshot();
await w.setCurrentOperator('Maria');
const cont = okData(await w.registrarContenedor({ codigo: 'S1' })).id;
const jaula = okData(await w.registrarJaula({ nombre: 'ICA', letra: 'A', generacion: 7, fase: 'activa' })).id;
const limpia = okData(await w.registrarJaula({ nombre: 'ICB', letra: 'B', generacion: 7, fase: 'limpia' })).id;
const S = {};
const recolecta = { jaula_id: jaula, peso_inicial_g: 10, n_bandejas: 3, alimento_bandeja_g: 400 };

test('a late date goes through, marked; only a very odd one asks', async () => {
  const inc = okData(await w.registrarRecolecta({ ...recolecta, fecha: `${addDays(HOY, -5)}T09:00` }));
  S.inc = inc.id;
  assert.deepEqual([inc.dia0, inc.excepcion], [addDays(HOY, -5), true]);

  pide(await w.registrarRecolecta({ ...recolecta, fecha: `${addDays(HOY, 3)}T09:00` }), /todavía no ha llegado/);
  pide(await w.registrarRecolecta({ ...recolecta, fecha: `${addDays(HOY, -400)}T09:00` }), /hace 400 días/);
  okData(await w.registrarRecolecta({ ...recolecta, fecha: `${addDays(HOY, 3)}T09:00`, ...SI }));
});

test('bandejas out of the range: shown on the form, never asked', async () => {
  const inc = okData(await w.registrarRecolecta({ ...recolecta, peso_inicial_g: 40, n_bandejas: 2 }));
  assert.deepEqual([inc.n_bandejas, inc.alimento_inicial_kg], [2, 0.8]);
  okData(await w.registrarRecolecta({ ...recolecta, peso_inicial_g: 2, n_bandejas: 9, alimento_bandeja_g: 0 }));
});

test('a recolecta from a cage without flies asks', async () => {
  assert.equal(okData(await r.getFormRecolecta()).jaulas.length, 2, 'the form offers the clean cage too');
  pide(await w.registrarRecolecta({ ...recolecta, jaula_id: limpia }), /ICB no tiene moscas/);
  okData(await w.registrarRecolecta({ ...recolecta, jaula_id: limpia, ...SI }));
});

test('out of order, past the ayuno, on a finished caja: saved without asking; days early asks', async () => {
  // Día 5: two days before the distribución is fine; cajas heavier than the total are not.
  const dist = { incubadora_id: S.inc, peso_total_kg: 1, cajas: [{ peso_inicial_kg: 5 }] };
  pide(await w.distribuir(dist), /Las cajas suman 5 kg y se tamizaron 1 kg/);
  S.caja = okData(await w.distribuir({ ...dist, ...SI })).cajas[0].id;

  // Carga 3 (día 13) on día 5: a week early.
  pide(await w.registrarCargas({ carga: 3, items: [{ caja_id: S.caja }] }), /carga 3 \(día 13\)/);
  okData(await w.registrarCargas({ carga: 3, items: [{ caja_id: S.caja }], ...SI }));
  okData(await w.registrarChequeos({ objeto: 'caja', dia: 14, ...SI, items: [{ id: S.caja, humedad_pct: 60, temperatura_c: 30, peso: 2 }] }));
  // Carga 2 after carga 3 and after the ayuno started, dated yesterday (día 4 of a día-10 carga: asked).
  okData(await w.registrarCargas({ carga: 2, items: [{ caja_id: S.caja }], fecha: `${addDays(HOY, -1)}T09:00`, ...SI }));
  S.sep = okData(await w.registrarSeparaciones({ items: [{ caja_id: S.caja, peso_total_kg: 1 }], ...SI }))[0].id;
  okData(await w.registrarChequeos({ objeto: 'caja', dia: 10, ...SI, items: [{ id: S.caja, humedad_pct: 60, temperatura_c: 30, peso: 2 }] }));
});

test('a step up to 3 days early does not ask', async () => {
  const inc = okData(await w.registrarRecolecta(recolecta));
  okData(await w.registrarChequeos({ objeto: 'incubadora', dia: 3, items: [{ id: inc.id, humedad_pct: 60, temperatura_c: 30, peso: 2 }] }));
});

test('what was never recorded can still be entered from its page', async () => {
  const inc = okData(await w.registrarRecolecta(recolecta));
  const d = okData(await w.distribuir({ incubadora_id: inc.id, peso_total_kg: 1, ...SI, cajas: [{ peso_inicial_kg: 1 }] }));
  okData(await w.registrarChequeos({ objeto: 'caja', dia: 14, ...SI, items: [{ id: d.cajas[0].id, humedad_pct: 60, temperatura_c: 30, peso: 2 }] }));
  const caja = okData(await r.getCaja(d.cajas[0].id));
  assert.deepEqual([caja.faltan_chequeos, caja.faltan_cargas], [[10], [2, 3]]);
  assert.deepEqual(okData(await r.getFormCargas({ caja_ids: [d.cajas[0].id], carga: 2 })).items.map(i => [i.en_ayuno, i.espera_chequeo]),
                   [[false, false]], 'the form does not hold it back');
  assert.deepEqual(okData(await r.getIncubadora(inc.id)).faltan_chequeos, [3]);
});

test('too many kilos, an ensilado before its material, opened early, corrected to the future: each asks', async () => {
  const cochada = { peso_inicial_kg: 50, origenes: [{ separacion_id: S.sep, kg: 50 }] };
  pide(await w.crearCochada(cochada), /quedan 0,98 kg del 98 %/);
  okData(await w.crearCochada({ ...cochada, ...SI }));

  const rec = okData(await w.registrarRecepcion({ material: 'Otro', kg: 5 })).id;
  const ens = { contenedor_id: cont, fecha: `${addDays(HOY, -2)}T09:00`, insumos: [{ recepcion_id: rec, kg: 4 }] };
  pide(await w.crearEnsilado(ens), /el ensilado no puede ser de antes/);
  pide(await w.crearEnsilado({ ...ens, fecha: null, insumos: [{ recepcion_id: rec, kg: 9 }] }), /quedan 5 kg/);
  const e = okData(await w.crearEnsilado({ ...ens, ...SI })).ensilado;

  assert.equal(okData(await r.getEnsilado(e.id)).puede_abrir, true);
  pide(await w.abrirEnsilado({ ensilado_id: e.id }), /sigue madurando/);
  okData(await w.abrirEnsilado({ ensilado_id: e.id, ...SI }));
  const futuro = { tabla: 'ensilado', id: e.id, cambios: { abierto_at: `${addDays(HOY, 5)}T08:00` } };
  pide(await w.editarRegistro(futuro), /posterior a ahora/);
  okData(await w.editarRegistro({ ...futuro, ...SI }));
});

test('what the database would refuse is still refused, not left to fail in the queue', async () => {
  assert.match((await w.registrarSeparaciones({ items: [{ caja_id: S.caja, peso_total_kg: 1 }] })).error.message, /ya fue separada/);
  assert.match((await w.registrarChequeos({ objeto: 'incubadora', dia: 3, items: [{ id: S.inc, humedad_pct: '', temperatura_c: 30, peso: 1 }] })).error.message,
               /falta la humedad/);
  assert.match((await w.registrarCargas({ carga: 2, items: [{ caja_id: S.caja }] })).error.message, /ya tiene la carga 2/);
  assert.match((await w.registrarIngreso({ jaula_id: jaula, kg_larvas: 1, bandejas: [{ peso_kg: 1 }] })).error.message, /ya está poblado/);
});

test('delete: says what goes with it, takes it all, and the work can be redone', async () => {
  const { aviso } = okData(await r.getBorrado({ tabla: 'distribucion', id: (await r.getIncubadora(S.inc)).data.registros.find(x => x.tabla === 'distribucion').id }));
  assert.match(aviso, /También se borra: 1 caja, 2 chequeos?|También se borra:.*1 caja/);

  // A separación: the caja is active again, and can be separated again.
  okData(await w.borrarRegistro({ tabla: 'separacion', id: S.sep }));
  assert.equal(okData(await r.getCaja(S.caja)).activa, true);
  assert.equal(okData(await r.getHorno()).activas.length + okData(await r.getHorno()).recientes.length, 1, 'the cochada stays');
  okData(await w.registrarSeparaciones({ items: [{ caja_id: S.caja, peso_total_kg: 2 }], ...SI }));

  // The incubadora: its caja and everything on it go too.
  const distId = okData(await r.getIncubadora(S.inc)).registros.find(x => x.tabla === 'distribucion').id;
  okData(await w.borrarRegistro({ tabla: 'incubadora', id: S.inc }));
  assert.equal((await r.getIncubadora(S.inc)).ok, false);
  assert.equal((await r.getCaja(S.caja)).ok, false);
  assert.equal((await w.borrarRegistro({ tabla: 'distribucion', id: distId })).error.code, 'not_found', 'already gone with it');
  assert.equal((await w.borrarRegistro({ tabla: 'parametro', id: 'x' })).ok, false);
});
