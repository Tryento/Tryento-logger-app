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
  ['0006', 'marcar_atractante(p_id, p_fecha)',           () => rpcUnambiguous('marcar_atractante', { p_id: NOBODY, p_fecha: '2000-01-01' })]
];

let bad = 0;
for (const [mig, label, fn] of checks) {
  const okay = await fn().catch(() => false);
  if (!okay) bad++;
  console.log(`  ${okay ? 'ok  ' : 'FALTA'}  [${mig.padEnd(10)}] ${label}`);
}
console.log(bad ? `\n${bad} sin aplicar.` : '\nTodas las migraciones esperadas están aplicadas.');
process.exitCode = bad ? 1 : 0;
