/**
 * check-backend.mjs — prove the database actually works, end to end.
 *
 *   npm run check:backend
 *
 * Everything else in this repo can be verified without a database. This cannot:
 * whether the schema applied, whether the schema is exposed, whether grants are
 * right, whether the triggers fire, whether the constraints hold. Those only
 * fail once, in production, on the first day — which is exactly when you least
 * want to be debugging them.
 *
 * So this writes a real colony, tray, feeding, fast, harvest and oven run
 * through the same SQL the app uses, checks the computed values and the state
 * machine came out right, and then REMOVES EVERYTHING IT CREATED — by marking
 * it deleted (deleted_at), never with a hard DELETE.
 *
 * Why soft: phones pull changes by `updated_at`, and a hard DELETE is invisible
 * to that. A phone that had pulled these rows kept them forever, and anything
 * recorded under them was rejected by the server with a foreign-key error
 * (409 bandeja_recoleccion_id_fkey). Marking them deleted bumps updated_at, so
 * every phone drops them on its next sync. `node tools/cleanup-qa.mjs --purge`
 * hard-deletes them later, once every phone has had time to see that.
 *
 * Test rows are prefixed ZZTEST- (codes) and registered by "check-backend", so
 * they are trivial to find.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'ZZTEST-';

let pass = 0, fail = 0;
const created = { lote: [], separacion: [], ayuno: [], revision: [], alimentacion: [], bandeja: [], incubadora: [], recoleccion: [], insectario: [],
                  ensilaje_lectura: [], ensilaje_insumo: [], ensilaje: [], recepcion_alimento: [] };

function ok(label, extra = '') { pass++; console.log(`  ok    ${label}${extra ? '   ' + extra : ''}`); }
function bad(label, why, fix) {
  fail++;
  console.log(`  FAIL  ${label}`);
  console.log(`        ${why}`);
  if (fix) console.log(`        → ${fix}`);
}

const uuid = () => crypto.randomUUID();

/** Decode a JWT payload without verifying it — just to spot a service_role key. */
function safeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}


async function loadConfig() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    return { supabaseUrl: process.env.SUPABASE_URL, supabaseAnonKey: process.env.SUPABASE_ANON_KEY, dbSchema: 'app', storageBucket: 'fotos' };
  }
  const src = await readFile(path.join(ROOT, 'app-config.js'), 'utf8');
  const win = {};
  new Function('window', src)(win);
  return win.__TRYENTO_CONFIG__ || {};
}

async function main() {
  console.log('Verificando el backend...\n');

  const cfg = await loadConfig();

  if (!cfg.supabaseUrl) {
    bad('configuración', 'Falta supabaseUrl en app-config.js.',
        'Supabase → Settings → API → "Project URL".');
    return;
  }
  // The dashboard shows the REST endpoint as well, and it is the one people
  // copy. supabase-js appends /rest/v1 itself, so pasting it gives requests to
  // /rest/v1/rest/v1/... and a 404 that looks like the schema is missing.
  if (/\/rest\/v1/.test(cfg.supabaseUrl)) {
    bad('configuración', `supabaseUrl es el endpoint REST: ${cfg.supabaseUrl}`,
        `Quita "/rest/v1/". Debe quedar: ${cfg.supabaseUrl.split('/rest/')[0]}`);
    return;
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(cfg.supabaseUrl)) {
    bad('configuración', `supabaseUrl no tiene la forma esperada: ${cfg.supabaseUrl}`,
        'Debe ser https://xxxxxxxx.supabase.co (sin nada después).');
    return;
  }
  if (!cfg.supabaseAnonKey) {
    bad('configuración', 'Falta supabaseAnonKey en app-config.js.',
        'Supabase → Settings → API Keys → la clave "anon" / "public".');
    return;
  }
  // A service_role key here would be published to every visitor of the site.
  if (/service_role/.test(cfg.supabaseAnonKey) ||
      /"role"\s*:\s*"service_role"/.test(safeJwtPayload(cfg.supabaseAnonKey))) {
    bad('configuración', 'Esa es la clave service_role, no la anon.',
        'La service_role ignora todas las políticas y quedaría pública en el sitio. Usa la "anon"/"public".');
    return;
  }
  ok('configuración', cfg.supabaseUrl);

  const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    db: { schema: cfg.dbSchema || 'app' },
    auth: { persistSession: false, autoRefreshToken: false }
  });

  /* 1 ── can we reach the schema at all? ─────────────────────────────────── */
  {
    const { data, error } = await db.from('catalogo').select('tipo, valor').limit(50);
    if (error) {
      const notExposed = /schema|does not exist|404|PGRST106/i.test(error.message + (error.code || ''));
      bad('esquema accesible', error.message,
        notExposed
          ? 'Supabase → Settings → API → "Exposed schemas": agrega "app". Es el error más común.'
          : 'Revisa que 0001_schema.sql se haya ejecutado completo.');
      return;
    }
    ok('esquema accesible', `${data.length} valores de catálogo`);

    const tipos = new Set(data.map(r => r.tipo));
    for (const t of ['nombre_insectario', 'tipo_alimento', 'tipo_iniciador', 'qc_color_dorado']) {
      if (!tipos.has(t)) bad(`catálogo ${t}`, 'no tiene valores', 'Ejecuta 0003_seed.sql.');
    }
    if (tipos.size >= 4) ok('catálogos sembrados', [...tipos].join(', '));
  }

  /* 2 ── insert a colony, and check the computed columns ─────────────────── */
  const insId = uuid();
  {
    const { error } = await db.from('insectario').insert({
      id: insId, codigo: PREFIX + Date.now(), nombre_insectario: 'ICB',
      fecha_inicio: '2026-05-01', biomasa_kg: 3.1,
      proyeccion_cierre: '2026-05-22', registrado_por: 'check-backend'
    });
    if (error) {
      bad('escritura', error.message,
        /permission denied/i.test(error.message)
          ? 'Faltan los GRANT del final de 0001_schema.sql.'
          : 'Revisa que 0001_schema.sql se haya ejecutado completo.');
      return;
    }
    created.insectario.push(insId);
    ok('escritura');

    const { data } = await db.from('insectario')
      .select('poblacion_estimada, estado, desviacion_cierre_dias').eq('id', insId).single();

    if (data?.poblacion_estimada === 155000) ok('columna calculada', 'poblacion_estimada = biomasa × 50000');
    else bad('columna calculada', `poblacion_estimada = ${data?.poblacion_estimada}, se esperaba 155000`);

    if (data?.estado === 'activo') ok('estado explícito', 'insectario = activo');
    else bad('estado explícito', `estado = ${data?.estado}`);

    // The whole reason for the rebuild: a missing date must produce NOTHING,
    // not the ~-20,676 that AppSheet wrote.
    if (data?.desviacion_cierre_dias === null) ok('desviación nula sin fecha real', 'no hay valores basura');
    else bad('desviación nula sin fecha real', `devolvió ${data?.desviacion_cierre_dias}, se esperaba null`);
  }

  /* 3 ── the chain down to a tray ────────────────────────────────────────── */
  const recId = uuid(), banId = uuid();
  {
    let r = await db.from('recoleccion').insert({
      id: recId, insectario_id: insId, recolecta: '1',
      fecha: new Date().toISOString(), huevos_g: 0.62, registrado_por: 'check-backend'
    });
    if (r.error) { bad('recolección', r.error.message); return; }
    created.recoleccion.push(recId);

    r = await db.from('bandeja').insert({
      id: banId, recoleccion_id: recId, no_bandeja: 1, id_bandeja: PREFIX + '1',
      fecha: new Date().toISOString(), gramos_huevos: 0.5, iniciador_g: 300,
      tipo_iniciador: 'Bagazo', registrado_por: 'check-backend'
    });
    if (r.error) { bad('bandeja', r.error.message); return; }
    created.bandeja.push(banId);
    ok('claves foráneas', 'insectario → recolección → bandeja');

    // The FK must actually reject an orphan, or nothing is protected.
    const orphan = await db.from('bandeja').insert({
      id: uuid(), recoleccion_id: uuid(), no_bandeja: 99, id_bandeja: PREFIX + 'orphan',
      fecha: new Date().toISOString()
    });
    if (orphan.error?.code === '23503') ok('integridad referencial', 'rechaza una bandeja huérfana');
    else bad('integridad referencial', 'aceptó una bandeja sin recolección válida',
             'Las FOREIGN KEY de 0001_schema.sql no se crearon.');
  }

  /* 4 ── the bulk feed, atomically ───────────────────────────────────────── */
  {
    const grupalId = uuid(), rowId = uuid();
    const { error } = await db.rpc('log_alimentacion_grupal', {
      p_rows: [{
        id: rowId, bandeja_id: banId, fecha: new Date().toISOString(),
        tipo_alimento: 'Bagazo', cantidad_kg: 1.3, grupal_id: grupalId,
        notas: '', registrado_por: 'check-backend', dispositivo_id: uuid()
      }]
    });
    if (error) bad('alimentación grupal (RPC)', error.message, 'Revisa app.log_alimentacion_grupal en 0001_schema.sql.');
    else { created.alimentacion.push(rowId); ok('alimentación grupal (RPC)', 'una sola operación atómica'); }
  }

  /* 5 ── the state machine — this is the trigger, and it must fire ───────── */
  const ayunoId = uuid();
  {
    const r = await db.from('ayuno').insert({
      id: ayunoId, bandeja_id: banId, fecha: new Date().toISOString(),
      peso_inicial_kg: 1.2, horas_ayuno: 24, registrado_por: 'check-backend'
    });
    if (r.error) { bad('ayuno', r.error.message); return; }
    created.ayuno.push(ayunoId);

    const { data } = await db.from('bandeja').select('estado').eq('id', banId).single();
    if (data?.estado === 'en_ayuno') ok('trigger de estado', 'la bandeja pasó a en_ayuno sola');
    else bad('trigger de estado', `la bandeja quedó en "${data?.estado}"`,
             'El trigger t_ayuno_estado no se creó. Sin él, el estado vuelve a ser una mentira silenciosa.');

    // Closing the fast — the write the old app could not express at all.
    const c = await db.rpc('cerrar_ayuno', { p_id: ayunoId, p_peso: 1.05, p_at: new Date().toISOString() });
    if (c.error) bad('cerrar ayuno (RPC)', c.error.message);
    else {
      const { data: a } = await db.from('ayuno').select('merma_pct, peso_final_kg').eq('id', ayunoId).single();
      if (a?.merma_pct !== null && Math.abs(a.merma_pct - 12.5) < 0.01) ok('merma calculada', `${a.merma_pct}%`);
      else bad('merma calculada', `merma_pct = ${a?.merma_pct}, se esperaba 12.5`);
    }
  }

  /* 6 ── harvest, and the uniqueness that offline devices will hit ───────── */
  const sepId = uuid();
  {
    const r = await db.from('separacion').insert({
      id: sepId, bandeja_id: banId, fecha: new Date().toISOString(),
      larva_limpia_g: 410, registrado_por: 'check-backend'
    });
    if (r.error) { bad('separación', r.error.message); return; }
    created.separacion.push(sepId);

    const { data } = await db.from('bandeja').select('estado').eq('id', banId).single();
    if (data?.estado === 'cosechada') ok('estado monotónico', 'en_ayuno → cosechada');
    else bad('estado monotónico', `la bandeja quedó en "${data?.estado}"`);

    // Two offline devices WILL both try this. The database has to be the one
    // that says no, or a harvest gets silently duplicated.
    const dup = await db.from('separacion').insert({
      id: uuid(), bandeja_id: banId, fecha: new Date().toISOString(), larva_limpia_g: 99
    });
    if (dup.error?.code === '23505') ok('una separación por bandeja', 'rechaza la segunda');
    else bad('una separación por bandeja', 'aceptó una segunda separación',
             'Falta el índice ux_separacion_bandeja.');
  }

  /* 7 ── the oven run and its join rows, in one transaction ──────────────── */
  const cochId = uuid();
  {
    const { error } = await db.rpc('crear_lote', {
      p_lote: {
        id: cochId, codigo: PREFIX + 'C' + Date.now(), fecha: new Date().toISOString(),
        peso_inicial_kg: 0.41, bandejas_metalicas_usadas: 1, notas: '',
        registrado_por: 'check-backend', dispositivo_id: uuid()
      },
      p_separacion_ids: [sepId]
    });
    if (error) { bad('crear lote (RPC)', error.message); }
    else {
      created.lote.push(cochId);
      const { data: links } = await db.from('lote_separacion').select('separacion_id').eq('lote_id', cochId);
      if (links?.length === 1) ok('lote + separaciones', 'creadas juntas, nunca a medias');
      else bad('lote + separaciones', `se crearon ${links?.length ?? 0} vínculos, se esperaba 1`);

      await db.rpc('actualizar_qc_lote', {
        p_id: cochId, p_tiempo: 14, p_peso_final: 0.11,
        p_color: 'Muy Crujiente', p_prueba: null, p_aprobado: true, p_foto_key: null
      });
      const { data: c } = await db.from('lote').select('estado, rendimiento_pct').eq('id', cochId).single();
      if (c?.estado === 'en_qc') ok('ciclo de el lote', `en_qc, rendimiento ${c.rendimiento_pct}%`);
      else bad('ciclo de el lote', `estado = ${c?.estado}, se esperaba en_qc`);

      // Dispatching before packing must be impossible.
      await db.rpc('marcar_despachado', { p_id: cochId });
      const { data: c2 } = await db.from('lote').select('estado').eq('id', cochId).single();
      if (c2?.estado === 'en_qc') ok('orden del proceso', 'no deja despachar sin empacar');
      else bad('orden del proceso', `permitió pasar a "${c2?.estado}" sin empacar`);
    }
  }

  /* 8 ── the analytics views the dashboard reads ─────────────────────────── */
  {
    const views = ['v_rendimiento_bandeja', 'v_fcr_bandeja', 'v_tiempos_ciclo',
                   'v_productividad_insectario', 'v_rendimiento_lote',
                   'v_actividad_operario', 'v_calidad_datos', 'v_estado_drift'];
    const missing = [];
    for (const v of views) {
      const { error } = await db.from(v).select('*').limit(1);
      if (error) missing.push(`${v} (${error.message})`);
    }
    if (!missing.length) ok('vistas de análisis', `${views.length} disponibles`);
    else bad('vistas de análisis', missing.join('; '), 'Ejecuta 0002_views.sql.');
  }

  /* 9 ── photo storage ───────────────────────────────────────────────────── */
  {
    const bucket = db.storage.from(cfg.storageBucket || 'fotos');
    // Must be a real image: the bucket restricts allowed_mime_types to
    // jpeg/png/webp, and in Node a Blob built without an explicit type arrives
    // as application/octet-stream regardless of the contentType option.
    // A 1x1 transparent PNG is the smallest thing that satisfies both.
    const PNG_1PX = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64');
    const key = `${PREFIX}check/${uuid()}.png`;
    const { error } = await bucket.upload(key, new Blob([PNG_1PX], { type: 'image/png' }),
                                          { contentType: 'image/png', upsert: true });
    if (error) {
      bad('almacenamiento de fotos', error.message,
        'Ejecuta 0003_seed.sql (crea el bucket "fotos" y su policy).');
    } else {
      ok('almacenamiento de fotos', 'subida y borrado');
      await bucket.remove([key]);
    }
  }

  /* 10 ── protocolo v2 (0007) ────────────────────────────────────────────── */
  let v2Tray = null;
  {
    const par = await db.from('parametro').select('clave, valor');
    if (par.error) {
      bad('protocolo v2: parámetros', par.error.message, 'Ejecuta 0007_protocolo_v2.sql.');
    } else {
      const cargas = (par.data.find(p => p.clave === 'cargas') || {}).valor;
      if (Array.isArray(cargas) && cargas.length) ok('protocolo v2: parámetros', `${cargas.length} cargas en el plan`);
      else bad('protocolo v2: parámetros', 'no está la clave "cargas"', 'Ejecuta 0007_protocolo_v2.sql.');

      const rec2 = uuid(), inc2 = uuid();
      const c = await db.rpc('crear_recoleccion_v2', {
        p_recoleccion: { id: rec2, insectario_id: insId, recolecta: '2', fecha: new Date().toISOString(),
                         peso_ovipositores_g: 300, atrayente_cambiado: true, registrado_por: 'check-backend' },
        p_incubadora: { id: inc2, codigo: PREFIX + 'INC' + Date.now(), fecha_inicio: new Date().toISOString().slice(0, 10),
                        registrado_por: 'check-backend' }
      });
      if (c.error) { bad('protocolo v2: recolecta + incubadora', c.error.message); }
      else {
        created.recoleccion.push(rec2); created.incubadora.push(inc2);
        ok('protocolo v2: recolecta + incubadora', 'juntas, en una operación');
        const b2 = uuid(), f1 = uuid();
        const d = await db.rpc('distribuir_incubadora', {
          p_distribucion: { incubadora_id: inc2, registrado_por: 'check-backend' },
          p_bandejas: [{ id: b2, no_bandeja: 1, id_bandeja: PREFIX + 'V2-01', individuos: 25000 }],
          p_cargas: [{ id: f1, bandeja_id: b2, cantidad_kg: 1.5, carga: 1, tipo_alimento: 'Ensilaje' }]
        });
        if (d.error) bad('protocolo v2: distribución', d.error.message);
        else {
          created.bandeja.push(b2); created.alimentacion.push(f1);
          const { data: t } = await db.from('bandeja').select('protocolo, incubadora_id').eq('id', b2).single();
          const { data: a } = await db.from('alimentacion').select('protocolo, carga').eq('id', f1).single();
          if (t?.protocolo === 'v2' && a?.protocolo === 'v2' && a?.carga === 1) {
            ok('protocolo v2: distribución', 'bandeja v2 con su carga 1');
            v2Tray = b2;
          } else {
            bad('protocolo v2: distribución', `bandeja ${t?.protocolo}, carga ${a?.protocolo}/${a?.carga}`);
          }
        }
      }
    }
  }

  /* 11 ── alimento (0008) ───────────────────────────────────────────────── */
  {
    const probe = await db.from('ensilaje').select('id').limit(0);
    if (probe.error) {
      // Release 1 runs without it: say so, without failing the check.
      console.log('  --    alimento (0008): todavía no aplicado; se revisa cuando corras 0008_alimento.sql');
    } else {
      const rec = uuid(), ens = uuid(), ins = uuid(), lec = uuid();
      const material = PREFIX + 'material';
      const r = await db.from('recepcion_alimento').insert({ id: rec, fecha: new Date().toISOString(), material, kg: 10,
                                                             registrado_por: 'check-backend' });
      if (r.error) bad('alimento: recepción', r.error.message, 'Ejecuta 0008_alimento.sql.');
      else { created.recepcion_alimento.push(rec); ok('alimento: recepción'); }

      const e = await db.rpc('crear_ensilaje', {
        p_ensilaje: { id: ens, codigo: PREFIX + 'ENS' + Date.now(), fecha_armado: new Date().toISOString(), kg_inicial: 10,
                      registrado_por: 'check-backend' },
        p_insumos: [{ id: ins, material, kg: 10, recepcion_id: r.error ? null : rec }]
      });
      if (e.error) bad('alimento: ensilaje con sus materiales', e.error.message);
      else {
        created.ensilaje.push(ens); created.ensilaje_insumo.push(ins);
        const s1 = await db.rpc('avanzar_ensilaje', { p_id: ens, p_paso: 'sellado', p_at: null, p_por: 'check-backend' });
        const s2 = await db.rpc('avanzar_ensilaje', { p_id: ens, p_paso: 'en_uso', p_at: null, p_por: 'check-backend' });
        const l = await db.from('ensilaje_lectura').insert({ id: lec, ensilaje_id: ens, fecha: new Date().toISOString(),
                                                             temperatura_c: 30, registrado_por: 'check-backend' });
        if (!l.error) created.ensilaje_lectura.push(lec);
        const est = await db.from('ensilaje').select('estado, listo_at, sellado_por').eq('id', ens).single();
        if (s1.error || s2.error || l.error) bad('alimento: pasos del ensilaje', (s1.error || s2.error || l.error).message);
        else if (est.data?.estado === 'en_uso' && est.data.listo_at && est.data.sellado_por === 'check-backend') {
          ok('alimento: pasos del ensilaje', 'sellado → en uso (y listo), con quién, y una lectura de temperatura');
        } else bad('alimento: pasos del ensilaje', `estado ${est.data?.estado}`);

        if (v2Tray) {
          const f2 = uuid();
          const g = await db.rpc('log_alimentacion_grupal', { p_rows: [{
            id: f2, bandeja_id: v2Tray, fecha: new Date().toISOString(), tipo_alimento: 'Ensilaje', cantidad_kg: 2,
            carga: 2, ensilaje_id: ens, grupal_id: uuid(), registrado_por: 'check-backend' }] });
          if (g.error) bad('alimento: la carga descuenta del ensilaje', g.error.message);
          else {
            created.alimentacion.push(f2);
            const v = await db.from('v_stock_ensilaje').select('consumido_kg, disponible_kg').eq('id', ens).single();
            if (Number(v.data?.consumido_kg) === 2 && Number(v.data?.disponible_kg) === 8) {
              ok('alimento: la carga descuenta del ensilaje', 'v_stock_ensilaje: 2 kg consumidos, quedan 8');
            } else bad('alimento: la carga descuenta del ensilaje', JSON.stringify(v.data || v.error));
          }
        }
      }
    }
  }

  /* 12 ── lo que toca hoy (0009) ─────────────────────────────────────────── */
  {
    const probe = await db.from('v_temperatura_cama').select('id').limit(0);
    if (probe.error) {
      console.log('  --    temperatura de cama (0009): todavía no aplicado; se revisa cuando corras 0009_monitor.sql');
    } else if (!v2Tray) {
      bad('temperatura de cama', 'no hay bandeja v2 de prueba (falló la distribución más arriba)');
    } else {
      const rev = uuid();
      const r = await db.from('revision').insert({ id: rev, bandeja_id: v2Tray, fecha: new Date().toISOString(),
                                                   temperatura_c: 37.5, notas: 'Temperatura de cama',
                                                   registrado_por: 'check-backend' });
      if (r.error) bad('temperatura de cama', r.error.message, 'Ejecuta 0009_monitor.sql.');
      else {
        created.revision.push(rev);
        const v = await db.from('v_temperatura_cama').select('temperatura_c, sobre_maximo').eq('id', rev).single();
        if (v.data && Number(v.data.temperatura_c) === 37.5 && v.data.sobre_maximo === true) {
          ok('temperatura de cama', '37,5 °C marcada sobre el máximo');
        } else bad('temperatura de cama', JSON.stringify(v.data || v.error));
      }
    }
  }

  /* 13 ── clean up ───────────────────────────────────────────────────────── */
  {
    // Children first. Soft delete: see the note at the top of this file.
    const order = ['lote', 'separacion', 'ayuno', 'revision', 'alimentacion', 'bandeja', 'incubadora', 'recoleccion', 'insectario',
                   'ensilaje_lectura', 'ensilaje_insumo', 'ensilaje', 'recepcion_alimento'];
    const now = new Date().toISOString();
    let left = 0;
    for (const table of order) {
      const ids = created[table];
      if (!ids?.length) continue;
      const { error } = await db.from(table).update({ deleted_at: now }).in('id', ids);
      if (error) { left += ids.length; console.log(`        no se pudo limpiar ${table}: ${error.message}`); }
    }
    if (!left) ok('limpieza', 'filas de prueba marcadas como borradas; los teléfonos las quitan al sincronizar');
    else bad('limpieza', `${left} filas de prueba quedaron`,
             `Márcalas como borradas a mano: las de prueba tienen código que empieza con ${PREFIX}`);
  }
}

main()
  .catch(e => { fail++; console.log(`\n  FAIL  error inesperado: ${e.message}`); })
  .finally(() => {
    console.log(`\n${pass} ok, ${fail} con problemas.`);
    if (fail) {
      console.log('\nLa base NO está lista. Arregla lo de arriba antes de usar la app.');
      process.exitCode = 1;
    } else {
      console.log('\nLa base está lista: escritura, claves foráneas, triggers, restricciones,');
      console.log('vistas y almacenamiento de fotos funcionan.');
    }
  });
