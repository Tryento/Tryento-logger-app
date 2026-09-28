-- ============================================================================
-- 0006 — Quitar las sobrecargas duplicadas que dejó 0004.
--
-- 0004 quiso agregar un parámetro p_por "sin romper a las apps viejas" usando
-- `create or replace function ... (..., p_por text default null)`. En Postgres
-- una lista de parámetros distinta NO reemplaza la función: crea una SEGUNDA.
-- Quedaron dos versiones de cada una, y cualquier llamada sin p_por falla con:
--
--     function app.marcar_despachado(uuid) is not unique
--
-- Es decir, justo lo contrario de lo que 0004 quería: los teléfonos con la app
-- vieja dejaron de poder despachar, empacar o marcar atractante.
--
-- Al borrar las versiones viejas queda sólo la que tiene p_por con valor por
-- defecto, que acepta las dos formas de llamarla. Reproducido y verificado en
-- Postgres real en test/sql-migrations.test.mjs.
--
-- Va en la instalación nueva (SETUP_COMPLETO) y en producción, porque las dos
-- tienen el problema. Es seguro correrlo dos veces.
--
-- EN PRODUCCIÓN: correr después de 0005.
-- ============================================================================

set search_path = app, public;

drop function if exists app.marcar_atractante(uuid, date);
drop function if exists app.marcar_cierre(uuid, date);
drop function if exists app.marcar_empacado(uuid, date);
drop function if exists app.marcar_despachado(uuid);
drop function if exists app.rechazar_lote(uuid, text);
drop function if exists app.actualizar_qc_lote(uuid, numeric, numeric, text, text, boolean, text);
