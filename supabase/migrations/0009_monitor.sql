-- ============================================================================
-- 0009 — Lo que toca hoy: temperatura de la cama y avisos del plan.
--
--   Días 11–12 la cama no debe pasar de 36 °C: se mide en una revisión.
--   La pantalla de inicio junta lo atrasado, lo de hoy y lo próximo; los
--   números que usa (máximo, días de control, días de previsión del stock)
--   están en app.parametro.
--
-- EN PRODUCCIÓN: correr DESPUÉS de 0008 y ANTES de publicar la app que lo usa.
-- Es seguro correrlo dos veces. También va en SETUP_COMPLETO. Sólo agrega:
-- ninguna función cambia.
-- ============================================================================

set search_path = app, public;


-- ── 1. Temperatura de la cama, en la revisión ─────────────────────────────

alter table app.revision add column if not exists temperatura_c numeric(5,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_revision_temperatura') then
    alter table app.revision add constraint ck_revision_temperatura
      check (temperatura_c is null or temperatura_c between -10 and 90);
  end if;
end $$;


-- ── 2. Parámetros del monitor ──────────────────────────────────────────────

insert into app.parametro (clave, valor, descripcion) values
  ('temperatura_cama_max_c',   '36',
     'Temperatura máxima de la cama (°C) en los días de control.'),
  ('dias_control_temperatura', '[11, 12]',
     'Días del ciclo en que se mide la temperatura de la cama.'),
  ('dias_stock_alerta',        '3',
     'Días hacia adelante en que la app revisa si el ensilaje listo alcanza para las cargas del plan.')
on conflict (clave) do nothing;


-- ── 3. Vistas ──────────────────────────────────────────────────────────────

-- Cada lectura de temperatura de cama: su día del ciclo y si pasó el máximo.
create or replace view app.v_temperatura_cama as
select
  r.id,
  r.bandeja_id,
  b.id_bandeja,
  inc.codigo                                 as incubadora,
  b.protocolo,
  app.dia_local(r.fecha)                     as dia,
  app.dia_local(r.fecha) - inc.fecha_inicio  as dia_ciclo,
  r.temperatura_c,
  r.temperatura_c > coalesce(
    (select (p.valor #>> '{}')::numeric from app.parametro p where p.clave = 'temperatura_cama_max_c'), 36)
                                             as sobre_maximo,
  r.registrado_por
from app.revision r
join app.bandeja b on b.id = r.bandeja_id and b.deleted_at is null
left join app.incubadora inc on inc.id = b.incubadora_id
where r.temperatura_c is not null
  and r.deleted_at is null;

-- Las mismas filas que 0007, más las camas que pasaron el máximo esta semana.
create or replace view app.v_calidad_datos as
select 'ayuno_huerfano_sin_resolver' as problema, count(*) as n
  from app.ayuno_huerfano where resuelto_at is null
union all
select 'ayuno_abierto_mas_48h', count(*)
  from app.ayuno
  where peso_final_kg is null
    and cerrado_at is null
    and fecha < now() - make_interval(hours => horas_ayuno + 24)
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
select 'estado_bandeja_drift', count(*) from app.v_estado_drift
union all
select 'carga_repetida', count(*)
  from (select 1 from app.alimentacion
         where carga is not null and deleted_at is null
         group by bandeja_id, carga having count(*) > 1) x
union all
select 'incubadora_sin_distribuir_10d', count(*)
  from app.incubadora
  where estado = 'incubando'
    and fecha_inicio < app.dia_local(now()) - 10
    and deleted_at is null
union all
select 'cama_sobre_maximo_7d', count(*)
  from app.v_temperatura_cama
  where sobre_maximo
    and dia >= app.dia_local(now()) - 7;


-- ── 4. Permisos ────────────────────────────────────────────────────────────

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;
