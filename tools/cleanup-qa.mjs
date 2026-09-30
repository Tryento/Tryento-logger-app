/**
 * cleanup-qa.mjs — remove records created while testing the live site.
 *
 *   node tools/cleanup-qa.mjs [CODIGO…]            # show what would be removed
 *   node tools/cleanup-qa.mjs [CODIGO…] --delete   # mark it deleted (phones drop it)
 *   node tools/cleanup-qa.mjs [CODIGO…] --purge    # erase what was marked ≥ 7 days ago
 *
 * CODIGO is an insectario code (default ICA-2509, the QA colony). Everything
 * under it goes: recolecciones, incubadoras, bandejas and their events.
 *
 * TWO STEPS, ON PURPOSE. Phones pull changes by `updated_at`, and a hard DELETE
 * leaves nothing to pull: a phone that had these rows kept them forever, and
 * anything recorded under them was rejected by the server with a foreign-key
 * error (409 bandeja_recoleccion_id_fkey). So `--delete` only sets deleted_at,
 * which every phone sees and hides on its next sync. `--purge` erases rows for
 * good once they have been marked for a week — time enough for every phone.
 *
 * Dry-run by default: this talks to the production database, and a delete
 * script that runs the moment you invoke it is one typo away from removing
 * real work.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DELETE = process.argv.includes('--delete');
const PURGE = process.argv.includes('--purge');
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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

console.log(PURGE ? 'BORRANDO PARA SIEMPRE lo marcado hace 7 días o más'
          : DELETE ? 'MARCANDO COMO BORRADO (los teléfonos lo quitan al sincronizar)'
          : 'Simulación (usa --delete para marcar como borrado)');
console.log('Insectarios objetivo: ' + TARGETS.join(', ') + '\n');

const { data: ins, error } = await db.from('insectario').select('id, codigo, deleted_at').in('codigo', TARGETS);
if (error) { console.error(error.message); process.exit(1); }
if (!ins?.length) { console.log('No se encontró ninguno. Nada que hacer.'); process.exit(0); }

const insIds = ins.map(r => r.id);
const idsOf = rows => (rows || []).map(r => r.id);
const recs = (await db.from('recoleccion').select('id, recolecta, deleted_at').in('insectario_id', insIds)).data || [];
const recIds = idsOf(recs);
const incs = recIds.length ? (await db.from('incubadora').select('id, codigo, deleted_at').in('recoleccion_id', recIds)).data || [] : [];
const bans = recIds.length ? (await db.from('bandeja').select('id, id_bandeja, deleted_at').in('recoleccion_id', recIds)).data || [] : [];
const banIds = idsOf(bans);

/** Every child table that hangs off a tray. */
const EVENTS = ['alimentacion', 'ayuno', 'revision', 'separacion'];
const events = {};
for (const t of EVENTS) {
  events[t] = banIds.length ? (await db.from(t).select('id, deleted_at').in('bandeja_id', banIds)).data || [] : [];
}

console.log(`  insectario    ${ins.length}   ${ins.map(r => r.codigo).join(', ')}`);
console.log(`  recoleccion   ${recIds.length}`);
console.log(`  incubadora    ${incs.length}   ${incs.map(r => r.codigo).join(', ')}`);
console.log(`  bandeja       ${banIds.length}   ${bans.map(r => r.id_bandeja).join(', ')}`);
for (const t of EVENTS) console.log(`  ${t.padEnd(13)} ${events[t].length}`);

if (!DELETE && !PURGE) {
  console.log('\nPara marcar como borrado:  node tools/cleanup-qa.mjs ' + TARGETS.join(' ') + ' --delete');
  process.exit(0);
}

if (DELETE) {
  // Children first, so nothing ever points at a row that looks alive.
  const now = new Date().toISOString();
  const mark = async (table, ids) => {
    if (!ids.length) return;
    const { error: e } = await db.from(table).update({ deleted_at: now }).in('id', ids).is('deleted_at', null);
    if (e) { console.log(`  no se pudo marcar ${table}: ${e.message}`); process.exitCode = 1; }
  };
  for (const t of EVENTS) await mark(t, idsOf(events[t]));
  await mark('bandeja', banIds);
  await mark('incubadora', idsOf(incs));
  await mark('recoleccion', recIds);
  await mark('insectario', insIds);
  const { data: vivos } = await db.from('insectario').select('id').in('id', insIds).is('deleted_at', null);
  if (!vivos?.length) console.log('\nListo: marcado como borrado. Los teléfonos lo quitan al sincronizar.');
  else { console.log(`\nQuedaron ${vivos.length} sin marcar.`); process.exitCode = 1; }
  process.exit();
}

// --purge: only what was marked deleted long enough ago for every phone to
// have pulled that. Anything still alive, or marked recently, stays.
const cutoff = Date.now() - PURGE_AFTER_MS;
const old = rows => (rows || []).filter(r => r.deleted_at && Date.parse(r.deleted_at) <= cutoff).map(r => r.id);
const gone = async (table, ids, col = 'id') => {
  if (!ids.length) return 0;
  const { error: e } = await db.from(table).delete().in(col, ids);
  if (e) { console.log(`  no se pudo borrar ${table}: ${e.message}`); process.exitCode = 1; return 0; }
  return ids.length;
};
let n = 0;
// Separaciones may be pooled into a lote; that link must go first.
const sepOld = old(events.separacion);
if (sepOld.length) await db.from('lote_separacion').delete().in('separacion_id', sepOld);
for (const t of EVENTS) n += await gone(t, old(events[t]));
n += await gone('bandeja', old(bans));
n += await gone('incubadora', old(incs));
n += await gone('recoleccion', old(recs));
n += await gone('insectario', old(ins));
console.log(`\nBorradas para siempre: ${n} filas (marcadas hace más de 7 días).`);
