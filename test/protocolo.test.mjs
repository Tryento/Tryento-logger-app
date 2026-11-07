/**
 * The protocol rules, on pinned farm days: settings, the 98/2 split, the day
 * count, and what each object needs next.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOLO_DEFAULTS, mergeProtocolo, repartoSeparacion, bandejasParaHuevos, huevosPorBandeja,
  diaCiclo, diaSemana, timing,
  pasosIncubadora, pasosCaja, estadoJaula, pasosJaula, pasosCochada, cargasDeCaja, cargaDistribucion
} from '../src/data/protocolo.js';
import {
  siguienteIncubadora, cajaCodigo, siguienteCochada, ensiladoCodigo, siguientesBandejas
} from '../src/data/ids.js';

const cfg = mergeProtocolo([]);
const resumen = pasos => pasos.map(p =>
  `${p.paso}${p.carga ?? ''}@${p.dia ?? ''}:${p.estado}${p.bloqueado ? '!' : ''}${p.aviso ? '' : '~'}`);

test('settings: the seeded values, and a bad value in the table never wins', () => {
  assert.deepEqual(cfg.cargas, [{ n: 1, dia: 7, kg: 1.5 }, { n: 2, dia: 10, kg: 2 }, { n: 3, dia: 13, kg: 2 }]);
  assert.equal(cfg.pct_coccion, 98);
  assert.deepEqual([cfg.huevos_bandeja_min_g, cfg.huevos_bandeja_max_g, cfg.alimento_bandeja_g], [2, 5, 400]);
  assert.equal(cfg.reglas_estrictas, false, 'modo abierto hasta que la base diga otra cosa');

  const c = mergeProtocolo([
    { clave: 'pct_coccion', valor: 97 },
    { clave: 'alimento_bandeja_g', valor: '350' },
    { clave: 'reglas_estrictas', valor: 'tal vez' },
    { clave: 'dias_recolecta', valor: [1, 9] },              // 9 is not a weekday
    { clave: 'cargas', valor: 'no es json' },
    { clave: 'dias_maduracion', valor: 21.5 },
    { clave: 'otra_cosa', valor: 1 },
    { clave: 'horas_consumo', valor: 48, deleted_at: '2026-10-01T00:00:00Z' }
  ]);
  assert.equal(c.pct_coccion, 97);
  assert.equal(c.alimento_bandeja_g, 350);
  assert.equal(c.reglas_estrictas, false);
  assert.equal(mergeProtocolo([{ clave: 'reglas_estrictas', valor: true }]).reglas_estrictas, true);
  // A range the wrong way round is a typo.
  const alReves = mergeProtocolo([{ clave: 'huevos_bandeja_min_g', valor: 6 }, { clave: 'huevos_bandeja_max_g', valor: 5 }]);
  assert.deepEqual([alReves.huevos_bandeja_min_g, alReves.huevos_bandeja_max_g], [2, 5]);
  assert.deepEqual(c.dias_recolecta, [1, 3, 5]);
  assert.deepEqual(c.cargas, PROTOCOLO_DEFAULTS.cargas);
  assert.equal(c.dias_maduracion, 21);
  assert.equal(c.horas_consumo, 72);
  assert.ok(!('otra_cosa' in c));
});

test('the 98/2 split rounds exactly like Postgres numeric', () => {
  assert.deepEqual(repartoSeparacion(10, 98), { coccion_kg: 9.8, retorno_kg: 0.2 });
  assert.deepEqual(repartoSeparacion(12.5, 98), { coccion_kg: 12.25, retorno_kg: 0.25 });
  // 0.125 * 0.98 = 0.1225: Postgres rounds half away from zero → 0.123.
  // Floating point (0.12249999…) would say 0.122.
  assert.deepEqual(repartoSeparacion(0.125, 98), { coccion_kg: 0.123, retorno_kg: 0.002 });
  assert.deepEqual(repartoSeparacion('7,3'.replace(',', '.'), 97.5), { coccion_kg: 7.118, retorno_kg: 0.182 });
  assert.deepEqual(repartoSeparacion(0, 98), { coccion_kg: 0, retorno_kg: 0 });
});

test('bandejas from the eggs: within 2–5 g each, proposing the middle of the range', () => {
  const b = g => { const r = bandejasParaHuevos(g, cfg); return r && [r.min, r.max, r.sugerida]; };
  assert.deepEqual(b(12), [3, 6, 3]);
  assert.deepEqual(b(20), [4, 10, 6]);
  assert.deepEqual(b(7), [2, 3, 2]);
  assert.deepEqual(b(5.5), [2, 2, 2]);
  assert.deepEqual(b(5), [1, 2, 1]);
  assert.deepEqual(b(2), [1, 1, 1]);
  assert.deepEqual(b(1), [1, 1, 1], 'muy pocos huevos: una bandeja igual');
  assert.equal(b(0), null);
  assert.equal(b(''), null);
  assert.equal(b('abc'), null);
  // The range is a setting. Where no count fits it, the closest one is proposed.
  const otro = mergeProtocolo([{ clave: 'huevos_bandeja_min_g', valor: 1 }, { clave: 'huevos_bandeja_max_g', valor: 3 }]);
  assert.deepEqual(bandejasParaHuevos(12, otro), { min: 4, max: 12, sugerida: 6 });
  const estrecho = mergeProtocolo([{ clave: 'huevos_bandeja_min_g', valor: 4 }, { clave: 'huevos_bandeja_max_g', valor: 5 }]);
  assert.deepEqual(bandejasParaHuevos(5.5, estrecho), { min: 2, max: 2, sugerida: 2 });
});

test('grams per bandeja, and whether that leaves the range', () => {
  assert.deepEqual(huevosPorBandeja(12, 3, cfg), { g_bandeja: 4, fuera: false });
  assert.deepEqual(huevosPorBandeja(12, 1, cfg), { g_bandeja: 12, fuera: true });
  assert.deepEqual(huevosPorBandeja(12, 8, cfg), { g_bandeja: 1.5, fuera: true });
  assert.deepEqual(huevosPorBandeja(10, 3, cfg), { g_bandeja: 3.33, fuera: false });
  assert.deepEqual(huevosPorBandeja(1, 1, cfg), { g_bandeja: 1, fuera: false }, 'con menos no se puede hacer otra cosa');
  assert.deepEqual(huevosPorBandeja(1, 2, cfg), { g_bandeja: 0.5, fuera: true });
  assert.equal(huevosPorBandeja(0, 2, cfg), null);
  assert.equal(huevosPorBandeja(12, 0, cfg), null);
});

test('days are farm days; weekdays Monday = 1', () => {
  assert.equal(diaCiclo('2026-10-19', '2026-10-26'), 7);
  assert.equal(diaSemana('2026-10-19'), 1);      // Monday
  assert.equal(diaSemana('2026-10-25'), 7);      // Sunday
  assert.deepEqual(timing('2026-10-20', '2026-10-20'), { vence: '2026-10-20', dias: 0, estado: 'hoy' });
  assert.equal(timing('2026-10-22', '2026-10-20').estado, 'proximo');
  assert.equal(timing('2026-10-18', '2026-10-20').dias, 2);
});

test('the carga of the distribución is part of it; the others are steps', () => {
  assert.deepEqual(cargaDistribucion(cfg), { n: 1, dia: 7, kg: 1.5 });
  assert.deepEqual(cargasDeCaja(cfg).map(c => c.n), [2, 3]);
});

test('incubadora: chequeo día 3, distribución día 7', () => {
  const inc = { dia0: '2026-10-19', created_at: '2026-10-19T13:00:00.000Z', estado: 'activo' };
  assert.deepEqual(resumen(pasosIncubadora(inc, {}, cfg, '2026-10-21')),
                   ['chequeo@3:proximo', 'distribucion@7:proximo']);
  assert.deepEqual(resumen(pasosIncubadora(inc, { chequeos: [{ dia: 3 }] }, cfg, '2026-10-26')),
                   ['distribucion@7:hoy']);
  assert.deepEqual(resumen(pasosIncubadora({ ...inc, estado: 'inactivo' }, {}, cfg, '2026-10-26')), []);
  assert.deepEqual(resumen(pasosIncubadora({ ...inc, cerrado_at: '2026-10-20T10:00:00Z' }, {}, cfg, '2026-10-21')), []);
});

test('a recolecta entered late (excepción): what was due before it is not chased', () => {
  // Día 0 on the 13th, entered on the 18th (día 5).
  const inc = { dia0: '2026-10-13', created_at: '2026-10-18T15:00:00.000Z', estado: 'activo', excepcion: true };
  assert.deepEqual(resumen(pasosIncubadora(inc, {}, cfg, '2026-10-18')), ['distribucion@7:proximo']);
  // Entered on día 9: the distribución is still doable, just not chased.
  const tarde = { ...inc, created_at: '2026-10-22T15:00:00.000Z' };
  assert.deepEqual(resumen(pasosIncubadora(tarde, {}, cfg, '2026-10-22')), ['distribucion@7:atrasado~']);
  // Marked as due before the record existed: its page says pending, not late.
  assert.equal(pasosIncubadora(tarde, {}, cfg, '2026-10-22')[0].previo, true);
  assert.equal(pasosIncubadora(inc, {}, cfg, '2026-10-18')[0].previo, false);
});

test('caja: chequeo día 10 before carga 2, carga 3, ayuno from the día-14 chequeo, separación', () => {
  const caja = { estado: 'activo', created_at: '2026-10-26T13:00:00.000Z' };   // distributed on día 7
  const dia0 = '2026-10-19';
  const cargas = [{ carga: 1 }];
  // Día 10: the chequeo is due; "para hoy" does not chase carga 2 until it is in…
  assert.deepEqual(resumen(pasosCaja(caja, { dia0, cargas }, cfg, '2026-10-29')),
                   ['chequeo@10:hoy', 'carga2@10:hoy~', 'carga3@13:proximo', 'chequeo@14:proximo', 'separacion@16:proximo']);
  // …and in protected mode carga 2 waits for it.
  const estricta = mergeProtocolo([{ clave: 'reglas_estrictas', valor: true }]);
  assert.deepEqual(resumen(pasosCaja(caja, { dia0, cargas }, estricta, '2026-10-29')),
                   ['chequeo@10:hoy', 'carga2@10:hoy!~', 'carga3@13:proximo', 'chequeo@14:proximo', 'separacion@16:proximo']);
  // Chequeo done: carga 2 is free.
  const ch10 = [{ dia: 10 }];
  assert.deepEqual(resumen(pasosCaja(caja, { dia0, cargas, chequeos: ch10 }, cfg, '2026-10-29')),
                   ['carga2@10:hoy', 'carga3@13:proximo', 'chequeo@14:proximo', 'separacion@16:proximo']);
  // The día-14 chequeo starts the ayuno: a carga 3 never given is not offered any more.
  const ch14 = [{ dia: 10 }, { dia: 14 }];
  const enAyuno = pasosCaja(caja, { dia0, cargas: [{ carga: 1 }, { carga: 2 }], chequeos: ch14 }, cfg, '2026-11-02');
  assert.deepEqual(resumen(enAyuno), ['separacion@16:proximo']);
  // A chequeo nobody did stops being asked once a later one is in.
  assert.deepEqual(resumen(pasosCaja(caja, { dia0, cargas, chequeos: [{ dia: 14 }] }, cfg, '2026-11-02')),
                   ['separacion@16:proximo']);
  // Likewise a carga: once carga 3 was given (confirmed out of order), carga 2 is not asked.
  assert.deepEqual(resumen(pasosCaja(caja, { dia0, cargas: [{ carga: 1 }, { carga: 3 }], chequeos: ch10 }, cfg, '2026-11-01')),
                   ['chequeo@14:proximo', 'separacion@16:proximo']);
  // Separated: nothing left.
  assert.deepEqual(pasosCaja(caja, { dia0, cargas, separada: true }, cfg, '2026-11-04'), []);
});

test('caja distributed late (go-live): steps due before it was entered are not asked', () => {
  // Día 0 on the 7th, distributed (entered) on the 19th = día 12.
  const caja = { estado: 'activo', created_at: '2026-10-19T13:00:00.000Z' };
  const pasos = pasosCaja(caja, { dia0: '2026-10-07', cargas: [{ carga: 1 }] }, cfg, '2026-10-19');
  assert.deepEqual(resumen(pasos), ['carga3@13:proximo', 'chequeo@14:proximo', 'separacion@16:proximo']);
});

test('cage: phase and generation from its last ingreso, cierre or limpieza', () => {
  const j = { fase_inicial: 'activa', generacion_inicial: 7 };
  assert.deepEqual(estadoJaula(j, {}), { fase: 'activa', estado: 'activo', generacion: 7, ciclo_desde: null, ultimo: null });
  const eventos = [{ tipo: 'cierre', fecha: '2026-11-01T14:00:00.000Z', created_at: 'a' },
                   { tipo: 'limpieza', fecha: '2026-11-02T14:00:00.000Z', created_at: 'b' }];
  assert.equal(estadoJaula(j, { eventos }).fase, 'limpia');
  const ingresos = [{ generacion: 8, fecha: '2026-11-03T02:00:00.000Z', created_at: 'c' }];   // 22:00 on the 2nd
  const e = estadoJaula(j, { eventos, ingresos });
  assert.deepEqual([e.fase, e.generacion, e.ciclo_desde], ['activa', 8, '2026-11-02']);
  assert.equal(estadoJaula(j, { eventos, ingresos: [{ ...ingresos[0], deleted_at: 'x' }] }).generacion, 7);
});

test('cage steps: recolecta Mon/Wed/Fri, cierre ~14 days into a cycle the app saw begin', () => {
  const j = { fase_inicial: 'activa', generacion_inicial: 7 };
  // Tuesday the 20th: the next recolecta is tomorrow; a cage with flies since
  // before the app has no cierre reminder.
  const est = estadoJaula(j, {});
  assert.deepEqual(resumen(pasosJaula(j, est, {}, cfg, '2026-10-20')), ['recolecta@:proximo']);
  // Monday: today, unless it already gave one.
  assert.deepEqual(resumen(pasosJaula(j, est, {}, cfg, '2026-10-19')), ['recolecta@:hoy']);
  assert.deepEqual(resumen(pasosJaula(j, est, { recolectasHoy: true }, cfg, '2026-10-19')), ['recolecta@:proximo']);
  // Repopulated on the 5th: the cierre is due on the 19th.
  const ing = estadoJaula(j, { ingresos: [{ generacion: 8, fecha: '2026-10-05T14:00:00.000Z' }] });
  assert.deepEqual(resumen(pasosJaula(j, ing, {}, cfg, '2026-10-20')), ['recolecta@:proximo', 'cierre@:atrasado']);
  // Closed → limpieza; clean → repopulate when there is 2 % waiting.
  const cerrada = estadoJaula(j, { eventos: [{ tipo: 'cierre', fecha: '2026-10-19T14:00:00.000Z' }] });
  assert.deepEqual(resumen(pasosJaula(j, cerrada, {}, cfg, '2026-10-20')), ['limpieza@:atrasado']);
  const limpia = estadoJaula({ fase_inicial: 'limpia', generacion_inicial: 3 }, {});
  assert.deepEqual(resumen(pasosJaula(j, limpia, { poolKg: 0 }, cfg, '2026-10-20')), ['repoblado@:hoy~']);
  assert.deepEqual(resumen(pasosJaula(j, limpia, { poolKg: 1.2 }, cfg, '2026-10-20')), ['repoblado@:hoy']);
});

test('cochada: the mid reading, then the final one', () => {
  const co = { estado: 'activo', horno_at: '2026-11-04T15:00:00.000Z' };
  assert.deepEqual(resumen(pasosCochada(co, {}, '2026-11-04')), ['lectura_media@:hoy', 'lectura_final@:hoy~']);
  assert.deepEqual(resumen(pasosCochada(co, { lecturas: [{ momento: 'media' }] }, '2026-11-04')), ['lectura_final@:hoy']);
  assert.deepEqual(pasosCochada(co, { lecturas: [{ momento: 'final' }] }, '2026-11-04'), []);
});

test('codes: given once, numbering continues from what was given', () => {
  assert.deepEqual(siguienteIncubadora(8, 'a', ['F8A-1', 'F8A-12', 'F8B-30', 'F7A-40']), { codigo: 'F8A-13', numero: 13 });
  assert.deepEqual(siguienteIncubadora(9, 'A', ['F8A-12']), { codigo: 'F9A-1', numero: 1 }, 'restarts per generation');
  assert.equal(cajaCodigo('F8A-12', 3), 'F8A-12-03');
  // 23:30 on the 28th in Caracas is the 29th in UTC: the code follows the farm.
  assert.equal(siguienteCochada('2026-10-29T03:30:00.000Z', ['H-2810-1', 'H-2810-2']), 'H-2810-3');
  assert.equal(ensiladoCodigo('s2', '2026-10-28T15:00:00.000Z'), 'S2-2810');
  assert.deepEqual(siguientesBandejas(7, '2026-11-05T14:00:00.000Z', 2, ['F7-B0511-1']).map(b => b.codigo),
                   ['F7-B0511-2', 'F7-B0511-3']);
});
