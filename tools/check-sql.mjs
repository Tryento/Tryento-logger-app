/**
 * check-sql.mjs — parse every migration against the real Postgres grammar.
 *
 * This validates SYNTAX only: libpg_query is the actual Postgres parser, so a
 * file that passes here will not fail on a typo. It does NOT validate
 * semantics — whether `auth.users` exists, whether a generated column's
 * expression is IMMUTABLE, or whether a policy references a real function. Only
 * applying the migration to a real Supabase project proves those.
 *
 * Note that plpgsql function BODIES are opaque string literals at parse time.
 * Postgres validates them when the function is created (unless
 * check_function_bodies is off), so an error inside one shows up on apply, not
 * here.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');

let pg;
try {
  const require = createRequire(import.meta.url);
  pg = require.resolve('libpg-query') && await import('libpg-query');
} catch {
  console.log('libpg-query not installed — skipping SQL syntax checks.');
  console.log('  npm i -D libpg-query   to enable them.');
  process.exit(0);
}
if (typeof pg.loadModule === 'function') await pg.loadModule();

const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
let failed = 0;

for (const f of files) {
  const sql = await readFile(path.join(DIR, f), 'utf8');
  try {
    const ast = await pg.parse(sql);
    const stmts = ast?.stmts ?? ast?.parse_tree?.stmts ?? [];
    console.log(`  ok    ${f}  (${stmts.length} statements)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${f}: ${e.message}`);
    if (e.cursorPosition) {
      const line = sql.slice(0, e.cursorPosition).split('\n').length;
      console.log(`        near line ${line}`);
    }
  }
}

/* The one-paste setup file must parse AND match the migrations it is built
 * from. Without the staleness check, editing a migration and forgetting to run
 * tools/build-setup-sql.sh would deploy yesterday's schema — and it would look
 * like it had worked. */
const COMBINED = path.join(ROOT, 'supabase', 'SETUP_COMPLETO.sql');
try {
  const combined = await readFile(COMBINED, 'utf8');
  const ast = await pg.parse(combined);
  const stmts = ast?.stmts ?? ast?.parse_tree?.stmts ?? [];
  console.log(`  ok    SETUP_COMPLETO.sql  (${stmts.length} statements)`);

  for (const f of files) {
    const body = await readFile(path.join(DIR, f), 'utf8');
    // Repair scripts are deliberately left out of the fresh-install file.
    if (/@setup-skip/.test(body.slice(0, 400))) continue;
    if (!combined.includes(body.trim())) {
      failed++;
      console.log(`  FAIL  SETUP_COMPLETO.sql está desactualizado: ${f} cambió`);
      console.log('        corre: bash tools/build-setup-sql.sh');
      break;
    }
  }
} catch (e) {
  failed++;
  console.log(`  FAIL  SETUP_COMPLETO.sql: ${e.message}`);
  console.log('        corre: bash tools/build-setup-sql.sh');
}

if (failed) {
  console.log(`\n${failed} problema(s).`);
  process.exitCode = 1;
} else {
  console.log('\nSQL syntax OK (semantics still need a real database).');
}
