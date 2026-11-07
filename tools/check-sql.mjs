/**
 * check-sql.mjs — parse every SQL file against the real Postgres grammar.
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
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ROOT, setupFiles, operaciones } from './migrations.mjs';

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

let failed = 0;

for (const { file, body } of [...await setupFiles(), ...await operaciones()]) {
  try {
    const ast = await pg.parse(body);
    const stmts = ast?.stmts ?? ast?.parse_tree?.stmts ?? [];
    console.log(`  ok    ${file}  (${stmts.length} statements)`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${file}: ${e.message}`);
    if (e.cursorPosition) {
      const line = body.slice(0, e.cursorPosition).split('\n').length;
      console.log(`        near line ${line}`);
    }
  }
}

/* The one-paste setup file must parse AND match the files it is built from.
 * Without the staleness check, editing a schema file and forgetting to run
 * `npm run setup:sql` would deploy yesterday's schema — and it would look like
 * it had worked. */
const COMBINED = path.join(ROOT, 'supabase', 'SETUP_COMPLETO.sql');
try {
  const combined = await readFile(COMBINED, 'utf8');
  const ast = await pg.parse(combined);
  const stmts = ast?.stmts ?? ast?.parse_tree?.stmts ?? [];
  console.log(`  ok    SETUP_COMPLETO.sql  (${stmts.length} statements)`);

  for (const { file, body } of await setupFiles()) {
    if (!combined.includes(body.trim())) {
      failed++;
      console.log(`  FAIL  SETUP_COMPLETO.sql está desactualizado: ${file} cambió`);
      console.log('        corre: npm run setup:sql');
      break;
    }
  }
} catch (e) {
  failed++;
  console.log(`  FAIL  SETUP_COMPLETO.sql: ${e.message}`);
  console.log('        corre: npm run setup:sql');
}

if (failed) {
  console.log(`\n${failed} problema(s).`);
  process.exitCode = 1;
} else {
  console.log('\nSQL syntax OK (semantics still need a real database).');
}
