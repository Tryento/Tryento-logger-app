-- ============================================================================
-- 0011 — Bandejas en vez de racks, y dos modos para los datos.
--
-- 1. LOS RACKS DESAPARECEN. Ya no hay racks registrados ni cambios de rack:
--    cada incubadora y cada caja de engorde es una bandeja, activa hasta que se
--    distribuye o se separa. Una recolecta conserva UN código, un chequeo y una
--    distribución, y dice cuántas bandejas ocupa (incubadora.n_bandejas).
--    El alimento se sigue guardando como el total que se dio.
--
-- 2. LA RECOLECTA PROPONE LAS BANDEJAS. Con 2–5 g de huevos por bandeja y 400 g
--    de alimento por bandeja. Son ajustes (app.parametro), no números fijos.
--
-- 3. DOS MODOS (app.parametro → reglas_estrictas). Se cambian SÓLO con los
--    archivos de supabase/operaciones/:
--      permitir_cambios.sql  modo abierto: el personal entra todo y puede borrar.
--      proteger_datos.sql    modo protegido: nadie borra, se cumplen los
--                            protocolos, y un dato sólo se corrige por la función
--                            que guarda quién y cuándo.
--    Este archivo NO cambia de modo: correrlo otra vez deja el que había.
--
-- 4. LA LLAVE PÚBLICA (la de app-config.js, que cualquiera puede leer en la
--    página) nunca más borra: ni filas, ni tablas, ni fotos. Tampoco cambia los
--    ajustes: se cambian en Supabase. Borrar desde la app es MARCAR (deleted_at),
--    porque una fila eliminada se quedaría para siempre en los teléfonos que ya
--    la tenían.
--
-- EN PRODUCCIÓN: correr en Supabase → SQL Editor ANTES de publicar la app que lo
-- usa. La app llama a estas funciones por su nombre. Correrlo otra vez no cambia
-- nada. Lo que había en racks y cambios de rack se borra para siempre.
--
-- Sigue abierto: quien tenga la dirección de la app puede leer y agregar, porque
-- no hay inicio de sesión (ver DEPLOY.md, «Before this is real»).
-- ============================================================================

set search_path = app, public;


-- ── 1. Sin racks ────────────────────────────────────────────────────────────

drop table if exists app.movimiento;
alter table app.incubadora       drop column if exists rack_id;
alter table app.caja             drop column if exists rack_id;
alter table app.bandeja_pupacion drop column if exists rack_id;
drop table if exists app.rack;

alter table app.incubadora
  add column if not exists n_bandejas int not null default 1 check (n_bandejas >= 1);


-- ── 2. Los ajustes nuevos ───────────────────────────────────────────────────

insert into app.parametro (clave, valor, descripcion) values
  ('huevos_bandeja_min_g', '2',
     'Gramos de huevos por bandeja, como mínimo. Con esto la recolecta propone cuántas bandejas armar.'),
  ('huevos_bandeja_max_g', '5',
     'Gramos de huevos por bandeja, como máximo.'),
  ('alimento_bandeja_g', '400',
     'Gramos de alimento inicial que la app propone para cada bandeja de la recolecta.'),
  ('reglas_estrictas', 'false',
     'Modo de los datos: false abierto, true protegido. Se cambia corriendo permitir_cambios.sql o proteger_datos.sql, no aquí.')
on conflict (clave) do nothing;

delete from app.parametro where clave = 'alimento_inicial_incubadora_kg';

create or replace function app.reglas_estrictas()
returns boolean language sql stable set search_path = app, public as $$
  select coalesce((select valor = 'true'::jsonb from app.parametro where clave = 'reglas_estrictas'), false)
$$;


-- ── 3. Acciones sin rack ────────────────────────────────────────────────────

create or replace function app.distribuir(p_distribucion jsonb, p_cajas jsonb, p_cargas jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_distribucion->>'id', '')::uuid;
  v_inc uuid := nullif(p_distribucion->>'incubadora_id', '')::uuid;
  v_por text := nullif(p_distribucion->>'registrado_por', '');
  inc   app.incubadora;
begin
  if v_id is null or v_inc is null or nullif(p_distribucion->>'fecha', '') is null
     or nullif(p_distribucion->>'peso_total_kg', '') is null
     or p_cajas is null or jsonb_typeof(p_cajas) <> 'array' or jsonb_array_length(p_cajas) = 0 then
    raise exception 'distribución incompleta' using errcode = '22023';
  end if;

  select * into inc from app.incubadora where id = v_inc and deleted_at is null;
  if inc.id is null then
    raise exception 'la incubadora % no existe en el servidor', v_inc using errcode = '23503';
  end if;
  if exists (select 1 from app.distribucion where id = v_id) then
    return;                                   -- la misma distribución otra vez
  end if;
  if exists (select 1 from app.distribucion where incubadora_id = v_inc and deleted_at is null) then
    raise exception 'La incubadora % ya fue distribuida desde otro teléfono.', inc.codigo
      using errcode = '23505';
  end if;

  insert into app.distribucion (id, incubadora_id, fecha, peso_total_kg, nota,
                                registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, v_inc, (p_distribucion->>'fecha')::timestamptz,
          (p_distribucion->>'peso_total_kg')::numeric, coalesce(p_distribucion->>'nota', ''),
          v_por, nullif(p_distribucion->>'created_by', '')::uuid,
          nullif(p_distribucion->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_distribucion->>'created_at', '')::timestamptz, now()));

  insert into app.caja (id, codigo, incubadora_id, distribucion_id, numero, peso_inicial_kg,
                        nota, registrado_por, created_by, dispositivo_id, created_at)
  select (c->>'id')::uuid, c->>'codigo', v_inc, v_id, (c->>'numero')::int,
         (c->>'peso_inicial_kg')::numeric,
         coalesce(c->>'nota', ''), coalesce(nullif(c->>'registrado_por', ''), v_por),
         nullif(c->>'created_by', '')::uuid, nullif(c->>'dispositivo_id', '')::uuid,
         coalesce(nullif(c->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_cajas) c
  on conflict (id) do nothing;

  insert into app.alimentacion (id, caja_id, carga, fecha, kg, kg_plan, dia_plan, nota,
                                registrado_por, created_by, dispositivo_id, created_at)
  select (a->>'id')::uuid, (a->>'caja_id')::uuid, (a->>'carga')::int,
         (a->>'fecha')::timestamptz, (a->>'kg')::numeric,
         nullif(a->>'kg_plan', '')::numeric, nullif(a->>'dia_plan', '')::int,
         coalesce(a->>'nota', ''), coalesce(nullif(a->>'registrado_por', ''), v_por),
         nullif(a->>'created_by', '')::uuid, nullif(a->>'dispositivo_id', '')::uuid,
         coalesce(nullif(a->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_cargas, '[]'::jsonb)) a
  on conflict (id) do nothing;
end $$;

-- Ingreso al insectario: el ingreso y sus bandejas de pupación. Sólo en un
-- insectario cerrado y limpio: si otro teléfono ya lo repobló, se rechaza.
create or replace function app.ingresar(p_ingreso jsonb, p_bandejas jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id    uuid := nullif(p_ingreso->>'id', '')::uuid;
  v_jaula uuid := nullif(p_ingreso->>'jaula_id', '')::uuid;
  v_por   text := nullif(p_ingreso->>'registrado_por', '');
  j       app.jaula;
begin
  if v_id is null or v_jaula is null or nullif(p_ingreso->>'fecha', '') is null
     or nullif(p_ingreso->>'kg_larvas', '') is null or nullif(p_ingreso->>'generacion', '') is null
     or p_bandejas is null or jsonb_typeof(p_bandejas) <> 'array' or jsonb_array_length(p_bandejas) = 0 then
    raise exception 'ingreso incompleto' using errcode = '22023';
  end if;
  select * into j from app.jaula where id = v_jaula and deleted_at is null;
  if j.id is null then
    raise exception 'el insectario % no existe en el servidor', v_jaula using errcode = '23503';
  end if;
  if exists (select 1 from app.ingreso where id = v_id) then return; end if;
  if j.fase <> 'limpia' then
    raise exception 'El insectario % no está listo para repoblar: %.', j.nombre,
      case j.fase when 'activa' then 'ya está poblado' else 'falta la limpieza' end
      using errcode = '23514';
  end if;

  insert into app.ingreso (id, jaula_id, fecha, kg_larvas, generacion, nota,
                           registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, v_jaula, (p_ingreso->>'fecha')::timestamptz, (p_ingreso->>'kg_larvas')::numeric,
          (p_ingreso->>'generacion')::int, coalesce(p_ingreso->>'nota', ''),
          v_por, nullif(p_ingreso->>'created_by', '')::uuid,
          nullif(p_ingreso->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_ingreso->>'created_at', '')::timestamptz, now()));

  insert into app.bandeja_pupacion (id, codigo, ingreso_id, jaula_id, numero,
                                    peso_kg, nota, registrado_por, created_by, dispositivo_id, created_at)
  select (b->>'id')::uuid, b->>'codigo', v_id, v_jaula, (b->>'numero')::int,
         (b->>'peso_kg')::numeric, coalesce(b->>'nota', ''),
         coalesce(nullif(b->>'registrado_por', ''), v_por),
         nullif(b->>'created_by', '')::uuid, nullif(b->>'dispositivo_id', '')::uuid,
         coalesce(nullif(b->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_bandejas) b
  on conflict (id) do nothing;
end $$;


-- ── 4. Corregir, revisar, borrar ────────────────────────────────────────────
-- Corren con los permisos del dueño de la base (security definer): en modo
-- protegido la llave pública no puede cambiar una fila directamente, sólo por
-- estas funciones, que dejan quién y cuándo. Lo que cada una puede tocar está en
-- su propia lista.

create or replace function app.editar(p_tabla text, p_id uuid, p_cambios jsonb,
                                      p_por text default null, p_at timestamptz default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  permitidos text[];
  k          text;
  sets       text[] := array[]::text[];
  solo_notas boolean := true;
begin
  permitidos := case p_tabla
    when 'contenedor'       then array['codigo', 'nota', 'foto_key']
    when 'jaula'            then array['nombre', 'letra', 'lugar', 'generacion_inicial', 'fase_inicial', 'nota', 'foto_key']
    when 'recepcion'        then array['fecha', 'material', 'kg', 'nota', 'foto_key']
    when 'ensilado'         then array['ensilado_at', 'abierto_at', 'nota', 'foto_key']
    when 'ensilado_insumo'  then array['kg', 'nota', 'foto_key']
    when 'incubadora'       then array['jaula_id', 'generacion', 'recolecta_at', 'peso_inicial_g', 'n_bandejas',
                                       'alimento_inicial_kg', 'nota', 'foto_key']
    when 'distribucion'     then array['fecha', 'peso_total_kg', 'nota', 'foto_key']
    when 'caja'             then array['peso_inicial_kg', 'nota', 'foto_key']
    when 'chequeo'          then array['fecha', 'humedad_pct', 'temperatura_c', 'peso_g', 'peso_kg', 'nota', 'foto_key']
    when 'alimentacion'     then array['fecha', 'kg', 'nota', 'foto_key']
    when 'separacion'       then array['fecha', 'peso_total_kg', 'nota', 'foto_key']
    when 'cochada'          then array['horno_at', 'peso_inicial_kg', 'nota', 'foto_key']
    when 'cochada_origen'   then array['kg', 'nota', 'foto_key']
    when 'cochada_lectura'  then array['fecha', 'temperatura_c', 'peso_kg', 'nota', 'foto_key']
    when 'ingreso'          then array['fecha', 'kg_larvas', 'generacion', 'nota', 'foto_key']
    when 'bandeja_pupacion' then array['peso_kg', 'nota', 'foto_key']
    when 'jaula_evento'     then array['fecha', 'nota', 'foto_key']
  end;
  if permitidos is null then
    raise exception 'no se puede editar %', p_tabla using errcode = '22023';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' or p_cambios = '{}'::jsonb then
    raise exception 'edición vacía' using errcode = '22023';
  end if;
  -- En modo protegido una corrección siempre dice quién la hizo.
  if app.reglas_estrictas() and nullif(trim(coalesce(p_por, '')), '') is null then
    raise exception 'Una corrección tiene que decir quién la hizo.' using errcode = '23514';
  end if;

  for k in select jsonb_object_keys(p_cambios) loop
    if not (k = any (permitidos)) then
      raise exception 'el campo % no se puede editar en %', k, p_tabla using errcode = '22023';
    end if;
    if k not in ('nota', 'foto_key') then solo_notas := false; end if;
    sets := sets || format('%I = r.%I', k, k);
  end loop;
  sets := sets || array['editado_at = coalesce($2, now())', 'editado_por = nullif($3, '''')'];
  if not solo_notas then
    sets := sets || array['valores_editados_at = coalesce($2, now())'];
  end if;

  execute format(
    'update app.%I t set %s from jsonb_populate_record(null::app.%I, $1) r where t.id = $4',
    p_tabla, array_to_string(sets, ', '), p_tabla)
    using p_cambios, p_at, p_por, p_id;
end $$;

create or replace function app.marcar_revisado(p_tabla text, p_id uuid,
                                               p_at timestamptz default null, p_por text default null)
returns void language plpgsql security definer set search_path = app, public as $$
begin
  if p_tabla not in ('incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion', 'separacion',
                     'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso', 'bandeja_pupacion',
                     'jaula', 'jaula_evento', 'recepcion', 'ensilado', 'ensilado_insumo') then
    raise exception 'no se puede revisar %', p_tabla using errcode = '22023';
  end if;
  execute format('update app.%I set revisado_at = coalesce($1, now()) where id = $2', p_tabla)
    using p_at, p_id;
end $$;

-- Borrar desde la app: marca el registro y lo que cuelga de él (el teléfono
-- calcula la lista, src/data/borrado.js), todo junto o nada. Sólo en modo abierto.
create or replace function app.borrar_registros(p_filas jsonb, p_at timestamptz default null, p_por text default null)
returns void language plpgsql security definer set search_path = app, public as $$
declare
  f jsonb;
  t text;
begin
  if app.reglas_estrictas() then
    raise exception 'Los datos están protegidos: no se puede borrar.' using errcode = '42501';
  end if;
  for f in select * from jsonb_array_elements(p_filas) loop
    t := f->>'tabla';
    if t is null or t not in ('contenedor', 'jaula', 'recepcion', 'ensilado', 'ensilado_insumo', 'incubadora',
                              'distribucion', 'caja', 'chequeo', 'alimentacion', 'separacion', 'cochada',
                              'cochada_origen', 'cochada_lectura', 'ingreso', 'bandeja_pupacion', 'jaula_evento') then
      raise exception 'no se puede borrar %', t using errcode = '22023';
    end if;
    execute format('update app.%I set deleted_at = coalesce(deleted_at, $1), editado_at = $1, editado_por = $2 where id = $3', t)
      using coalesce(p_at, now()), nullif(p_por, ''), (f->>'id')::uuid;
  end loop;
end $$;

-- Las otras dos que cambian una fila existente: el cuerpo no cambia.
alter function app.abrir_ensilado(uuid, timestamptz, text) security definer;
alter function app.cerrar_objeto(text, uuid, text, timestamptz, text) security definer;

-- Lo que los registros mantienen al día en otras tablas, también con los permisos
-- del dueño: en modo protegido, quien agrega una separación no podría tocar su caja.
alter function app.trg_tocar_objeto() security definer;
alter function app.trg_tocar_jaula() security definer;
alter function app.trg_jaula_inicial() security definer;
revoke execute on function app.recalcular_jaula(uuid) from public, anon, authenticated;


-- ── 5. En modo protegido, nada con fecha de un día que no ha llegado ────────
-- El teléfono ya lo rechaza; esto vale también para lo que llegue por otro lado.
-- Con un día de margen, por los relojes y las zonas horarias.

create or replace function app.trg_fecha_no_futura()
returns trigger language plpgsql set search_path = app, public as $$
declare
  i     int;
  col   text;
  nueva timestamptz;
begin
  for i in 0 .. tg_nargs - 1 loop
    col := tg_argv[i];
    nueva := (to_jsonb(new) ->> col)::timestamptz;
    if nueva > now() + interval '1 day'
       and (tg_op = 'INSERT' or nueva is distinct from (to_jsonb(old) ->> col)::timestamptz)
       and app.reglas_estrictas() then
      raise exception 'La fecha % todavía no ha llegado.',
        to_char(nueva at time zone 'America/Caracas', 'DD/MM/YYYY HH24:MI') using errcode = '23514';
    end if;
  end loop;
  return new;
end $$;

do $$
declare
  fila text[];
begin
  foreach fila slice 1 in array array[
    ['recepcion', 'fecha', 'fecha'], ['ensilado', 'ensilado_at', 'abierto_at'],
    ['incubadora', 'recolecta_at', 'recolecta_at'], ['distribucion', 'fecha', 'fecha'],
    ['chequeo', 'fecha', 'fecha'], ['alimentacion', 'fecha', 'fecha'], ['separacion', 'fecha', 'fecha'],
    ['cochada', 'horno_at', 'horno_at'], ['cochada_lectura', 'fecha', 'fecha'],
    ['ingreso', 'fecha', 'fecha'], ['jaula_evento', 'fecha', 'fecha']
  ] loop
    execute format('drop trigger if exists %I on app.%I', 't_' || fila[1] || '_fecha', fila[1]);
    execute format('create trigger %I before insert or update on app.%I for each row
                    execute function app.trg_fecha_no_futura(%L, %L)',
                   't_' || fila[1] || '_fecha', fila[1], fila[2], fila[3]);
  end loop;
end $$;


-- ── 6. Lo que puede hacer la llave pública ──────────────────────────────────
-- Una política por cosa que se puede hacer; ninguna para borrar. Sin el permiso,
-- un DELETE se rechaza (42501) en vez de borrar cero filas en silencio.

do $$
declare
  t text;
begin
  foreach t in array array[
    'catalogo', 'parametro', 'contenedor', 'jaula', 'recepcion', 'ensilado',
    'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
    'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
    'bandeja_pupacion', 'jaula_evento'
  ] loop
    execute format('drop policy if exists demo_abierto on app.%I', t);
    execute format('drop policy if exists app_leer on app.%I', t);
    execute format('drop policy if exists app_agregar on app.%I', t);
    execute format('drop policy if exists app_corregir on app.%I', t);
    execute format('create policy app_leer on app.%I for select to anon, authenticated using (true)', t);
    execute format('revoke delete, truncate, references, trigger on app.%I from anon, authenticated', t);
    if t = 'parametro' then
      -- Los ajustes (y el modo) sólo se cambian en Supabase.
      execute format('revoke insert, update on app.%I from anon, authenticated', t);
    else
      execute format('create policy app_agregar on app.%I for insert to anon, authenticated with check (true)', t);
      execute format('create policy app_corregir on app.%I for update to anon, authenticated using (true) with check (true)', t);
    end if;
  end loop;

  -- Correr esto otra vez no abre lo que estaba protegido.
  if app.reglas_estrictas() then
    foreach t in array array[
      'catalogo', 'contenedor', 'jaula', 'recepcion', 'ensilado',
      'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
      'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
      'bandeja_pupacion', 'jaula_evento'
    ] loop
      execute format('revoke update on app.%I from anon, authenticated', t);
    end loop;
  end if;
end $$;

-- Las tablas que se creen después nacen igual: leer y agregar.
alter default privileges in schema app
  revoke update, delete, truncate, references, trigger on tables from anon, authenticated;

grant execute on function app.reglas_estrictas() to anon, authenticated, service_role;
grant execute on function app.borrar_registros(jsonb, timestamptz, text) to anon, authenticated, service_role;

-- Las fotos se suben, y una foto nueva reemplaza a la anterior; no se borran.
drop policy if exists fotos_todo on storage.objects;
drop policy if exists fotos_leer on storage.objects;
drop policy if exists fotos_subir on storage.objects;
drop policy if exists fotos_reemplazar on storage.objects;
create policy fotos_leer on storage.objects
  for select to anon, authenticated using (bucket_id = 'fotos');
create policy fotos_subir on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'fotos');
create policy fotos_reemplazar on storage.objects
  for update to anon, authenticated using (bucket_id = 'fotos') with check (bucket_id = 'fotos');


-- PostgREST: que lea el esquema nuevo ya.
notify pgrst, 'reload schema';
