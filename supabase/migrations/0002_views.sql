-- ============================================================================
-- Analytics views, consumed by the Streamlit dashboard (Tryento/Dashboard-demo).
--
-- These are the numbers the AppSheet app could never answer, because the data
-- to answer them was either never linked (ayuno had no tray) or never recorded
-- (separacion and lotes had zero rows).
--
-- Plain views, NOT materialized: at a few thousand rows a refresh job buys
-- nothing measurable and adds a staleness question nobody wants to reason about.
--
-- Every date is reported in FARM-LOCAL days via app.dia_local(). Reporting in
-- UTC would move every evening event to the following day.
--
-- CONNECTION MODEL: Streamlit must NOT use the anon key through PostgREST — RLS
-- returns zero rows. It connects as `analytics_ro` (see the bottom of
-- 0001_schema.sql) through Supavisor in TRANSACTION mode, or a dashboard
-- refresh will exhaust the pool PostgREST is also using.
-- ============================================================================

set search_path = app, public;


-- 1 ── yield per tray -------------------------------------------------------
-- The core unit-economics question: how much clean larvae came out of the eggs
-- and starter that went in.
create or replace view app.v_rendimiento_bandeja as
select
  b.id                                   as bandeja_id,
  b.id_bandeja,
  b.estado,
  i.codigo                               as insectario,
  i.nombre_insectario,
  i.generacion_moscas,
  r.recolecta,
  app.dia_local(b.fecha)                 as dia_siembra,
  b.gramos_huevos,
  b.iniciador_g,
  b.tipo_iniciador,
  ay.peso_inicial_kg,
  ay.peso_final_kg,
  ay.merma_pct,
  s.larva_limpia_g,
  app.dia_local(s.fecha)                 as dia_separacion,
  s.larva_limpia_g / nullif(b.gramos_huevos, 0) as g_larva_por_g_huevo,
  s.larva_limpia_g / nullif(b.iniciador_g, 0)   as g_larva_por_g_iniciador
from app.bandeja b
join app.recoleccion r on r.id = b.recoleccion_id
join app.insectario  i on i.id = r.insectario_id
left join app.separacion s on s.bandeja_id = b.id and s.deleted_at is null
-- The most recent fast, if any. A tray can in principle be fasted more than
-- once; the last one is what preceded the harvest.
left join lateral (
  select * from app.ayuno a
  where a.bandeja_id = b.id and a.deleted_at is null
  order by a.fecha desc limit 1
) ay on true
where b.deleted_at is null
  and b.cerrada_admin_at is null;


-- 2 ── feed conversion ------------------------------------------------------
-- Only trays that were actually harvested: without a separacion there is no
-- denominator and an FCR of NULL would quietly skew every average.
create or replace view app.v_fcr_bandeja as
select
  b.id                                   as bandeja_id,
  b.id_bandeja,
  i.codigo                               as insectario,
  app.dia_local(b.fecha)                 as dia_siembra,
  f.kg_alimento_total,
  f.n_alimentaciones,
  s.larva_limpia_g / 1000.0              as kg_larva,
  f.kg_alimento_total / nullif(s.larva_limpia_g / 1000.0, 0) as fcr,
  (s.larva_limpia_g / 1000.0) / nullif(f.kg_alimento_total, 0) * 100 as conversion_pct
from app.bandeja b
join app.recoleccion r on r.id = b.recoleccion_id
join app.insectario  i on i.id = r.insectario_id
join app.separacion  s on s.bandeja_id = b.id and s.deleted_at is null
join lateral (
  select coalesce(sum(a.cantidad_kg), 0) as kg_alimento_total,
         count(*)                        as n_alimentaciones
  from app.alimentacion a
  where a.bandeja_id = b.id and a.deleted_at is null
) f on true
where b.deleted_at is null;


-- 3 ── cycle times ----------------------------------------------------------
create or replace view app.v_tiempos_ciclo as
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


-- 4 ── colony productivity --------------------------------------------------
create or replace view app.v_productividad_insectario as
select
  i.id,
  i.codigo,
  i.nombre_insectario,
  i.generacion_moscas,
  i.estado,
  i.fecha_inicio,
  i.cierre_real,
  i.biomasa_kg,
  i.poblacion_estimada,
  i.desviacion_ovipositores_dias,
  i.desviacion_cierre_dias,
  coalesce(i.cierre_real, current_date) - i.fecha_inicio as dias_operacion,
  count(distinct r.id)                                   as n_recolecciones,
  sum(r.huevos_g)                                        as huevos_g_total,
  sum(r.huevos_g) / nullif(i.biomasa_kg, 0)              as g_huevos_por_kg_biomasa,
  sum(r.huevos_g)
    / nullif(coalesce(i.cierre_real, current_date) - i.fecha_inicio, 0) as g_huevos_por_dia,
  count(distinct b.id)                                   as n_bandejas,
  sum(s.larva_limpia_g) / 1000.0                         as kg_larva_total,
  sum(s.larva_limpia_g) / nullif(sum(r.huevos_g), 0)     as g_larva_por_g_huevo
from app.insectario i
left join app.recoleccion r on r.insectario_id = i.id  and r.deleted_at is null
left join app.bandeja     b on b.recoleccion_id = r.id and b.deleted_at is null
left join app.separacion  s on s.bandeja_id = b.id     and s.deleted_at is null
where i.deleted_at is null
group by i.id;


-- 5 ── oven-run yield over time ---------------------------------------------
create or replace view app.v_rendimiento_lote as
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


-- 6 ── operator activity ----------------------------------------------------
-- Keyed on registrado_por: the name the person typed or tapped.
--
-- Grouped case-insensitively on a trimmed name, because free text means
-- "Maria", "maria" and " Maria " would otherwise be three different people.
-- The app offers previously-used names as one-tap chips specifically to keep
-- this clean, but the view should not depend on that having worked.
--
-- NOTE FOR WHOEVER PUTS THIS ON A DASHBOARD: this identity is self-asserted —
-- anyone can type any name. It is a coaching and workload view, NOT an audit
-- record, and should be introduced to the team as such. Presented as
-- surveillance it will simply degrade the quality of what gets logged.
create or replace view app.v_actividad_operario as
with ev as (
  select registrado_por, fecha, 'alimentacion' as t, cantidad_kg     as magnitud
    from app.alimentacion where deleted_at is null
  union all
  select registrado_por, fecha, 'ayuno',              peso_inicial_kg
    from app.ayuno        where deleted_at is null
  union all
  select registrado_por, fecha, 'revision',           null
    from app.revision     where deleted_at is null
  union all
  select registrado_por, fecha, 'separacion',         larva_limpia_g
    from app.separacion   where deleted_at is null
)
select
  lower(trim(ev.registrado_por))                   as operario_clave,
  min(trim(ev.registrado_por))                     as nombre,
  app.dia_local(ev.fecha)                          as dia,
  date_trunc('week', app.dia_local(ev.fecha))::date as semana,
  ev.t                                             as tipo_evento,
  count(*)                                         as n_eventos,
  sum(ev.magnitud)                                 as magnitud_total,
  min(ev.fecha)                                    as primer_evento,
  max(ev.fecha)                                    as ultimo_evento
from ev
where nullif(trim(ev.registrado_por), '') is not null
group by 1, 3, 4, 5;

-- Spot the near-duplicates that free text inevitably produces, so they can be
-- cleaned up with one UPDATE before they distort a month of reporting.
create or replace view app.v_nombres_registrados as
with ev as (
  select registrado_por, fecha from app.alimentacion where deleted_at is null
  union all select registrado_por, fecha from app.ayuno      where deleted_at is null
  union all select registrado_por, fecha from app.revision   where deleted_at is null
  union all select registrado_por, fecha from app.separacion where deleted_at is null
)
select trim(registrado_por) as nombre,
       count(*)             as n_registros,
       min(fecha)           as primero,
       max(fecha)           as ultimo
from ev
where nullif(trim(registrado_por), '') is not null
group by 1
order by 2 desc;


-- 7 ── feed consumption -----------------------------------------------------
create or replace view app.v_consumo_alimento as
select
  app.dia_local(a.fecha)                           as dia,
  date_trunc('week', app.dia_local(a.fecha))::date as semana,
  a.tipo_alimento,
  a.origen,
  count(*)                                         as n_eventos,
  count(distinct a.bandeja_id)                     as n_bandejas,
  sum(a.cantidad_kg)                               as kg_total
from app.alimentacion a
where a.deleted_at is null
group by 1, 2, 3, 4;


-- 8 ── data quality ---------------------------------------------------------
-- Not requested, but this is the one to put on the dashboard home: it is what
-- makes "the active/archive view has been silently wrong for months" a thing
-- that gets noticed in a day instead of a year.
create or replace view app.v_calidad_datos as
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


-- 9 ── the AppSheet slices, as views ----------------------------------------
-- Same idea the original app expressed with slices, but indexable and usable
-- from SQL and BI tools rather than only inside the app.
create or replace view app.v_bandejas_activas as
  select * from app.bandeja
  where deleted_at is null and cerrada_admin_at is null and estado <> 'cosechada';

create or replace view app.v_insectarios_activos as
  select * from app.insectario where deleted_at is null and estado = 'activo';

create or replace view app.v_lotes_activos as
  select * from app.lote
  where deleted_at is null and estado not in ('despachado', 'rechazado');
