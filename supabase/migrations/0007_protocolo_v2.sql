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
  coalesce(i.cierre_real, current_date) - i.fecha_inicio as dias_operacion,
  rc.n_recolecciones,
  rc.huevos_g_total,
  rc.huevos_g_total / nullif(i.biomasa_kg, 0)            as g_huevos_por_kg_biomasa,
  rc.huevos_g_total
    / nullif(coalesce(i.cierre_real, current_date) - i.fecha_inicio, 0) as g_huevos_por_dia,
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
    and fecha_inicio < current_date - 10
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
