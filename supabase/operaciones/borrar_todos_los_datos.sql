-- ============================================================================
-- BORRAR TODOS LOS DATOS — sin restricciones y para siempre.
--
-- Elimina de verdad TODO lo registrado en la app: insectarios, contenedores,
-- recolectas, bandejas, cochadas, ensilados, recepciones y todos sus registros.
-- No se puede deshacer.
--
-- SE QUEDA:   los ajustes (parametro), la lista de materiales y los nombres de las
--             personas. El modo de los datos (abierto o protegido) no cambia. El
--             esquema `historico`, que la app no usa, no se toca.
-- LAS FOTOS:  no salen con SQL. Se vacían en Supabase → Storage → fotos.
--
-- LOS TELÉFONOS: una fila eliminada no les llega por sincronización, así que
-- esto deja la hora del borrado en parametro (datos_vaciados_at). Cada teléfono
-- la ve al sincronizar y borra lo suyo de antes de esa hora, también lo que tenía
-- sin subir. Lo que un teléfono registre después se conserva; si dependía de algo
-- borrado, aparece en Conflictos.
--
-- NO ES PARTE DEL ESQUEMA: no va en SETUP_COMPLETO.sql. Se corre a mano, en
-- Supabase → SQL Editor, sólo cuando de verdad se quiera empezar de cero.
-- ============================================================================

begin;

-- Toda tabla de la app menos las dos que se quedan: una tabla nueva no se puede
-- olvidar. Todas en una sola orden, por las referencias entre ellas.
do $$
declare
  tablas text;
begin
  select string_agg(format('app.%I', tablename), ', ') into tablas
    from pg_tables
   where schemaname = 'app' and tablename not in ('parametro', 'catalogo');
  execute 'truncate ' || tablas;
end $$;

insert into app.parametro (clave, valor, descripcion)
values ('datos_vaciados_at', to_jsonb(now()),
        'Cuándo se borraron todos los datos (borrar_todos_los_datos.sql). Los teléfonos borran lo suyo de antes de esta hora.')
on conflict (clave) do update set valor = excluded.valor;

-- Los nombres de las pruebas no son personas del laboratorio.
update app.catalogo set activo = false
 where tipo = 'operario' and activo and lower(valor) in ('qa claude', 'check-backend', 'check-sync');

commit;

-- Lo que queda en la lista de nombres: que sean sólo personas del laboratorio.
-- Un nombre que sobre se quita con:
--   update app.catalogo set activo = false where tipo = 'operario' and valor = 'Nombre';
select valor as nombre, activo from app.catalogo where tipo = 'operario' order by orden, valor;
