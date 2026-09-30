/**
 * check-sql-applied.mjs — which numbered migrations are live on Supabase?
 *
 *   npm run check:sql-applied
 *
 * The app calls RPCs by name, so pushing app code before its SQL breaks those
 * actions in production. This answers "has 000N been run?" from the database
 * itself instead of from memory.
 *
 * Every probe is READ-ONLY or a guaranteed no-op: the CAS functions are called
 * against an id that does not exist, so they match zero rows. Nothing is
 * created, changed or deleted.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
const win = {};
new Function('window', src)(win);
const cfg = win.__TRYENTO_CONFIG__ || {};

const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
  db: { schema: cfg.dbSchema || 'app' },
  auth: { persistSession: false, autoRefreshToken: false }
});

/** An id that cannot exist, so every CAS probe updates nothing. */
const NOBODY = '00000000-0000-4000-8000-000000000000';

const table = async name => {
  const { error } = await db.from(name).select('*').limit(0);
  return !error;
};
const column = async (tbl, col) => {
  const { error } = await db.from(tbl).select(col).limit(0);
  return !error;
};
/** PostgREST answers PGRST202 when no function matches the name + args. */
const rpc = async (name, args) => {
  const { error } = await db.rpc(name, args);
  return !(error && (error.code === 'PGRST202' || /could not find the function/i.test(error.message)));
};
/** ...and PGRST203 when TWO match: the duplicate overloads 0006 removes. */
const rpcUnambiguous = async (name, args) => {
  const { error } = await db.rpc(name, args);
  return !(error && (error.code === 'PGRST202' || error.code === 'PGRST203' ||
                     /could not (find|choose)|is not unique/i.test(error.message)));
};

const checks = [
  ['0004', 'columna insectario.fecha_ovipositores_por', () => column('insectario', 'fecha_ovipositores_por')],
  ['0004', 'marcar_atractante(p_id, p_fecha, p_por)',    () => rpc('marcar_atractante', { p_id: NOBODY, p_fecha: '2000-01-01', p_por: null })],
  ['0004', 'marcar_despachado(p_id, p_por)',             () => rpc('marcar_despachado', { p_id: NOBODY, p_por: null })],
  ['0005', 'tabla lote',                                 () => table('lote')],
  ['0005', 'tabla lote_separacion',                      () => table('lote_separacion')],
  ['0005', 'columna lote_separacion.lote_id',            () => column('lote_separacion', 'lote_id')],
  ['0005', 'rechazar_lote(p_id, p_motivo, p_por)',       () => rpc('rechazar_lote', { p_id: NOBODY, p_motivo: 'x', p_por: null })],
  ['0005', 'actualizar_qc_lote(...)',                    () => rpc('actualizar_qc_lote', {
      p_id: NOBODY, p_tiempo: null, p_peso_final: null, p_color: null,
      p_prueba: null, p_aprobado: null, p_foto_key: null, p_por: null })],
  ['0005', 'vista v_rendimiento_lote',                   () => table('v_rendimiento_lote')],
  ['0005', 'tabla cochada ya NO existe',                 async () => !(await table('cochada'))],
  // Called the way phones on older builds call them: without p_por.
  ['0006', 'marcar_despachado(p_id) sin ambigüedad',     () => rpcUnambiguous('marcar_despachado', { p_id: NOBODY })],
  ['0006', 'marcar_empacado(p_id, p_vencimiento)',       () => rpcUnambiguous('marcar_empacado', { p_id: NOBODY, p_vencimiento: null })],
  ['0006', 'marcar_atractante(p_id, p_fecha)',           () => rpcUnambiguous('marcar_atractante', { p_id: NOBODY, p_fecha: '2000-01-01' })],
  // Protocolo v2. The two new functions reject empty input before writing
  // anything (22023), so calling them empty only proves they exist.
  ['0007', 'columna bandeja.protocolo',                  () => column('bandeja', 'protocolo')],
  ['0007', 'columna alimentacion.carga',                 () => column('alimentacion', 'carga')],
  ['0007', 'columna separacion.reserva_cria_g',          () => column('separacion', 'reserva_cria_g')],
  ['0007', 'tabla incubadora',                           () => table('incubadora')],
  ['0007', 'tabla parametro',                            () => table('parametro')],
  ['0007', 'crear_recoleccion_v2(...)',                  () => rpc('crear_recoleccion_v2', { p_recoleccion: {}, p_incubadora: {} })],
  ['0007', 'distribuir_incubadora(...)',                 () => rpc('distribuir_incubadora', { p_distribucion: {}, p_bandejas: [], p_cargas: [] })],
  ['0007', 'cerrar_ayuno(p_id, p_peso, p_at, p_por)',    () => rpcUnambiguous('cerrar_ayuno', { p_id: NOBODY, p_peso: null, p_at: null, p_por: null })],
  ['0007', 'cerrar_ayuno sin p_por (teléfonos viejos)',  () => rpcUnambiguous('cerrar_ayuno', { p_id: NOBODY, p_peso: null, p_at: null })],
  // Alimento. crear_ensilaje rejects an empty batch and avanzar_ensilaje an
  // unknown step (22023) before touching anything.
  ['0008', 'tabla recepcion_alimento',                   () => table('recepcion_alimento')],
  ['0008', 'tabla ensilaje',                             () => table('ensilaje')],
  ['0008', 'tabla ensilaje_insumo',                      () => table('ensilaje_insumo')],
  ['0008', 'tabla ensilaje_lectura',                     () => table('ensilaje_lectura')],
  ['0008', 'columna alimentacion.ensilaje_id',           () => column('alimentacion', 'ensilaje_id')],
  ['0008', 'vista v_stock_ensilaje',                     () => table('v_stock_ensilaje')],
  ['0008', 'vista v_stock_material',                     () => table('v_stock_material')],
  ['0008', 'crear_ensilaje(...)',                        () => rpc('crear_ensilaje', { p_ensilaje: {}, p_insumos: [] })],
  ['0008', 'avanzar_ensilaje(p_id, p_paso, p_at, p_por)', () => rpcUnambiguous('avanzar_ensilaje', { p_id: NOBODY, p_paso: 'ninguno', p_at: null, p_por: null })],
  ['0008', 'parámetro dias_fermentacion',                async () => {
      const { data, error } = await db.from('parametro').select('clave').eq('clave', 'dias_fermentacion');
      return !error && data.length === 1;
    }]
];

let bad = 0;
for (const [mig, label, fn] of checks) {
  const okay = await fn().catch(() => false);
  if (!okay) bad++;
  console.log(`  ${okay ? 'ok  ' : 'FALTA'}  [${mig.padEnd(10)}] ${label}`);
}
console.log(bad ? `\n${bad} sin aplicar.` : '\nTodas las migraciones esperadas están aplicadas.');
process.exitCode = bad ? 1 : 0;
