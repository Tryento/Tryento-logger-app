/**
 * "Revisar": what a correction leaves to check. Computed values just move;
 * what a person recorded or confirmed on top of the corrected record is
 * flagged until someone reviews it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revisiones, generacionDeJaula, visto } from '../src/data/revisar.js';
import { pool2 } from '../src/data/pool.js';
import { mergeProtocolo } from '../src/data/protocolo.js';

const cfg = mergeProtocolo([]);
const T = s => new Date(s).toISOString();
const flags = (r, k) => r.get(k) || [];

const jaulas = [{ id: 'j', nombre: 'ICA', generacion_inicial: 7 }];
const incubadoras = [{ id: 'i', codigo: 'F7A-1', jaula_id: 'j', generacion: 7, recolecta_at: T('2026-10-01T13:00:00Z'),
                       dia0: '2026-10-01', created_at: T('2026-10-01T13:00:00Z') }];
const cajas = [{ id: 'c', codigo: 'F7A-1-01', incubadora_id: 'i' }];
const sep = { id: 's', caja_id: 'c', fecha: T('2026-10-17T13:00:00Z'), peso_total_kg: 10, pct_coccion: 98,
              created_at: T('2026-10-17T13:00:00Z') };

test('a corrected separación flags the cochada that took its 98 %, until reviewed', () => {
  const origen = { id: 'o', separacion_id: 's', kg: 9, created_at: T('2026-10-18T10:00:00Z') };
  const base = { incubadoras, cajas, jaulas, origenes: [origen] };
  assert.equal(revisiones({ ...base, separaciones: [sep] }, cfg).size, 0);

  const corregida = { ...sep, peso_total_kg: 9.5, valores_editados_at: T('2026-10-19T10:00:00Z') };
  const r = revisiones({ ...base, separaciones: [corregida] }, cfg);
  assert.deepEqual(flags(r, 'cochada_origen:o'), ['Se corrigió la separación de la caja F7A-1-01.']);

  const revisado = { ...origen, revisado_at: T('2026-10-19T11:00:00Z') };
  assert.equal(revisiones({ ...base, origenes: [revisado], separaciones: [corregida] }, cfg).size, 0);

  // A note is not a value: nothing to check.
  const conNota = { ...sep, nota: 'húmeda', editado_at: T('2026-10-19T10:00:00Z') };
  assert.equal(revisiones({ ...base, separaciones: [conNota] }, cfg).size, 0);
});

test('a 98 % given out beyond what it has stays flagged until fixed', () => {
  const origenes = [{ id: 'o1', separacion_id: 's', kg: 6, created_at: '1' },
                    { id: 'o2', separacion_id: 's', kg: 6, created_at: '2', revisado_at: T('2030-01-01T00:00:00Z') }];
  const r = revisiones({ incubadoras, cajas, jaulas, separaciones: [sep], origenes }, cfg);
  assert.match(flags(r, 'cochada_origen:o2')[0], /\(9\.8 kg\) se le tomaron 12 kg/);
  assert.ok(flags(r, 'cochada_origen:o1').length);
});

test('ingresos: an earlier separación arriving late, or an earlier ingreso corrected', () => {
  const ing1 = { id: 'g1', jaula_id: 'j', fecha: T('2026-10-18T15:00:00Z'), kg_larvas: 0.1, generacion: 8,
                 created_at: T('2026-10-18T15:00:00Z') };
  const ing2 = { id: 'g2', jaula_id: 'k', fecha: T('2026-10-20T15:00:00Z'), kg_larvas: 0.1, generacion: 8,
                 created_at: T('2026-10-20T15:00:00Z') };
  const d = { incubadoras, cajas, jaulas, separaciones: [sep], ingresos: [ing1, ing2] };
  const pool = pool2(d, cfg);
  assert.equal(revisiones(d, cfg, pool).size, 0);

  // A separación dated the 16th that synced on the 21st: it changes what both drew.
  const tarde = { ...sep, id: 's0', fecha: T('2026-10-16T13:00:00Z'), created_at: T('2026-10-21T08:00:00Z') };
  const d2 = { ...d, separaciones: [sep, tarde] };
  const r2 = revisiones(d2, cfg, pool2(d2, cfg));
  assert.ok(flags(r2, 'ingreso:g1').some(m => /separación anterior/.test(m)));
  assert.ok(flags(r2, 'ingreso:g2').some(m => /separación anterior/.test(m)));

  // The first ingreso corrected: the second drew after it.
  const d3 = { ...d, ingresos: [{ ...ing1, kg_larvas: 0.15, valores_editados_at: T('2026-10-22T08:00:00Z') }, ing2] };
  const r3 = revisiones(d3, cfg, pool2(d3, cfg));
  assert.deepEqual(flags(r3, 'ingreso:g2'), ['Cambió un ingreso anterior: revisa las larvas que tomó.']);
  assert.equal(flags(r3, 'ingreso:g1').length, 0);
});

test('an ingreso whose larvae no longer match the generation it gave the cage', () => {
  const ing = { id: 'g', jaula_id: 'j', fecha: T('2026-10-18T15:00:00Z'), kg_larvas: 0.1, generacion: 9,
                created_at: T('2026-10-18T15:00:00Z') };
  const d = { incubadoras, cajas, jaulas, separaciones: [sep], ingresos: [ing] };
  assert.deepEqual(flags(revisiones(d, cfg, pool2(d, cfg)), 'ingreso:g'),
                   ['Sus larvas son F7: la jaula sería F8, no F9.']);
});

test('a corrected incubadora flags its chequeos; the cage generation must match', () => {
  const chequeo = { id: 'k', incubadora_id: 'i', dia: 3, created_at: T('2026-10-04T13:00:00Z') };
  const editada = { ...incubadoras[0], recolecta_at: T('2026-09-30T13:00:00Z'), valores_editados_at: T('2026-10-05T09:00:00Z') };
  const r = revisiones({ jaulas, incubadoras: [editada], chequeos: [chequeo] }, cfg);
  assert.deepEqual(flags(r, 'chequeo:k'), ['Se corrigió la incubadora F7A-1.']);

  // The cage was registered as F6 after all: its first-cycle incubadora says F7.
  const r2 = revisiones({ jaulas: [{ ...jaulas[0], generacion_inicial: 6 }], incubadoras }, cfg);
  assert.deepEqual(flags(r2, 'incubadora:i'), ['Su jaula era F6 en esa recolecta; esta incubadora dice F7.']);
  assert.equal(generacionDeJaula('j', T('2026-10-01T13:00:00Z'), {
    jaulas, ingresos: [{ jaula_id: 'j', fecha: T('2026-09-20T13:00:00Z'), generacion: 9 }] }), 9);
});

test('raw material: a corrected or over-drawn recepción flags the ensilado', () => {
  const recepciones = [{ id: 'r', material: 'Desecho de fruta', kg: 50, created_at: '1' }];
  const ensilados = [{ id: 'e', codigo: 'S2-2810', created_at: T('2026-10-28T15:00:00Z') }];
  const insumos = [{ id: 'n', ensilado_id: 'e', recepcion_id: 'r', kg: 40 }];
  assert.equal(revisiones({ recepciones, ensilados, insumos }, cfg).size, 0);
  const corregida = [{ ...recepciones[0], kg: 30, valores_editados_at: T('2026-10-29T08:00:00Z') }];
  assert.deepEqual(flags(revisiones({ recepciones: corregida, ensilados, insumos }, cfg), 'ensilado:e'), [
    'Se corrigió la recepción de Desecho de fruta.',
    'De la recepción de Desecho de fruta (30 kg) se ensilaron 40 kg.'
  ]);
});

test('"visto" is the latest of made, corrected and reviewed', () => {
  assert.equal(visto({ created_at: 'b', valores_editados_at: 'c', revisado_at: 'a' }), 'c');
  assert.equal(visto({ created_at: 'b' }), 'b');
});
