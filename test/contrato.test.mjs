/**
 * Does what the phone believes match what the database has?
 *
 * The failures this guards against are silent until the day they happen: a
 * correction the phone offers that app.editar refuses, a store the pull asks
 * for that has no table, a GENERATED column sent on insert (Postgres rejects
 * the whole row). Read straight from the SQL a fresh install runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupFiles } from '../tools/migrations.mjs';
import { EDITABLE, SIEMPRE } from '../src/data/registros.js';
import { SYNCED_STORES } from '../src/data/idb/schema.js';
import { toWire } from '../src/data/sync/push.js';

const sql = (await setupFiles()).map(f => f.body).join('\n');

/** The body of a plpgsql function, by name. */
function funcion(nombre) {
  const m = new RegExp(`create or replace function app\\.${nombre}\\(([\\s\\S]*?)\\$\\$;`, 'i').exec(sql);
  assert.ok(m, `no encuentro app.${nombre}`);
  return m[1];
}

/** CREATE TABLE app.x ( … ) bodies. */
function tablas() {
  const out = new Map();
  const re = /create table if not exists app\.(\w+)\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = re.exec(sql))) out.set(m[1], m[2]);
  return out;
}

test('every correction the phone offers, app.editar accepts — and nothing more', () => {
  const cuerpo = funcion('editar');
  const servidor = {};
  for (const m of cuerpo.matchAll(/when '(\w+)'\s+then array\[([^\]]*)\]/g)) {
    servidor[m[1]] = [...m[2].matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
  }
  const telefono = {};
  for (const [tabla, def] of Object.entries(EDITABLE)) {
    telefono[tabla] = [...def.campos.map(c => c[0]), ...SIEMPRE].sort();
  }
  assert.deepEqual(telefono, servidor);
});

test('"Revisado" is offered on exactly the records app.marcar_revisado takes', () => {
  const cuerpo = funcion('marcar_revisado');
  const lista = /p_tabla not in \(([\s\S]*?)\)/.exec(cuerpo)[1];
  const servidor = [...lista.matchAll(/'(\w+)'/g)].map(x => x[1]).sort();
  const telefono = Object.keys(EDITABLE).filter(t => !['rack', 'contenedor'].includes(t)).sort();
  assert.deepEqual(telefono, servidor);
});

test('every synced store has its table, and every table its store', () => {
  const t = [...tablas().keys()].sort();
  assert.deepEqual([...SYNCED_STORES].sort(), t);
});

test('generated and server-kept columns never leave the phone', () => {
  const vistas = [];
  for (const [tabla, cuerpo] of tablas()) {
    const generadas = [...cuerpo.matchAll(/^\s*(\w+)\s+[^\n]*generated always/gim)].map(m => m[1]);
    const fila = Object.fromEntries(generadas.map(c => [c, 1]));
    for (const c of generadas) {
      vistas.push(`${tabla}.${c}`);
      assert.ok(!(c in toWire(tabla, { id: 'x', ...fila })), `${tabla}.${c} es GENERATED: no se puede enviar`);
    }
  }
  // Or the check above passes by finding nothing.
  assert.deepEqual(vistas.sort(), ['jaula.estado', 'separacion.coccion_kg', 'separacion.retorno_kg']);
  // Kept by the server's triggers from the cage's registries.
  assert.deepEqual(Object.keys(toWire('jaula', { id: 'x', fase: 'activa', generacion: 8, ciclo_desde: 'd', nombre: 'ICA' })),
                   ['id', 'nombre']);
  // …but `generacion` is a real column of incubadora and ingreso.
  assert.ok('generacion' in toWire('incubadora', { generacion: 8 }));
  assert.ok('generacion' in toWire('ingreso', { generacion: 8 }));
});
