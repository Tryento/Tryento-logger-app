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
