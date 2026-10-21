/**
 * build-setup-sql.mjs — regenerate supabase/SETUP_COMPLETO.sql.
 *
 *   npm run setup:sql
 *
 * Concatenates, in order, the migrations a NEW, EMPTY database runs: from the
 * newest file marked `@setup-baseline` onwards, leaving out the `@setup-skip`
 * repairs (see tools/migrations.mjs).
 *
 * Node rather than bash: on Windows `bash` can resolve to an empty WSL install,
 * and the old shell version silently failed there.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, migrationPlan } from './migrations.mjs';

const OUT = path.join(ROOT, 'supabase', 'SETUP_COMPLETO.sql');

const HEADER = `-- ============================================================================
-- TryEnto — INSTALACIÓN COMPLETA DE LA BASE DE DATOS
--
-- PARA UNA BASE NUEVA Y VACÍA. Empieza en el archivo marcado @setup-baseline:
-- los anteriores quedan en supabase/migrations como historia y no se corren.
--
-- OJO: en una base que todavía tiene el protocolo anterior, BORRA todos sus
-- datos (menos los nombres de las personas). Para actualizar una base que ya
-- existe se corren los archivos numerados que falten, uno por uno.
--
-- Cópialo ENTERO y pégalo en Supabase → SQL Editor → New query → Run.
-- Copia el CONTENIDO del archivo, no su nombre.
--
-- Después: Settings → API → "Exposed schemas" → agrega  app
--
-- GENERADO por tools/build-setup-sql.mjs (npm run setup:sql). No lo edites a
-- mano: las fuentes son supabase/migrations/00*.sql
-- ============================================================================
`;

const parts = [HEADER];

for (const { file, body, role } of await migrationPlan()) {
  if (role === 'history') {
    console.log(`  history ${file}  (antes de la base actual)`);
    continue;
  }
  if (role === 'skip') {
    console.log(`  skip    ${file}  (reparación de una base existente)`);
    continue;
  }
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
