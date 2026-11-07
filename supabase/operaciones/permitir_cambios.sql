-- ============================================================================
-- PERMITIR CAMBIOS — modo abierto.
--
-- El personal registra lo que tenga, aunque sea tarde o esté mal, corrige y puede
-- borrar registros desde la app. La app sólo pregunta ante lo muy raro.
--
--   · parametro.reglas_estrictas = false: los teléfonos dejan de exigir el orden y
--     las fechas de los protocolos en su próxima sincronización.
--   · app.borrar_registros vuelve a aceptar. Borrar sigue siendo MARCAR: así se
--     entera cada teléfono.
--   · La llave pública vuelve a poder cambiar filas directamente. Las herramientas
--     de QA (cleanup:qa, check:backend) lo necesitan para limpiar sus pruebas.
--
-- Nunca abre: DELETE y TRUNCATE con la llave pública, ni cambiar los ajustes.
-- No toca ningún dato. Se corre en Supabase → SQL Editor, cuantas veces se quiera.
-- Lo contrario: proteger_datos.sql.
-- ============================================================================

begin;

do $$
declare
  t text;
begin
  if to_regprocedure('app.reglas_estrictas()') is null then
    raise exception 'Primero corre supabase/esquema/0011_bandejas_y_reglas.sql.';
  end if;

  update app.parametro set valor = 'false'::jsonb where clave = 'reglas_estrictas';
  if not found then
    raise exception 'Falta el ajuste reglas_estrictas: corre supabase/esquema/0011_bandejas_y_reglas.sql.';
  end if;

  for t in select tablename from pg_tables where schemaname = 'app' and tablename <> 'parametro' loop
    execute format('grant update on app.%I to anon, authenticated', t);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';

select 'ABIERTO: se puede borrar y modificar' as modo,
       (select valor from app.parametro where clave = 'reglas_estrictas') as reglas_estrictas,
       has_table_privilege('anon', 'app.incubadora', 'update') as llave_publica_cambia_filas,
       has_table_privilege('anon', 'app.incubadora', 'delete') as llave_publica_elimina_filas;
