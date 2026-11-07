/**
 * migrations.mjs — the SQL files, and which of them make up a fresh install.
 *
 * Shared by build-setup-sql (which writes SETUP_COMPLETO.sql), check-sql (which
 * proves SETUP_COMPLETO.sql is not stale) and the tests, so the three can never
 * disagree about what a new database runs.
 *
 *   supabase/esquema      the schema, numbered and append-only. A fresh install
 *                         runs all of it; an existing database runs what it lacks.
 *   supabase/operaciones  run by hand, never part of an install: the full delete
 *                         and the two modes.
 *
 * Not `supabase/migrations`: Supabase's GitHub integration applies that folder to
 * production on every push to main, and the SQL here runs by hand before the
 * push. Everything before 0010 is in git history.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ESQUEMA_DIR = path.join(ROOT, 'supabase', 'esquema');
export const OPERACIONES_DIR = path.join(ROOT, 'supabase', 'operaciones');

async function archivos(dir) {
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  const out = [];
  for (const file of files) out.push({ file, body: await readFile(path.join(dir, file), 'utf8') });
  return out;
}

/** The files a fresh install runs, in order. */
export const setupFiles = () => archivos(ESQUEMA_DIR);

/** The scripts run by hand. */
export const operaciones = () => archivos(OPERACIONES_DIR);
