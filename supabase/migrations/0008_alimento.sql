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
