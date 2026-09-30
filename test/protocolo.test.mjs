/**
 * The v2 protocol, day by day, exactly as the lab's document lays it out
 * ("Régimen de alimentación optimizado, ciclo de 16 días"):
 *
 *   día 0        incubadora (starter)
 *   día 7        distribución + carga 1 (1,5 kg)
 *   día 10       carga 2 (2 kg) + tamizado de control
 *   día 13       carga 3 (2 kg)          → 5,5 kg per bandeja
 *   días 14–15   ayuno
 *   día 16       cosecha
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOLO_DEFAULTS, mergeProtocolo, siguientePaso, pasoIncubadora, diaCiclo,
  cuandoLabel, pasoLabel, v2Vigente, cargaDef
} from '../src/data/protocolo.js';
import { incubadoraCodigo, bandejaV2Codigo } from '../src/data/ids.js';
import { farmDay } from '../src/data/time.js';

const cfg = mergeProtocolo([]);

test('the defaults are the document: 3 loads, 5.5 kg, fast on 14, harvest on 16', () => {
  assert.deepEqual(cfg.cargas.map(c => [c.n, c.dia, c.kg]), [[1, 7, 1.5], [2, 10, 2], [3, 13, 2]]);
  assert.equal(cfg.cargas.reduce((s, c) => s + c.kg, 0), 5.5);
  assert.equal(cfg.dias_incubacion, 7);
  assert.equal(cfg.dia_inicio_ayuno, 14);
  assert.equal(cfg.horas_ayuno, 48, 'días 14 y 15');
  assert.equal(cfg.dia_cosecha, 16);
  assert.equal(cfg.individuos_por_bandeja, 25000);
  assert.equal(cfg.reserva_cria_pct, 2);
  assert.equal(cargaDef(cfg, 2).tamizado, true, 'tamizado de control en la carga 2');
});

test('settings from the database override the defaults, and a typo does not break anything', () => {
  const c = mergeProtocolo([
    { clave: 'dia_cosecha', valor: 17 },
    { clave: 'cargas', valor: '[{"n":1,"dia":7,"kg":1.4},{"n":2,"dia":11,"kg":2.1}]' },
    { clave: 'individuos_por_bandeja', valor: 'mucho' },          // malformed
    { clave: 'dias_incubacion', valor: -3 },                       // out of range
    { clave: 'fecha_corte', valor: '2026-10-01' },
    { clave: 'algo_desconocido', valor: 1 }
  ]);
  assert.equal(c.dia_cosecha, 17);
  assert.deepEqual(c.cargas.map(x => x.kg), [1.4, 2.1]);
  assert.equal(c.individuos_por_bandeja, 25000, 'malformed value keeps the default');
  assert.equal(c.dias_incubacion, 7, 'out-of-range value keeps the default');
  assert.equal(c.fecha_corte, '2026-10-01');
  assert.ok(!('algo_desconocido' in c));
  assert.equal(PROTOCOLO_DEFAULTS.dia_cosecha, 16, 'the defaults themselves are never mutated');
});

test('next step for a v2 tray, every day of the cycle', () => {
  const at = (dia, extra = {}) => siguientePaso({ dia_ciclo: dia, cargas_dadas: [], ...extra }, cfg);

  // Day 7: the distribución normally includes carga 1, so the next is carga 2.
  assert.deepEqual(pick(at(7, { cargas_dadas: [1] })), ['carga', 2, 'proximo', -3]);
  assert.deepEqual(pick(at(9, { cargas_dadas: [1] })), ['carga', 2, 'proximo', -1]);
  assert.deepEqual(pick(at(10, { cargas_dadas: [1] })), ['carga', 2, 'hoy', 0]);
  assert.deepEqual(pick(at(11, { cargas_dadas: [1] })), ['carga', 2, 'atrasado', 1]);
  assert.deepEqual(pick(at(12, { cargas_dadas: [1, 2] })), ['carga', 3, 'proximo', -1]);
  assert.deepEqual(pick(at(13, { cargas_dadas: [1, 2] })), ['carga', 3, 'hoy', 0]);
  assert.deepEqual(pick(at(13, { cargas_dadas: [1, 2, 3] })), ['ayuno', undefined, 'proximo', -1]);
  assert.deepEqual(pick(at(14, { cargas_dadas: [1, 2, 3] })), ['ayuno', undefined, 'hoy', 0]);
  assert.deepEqual(pick(at(15, { cargas_dadas: [1, 2, 3], tiene_ayuno: true })), ['cosecha', undefined, 'proximo', -1]);
  assert.deepEqual(pick(at(16, { cargas_dadas: [1, 2, 3], tiene_ayuno: true })), ['cosecha', undefined, 'hoy', 0]);
  assert.deepEqual(pick(at(17, { cargas_dadas: [1, 2, 3], tiene_ayuno: true })), ['cosecha', undefined, 'atrasado', 1]);
  assert.equal(at(16, { tiene_ayuno: true, cosechada: true }), null, 'nothing left after the harvest');
});

test('a load missed before día 14 stops being "due": the protocol fasts anyway', () => {
  const p = siguientePaso({ dia_ciclo: 14, cargas_dadas: [1, 2] }, cfg);
  assert.equal(p.paso, 'ayuno');
  // If carga 1 was not given with the distribución, it is due right away.
  assert.deepEqual(pick(siguientePaso({ dia_ciclo: 8, cargas_dadas: [] }, cfg)), ['carga', 1, 'atrasado', 1]);
});

test('incubadora: distribution is due on día 7', () => {
  const hoy = '2026-09-08';
  assert.deepEqual(pick(pasoIncubadora({ fecha_inicio: '2026-09-01' }, cfg, hoy)), ['distribucion', undefined, 'hoy', 0]);
  assert.deepEqual(pick(pasoIncubadora({ fecha_inicio: '2026-09-03' }, cfg, hoy)), ['distribucion', undefined, 'proximo', -2]);
  assert.equal(pasoIncubadora({ fecha_inicio: '2026-09-01', distribuida_at: '2026-09-08T12:00:00Z' }, cfg, hoy), null);
});

test('the cycle day is the FARM day, also between 20:00 and midnight in Caracas', () => {
  // 22:30 in Caracas on 2026-09-10 is already 2026-09-11 in UTC.
  const late = new Date('2026-09-11T02:30:00Z');
  assert.equal(farmDay(late), '2026-09-10');
  assert.equal(diaCiclo('2026-09-01', farmDay(late)), 9, 'still día 9 on the farm, not día 10');
  assert.equal(diaCiclo('2026-09-01', '2026-09-17'), 16);
});

test('labels a person can read', () => {
  assert.equal(pasoLabel({ paso: 'carga', carga: 1, kg: 1.5 }), 'Carga 1 · 1,5 kg');
  assert.equal(pasoLabel({ paso: 'ayuno' }), 'Iniciar ayuno');
  assert.equal(cuandoLabel({ estado: 'hoy', dias: 0 }), 'hoy');
  assert.equal(cuandoLabel({ estado: 'proximo', dias: -1 }), 'mañana');
  assert.equal(cuandoLabel({ estado: 'proximo', dias: -3 }), 'en 3 días');
  assert.equal(cuandoLabel({ estado: 'atrasado', dias: 1 }), 'atrasado 1 día');
});

test('codes: F7AR9 and its trays F7AR9-01…', () => {
  const letras = cfg.letras_insectario;
  assert.equal(incubadoraCodigo({ generacion: 'F7', nombreInsectario: 'ICA', recolecta: '9', letras }), 'F7AR9');
  assert.equal(incubadoraCodigo({ generacion: 'f8', nombreInsectario: 'ICB', recolecta: '12', letras }), 'F8BR12');
  assert.equal(incubadoraCodigo({ generacion: 'F7', nombreInsectario: 'JN3A', recolecta: '1', letras }), 'F7JR1');
  assert.equal(incubadoraCodigo({ generacion: 'F7', nombreInsectario: 'NUEVO', recolecta: '1', letras }), 'F7NR1',
    'an insectario without a letter still gets a code');
  assert.equal(bandejaV2Codigo('F7AR9', 1), 'F7AR9-01');
  assert.equal(bandejaV2Codigo('F7AR9', 12), 'F7AR9-12');
});

test('cutover: no date means v2 already applies', () => {
  assert.equal(v2Vigente({ fecha_corte: null }, '2026-09-29'), true);
  assert.equal(v2Vigente({ fecha_corte: '2026-10-01' }, '2026-09-29'), false);
  assert.equal(v2Vigente({ fecha_corte: '2026-10-01' }, '2026-10-01'), true);
});

function pick(p) {
  return p ? [p.paso, p.carga, p.estado, p.dias] : null;
}
