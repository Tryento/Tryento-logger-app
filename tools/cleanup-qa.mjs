/**
 * cleanup-qa.mjs — remove what the checks, or a person testing, wrote into the
 * live database.
 *
 *   node tools/cleanup-qa.mjs                      # show what would be removed
 *   node tools/cleanup-qa.mjs --delete             # mark it deleted (phones drop it)
 *   node tools/cleanup-qa.mjs --purge              # print the SQL that erases what was marked ≥ 7 days ago
 *   node tools/cleanup-qa.mjs --como "QA Claude" … # also what was registered as "QA Claude"
 *
 * A test row is one registered under a name no person uses: check-backend and
 * check-sync always, plus any name given with --como (whoever tested the live
 * site registered as that name). Every table is covered, children first; with
 * --delete, a --como name also leaves the shared list of names.
 *
 * TWO STEPS, ON PURPOSE. Phones pull changes by `updated_at`, and a hard DELETE
 * leaves nothing to pull: a phone that had these rows kept them forever, and
 * anything recorded under them was rejected by the server with a foreign-key
 * error. So `--delete` only sets deleted_at, which every phone sees and hides
 * on its next sync. Erasing for good, once rows have been marked for a week, is
 * not something the public key may do (0011): `--purge` prints the SQL to run
 * in Supabase → SQL Editor.
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

console.log(PURGE ? 'SQL para borrar para siempre lo marcado hace 7 días o más'
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
// A tester's name, added to the shared list when they typed it.
const { data: nombres } = await db.from('catalogo').select('id, valor, activo').eq('tipo', 'operario');
const nombresQa = (nombres || []).filter(n => extra.some(x => x.toLowerCase() === String(n.valor).toLowerCase()) && n.activo !== false);
if (nombresQa.length) console.log(`  en la lista de nombres: ${nombresQa.map(n => n.valor).join(', ')}`);
if (!total && !nombresQa.length) {
  console.log('No se encontró nada. Nada que hacer.');
  process.exit(0);
}

if (!DELETE && !PURGE) {
  console.log('\nPara marcar como borrado:  node tools/cleanup-qa.mjs --delete' + extra.map(n => ` --como "${n}"`).join(''));
  process.exit(0);
}

if (DELETE) {
  let quedan = await marcarQa(db, NOMBRES);
  // Off the list on every phone at its next sync (a row is never erased: see above).
  for (const n of nombresQa) {
    const { error } = await db.from('catalogo').update({ activo: false }).eq('id', n.id);
    if (error) { quedan++; console.log(`        no se pudo quitar el nombre ${n.valor}: ${error.message}`); }
  }
  console.log(quedan ? `\nQuedaron ${quedan} filas sin marcar.` : '\nListo: marcado como borrado. Los teléfonos lo quitan al sincronizar.');
  process.exitCode = quedan ? 1 : 0;
  process.exit();
}

// --purge: only what was marked deleted long enough ago for every phone to
// have pulled that. Anything still alive, or marked recently, stays. The public
// key may not delete (0011), so this prints the SQL for the SQL Editor.
const cutoff = Date.now() - PURGE_AFTER_MS;
const sql = [];
for (const t of ORDEN) {
  const ids = filas[t].filter(r => r.deleted_at && Date.parse(r.deleted_at) <= cutoff).map(r => `'${r.id}'`);
  if (ids.length) sql.push(`delete from app.${t} where deleted_at is not null and id in (${ids.join(', ')});`);
}
if (!sql.length) {
  console.log('\nNada marcado hace más de 7 días.');
} else {
  console.log('\nPega esto en Supabase → SQL Editor y Run (hijos primero):\n');
  console.log(['begin;', ...sql, 'commit;'].join('\n'));
}
