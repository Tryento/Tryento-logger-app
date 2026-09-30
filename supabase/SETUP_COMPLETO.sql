-- ============================================================================
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


-- ############################################################################
-- 0001_schema.sql
-- ############################################################################

-- ============================================================================
-- TryEnto BSF Logger — schema (DEMO CONFIGURATION)
--
-- ┌────────────────────────────────────────────────────────────────────────┐
-- │  THIS DATABASE IS OPEN. No login, no password: anyone with the         │
-- │  Supabase URL and the public anon key can read, write and delete       │
-- │  everything. That is deliberate for the first demo.                    │
-- │  See the bottom of this file for exactly how to close it later —       │
-- │  it is a policy change, not a redesign.                                │
-- └────────────────────────────────────────────────────────────────────────┘
--
-- What is deliberately NOT simplified away, because it is the whole point of
-- replacing the AppSheet app:
--
--  * real foreign keys, including ayuno -> bandeja, which never existed
--  * `estado` as a real column, never inferred from a blank cell
--  * computed values that are absent (NULL) rather than wrong when an input
--    is missing — this is the fix for the -20,676-day values in the sheet
--  * a join table for lote <-> separacion, so an oven run can never point
--    at nothing
--  * one atomic bulk-feed operation, so the partial-row bug cannot recur
--
-- What IS simplified for the demo:
--
--  * no auth, no roles, no per-user policies
--  * `registrado_por` is plain TEXT — the person's name as typed. No operator
--    table, no foreign key, nothing to seed, and nothing that can reject a
--    write because a device has not synced yet.
--
-- Farm timezone: America/Caracas (UTC-4).
-- Tray labelling: the marker goes on the tray FIRST, so no_bandeja is typed by
--                 a human and (recoleccion_id, no_bandeja) is genuinely unique.
--
-- SUPABASE SETUP: this lives in schema `app`, not `public`. Add `app` under
-- Settings → API → "Exposed schemas", or every request returns 404.
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

create schema if not exists app;
set search_path = app, public;


-- ── enums ───────────────────────────────────────────────────────────────────

create type app.insectario_estado as enum ('activo', 'cerrado');
create type app.bandeja_estado    as enum ('en_crecimiento', 'en_ayuno', 'cosechada');
create type app.lote_estado    as enum ('secando', 'en_qc', 'empacado', 'despachado', 'rechazado');
create type app.origen_alim       as enum ('individual', 'grupal');


-- ── helpers ─────────────────────────────────────────────────────────────────

-- Farm-local calendar day. STABLE, not IMMUTABLE, because `at time zone` with a
-- named zone depends on the tz database — so it can NOT appear in a generated
-- column. Use it in views only.
create or replace function app.dia_local(ts timestamptz)
returns date language sql stable as $$
  select (ts at time zone 'America/Caracas')::date
$$;

create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.synced_at  := now();
  return new;
end $$;


-- ── catalogues ──────────────────────────────────────────────────────────────
-- Editable lists. In AppSheet these were buried in column metadata, which is
-- why nobody could add a fifth cage without opening the editor.

create table app.catalogo (
  id         uuid primary key,
  tipo       text not null,   -- nombre_insectario | tipo_alimento | tipo_iniciador | qc_color_dorado
  valor      text not null,
  orden      int  not null default 0,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  unique (tipo, valor)
);
create index ix_catalogo_tipo on app.catalogo(tipo, orden) where activo;


-- ── insectario ──────────────────────────────────────────────────────────────

create table app.insectario (
  id                      uuid primary key,
  codigo                  text not null,          -- 'ICA-0326', human-facing
  nombre_insectario       text not null,
  fecha_inicio            date not null,
  generacion_moscas       text,                   -- free text on purpose (F6, F7...)
  biomasa_kg              numeric(8,3) check (biomasa_kg >= 0),
  proyeccion_ovipositores date,
  proyeccion_cierre       date,
  fecha_ovipositores      date,
  cierre_real             date,
  notas                   text not null default '',

  poblacion_estimada bigint generated always as
    ((biomasa_kg * 50000)::bigint) stored,

  -- date - date is IMMUTABLE and NULL-propagating, so a deviation is simply
  -- ABSENT until the real date exists. This one line is the fix for the
  -- ~-20,676 values sitting in the live sheet, where AppSheet read a blank
  -- date as the epoch.
  desviacion_ovipositores_dias int generated always as
    (fecha_ovipositores - proyeccion_ovipositores) stored,
  desviacion_cierre_dias int generated always as
    (cierre_real - proyeccion_cierre) stored,

  estado app.insectario_estado generated always as
    (case when cierre_real is not null then 'cerrado'::app.insectario_estado
          else 'activo'::app.insectario_estado end) stored,

  registrado_por text,          -- the person's name, as typed
  created_by     uuid,          -- stub for when real logins arrive; null for now
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),   -- server clock, trustworthy
  deleted_at     timestamptz,

  check (cierre_real is null or fecha_ovipositores is null
         or cierre_real >= fecha_ovipositores)
);
create unique index ux_insectario_codigo on app.insectario(codigo) where deleted_at is null;
create index ix_insectario_updated on app.insectario(updated_at);


-- ── recoleccion ─────────────────────────────────────────────────────────────

create table app.recoleccion (
  id            uuid primary key,
  insectario_id uuid not null references app.insectario(id),
  recolecta     text not null,          -- per-colony ordinal, human-facing
  fecha         timestamptz not null,
  huevos_g      numeric(8,3) check (huevos_g >= 0),
  notas         text not null default '',

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
-- Scoped per colony, NOT global. A global counter cannot survive two devices
-- capturing offline; one person harvests one cage, so a scoped collision is
-- near-impossible — but the constraint must exist so the rare real one surfaces.
create unique index ux_recoleccion_ordinal
  on app.recoleccion(insectario_id, recolecta) where deleted_at is null;
create index ix_recoleccion_insectario on app.recoleccion(insectario_id, fecha desc);
create index ix_recoleccion_updated    on app.recoleccion(updated_at);


-- ── bandeja ─────────────────────────────────────────────────────────────────

create table app.bandeja (
  id             uuid primary key,
  recoleccion_id uuid not null references app.recoleccion(id),
  no_bandeja     int  not null check (no_bandeja > 0),
  id_bandeja     text not null,          -- 'ddmm.recolecta.n', the marker on the tray
  fecha          timestamptz not null,
  gramos_huevos  numeric(8,3) check (gramos_huevos >= 0),
  iniciador_g    numeric(8,1) check (iniciador_g >= 0),
  tipo_iniciador text,
  notas          text not null default '',

  -- Maintained by trigger. Its inputs live in OTHER tables, so a generated
  -- column is impossible here, not merely suboptimal.
  estado app.bandeja_estado not null default 'en_crecimiento',

  -- Administrative closure, for the ~9 months of migrated trays with no
  -- recorded harvest. DELIBERATELY separate from `estado`: state stays a pure
  -- function of physical events, and "we stopped tracking this" is a different
  -- kind of fact. Collapsing them is how you end up inferring state from blanks.
  cerrada_admin_at     timestamptz,
  cerrada_admin_motivo text,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,

  check (cerrada_admin_at is null or cerrada_admin_motivo is not null)
);
-- ENFORCED: the farm writes the number on the tray before entering it, so a
-- human assigns it and a duplicate is a real mistake worth surfacing.
create unique index ux_bandeja_no on app.bandeja(recoleccion_id, no_bandeja)
  where deleted_at is null;
create index ix_bandeja_estado on app.bandeja(estado)
  where deleted_at is null and cerrada_admin_at is null;
create index ix_bandeja_recoleccion on app.bandeja(recoleccion_id);
create index ix_bandeja_updated     on app.bandeja(updated_at);


-- ── tray events ─────────────────────────────────────────────────────────────

create table app.alimentacion (
  id            uuid primary key,
  bandeja_id    uuid not null references app.bandeja(id),
  fecha         timestamptz not null,
  tipo_alimento text not null,
  cantidad_kg   numeric(8,3) not null check (cantidad_kg >= 0),
  origen        app.origen_alim not null default 'individual',
  grupal_id     uuid,                    -- shared by one bulk-feed fan-out
  notas         text not null default '',
  foto_key      text,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index ix_alim_bandeja on app.alimentacion(bandeja_id, fecha desc);
create index ix_alim_grupal  on app.alimentacion(grupal_id) where grupal_id is not null;
create index ix_alim_updated on app.alimentacion(updated_at);

create table app.ayuno (
  id              uuid primary key,
  bandeja_id      uuid not null references app.bandeja(id),   -- THE missing link
  fecha           timestamptz not null,
  peso_inicial_kg numeric(8,3) not null check (peso_inicial_kg > 0),
  horas_ayuno     int not null default 24 check (horas_ayuno between 1 and 168),

  -- Filled on the SECOND visit ~24 h later, via app.cerrar_ayuno(). The
  -- prototype had no update path for these at all, which is why merma_pct was
  -- permanently null: a fast is two visits and only the first was modelled.
  peso_final_kg   numeric(8,3) check (peso_final_kg >= 0),
  cerrado_at      timestamptz,

  notas    text not null default '',
  foto_key text,

  merma_pct numeric(6,3) generated always as
    (case when peso_final_kg is null then null
          else (peso_inicial_kg - peso_final_kg) / nullif(peso_inicial_kg, 0) * 100
     end) stored,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,

  check (peso_final_kg is null or peso_final_kg <= peso_inicial_kg),
  -- One-directional: "closed" needs a weight, but a weight may exist without a
  -- close time. The historical sheet rows have a final weight and no record of
  -- when the second visit happened, and inventing one would be fabricating data.
  check (cerrado_at is null or peso_final_kg is not null)
);
create index ix_ayuno_bandeja on app.ayuno(bandeja_id, fecha desc);
create index ix_ayuno_abierto on app.ayuno(bandeja_id)
  where peso_final_kg is null and deleted_at is null;
create index ix_ayuno_updated on app.ayuno(updated_at);

create table app.revision (
  id         uuid primary key,
  bandeja_id uuid not null references app.bandeja(id),
  fecha      timestamptz not null,
  notas      text not null default '',
  foto_key   text,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index ix_rev_bandeja on app.revision(bandeja_id, fecha desc);
create index ix_rev_updated on app.revision(updated_at);

create table app.separacion (
  id             uuid primary key,
  bandeja_id     uuid not null references app.bandeja(id),
  fecha          timestamptz not null,
  larva_limpia_g numeric(10,2) not null check (larva_limpia_g >= 0),
  notas          text not null default '',
  foto_key       text,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
-- HARD invariant: a tray is separated once. Two offline devices CAN both pass
-- the client-side check and both sync — one then gets 23505 and lands in the
-- conflict inbox. Do NOT soften this to ON CONFLICT DO NOTHING; silently
-- dropping a recorded harvest is worse than the AppSheet bug being replaced.
create unique index ux_separacion_bandeja on app.separacion(bandeja_id)
  where deleted_at is null;
create index ix_sep_updated on app.separacion(updated_at);


-- ── lote (one oven run; AppSheet called this "Lote") ────────────────────

create table app.lote (
  id     uuid primary key,
  codigo text not null,
  fecha  timestamptz not null,

  peso_inicial_kg     numeric(10,3) check (peso_inicial_kg >= 0),
  tiempo_secado_horas numeric(6,2) check (tiempo_secado_horas >= 0),
  peso_final_kg       numeric(10,3) check (peso_final_kg >= 0),

  qc_color_dorado     text,
  qc_prueba_crujiente text not null default '',
  -- An explicit decision, NOT a side effect of entering a weight. In the
  -- prototype, typing peso_final_kg flipped the state and hid the very form
  -- that edits peso_final_kg, so a typo was uncorrectable.
  qc_aprobado         boolean,
  qc_foto_key         text,

  bandejas_metalicas_usadas int check (bandejas_metalicas_usadas > 0),

  empacado_at       timestamptz,
  fecha_vencimiento date,
  despachado_at     timestamptz,
  rechazado_at      timestamptz,
  rechazo_motivo    text,

  notas text not null default '',

  rendimiento_pct numeric(6,3) generated always as
    (case when peso_final_kg is null or coalesce(peso_inicial_kg, 0) = 0 then null
          else peso_final_kg / peso_inicial_kg * 100 end) stored,

  -- Same-row inputs => generated column, strictly better than a trigger.
  -- rechazado is terminal and outranks everything.
  estado app.lote_estado generated always as (
    case when rechazado_at  is not null then 'rechazado'::app.lote_estado
         when despachado_at is not null then 'despachado'::app.lote_estado
         when empacado_at   is not null then 'empacado'::app.lote_estado
         when qc_aprobado   is not null then 'en_qc'::app.lote_estado
         else 'secando'::app.lote_estado end) stored,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,

  -- A coherent lifecycle: only pack what passed, only reject what failed, only
  -- dispatch what was packed.
  check (empacado_at   is null or qc_aprobado is true),
  check (rechazado_at  is null or qc_aprobado is false),
  check (rechazado_at  is null or rechazo_motivo is not null),
  check (rechazado_at  is null or despachado_at is null),
  check (despachado_at is null or empacado_at is not null),
  check (despachado_at is null or despachado_at >= empacado_at)
);
create unique index ux_lote_codigo on app.lote(codigo) where deleted_at is null;
create index ix_lote_updated on app.lote(updated_at);

create table app.lote_separacion (
  lote_id    uuid not null references app.lote(id) on delete cascade,
  separacion_id uuid not null references app.separacion(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  synced_at     timestamptz not null default now(),
  primary key (lote_id, separacion_id)
);
-- "A separacion is pooled into at most one lote." A lote is a physical
-- oven run: if two operators pool the same harvest into two ovens, the database
-- is right and reality is already wrong, so this must surface loudly.
create unique index ux_sep_una_sola_lote on app.lote_separacion(separacion_id);
create index ix_cochsep_updated on app.lote_separacion(updated_at);


-- ── bandeja estado: trigger + reconciliation ───────────────────────────────

create or replace function app.recompute_bandeja_estado(p_id uuid)
returns void language plpgsql security definer set search_path = app, public as $$
declare v app.bandeja_estado;
begin
  select case
    when exists (select 1 from app.separacion s
                  where s.bandeja_id = p_id and s.deleted_at is null)
         then 'cosechada'::app.bandeja_estado
    when exists (select 1 from app.ayuno a
                  where a.bandeja_id = p_id and a.deleted_at is null)
         then 'en_ayuno'::app.bandeja_estado
    else 'en_crecimiento'::app.bandeja_estado
  end into v;

  -- IS DISTINCT FROM is load-bearing: without it updated_at bumps on every
  -- no-op write and the client's delta pull re-downloads the tray forever.
  update app.bandeja b set estado = v
   where b.id = p_id and b.estado is distinct from v;
end $$;

create or replace function app.trg_bandeja_estado()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    perform app.recompute_bandeja_estado(old.bandeja_id);
  else
    perform app.recompute_bandeja_estado(new.bandeja_id);
    if tg_op = 'UPDATE' and old.bandeja_id is distinct from new.bandeja_id then
      perform app.recompute_bandeja_estado(old.bandeja_id);
    end if;
  end if;
  return null;
end $$;

-- Full recompute on every fire, including DELETE: an escalate-only AFTER INSERT
-- trigger would strand a tray in en_ayuno when a mistaken ayuno is removed.
create trigger t_ayuno_estado
  after insert or update or delete on app.ayuno
  for each row execute function app.trg_bandeja_estado();

create trigger t_separacion_estado
  after insert or update or delete on app.separacion
  for each row execute function app.trg_bandeja_estado();

-- DELIBERATELY NOT on app.alimentacion. Feeding never changes estado; a trigger
-- there would bump updated_at on 30 trays per bulk feed and re-sync them all.

create or replace function app.recompute_all_bandeja_estados()
returns bigint language sql security definer set search_path = app, public as $$
  with calc as (
    select b.id, case
      when exists (select 1 from app.separacion s
                    where s.bandeja_id = b.id and s.deleted_at is null)
           then 'cosechada'::app.bandeja_estado
      when exists (select 1 from app.ayuno a
                    where a.bandeja_id = b.id and a.deleted_at is null)
           then 'en_ayuno'::app.bandeja_estado
      else 'en_crecimiento'::app.bandeja_estado end as e
    from app.bandeja b)
  , upd as (
    update app.bandeja b set estado = c.e from calc c
     where b.id = c.id and b.estado is distinct from c.e
    returning 1)
  select count(*) from upd;
$$;

-- Trigger-maintained denormalisation always drifts eventually; this makes it a
-- one-query check rather than an archaeology session.
create or replace view app.v_estado_drift as
  select b.id, b.id_bandeja, b.estado as almacenado, c.e as calculado
  from app.bandeja b
  join lateral (select case
    when exists (select 1 from app.separacion s
                  where s.bandeja_id = b.id and s.deleted_at is null)
         then 'cosechada'::app.bandeja_estado
    when exists (select 1 from app.ayuno a
                  where a.bandeja_id = b.id and a.deleted_at is null)
         then 'en_ayuno'::app.bandeja_estado
    else 'en_crecimiento'::app.bandeja_estado end as e) c on true
  where b.estado is distinct from c.e;


-- ── updated_at maintenance ─────────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'catalogo','insectario','recoleccion','bandeja',
    'alimentacion','ayuno','revision','separacion','lote','lote_separacion'
  ] loop
    execute format(
      'create trigger t_%1$s_touch before update on app.%1$I
         for each row execute function app.touch_updated_at()', t);
  end loop;
end $$;


-- ── compare-and-set RPCs ───────────────────────────────────────────────────
--
-- These are what make out-of-order offline sync safe. Each is idempotent and
-- commutative: whichever device syncs first wins, and the second is a harmless
-- no-op rather than an overwrite.

create or replace function app.marcar_atractante(p_id uuid, p_fecha date)
returns app.insectario language plpgsql set search_path = app, public as $$
declare r app.insectario;
begin
  update app.insectario set fecha_ovipositores = p_fecha
   where id = p_id and fecha_ovipositores is null      -- first write wins
  returning * into r;
  if r.id is null then select * into r from app.insectario where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_cierre(p_id uuid, p_fecha date)
returns app.insectario language plpgsql set search_path = app, public as $$
declare r app.insectario;
begin
  update app.insectario set cierre_real = p_fecha
   where id = p_id and cierre_real is null
  returning * into r;
  if r.id is null then select * into r from app.insectario where id = p_id; end if;
  return r;
end $$;

-- The write that makes merma_pct reachable at all.
create or replace function app.cerrar_ayuno(p_id uuid, p_peso numeric, p_at timestamptz)
returns app.ayuno language plpgsql set search_path = app, public as $$
declare r app.ayuno;
begin
  update app.ayuno set peso_final_kg = p_peso, cerrado_at = coalesce(p_at, now())
   where id = p_id and peso_final_kg is null
  returning * into r;
  if r.id is null then select * into r from app.ayuno where id = p_id; end if;
  return r;
end $$;

create or replace function app.actualizar_qc_lote(
  p_id uuid, p_tiempo numeric, p_peso_final numeric,
  p_color text, p_prueba text, p_aprobado boolean, p_foto_key text)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  -- Per-field last-write-wins: only overwrite what this call actually carries.
  update app.lote set
    tiempo_secado_horas = coalesce(p_tiempo,     tiempo_secado_horas),
    peso_final_kg       = coalesce(p_peso_final, peso_final_kg),
    qc_color_dorado     = coalesce(p_color,      qc_color_dorado),
    qc_prueba_crujiente = coalesce(p_prueba,     qc_prueba_crujiente),
    qc_aprobado         = coalesce(p_aprobado,   qc_aprobado),
    qc_foto_key         = coalesce(p_foto_key,   qc_foto_key)
   where id = p_id and despachado_at is null and rechazado_at is null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_empacado(p_id uuid, p_vencimiento date)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  update app.lote
     set empacado_at = now(),
         fecha_vencimiento = coalesce(
           p_vencimiento, ((now() at time zone 'America/Caracas')::date + 180))
   where id = p_id and empacado_at is null and qc_aprobado is true
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.marcar_despachado(p_id uuid)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  -- State guard the prototype lacked: it could dispatch before packing.
  update app.lote set despachado_at = now()
   where id = p_id and despachado_at is null and empacado_at is not null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

create or replace function app.rechazar_lote(p_id uuid, p_motivo text)
returns app.lote language plpgsql set search_path = app, public as $$
declare r app.lote;
begin
  if coalesce(trim(p_motivo), '') = '' then
    raise exception 'motivo de rechazo requerido' using errcode = '22023';
  end if;
  update app.lote set rechazado_at = now(), rechazo_motivo = p_motivo, qc_aprobado = false
   where id = p_id and rechazado_at is null and despachado_at is null
  returning * into r;
  if r.id is null then select * into r from app.lote where id = p_id; end if;
  return r;
end $$;

-- Bulk feed as ONE atomic unit. N independent writes would reintroduce exactly
-- the AppSheet partial-fan-out bug that left ~20 rows in the live sheet with a
-- tray reference but blank fecha, tipo and cantidad.
create or replace function app.log_alimentacion_grupal(p_rows jsonb)
returns setof app.alimentacion language sql set search_path = app, public as $$
  insert into app.alimentacion
    (id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, grupal_id,
     notas, registrado_por, dispositivo_id)
  select (r->>'id')::uuid, (r->>'bandeja_id')::uuid, (r->>'fecha')::timestamptz,
         r->>'tipo_alimento', (r->>'cantidad_kg')::numeric, 'grupal',
         (r->>'grupal_id')::uuid, coalesce(r->>'notas', ''),
         nullif(r->>'registrado_por', ''), nullif(r->>'dispositivo_id', '')::uuid
  from jsonb_array_elements(p_rows) r
  on conflict (id) do nothing
  returning *;
$$;

-- Create one oven run together with the harvests it pools, in a single
-- transaction. Two separate writes are how the old Lotes table ended up
-- pointing at nothing.
--
-- The two conflict behaviours are deliberately different:
--   PK (lote_id, separacion_id) DO NOTHING -> retrying THIS lote after a
--     lost acknowledgement is idempotent.
--   ux_sep_una_sola_lote is NOT handled    -> a separacion already pooled
--     elsewhere raises 23505, the whole function rolls back, and the client
--     surfaces it in the conflict inbox.
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


-- ── migration support ──────────────────────────────────────────────────────

-- Orphan ayuno rows: the live sheet has no tray link at all, so every
-- historical row is unattributable. They land here, where neither the FK nor
-- the estado trigger can see them, and a human resolves them. A sentinel
-- "unknown tray" would poison every downstream analytic and is precisely the
-- infer-from-a-blank failure this rebuild exists to remove.
create table app.ayuno_huerfano (
  id                  uuid primary key,
  raw                 jsonb not null,
  fecha               timestamptz,
  peso_inicial_kg     numeric,
  horas_ayuno         int,
  peso_final_kg       numeric,
  operario_texto      text,
  bandeja_id_sugerida uuid references app.bandeja(id),
  confianza           numeric,
  resuelto_at         timestamptz,
  ayuno_id            uuid references app.ayuno(id),
  created_at          timestamptz not null default now()
);

create table app.migracion_log (
  id         bigserial primary key,
  tipo       text not null,
  n          bigint not null,
  detalle    jsonb,
  created_at timestamptz not null default now()
);


-- ── access ─────────────────────────────────────────────────────────────────
--
-- DEMO: fully open. Supabase's `anon` role is what an unauthenticated request
-- uses, and here it can do everything.
--
-- A custom schema gets NO grants by default — without these every request fails
-- with "permission denied for schema app", which looks nothing like a
-- permissions problem from the browser.

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;

alter default privileges in schema app grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema app grant all on routines  to anon, authenticated, service_role;
alter default privileges in schema app grant all on sequences to anon, authenticated, service_role;

-- RLS is ENABLED with a permissive policy rather than left off, so tightening
-- later means editing one policy per table instead of remembering to turn RLS
-- on at all — a step that is very easy to forget and silent when missed.
do $$
declare t text;
begin
  foreach t in array array[
    'catalogo','insectario','recoleccion','bandeja','alimentacion','ayuno',
    'revision','separacion','lote','lote_separacion',
    'ayuno_huerfano','migracion_log'
  ] loop
    execute format('alter table app.%I enable row level security', t);
    execute format(
      'create policy demo_abierto on app.%I for all to anon, authenticated
         using (true) with check (true)', t);
  end loop;
end $$;


-- ============================================================================
-- CLOSING THIS LATER — for reference. No schema change is required.
--
--  1. Supabase → Authentication → Providers → enable Google.
--  2. app-config.js:  authMode: 'google'
--  3. Replace the open policy on each table, e.g.:
--       drop policy demo_abierto on app.alimentacion;
--       create policy leer  on app.alimentacion for select to authenticated using (true);
--       create policy crear on app.alimentacion for insert to authenticated with check (true);
--       -- and simply no update/delete policy, so neither is possible
--     then: revoke all on all tables in schema app from anon;
--  4. `created_by` is already on every table, unused and null. Start populating
--     it with auth.uid() and you have an audit trail with no migration.
--
-- `registrado_por` is TEXT — who physically did the work, as typed. It stays
-- correct regardless of how login works, which is why it is separate from
-- created_by. To normalise it into a real table later:
--
--   create table app.operario (id uuid primary key default gen_random_uuid(),
--                              nombre text not null unique);
--   insert into app.operario (nombre)
--     select distinct registrado_por from app.alimentacion
--      where registrado_por is not null;
--   -- then add operario_id columns and backfill by name
-- ============================================================================


-- ############################################################################
-- 0002_views.sql
-- ############################################################################

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


-- ############################################################################
-- 0003_seed.sql
-- ############################################################################

-- ============================================================================
-- Reference data.
--
-- Catalogues are data, not code: adding a fifth cage or a new feed type is a
-- row here, never a redeploy. In AppSheet these lists were buried in column
-- metadata, which is why nobody could change them without opening the editor.
--
-- There is deliberately NO operator table. `registrado_por` is plain text —
-- whatever name the person typed or tapped — so there is nothing to seed and
-- nothing that can reject a write because a device has not synced yet.
-- ============================================================================

set search_path = app, public;

insert into app.catalogo (id, tipo, valor, orden) values
  (gen_random_uuid(), 'nombre_insectario', 'ICA',  1),
  (gen_random_uuid(), 'nombre_insectario', 'ICB',  2),
  (gen_random_uuid(), 'nombre_insectario', 'ICC',  3),
  (gen_random_uuid(), 'nombre_insectario', 'JN3A', 4),

  (gen_random_uuid(), 'tipo_iniciador', 'Bagazo',  1),
  (gen_random_uuid(), 'tipo_iniciador', 'Afrecho', 2),
  (gen_random_uuid(), 'tipo_iniciador', 'Yogurt',  3),
  (gen_random_uuid(), 'tipo_iniciador', 'Otro',    4),

  (gen_random_uuid(), 'tipo_alimento', 'Bagazo',  1),
  (gen_random_uuid(), 'tipo_alimento', 'Yogurt',  2),
  (gen_random_uuid(), 'tipo_alimento', 'Afrecho', 3),
  (gen_random_uuid(), 'tipo_alimento', 'Mezcla',  4),

  (gen_random_uuid(), 'qc_color_dorado', 'Blando',         1),
  (gen_random_uuid(), 'qc_color_dorado', 'Poco Crujiente', 2),
  (gen_random_uuid(), 'qc_color_dorado', 'Muy Crujiente',  3),
  (gen_random_uuid(), 'qc_color_dorado', 'Tostado',        4),

  -- The people already registered. These appear as one-tap chips on every
  -- device. Anyone whose name is not here types it once on the name screen and
  -- it joins this list automatically, so the roster maintains itself.
  --
  -- To add someone from SQL instead:
  --   insert into app.catalogo (id, tipo, valor, orden)
  --   values (gen_random_uuid(), 'operario', 'Jose', 3)
  --   on conflict (tipo, valor) do nothing;
  --
  -- To retire someone (never delete — records reference the name):
  --   update app.catalogo set activo = false
  --    where tipo = 'operario' and valor = 'Jose';
  (gen_random_uuid(), 'operario', 'Maria',   1),
  (gen_random_uuid(), 'operario', 'Ricardo', 2)
on conflict (tipo, valor) do nothing;


-- ── photo storage ──────────────────────────────────────────────────────────
-- Public bucket for the demo, matching the rest of the setup: no signed URLs to
-- manage, photos just load. Flip `public` to false when the database is closed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public;

-- Anyone may read and write photos, same as the tables.
-- `upsert: true` on a retry issues an UPDATE, so that policy is required for
-- the photo upload lane to be idempotent after a lost acknowledgement.
drop policy if exists fotos_todo on storage.objects;
create policy fotos_todo on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'fotos') with check (bucket_id = 'fotos');


-- ############################################################################
-- 0004_atribucion_acciones.sql
-- ############################################################################

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


-- ############################################################################
-- 0006_sobrecargas.sql
-- ############################################################################

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


-- ############################################################################
-- 0007_protocolo_v2.sql
-- ############################################################################

-- ============================================================================
-- 0007 — Protocolo v2: el ciclo de 16 días.
--
--   Recolecta ─► Incubadora (día 0–7) ─► día 7: distribución en bandejas +
--   carga 1 ─► día 10: carga 2 ─► día 13: carga 3 ─► días 14–15: ayuno ─►
--   día 16: cosecha (≈98 % a horneado, ≈2 % al laboratorio)
--
-- EN PRODUCCIÓN: correr DESPUÉS de 0005 y 0006, y ANTES de publicar la app que
-- lo usa. Es seguro correrlo dos veces. También va en SETUP_COMPLETO.
--
-- Qué NO hace, a propósito:
--   * No convierte datos viejos. Todo lo existente queda marcado `v1` por el
--     valor por defecto de la columna nueva. Agregar una columna con valor por
--     defecto no toca `updated_at`, así que los teléfonos no vuelven a bajar
--     todo; la app trata "sin protocolo" como v1.
--   * No renombra nada.
--   * No agrega parámetros a funciones existentes con `create or replace`
--     (así fue como 0004 dejó funciones duplicadas). cerrar_ayuno cambia de
--     firma: se borra la vieja y se crea la nueva en este mismo archivo.
--
-- Números del protocolo (días, kg, larvas por bandeja): tabla app.parametro.
-- Se cambian ahí, en el editor de tablas de Supabase, sin tocar la app.
-- ============================================================================

set search_path = app, public;


-- ── 1. Protocolo en cada registro de producción ────────────────────────────

alter table app.recoleccion  add column if not exists protocolo text not null default 'v1';
alter table app.bandeja      add column if not exists protocolo text not null default 'v1';
alter table app.alimentacion add column if not exists protocolo text not null default 'v1';
alter table app.ayuno        add column if not exists protocolo text not null default 'v1';
alter table app.separacion   add column if not exists protocolo text not null default 'v1';

do $$
declare t text;
begin
  foreach t in array array['recoleccion','bandeja','alimentacion','ayuno','separacion'] loop
    if not exists (select 1 from pg_constraint where conname = 'ck_' || t || '_protocolo') then
      execute format('alter table app.%I add constraint %I check (protocolo in (''v1'', ''v2''))',
                     t, 'ck_' || t || '_protocolo');
    end if;
  end loop;
end $$;


-- ── 2. Parámetros del protocolo ────────────────────────────────────────────
-- Sólo lectura para la app. Si falta una clave, la app usa su valor de fábrica
-- (src/data/protocolo.js), que es el mismo que se siembra aquí.

create table if not exists app.parametro (
  id          uuid primary key default gen_random_uuid(),
  clave       text not null,
  valor       jsonb,
  descripcion text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default now()
);
create unique index if not exists ux_parametro_clave on app.parametro(clave);
create index if not exists ix_parametro_updated on app.parametro(updated_at);

insert into app.parametro (clave, valor, descripcion) values
  ('dias_incubacion',        '7',
     'Día del ciclo en que se distribuye la incubadora en bandejas.'),
  ('cargas',                 '[{"n":1,"dia":7,"kg":1.5},{"n":2,"dia":10,"kg":2.0,"tamizado":true},{"n":3,"dia":13,"kg":2.0}]',
     'Cargas de ensilaje por bandeja: número, día del ciclo y kg.'),
  ('dia_inicio_ayuno',       '14',
     'Día del ciclo en que empieza el ayuno.'),
  ('horas_ayuno',            '48',
     'Horas de ayuno (días 14 y 15).'),
  ('dia_cosecha',            '16',
     'Día del ciclo de la cosecha.'),
  ('individuos_por_bandeja', '25000',
     'Larvas por bandeja que propone la app al distribuir.'),
  ('reserva_cria_pct',       '2',
     'Porcentaje de la cosecha que va al laboratorio (referencia).'),
  ('letras_insectario',      '{"ICA":"A","ICB":"B","ICC":"C","JN3A":"J"}',
     'Letra de cada insectario en el código de la incubadora (F7AR9).'),
  ('fecha_corte',            'null',
     'Desde esta fecha (AAAA-MM-DD) las recolectas nuevas usan el protocolo v2. Vacío = ya rige.')
on conflict (clave) do nothing;


-- ── 3. Recolecta v2 ─────────────────────────────────────────────────────────
-- huevos_g queda como dato del protocolo anterior.

alter table app.recoleccion add column if not exists peso_ovipositores_g numeric(10,2);
alter table app.recoleccion add column if not exists atrayente_cambiado  boolean;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_recoleccion_peso_ovipositores') then
    alter table app.recoleccion add constraint ck_recoleccion_peso_ovipositores
      check (peso_ovipositores_g is null or peso_ovipositores_g >= 0);
  end if;
end $$;


-- ── 4. Incubadora: una por recolecta, días 0 a 7 ───────────────────────────

create table if not exists app.incubadora (
  id               uuid primary key,
  recoleccion_id   uuid not null references app.recoleccion(id),
  codigo           text not null,                 -- F7AR9: generación, insectario, recolecta
  fecha_inicio     date not null,                 -- día 0 del ciclo
  starter_kg       numeric(8,3) check (starter_kg >= 0),
  individuos_total int check (individuos_total >= 0),
  notas            text not null default '',

  distribuida_at   timestamptz,
  distribuida_por  text,

  -- Mismo criterio que lote: estado a partir de la misma fila, nunca inferido
  -- de un campo vacío en otra tabla.
  estado text generated always as
    (case when distribuida_at is not null then 'distribuida' else 'incubando' end) stored,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_incubadora_recoleccion
  on app.incubadora(recoleccion_id) where deleted_at is null;
-- El código va escrito en las bandejas: dos teléfonos no pueden usar el mismo.
create unique index if not exists ux_incubadora_codigo
  on app.incubadora(codigo) where deleted_at is null;
create index if not exists ix_incubadora_updated on app.incubadora(updated_at);


-- ── 5. Bandeja: sale de una incubadora en v2 ───────────────────────────────
-- recoleccion_id se sigue llenando (la de su incubadora), así que todo lo que
-- ya une bandeja -> recolección -> insectario sigue funcionando igual.

alter table app.bandeja add column if not exists incubadora_id uuid references app.incubadora(id);
alter table app.bandeja add column if not exists individuos    int;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_bandeja_individuos') then
    alter table app.bandeja add constraint ck_bandeja_individuos
      check (individuos is null or individuos >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_bandeja_v2_incubadora') then
    alter table app.bandeja add constraint ck_bandeja_v2_incubadora
      check (protocolo <> 'v2' or incubadora_id is not null);
  end if;
end $$;
create index if not exists ix_bandeja_incubadora on app.bandeja(incubadora_id)
  where incubadora_id is not null;


-- ── 6. Alimentación: cargas fijas ──────────────────────────────────────────
-- v2: tipo_alimento = 'Ensilaje' y cantidad_kg = los kg de esa carga según el
-- plan, así las columnas obligatorias y las vistas existentes siguen valiendo.

alter table app.alimentacion add column if not exists carga    smallint;
alter table app.alimentacion add column if not exists tamizado boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_alimentacion_carga') then
    alter table app.alimentacion add constraint ck_alimentacion_carga
      check (carga is null or carga between 1 and 20);
  end if;
end $$;


-- ── 7. Ayuno: un toque en v2, pesar es opcional ────────────────────────────

alter table app.ayuno alter column peso_inicial_kg drop not null;
alter table app.ayuno add column if not exists cerrado_por text;

-- La regla vieja "cerrar exige peso final" (0001) se reemplaza: en v2 la
-- cosecha cierra el ayuno aunque nadie lo haya pesado.
do $$
declare c text;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'app.ayuno'::regclass and contype = 'c'
       and conname <> 'ck_ayuno_cierre'
       and pg_get_constraintdef(oid) ilike '%cerrado_at IS NULL%'
       and pg_get_constraintdef(oid) ilike '%peso_final_kg IS NOT NULL%'
  loop
    execute format('alter table app.ayuno drop constraint %I', c);
  end loop;

  if not exists (select 1 from pg_constraint where conname = 'ck_ayuno_cierre') then
    alter table app.ayuno add constraint ck_ayuno_cierre
      check (cerrado_at is null or peso_final_kg is not null or protocolo = 'v2');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ck_ayuno_peso_v1') then
    alter table app.ayuno add constraint ck_ayuno_peso_v1
      check (protocolo = 'v2' or peso_inicial_kg is not null);
  end if;
end $$;

drop function if exists app.cerrar_ayuno(uuid, numeric, timestamptz);
create or replace function app.cerrar_ayuno(
  p_id uuid, p_peso numeric, p_at timestamptz, p_por text default null)
returns app.ayuno language plpgsql set search_path = app, public as $$
declare r app.ayuno;
begin
  -- Abierto = sin fecha de cierre y sin peso final. Un ayuno viejo que ya tenía
  -- peso final (importado de la planilla) se deja como está.
  update app.ayuno
     set peso_final_kg = coalesce(p_peso, peso_final_kg),
         cerrado_at    = coalesce(p_at, now()),
         cerrado_por   = coalesce(nullif(p_por, ''), cerrado_por)
   where id = p_id and cerrado_at is null and peso_final_kg is null
  returning * into r;
  if r.id is null then select * into r from app.ayuno where id = p_id; end if;
  return r;
end $$;


-- ── 8. Cosecha: la parte que va al laboratorio ─────────────────────────────
-- larva_limpia_g = lo que va a horneado (lo que suma al Lote).

alter table app.separacion add column if not exists reserva_cria_g numeric(10,2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ck_separacion_reserva') then
    alter table app.separacion add constraint ck_separacion_reserva
      check (reserva_cria_g is null or reserva_cria_g >= 0);
  end if;
end $$;


-- ── 9. El protocolo de un evento es el de su bandeja ───────────────────────
-- La app ya lo manda así; esto lo garantiza aunque escriba una versión vieja
-- de la app que todavía está en caché en algún teléfono.

create or replace function app.trg_protocolo_de_bandeja()
returns trigger language plpgsql set search_path = app, public as $$
declare v text;
begin
  select b.protocolo into v from app.bandeja b where b.id = new.bandeja_id;
  new.protocolo := coalesce(v, new.protocolo, 'v1');
  return new;
end $$;

create or replace trigger t_alimentacion_protocolo before insert on app.alimentacion
  for each row execute function app.trg_protocolo_de_bandeja();
create or replace trigger t_ayuno_protocolo before insert on app.ayuno
  for each row execute function app.trg_protocolo_de_bandeja();
create or replace trigger t_separacion_protocolo before insert on app.separacion
  for each row execute function app.trg_protocolo_de_bandeja();


-- ── 10. Funciones del flujo v2 ─────────────────────────────────────────────
-- Cada una valida su entrada ANTES de escribir, así que llamarla vacía (como
-- hace tools/check-sql-applied.mjs para ver si existe) no escribe nada.

-- Recolecta + su incubadora, juntas o ninguna.
create or replace function app.crear_recoleccion_v2(p_recoleccion jsonb, p_incubadora jsonb)
returns app.incubadora language plpgsql set search_path = app, public as $$
declare
  v_rec uuid := nullif(p_recoleccion->>'id', '')::uuid;
  v_inc uuid := nullif(p_incubadora->>'id', '')::uuid;
  r app.incubadora;
begin
  if v_rec is null or v_inc is null
     or nullif(p_recoleccion->>'insectario_id', '') is null
     or nullif(p_recoleccion->>'recolecta', '') is null
     or nullif(p_recoleccion->>'fecha', '') is null
     or nullif(p_incubadora->>'codigo', '') is null
     or nullif(p_incubadora->>'fecha_inicio', '') is null then
    raise exception 'recolecta incompleta' using errcode = '22023';
  end if;

  insert into app.recoleccion (
    id, insectario_id, recolecta, fecha, peso_ovipositores_g, atrayente_cambiado,
    notas, protocolo, registrado_por, created_by, dispositivo_id, created_at)
  values (
    v_rec,
    (p_recoleccion->>'insectario_id')::uuid,
    p_recoleccion->>'recolecta',
    (p_recoleccion->>'fecha')::timestamptz,
    nullif(p_recoleccion->>'peso_ovipositores_g', '')::numeric,
    nullif(p_recoleccion->>'atrayente_cambiado', '')::boolean,
    coalesce(p_recoleccion->>'notas', ''),
    'v2',
    nullif(p_recoleccion->>'registrado_por', ''),
    nullif(p_recoleccion->>'created_by', '')::uuid,
    nullif(p_recoleccion->>'dispositivo_id', '')::uuid,
    coalesce(nullif(p_recoleccion->>'created_at', '')::timestamptz, now()))
  on conflict (id) do nothing;

  insert into app.incubadora (
    id, recoleccion_id, codigo, fecha_inicio, starter_kg, notas,
    registrado_por, created_by, dispositivo_id, created_at)
  values (
    v_inc,
    v_rec,
    p_incubadora->>'codigo',
    (p_incubadora->>'fecha_inicio')::date,
    nullif(p_incubadora->>'starter_kg', '')::numeric,
    coalesce(p_incubadora->>'notas', ''),
    nullif(p_incubadora->>'registrado_por', ''),
    nullif(p_incubadora->>'created_by', '')::uuid,
    nullif(p_incubadora->>'dispositivo_id', '')::uuid,
    coalesce(nullif(p_incubadora->>'created_at', '')::timestamptz, now()))
  on conflict (id) do nothing;

  select * into r from app.incubadora where id = v_inc;
  return r;
end $$;

-- Día 7: la incubadora se reparte en N bandejas y reciben la carga 1, todo
-- junto. "Transferencia y primera carga" es una sola acción en el protocolo.
--
--   p_distribucion: {incubadora_id, fecha, registrado_por, individuos_total}
--   p_bandejas:     [{id, no_bandeja, id_bandeja, individuos, ...}]
--   p_cargas:       [{id, bandeja_id, fecha, cantidad_kg, carga, grupal_id, ...}]
create or replace function app.distribuir_incubadora(
  p_distribucion jsonb, p_bandejas jsonb, p_cargas jsonb)
returns app.incubadora language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_distribucion->>'incubadora_id', '')::uuid;
  v_at  timestamptz := coalesce(nullif(p_distribucion->>'fecha', '')::timestamptz, now());
  v_por text := nullif(p_distribucion->>'registrado_por', '');
  inc app.incubadora;
begin
  if v_id is null or p_bandejas is null or jsonb_typeof(p_bandejas) <> 'array'
     or jsonb_array_length(p_bandejas) = 0 then
    raise exception 'distribución incompleta' using errcode = '22023';
  end if;

  select * into inc from app.incubadora where id = v_id and deleted_at is null;
  if inc.id is null then
    raise exception 'la incubadora % no existe en el servidor', v_id using errcode = '23503';
  end if;

  if inc.distribuida_at is not null then
    -- La misma distribución otra vez (se perdió la respuesta): ya está todo.
    if exists (select 1 from app.bandeja b where b.id = (p_bandejas->0->>'id')::uuid) then
      return inc;
    end if;
    raise exception 'La incubadora % ya fue distribuida desde otro teléfono.', inc.codigo
      using errcode = '23505';
  end if;

  insert into app.bandeja (
    id, recoleccion_id, incubadora_id, no_bandeja, id_bandeja, fecha, individuos,
    notas, protocolo, registrado_por, created_by, dispositivo_id, created_at)
  select
    (b->>'id')::uuid, inc.recoleccion_id, inc.id,
    (b->>'no_bandeja')::int, b->>'id_bandeja', v_at,
    nullif(b->>'individuos', '')::int,
    coalesce(b->>'notas', ''), 'v2',
    coalesce(nullif(b->>'registrado_por', ''), v_por),
    nullif(b->>'created_by', '')::uuid,
    nullif(b->>'dispositivo_id', '')::uuid,
    coalesce(nullif(b->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(p_bandejas) b
  on conflict (id) do nothing;

  insert into app.alimentacion (
    id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, grupal_id, carga,
    tamizado, notas, registrado_por, created_by, dispositivo_id, created_at)
  select
    (c->>'id')::uuid, (c->>'bandeja_id')::uuid,
    coalesce(nullif(c->>'fecha', '')::timestamptz, v_at),
    coalesce(nullif(c->>'tipo_alimento', ''), 'Ensilaje'),
    (c->>'cantidad_kg')::numeric, 'grupal',
    nullif(c->>'grupal_id', '')::uuid,
    nullif(c->>'carga', '')::smallint,
    coalesce(nullif(c->>'tamizado', '')::boolean, false),
    coalesce(c->>'notas', ''),
    coalesce(nullif(c->>'registrado_por', ''), v_por),
    nullif(c->>'created_by', '')::uuid,
    nullif(c->>'dispositivo_id', '')::uuid,
    coalesce(nullif(c->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_cargas, '[]'::jsonb)) c
  on conflict (id) do nothing;

  update app.incubadora
     set distribuida_at   = v_at,
         distribuida_por  = coalesce(v_por, distribuida_por),
         individuos_total = coalesce(nullif(p_distribucion->>'individuos_total', '')::int,
                                     individuos_total)
   where id = inc.id and distribuida_at is null
  returning * into inc;
  return inc;
end $$;

-- Alimentación en grupo: misma firma que 0001 (sólo jsonb), ahora guarda
-- también la carga, el tamizado, quién y cuándo.
create or replace function app.log_alimentacion_grupal(p_rows jsonb)
returns setof app.alimentacion language sql set search_path = app, public as $$
  insert into app.alimentacion
    (id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, grupal_id, carga,
     tamizado, notas, registrado_por, created_by, dispositivo_id, created_at)
  select (r->>'id')::uuid, (r->>'bandeja_id')::uuid, (r->>'fecha')::timestamptz,
         r->>'tipo_alimento', (r->>'cantidad_kg')::numeric, 'grupal',
         (r->>'grupal_id')::uuid,
         nullif(r->>'carga', '')::smallint,
         coalesce(nullif(r->>'tamizado', '')::boolean, false),
         coalesce(r->>'notas', ''),
         nullif(r->>'registrado_por', ''),
         nullif(r->>'created_by', '')::uuid,
         nullif(r->>'dispositivo_id', '')::uuid,
         coalesce(nullif(r->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(p_rows) r
  on conflict (id) do nothing
  returning *;
$$;


-- ── 11. Mantenimiento, acceso ──────────────────────────────────────────────

create or replace trigger t_incubadora_touch before update on app.incubadora
  for each row execute function app.touch_updated_at();
create or replace trigger t_parametro_touch before update on app.parametro
  for each row execute function app.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['incubadora', 'parametro'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists demo_abierto on app.%I', t);
    execute format(
      'create policy demo_abierto on app.%I for all to anon, authenticated
         using (true) with check (true)', t);
  end loop;
end $$;


-- ── 12. Vistas: separar por protocolo ──────────────────────────────────────
-- `create or replace view` sólo permite agregar columnas al final, así que las
-- columnas nuevas van al final y las existentes no cambian.

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
  s.larva_limpia_g / nullif(b.iniciador_g, 0)   as g_larva_por_g_iniciador,
  b.protocolo,
  inc.codigo                             as incubadora,
  b.individuos,
  s.reserva_cria_g
from app.bandeja b
join app.recoleccion r on r.id = b.recoleccion_id
join app.insectario  i on i.id = r.insectario_id
left join app.incubadora inc on inc.id = b.incubadora_id
left join app.separacion s on s.bandeja_id = b.id and s.deleted_at is null
left join lateral (
  select * from app.ayuno a
  where a.bandeja_id = b.id and a.deleted_at is null
  order by a.fecha desc limit 1
) ay on true
where b.deleted_at is null
  and b.cerrada_admin_at is null;

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
  (s.larva_limpia_g / 1000.0) / nullif(f.kg_alimento_total, 0) * 100 as conversion_pct,
  b.protocolo
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
  extract(day from c.despachado_at - b.fecha)::int    as dias_total_a_despacho,
  b.protocolo,
  app.dia_local(s.fecha) - inc.fecha_inicio           as dia_ciclo_cosecha
from app.bandeja b
join app.recoleccion r on r.id = b.recoleccion_id
join app.insectario  i on i.id = r.insectario_id
left join app.incubadora inc on inc.id = b.incubadora_id
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

-- También corrige un error de 0002: los gramos de huevos de cada recolecta se
-- sumaban una vez POR BANDEJA, inflando todos los totales y cocientes. Ahora
-- cada total se calcula en su propio nivel. Los cocientes por gramo de huevo
-- usan sólo datos v1, que es donde se pesaban huevos.
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
  -- "Hoy" es el día de la granja, no el del servidor (UTC), que va un día
  -- adelantado de 20:00 a 24:00 en Caracas.
  coalesce(i.cierre_real, app.dia_local(now())) - i.fecha_inicio as dias_operacion,
  rc.n_recolecciones,
  rc.huevos_g_total,
  rc.huevos_g_total / nullif(i.biomasa_kg, 0)            as g_huevos_por_kg_biomasa,
  rc.huevos_g_total
    / nullif(coalesce(i.cierre_real, app.dia_local(now())) - i.fecha_inicio, 0) as g_huevos_por_dia,
  bs.n_bandejas,
  bs.kg_larva_total,
  (bs.kg_larva_v1 * 1000.0) / nullif(rc.huevos_g_total, 0) as g_larva_por_g_huevo,
  rc.n_recolecciones_v2,
  rc.peso_ovipositores_g_total,
  bs.kg_larva_v2,
  bs.kg_reserva_cria_total
from app.insectario i
left join lateral (
  select count(*)                                              as n_recolecciones,
         sum(r.huevos_g)                                       as huevos_g_total,
         count(*) filter (where r.protocolo = 'v2')            as n_recolecciones_v2,
         sum(r.peso_ovipositores_g)                            as peso_ovipositores_g_total
    from app.recoleccion r
   where r.insectario_id = i.id and r.deleted_at is null
) rc on true
left join lateral (
  select count(*)                                                        as n_bandejas,
         sum(s.larva_limpia_g) / 1000.0                                  as kg_larva_total,
         sum(s.larva_limpia_g) filter (where b.protocolo = 'v1') / 1000.0 as kg_larva_v1,
         sum(s.larva_limpia_g) filter (where b.protocolo = 'v2') / 1000.0 as kg_larva_v2,
         sum(s.reserva_cria_g) / 1000.0                                  as kg_reserva_cria_total
    from app.recoleccion r
    join app.bandeja b on b.recoleccion_id = r.id and b.deleted_at is null
    left join app.separacion s on s.bandeja_id = b.id and s.deleted_at is null
   where r.insectario_id = i.id and r.deleted_at is null
) bs on true
where i.deleted_at is null;

create or replace view app.v_consumo_alimento as
select
  app.dia_local(a.fecha)                           as dia,
  date_trunc('week', app.dia_local(a.fecha))::date as semana,
  a.tipo_alimento,
  a.origen,
  count(*)                                         as n_eventos,
  count(distinct a.bandeja_id)                     as n_bandejas,
  sum(a.cantidad_kg)                               as kg_total,
  a.protocolo
from app.alimentacion a
where a.deleted_at is null
group by 1, 2, 3, 4, a.protocolo;

create or replace view app.v_calidad_datos as
select 'ayuno_huerfano_sin_resolver' as problema, count(*) as n
  from app.ayuno_huerfano where resuelto_at is null
union all
-- Abierto más de lo planeado + 24 h. Con el ayuno v1 de 24 h esto es lo mismo
-- que antes (48 h); el ayuno v2 de 48 h no se marca hasta pasadas 72 h.
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
-- Dos teléfonos anotaron la misma carga de la misma bandeja.
select 'carga_repetida', count(*)
  from (select 1 from app.alimentacion
         where carga is not null and deleted_at is null
         group by bandeja_id, carga having count(*) > 1) x
union all
select 'incubadora_sin_distribuir_10d', count(*)
  from app.incubadora
  where estado = 'incubando'
    and fecha_inicio < app.dia_local(now()) - 10
    and deleted_at is null;

-- Las vistas "select *" se expanden al crearlas: se recrean para que incluyan
-- las columnas nuevas (y las de 0004, que v_insectarios_activos no tenía).
create or replace view app.v_bandejas_activas as
  select * from app.bandeja
  where deleted_at is null and cerrada_admin_at is null and estado <> 'cosechada';

create or replace view app.v_insectarios_activos as
  select * from app.insectario where deleted_at is null and estado = 'activo';

create or replace view app.v_incubadoras_activas as
  select * from app.incubadora where deleted_at is null and estado = 'incubando';


-- ── 13. Permisos ───────────────────────────────────────────────────────────

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;


-- ############################################################################
-- 0008_alimento.sql
-- ############################################################################

-- ============================================================================
-- 0008 — Alimento: recepción de material, ensilaje (alimento fermentado),
-- lecturas de temperatura, y consumo por carga.
--
--   Recepción (material, kg) ─► Ensilaje: armado ─► sellado (fermenta) ─►
--   listo ─► en uso ─► agotado ─► cada carga de las bandejas descuenta sus kg
--   del ensilaje en uso.
--
-- EN PRODUCCIÓN: correr DESPUÉS de 0007 y ANTES de publicar la app que lo
-- usa. Es seguro correrlo dos veces. También va en SETUP_COMPLETO.
--
-- No cambia datos existentes. `log_alimentacion_grupal` y
-- `distribuir_incubadora` se reemplazan con la MISMA firma (jsonb) para que
-- guarden de qué ensilaje salió cada carga.
-- ============================================================================

set search_path = app, public;


-- ── 1. Materiales y parámetros ─────────────────────────────────────────────

insert into app.catalogo (id, tipo, valor, orden) values
  (gen_random_uuid(), 'material_alimento', 'Bagazo de cerveza (BSG)', 1),
  (gen_random_uuid(), 'material_alimento', 'Desecho de panadería',    2),
  (gen_random_uuid(), 'material_alimento', 'Desecho de fruta',        3),
  (gen_random_uuid(), 'material_alimento', 'Otro',                    4)
on conflict (tipo, valor) do nothing;

insert into app.parametro (clave, valor, descripcion) values
  ('dias_fermentacion', '14',
   'PROVISIONAL (definir con el laboratorio): días desde que se sella un ensilaje hasta que está listo.')
on conflict (clave) do nothing;


-- ── 2. Recepción de material ───────────────────────────────────────────────

create table if not exists app.recepcion_alimento (
  id         uuid primary key,
  fecha      timestamptz not null,
  material   text not null,
  kg         numeric(10,2) not null check (kg > 0),
  proveedor  text,
  notas      text not null default '',

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_recepcion_fecha   on app.recepcion_alimento(fecha desc);
create index if not exists ix_recepcion_updated on app.recepcion_alimento(updated_at);


-- ── 3. Ensilaje: una tanda de alimento fermentado ──────────────────────────
-- Cada paso es un sello con fecha y quién (como lote). El estado sale de los
-- sellos de la misma fila, nunca de un campo vacío en otra tabla.

create table if not exists app.ensilaje (
  id           uuid primary key,
  codigo       text not null,
  silo         text not null default '',
  fecha_armado timestamptz not null,
  kg_inicial   numeric(10,2) check (kg_inicial >= 0),
  notas        text not null default '',

  sellado_at  timestamptz, sellado_por text,
  listo_at    timestamptz, listo_por   text,
  en_uso_at   timestamptz, en_uso_por  text,
  agotado_at  timestamptz, agotado_por text,

  estado text generated always as (
    case when agotado_at is not null then 'agotado'
         when en_uso_at  is not null then 'en_uso'
         when listo_at   is not null then 'listo'
         when sellado_at is not null then 'fermentando'
         else 'armado' end) stored,

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,

  check (listo_at  is null or sellado_at is not null),
  check (en_uso_at is null or sellado_at is not null)
);
create unique index if not exists ux_ensilaje_codigo on app.ensilaje(codigo) where deleted_at is null;
create index if not exists ix_ensilaje_updated on app.ensilaje(updated_at);

-- Qué material entró en cada ensilaje (y opcionalmente de qué entrega).
create table if not exists app.ensilaje_insumo (
  id           uuid primary key,
  ensilaje_id  uuid not null references app.ensilaje(id),
  material     text not null,
  kg           numeric(10,2) not null check (kg > 0),
  recepcion_id uuid references app.recepcion_alimento(id),

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_insumo_ensilaje on app.ensilaje_insumo(ensilaje_id);
create index if not exists ix_insumo_updated  on app.ensilaje_insumo(updated_at);

-- Seguimiento de la fermentación.
create table if not exists app.ensilaje_lectura (
  id            uuid primary key,
  ensilaje_id   uuid not null references app.ensilaje(id),
  fecha         timestamptz not null,
  temperatura_c numeric(5,2) check (temperatura_c between -10 and 90),
  notas         text not null default '',

  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_lectura_ensilaje on app.ensilaje_lectura(ensilaje_id, fecha desc);
create index if not exists ix_lectura_updated  on app.ensilaje_lectura(updated_at);

-- De qué ensilaje salió cada carga: es lo que descuenta el stock.
alter table app.alimentacion add column if not exists ensilaje_id uuid references app.ensilaje(id);
create index if not exists ix_alim_ensilaje on app.alimentacion(ensilaje_id) where ensilaje_id is not null;


-- ── 4. Funciones ───────────────────────────────────────────────────────────
-- Validan antes de escribir: llamarlas vacías no escribe nada.

-- El ensilaje y sus materiales, juntos o ninguno.
create or replace function app.crear_ensilaje(p_ensilaje jsonb, p_insumos jsonb)
returns app.ensilaje language plpgsql set search_path = app, public as $$
declare
  v_id uuid := nullif(p_ensilaje->>'id', '')::uuid;
  r app.ensilaje;
begin
  if v_id is null or nullif(p_ensilaje->>'codigo', '') is null
     or nullif(p_ensilaje->>'fecha_armado', '') is null then
    raise exception 'ensilaje incompleto' using errcode = '22023';
  end if;

  insert into app.ensilaje (
    id, codigo, silo, fecha_armado, kg_inicial, notas,
    registrado_por, created_by, dispositivo_id, created_at)
  values (
    v_id, p_ensilaje->>'codigo', coalesce(p_ensilaje->>'silo', ''),
    (p_ensilaje->>'fecha_armado')::timestamptz,
    nullif(p_ensilaje->>'kg_inicial', '')::numeric,
    coalesce(p_ensilaje->>'notas', ''),
    nullif(p_ensilaje->>'registrado_por', ''),
    nullif(p_ensilaje->>'created_by', '')::uuid,
    nullif(p_ensilaje->>'dispositivo_id', '')::uuid,
    coalesce(nullif(p_ensilaje->>'created_at', '')::timestamptz, now()))
  on conflict (id) do nothing;

  insert into app.ensilaje_insumo (
    id, ensilaje_id, material, kg, recepcion_id,
    registrado_por, created_by, dispositivo_id, created_at)
  select
    (i->>'id')::uuid, v_id, i->>'material', (i->>'kg')::numeric,
    nullif(i->>'recepcion_id', '')::uuid,
    coalesce(nullif(i->>'registrado_por', ''), nullif(p_ensilaje->>'registrado_por', '')),
    nullif(i->>'created_by', '')::uuid,
    nullif(i->>'dispositivo_id', '')::uuid,
    coalesce(nullif(i->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_insumos, '[]'::jsonb)) i
  on conflict (id) do nothing;

  select * into r from app.ensilaje where id = v_id;
  return r;
end $$;

-- Un paso del ensilaje. Cada paso se sella una sola vez (el primero gana) y
-- sólo en orden: no se usa lo que no se selló.
create or replace function app.avanzar_ensilaje(p_id uuid, p_paso text, p_at timestamptz, p_por text default null)
returns app.ensilaje language plpgsql set search_path = app, public as $$
declare
  r app.ensilaje;
  v_at timestamptz := coalesce(p_at, now());
  v_por text := nullif(p_por, '');
begin
  if p_paso not in ('sellado', 'listo', 'en_uso', 'agotado') then
    raise exception 'paso de ensilaje desconocido: %', p_paso using errcode = '22023';
  end if;

  if p_paso = 'sellado' then
    update app.ensilaje set sellado_at = v_at, sellado_por = v_por
     where id = p_id and sellado_at is null
    returning * into r;
  elsif p_paso = 'listo' then
    update app.ensilaje set listo_at = v_at, listo_por = v_por
     where id = p_id and listo_at is null and sellado_at is not null
    returning * into r;
  elsif p_paso = 'en_uso' then
    -- Empezar a usarlo también lo da por listo, si nadie lo marcó.
    update app.ensilaje
       set en_uso_at = v_at, en_uso_por = v_por,
           listo_at = coalesce(listo_at, v_at), listo_por = coalesce(listo_por, v_por)
     where id = p_id and en_uso_at is null and sellado_at is not null and agotado_at is null
    returning * into r;
  else
    update app.ensilaje set agotado_at = v_at, agotado_por = v_por
     where id = p_id and agotado_at is null
    returning * into r;
  end if;

  if r.id is null then select * into r from app.ensilaje where id = p_id; end if;
  return r;
end $$;

-- Misma firma que 0007: ahora guarda también de qué ensilaje salió la carga.
create or replace function app.log_alimentacion_grupal(p_rows jsonb)
returns setof app.alimentacion language sql set search_path = app, public as $$
  insert into app.alimentacion
    (id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, grupal_id, carga,
     tamizado, ensilaje_id, notas, registrado_por, created_by, dispositivo_id, created_at)
  select (r->>'id')::uuid, (r->>'bandeja_id')::uuid, (r->>'fecha')::timestamptz,
         r->>'tipo_alimento', (r->>'cantidad_kg')::numeric, 'grupal',
         (r->>'grupal_id')::uuid,
         nullif(r->>'carga', '')::smallint,
         coalesce(nullif(r->>'tamizado', '')::boolean, false),
         nullif(r->>'ensilaje_id', '')::uuid,
         coalesce(r->>'notas', ''),
         nullif(r->>'registrado_por', ''),
         nullif(r->>'created_by', '')::uuid,
         nullif(r->>'dispositivo_id', '')::uuid,
         coalesce(nullif(r->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(p_rows) r
  on conflict (id) do nothing
  returning *;
$$;

-- Misma firma que 0007; la carga 1 también guarda su ensilaje.
create or replace function app.distribuir_incubadora(
  p_distribucion jsonb, p_bandejas jsonb, p_cargas jsonb)
returns app.incubadora language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_distribucion->>'incubadora_id', '')::uuid;
  v_at  timestamptz := coalesce(nullif(p_distribucion->>'fecha', '')::timestamptz, now());
  v_por text := nullif(p_distribucion->>'registrado_por', '');
  inc app.incubadora;
begin
  if v_id is null or p_bandejas is null or jsonb_typeof(p_bandejas) <> 'array'
     or jsonb_array_length(p_bandejas) = 0 then
    raise exception 'distribución incompleta' using errcode = '22023';
  end if;

  select * into inc from app.incubadora where id = v_id and deleted_at is null;
  if inc.id is null then
    raise exception 'la incubadora % no existe en el servidor', v_id using errcode = '23503';
  end if;

  if inc.distribuida_at is not null then
    if exists (select 1 from app.bandeja b where b.id = (p_bandejas->0->>'id')::uuid) then
      return inc;
    end if;
    raise exception 'La incubadora % ya fue distribuida desde otro teléfono.', inc.codigo
      using errcode = '23505';
  end if;

  insert into app.bandeja (
    id, recoleccion_id, incubadora_id, no_bandeja, id_bandeja, fecha, individuos,
    notas, protocolo, registrado_por, created_by, dispositivo_id, created_at)
  select
    (b->>'id')::uuid, inc.recoleccion_id, inc.id,
    (b->>'no_bandeja')::int, b->>'id_bandeja', v_at,
    nullif(b->>'individuos', '')::int,
    coalesce(b->>'notas', ''), 'v2',
    coalesce(nullif(b->>'registrado_por', ''), v_por),
    nullif(b->>'created_by', '')::uuid,
    nullif(b->>'dispositivo_id', '')::uuid,
    coalesce(nullif(b->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(p_bandejas) b
  on conflict (id) do nothing;

  insert into app.alimentacion (
    id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, grupal_id, carga,
    tamizado, ensilaje_id, notas, registrado_por, created_by, dispositivo_id, created_at)
  select
    (c->>'id')::uuid, (c->>'bandeja_id')::uuid,
    coalesce(nullif(c->>'fecha', '')::timestamptz, v_at),
    coalesce(nullif(c->>'tipo_alimento', ''), 'Ensilaje'),
    (c->>'cantidad_kg')::numeric, 'grupal',
    nullif(c->>'grupal_id', '')::uuid,
    nullif(c->>'carga', '')::smallint,
    coalesce(nullif(c->>'tamizado', '')::boolean, false),
    nullif(c->>'ensilaje_id', '')::uuid,
    coalesce(c->>'notas', ''),
    coalesce(nullif(c->>'registrado_por', ''), v_por),
    nullif(c->>'created_by', '')::uuid,
    nullif(c->>'dispositivo_id', '')::uuid,
    coalesce(nullif(c->>'created_at', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_cargas, '[]'::jsonb)) c
  on conflict (id) do nothing;

  update app.incubadora
     set distribuida_at   = v_at,
         distribuida_por  = coalesce(v_por, distribuida_por),
         individuos_total = coalesce(nullif(p_distribucion->>'individuos_total', '')::int,
                                     individuos_total)
   where id = inc.id and distribuida_at is null
  returning * into inc;
  return inc;
end $$;


-- ── 5. Mantenimiento, acceso ───────────────────────────────────────────────

create or replace trigger t_recepcion_alimento_touch before update on app.recepcion_alimento
  for each row execute function app.touch_updated_at();
create or replace trigger t_ensilaje_touch before update on app.ensilaje
  for each row execute function app.touch_updated_at();
create or replace trigger t_ensilaje_insumo_touch before update on app.ensilaje_insumo
  for each row execute function app.touch_updated_at();
create or replace trigger t_ensilaje_lectura_touch before update on app.ensilaje_lectura
  for each row execute function app.touch_updated_at();

do $$
declare t text;
begin
  foreach t in array array['recepcion_alimento', 'ensilaje', 'ensilaje_insumo', 'ensilaje_lectura'] loop
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists demo_abierto on app.%I', t);
    execute format(
      'create policy demo_abierto on app.%I for all to anon, authenticated
         using (true) with check (true)', t);
  end loop;
end $$;


-- ── 6. Vistas: stock y consumo ─────────────────────────────────────────────

-- Materia prima: lo recibido menos lo que entró en ensilajes.
create or replace view app.v_stock_material as
with rec as (
  select material, sum(kg) as recibido_kg, max(fecha) as ultima_recepcion
    from app.recepcion_alimento where deleted_at is null group by material),
usado as (
  select i.material, sum(i.kg) as usado_kg
    from app.ensilaje_insumo i
    join app.ensilaje e on e.id = i.ensilaje_id and e.deleted_at is null
   where i.deleted_at is null group by i.material)
select coalesce(rec.material, usado.material) as material,
       coalesce(rec.recibido_kg, 0)           as recibido_kg,
       coalesce(usado.usado_kg, 0)            as usado_kg,
       coalesce(rec.recibido_kg, 0) - coalesce(usado.usado_kg, 0) as disponible_kg,
       rec.ultima_recepcion
  from rec full join usado on usado.material = rec.material;

-- Cada ensilaje: lo que tenía, lo que se ha dado en cargas y lo que queda.
create or replace view app.v_stock_ensilaje as
select
  e.id, e.codigo, e.silo, e.estado,
  app.dia_local(e.fecha_armado)                   as dia_armado,
  app.dia_local(e.sellado_at)                     as dia_sellado,
  -- Días de la granja: current_date es el día del servidor (UTC).
  app.dia_local(now()) - app.dia_local(e.sellado_at) as dias_fermentando,
  app.dia_local(e.sellado_at)
    + coalesce((select (valor #>> '{}')::int from app.parametro where clave = 'dias_fermentacion'), 0)
                                                  as listo_previsto,
  e.kg_inicial,
  coalesce(c.consumido_kg, 0)                     as consumido_kg,
  e.kg_inicial - coalesce(c.consumido_kg, 0)      as disponible_kg,
  c.n_cargas,
  l.temperatura_c                                 as ultima_temperatura_c,
  l.fecha                                         as ultima_lectura
from app.ensilaje e
left join lateral (
  select sum(a.cantidad_kg) as consumido_kg, count(*) as n_cargas
    from app.alimentacion a where a.ensilaje_id = e.id and a.deleted_at is null) c on true
left join lateral (
  select x.temperatura_c, x.fecha from app.ensilaje_lectura x
   where x.ensilaje_id = e.id and x.deleted_at is null
   order by x.fecha desc limit 1) l on true
where e.deleted_at is null;

-- Consumo de alimento del protocolo nuevo, por día (para prever cuánto dura).
create or replace view app.v_consumo_ensilaje_diario as
select app.dia_local(a.fecha) as dia,
       sum(a.cantidad_kg)     as kg,
       count(*)               as n_cargas,
       count(distinct a.bandeja_id) as n_bandejas,
       count(*) filter (where a.ensilaje_id is null) as n_sin_ensilaje
  from app.alimentacion a
 where a.deleted_at is null and a.protocolo = 'v2'
 group by 1;


-- ── 7. Permisos ────────────────────────────────────────────────────────────

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;


-- ############################################################################
-- 0009_monitor.sql
-- ############################################################################

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
