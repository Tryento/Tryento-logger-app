/**
 * build-setup-sql.mjs — regenerate supabase/SETUP_COMPLETO.sql.
 *
 *   npm run setup:sql
 *
 * Concatenates, in order, what a NEW, EMPTY database runs: every file in
 * supabase/esquema (see tools/migrations.mjs).
 *
 * Node rather than bash: on Windows `bash` can resolve to an empty WSL install,
 * and the old shell version silently failed there.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, setupFiles } from './migrations.mjs';

const OUT = path.join(ROOT, 'supabase', 'SETUP_COMPLETO.sql');

const HEADER = `-- ============================================================================
-- TryEnto — INSTALACIÓN COMPLETA DE LA BASE DE DATOS
--
-- SÓLO PARA UNA BASE NUEVA Y VACÍA. Para actualizar una base que ya existe se
-- corren los archivos de supabase/esquema que falten, uno por uno.
--
-- OJO: en una base que todavía tiene el protocolo de antes de octubre de 2026,
-- BORRA todos sus datos (menos los nombres de las personas).
--
-- Cópialo ENTERO y pégalo en Supabase → SQL Editor → New query → Run.
-- Copia el CONTENIDO del archivo, no su nombre.
--
-- Después: Settings → API → "Exposed schemas" → agrega  app
--
-- GENERADO por tools/build-setup-sql.mjs (npm run setup:sql). No lo edites a
-- mano: las fuentes son supabase/esquema/00*.sql
-- ============================================================================
`;

const parts = [HEADER];

for (const { file, body } of await setupFiles()) {
  parts.push(
    '\n\n-- ############################################################################\n' +
    `-- ${file}\n` +
    '-- ############################################################################\n\n' +
    body
  );
  console.log(`  add     ${file}`);
}

const out = parts.join('');
await writeFile(OUT, out, 'utf8');
console.log(`  ->      supabase/SETUP_COMPLETO.sql  (${Buffer.byteLength(out)} bytes)`);
