-- ============================================================================
-- VACIAR ANTES DEL ARRANQUE — deja la app sin datos, para empezar de verdad.
--
-- El protocolo lo pide: «antes de empezar se borran todos los datos». Esto
-- marca como borrado TODO lo registrado en la app — racks, contenedores,
-- jaulas, recolectas, cajas, cochadas, ensilados, recepciones y todos sus
-- registros, también los de las pruebas (QA) — y cada teléfono lo quita en su
-- próxima sincronización. Un borrado «de verdad» no llegaría a los teléfonos:
-- los que ya tenían esos datos los conservarían para siempre.
--
-- Se conservan los ajustes (parametro), la lista de materiales y los nombres
-- de las personas. Los nombres de prueba de abajo salen de la lista.
--
-- NO ES UNA MIGRACIÓN y no va en SETUP_COMPLETO.sql. Se corre UNA vez, el día
-- del arranque, en Supabase → SQL Editor, ANTES de registrar los racks, los
-- contenedores y las jaulas de verdad. Desde la app no se puede deshacer.
-- ============================================================================

begin;

do $$
declare t text;
begin
  -- Hijos primero: nada vivo queda apuntando a algo borrado.
  foreach t in array array[
    'cochada_lectura', 'cochada_origen', 'cochada', 'movimiento', 'separacion', 'alimentacion',
    'chequeo', 'caja', 'distribucion', 'bandeja_pupacion', 'ingreso', 'jaula_evento', 'incubadora',
    'ensilado_insumo', 'ensilado', 'recepcion', 'jaula', 'contenedor', 'rack'
  ] loop
    execute format('update app.%I set deleted_at = now() where deleted_at is null', t);
  end loop;
end $$;

update app.catalogo set activo = false
 where tipo = 'operario' and lower(valor) in ('qa claude', 'check-backend', 'check-sync');

commit;

-- Lo que queda en la lista de nombres: que sean sólo personas del laboratorio.
-- Un nombre que sobre se quita con:
--   update app.catalogo set activo = false where tipo = 'operario' and valor = 'Nombre';
select valor as nombre, activo from app.catalogo where tipo = 'operario' order by orden, valor;
