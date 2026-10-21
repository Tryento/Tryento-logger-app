/**
 * check-sql-applied.mjs — is the SQL the app needs live on Supabase?
 *
 *   npm run check:sql-applied
 *
 * The app calls RPCs by name, so pushing app code before its SQL breaks those
 * actions in production. This answers "has 0010 been run?" from the database
 * itself instead of from memory.
 *
 * Every probe is READ-ONLY or a guaranteed no-op: the multi-row calls are made
 * empty (they refuse before writing anything, 22023), and the stamps and edits
 * aim at an id that does not exist, so they match zero rows. Nothing is
 * created, changed or deleted.
 *
 * The test suite runs `comprobar` against a local Postgres too.
 */
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './qa.mjs';

/** An id that cannot exist, so every stamp and edit updates nothing. */
const NOBODY = '00000000-0000-4000-8000-000000000000';

const TABLAS = ['catalogo', 'parametro', 'rack', 'contenedor', 'jaula', 'recepcion', 'ensilado',
  'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion', 'separacion',
  'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso', 'bandeja_pupacion', 'jaula_evento', 'movimiento'];

/** Every probe against `db`: [{ mig, label, ok }]. */
export async function comprobar(db) {
  const table = async name => {
    const { error } = await db.from(name).select('*').limit(0);
    return !error;
  };
  const column = async (tbl, col) => {
    const { error } = await db.from(tbl).select(col).limit(0);
    return !error;
  };
  /** Exists, with these argument names: PostgREST answers PGRST202 when no
   *  function matches, PGRST203 when two do. A refusal of the empty input is
   *  the function answering. */
  const rpc = async (name, args) => {
    const { error } = await db.rpc(name, args);
    return !(error && (error.code === 'PGRST202' || error.code === 'PGRST203' ||
                       /could not (find|choose)|is not unique/i.test(error.message)));
  };

  const checks = [
    ...TABLAS.map(t => ['0010', 'tabla ' + t, () => table(t)]),
    ['0010', 'jaula.fase (la mantienen ingresos, cierres y limpiezas)', () => column('jaula', 'fase')],
    ['0010', 'separacion.coccion_kg y retorno_kg', async () => (await column('separacion', 'coccion_kg')) && column('separacion', 'retorno_kg')],
    ['0010', 'valores_editados_at y revisado_at', () => column('chequeo', 'valores_editados_at,revisado_at')],
    ['0010', 'las tablas del protocolo anterior ya no existen', async () =>
        !(await table('insectario')) && !(await table('bandeja')) && !(await table('lote'))],
    ['0010', 'distribuir(p_distribucion, p_cajas, p_cargas)', () => rpc('distribuir', { p_distribucion: {}, p_cajas: [], p_cargas: [] })],
    ['0010', 'crear_cochada(p_cochada, p_origenes)', () => rpc('crear_cochada', { p_cochada: {}, p_origenes: [] })],
    ['0010', 'ingresar(p_ingreso, p_bandejas)', () => rpc('ingresar', { p_ingreso: {}, p_bandejas: [] })],
    ['0010', 'crear_ensilado(p_ensilado, p_insumos)', () => rpc('crear_ensilado', { p_ensilado: {}, p_insumos: [] })],
    ['0010', 'abrir_ensilado(p_id, p_at, p_por)', () => rpc('abrir_ensilado', { p_id: NOBODY, p_at: null, p_por: null })],
    ['0010', 'cerrar_objeto(p_tabla, p_id, p_motivo, p_at, p_por)', () =>
        rpc('cerrar_objeto', { p_tabla: 'incubadora', p_id: NOBODY, p_motivo: 'prueba', p_at: null, p_por: null })],
    ['0010', 'editar(p_tabla, p_id, p_cambios, p_por, p_at)', () =>
        rpc('editar', { p_tabla: 'rack', p_id: NOBODY, p_cambios: { nota: 'prueba' }, p_por: null, p_at: null })],
    ['0010', 'marcar_revisado(p_tabla, p_id, p_at, p_por)', () =>
        rpc('marcar_revisado', { p_tabla: 'incubadora', p_id: NOBODY, p_at: null, p_por: null })],
    ['0010', 'los ajustes del protocolo', async () => {
        const { data, error } = await db.from('parametro').select('clave');
        return !error && ['dia_chequeo_incubadora', 'cargas', 'pct_coccion', 'kg_bandeja_pupacion', 'dias_maduracion',
                          'horas_consumo', 'alimento_inicial_incubadora_kg'].every(k => data.some(r => r.clave === k));
      }],
    ['0010', 'la lista de materiales', async () => {
        const { data, error } = await db.from('catalogo').select('valor').eq('tipo', 'material_alimento');
        return !error && data.length >= 4;
      }],
    ['0010', 'los nombres de las personas', async () => {
        const { data, error } = await db.from('catalogo').select('valor').eq('tipo', 'operario');
        return !error && data.length >= 1;
      }]
  ];

  const out = [];
  for (const [mig, label, fn] of checks) out.push({ mig, label, ok: await fn().catch(() => false) });
  return out;
}

/* ── command line ────────────────────────────────────────────────────────── */

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = await loadConfig();
  const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    db: { schema: cfg.dbSchema || 'app' },
    auth: { persistSession: false, autoRefreshToken: false }
  });
  let bad = 0;
  for (const { mig, label, ok } of await comprobar(db)) {
    if (!ok) bad++;
    console.log(`  ${ok ? 'ok  ' : 'FALTA'}  [${mig}] ${label}`);
  }

  // Not a failure, but the recolecta form has nothing to propose until it is set.
  const { data: usual } = await db.from('parametro').select('valor').eq('clave', 'alimento_inicial_incubadora_kg');
  if (usual && usual.length && (usual[0].valor === null || usual[0].valor === undefined)) {
    console.log('\n  aviso  alimento_inicial_incubadora_kg sigue sin valor: la recolecta no propone los kg.' +
                '\n         Se pone en Supabase → Table editor → app.parametro (por ejemplo 2).');
  }

  console.log(bad ? `\n${bad} sin aplicar.` : '\nTodo lo que la app necesita está aplicado.');
  process.exitCode = bad ? 1 : 0;
}
