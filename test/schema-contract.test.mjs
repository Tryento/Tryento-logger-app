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
import { readFile, readdir } from 'node:fs/promises';
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

/** Column facts from one column definition ("name type [not null] [default …]"). */
function columnFacts(t) {
  const col = (/^["']?(\w+)["']?/.exec(t) || [])[1];
  if (!col) return null;
  const isGenerated = /generated\s+always/i.test(t);
  const notNull = /\bnot\s+null\b/i.test(t) || /\bprimary\s+key\b/i.test(t);
  const hasDefault = /\bdefault\b/i.test(t);
  return { col, isGenerated, required: notNull && !hasDefault && !isGenerated };
}

/**
 * The schema as ALL the migrations leave it: `create table` plus every later
 * `alter table … add column` / `alter column … drop not null`. Reading 0001
 * alone missed every table and column added since, so a new synced store
 * looked like it had no table.
 */
export function parseMigrations(sqlFiles) {
  const tables = new Map();
  for (const raw of sqlFiles) {
    for (const [name, def] of parseSchema(raw)) tables.set(name, def);
    const sql = stripComments(raw);
    const re = /alter\s+table\s+app\.(\w+)\s+([\s\S]*?);/gi;
    let m;
    while ((m = re.exec(sql))) {
      const t = tables.get(m[1]);
      if (!t) continue;
      for (const part of splitTopLevel(m[2])) {
        const p = part.trim();
        const add = /^add\s+column\s+(?:if\s+not\s+exists\s+)?([\s\S]+)$/i.exec(p);
        if (add) {
          const f = columnFacts(add[1].trim());
          if (!f) continue;
          t.columns.add(f.col);
          if (f.isGenerated) t.generated.add(f.col);
          if (f.required) t.required.add(f.col);
          continue;
        }
        const drop = /^alter\s+column\s+(\w+)\s+drop\s+not\s+null/i.exec(p);
        if (drop) t.required.delete(drop[1]);
      }
    }
  }
  return tables;
}

export function parseSchema(rawSql) {
  const sql = stripComments(rawSql);
  const tables = new Map();
  const re = /create\s+table\s+(?:if\s+not\s+exists\s+)?app\.(\w+)\s*\(/gi;
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
    const required = new Set();
    for (const part of splitTopLevel(body)) {
      const t = part.trim();
      if (!t || NOT_A_COLUMN.test(t)) continue;
      const col = (/^["']?(\w+)["']?/.exec(t) || [])[1];
      if (!col) continue;
      columns.add(col);
      const isGenerated = /generated\s+always/i.test(t);
      if (isGenerated) generated.add(col);
      // Required = the client MUST supply it. NOT NULL (or a primary key) with
      // no DEFAULT to fall back on, and not computed by the database.
      const notNull = /\bnot\s+null\b/i.test(t) || /\bprimary\s+key\b/i.test(t);
      const hasDefault = /\bdefault\b/i.test(t);
      if (notNull && !hasDefault && !isGenerated) required.add(col);
    }
    tables.set(name, { columns, generated, required });
  }
  return tables;
}

// Every migration a fresh install runs, in order (the @setup-skip repairs are
// for an old production database and describe no new structure).
const MIG_DIR = path.join(ROOT, 'supabase/migrations');
const migrationFiles = (await readdir(MIG_DIR)).filter(f => f.endsWith('.sql')).sort();
const migrationSql = [];
for (const f of migrationFiles) {
  const body = await readFile(path.join(MIG_DIR, f), 'utf8');
  if (!/@setup-skip/.test(body.slice(0, 400))) migrationSql.push(body);
}
const TABLES = parseMigrations(migrationSql);

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
                   'ayuno', 'revision', 'separacion', 'lote', 'lote_separacion']) {
    assert.ok(TABLES.has(t), `missing table ${t}`);
    assert.ok(TABLES.get(t).columns.size > 3, `${t} parsed with too few columns`);
  }
  // Sanity-check the parser actually recognises generated columns, or the
  // whole test would pass vacuously.
  assert.ok(TABLES.get('insectario').generated.has('poblacion_estimada'));
  assert.ok(TABLES.get('insectario').generated.has('estado'));
  assert.ok(TABLES.get('ayuno').generated.has('merma_pct'));
  assert.ok(TABLES.get('lote').generated.has('rendimiento_pct'));
  assert.ok(!TABLES.get('bandeja').generated.has('estado'), 'bandeja.estado is trigger-owned, not generated');

  // Required-column parsing must actually be finding things, or the check below
  // passes vacuously.
  assert.ok(TABLES.get('recoleccion').required.has('insectario_id'),
    'recoleccion.insectario_id is NOT NULL with no default');
  assert.ok(TABLES.get('recoleccion').required.has('recolecta'));
  assert.ok(TABLES.get('bandeja').required.has('no_bandeja'));
  assert.ok(!TABLES.get('bandeja').required.has('notas'), "notas has a default, so it is not required");
  assert.ok(!TABLES.get('bandeja').required.has('estado'), 'estado has a default');
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
    const wire = toWire(table, row);
    for (const key of Object.keys(wire)) {
      if (!spec.columns.has(key)) {
        problems.push(`${label}: sends "${key}", which app.${table} does not have`);
      } else if (spec.generated.has(key)) {
        problems.push(`${label}: sends "${key}", a GENERATED ALWAYS column — Postgres rejects the whole insert`);
      }
    }
    // The other half, and the one that actually bit: a NOT NULL column with no
    // default that the client never sends. `recoleccion.insectario_id` was
    // being stripped by an over-eager shared deny-list, so every collection
    // failed with a not-null violation — and every tray and event behind it
    // was blocked too.
    for (const col of spec.required) {
      if (!(col in wire) || wire[col] === null || wire[col] === undefined) {
        problems.push(`${label}: never sends "${col}", which app.${table} requires (NOT NULL, no default)`);
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
    } else if (item.rpc === 'crear_lote') {
      rpcs++;
      checkRow('lote', item.payload.p_lote, 'rpc crear_lote');
    }
  }

  assert.ok(upserts >= 6, `expected several table upserts, got ${upserts}`);
  assert.ok(rpcs >= 2, `expected the grupal and lote RPCs, got ${rpcs}`);
  assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
});

test('generated and derived values are stripped before sending', async () => {
  // Explicit spot-checks, so a regression names the field rather than just
  // failing somewhere in the sweep above.
  const wire = toWire('insectario', {
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

test('REGRESSION: every record carries who registered it', async () => {
  // QA found every insectario, recoleccion and bandeja saving
  // registrado_por: null while the header displayed "registrando como
  // Ricardo". Three of the six forms never seeded operator_name, so the name
  // was shown and never written. provenance() now falls back to the selected
  // operator, so this holds even for a form that forgets.
  const queued = await listOpen(await openDb());
  const CARRIES_NAME = new Set(['insectario', 'recoleccion', 'bandeja',
                                'alimentacion', 'ayuno', 'revision',
                                'separacion', 'lote']);
  const anonymous = [];

  for (const item of queued) {
    if (item.op === 'upsert' && CARRIES_NAME.has(item.table)) {
      if (!item.payload?.registrado_por) anonymous.push(item.table);
    }
    if (item.rpc === 'log_alimentacion_grupal') {
      for (const r of item.payload.p_rows || []) {
        if (!r.registrado_por) anonymous.push('alimentacion (grupal)');
      }
    }
    if (item.rpc === 'crear_lote' && !item.payload.p_lote?.registrado_por) {
      anonymous.push('lote (rpc)');
    }
  }

  assert.deepEqual(anonymous, [],
    'estos registros se guardarian sin autor: ' + anonymous.join(', '));
});

test('a form that forgets operator_name still records the operator', async () => {
  const { setCurrentOperator } = await import('../src/data/write.js');
  await setCurrentOperator('Ricardo');

  // Deliberately omit operator_name, the way the three broken forms did.
  const res = await api.createInsectario({
    nombre_insectario: 'ICC', fecha_inicio: '2026-06-01'
  });
  assert.ok(res.ok, JSON.stringify(res.error));

  const queued = await listOpen(await openDb());
  const item = queued.find(i => i.table === 'insectario' && i.row_id === res.data.id);
  assert.equal(item.payload.registrado_por, 'Ricardo',
    'debe caer de vuelta al operador seleccionado');
});

test('the name is sent as plain text, never as an id', async () => {
  const queued = await listOpen(await openDb());
  const withName = queued.filter(i => i.op === 'upsert' && i.payload?.registrado_por);
  assert.ok(withName.length > 0, 'something should carry a name');
  for (const item of withName) {
    assert.ok(['Maria', 'Ricardo'].includes(item.payload.registrado_por),
      'got ' + item.payload.registrado_por);
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

test('the parser sees what later migrations added (0004, 0007)', () => {
  assert.ok(TABLES.get('insectario').columns.has('fecha_ovipositores_por'), '0004 alter add column');
  assert.ok(TABLES.has('incubadora') && TABLES.get('incubadora').generated.has('estado'), '0007 create table');
  assert.ok(TABLES.get('alimentacion').columns.has('carga'));
  assert.ok(!TABLES.get('ayuno').required.has('peso_inicial_kg'), '0007 drops NOT NULL: v2 fasts are not weighed');
});

test('v2 writes send only columns the tables have, and never the protocol', async () => {
  const { createRecoleccionV2, distribuirIncubadora, logCarga, logAyuno, logSeparacion } =
    await import('../src/data/write.js');
  const ins = await api.createInsectario({ nombre_insectario: 'ICA', fecha_inicio: '2026-08-01',
                                           generacion_moscas: 'F7', operator_name: OP });
  const r = await createRecoleccionV2({ insectario_id: ins.data.id, peso_ovipositores_g: 320,
                                        atrayente_cambiado: true, starter_kg: 2, operator_name: OP });
  assert.ok(r.ok, JSON.stringify(r.error));
  const d = await distribuirIncubadora(r.data.incubadora.id, { n_bandejas: 2, operator_name: OP });
  assert.ok(d.ok, JSON.stringify(d.error));
  const [b1, b2] = d.data.bandejas;
  assert.ok((await logCarga({ bandeja_ids: [b1.id, b2.id], carga: 2, tamizado: true, operator_name: OP })).ok);
  assert.ok((await logCarga({ bandeja_id: b1.id, carga: 3, operator_name: OP })).ok, 'one tray: a plain upsert');
  assert.ok((await logAyuno({ bandeja_id: b2.id, operator_name: OP })).ok, 'v2 fast without a scale');
  assert.ok((await logSeparacion({ bandeja_id: b2.id, larva_limpia_g: 4900, reserva_cria_g: 100, operator_name: OP })).ok);

  const problems = [];
  const queued = await listOpen(await openDb());
  for (const item of queued.filter(i => i.op === 'upsert' && ['alimentacion', 'ayuno', 'separacion'].includes(i.table))) {
    const spec = TABLES.get(item.table);
    const wire = toWire(item.table, item.payload);
    if ('protocolo' in wire) problems.push(`${item.table}: sends protocolo (the server decides it)`);
    for (const k of Object.keys(wire)) if (!spec.columns.has(k)) problems.push(`${item.table}: sends "${k}"`);
    for (const col of spec.required) if (wire[col] === null || wire[col] === undefined) problems.push(`${item.table}: lacks "${col}"`);
  }
  for (const item of queued.filter(i => i.rpc === 'log_alimentacion_grupal')) {
    for (const row of item.payload.p_rows) {
      const wire = toWire('alimentacion', row);
      for (const k of Object.keys(wire)) if (!TABLES.get('alimentacion').columns.has(k)) problems.push(`grupal: "${k}"`);
    }
  }
  assert.deepEqual(problems, [], '\n  ' + problems.join('\n  '));
});

test('every one-tap action records who did it (p_por)', async () => {
  const w = await import('../src/data/write.js');
  // Earlier tests queued actions before any name was chosen; only judge the new ones.
  const before = new Set((await listOpen(await openDb())).map(i => i.id));
  await w.setCurrentOperator('Ricardo');

  const ins = await api.createInsectario({ nombre_insectario: 'ICC', fecha_inicio: '2026-07-01' });
  await api.marcarAtractante(ins.data.id);
  await api.marcarCierre(ins.data.id);
  const rec = await api.createRecoleccion({ insectario_id: ins.data.id, huevos_g: 1 });
  const b = await api.createBandeja({ recoleccion_id: rec.data.id, no_bandeja: 1 });
  const ay = await api.logAyuno({ bandeja_id: b.data.id, peso_inicial_kg: 2 });
  await api.logAyunoFin(ay.data.id, { peso_final_kg: 1.9 });
  const sep = await api.logSeparacion({ bandeja_id: b.data.id, larva_limpia_g: 300 });
  const l1 = await api.createLote({ separacion_ids: [sep.data.id], peso_inicial_kg: 0.3 });
  await api.updateLoteQC(l1.data.id, { peso_final_kg: 0.1, qc_aprobado: true });
  await api.marcarEmpacado(l1.data.id, {});
  await api.marcarDespachado(l1.data.id);

  const queued = await listOpen(await openDb());
  const cas = queued.filter(i => i.op === 'cas' && !before.has(i.id));
  const rpcs = new Set(cas.map(i => i.rpc));
  for (const rpc of ['marcar_atractante', 'marcar_cierre', 'cerrar_ayuno', 'actualizar_qc_lote',
                     'marcar_empacado', 'marcar_despachado']) {
    assert.ok(rpcs.has(rpc), `falta probar ${rpc}`);
  }
  const sinAutor = cas.filter(i => !i.payload?.p_por).map(i => i.rpc);
  assert.deepEqual(sinAutor, [], 'estas acciones no guardarían quién las hizo: ' + sinAutor.join(', '));
});
