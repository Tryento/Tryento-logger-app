/**
 * "Para hoy", from a picture of the lab: late first, then today, then the next
 * two days; the cajas of one incubadora on one line; nothing that is blocked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { construirVista } from '../src/data/vista.js';
import { paraHoy } from '../src/data/monitor.js';
import { mergeProtocolo } from '../src/data/protocolo.js';

const cfg = mergeProtocolo([]);
const T = s => new Date(s).toISOString();

/** Tuesday 20 Oct 2026, 11:00 at the farm. */
const HOY = '2026-10-20', AHORA = Date.parse('2026-10-20T15:00:00Z');

function lab() {
  return {
    rack: [{ id: 'r1', codigo: 'R1' }],
    jaula: [
      { id: 'jA', nombre: 'ICA', letra: 'A', lugar: 'Galpón', generacion_inicial: 7, fase_inicial: 'activa' },
      { id: 'jB', nombre: 'ICB', letra: 'B', lugar: 'Galpón', generacion_inicial: 6, fase_inicial: 'limpia' }
    ],
    incubadora: [
      // Día 14 today: distributed on día 7 into two cajas.
      { id: 'i1', codigo: 'F7A-1', jaula_id: 'jA', generacion: 7, recolecta_at: T('2026-10-06T13:00:00Z'),
        rack_id: 'r1', peso_inicial_g: 12, alimento_inicial_kg: 2, created_at: T('2026-10-06T13:00:00Z') },
      // Día 3 today.
      { id: 'i2', codigo: 'F7A-2', jaula_id: 'jA', generacion: 7, recolecta_at: T('2026-10-17T13:00:00Z'),
        rack_id: 'r1', peso_inicial_g: 12, alimento_inicial_kg: 2, created_at: T('2026-10-17T13:00:00Z') }
    ],
    distribucion: [{ id: 'd1', incubadora_id: 'i1', fecha: T('2026-10-13T13:00:00Z'), peso_total_kg: 2.7 }],
    caja: [1, 2, 3].map(n => ({ id: `c${n}`, codigo: `F7A-1-0${n}`, incubadora_id: 'i1', numero: n, rack_id: 'r1',
                                peso_inicial_kg: 0.9, created_at: T('2026-10-13T13:00:00Z') })),
    alimentacion: [1, 2, 3].map(n => ({ id: `a${n}`, caja_id: `c${n}`, carga: 1, fecha: T('2026-10-13T13:00:00Z'), kg: 1.5 })),
    // Caja 1 had its día-10 chequeo and carga 2; cajas 2 and 3 did not.
    chequeo: [{ id: 'k1', caja_id: 'c1', dia: 10, fecha: T('2026-10-16T13:00:00Z'), humedad_pct: 60,
                temperatura_c: 30, peso_kg: 2, created_at: T('2026-10-16T13:00:00Z') }],
    separacion: [],
    ensilado: [{ id: 'e1', codigo: 'S2-2909', contenedor_id: 'x', ensilado_at: T('2026-09-29T15:00:00Z') }],
    ensilado_insumo: [{ id: 'n1', ensilado_id: 'e1', recepcion_id: 'rc', kg: 50 }],
    recepcion: [{ id: 'rc', material: 'Desecho de fruta', kg: 50, fecha: T('2026-09-29T12:00:00Z') }]
  };
}

test('late first, then today, then the next two days, each opening its form', () => {
  const s = lab();
  s.alimentacion.push({ id: 'a1b', caja_id: 'c1', carga: 2, fecha: T('2026-10-16T14:00:00Z'), kg: 2 });
  const v = construirVista(s, cfg, { hoy: HOY, ahora: AHORA });
  const { items, resumen } = paraHoy(v);
  const lineas = items.map(i => `${i.estado}|${i.titulo}|${i.detalle}`);

  assert.deepEqual(lineas, [
    // Late: the día-10 chequeo of cajas 2 and 3 (carga 2 waits for it, so it is not listed).
    'atrasado|Chequeo día 10 · F7A-1|2 cajas: 02, 03',
    // Carga 3 (día 13) of all three, a day late.
    'atrasado|Carga 3 · 2 kg · F7A-1|3 cajas: 01, 02, 03',
    'hoy|Abrir el ensilado · S2-2909|50 kg · día 21 de maduración',
    'hoy|Chequeo día 14 (inicia el ayuno) · F7A-1|3 cajas: 01, 02, 03',
    'hoy|Chequeo día 3 · F7A-2|Día 3 · rack R1',
    'proximo|Recolecta · ICA|F7 · Galpón',
    'proximo|Separación · F7A-1|3 cajas: 01, 02, 03'
  ]);
  assert.deepEqual(resumen, { atrasado: 2, hoy: 3, proximo: 2 });

  const chequeo = items.find(i => i.titulo.startsWith('Chequeo día 10'));
  assert.deepEqual(chequeo.accion, { tipo: 'chequeo', caja_ids: ['c2', 'c3'], dia: 10, carga: null });
  assert.equal(chequeo.cuando, 'atrasado 4 días');
  // ICB is clean, but there is no 2 % waiting: nothing to repopulate with.
  assert.ok(!items.some(i => i.titulo.includes('ICB')));
});

test('the 98 % waiting, the 2 % with a clean cage, an open ensilado, records to review', () => {
  const s = lab();
  s.separacion = [{ id: 's1', caja_id: 'c1', fecha: T('2026-10-20T13:00:00Z'), peso_total_kg: 10, pct_coccion: 98,
                    created_at: T('2026-10-20T13:00:00Z') }];
  s.ensilado[0].abierto_at = T('2026-10-20T12:00:00Z');
  s.cochada_origen = [{ id: 'o1', cochada_id: 'h1', separacion_id: 's1', kg: 12 }];   // more than 9.8
  s.cochada = [{ id: 'h1', codigo: 'H-2010-1', horno_at: T('2026-10-20T14:00:00Z'), peso_inicial_kg: 12 }];
  const v = construirVista(s, cfg, { hoy: HOY, ahora: AHORA });
  const titulos = paraHoy(v).items.map(i => i.titulo);

  assert.ok(titulos.includes('Repoblar con el 2 % · ICB'), 'a clean cage, and 0,2 kg waiting');
  assert.ok(!titulos.some(t => t.startsWith('98 %')), 'the cochada took more than the 98 %: nothing waits');
  assert.ok(titulos.includes('Consumir el ensilado abierto · S2-2909'));
  assert.ok(titulos.includes('Temperatura a mitad del horno · H-2010-1'));
  assert.ok(titulos.includes('1 registro para revisar'));
});

test('nothing further than two days ahead', () => {
  const s = lab();
  s.incubadora = [s.incubadora[1]];        // only the día-3 one
  s.caja = []; s.alimentacion = []; s.chequeo = []; s.distribucion = [];
  s.chequeo.push({ id: 'k3', incubadora_id: 'i2', dia: 3, fecha: T('2026-10-20T13:00:00Z'), humedad_pct: 60,
                   temperatura_c: 29, peso_g: 40, created_at: T('2026-10-20T13:00:00Z') });
  const v = construirVista(s, cfg, { hoy: HOY, ahora: AHORA });
  const titulos = paraHoy(v).items.map(i => i.titulo);
  assert.ok(!titulos.some(t => t.startsWith('Tamizado')), 'the distribución is 4 days away');
});
