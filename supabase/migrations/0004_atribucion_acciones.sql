-- ============================================================================
-- Quién hizo cada acción de un toque.
--
-- `registrado_por` en insectario y lote dice quién CREÓ el registro. No dice
-- quién marcó el atractante tres semanas después, ni quién despachó el lote
-- — y muchas veces no es la misma persona.
--
-- Las acciones de un toque sólo estampaban la fecha, así que ese dato se perdía.
-- Estas columnas lo guardan sin tocar nada de lo que ya existe: todas son
-- nullable, así que las filas actuales siguen válidas.
--
-- Correr después de 0003_seed.sql. Es seguro correrlo dos veces.
-- ============================================================================

set search_path = app, public;

alter table app.insectario
  add column if not exists fecha_ovipositores_por text,
  add column if not exists cierre_real_por        text;

alter table app.lote
  add column if not exists qc_por          text,
  add column if not exists empacado_por    text,
  add column if not exists despachado_por  text,
  add column if not exists rechazado_por   text;


-- ── RPCs: ahora reciben el nombre ──────────────────────────────────────────
--
-- Se agrega un parámetro con DEFAULT null en vez de cambiar la firma, para que
-- una app vieja que todavía llame con dos argumentos siga funcionando mientras
-- los dispositivos se actualizan.

create or replace function app.marcar_atractante(p_id uuid, p_fecha date, p_por text default null)
returns app.insectario language plpgsql set search_path = app, public as $$
declare r app.insectario;
begin
  update app.insectario
     set fecha_ovipositores = p_fecha,
         fecha_ovipositores_por = coalesce(nullif(p_por, ''), fecha_ovipositores_por)
   where id = p_id and fecha_ovipositores is null      -- el primero gana
  returning * into r;
  if r.id is null then select * into r from app.insectario where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_cierre(p_id uuid, p_fecha date, p_por text default null)
returns app.insectario language plpgsql set search_path = app, public as $$
declare r app.insectario;
begin
  update app.insectario
     set cierre_real = p_fecha,
         cierre_real_por = coalesce(nullif(p_por, ''), cierre_real_por)
   where id = p_id and cierre_real is null
  returning * into r;
  if r.id is null then select * into r from app.insectario where id = p_id; end if;
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
