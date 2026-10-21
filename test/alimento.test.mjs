/**
 * The food cycle, worked out from what was recorded: every feeding takes from
 * the oldest ensilado open at that moment; 72 h after opening, what is left is
 * discarded; the store is what came in minus what was ensiled.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cicloAlimento, consumosDe, stockMaterial } from '../src/data/alimento.js';
import { mergeProtocolo } from '../src/data/protocolo.js';

const cfg = mergeProtocolo([]);
const T = s => new Date(s).toISOString();

// Two ensilados, both open on the 17th of November; S1 is the older one.
const ensilados = [
  { id: 's1', codigo: 'S1-2710', ensilado_at: T('2026-10-27T15:00:00Z'), abierto_at: T('2026-11-17T12:00:00Z') },
  { id: 's2', codigo: 'S2-2810', ensilado_at: T('2026-10-28T15:00:00Z'), abierto_at: T('2026-11-18T12:00:00Z') },
  { id: 's3', codigo: 'S3-0111', ensilado_at: T('2026-11-01T15:00:00Z'), abierto_at: null }
];
const insumos = [
  { id: 'i1', ensilado_id: 's1', recepcion_id: 'r1', kg: 10 },
  { id: 'i2', ensilado_id: 's2', recepcion_id: 'r1', kg: 30 },
  { id: 'i3', ensilado_id: 's2', recepcion_id: 'r2', kg: 20 },
  { id: 'i4', ensilado_id: 's3', recepcion_id: 'r2', kg: 40 }
];

test('oldest open ensilado first, splitting when it runs out', () => {
  const consumos = [
    { id: 'antes', tabla: 'incubadora', fecha: T('2026-11-16T12:00:00Z'), kg: 2 },  // nothing open yet
    { id: 'c1', tabla: 'alimentacion', fecha: T('2026-11-18T13:00:00Z'), kg: 6 },
    { id: 'c2', tabla: 'alimentacion', fecha: T('2026-11-18T14:00:00Z'), kg: 6 },   // 4 left in S1, 2 from S2
    { id: 'c3', tabla: 'alimentacion', fecha: T('2026-11-19T13:00:00Z'), kg: 0 }    // nothing to take
  ];
  const r = cicloAlimento({ ensilados, insumos, consumos }, cfg, Date.parse('2026-11-19T15:00:00Z'));
  assert.deepEqual(r.consumos.get('antes'), { tabla: 'incubadora', partes: [], sin_ensilado_kg: 2 });
  assert.deepEqual(r.consumos.get('c1').partes, [{ ensilado_id: 's1', codigo: 'S1-2710', kg: 6 }]);
  assert.deepEqual(r.consumos.get('c2').partes, [{ ensilado_id: 's1', codigo: 'S1-2710', kg: 4 },
                                                 { ensilado_id: 's2', codigo: 'S2-2810', kg: 2 }]);
  assert.equal(r.consumos.get('c2').sin_ensilado_kg, 0);
  assert.ok(!r.consumos.has('c3'));

  const s1 = r.ensilados.get('s1'), s2 = r.ensilados.get('s2'), s3 = r.ensilados.get('s3');
  assert.deepEqual([s1.estado, s1.kg_total, s1.kg_usado, s1.kg_restante], ['abierto', 10, 10, 0]);
  assert.deepEqual([s2.estado, s2.kg_total, s2.kg_usado, s2.kg_restante], ['abierto', 50, 2, 48]);
  assert.deepEqual([s3.estado, s3.dia0, s3.apertura_prevista], ['madurando', '2026-11-01', '2026-11-22']);
});

test('72 h after opening, what is left is discarded and nothing more is taken', () => {
  const consumos = [
    { id: 'c1', tabla: 'alimentacion', fecha: T('2026-11-18T13:00:00Z'), kg: 4 },
    // S1 expires at 12:00 on the 20th; this carga is after it.
    { id: 'c2', tabla: 'alimentacion', fecha: T('2026-11-20T13:00:00Z'), kg: 3 }
  ];
  const r = cicloAlimento({ ensilados, insumos, consumos }, cfg, Date.parse('2026-11-21T13:00:00Z'));
  const s1 = r.ensilados.get('s1');
  assert.deepEqual([s1.estado, s1.kg_usado, s1.kg_restante, s1.kg_descartado], ['vencido', 4, 0, 6]);
  assert.equal(s1.vence_at, T('2026-11-20T12:00:00Z'));
  assert.deepEqual(r.consumos.get('c2').partes, [{ ensilado_id: 's2', codigo: 'S2-2810', kg: 3 }],
    'S2 is still open, until the 21st at 12:00');
});

test('a feeding with no open ensilado is recorded and shown as sin ensilado', () => {
  const r = cicloAlimento({ ensilados: [], insumos: [],
    consumos: [{ id: 'x', tabla: 'alimentacion', fecha: T('2026-11-18T13:00:00Z'), kg: 1.5 }] }, cfg);
  assert.equal(r.consumos.get('x').sin_ensilado_kg, 1.5);
});

test('the feedings of the cycle: initial food at the recolecta and every carga', () => {
  const c = consumosDe({
    incubadoras: [{ id: 'i', recolecta_at: 'A', alimento_inicial_kg: 2 },
                  { id: 'gone', recolecta_at: 'B', alimento_inicial_kg: 2, deleted_at: 'x' }],
    alimentaciones: [{ id: 'a', fecha: 'C', kg: '1.5' }]
  });
  assert.deepEqual(c, [{ id: 'i', tabla: 'incubadora', fecha: 'A', kg: 2 },
                       { id: 'a', tabla: 'alimentacion', fecha: 'C', kg: 1.5 }]);
});

test('the store: received minus ensiled, per material and per recepción', () => {
  const recepciones = [
    { id: 'r1', material: 'Bagazo de cerveza (BSG)', kg: 100, fecha: 'a' },
    { id: 'r2', material: 'Desecho de fruta', kg: 60, fecha: 'b' },
    { id: 'r3', material: 'Bagazo de cerveza (BSG)', kg: 25, fecha: 'c' }
  ];
  const s = stockMaterial({ recepciones, insumos });
  assert.deepEqual(s.porMaterial.get('Bagazo de cerveza (BSG)'),
    { material: 'Bagazo de cerveza (BSG)', kg_recibido: 125, kg_ensilado: 40, kg_disponible: 85 });
  assert.equal(s.porMaterial.get('Desecho de fruta').kg_disponible, 0);
  assert.equal(s.porRecepcion.get('r1').kg_disponible, 60);
  assert.equal(s.porRecepcion.get('r3').kg_disponible, 25);
});
