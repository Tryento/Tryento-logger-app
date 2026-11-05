-- ============================================================================
-- 0011 — Con la llave pública nadie borra.
--
-- La app nunca borra: un registro se corrige, y un objeto que se pierde se
-- cierra con su motivo. Pero la llave pública (la de app-config.js, que
-- cualquiera puede leer en la página) podía además BORRAR cualquier fila de
-- cualquier tabla: la política de cada tabla (demo_abierto) era «todo
-- permitido». Desde aquí la llave pública lee, agrega y corrige, y nada más:
-- sin DELETE ni TRUNCATE, ni en las tablas ni en las fotos.
--
-- No cambia nada de lo que hace la app. Se puede correr antes o después de
-- publicarla, y correrlo otra vez no cambia nada.
--
-- Sigue abierto: quien tenga la dirección de la app puede leer y escribir,
-- porque no hay inicio de sesión. Eso necesita un proveedor de inicio de
-- sesión configurado en Supabase (ver DEPLOY.md, «Before this is real»).
--
-- Borrar de verdad (los datos de prueba, por ejemplo) se hace desde el editor
-- SQL de Supabase, que entra como dueño de la base, no con la llave pública.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'catalogo', 'parametro', 'rack', 'contenedor', 'jaula', 'recepcion', 'ensilado',
    'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
    'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
    'bandeja_pupacion', 'jaula_evento', 'movimiento'
  ] loop
    -- Una política por cosa que se puede hacer; ninguna para borrar.
    execute format('drop policy if exists demo_abierto on app.%I', t);
    execute format('drop policy if exists app_leer on app.%I', t);
    execute format('drop policy if exists app_agregar on app.%I', t);
    execute format('drop policy if exists app_corregir on app.%I', t);
    execute format('create policy app_leer on app.%I for select to anon, authenticated using (true)', t);
    execute format('create policy app_agregar on app.%I for insert to anon, authenticated with check (true)', t);
    execute format('create policy app_corregir on app.%I for update to anon, authenticated using (true) with check (true)', t);
    -- Y sin el permiso: un DELETE se rechaza (42501) en vez de borrar cero filas en silencio.
    execute format('revoke delete, truncate, references, trigger on app.%I from anon, authenticated', t);
  end loop;
end $$;

-- Lo mismo para las tablas que se creen después.
alter default privileges in schema app revoke delete, truncate, references, trigger on tables from anon, authenticated;

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

notify pgrst, 'reload schema';
