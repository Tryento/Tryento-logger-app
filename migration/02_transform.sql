-- ============================================================================
-- staging -> app.  Run AFTER 01_staging_load.sql (generated from the CSVs).
--
-- READ THIS BEFORE RUNNING IT:
--
--  * Column names below are the EXPECTED normalisation of the AppSheet
--    headers. Verify them against what tools/csv-to-staging.mjs actually
--    produced — a header like "Larva Limpia_g" could normalise differently
--    than assumed, and a silently-NULL column is the worst outcome here.
--
--  * This script is IDEMPOTENT and RE-RUNNABLE. Every id is derived with
--    uuid_generate_v5 from the original ID_Interno, so running it three times
--    produces byte-identical ids. You will run it at least three times.
--
--  * Timestamps are read as America/Caracas. The sheet stores naive local
--    strings; reading them as UTC would shift nine months of data by four
--    hours and move every evening event to the wrong day.
--
--  * Calendar facts (fecha_inicio, proyeccion_*, cierre_real, vencimiento) are
--    imported as DATE, not timestamptz. They are days, not instants.
-- ============================================================================

set search_path = app, staging, public;

-- Stable namespace so v5 ids never change between runs.
create or replace function app.mig_id(p_kind text, p_raw text)
returns uuid language sql immutable as $$
  select uuid_generate_v5('6ba7b810-9dad-11d1-80b4-00c04fd430c8'::uuid, p_kind || ':' || coalesce(p_raw, ''))
$$;

-- Numbers in the sheet may use a comma decimal separator and stray spaces.
create or replace function app.mig_num(p text)
returns numeric language sql immutable as $$
  select nullif(regexp_replace(replace(trim(coalesce(p, '')), ',', '.'), '[^0-9.\-]', '', 'g'), '')::numeric
$$;

create or replace function app.mig_ts(p text)
returns timestamptz language sql stable as $$
  select case when nullif(trim(coalesce(p, '')), '') is null then null
              else (trim(p))::timestamp at time zone 'America/Caracas' end
$$;

create or replace function app.mig_date(p text)
returns date language sql immutable as $$
  select case when nullif(trim(coalesce(p, '')), '') is null then null
              else (trim(p))::date end
$$;


-- ── STEP 0: is ID_Interno actually a UUID? ─────────────────────────────────
-- AppSheet's UNIQUEID() emits 8-character strings by default, NOT RFC-4122
-- UUIDs. Run this FIRST and look at the numbers before trusting anything.
-- Either way app.mig_id() handles it, but you need to know which world you are
-- in before you reconcile row counts.
--
--   select 'bandejas' t, count(*) total,
--          count(*) filter (where id_interno ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') uuid_validos,
--          count(distinct id_interno) distintos
--     from staging.bandejas;


-- ── STEP 1: disable the estado trigger ─────────────────────────────────────
-- Otherwise importing thousands of events fires thousands of single-row
-- UPDATE bandeja statements, one per event.
alter table app.ayuno      disable trigger user;
alter table app.separacion disable trigger user;


-- ── STEP 2: operators ──────────────────────────────────────────────────────
-- The AppSheet event tables have NO operator column, so history has no author.
-- Nothing to migrate; app.operario is seeded separately (0003_seed.sql) with
-- the real roster, and historical rows keep registrado_por NULL, which is the
-- honest encoding of "we do not know who did this".


-- ── STEP 3: insectarios ────────────────────────────────────────────────────
insert into app.insectario (
  id, codigo, nombre_insectario, fecha_inicio, generacion_moscas, biomasa_kg,
  proyeccion_ovipositores, proyeccion_cierre, fecha_ovipositores, cierre_real,
  notas, created_at, updated_at)
select
  app.mig_id('insectario', s.id_interno),
  coalesce(nullif(trim(s.nombre_insectario), ''), 'SIN-NOMBRE')
    || '-' || to_char(coalesce(app.mig_date(s.fecha_inicio), current_date), 'DDMM'),
  coalesce(nullif(trim(s.nombre_insectario), ''), 'SIN-NOMBRE'),
  coalesce(app.mig_date(s.fecha_inicio), current_date),
  nullif(trim(s.generacion_moscas), ''),
  app.mig_num(s.biomasa_kg),
  app.mig_date(s.proyeccion_ovipositores),
  app.mig_date(s.proyeccion_cierre),
  app.mig_date(s.fecha_ovipositores),
  -- Deliberately NOT importing Deviacion/Desviacion: those columns hold the
  -- ~-20,676 garbage produced by reading a blank date as the epoch. The target
  -- schema recomputes them as generated columns, and they stay NULL until the
  -- real date exists.
  app.mig_date(s.cierre_real),
  '',
  now(), now()
from staging.insectarios s
where nullif(trim(s.id_interno), '') is not null
on conflict (id) do nothing;


-- ── STEP 4: recolecciones ──────────────────────────────────────────────────
insert into app.recoleccion (
  id, insectario_id, recolecta, fecha, huevos_g, notas, created_at, updated_at)
select
  app.mig_id('recoleccion', s.id_interno),
  app.mig_id('insectario', s.insectario),
  coalesce(nullif(trim(s.recolecta), ''), '0'),
  coalesce(app.mig_ts(s.fecha), now()),
  app.mig_num(s.huevos_g),
  '', now(), now()
from staging.recoleccion s
where nullif(trim(s.id_interno), '') is not null
  -- Orphans would violate the FK and abort the whole load; they are reported
  -- by 03_checks.sql instead of silently dropped.
  and exists (select 1 from app.insectario i where i.id = app.mig_id('insectario', s.insectario))
on conflict (id) do nothing;


-- ── STEP 5: bandejas ───────────────────────────────────────────────────────
-- The sheet has no FK to Recoleccion — it matched a loose "Recolecta" text
-- value. Rebuild the real link by (insectario's) recolecta number.
insert into app.bandeja (
  id, recoleccion_id, no_bandeja, id_bandeja, fecha, gramos_huevos,
  iniciador_g, tipo_iniciador, notas, estado, created_at, updated_at)
select
  app.mig_id('bandeja', s.id_interno),
  r.id,
  coalesce(app.mig_num(s.no_bandeja)::int, 1),
  coalesce(nullif(trim(s.id_bandeja), ''),
           to_char(coalesce(app.mig_ts(s.fecha), now()) at time zone 'America/Caracas', 'DDMM')
             || '.' || coalesce(nullif(trim(s.recolecta), ''), '0')
             || '.' || coalesce(app.mig_num(s.no_bandeja)::int, 1)),
  coalesce(app.mig_ts(s.fecha), now()),
  app.mig_num(s.gramos_huevos),
  app.mig_num(s.iniciador),
  nullif(trim(s.tipo_iniciador), ''),
  '', 'en_crecimiento', now(), now()
from staging.bandejas s
join lateral (
  select r2.id from app.recoleccion r2
  where r2.recolecta = nullif(trim(s.recolecta), '')
  order by r2.fecha desc limit 1
) r on true
where nullif(trim(s.id_interno), '') is not null
on conflict (id) do nothing;


-- ── STEP 6: alimentaciones ─────────────────────────────────────────────────
-- The ~20 bot-race rows with a tray reference but blank fecha/tipo/cantidad are
-- EXCLUDED. A row with no date cannot be placed on a timeline and contributes
-- nothing to FCR; importing it with an "es_dudoso" flag would force every view
-- to handle NULL forever in exchange for 20 rows of noise. They remain in
-- staging, and 03_checks.sql records the decision in app.migracion_log.
insert into app.alimentacion (
  id, bandeja_id, fecha, tipo_alimento, cantidad_kg, origen, notas, created_at, updated_at)
select
  app.mig_id('alimentacion', s.id_interno),
  app.mig_id('bandeja', s.id_bandeja),
  app.mig_ts(s.fecha),
  nullif(trim(s.tipo_alimento), ''),
  coalesce(app.mig_num(s.cantidad_kg), 0),
  'individual', '', now(), now()
from staging.alimentacion s
where nullif(trim(s.id_interno), '') is not null
  and app.mig_ts(s.fecha) is not null
  and nullif(trim(s.tipo_alimento), '') is not null
  and exists (select 1 from app.bandeja b where b.id = app.mig_id('bandeja', s.id_bandeja))
on conflict (id) do nothing;


-- ── STEP 7: revisiones ─────────────────────────────────────────────────────
insert into app.revision (id, bandeja_id, fecha, notas, created_at, updated_at)
select
  app.mig_id('revision', s.id_interno),
  app.mig_id('bandeja', s.bandeja),
  coalesce(app.mig_ts(s.fecha), now()),
  '', now(), now()
from staging.revision s
where nullif(trim(s.id_interno), '') is not null
  and exists (select 1 from app.bandeja b where b.id = app.mig_id('bandeja', s.bandeja))
on conflict (id) do nothing;


-- ── STEP 8: ayunos — the orphan problem ────────────────────────────────────
-- The AppSheet Ayuno tab has NO reference to a tray at all. Every historical
-- row is unattributable.
--
-- These go to a quarantine table the FK and the estado trigger cannot see. A
-- sentinel "desconocida" tray was considered and rejected: it would poison
-- every downstream analytic and is precisely the infer-from-a-blank failure
-- this rebuild exists to eliminate.
--
-- The process lead resolves them in one sitting using the ranked suggestions in
-- 03_checks.sql. Promoting a row into app.ayuno fires the estado trigger and
-- the tray's state corrects itself — late historical data self-heals.
insert into app.ayuno_huerfano (
  id, raw, fecha, peso_inicial_kg, horas_ayuno, peso_final_kg, operario_texto)
select
  app.mig_id('ayuno', s.id_interno),
  to_jsonb(s),
  app.mig_ts(s.fecha),
  app.mig_num(s.peso_inicial_kg),
  app.mig_num(s.horas_de_ayuno)::int,
  app.mig_num(s.peso_final_kg),
  null
from staging.ayuno s
where nullif(trim(s.id_interno), '') is not null
on conflict (id) do nothing;


-- ── STEP 9: separaciones ───────────────────────────────────────────────────
-- Expected to import ZERO rows: the Separacion tab is empty in the live sheet.
-- That is a product finding, not a migration failure — see 03_checks.sql.
insert into app.separacion (id, bandeja_id, fecha, larva_limpia_g, notas, created_at, updated_at)
select
  app.mig_id('separacion', s.id_interno),
  app.mig_id('bandeja', s.bandeja),
  coalesce(app.mig_ts(s.fecha), now()),
  coalesce(app.mig_num(s.larva_limpia_g), 0),
  '', now(), now()
from staging.separacion s
where nullif(trim(s.id_interno), '') is not null
  and exists (select 1 from app.bandeja b where b.id = app.mig_id('bandeja', s.bandeja))
on conflict (id) do nothing;


-- ── STEP 10: lotes / cochadas ──────────────────────────────────────────────
-- Also expected to be ZERO rows. app.cochada_separacion therefore starts empty
-- and is populated going forward — there is nothing historical to link.


-- ── STEP 11: re-enable triggers and reconcile ──────────────────────────────
alter table app.ayuno      enable trigger user;
alter table app.separacion enable trigger user;

select app.recompute_all_bandeja_estados() as trays_corregidas;


-- ── STEP 12: close out the dead trays ──────────────────────────────────────
-- Nine months of trays have no recorded harvest, so under the estado rules they
-- all compute to 'en_crecimiento' and the home screen would read
-- "347 bandejas activas" on day one, with the bulk-feed picker offering every
-- one of them.
--
-- This is an EXPLICIT, ATTRIBUTABLE administrative closure, written to its own
-- column. estado stays a pure function of physical events; "we stopped tracking
-- this one" is a different kind of fact and gets its own field. Collapsing the
-- two is how you end up inferring state from blanks again.
--
-- Set :go_live to your cutover date before running.
update app.bandeja b
   set cerrada_admin_at = now(),
       cerrada_admin_motivo = 'Migración AppSheet: sin separación registrada en la hoja'
 where b.cerrada_admin_at is null
   and b.fecha < (current_date - interval '60 days')
   and not exists (select 1 from app.separacion s where s.bandeja_id = b.id)
   and not exists (
     select 1 from app.alimentacion a
     where a.bandeja_id = b.id and a.fecha > (current_date - interval '45 days'));
