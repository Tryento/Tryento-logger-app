-- ============================================================================
-- Post-migration verification. Run every one of these and READ the output.
--
-- A migration that "ran without errors" is not a migration that worked. The
-- AppSheet app also ran without errors for months while its active/archive view
-- was silently wrong.
-- ============================================================================

set search_path = app, staging, public;

-- ── 1. row counts: staging vs app ──────────────────────────────────────────
-- Differences are expected in exactly two places (ayunos are quarantined, and
-- ~20 blank alimentaciones are dropped). Any OTHER gap needs explaining before
-- you go further.
select 'insectario'   as tabla, (select count(*) from staging.insectarios)  as en_hoja, (select count(*) from app.insectario)   as importado
union all select 'recoleccion',  (select count(*) from staging.recoleccion),  (select count(*) from app.recoleccion)
union all select 'bandeja',      (select count(*) from staging.bandejas),     (select count(*) from app.bandeja)
union all select 'alimentacion', (select count(*) from staging.alimentacion), (select count(*) from app.alimentacion)
union all select 'revision',     (select count(*) from staging.revision),     (select count(*) from app.revision)
union all select 'ayuno',        (select count(*) from staging.ayuno),        (select count(*) from app.ayuno)
union all select 'ayuno_huerfano', null,                                      (select count(*) from app.ayuno_huerfano)
union all select 'separacion',   (select count(*) from staging.separacion),   (select count(*) from app.separacion)
union all select 'cochada',      (select count(*) from staging.lotes),        (select count(*) from app.cochada);


-- ── 2. what did we deliberately drop? ──────────────────────────────────────
-- Recorded permanently, so the decision is auditable rather than folklore.
insert into app.migracion_log (tipo, n, detalle)
select 'alimentacion_descartada_sin_fecha_o_tipo',
       count(*),
       jsonb_agg(jsonb_build_object('fila', s.fila_origen, 'raw', to_jsonb(s)))
from staging.alimentacion s
where nullif(trim(s.id_interno), '') is not null
  and (app.mig_ts(s.fecha) is null or nullif(trim(s.tipo_alimento), '') is null);

-- These are the bot-race artifacts: a valid tray reference, but no date, type
-- or quantity. The atomic bulk-feed RPC is what stops new ones appearing.
select s.fila_origen, s.id_bandeja, s.fecha, s.tipo_alimento, s.cantidad_kg
from staging.alimentacion s
where nullif(trim(s.id_interno), '') is not null
  and (app.mig_ts(s.fecha) is null or nullif(trim(s.tipo_alimento), '') is null)
order by s.fila_origen;


-- ── 3. orphans the FK would have rejected ──────────────────────────────────
select 'recoleccion sin insectario' as problema, s.fila_origen, s.id_interno
from staging.recoleccion s
where nullif(trim(s.id_interno), '') is not null
  and not exists (select 1 from app.insectario i where i.id = app.mig_id('insectario', s.insectario))
union all
select 'alimentacion sin bandeja', s.fila_origen, s.id_interno
from staging.alimentacion s
where nullif(trim(s.id_interno), '') is not null
  and not exists (select 1 from app.bandeja b where b.id = app.mig_id('bandeja', s.id_bandeja));


-- ── 4. duplicate human identifiers ─────────────────────────────────────────
-- The target schema enforces UNIQUE(recoleccion_id, no_bandeja) because the
-- farm labels trays by hand. If the sheet already contains duplicates, decide
-- what they mean BEFORE the constraint decides for you.
select recoleccion_id, no_bandeja, count(*)
from app.bandeja
group by 1, 2 having count(*) > 1;

select insectario_id, recolecta, count(*)
from app.recoleccion
group by 1, 2 having count(*) > 1;

-- Does the recolecta counter restart each year?
select left(fecha::text, 4) as anio, min(recolecta), max(recolecta), count(*)
from app.recoleccion group by 1 order by 1;


-- ── 5. ranked suggestions for the orphan ayunos ────────────────────────────
-- NEVER auto-applied. The process lead confirms each one; promoting a row fires
-- the estado trigger and the tray corrects itself.
--
-- Scoring: same-day is the strongest signal, a tray already harvested before
-- the fast cannot be the right one.
select h.id                as ayuno_huerfano_id,
       h.fecha             as ayuno_fecha,
       h.peso_inicial_kg,
       b.id                as bandeja_id,
       b.id_bandeja,
       b.fecha             as bandeja_fecha,
       ( (abs(extract(epoch from h.fecha - b.fecha) / 86400) <= 1)::int * 3
       + (b.tipo_iniciador is not null)::int
       + (not exists (select 1 from app.separacion s
                       where s.bandeja_id = b.id and s.fecha < h.fecha))::int * 2
       ) as score
from app.ayuno_huerfano h
join app.bandeja b
  on b.fecha <= h.fecha
 and b.fecha > h.fecha - interval '45 days'
where h.resuelto_at is null
order by h.id, score desc, b.fecha desc;

-- To accept one (run per confirmed pair):
--
--   with promoted as (
--     insert into app.ayuno (id, bandeja_id, fecha, peso_inicial_kg, horas_ayuno,
--                            peso_final_kg, cerrado_at, notas)
--     select h.id, :'bandeja_id'::uuid, h.fecha, h.peso_inicial_kg,
--            coalesce(h.horas_ayuno, 24), h.peso_final_kg, null, 'Migrado y asignado a mano'
--     from app.ayuno_huerfano h where h.id = :'huerfano_id'::uuid
--     returning id)
--   update app.ayuno_huerfano
--      set resuelto_at = now(), ayuno_id = (select id from promoted),
--          bandeja_id_sugerida = :'bandeja_id'::uuid
--    where id = :'huerfano_id'::uuid;


-- ── 6. the state machine agrees with the events ────────────────────────────
select count(*) as trays_con_estado_incorrecto from app.v_estado_drift;   -- must be 0

select estado, count(*) from app.bandeja
where cerrada_admin_at is null group by 1 order by 1;

select count(*) as cerradas_administrativamente
from app.bandeja where cerrada_admin_at is not null;


-- ── 7. the bug that started all this ───────────────────────────────────────
-- Every open colony must show NULL here, never ~-20,676.
select codigo, proyeccion_cierre, cierre_real, desviacion_cierre_dias, estado
from app.insectario order by fecha_inicio;


-- ── 8. timezone spot-check ─────────────────────────────────────────────────
-- Pick a few evening events and confirm the farm-local day matches the sheet.
-- If these are a day ahead, the import read naive strings as UTC.
select a.id, a.fecha as instante_utc,
       a.fecha at time zone 'America/Caracas' as hora_local,
       app.dia_local(a.fecha) as dia_local
from app.alimentacion a
order by a.fecha desc limit 20;


-- ── 9. overall health ──────────────────────────────────────────────────────
select * from app.v_calidad_datos;

-- Yield views will be EMPTY until real separaciones start arriving — the
-- Separacion tab has zero rows in the sheet. That is expected, and it is the
-- single most important thing to tell the farm: the back half of the process
-- has never actually been recorded.
select count(*) as filas_rendimiento from app.v_rendimiento_bandeja where larva_limpia_g is not null;
select count(*) as filas_fcr from app.v_fcr_bandeja;
