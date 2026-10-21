/**
 * check-backend.mjs — prove the database actually works, end to end.
 *
 *   npm run check:backend
 *
 * Everything else in this repo can be verified without a database. This cannot:
 * whether the schema applied, whether it is exposed, whether grants are right,
 * whether the triggers fire, whether the constraints hold. Those only fail
 * once, in production, on the first day — which is exactly when you least want
 * to be debugging them.
 *
 * So this runs a whole cycle through the same SQL the app uses — a cage, a
 * recolecta, its chequeo and distribución, a separación and its 98/2, a
 * correction, a cochada, the cage closed, cleaned and repopulated, food
 * ensiled and opened, an early close, a photo — checks what the database
 * computed, and then MARKS EVERYTHING IT CREATED as deleted (deleted_at),
 * never with a hard DELETE: phones pull changes by updated_at, and a hard
 * DELETE is invisible to that (tools/qa.mjs).
 *
 * Everything is registered as "check-backend", and codes start with ZZTEST-.
 *
 * The test suite runs `verificar` against a local Postgres too, so this tool is
 * proven before anyone runs it against production.
 */
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { loadConfig, marcarQa } from './qa.mjs';

const PREFIX = 'ZZTEST-';
const POR = 'check-backend';
const uuid = () => crypto.randomUUID();

/** Decode a JWT payload without verifying it — just to spot a service_role key. */
function safeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch { return ''; }
}

/** The configuration mistakes people actually make, caught before any request. */
export function revisarConfig(cfg) {
  if (!cfg.supabaseUrl) return ['Falta supabaseUrl en app-config.js.', 'Supabase → Settings → API → "Project URL".'];
  // supabase-js appends /rest/v1 itself; pasting the REST endpoint gives a 404
  // that looks like the schema is missing.
  if (/\/rest\/v1/.test(cfg.supabaseUrl)) {
    return [`supabaseUrl es el endpoint REST: ${cfg.supabaseUrl}`, `Quita "/rest/v1/". Debe quedar: ${cfg.supabaseUrl.split('/rest/')[0]}`];
  }
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.(co|in)\/?$/i.test(cfg.supabaseUrl)) {
    return [`supabaseUrl no tiene la forma esperada: ${cfg.supabaseUrl}`, 'Debe ser https://xxxxxxxx.supabase.co (sin nada después).'];
  }
  if (!cfg.supabaseAnonKey) return ['Falta supabaseAnonKey en app-config.js.', 'Supabase → Settings → API Keys → la clave "anon" / "public".'];
  // A service_role key here would be published to every visitor of the site.
  if (/service_role/.test(cfg.supabaseAnonKey) || /"role"\s*:\s*"service_role"/.test(safeJwtPayload(cfg.supabaseAnonKey))) {
    return ['Esa es la clave service_role, no la anon.', 'La service_role ignora todas las políticas y quedaría pública en el sitio. Usa la "anon"/"public".'];
  }
  return null;
}

/**
 * The cycle, against `db` (supabase-js or the test double). `t` reports:
 * t.ok(label, extra), t.bad(label, why, fix).
 */
export async function verificar(db, t, { bucket = 'fotos', fotos = true } = {}) {
  const fila = async (tabla, id, cols = '*') => {
    const { data, error } = await db.from(tabla).select(cols).eq('id', id);
    if (error) throw new Error(`${tabla}: ${error.message}`);
    return data?.[0] || null;
  };
  const insertar = async (tabla, row) => {
    const { error } = await db.from(tabla).insert({ registrado_por: POR, ...row });
    if (error) throw Object.assign(new Error(`${tabla}: ${error.message}`), { code: error.code });
    return row.id;
  };
  const llamar = async (fn, args) => {
    const { error } = await db.rpc(fn, args);
    if (error) throw Object.assign(new Error(`${fn}: ${error.message}`), { code: error.code });
  };
  /** One check: run it, report it, never let it stop the others. */
  const paso = async (label, fn, fix) => {
    try {
      const extra = await fn();
      t.ok(label, typeof extra === 'string' ? extra : '');
      return true;
    } catch (e) {
      t.bad(label, e.message, fix);
      return false;
    }
  };
  const igual = (a, b, que) => { if (String(a) !== String(b)) throw new Error(`${que}: ${a} (se esperaba ${b})`); };
  const rechaza = async (fn, code, que) => {
    try { await fn(); } catch (e) {
      if (e.code === code) return;
      throw new Error(`${que}: rechazado con ${e.code} en vez de ${code} (${e.message})`);
    }
    throw new Error(`${que}: no se rechazó`);
  };

  /* 1 ── can we reach the schema at all? */
  const alcanza = await paso('esquema accesible', async () => {
    const { data, error } = await db.from('catalogo').select('tipo, valor');
    if (error) throw new Error(error.message);
    const tipos = new Set(data.map(r => r.tipo));
    if (!tipos.has('operario') || !tipos.has('material_alimento')) throw new Error('faltan las listas de 0010');
    return `${data.length} valores en las listas`;
  }, 'Supabase → Settings → API → "Exposed schemas": agrega "app". Y que 0010_ciclo_nuevo.sql haya corrido completo.');
  if (!alcanza) return;

  await paso('ajustes del protocolo', async () => {
    const { data, error } = await db.from('parametro').select('clave, valor');
    if (error) throw new Error(error.message);
    const p = Object.fromEntries(data.map(r => [r.clave, r.valor]));
    igual(p.pct_coccion, 98, 'pct_coccion');
    return `${data.length} ajustes · alimento inicial usual: ${p.alimento_inicial_incubadora_kg ?? 'POR DEFINIR'}`;
  }, 'Ejecuta 0010_ciclo_nuevo.sql.');

  const S = {};
  const sello = Date.now().toString(36).toUpperCase();

  /* 2 ── objects registered once */
  const base = await paso('rack, contenedor y jaula', async () => {
    S.rack = await insertar('rack', { id: uuid(), codigo: PREFIX + 'R' + sello });
    S.cont = await insertar('contenedor', { id: uuid(), codigo: PREFIX + 'S' + sello });
    for (let i = 0; i < 4 && !S.jaula; i++) {
      const letra = 'Z' + String(Math.floor(Math.random() * 100)).padStart(2, '0');
      try {
        S.jaula = await insertar('jaula', { id: uuid(), nombre: PREFIX + sello, letra, lugar: 'prueba',
                                            generacion_inicial: 7, fase_inicial: 'activa' });
      } catch (e) { if (e.code !== '23505') throw e; }
    }
    const j = await fila('jaula', S.jaula, 'fase, generacion, estado');
    igual(`${j.fase}/${j.generacion}/${j.estado}`, 'activa/7/activo', 'jaula registrada con moscas, F7');
    return 'la jaula toma su fase y generación al registrarse';
  }, 'Si dice "permission denied": faltan los grants o las políticas (0010, sección 10).');
  if (!base) { await limpiar(db, t); return; }

  /* 3 ── the larvae cycle */
  await paso('recolecta → incubadora (día 0 en hora de la granja)', async () => {
    S.inc = await insertar('incubadora', { id: uuid(), codigo: PREFIX + 'F7-' + sello, jaula_id: S.jaula, generacion: 7,
      numero: 1, recolecta_at: new Date().toISOString(), rack_id: S.rack, peso_inicial_g: 12.5, alimento_inicial_kg: 2 });
    const i = await fila('incubadora', S.inc, 'dia0, estado');
    if (!i.dia0) throw new Error('el trigger no puso el día 0');
    igual(i.estado, 'activo', 'estado');
    return `día 0 ${i.dia0}`;
  });

  await paso('chequeo del día 3 (gramos, y kilos rechazados)', async () => {
    await insertar('chequeo', { id: uuid(), incubadora_id: S.inc, dia: 3, fecha: new Date().toISOString(),
                                humedad_pct: 68, temperatura_c: 29.5, peso_g: 40 });
    await rechaza(() => insertar('chequeo', { id: uuid(), incubadora_id: S.inc, dia: 4, fecha: new Date().toISOString(),
                                              humedad_pct: 68, temperatura_c: 29.5, peso_kg: 0.04 }), '23514', 'chequeo en kg');
  });

  await paso('distribución: caja y carga 1 juntas, una sola vez', async () => {
    const dist = { id: uuid(), incubadora_id: S.inc, fecha: new Date().toISOString(), peso_total_kg: 1.8, registrado_por: POR };
    S.caja = uuid();
    const cajas = [{ id: S.caja, codigo: PREFIX + 'F7-' + sello + '-01', numero: 1, rack_id: S.rack, peso_inicial_kg: 0.9 }];
    const cargas = [{ id: uuid(), caja_id: S.caja, carga: 1, fecha: dist.fecha, kg: 1.5, kg_plan: 1.5, dia_plan: 7 }];
    await llamar('distribuir', { p_distribucion: dist, p_cajas: cajas, p_cargas: cargas });
    await llamar('distribuir', { p_distribucion: dist, p_cajas: cajas, p_cargas: cargas });
    igual((await fila('incubadora', S.inc, 'estado')).estado, 'inactivo', 'incubadora distribuida');
    const c = await fila('caja', S.caja, 'estado, registrado_por');
    igual(`${c.estado}/${c.registrado_por}`, `activo/${POR}`, 'caja');
    await rechaza(() => llamar('distribuir', { p_distribucion: { ...dist, id: uuid() },
      p_cajas: [{ ...cajas[0], id: uuid(), codigo: PREFIX + 'X' + sello }], p_cargas: [] }), '23505', 'segunda distribución');
    return 'repetirla no duplica; otra distinta se rechaza';
  }, 'Revisa que la función app.distribuir exista (0010).');

  await paso('separación: 98 % al horno y 2 % de vuelta', async () => {
    S.sep = await insertar('separacion', { id: uuid(), caja_id: S.caja, fecha: new Date().toISOString(), peso_total_kg: 10 });
    const s = await fila('separacion', S.sep, 'coccion_kg, retorno_kg');
    igual(`${Number(s.coccion_kg)}/${Number(s.retorno_kg)}`, '9.8/0.2', 'reparto');
    igual((await fila('caja', S.caja, 'estado')).estado, 'inactivo', 'caja separada');
  });

  await paso('corrección: el reparto se recalcula; el código no se corrige', async () => {
    await llamar('editar', { p_tabla: 'separacion', p_id: S.sep, p_cambios: { peso_total_kg: 12 }, p_por: POR, p_at: new Date().toISOString() });
    const s = await fila('separacion', S.sep, 'coccion_kg, valores_editados_at, editado_por');
    igual(`${Number(s.coccion_kg)}/${s.editado_por}`, `11.76/${POR}`, 'corregida');
    if (!s.valores_editados_at) throw new Error('no quedó marcada la corrección de valores');
    await rechaza(() => llamar('editar', { p_tabla: 'incubadora', p_id: S.inc, p_cambios: { codigo: 'X' }, p_por: POR, p_at: null }),
                  '22023', 'corregir un código');
    await llamar('marcar_revisado', { p_tabla: 'separacion', p_id: S.sep, p_at: null, p_por: POR });
    if (!(await fila('separacion', S.sep, 'revisado_at')).revisado_at) throw new Error('revisado no quedó');
  });

  await paso('cochada: al horno, mitad y final', async () => {
    S.co = uuid();
    await llamar('crear_cochada', { p_cochada: { id: S.co, codigo: PREFIX + 'H' + sello, horno_at: new Date().toISOString(),
      peso_inicial_kg: 11.76, registrado_por: POR }, p_origenes: [{ id: uuid(), separacion_id: S.sep, kg: 11.76 }] });
    await insertar('cochada_lectura', { id: uuid(), cochada_id: S.co, momento: 'media', fecha: new Date().toISOString(), temperatura_c: 92 });
    igual((await fila('cochada', S.co, 'estado')).estado, 'activo', 'en el horno');
    await insertar('cochada_lectura', { id: uuid(), cochada_id: S.co, momento: 'final', fecha: new Date().toISOString(),
                                        temperatura_c: 105, peso_kg: 3.1 });
    igual((await fila('cochada', S.co, 'estado')).estado, 'inactivo', 'lista para empacar');
  });

  /* 4 ── the insectario */
  await paso('jaula: cierre, limpieza y repoblado con el 2 %', async () => {
    const ing = { id: uuid(), jaula_id: S.jaula, fecha: null, kg_larvas: 0.24, generacion: 8, registrado_por: POR };
    const bandejas = [{ id: uuid(), codigo: PREFIX + 'B' + sello, numero: 1, rack_id: S.rack, peso_kg: 4.7 }];
    await rechaza(() => llamar('ingresar', { p_ingreso: { ...ing, fecha: new Date().toISOString() }, p_bandejas: bandejas }),
                  '23514', 'repoblar una jaula con moscas');
    const ahora = Date.now();
    await insertar('jaula_evento', { id: uuid(), jaula_id: S.jaula, tipo: 'cierre', fecha: new Date(ahora).toISOString() });
    await insertar('jaula_evento', { id: uuid(), jaula_id: S.jaula, tipo: 'limpieza', fecha: new Date(ahora + 1000).toISOString() });
    igual((await fila('jaula', S.jaula, 'fase')).fase, 'limpia', 'jaula limpia');
    await llamar('ingresar', { p_ingreso: { ...ing, fecha: new Date(ahora + 2000).toISOString() }, p_bandejas: bandejas });
    const j = await fila('jaula', S.jaula, 'fase, generacion, ciclo_desde');
    igual(`${j.fase}/${j.generacion}`, 'activa/8', 'jaula repoblada');
    return `F8 desde ${j.ciclo_desde}`;
  }, 'Revisa que la función app.ingresar exista (0010).');

  /* 5 ── food */
  await paso('alimento: recepción, ensilado y apertura', async () => {
    S.rec = await insertar('recepcion', { id: uuid(), fecha: new Date().toISOString(), material: 'Otro', kg: 10 });
    S.ens = uuid();
    await llamar('crear_ensilado', { p_ensilado: { id: S.ens, codigo: PREFIX + 'E' + sello, contenedor_id: S.cont,
      ensilado_at: new Date().toISOString(), registrado_por: POR }, p_insumos: [{ id: uuid(), recepcion_id: S.rec, kg: 10 }] });
    if (!(await fila('ensilado', S.ens, 'dia0')).dia0) throw new Error('sin día 0');
    const at = new Date().toISOString();
    await llamar('abrir_ensilado', { p_id: S.ens, p_at: at, p_por: POR });
    await llamar('abrir_ensilado', { p_id: S.ens, p_at: new Date(Date.now() + 86400000).toISOString(), p_por: 'otro' });
    const e = await fila('ensilado', S.ens, 'abierto_at, abierto_por');
    igual(`${new Date(e.abierto_at).toISOString()}/${e.abierto_por}`, `${at}/${POR}`, 'la primera apertura queda');
  });

  /* 6 ── moves and early closing */
  await paso('cambio de rack y cierre antes de tiempo', async () => {
    await insertar('movimiento', { id: uuid(), objeto: 'caja', objeto_id: S.caja, rack_desde: S.rack, rack_hasta: S.rack,
                                   fecha: new Date().toISOString() });
    S.inc2 = await insertar('incubadora', { id: uuid(), codigo: PREFIX + 'F7-' + sello + 'B', jaula_id: S.jaula, generacion: 8,
      numero: 2, recolecta_at: new Date().toISOString(), rack_id: S.rack, peso_inicial_g: 10, alimento_inicial_kg: 2 });
    await llamar('cerrar_objeto', { p_tabla: 'incubadora', p_id: S.inc2, p_motivo: 'prueba', p_at: null, p_por: POR });
    const i = await fila('incubadora', S.inc2, 'estado, motivo_cierre');
    igual(`${i.estado}/${i.motivo_cierre}`, 'inactivo/prueba', 'cerrada');
  });

  /* 7 ── photo storage */
  if (fotos) {
    await paso('almacenamiento de fotos', async () => {
      const b = db.storage.from(bucket);
      // Must be a real image: the bucket only takes jpeg/png/webp, and in Node a
      // Blob without an explicit type arrives as application/octet-stream.
      const PNG_1PX = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
      const key = `${PREFIX}check/${uuid()}.png`;
      const { error } = await b.upload(key, new Blob([PNG_1PX], { type: 'image/png' }), { contentType: 'image/png', upsert: true });
      if (error) throw new Error(error.message);
      await b.remove([key]);
      return 'subida y borrado';
    }, 'El bucket "fotos" y su política los crea 0010 (sección 12).');
  }

  await limpiar(db, t);
}

async function limpiar(db, t) {
  const quedan = await marcarQa(db, [POR]);
  if (!quedan) t.ok('limpieza', 'filas de prueba marcadas como borradas; los teléfonos las quitan al sincronizar');
  else t.bad('limpieza', `${quedan} filas de prueba quedaron`, 'Corre: node tools/cleanup-qa.mjs --delete');
}

/* ── command line ────────────────────────────────────────────────────────── */

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pass = 0, fail = 0;
  const t = {
    ok(label, extra = '') { pass++; console.log(`  ok    ${label}${extra ? '   ' + extra : ''}`); },
    bad(label, why, fix) {
      fail++;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${why}`);
      if (fix) console.log(`        → ${fix}`);
    }
  };
  console.log('Verificando el backend...\n');
  const cfg = await loadConfig();
  const problema = revisarConfig(cfg);
  if (problema) t.bad('configuración', problema[0], problema[1]);
  else {
    t.ok('configuración', cfg.supabaseUrl);
    const db = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      db: { schema: cfg.dbSchema || 'app' },
      auth: { persistSession: false, autoRefreshToken: false }
    });
    await verificar(db, t, { bucket: cfg.storageBucket || 'fotos' })
      .catch(e => t.bad('error inesperado', e.message));
  }
  console.log(`\n${pass} ok, ${fail} con problemas.`);
  if (fail) {
    console.log('\nLa base NO está lista. Arregla lo de arriba antes de usar la app.');
    process.exitCode = 1;
  } else {
    console.log('\nLa base está lista: escritura, llamadas, triggers, restricciones y fotos funcionan.');
  }
}
