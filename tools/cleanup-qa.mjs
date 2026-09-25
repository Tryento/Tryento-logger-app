/**
 * cleanup-qa.mjs — remove records created while testing the live site.
 *
 *   node tools/cleanup-qa.mjs            # show what would be deleted
 *   node tools/cleanup-qa.mjs --delete   # actually delete
 *
 * Deletes children before parents so foreign keys never block it. Dry-run by
 * default: this talks to the production database, and a delete script that
 * runs the moment you invoke it is one typo away from removing real work.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DELETE = process.argv.includes('--delete');

/** Codes reported in the QA pass. Add more as needed. */
const CODIGOS = process.argv.filter(a => !a.startsWith('--')).slice(2);
const TARGETS = CODIGOS.length ? CODIGOS : ['ICA-2509'];

const src = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const cfg = win.__TRYENTO_CONFIG__ || {};
if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
  console.error('app-config.js no tiene supabaseUrl / supabaseAnonKey.');
  process.exit(1);
}

const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  db: { schema: cfg.dbSchema || 'app' },
  auth: { persistSession: false, autoRefreshToken: false }
});

console.log(DELETE ? 'BORRANDO' : 'Simulacion (usa --delete para borrar de verdad)');
console.log('Insectarios objetivo: ' + TARGETS.join(', ') + '\n');

const { data: ins, error } = await db.from('insectario').select('id, codigo').in('codigo', TARGETS);
if (error) { console.error(error.message); process.exit(1); }
if (!ins?.length) { console.log('No se encontro ninguno. Nada que hacer.'); process.exit(0); }

const insIds = ins.map(r => r.id);
const { data: recs } = await db.from('recoleccion').select('id, recolecta').in('insectario_id', insIds);
const recIds = (recs || []).map(r => r.id);
const { data: bans } = recIds.length
  ? await db.from('bandeja').select('id, id_bandeja').in('recoleccion_id', recIds)
  : { data: [] };
const banIds = (bans || []).map(r => r.id);

/** Every child table that hangs off a tray. */
const EVENTS = ['alimentacion', 'ayuno', 'revision', 'separacion'];
const counts = {};
for (const t of EVENTS) {
  const { data } = banIds.length
    ? await db.from(t).select('id').in('bandeja_id', banIds)
    : { data: [] };
  counts[t] = (data || []).length;
}

console.log(`  insectario    ${ins.length}   ${ins.map(r => r.codigo).join(', ')}`);
console.log(`  recoleccion   ${recIds.length}`);
console.log(`  bandeja       ${banIds.length}   ${(bans || []).map(r => r.id_bandeja).join(', ')}`);
for (const t of EVENTS) console.log(`  ${t.padEnd(13)} ${counts[t]}`);

if (!DELETE) {
  console.log('\nPara borrar:  node tools/cleanup-qa.mjs --delete');
  process.exit(0);
}

// Separaciones may be pooled into a cochada; that link must go first.
if (banIds.length) {
  const { data: seps } = await db.from('separacion').select('id').in('bandeja_id', banIds);
  const sepIds = (seps || []).map(r => r.id);
  if (sepIds.length) await db.from('cochada_separacion').delete().in('separacion_id', sepIds);
  for (const t of EVENTS) await db.from(t).delete().in('bandeja_id', banIds);
  await db.from('bandeja').delete().in('id', banIds);
}
if (recIds.length) await db.from('recoleccion').delete().in('id', recIds);
await db.from('insectario').delete().in('id', insIds);

const { data: left } = await db.from('insectario').select('id').in('id', insIds);
if (!left?.length) console.log('\nListo: los registros de prueba fueron borrados.');
else { console.log(`\nQuedaron ${left.length} sin borrar.`); process.exitCode = 1; }
