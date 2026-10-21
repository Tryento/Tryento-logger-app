/**
 * The 2 % back to the insectario, oldest first, and the 98 % waiting for the
 * oven.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pool2, pendienteHorno, resumenLarvas } from '../src/data/pool.js';
import { mergeProtocolo } from '../src/data/protocolo.js';

const cfg = mergeProtocolo([]);
const T = s => new Date(s).toISOString();

// Three cajas: two of F7 (día 0 on the 1st and the 3rd), one of F6 (the 2nd).
const incubadoras = [
  { id: 'iA', dia0: '2026-10-01', generacion: 7 },
  { id: 'iB', dia0: '2026-10-03', generacion: 7 },
  { id: 'iC', dia0: '2026-10-02', generacion: 6 }
];
const cajas = [
  { id: 'cA', codigo: 'F7A-1-01', incubadora_id: 'iA' },
  { id: 'cB', codigo: 'F7A-2-01', incubadora_id: 'iB' },
  { id: 'cC', codigo: 'F6B-1-01', incubadora_id: 'iC' }
];
// 2 % of 10, 20 and 30 kg: 0.2, 0.4, 0.6.
const separaciones = [
  { id: 'sA', caja_id: 'cA', fecha: T('2026-10-17T13:00:00Z'), peso_total_kg: 10, pct_coccion: 98, created_at: '1' },
  { id: 'sC', caja_id: 'cC', fecha: T('2026-10-18T13:00:00Z'), peso_total_kg: 30, pct_coccion: 98, created_at: '2' },
  { id: 'sB', caja_id: 'cB', fecha: T('2026-10-19T13:00:00Z'), peso_total_kg: 20, pct_coccion: 98, created_at: '3' }
];

test('ingresos draw oldest first, and only what was separated by their date', () => {
  const ingresos = [
    { id: 'g1', jaula_id: 'j', fecha: T('2026-10-18T15:00:00Z'), kg_larvas: 0.5, generacion: 8, created_at: '4' },
    { id: 'g2', jaula_id: 'k', fecha: T('2026-10-20T15:00:00Z'), kg_larvas: 0.4, generacion: 8, created_at: '5' }
  ];
  const r = pool2({ separaciones, cajas, incubadoras, ingresos }, cfg);
  const g1 = r.usos.get('g1');
  // By the 18th: 0.2 from A, then 0.3 of C's 0.6. B (19th) is not there yet.
  assert.deepEqual(g1.partes, [{ separacion_id: 'sA', caja_id: 'cA', kg: 0.2 },
                               { separacion_id: 'sC', caja_id: 'cC', kg: 0.3 }]);
  assert.equal(g1.faltan_kg, 0);
  assert.deepEqual([g1.edad_min, g1.edad_max, g1.edad_promedio], [16, 17, 17], 'simple average of the cajas');
  assert.deepEqual([g1.mezcla, g1.generaciones], [true, [6, 7]]);
  assert.equal(g1.generacion_larvas, 7, 'a tie goes to the oldest caja (F7A-1-01)');

  const g2 = r.usos.get('g2');
  assert.deepEqual(g2.partes.map(p => [p.separacion_id, p.kg]), [['sC', 0.3], ['sB', 0.1]]);
  assert.equal(r.kg_pendiente, 0.3, '0.4 of B minus the 0.1 g2 took');
  assert.deepEqual(r.pendientes.map(p => [p.caja_codigo, p.kg]), [['F7A-2-01', 0.3]]);
});

test('more kilos than the 2 % shows: drawn as far as it goes, the rest has no record', () => {
  const r = pool2({ separaciones, cajas, incubadoras }, cfg, { fecha: T('2026-10-21T15:00:00Z'), kg_larvas: 1.5 });
  assert.equal(r.nuevo.kg, 1.2);
  assert.equal(r.nuevo.faltan_kg, 0.3);
  assert.equal(r.kg_pendiente, 1.2, 'a preview is not an ingreso: what is waiting stays as recorded');
  const vacio = pool2({}, cfg, { fecha: T('2026-10-21T15:00:00Z'), kg_larvas: 1 });
  assert.equal(vacio.nuevo.generacion_larvas, null, 'nothing recorded: the generation must be typed');
});

test('the generation is the most common by caja', () => {
  const r = resumenLarvas([
    { caja_id: 'a', dia0: '2026-10-01', generacion: 6, kg: 1 },
    { caja_id: 'b', dia0: '2026-10-02', generacion: 7, kg: 1 },
    { caja_id: 'c', dia0: '2026-10-03', generacion: 7, kg: 1 }
  ], '2026-10-19');
  assert.deepEqual([r.generacion_larvas, r.mezcla, r.edad_min, r.edad_max, r.edad_promedio, r.dia0_promedio],
                   [7, true, 16, 18, 17, '2026-10-02']);
});

test('the 98 % waiting: what cochadas have not taken yet, never negative', () => {
  const origenes = [
    { separacion_id: 'sA', kg: 5 },
    { separacion_id: 'sA', kg: 4.8 },     // the rest of A's 9.8
    { separacion_id: 'sC', kg: 30 },      // more than C has (29.4)
    { separacion_id: 'sB', kg: 1, deleted_at: 'x' }
  ];
  const h = pendienteHorno({ separaciones, origenes }, cfg);
  assert.deepEqual(h.map(x => [x.separacion_id, x.coccion_kg, x.kg_tomado, x.kg_pendiente, x.excedido]), [
    ['sA', 9.8, 9.8, 0, false],
    ['sC', 29.4, 30, 0, true],
    ['sB', 19.6, 0, 19.6, false]
  ]);
});
