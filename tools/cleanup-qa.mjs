/**
 * cleanup-qa.mjs — remove what the checks, or a person testing, wrote into the
 * live database.
 *
 *   node tools/cleanup-qa.mjs                    # show what would be removed
 *   node tools/cleanup-qa.mjs --delete           # mark it deleted (phones drop it)
 *   node tools/cleanup-qa.mjs --purge            # erase what was marked ≥ 7 days ago
 *   node tools/cleanup-qa.mjs --como Prueba …    # also what was registered as "Prueba"
 *
 * A test row is one registered under a name no person uses: check-backend and
 * check-sync always, plus any name given with --como (whoever tested the live
 * site registered as that name). Every table is covered, children first.
 *
 * TWO STEPS, ON PURPOSE. Phones pull changes by `updated_at`, and a hard DELETE
 * leaves nothing to pull: a phone that had these rows kept them forever, and
 * anything recorded under them was rejected by the server with a foreign-key
 * error. So `--delete` only sets deleted_at, which every phone sees and hides
 * on its next sync. `--purge` erases rows for good once they have been marked
 * for a week — time enough for every phone.
 *
 * Dry-run by default: this talks to the production database, and a delete
 * script that runs the moment you invoke it is one typo away from removing
 * real work.
 */
import { createClient } from '@supabase/supabase-js';
import { NOMBRES_QA, ORDEN, loadConfig, filasQa, marcarQa } from './qa.mjs';

const args = process.argv.slice(2);
const DELETE = args.includes('--delete');
const PURGE = args.includes('--purge');
const PURGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const extra = [];
args.forEach((a, i) => { if (a === '--como' && args[i + 1]) extra.push(args[i + 1]); });
const NOMBRES = [...NOMBRES_QA, ...extra];

const cfg = await loadConfig();
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
console.log('Registrado por: ' + NOMBRES.join(', ') + '\n');

const filas = await filasQa(db, NOMBRES);
let total = 0;
for (const t of ORDEN) {
  const vivas = filas[t].filter(r => !r.deleted_at).length;
  const marcadas = filas[t].length - vivas;
  total += filas[t].length;
  if (filas[t].length) console.log(`  ${t.padEnd(17)} ${String(vivas).padStart(4)} vivas   ${String(marcadas).padStart(4)} ya marcadas`);
}
if (!total) {
  console.log('No se encontró nada. Nada que hacer.');
  process.exit(0);
}

if (!DELETE && !PURGE) {
  console.log('\nPara marcar como borrado:  node tools/cleanup-qa.mjs --delete' + extra.map(n => ' --como ' + n).join(''));
  process.exit(0);
}

if (DELETE) {
  const quedan = await marcarQa(db, NOMBRES);
  console.log(quedan ? `\nQuedaron ${quedan} filas sin marcar.` : '\nListo: marcado como borrado. Los teléfonos lo quitan al sincronizar.');
  process.exitCode = quedan ? 1 : 0;
  process.exit();
}

// --purge: only what was marked deleted long enough ago for every phone to
// have pulled that. Anything still alive, or marked recently, stays.
const cutoff = Date.now() - PURGE_AFTER_MS;
let n = 0;
for (const t of ORDEN) {
  const ids = filas[t].filter(r => r.deleted_at && Date.parse(r.deleted_at) <= cutoff).map(r => r.id);
  if (!ids.length) continue;
  const { error } = await db.from(t).delete().in('id', ids);
  if (error) { console.log(`  no se pudo borrar ${t}: ${error.message}`); process.exitCode = 1; continue; }
  n += ids.length;
}
console.log(`\nBorradas para siempre: ${n} filas (marcadas hace más de 7 días).`);
