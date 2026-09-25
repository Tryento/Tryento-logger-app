#!/usr/bin/env bash
# Regenerate supabase/SETUP_COMPLETO.sql from the individual migrations.
#
# Exists because pasting three files into the Supabase SQL editor in the right
# order is three chances to paste the wrong thing; one file is one paste.
# The numbered migrations stay the source of truth — edit those, then run this.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=supabase/SETUP_COMPLETO.sql

cat > "$OUT" <<'HEADER'
-- ============================================================================
-- TryEnto — INSTALACIÓN COMPLETA DE LA BASE DE DATOS
--
-- Este archivo junta las tres migraciones en una sola. Cópialo ENTERO y
-- pégalo en Supabase → SQL Editor → New query → Run.
--
-- Copia el CONTENIDO del archivo, no su nombre. En VS Code: abre este archivo,
-- Ctrl+A, Ctrl+C. O desde PowerShell, para copiarlo directo al portapapeles:
--
--   [System.IO.File]::ReadAllText("$PWD\supabase\SETUP_COMPLETO.sql") | Set-Clipboard
--
-- Después de correrlo:
--   Settings → API → "Exposed schemas" → agrega  app   ← imprescindible
--
-- GENERADO por tools/build-setup-sql.sh — no lo edites a mano.
-- Las fuentes son supabase/migrations/000*.sql
-- ============================================================================


HEADER

for f in supabase/migrations/0001_schema.sql supabase/migrations/0002_views.sql supabase/migrations/0003_seed.sql; do
  printf '\n\n-- ############################################################################\n' >> "$OUT"
  printf -- '-- %s\n' "$(basename "$f")" >> "$OUT"
  printf -- '-- ############################################################################\n\n' >> "$OUT"
  cat "$f" >> "$OUT"
done

echo "  $OUT  ($(wc -c < "$OUT") bytes)"
