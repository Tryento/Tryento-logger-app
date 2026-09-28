/**
 * build-setup-sql.mjs — regenerate supabase/SETUP_COMPLETO.sql.
 *
 *   npm run setup:sql
 *
 * Concatenates every migration in order into the one-paste file for a NEW,
 * EMPTY database. Files marked `@setup-skip` in their first lines are repairs
 * for an existing database and are left out — bundling them would drop objects
 * the files above just created.
 *
 * Node rather than bash: on Windows `bash` can resolve to an empty WSL install,
 * and the old shell version silently failed there.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'supabase', 'migrations');
const OUT = path.join(ROOT, 'supabase', 'SETUP_COMPLETO.sql');

const HEADER = `-- ============================================================================
-- TryEnto — INSTALACIÓN COMPLETA DE LA BASE DE DATOS
--
-- SÓLO PARA UNA BASE NUEVA Y VACÍA. En una base que ya existe falla en su
-- primera línea (a propósito: no es idempotente). Para actualizar una base
-- existente se corren los archivos numerados que falten, uno por uno.
--
-- Cópialo ENTERO y pégalo en Supabase → SQL Editor → New query → Run.
-- Copia el CONTENIDO del archivo, no su nombre.
--
-- Después: Settings → API → "Exposed schemas" → agrega  app
--
-- GENERADO por tools/build-setup-sql.mjs (npm run setup:sql). No lo edites a
-- mano: las fuentes son supabase/migrations/000*.sql
-- ============================================================================
`;

const files = (await readdir(DIR)).filter(f => f.endsWith('.sql')).sort();
const parts = [HEADER];

for (const f of files) {
  const body = await readFile(path.join(DIR, f), 'utf8');
  if (/@setup-skip/.test(body.slice(0, 400))) {
    console.log(`  skip    ${f}  (reparación de una base existente)`);
    continue;
  }
  parts.push(
    '\n\n-- ############################################################################\n' +
    `-- ${f}\n` +
    '-- ############################################################################\n\n' +
    body
  );
  console.log(`  add     ${f}`);
}

const out = parts.join('');
await writeFile(OUT, out, 'utf8');
console.log(`  ->      supabase/SETUP_COMPLETO.sql  (${Buffer.byteLength(out)} bytes)`);
