-- @setup-skip: reparacion para una base existente, no parte de la instalacion
-- ============================================================================
-- Volver a "Lote", el nombre que usa la gente.
--
-- El modelo objetivo renombraba Lotes -> Cochada porque el responsable del
-- proceso dijo que "cochada va mejor" para describir una horneada. Es cierto,
-- pero el equipo lleva meses diciendo "lote" en AppSheet: quien abra esta app
-- tiene que poder trabajar sin aprender vocabulario nuevo. La precisión no
-- compensa la fricción del primer día.
--
-- Esto renombra en el lugar, sin tocar los datos. Correr sólo si ya creaste la
-- base con los nombres viejos. En una base nueva no hace falta: el esquema ya
-- viene con los nombres correctos.
--
-- Es seguro correrlo dos veces.
-- ============================================================================

set search_path = app, public;

do $$
begin
  -- ── tablas ───────────────────────────────────────────────────────────────
  if exists (select 1 from information_schema.tables
              where table_schema = 'app' and table_name = 'cochada') then
    alter table app.cochada rename to lote;
  end if;

  if exists (select 1 from information_schema.tables
              where table_schema = 'app' and table_name = 'cochada_separacion') then
    alter table app.cochada_separacion rename to lote_separacion;
  end if;

  -- ── columna de la tabla puente ───────────────────────────────────────────
  if exists (select 1 from information_schema.columns
              where table_schema = 'app' and table_name = 'lote_separacion'
                and column_name = 'cochada_id') then
    alter table app.lote_separacion rename column cochada_id to lote_id;
  end if;

  -- ── tipo enumerado ───────────────────────────────────────────────────────
  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'app' and t.typname = 'cochada_estado') then
    alter type app.cochada_estado rename to lote_estado;
  end if;
end $$;

-- Los índices conservan su nombre viejo tras un rename de tabla. Funcionan
-- igual, pero un índice llamado ux_cochada_codigo sobre app.lote confunde a
-- quien lo lea dentro de seis meses.
do $$
declare r record;
begin
  for r in
    select indexname from pg_indexes
    where schemaname = 'app' and indexname like '%cochada%'
  loop
    execute format('alter index app.%I rename to %I',
                   r.indexname, replace(r.indexname, 'cochada', 'lote'));
  end loop;
end $$;

-- ── funciones ──────────────────────────────────────────────────────────────
-- Se borran las viejas y se recrean con el nombre nuevo. Correr DESPUÉS de
-- esto el archivo 0001 (o SETUP_COMPLETO) vuelve a crearlas todas.
drop function if exists app.crear_cochada(jsonb, uuid[]);
drop function if exists app.rechazar_cochada(uuid, text);
drop function if exists app.rechazar_cochada(uuid, text, text);
drop function if exists app.actualizar_qc_cochada(uuid, numeric, numeric, text, text, boolean, text);
drop function if exists app.actualizar_qc_cochada(uuid, numeric, numeric, text, text, boolean, text, text);

-- ── vistas ─────────────────────────────────────────────────────────────────
drop view if exists app.v_rendimiento_cochada;
drop view if exists app.v_cochadas_activas;

-- ============================================================================
-- DESPUÉS DE ESTO: volver a correr supabase/SETUP_COMPLETO.sql.
--
-- Recrea las funciones y las vistas con los nombres nuevos. Es idempotente
-- (create table ... / on conflict do nothing), así que no duplica datos ni
-- borra lo que ya existe.
-- ============================================================================
