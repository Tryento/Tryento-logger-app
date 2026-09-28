-- @setup-skip: reparacion para una base existente, no parte de la instalacion
-- ============================================================================
-- 0005 — Renombrar cochada -> lote en una base que ya existe.
--
-- CORRER SÓLO en una base creada ANTES del renombrado (la de producción).
-- Una base nueva ya nace con los nombres correctos; si igual lo corres ahí, no
-- hace nada malo. Es seguro correrlo dos veces.
--
-- ESTE ARCHIVO SE CORRIGIÓ ANTES DE APLICARSE EN NINGUNA BASE (verificado
-- contra producción el 2026-09-28). La versión anterior tenía tres defectos,
-- los tres reproducidos en Postgres real (test/sql-migrations.test.mjs):
--
--   1. Decía que después había que volver a correr SETUP_COMPLETO.sql "porque
--      es idempotente". No lo es: falla en su primera línea
--      (type "insectario_estado" already exists), así que las funciones y las
--      vistas nunca se habrían recreado.
--   2. No recreaba marcar_empacado ni marcar_despachado. Sus cuerpos venían de
--      0004 y decían "update app.cochada"; Postgres guarda el cuerpo como texto,
--      así que después del renombrado fallan con
--      type "app.cochada" does not exist.
--   3. No resolvía las sobrecargas duplicadas que dejó 0004 (eso lo hace 0006,
--      que sí va en la instalación nueva porque el problema existe en ambas).
--
-- Ahora este archivo hace todo solo. No hace falta correr nada más después,
-- salvo 0006.
-- ============================================================================

set search_path = app, public;


-- ── 1. Renombrar objetos (cada paso sólo si hace falta) ─────────────────────

do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'app' and table_name = 'cochada') then
    alter table app.cochada rename to lote;
  end if;

  if exists (select 1 from information_schema.tables
              where table_schema = 'app' and table_name = 'cochada_separacion') then
    alter table app.cochada_separacion rename to lote_separacion;
  end if;

  if exists (select 1 from information_schema.columns
              where table_schema = 'app' and table_name = 'lote_separacion'
                and column_name = 'cochada_id') then
    alter table app.lote_separacion rename column cochada_id to lote_id;
  end if;

  if exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
              where n.nspname = 'app' and t.typname = 'cochada_estado') then
    alter type app.cochada_estado rename to lote_estado;
  end if;
end $$;

-- Índices y triggers conservan su nombre viejo tras renombrar la tabla.
-- Funcionan igual, pero "ux_cochada_codigo" sobre app.lote confunde a quien lo
-- lea. Se salta cualquiera cuyo nombre nuevo ya exista.
do $$
declare r record;
begin
  for r in
    select indexname from pg_indexes
     where schemaname = 'app' and indexname like '%cochada%'
  loop
    if not exists (select 1 from pg_indexes
                    where schemaname = 'app'
                      and indexname = replace(r.indexname, 'cochada', 'lote')) then
      execute format('alter index app.%I rename to %I',
                     r.indexname, replace(r.indexname, 'cochada', 'lote'));
    end if;
  end loop;

  for r in
    select t.tgname, c.relname
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app' and not t.tgisinternal and t.tgname like '%cochada%'
  loop
    execute format('alter trigger %I on app.%I rename to %I',
                   r.tgname, r.relname, replace(r.tgname, 'cochada', 'lote'));
  end loop;
end $$;


-- ── 2. Borrar TODAS las funciones cuyo cuerpo o nombre dice "cochada" ───────
-- Incluye las dos sobrecargas que dejó 0004 de cada una.

drop function if exists app.crear_cochada(jsonb, uuid[]);
drop function if exists app.rechazar_cochada(uuid, text);
drop function if exists app.rechazar_cochada(uuid, text, text);
drop function if exists app.actualizar_qc_cochada(uuid, numeric, numeric, text, text, boolean, text);
drop function if exists app.actualizar_qc_cochada(uuid, numeric, numeric, text, text, boolean, text, text);
drop function if exists app.marcar_empacado(uuid, date);
drop function if exists app.marcar_empacado(uuid, date, text);
drop function if exists app.marcar_despachado(uuid);
drop function if exists app.marcar_despachado(uuid, text);


-- ── 3. Recrearlas contra app.lote ───────────────────────────────────────────
-- Idénticas a 0001 (crear_lote) y 0004 (el resto) tal como están hoy.

create or replace function app.crear_lote(p_lote jsonb, p_separacion_ids uuid[])
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  if p_separacion_ids is null or array_length(p_separacion_ids, 1) is null then
    raise exception 'un lote requiere al menos una separación' using errcode = '22023';
  end if;

  insert into app.lote (
    id, codigo, fecha, peso_inicial_kg, bandejas_metalicas_usadas, notas,
    registrado_por, dispositivo_id)
  values (
    (p_lote->>'id')::uuid,
    p_lote->>'codigo',
    (p_lote->>'fecha')::timestamptz,
    nullif(p_lote->>'peso_inicial_kg', '')::numeric,
    nullif(p_lote->>'bandejas_metalicas_usadas', '')::int,
    coalesce(p_lote->>'notas', ''),
    nullif(p_lote->>'registrado_por', ''),
    nullif(p_lote->>'dispositivo_id', '')::uuid)
  on conflict (id) do nothing
  returning * into r;

  if r.id is null then
    select * into r from app.lote where id = (p_lote->>'id')::uuid;
  end if;
  if r.id is null then
    raise exception 'no se pudo crear el lote' using errcode = '22023';
  end if;

  insert into app.lote_separacion (lote_id, separacion_id)
  select r.id, s from unnest(p_separacion_ids) s
  on conflict (lote_id, separacion_id) do nothing;

  return r;
end $$;

create or replace function app.actualizar_qc_lote(
  p_id uuid, p_tiempo numeric, p_peso_final numeric,
  p_color text, p_prueba text, p_aprobado boolean, p_foto_key text,
  p_por text default null)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  update app.lote set
    tiempo_secado_horas = coalesce(p_tiempo,     tiempo_secado_horas),
    peso_final_kg       = coalesce(p_peso_final, peso_final_kg),
    qc_color_dorado     = coalesce(p_color,      qc_color_dorado),
    qc_prueba_crujiente = coalesce(p_prueba,     qc_prueba_crujiente),
    qc_aprobado         = coalesce(p_aprobado,   qc_aprobado),
    qc_foto_key         = coalesce(p_foto_key,   qc_foto_key),
    qc_por              = coalesce(nullif(p_por, ''), qc_por)
   where id = p_id and despachado_at is null and rechazado_at is null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_empacado(p_id uuid, p_vencimiento date, p_por text default null)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  update app.lote
     set empacado_at = now(),
         empacado_por = coalesce(nullif(p_por, ''), empacado_por),
         fecha_vencimiento = coalesce(
           p_vencimiento, ((now() at time zone 'America/Caracas')::date + 180))
   where id = p_id and empacado_at is null and qc_aprobado is true
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_despachado(p_id uuid, p_por text default null)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  update app.lote
     set despachado_at = now(),
         despachado_por = coalesce(nullif(p_por, ''), despachado_por)
   where id = p_id and despachado_at is null and empacado_at is not null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.rechazar_lote(p_id uuid, p_motivo text, p_por text default null)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'motivo de rechazo requerido' using errcode = '22023';
  end if;
  update app.lote
     set rechazado_at = now(),
         rechazo_motivo = p_motivo,
         rechazado_por = coalesce(nullif(p_por, ''), rechazado_por),
         qc_aprobado = false
   where id = p_id and rechazado_at is null and despachado_at is null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;


-- ── 4. Vistas ───────────────────────────────────────────────────────────────
-- Se borran y se crean de nuevo porque cambian nombres de columnas
-- (dias_separacion_a_cochada -> dias_separacion_a_lote), cosa que
-- "create or replace view" no permite. Idénticas a 0002 tal como está hoy.

drop view if exists app.v_rendimiento_cochada;
drop view if exists app.v_cochadas_activas;
drop view if exists app.v_tiempos_ciclo;
drop view if exists app.v_rendimiento_lote;
drop view if exists app.v_calidad_datos;
drop view if exists app.v_lotes_activos;

create view app.v_tiempos_ciclo as
select
  b.id                                   as bandeja_id,
  b.id_bandeja,
  i.codigo                               as insectario,
  app.dia_local(b.fecha)                 as dia_siembra,
  extract(day from ay.fecha - b.fecha)::int           as dias_siembra_a_ayuno,
  extract(day from s.fecha - ay.fecha)::int           as dias_ayuno_a_separacion,
  extract(day from s.fecha - b.fecha)::int            as dias_ciclo_bandeja,
  extract(day from c.fecha - s.fecha)::int            as dias_separacion_a_lote,
  extract(day from c.despachado_at - b.fecha)::int    as dias_total_a_despacho
from app.bandeja b
join app.recoleccion r on r.id = b.recoleccion_id
join app.insectario  i on i.id = r.insectario_id
left join lateral (
  select * from app.ayuno a
  where a.bandeja_id = b.id and a.deleted_at is null
  order by a.fecha limit 1
) ay on true
left join app.separacion s on s.bandeja_id = b.id and s.deleted_at is null
left join app.lote_separacion cs on cs.separacion_id = s.id
left join app.lote c on c.id = cs.lote_id and c.deleted_at is null
where b.deleted_at is null
  and b.cerrada_admin_at is null;

create view app.v_rendimiento_lote as
select
  c.id,
  c.codigo,
  c.estado,
  app.dia_local(c.fecha)                          as dia,
  date_trunc('week', app.dia_local(c.fecha))::date as semana,
  c.peso_inicial_kg,
  c.peso_final_kg,
  c.rendimiento_pct,
  c.peso_inicial_kg - c.peso_final_kg             as kg_agua_evaporada,
  c.tiempo_secado_horas,
  c.qc_color_dorado,
  c.qc_aprobado,
  c.rechazado_at is not null                      as rechazada,
  c.rechazo_motivo,
  c.bandejas_metalicas_usadas,
  n.n_separaciones,
  n.g_larva_aportada,
  c.peso_inicial_kg / nullif(c.tiempo_secado_horas, 0) as kg_por_hora_secado,
  c.fecha_vencimiento,
  c.despachado_at,
  avg(c.rendimiento_pct) over (
    order by c.fecha rows between 4 preceding and current row
  ) as rendimiento_media_movil_5
from app.lote c
join lateral (
  select count(*)                              as n_separaciones,
         coalesce(sum(s.larva_limpia_g), 0)    as g_larva_aportada
  from app.lote_separacion cs
  join app.separacion s on s.id = cs.separacion_id
  where cs.lote_id = c.id
) n on true
where c.deleted_at is null;

create view app.v_calidad_datos as
select 'ayuno_huerfano_sin_resolver' as problema, count(*) as n
  from app.ayuno_huerfano where resuelto_at is null
union all
select 'ayuno_abierto_mas_48h', count(*)
  from app.ayuno
  where peso_final_kg is null
    and fecha < now() - interval '48 hours'
    and deleted_at is null
union all
select 'bandeja_sin_eventos_7d', count(*)
  from app.bandeja b
  where b.estado = 'en_crecimiento'
    and b.deleted_at is null
    and b.cerrada_admin_at is null
    and not exists (
      select 1 from app.alimentacion a
      where a.bandeja_id = b.id and a.fecha > now() - interval '7 days')
union all
select 'separacion_sin_lote_14d', count(*)
  from app.separacion s
  where s.deleted_at is null
    and s.fecha < now() - interval '14 days'
    and not exists (
      select 1 from app.lote_separacion cs where cs.separacion_id = s.id)
union all
select 'lote_empacada_sin_despachar_30d', count(*)
  from app.lote
  where empacado_at is not null
    and despachado_at is null
    and empacado_at < now() - interval '30 days'
    and deleted_at is null
union all
select 'lote_secando_mas_72h', count(*)
  from app.lote
  where estado = 'secando'
    and fecha < now() - interval '72 hours'
    and deleted_at is null
union all
select 'estado_bandeja_drift', count(*) from app.v_estado_drift;

create view app.v_lotes_activos as
  select * from app.lote
  where deleted_at is null and estado not in ('despachado', 'rechazado');


-- ── 5. Permisos ─────────────────────────────────────────────────────────────
-- Las vistas y funciones recién creadas necesitan los mismos permisos que el
-- resto. Los "default privileges" de 0001 deberían cubrirlas, pero dependen de
-- qué rol corre el script; esto no depende de eso.

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;
