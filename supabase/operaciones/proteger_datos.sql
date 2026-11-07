-- ============================================================================
-- PROTEGER LOS DATOS — modo protegido.
--
-- Nadie borra y los protocolos se cumplen, pero un dato equivocado todavía se
-- corrige, con quién y cuándo, y lo que dependía de él se marca «revisar».
--
--   · parametro.reglas_estrictas = true: en su próxima sincronización cada teléfono
--     exige el orden y las fechas de los protocolos y deja de ofrecer «Borrar».
--   · app.borrar_registros rechaza.
--   · app.editar exige el nombre de quien corrige.
--   · La base rechaza fechas de un día que no ha llegado.
--   · La llave pública ya no puede cambiar filas directamente: registra, y corrige
--     sólo por las funciones que dejan constancia.
--
-- Las herramientas de QA ya no pueden limpiar sus pruebas en este modo: para eso,
-- permitir_cambios.sql primero.
--
-- No toca ningún dato. Se corre en Supabase → SQL Editor, cuantas veces se quiera.
-- Lo contrario: permitir_cambios.sql.
-- ============================================================================

begin;

do $$
declare
  t text;
begin
  if to_regprocedure('app.reglas_estrictas()') is null then
    raise exception 'Primero corre supabase/esquema/0011_bandejas_y_reglas.sql.';
  end if;

  update app.parametro set valor = 'true'::jsonb where clave = 'reglas_estrictas';
  if not found then
    raise exception 'Falta el ajuste reglas_estrictas: corre supabase/esquema/0011_bandejas_y_reglas.sql.';
  end if;

  for t in select tablename from pg_tables where schemaname = 'app' loop
    execute format('revoke update on app.%I from anon, authenticated', t);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';

select 'PROTEGIDO: nadie borra; se corrige con quién y cuándo' as modo,
       (select valor from app.parametro where clave = 'reglas_estrictas') as reglas_estrictas,
       has_table_privilege('anon', 'app.incubadora', 'update') as llave_publica_cambia_filas,
       has_table_privilege('anon', 'app.incubadora', 'delete') as llave_publica_elimina_filas;
