/**
 * migrations.mjs — which migration files make up a fresh install.
 *
 * Shared by build-setup-sql (which writes SETUP_COMPLETO.sql), check-sql (which
 * proves SETUP_COMPLETO.sql is not stale) and the tests, so the three can never
 * disagree about what a new database runs.
 *
 * Two markers, read from a file's first lines:
 *   @setup-baseline  the file rebuilds the whole schema from nothing. A fresh
 *                    install starts at the NEWEST such file; the files before
 *                    it stay in the folder as history and are never re-run.
 *   @setup-skip      a repair for an existing database. Bundling it into a
 *                    fresh install would drop what the files above it created.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const marked = (body, tag) => body.slice(0, 400).includes('@' + tag);

/**
 * Every migration in order, each with its role in a fresh install:
 * 'history' (before the baseline), 'skip' (a repair) or 'setup'.
 * @returns {Promise<Array<{file: string, body: string, role: string}>>}
 */
export async function migrationPlan() {
  const files = (await readdir(MIGRATIONS_DIR)).filter(f => f.endsWith('.sql')).sort();
  const all = [];
  for (const file of files) {
    all.push({ file, body: await readFile(path.join(MIGRATIONS_DIR, file), 'utf8') });
  }
  let base = 0;
  all.forEach((m, i) => { if (marked(m.body, 'setup-baseline')) base = i; });
  return all.map((m, i) => ({
    ...m,
    role: i < base ? 'history' : marked(m.body, 'setup-skip') ? 'skip' : 'setup'
  }));
}

/** The files a fresh install runs, in order. */
export async function setupFiles() {
  return (await migrationPlan()).filter(m => m.role === 'setup');
}
