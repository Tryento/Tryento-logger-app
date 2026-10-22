/**
 * The lab in numbers, from one picture of it: what there is now, the last
 * weeks on the farm's calendar, and how a period went — a larvae cycle counts
 * in the period it ended, early closures included.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirVista } from '../src/data/vista.js';
import { resumenLab } from '../src/data/resumen.js';
import { mergeProtocolo } from '../src/data/protocolo.js';

const cfg = mergeProtocolo([]);
const T = s => new Date(s).toISOString();
/** A farm day at 09:00 at the farm (13:00 UTC), or at another UTC hour. */
const d = (dia, hora = '13:00') => T(`${dia}T${hora}:00Z`);

/** Thursday 22 Oct 2026, 11:00 at the farm. */
const HOY = '2026-10-22', AHORA = Date.parse('2026-10-22T15:00:00Z');

const inc = (id, codigo, jaula_id, generacion, dia, g, extra = {}) => ({
  id, codigo, jaula_id, generacion, recolecta_at: d(dia), dia0: dia, rack_id: 'r1',
  peso_inicial_g: g, alimento_inicial_kg: 2, created_at: d(dia), ...extra
});
const caja = (id, codigo, incubadora_id, numero, dia, kg) => ({
  id, codigo, incubadora_id, numero, rack_id: 'r1', peso_inicial_kg: kg, created_at: d(dia)
});
/** Cargas 1, 2 and 3 of a caja: 1,5 · 2 · 2 kg. */
const cargas = (caja_id, dias) => dias.map((dia, k) => ({
  id: `${caja_id}-a${k + 1}`, caja_id, carga: k + 1, fecha: d(dia), kg: [1.5, 2, 2][k], created_at: d(dia)
}));
const sep = (id, caja_id, fecha, kg) => ({ id, caja_id, fecha, peso_total_kg: kg, pct_coccion: 98, created_at: fecha });

function lab() {
  return {
    rack: [{ id: 'r1', codigo: 'R1' }],
    contenedor: [{ id: 'x1', codigo: 'S1' }, { id: 'x2', codigo: 'S2' }],
    jaula: [
      // ICA was clean when registered; the app saw its cycle begin and end.
      { id: 'jA', nombre: 'ICA', letra: 'A', lugar: 'Galpón', generacion_inicial: 7, fase_inicial: 'limpia', created_at: d('2026-09-01') },
      // ICB already had flies.
      { id: 'jB', nombre: 'ICB', letra: 'B', lugar: 'Galpón', generacion_inicial: 7, fase_inicial: 'activa', created_at: d('2026-09-01') }
    ],
    ingreso: [
      { id: 'g1', jaula_id: 'jA', fecha: d('2026-09-21', '15:00'), kg_larvas: 1.2, generacion: 8, created_at: d('2026-09-21', '15:00') },
      { id: 'g2', jaula_id: 'jA', fecha: d('2026-10-16', '15:00'), kg_larvas: 1, generacion: 8, created_at: d('2026-10-16', '15:00') }
    ],
    bandeja_pupacion: [
      { id: 'b1', ingreso_id: 'g1', jaula_id: 'jA', rack_id: 'r1', numero: 1, codigo: 'F7-B2109-1', peso_kg: 4.7 },
      { id: 'b2', ingreso_id: 'g2', jaula_id: 'jA', rack_id: 'r1', numero: 1, codigo: 'F7-B1610-1', peso_kg: 4.7 }
    ],
    jaula_evento: [
      { id: 'v1', jaula_id: 'jA', tipo: 'cierre', fecha: d('2026-10-06', '20:00'), created_at: d('2026-10-06', '20:00') },
      { id: 'v2', jaula_id: 'jA', tipo: 'limpieza', fecha: d('2026-10-07', '20:00'), created_at: d('2026-10-07', '20:00') }
    ],
    incubadora: [
      inc('i7', 'F7B-0', 'jB', 7, '2026-09-10', 5, { cerrado_at: d('2026-09-12'), motivo_cierre: 'Hongos' }),
      inc('i1', 'F7B-1', 'jB', 7, '2026-09-23', 10),
      inc('i2', 'F8A-1', 'jA', 8, '2026-09-25', 8),
      inc('i6', 'F8A-2', 'jA', 8, '2026-10-01', 10),
      inc('i3', 'F7B-2', 'jB', 7, '2026-10-02', 12, { cerrado_at: d('2026-10-04'), motivo_cierre: 'Contaminada' }),
      inc('i4', 'F7B-3', 'jB', 7, '2026-10-19', 9),
      inc('i5', 'F7B-4', 'jB', 7, '2026-10-21', 11)
    ],
    distribucion: [
      { id: 'd1', incubadora_id: 'i1', fecha: d('2026-09-30'), peso_total_kg: 3, created_at: d('2026-09-30') },
      { id: 'd2', incubadora_id: 'i2', fecha: d('2026-10-03'), peso_total_kg: 2.5, created_at: d('2026-10-03') },
      { id: 'd6', incubadora_id: 'i6', fecha: d('2026-10-08'), peso_total_kg: 3.2, created_at: d('2026-10-08') }
    ],
    caja: [
      caja('c11', 'F7B-1-01', 'i1', 1, '2026-09-30', 1.5), caja('c12', 'F7B-1-02', 'i1', 2, '2026-09-30', 1.5),
      caja('c21', 'F8A-1-01', 'i2', 1, '2026-10-03', 2.5), caja('c61', 'F8A-2-01', 'i6', 1, '2026-10-08', 3.2)
    ],
    alimentacion: [
      ...cargas('c11', ['2026-09-30', '2026-10-03', '2026-10-06']),
      ...cargas('c12', ['2026-09-30', '2026-10-03', '2026-10-06']),
      ...cargas('c21', ['2026-10-03', '2026-10-05', '2026-10-08']),
      ...cargas('c61', ['2026-10-08', '2026-10-11', '2026-10-14'])
    ],
    separacion: [
      sep('s11', 'c11', d('2026-10-09'), 12), sep('s12', 'c12', d('2026-10-10'), 10), sep('s21', 'c21', d('2026-10-12'), 9),
      // Sunday 18 Oct at 23:30 on the farm: already Monday in UTC.
      sep('s61', 'c61', T('2026-10-19T03:30:00Z'), 11.5)
    ],
    chequeo: [
      { id: 'k1', caja_id: 'c61', dia: 10, fecha: d('2026-10-11'), humedad_pct: 60, temperatura_c: 28, peso_kg: 4, created_at: d('2026-10-11') },
      { id: 'k2', caja_id: 'c61', dia: 14, fecha: d('2026-10-15'), humedad_pct: 64, temperatura_c: 30, peso_kg: 9, created_at: d('2026-10-15') },
      { id: 'k3', incubadora_id: 'i4', dia: 3, fecha: d('2026-10-22'), humedad_pct: 70, temperatura_c: 27, peso_g: 30, created_at: d('2026-10-22') }
    ],
    cochada: [
      { id: 'h1', codigo: 'H-1010-1', horno_at: d('2026-10-10', '14:00'), peso_inicial_kg: 21, created_at: d('2026-10-10', '14:00') },
      { id: 'h2', codigo: 'H-1810-1', horno_at: d('2026-10-18', '14:00'), peso_inicial_kg: 8.8, created_at: d('2026-10-18', '14:00') },
      { id: 'h3', codigo: 'H-2110-1', horno_at: d('2026-10-21', '14:00'), peso_inicial_kg: 11.27, created_at: d('2026-10-21', '14:00') }
    ],
    cochada_origen: [
      { id: 'o1', cochada_id: 'h1', separacion_id: 's11', kg: 11.76, created_at: d('2026-10-10', '14:00') },
      { id: 'o2', cochada_id: 'h1', separacion_id: 's12', kg: 9.24, created_at: d('2026-10-10', '14:00') },
      { id: 'o3', cochada_id: 'h2', separacion_id: 's21', kg: 8.8, created_at: d('2026-10-18', '14:00') },
      { id: 'o4', cochada_id: 'h3', separacion_id: 's61', kg: 11.27, created_at: d('2026-10-21', '14:00') }
    ],
    cochada_lectura: [
      { id: 'l1', cochada_id: 'h1', momento: 'media', fecha: d('2026-10-10', '16:00'), temperatura_c: 80 },
      { id: 'l2', cochada_id: 'h1', momento: 'final', fecha: d('2026-10-10', '20:00'), temperatura_c: 90, peso_kg: 6.3 },
      { id: 'l3', cochada_id: 'h2', momento: 'media', fecha: d('2026-10-18', '16:00'), temperatura_c: 84 },
      { id: 'l4', cochada_id: 'h2', momento: 'final', fecha: d('2026-10-18', '20:00'), temperatura_c: 94, peso_kg: 3.08 }
    ],
    recepcion: [
      { id: 'rc1', material: 'Bagazo de cerveza (BSG)', kg: 100, fecha: d('2026-09-20') },
      { id: 'rc2', material: 'Desecho de panadería', kg: 60, fecha: d('2026-10-01') },
      { id: 'rc3', material: 'Bagazo de cerveza (BSG)', kg: 40, fecha: d('2026-10-20') }
    ],
    ensilado: [
      // Open 12–15 Oct: only carga 3 of F8A-2-01 ate from it.
      { id: 'e1', codigo: 'S1-2109', contenedor_id: 'x1', ensilado_at: d('2026-09-21', '15:00'), dia0: '2026-09-21',
        abierto_at: d('2026-10-12', '12:00') },
      // Open since the 20th: the recolecta F7B-4 ate from it.
      { id: 'e2', codigo: 'S2-2809', contenedor_id: 'x2', ensilado_at: d('2026-09-28', '15:00'), dia0: '2026-09-28',
        abierto_at: d('2026-10-20', '12:00') }
    ],
    ensilado_insumo: [
      { id: 'n1', ensilado_id: 'e1', recepcion_id: 'rc1', kg: 40 },
      { id: 'n2', ensilado_id: 'e2', recepcion_id: 'rc2', kg: 50 }
    ]
  };
}

const vista = (s = lab()) => construirVista(s, cfg, { hoy: HOY, ahora: AHORA });

test('now: cages, larvae, the oven, the 2 % and the 98 %, food, what is late', () => {
  const { ahora } = resumenLab(vista());
  assert.deepEqual(ahora.jaulas, { total: 2, con_moscas: 2, cerradas: 0, limpias: 0,
                                   generaciones: [{ generacion: 7, n: 1 }, { generacion: 8, n: 1 }] });
  assert.deepEqual(ahora.incubadoras, { activas: 2, dias: { min: 1, max: 3 } });
  assert.deepEqual(ahora.cajas, { activas: 0, en_ayuno: 0, dias: null });
  assert.equal(ahora.cochadas_en_horno, 1);
  // 0,56 kg of F7B-1-02's 98 % and 0,02 kg of F8A-1-01's never went in.
  assert.equal(ahora.horno_kg, 0.58);
  // The repopulation of the 16th took the 2 % of the three cajas separated by then.
  assert.equal(ahora.pool_kg, 0.23);
  assert.deepEqual(ahora.ensilado, { abiertos: 1, kg_restante: 48, vence_at: '2026-10-23T12:00:00.000Z',
                                     madurando: 0, proxima_apertura: null });
  assert.equal(ahora.bodega_kg, 110);
  assert.equal(ahora.revisar, 0);
  assert.equal(ahora.atrasados, 1, "H-2110-1's mid reading was due yesterday");
});

test('the last eight weeks run Monday to Sunday on the farm clock', () => {
  const { semanas } = resumenLab(vista());
  assert.equal(semanas.length, 8);
  assert.deepEqual(semanas.map(s => s.desde), ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21',
                                               '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
  assert.deepEqual(semanas.map(s => [s.recolectas, s.recolectado_g]),
                   [[0, 0], [1, 5], [0, 0], [2, 18], [2, 22], [0, 0], [0, 0], [2, 20]]);
  // The Sunday-night separación belongs to the week of the 12th, not the 19th.
  assert.deepEqual(semanas.map(s => [s.separaciones, s.separado_kg]),
                   [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [2, 22], [2, 20.5], [0, 0]]);
  assert.deepEqual(semanas.map(s => s.en_curso), [false, false, false, false, false, false, false, true]);
});

test('30 days: the larvae cycles that ended in it, early closures included', () => {
  const { periodo: p } = resumenLab(vista(), { periodo: '30' });
  assert.equal(p.desde, '2026-09-23');
  assert.deepEqual(p.larvas, {
    n: 4,                                   // F7B-1, F8A-1, F8A-2 and F7B-2 (closed in the incubadora)
    cerradas: { incubadoras: 1, cajas: 0 },
    g_inicial: 40, kg_tamizado: 8.7, kg_separado: 42.5, kg_alimento: 30,
    kg_por_g: 1.06,                         // 42,5 kg ÷ 40 g
    multiplicacion: 4.89,                   // 42,5 kg ÷ 8,7 kg
    fcr: 0.71,                              // 30 kg of food ÷ 42,5 kg
    dia_distribucion: 7.3,                  // días 7, 8, 7
    dia_separacion: 16.8,                   // días 16, 17, 17, 17
    plan: { distribucion: 7, separacion: 16 }
  });
  assert.deepEqual(p.separaciones, { n: 4, kg: 42.5, coccion_kg: 41.65, retorno_kg: 0.85 });
  assert.deepEqual(p.chequeos, { n: 3, humedad: { prom: 64.7, min: 60, max: 70 }, temperatura: { prom: 28.3, min: 27, max: 30 } });
  assert.deepEqual(p.cierres, { n: 1, incubadoras: 1, cajas: 0, cochadas: 0, bandejas: 0 });
});

test('30 days: recolectas per cage, the cage cycle that closed, repopulations', () => {
  const { periodo: p } = resumenLab(vista(), { periodo: '30' });
  assert.equal(p.recolectas.n, 6);
  assert.equal(p.recolectas.g, 60);
  assert.equal(p.recolectas.g_prom, 10);
  assert.deepEqual(p.recolectas.por_jaula.map(j => [j.nombre, j.recolectas, j.g, j.g_prom]),
                   [['ICB', 4, 42, 10.5], ['ICA', 2, 18, 9]]);
  // ICA: repopulated on 21 Sep, closed on 6 Oct, two recolectas in between.
  assert.deepEqual(p.ciclos_jaula, {
    n: 1, dias_prom: 15, recolectas_prom: 2, g_prom: 18,
    lista: [{ jaula_id: 'jA', nombre: 'ICA', generacion: 8, dias: 15, recolectas: 2, g: 18 }]
  });
  assert.deepEqual(p.repoblados, { n: 1, kg_larvas: 1, bandejas: 1 });
});

test('30 days: the oven and the food', () => {
  const { periodo: p } = resumenLab(vista(), { periodo: '30' });
  assert.deepEqual(p.horno, {
    al_horno: { n: 3, kg: 41.07 },
    terminadas: { n: 2, kg_entrada: 29.8, kg_salida: 9.38, rendimiento_pct: 31, rango_pct: { min: 30, max: 35 },
                  temp_media: 82, temp_final: 92 }
  });
  assert.deepEqual(p.alimento, {
    dado_kg: 34,                            // 6 recolectas × 2 kg + 22 kg of cargas
    sin_ensilado_kg: 30, sin_ensilado_n: 16,  // only carga 3 of F8A-2-01 and F7B-4 found an open ensilado
    recibido: { kg: 100, por_material: [{ material: 'Desecho de panadería', kg: 60 }, { material: 'Bagazo de cerveza (BSG)', kg: 40 }] },
    ensilados_hechos: { n: 1, kg: 50 },
    ensilados_terminados: { n: 1, kg: 40, consumido_kg: 2, descartado_kg: 38, consumido_pct: 5 }
  });
});

test('7 days and everything', () => {
  const siete = resumenLab(vista(), { periodo: '7' }).periodo;
  assert.equal(siete.desde, '2026-10-16');
  assert.deepEqual([siete.recolectas.n, siete.recolectas.g], [2, 20]);
  assert.equal(siete.ciclos_jaula.n, 0);
  assert.equal(siete.ciclos_jaula.dias_prom, null);
  assert.deepEqual(siete.repoblados, { n: 1, kg_larvas: 1, bandejas: 1 });
  assert.deepEqual([siete.larvas.n, siete.larvas.kg_por_g, siete.larvas.multiplicacion, siete.larvas.fcr,
                    siete.larvas.dia_distribucion, siete.larvas.dia_separacion], [1, 1.15, 3.59, 0.65, 7, 17]);
  assert.deepEqual(siete.separaciones, { n: 1, kg: 11.5, coccion_kg: 11.27, retorno_kg: 0.23 });
  assert.deepEqual(siete.horno.terminadas.rango_pct, { min: 35, max: 35 });
  assert.deepEqual([siete.alimento.dado_kg, siete.alimento.sin_ensilado_kg], [4, 2]);
  assert.equal(siete.alimento.ensilados_terminados.consumido_pct, null);

  const todo = resumenLab(vista(), { periodo: 'todo' }).periodo;
  assert.equal(todo.desde, null);
  assert.deepEqual([todo.recolectas.n, todo.recolectas.g], [7, 65]);
  assert.deepEqual([todo.larvas.n, todo.larvas.cerradas.incubadoras, todo.larvas.kg_por_g], [5, 2, 0.94]);
  assert.deepEqual(todo.repoblados, { n: 2, kg_larvas: 2.2, bandejas: 2 });

  assert.equal(resumenLab(vista(), { periodo: 'no-existe' }).periodo.clave, '30');
});

test('a deleted record counts nowhere, and an empty lab is all zeros', () => {
  const s = lab();
  s.separacion = s.separacion.map(x => (x.id === 's61' ? { ...x, deleted_at: d('2026-10-20') } : x));
  const p = resumenLab(vista(s), { periodo: '7' }).periodo;
  assert.equal(p.separaciones.n, 0);
  assert.equal(p.larvas.n, 0, 'F8A-2 has a caja still in engorde');

  const vacio = resumenLab(construirVista({}, cfg, { hoy: HOY, ahora: AHORA }));
  assert.equal(vacio.ahora.jaulas.total, 0);
  assert.equal(vacio.ahora.atrasados, 0);
  assert.ok(vacio.semanas.every(x => x.recolectas === 0 && x.separaciones === 0));
  assert.deepEqual([vacio.periodo.larvas.n, vacio.periodo.larvas.kg_por_g, vacio.periodo.larvas.fcr], [0, null, null]);
  assert.equal(vacio.periodo.horno.terminadas.rendimiento_pct, null);
});
