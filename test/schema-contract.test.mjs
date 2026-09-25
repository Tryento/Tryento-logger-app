/**
 * Does what the app SENDS match what the database HAS?
 *
 * This is the failure that breaks storage on day one and is invisible until it
 * happens: the app posts a column the table does not have, or posts a
 * GENERATED ALWAYS column, and PostgREST rejects every single write with a 400.
 * Nothing in the UI would look wrong — records just stop arriving.
 *
 * So: parse the real CREATE TABLE statements out of the migration, drive the
 * real write path, and assert that every payload the outbox is about to send
 * would be accepted. No database required, so it runs on every commit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshDb } from './helpers/env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── parse the schema ────────────────────────────────────────────────────── */

/**
 * Strip SQL comments, leaving string literals alone.
 *
 * Required, not cosmetic: several column comments contain commas
 * (`-- 'ICA-0326', human-facing`), and a naive split on commas would cut a
 * column definition in half and lose the NEXT column entirely — which reads as
 * "the app sends a column the table does not have" and would send you hunting
 * a bug that is not there.
 */
export function stripComments(sql) {
  let out = '', i = 0, inStr = false, inLine = false, inBlock = false;
  while (i < sql.length) {
    const c = sql[i], n = sql[i + 1];
    if (inLine) { if (c === '\n') { inLine = false; out += c; } i++; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; } else i++; continue; }
    if (inStr) {
      out += c;
      if (c === "'") { if (n === "'") { out += n; i += 2; continue; } inStr = false; }
      i++; continue;
    }
    if (c === "'") { inStr = true; out += c; i++; continue; }
    if (c === '-' && n === '-') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** Split a CREATE TABLE body on commas at paren depth 0, ignoring strings. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0, cur = '', inStr = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) { cur += ch; if (ch === "'") inStr = false; continue; }
    if (ch === "'") { inStr = true; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

const NOT_A_COLUMN = /^\s*(check|unique|primary\s+key|foreign\s+key|constraint|exclude)\b/i;

export function parseSchema(rawSql) {
  const sql = stripComments(rawSql);
  const tables = new Map();
  const re = /create\s+table\s+app\.(\w+)\s*\(/gi;
  let m;
  while ((m = re.exec(sql))) {
    const name = m[1];
    // Walk from the opening paren to its match, respecting nesting.
    let i = re.lastIndex, depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    const body = sql.slice(re.lastIndex, i - 1);

    const columns = new Set();
    const generated = new Set();
    for (const part of splitTopLevel(body)) {
      const t = part.trim();
      if (!t || NOT_A_COLUMN.test(t)) continue;
      const col = (/^["']?(\w+)["']?/.exec(t) || [])[1];
      if (!col) continue;
      columns.add(col);
      if (/generated\s+always/i.test(t)) generated.add(col);
    }
    tables.set(name, { columns, generated });
  }
  return tables;
}

const schemaSql = await readFile(path.join(ROOT, 'supabase/migrations/0001_schema.sql'), 'utf8');
const TABLES = parseSchema(schemaSql);

/* ── drive the real write path ───────────────────────────────────────────── */

await freshDb();
const api = await import('../dataClient.js');
await api.ready();

const { openDb } = await import('../src/data/idb/open.js');
const { listOpen } = await import('../src/data/outbox.js');
const { toWire } = await import('../src/data/sync/push.js');

const OP = 'Maria';

test('the migration parses into tables with columns', () => {
  assert.ok(TABLES.size >= 10, `expected the main tables, found ${TABLES.size}`);
  for (const t of ['insectario', 'recoleccion', 'bandeja', 'alimentacion',
                   'ayuno', 'revision', 'separacion', 'cochada', 'cochada_separacion']) {
    assert.ok(TABLES.has(t), `missing table ${t}`);
    assert.ok(TABLES.get(t).columns.size > 3, `${t} parsed with too few columns`);
  }
  // Sanity-check the parser actually recognises generated columns, or the
  // whole test would pass vacuously.
  assert.ok(TABLES.get('insectario').generated.has('poblacion_estimada'));
  assert.ok(TABLES.get('insectario').generated.has('estado'));
  assert.ok(TABLES.get('ayuno').generated.has('merma_pct'));
  assert.ok(TABLES.get('cochada').generated.has('rendimiento_pct'));
  assert.ok(!TABLES.get('bandeja').generated.has('estado'), 'bandeja.estado is trigger-owned, not generated');
});

test('exercise every write, then verify every queued payload', async () => {
  const ins = await api.createInsectario({
    nombre_insectario: 'ICB', fecha_inicio: '2026-05-01', generacion_moscas: 'F6',
    biomasa_kg: 3.1, proyeccion_ovipositores: '2026-05-15',
    proyeccion_cierre: '2026-05-22', operator_name: OP
  });
  assert.ok(ins.ok, JSON.stringify(ins.error));
  await api.marcarAtractante(ins.data.id);

  const rec = await api.createRecoleccion({ insectario_id: ins.data.id, huevos_g: 0.62, operator_name: OP });
  assert.ok(rec.ok, JSON.stringify(rec.error));

  const b1 = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 1, operator_name: OP });
  const b2 = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 2, operator_name: OP });
  assert.ok(b1.ok && b2.ok);

  await api.logAlimentacion({ bandeja_id: b1.data.id, tipo_alimento: 'Bagazo', cantidad_kg: 1.3, operator_name: OP });
  await api.logAlimentacionGrupal({
    bandeja_ids: [b1.data.id, b2.data.id], tipo_alimento: 'Afrecho',
    cantidad_kg: 0.9, operator_name: OP
  });
  await api.logRevision({ bandeja_id: b1.data.id, notas: 'ok', operator_name: OP });

  const ay = await api.logAyuno({ bandeja_id: b1.data.id, peso_inicial_kg: 1.2, operator_name: OP });
  await api.logAyunoFin(ay.data.id, { peso_final_kg: 1.05 });

  const sep = await api.logSeparacion({ bandeja_id: b1.data.id, larva_limpia_g: 410, operator_name: OP });
  const lote = await api.createLote({ separacion_ids: [sep.data.id], peso_inicial_kg: 0.41, operator_name: OP });
  await api.updateLoteQC(lote.data.id, { peso_final_kg: 0.11, tiempo_secado_horas: 14, qc_aprobado: true });
  await api.marcarEmpacado(lote.data.id, {});
  await api.marcarDespachado(lote.data.id);

  const queued = await listOpen(await openDb());
  assert.ok(queued.length >= 10, `expected a full queue, got ${queued.length}`);

  const problems = [];
  const checkRow = (table, row, label) => {
    const spec = TABLES.get(table);
    if (!spec) { problems.push(`${label}: no such table "${table}" in the migration`); return; }
    for (const key of Object.keys(toWire(row))) {
      if (!spec.columns.has(key)) {
        problems.push(`${label}: sends "${key}", which app.${table} does not have`);
      } else if (spec.generated.has(key)) {
        problems.push(`${label}: sends "${key}", a GENERATED ALWAYS column — Postgres rejects the whole insert`);
      }
    }
  };

  let upserts = 0, rpcs = 0;
  for (const item of queued) {
    if (item.op === 'upsert') {
      upserts++;
      checkRow(item.table, item.payload, `upsert ${item.table}`);
    } else if (item.rpc === 'log_alimentacion_grupal') {
      rpcs++;
      for (const r of item.payload.p_rows) checkRow('alimentacion', r, 'rpc log_alimentacion_grupal');
    } else if (item.rpc === 'crear_cochada') {
      rpcs++;
      checkRow('cochada', item.payload.p_cochada, 'rpc crear_cochada');
    }
  }

  assert.ok(upserts >= 6, `expected several table upserts, got ${upserts}`);
  assert.ok(rpcs >= 2, `expected the grupal and cochada RPCs, got ${rpcs}`);
  assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
});

test('generated and derived values are stripped before sending', async () => {
  // Explicit spot-checks, so a regression names the field rather than just
  // failing somewhere in the sweep above.
  const wire = toWire({
    id: 'x', codigo: 'ICB-0105', biomasa_kg: 3.1,
    poblacion_estimada: 155000,           // GENERATED
    desviacion_cierre_dias: null,         // GENERATED
    estado: 'activo',                     // GENERATED on insectario
    updated_at: '2026-01-01T00:00:00Z',   // server-owned: see push.js
    synced_at: '2026-01-01T00:00:00Z',
    insectario_nombre: 'ICB',             // read-side join, no column
    last_evento: { tipo: 'x' },
    created_at: '2026-01-01T00:00:00Z'    // kept: when the operator entered it
  });
  assert.deepEqual(Object.keys(wire).sort(), ['biomasa_kg', 'codigo', 'created_at', 'id']);
});

test('the name is sent as plain text, never as an id', async () => {
  const queued = await listOpen(await openDb());
  const withName = queued.filter(i => i.op === 'upsert' && i.payload?.registrado_por);
  assert.ok(withName.length > 0, 'something should carry a name');
  for (const item of withName) {
    assert.equal(item.payload.registrado_por, OP);
    assert.ok(!/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(item.payload.registrado_por),
      'must be the typed name, not a foreign key to a roster that may not exist');
  }
});

test('every synced store maps to a real table', async () => {
  const { SYNCED_STORES } = await import('../src/data/idb/schema.js');
  for (const store of SYNCED_STORES) {
    assert.ok(TABLES.has(store),
      `local store "${store}" has no app.${store} table — the pull would 404`);
  }
});
