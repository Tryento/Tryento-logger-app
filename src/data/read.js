/**
 * read.js — every read the UI performs, served from IndexedDB.
 *
 * Every screen starts from the same picture of the lab (vista.js, through
 * snapshot.js), so a list, a detail page and "para hoy" can never disagree
 * about what state something is in. Each function shapes that picture for one
 * screen: plain data, Spanish words, numbers with a decimal comma.
 *
 * Every record shown on a detail page comes as a `registro` — what it is, its
 * numbers, when and who, whether it was corrected, its note and photo, and why
 * it needs a second look — so one component can show, correct, annotate and
 * review any of them.
 *
 * Everything is local, so these resolve in milliseconds with no network.
 */
import { ok, fail, CODES, str } from './envelope.js';
import { openDb } from './idb/open.js';
import { metaGet } from './idb/tx.js';
import { allRows, rowById, rowsByIndex } from './store.js';
import { vistaActual, protocolo } from './snapshot.js';
import { motivosRevisar } from './vista.js';
import { paraHoy, horaLocal } from './monitor.js';
import { pasoLabel, cuandoLabel, cargaDistribucion, cargaDef, kg3 } from './protocolo.js';
import { pool2 } from './pool.js';
import { siguienteIncubadora, cajaCodigo, siguientesBandejas, siguienteCochada, ensiladoCodigo } from './ids.js';
import { EDITABLE, camposDe } from './registros.js';
import { kgTxt, diaTxt, fechaHoraTxt, cuandoTxt } from './formato.js';
import { farmDay, toNaiveLocal } from './time.js';
import { generacionDeJaula } from './revisar.js';
import { resumenLab } from './resumen.js';
import { avisoBorrado } from './borrado.js';

export async function getProtocolo() {
  return ok(await protocolo(await openDb()));
}

/* ── shaping helpers ──────────────────────────────────────────────────────── */

const FASE_TXT = { activa: 'Con moscas', cerrada: 'Cerrado', limpia: 'Limpio' };
const ENSILADO_TXT = { madurando: 'Madurando', abierto: 'Abierto', vencido: 'Vencido' };
/** Past its 72 h: "Consumido" only if nothing was left to discard. */
const ensiladoTxt = e => (e.estado === 'vencido' && !(e.kg_descartado > 0) ? 'Consumido' : ENSILADO_TXT[e.estado]);

/** A step for a screen. One due before its record was entered (a recolecta
 *  registered late) is pending, not late: nobody missed it, and "para hoy"
 *  does not chase it either. */
const paso = p => {
  if (!p) return null;
  const pendiente = p.previo && p.estado === 'atrasado';
  return { ...p, ...(pendiente ? { estado: 'pendiente' } : {}), label: pasoLabel(p),
           cuando: pendiente ? 'pendiente' : cuandoLabel(p) };
};
const primerPaso = pasos => paso((pasos || []).find(p => !p.bloqueado) || null);

/** In open mode, what was never recorded can still be entered late: scheduled
 *  chequeos and cargas missing from an object and not among its steps. */
function atrasables(cfg, dias, hechos, pasos, tipo) {
  if (cfg.reglas_estrictas) return [];
  return dias.filter(d => !hechos.includes(d) && !pasos.some(p => p.paso === tipo && (p.carga ?? p.dia) === d));
}

/** Where an object's food came from, in words. */
function origenAlimento(v, id) {
  const c = v.alimento.consumos.get(id);
  if (!c) return '';
  const partes = c.partes.map(p => `${kgTxt(p.kg)} kg de ${p.codigo}`);
  if (c.sin_ensilado_kg > 0) partes.push(`${kgTxt(c.sin_ensilado_kg)} kg sin ensilado`);
  return partes.join(' · ');
}

const sinEnsilado = (v, id) => (v.alimento.consumos.get(id)?.sin_ensilado_kg || 0) > 0;

/**
 * One record, ready for a list: what it is and its numbers, when and who,
 * whether it was corrected, its note and photo, why it needs a second look.
 */
function registro(v, tabla, r, titulo, detalle, { fecha } = {}) {
  const momento = fecha || r.fecha || r.created_at;
  return {
    tabla, id: r.id, titulo, detalle: detalle || '',
    fecha: momento,
    cuando: cuandoTxt(momento, v.hoy),
    por: r.registrado_por || '',
    corregido: r.editado_at ? `Corregido por ${r.editado_por || '—'} · ${cuandoTxt(r.editado_at, v.hoy)}` : '',
    nota: r.nota || '',
    foto_key: r.foto_key || null,
    revisar: motivosRevisar(v, tabla, r.id),
    editable: Boolean(EDITABLE[tabla]),
    revisable: tabla !== 'contenedor'
  };
}

const porFechaDesc = (a, b) => String(b.fecha).localeCompare(String(a.fecha));

const chequeoTxt = c =>
  `${kgTxt(c.humedad_pct)} % · ${kgTxt(c.temperatura_c)} °C · ${c.peso_g != null ? `${kgTxt(c.peso_g)} g` : `${kgTxt(c.peso_kg)} kg`}`;

const cierreTxt = o => o.cerrado_at
  ? `Cerrada antes de tiempo: ${o.motivo_cierre || '—'} (${o.cerrado_por || '—'}, ${cuandoTxt(o.cerrado_at)})` : '';

/* ── home ─────────────────────────────────────────────────────────────────── */

export async function getInicio() {
  const v = await vistaActual(await openDb());
  const hoy = paraHoy(v);
  return ok({
    paraHoy: hoy,
    conteos: {
      jaulas: v.jaulas.filter(j => j.fase === 'activa').length,
      incubadoras: v.incubadoras.filter(i => i.estado === 'activo').length,
      cajas: v.cajas.filter(c => c.estado === 'activo').length,
      cochadas: v.cochadas.filter(c => c.estado === 'activo').length,
      ensilados: v.ensilados.filter(e => e.estado === 'abierto').length,
      revisar: v.revisar.size
    },
    pool_kg: v.pool.kg_pendiente,
    horno_kg: kg3(v.horno.reduce((s, h) => s + h.kg_pendiente, 0)),
    vacio: !v.jaulas.length || !v.contenedores.length
  });
}

/* ── the lab in numbers ───────────────────────────────────────────────────── */

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
const diasTxt = r => (!r ? '' : r.min === r.max ? `Día ${r.min}` : `Días ${r.min}–${r.max}`);
const medidaTxt = (m, u) => (!m ? null : m.min === m.max ? `${kgTxt(m.prom)} ${u}`
  : `${kgTxt(m.prom)} ${u} (${kgTxt(m.min)}–${kgTxt(m.max)})`);
const PERIODO_TXT = { 7: 'Últimos 7 días', 30: 'Últimos 30 días' };

/**
 * The Resumen tab: what there is now (each tile opens the tab it lives on),
 * the last eight weeks, and how the chosen period went.
 */
export async function getResumen({ periodo = '30' } = {}) {
  const v = await vistaActual(await openDb());
  const { ahora: a, semanas, periodo: p } = resumenLab(v, { periodo });

  const jaulasSub = a.jaulas.total
    ? [a.jaulas.generaciones.map(g => (g.n > 1 ? `F${g.generacion} ×${g.n}` : `F${g.generacion}`)).join(' · '),
       a.jaulas.cerradas ? plural(a.jaulas.cerradas, 'cerrado', 'cerrados') : null,
       a.jaulas.limpias ? plural(a.jaulas.limpias, 'limpio', 'limpios') : null].filter(Boolean).join(' · ')
    : 'Ninguno registrado';
  const ens = a.ensilado;
  const ahora = [
    { valor: String(a.jaulas.con_moscas), label: a.jaulas.con_moscas === 1 ? 'insectario con moscas' : 'insectarios con moscas',
      sub: jaulasSub, ir: 'lab', filtro: 'insectarios' },
    { valor: String(a.incubadoras.activas), label: a.incubadoras.activas === 1 ? 'incubadora activa' : 'incubadoras activas',
      sub: diasTxt(a.incubadoras.dias), ir: 'lab', filtro: 'bandejas' },
    { valor: String(a.cajas.activas), label: a.cajas.activas === 1 ? 'caja de engorde' : 'cajas de engorde',
      sub: [a.cajas.en_ayuno ? `${a.cajas.en_ayuno} en ayuno` : null, diasTxt(a.cajas.dias)].filter(Boolean).join(' · '), ir: 'lab', filtro: 'bandejas' },
    { valor: String(a.cochadas_en_horno), label: a.cochadas_en_horno === 1 ? 'cochada en el horno' : 'cochadas en el horno',
      sub: '', ir: 'horno' },
    { valor: `${kgTxt(a.horno_kg)} kg`, label: '98 % esperando el horno', sub: '', ir: 'horno' },
    { valor: `${kgTxt(a.pool_kg)} kg`, label: '2 % esperando para repoblar', sub: '', ir: 'lab', filtro: 'insectarios' },
    ens.abiertos
      ? { valor: `${kgTxt(ens.kg_restante)} kg`, label: ens.abiertos === 1 ? 'en el ensilado abierto' : `en ${ens.abiertos} ensilados abiertos`,
          sub: `Vence ${horaLocal(ens.vence_at)}`, ir: 'alimento' }
      : { valor: '0 kg', label: 'ningún ensilado abierto',
          sub: ens.madurando ? `Próxima apertura ${diaTxt(ens.proxima_apertura)}` : 'Ninguno madurando', ir: 'alimento' },
    { valor: `${kgTxt(a.bodega_kg)} kg`, label: 'material sin ensilar', sub: '', ir: 'alimento' }
  ];
  const alerta = a.atrasados || a.revisar
    ? { tono: 'mal', ir: a.atrasados ? 'home' : 'revisar',
        texto: [a.atrasados ? plural(a.atrasados, 'paso atrasado', 'pasos atrasados') : null,
                a.revisar ? plural(a.revisar, 'registro para revisar', 'registros para revisar') : null].filter(Boolean).join(' · ') }
    : { tono: 'bien', ir: null, texto: 'Nada atrasado ni por revisar.' };

  /* the period, section by section */
  const L = p.larvas;
  const cerradasL = [L.cerradas.incubadoras ? plural(L.cerradas.incubadoras, 'cerrada en la incubadora', 'cerradas en la incubadora') : null,
                     L.cerradas.cajas ? plural(L.cerradas.cajas, 'caja cerrada antes de tiempo', 'cajas cerradas antes de tiempo') : null]
    .filter(Boolean).join(' · ');
  const S = p.separaciones, C = p.chequeos, X = p.cierres;
  const larvas = {
    titulo: 'CICLO DE LAS LARVAS',
    nota: L.n
      ? `${plural(L.n, 'incubadora terminó su ciclo', 'incubadoras terminaron su ciclo')} en este periodo${cerradasL ? ` (${cerradasL})` : ''}.`
      : 'Ninguna incubadora terminó su ciclo en este periodo.',
    tiles: L.n ? [
      { valor: `${kgTxt(L.kg_separado)} kg`, label: 'separados', sub: `De ${plural(L.n, 'incubadora', 'incubadoras')}` },
      { valor: L.kg_por_g === null ? '—' : `${kgTxt(L.kg_por_g)} kg`, label: 'por g recolectado',
        sub: `${kgTxt(L.kg_separado)} kg de ${kgTxt(L.g_inicial)} g` },
      { valor: L.multiplicacion === null ? '—' : `×${kgTxt(L.multiplicacion)}`, label: 'de la distribución a la separación',
        sub: `${kgTxt(L.kg_tamizado)} → ${kgTxt(L.kg_separado)} kg` },
      { valor: L.fcr === null ? '—' : kgTxt(L.fcr), label: 'kg de alimento por kg separado',
        sub: `FCR en base húmeda · ${kgTxt(L.kg_alimento)} kg dados` },
      { valor: L.dia_distribucion === null ? '—' : `Día ${kgTxt(L.dia_distribucion)}`, label: 'distribución, en promedio',
        sub: `Plan: día ${L.plan.distribucion}` },
      { valor: L.dia_separacion === null ? '—' : `Día ${kgTxt(L.dia_separacion)}`, label: 'separación, en promedio',
        sub: `Plan: día ${L.plan.separacion}` }
    ] : [],
    lineas: [
      S.n ? `Separaciones: ${plural(S.n, 'caja', 'cajas')} · ${kgTxt(S.kg)} kg → ${kgTxt(S.coccion_kg)} kg al horno y ${kgTxt(S.retorno_kg)} kg al insectario`
          : 'Ninguna separación en este periodo.',
      C.n ? ['Chequeos: ' + C.n, medidaTxt(C.humedad, '% de humedad'), medidaTxt(C.temperatura, '°C')].filter(Boolean).join(' · ')
          : 'Ningún chequeo en este periodo.',
      X.n ? 'Cerrados antes de tiempo: ' + [X.incubadoras ? plural(X.incubadoras, 'incubadora', 'incubadoras') : null,
                                            X.cajas ? plural(X.cajas, 'caja', 'cajas') : null,
                                            X.cochadas ? plural(X.cochadas, 'cochada', 'cochadas') : null,
                                            X.bandejas ? plural(X.bandejas, 'bandeja de pupación', 'bandejas de pupación') : null].filter(Boolean).join(', ')
          : null
    ].filter(Boolean)
  };

  const Rc = p.recolectas, CJ = p.ciclos_jaula, RP = p.repoblados;
  const insectario = {
    titulo: 'INSECTARIO',
    nota: Rc.n ? '' : 'Ninguna recolecta en este periodo.',
    barrasTitulo: 'Recolectado por insectario',
    barras: Rc.por_jaula.map(j => ({ nombre: j.nombre, g: j.g,
                                     texto: `${kgTxt(j.g)} g · ${plural(j.recolectas, 'recolecta', 'recolectas')}` })),
    lineas: [
      Rc.n ? `Recolectas: ${Rc.n} · ${kgTxt(Rc.g)} g · ${kgTxt(Rc.g_prom)} g por recolecta` : null,
      CJ.n ? `${plural(CJ.n, 'ciclo de insectario cerrado', 'ciclos de insectario cerrados')}: ${kgTxt(CJ.dias_prom)} días, ` +
             `${kgTxt(CJ.recolectas_prom)} recolectas y ${kgTxt(CJ.g_prom)} g por ciclo, en promedio`
           : 'Ningún ciclo de insectario se cerró en este periodo.',
      RP.n ? `${plural(RP.n, 'repoblado', 'repoblados')}: ${kgTxt(RP.kg_larvas)} kg de larvas en ${plural(RP.bandejas, 'bandeja de pupación', 'bandejas de pupación')}`
           : 'Ningún repoblado en este periodo.'
    ].filter(Boolean)
  };

  const H = p.horno, T = H.terminadas;
  const rangoH = T.rango_pct && T.rango_pct.min !== T.rango_pct.max ? `Entre ${T.rango_pct.min} y ${T.rango_pct.max} %` : null;
  const horno = {
    titulo: 'HORNO',
    nota: '',
    tiles: [
      { valor: String(T.n), label: T.n === 1 ? 'cochada terminada' : 'cochadas terminadas',
        sub: T.n ? `${kgTxt(T.kg_entrada)} kg → ${kgTxt(T.kg_salida)} kg` : '' },
      { valor: T.rendimiento_pct === null ? '—' : `${T.rendimiento_pct} %`, label: 'rendimiento del horno',
        sub: [rangoH, 'Peso final ÷ peso inicial'].filter(Boolean).join(' · ') }
    ],
    lineas: [
      H.al_horno.n ? `Al horno: ${plural(H.al_horno.n, 'cochada', 'cochadas')} · ${kgTxt(H.al_horno.kg)} kg`
                   : 'Ninguna cochada entró al horno en este periodo.',
      T.n ? `Temperatura promedio: ${T.temp_media === null ? '—' : `${kgTxt(T.temp_media)} °C`} a mitad · ${kgTxt(T.temp_final)} °C al final` : null
    ].filter(Boolean)
  };

  const A = p.alimento, ET = A.ensilados_terminados, horas = v.cfg.horas_consumo;
  const alimento = {
    titulo: 'ALIMENTO',
    nota: ET.kg > 0 ? '' : `Ningún ensilado terminó sus ${horas} h en este periodo.`,
    medidor: ET.kg > 0 ? {
      pct: ET.consumido_pct,
      texto: `${ET.consumido_pct} % consumido · ${100 - ET.consumido_pct} % descartado`,
      sub: `${plural(ET.n, 'ensilado terminó', 'ensilados terminaron')} sus ${horas} h: ${kgTxt(ET.consumido_kg)} de ${kgTxt(ET.kg)} kg comidos, ` +
           `${kgTxt(ET.descartado_kg)} kg descartados`
    } : null,
    lineas: [
      A.dado_kg ? `Alimento dado: ${kgTxt(A.dado_kg)} kg` +
                  (A.sin_ensilado_kg > 0 ? ` · ${kgTxt(A.sin_ensilado_kg)} kg sin ensilado (${plural(A.sin_ensilado_n, 'alimentación', 'alimentaciones')})` : '')
                : 'No se dio alimento en este periodo.',
      A.recibido.kg ? `Recibido: ${kgTxt(A.recibido.kg)} kg · ${A.recibido.por_material.map(m => `${m.material} ${kgTxt(m.kg)} kg`).join(' · ')}`
                    : 'No se recibió material en este periodo.',
      A.ensilados_hechos.n ? `${plural(A.ensilados_hechos.n, 'ensilado hecho', 'ensilados hechos')}: ${kgTxt(A.ensilados_hechos.kg)} kg`
                           : 'Ningún ensilado hecho en este periodo.'
    ]
  };

  return ok({
    ahora, alerta,
    semanas: semanas.map(s => ({
      desde: s.desde, etiqueta: diaTxt(s.desde), en_curso: s.en_curso,
      titulo: s.en_curso ? 'Esta semana (en curso)' : `Semana del ${diaTxt(s.desde)}`,
      recolectas: s.recolectas, g: s.recolectado_g, separaciones: s.separaciones, kg: s.separado_kg
    })),
    periodo: {
      clave: p.clave,
      titulo: p.desde ? `${PERIODO_TXT[p.clave]} · desde el ${diaTxt(p.desde)}` : 'Todo, desde el primer registro',
      secciones: [larvas, insectario, horno, alimento]
    }
  });
}

/* ── the lab ──────────────────────────────────────────────────────────────── */

const URGENCIA = { atrasado: 0, hoy: 1, pendiente: 2, proximo: 3 };
const urgencia = f => (f.paso ? URGENCIA[f.paso.estado] ?? 4 : 4);

/**
 * The lab in one list: every insectario and every bandeja (each incubadora and
 * each caja de engorde) with how it is doing and what it needs next, the most
 * pressing first. All that are active; of the rest, the most recent, with the
 * true totals so the counts on screen are never short.
 */
const INACTIVAS_A_LA_VISTA = 60;

export async function getLaboratorio() {
  const v = await vistaActual(await openDb());
  const insectarios = v.jaulas.map(j => ({ ...jaulaFila(v, j), activo: j.fase === 'activa' }))
    .sort((a, b) => Number(b.activo) - Number(a.activo) || urgencia(a) - urgencia(b) || a.nombre.localeCompare(b.nombre, 'es'));
  const filas = [
    ...v.incubadoras.map(i => ({ ...incubadoraFila(v, i), tipo: 'incubadora', n: i.n_bandejas, activo: i.estado === 'activo', dia0: i.dia0 })),
    ...v.cajas.map(c => ({ ...cajaFila(v, c), tipo: 'caja', n: 1, activo: c.estado === 'activo', dia0: c.dia0 }))
  ];
  const activas = filas.filter(b => b.activo)
    .sort((a, b) => urgencia(a) - urgencia(b) || String(a.dia0).localeCompare(String(b.dia0)) || a.codigo.localeCompare(b.codigo));
  const inactivas = filas.filter(b => !b.activo)
    .sort((a, b) => String(b.dia0).localeCompare(String(a.dia0)) || a.codigo.localeCompare(b.codigo));
  return ok({
    insectarios,
    bandejas: [...activas, ...inactivas.slice(0, INACTIVAS_A_LA_VISTA)],
    bandejas_total: filas.reduce((t, b) => t + b.n, 0),
    inactivas_sin_ver: Math.max(0, inactivas.length - INACTIVAS_A_LA_VISTA),
    pool_kg: v.pool.kg_pendiente
  });
}

/* ── containers ───────────────────────────────────────────────────────────── */

export async function listContenedores() {
  const v = await vistaActual(await openDb());
  return ok(v.contenedores.map(c => {
    const actual = v.ensilados.filter(e => e.contenedor_id === c.id && e.estado !== 'vencido')
      .sort((a, b) => String(b.ensilado_at).localeCompare(String(a.ensilado_at)))[0];
    return { id: c.id, codigo: c.codigo, ensilado: actual ? `${actual.codigo} · ${ENSILADO_TXT[actual.estado]}` : 'Vacío',
             registro: registro(v, 'contenedor', c, `Contenedor ${c.codigo}`, '') };
  }).sort((a, b) => a.codigo.localeCompare(b.codigo, 'es', { numeric: true })));
}

/* ── the insectario ───────────────────────────────────────────────────────── */

function jaulaFila(v, j) {
  return {
    id: j.id, nombre: j.nombre, letra: j.letra, lugar: j.lugar,
    fase: j.fase, faseTxt: FASE_TXT[j.fase], generacion: j.generacion,
    dia_ciclo: j.dia_ciclo,
    linea: [`F${j.generacion}`, j.dia_ciclo !== null ? `día ${j.dia_ciclo} del ciclo` : null, j.lugar || null].filter(Boolean).join(' · '),
    paso: primerPaso(j.pasos.filter(p => p.aviso))
  };
}

function ingresoRegistros(v, i) {
  const l = i.larvas;
  const edades = l && l.edad_min !== null
    ? (l.edad_min === l.edad_max ? `${l.edad_min} días` : `${l.edad_min}–${l.edad_max} días (prom. ${l.edad_promedio})`)
    : 'sin datos de edad';
  const out = [registro(v, 'ingreso', i, `Ingreso · F${i.generacion}`,
    `${kgTxt(i.kg_larvas)} kg del 2 % · ${i.bandejas.length} bandeja${i.bandejas.length === 1 ? '' : 's'} · larvas de ${edades}` +
    (l?.mezcla ? ` · mezcla de F${l.generaciones.join(', F')}` : '') +
    (l?.faltan_kg > 0 ? ` · ${kgTxt(l.faltan_kg)} kg sin registro en el 2 %` : ''))];
  for (const b of i.bandejas) {
    out.push(registro(v, 'bandeja_pupacion', b, `Bandeja de pupación ${b.codigo}`, `${kgTxt(b.peso_kg)} kg`, { fecha: i.fecha }));
  }
  return out;
}

export async function getJaula(id) {
  const v = await vistaActual(await openDb());
  const j = v.jaulas.find(x => x.id === id);
  if (!j) return fail(CODES.NOT_FOUND, 'Insectario no encontrado.');
  const ingresos = v.ingresos.filter(i => i.jaula_id === id);
  const registros = [
    registro(v, 'jaula', j, 'Registro del insectario',
             `Letra ${j.letra} · F${j.generacion_inicial} al registrarlo · ${FASE_TXT[j.fase_inicial]}`,
             { fecha: j.created_at }),
    ...ingresos.flatMap(i => ingresoRegistros(v, i)),
    ...j.eventos.map(e => registro(v, 'jaula_evento', e, e.tipo === 'cierre' ? 'Cierre' : 'Limpieza', ''))
  ].sort(porFechaDesc);
  const recolectas = v.incubadoras.filter(i => i.jaula_id === id)
    .sort((a, b) => String(b.recolecta_at).localeCompare(String(a.recolecta_at)))
    .slice(0, 12)
    .map(i => ({ id: i.id, codigo: i.codigo, linea: `${diaTxt(i.dia0)} · día ${i.dia} · ${i.estado === 'activo' ? 'en incubadora' : i.distribucion ? 'distribuida' : 'cerrada'}` }));
  return ok({
    jaula: jaulaFila(v, j),
    facts: [
      ['Generación', `F${j.generacion}`], ['Estado', FASE_TXT[j.fase]],
      ['Ciclo', j.ciclo_desde ? `desde ${diaTxt(j.ciclo_desde)} (día ${j.dia_ciclo})`
        : j.fase === 'activa' ? 'sin fecha (ya tenía moscas al registrarlo)'
        : j.fase === 'limpia' ? 'empieza al repoblarlo' : 'sin fecha'],
      ['Lugar', j.lugar || '—']
    ],
    pasos: j.pasos.map(paso),
    pool_kg: v.pool.kg_pendiente,
    recolectas,
    registros
  });
}

/* ── incubadoras ──────────────────────────────────────────────────────────── */

const bandejasTxt = n => (n === 1 ? '1 bandeja' : `${n} bandejas`);

function incubadoraFila(v, i) {
  return {
    id: i.id, codigo: i.codigo, estado: i.estado, dia: i.dia,
    jaula: i.jaula?.nombre || '?',
    linea: [`Día ${i.dia}`, bandejasTxt(i.n_bandejas), i.jaula?.nombre,
            i.excepcion ? 'registrada tarde' : null].filter(Boolean).join(' · '),
    paso: primerPaso(i.pasos.filter(p => p.aviso)),
    revisar: motivosRevisar(v, 'incubadora', i.id).length > 0,
    estadoTxt: i.estado === 'activo' ? 'En incubadora' : i.distribucion ? 'Distribuida' : 'Cerrada'
  };
}

export async function getIncubadora(id) {
  const v = await vistaActual(await openDb());
  const i = v.por.incubadora.get(id);
  if (!i) return fail(CODES.NOT_FOUND, 'Incubadora no encontrada.');
  const cajas = v.cajas.filter(c => c.incubadora_id === id).sort((a, b) => a.numero - b.numero);
  const registros = [
    registro(v, 'incubadora', i, 'Recolecta',
             `${kgTxt(i.peso_inicial_g)} g · ${bandejasTxt(i.n_bandejas)} · ${kgTxt(i.alimento_inicial_kg)} kg de alimento` +
             (origenAlimento(v, i.id) ? ` (${origenAlimento(v, i.id)})` : ''),
             { fecha: i.recolecta_at }),
    ...i.chequeos.map(c => registro(v, 'chequeo', c, `Chequeo día ${c.dia}`, chequeoTxt(c))),
    ...(i.distribucion ? [registro(v, 'distribucion', i.distribucion, 'Tamizado, pesado y distribución',
        `${kgTxt(i.distribucion.peso_total_kg)} kg tamizados · ${cajas.length} caja${cajas.length === 1 ? '' : 's'}`)] : [])
  ].sort(porFechaDesc);
  return ok({
    incubadora: incubadoraFila(v, i),
    facts: [
      ['Insectario', `${i.jaula?.nombre || '?'} · F${i.generacion}`], ['Día', String(i.dia)],
      ['Recolecta', fechaHoraTxt(i.recolecta_at)], ['Bandejas', String(i.n_bandejas)],
      ['Peso inicial', `${kgTxt(i.peso_inicial_g)} g`],
      ['Alimento inicial', `${kgTxt(i.alimento_inicial_kg)} kg · ${kgTxt(Math.round(i.alimento_inicial_kg * 1000 / i.n_bandejas))} g por bandeja`]
    ],
    sin_ensilado: sinEnsilado(v, i.id),
    cierre: cierreTxt(i),
    excepcion: i.excepcion ? 'Registrada con fecha pasada (excepción).' : '',
    pasos: i.pasos.map(paso),
    cajas: cajas.map(c => cajaFila(v, c)),
    registros,
    faltan_chequeos: i.cerrado_at ? [] : atrasables(v.cfg, [v.cfg.dia_chequeo_incubadora], i.chequeos.map(c => Number(c.dia)), i.pasos, 'chequeo'),
    activa: i.estado === 'activo'
  });
}

/* ── cajas de engorde ─────────────────────────────────────────────────────── */

function cajaFila(v, c) {
  const estadoTxt = c.estado === 'activo' ? (c.en_ayuno ? 'En ayuno' : 'Engorde')
                  : c.separacion ? 'Separada' : 'Cerrada';
  return {
    id: c.id, codigo: c.codigo, estado: c.estado, estadoTxt, dia: c.dia, en_ayuno: c.en_ayuno,
    incubadora_id: c.incubadora_id, incubadora: c.incubadora_codigo, numero: c.numero,
    linea: [`Día ${c.dia}`, `cargas ${c.cargas.map(x => x.carga).join(', ') || '—'}`].join(' · '),
    paso: primerPaso(c.pasos.filter(p => p.aviso)),
    revisar: motivosRevisar(v, 'caja', c.id).length > 0
  };
}

export async function getCaja(id) {
  const v = await vistaActual(await openDb());
  const c = v.por.caja.get(id);
  if (!c) return fail(CODES.NOT_FOUND, 'Caja no encontrada.');
  const sep = c.separacion;
  const registros = [
    registro(v, 'caja', c, 'Caja creada en la distribución', `${kgTxt(c.peso_inicial_kg)} kg`, { fecha: c.created_at }),
    ...c.cargas.map(a => registro(v, 'alimentacion', a, `Carga ${a.carga}`,
      `${kgTxt(a.kg)} kg${a.kg_plan != null && Number(a.kg_plan) !== Number(a.kg) ? ` (plan ${kgTxt(a.kg_plan)})` : ''}` +
      (origenAlimento(v, a.id) ? ` · ${origenAlimento(v, a.id)}` : ''))),
    ...c.chequeos.map(x => registro(v, 'chequeo', x, `Chequeo día ${x.dia}`, chequeoTxt(x))),
    ...(sep ? [registro(v, 'separacion', sep, 'Separación',
        `${kgTxt(sep.peso_total_kg)} kg → ${kgTxt(c.reparto.coccion_kg)} kg al horno · ${kgTxt(c.reparto.retorno_kg)} kg al insectario`)] : [])
  ].sort(porFechaDesc);
  return ok({
    caja: cajaFila(v, c),
    facts: [
      ['Incubadora', c.incubadora_codigo], ['Día', String(c.dia)],
      ['Peso inicial', `${kgTxt(c.peso_inicial_kg)} kg`],
      ['Estado', cajaFila(v, c).estadoTxt], ['Generación', c.generacion !== null ? `F${c.generacion}` : '—']
    ],
    cierre: cierreTxt(c),
    sin_ensilado: c.cargas.some(a => sinEnsilado(v, a.id)),
    pasos: c.pasos.map(paso),
    registros,
    faltan_chequeos: c.cerrado_at ? [] : atrasables(v.cfg, v.cfg.dias_chequeo_caja, c.chequeos.map(x => Number(x.dia)), c.pasos, 'chequeo'),
    faltan_cargas: c.cerrado_at ? [] : atrasables(v.cfg, v.cfg.cargas.filter(x => x.dia !== v.cfg.dia_distribucion).map(x => x.n),
                                                  c.cargas.map(x => Number(x.carga)), c.pasos, 'carga'),
    activa: c.estado === 'activo'
  });
}

/* ── the oven ─────────────────────────────────────────────────────────────── */

function cochadaFila(v, co) {
  return {
    id: co.id, codigo: co.codigo, estado: co.estado,
    estadoTxt: co.estado === 'activo' ? 'En el horno' : co.final ? 'Lista para empacar' : 'Cerrada',
    linea: [`${kgTxt(co.peso_inicial_kg)} kg`, co.final ? `final ${kgTxt(co.final.peso_kg)} kg` : null,
            fechaHoraTxt(co.horno_at)].filter(Boolean).join(' · '),
    paso: primerPaso(co.pasos.filter(p => p.aviso)),
    revisar: co.origenes.some(o => motivosRevisar(v, 'cochada_origen', o.id).length)
  };
}

/** The 98 % waiting, separación by separación — what a new cochada takes from. */
function pendientesHorno(v) {
  return v.horno.filter(h => h.kg_pendiente > 0).map(h => {
    const caja = v.por.caja.get(h.caja_id);
    return { separacion_id: h.separacion_id, caja: caja?.codigo || '?', fecha: diaTxt(farmDay(h.fecha)),
             kg_pendiente: h.kg_pendiente, coccion_kg: h.coccion_kg };
  });
}

export async function getHorno() {
  const v = await vistaActual(await openDb());
  const cochadas = [...v.cochadas].sort((a, b) =>
    (a.estado === b.estado ? 0 : a.estado === 'activo' ? -1 : 1) || String(b.horno_at).localeCompare(String(a.horno_at)));
  return ok({
    pendientes: pendientesHorno(v),
    kg_pendiente: kg3(v.horno.reduce((s, h) => s + h.kg_pendiente, 0)),
    activas: cochadas.filter(c => c.estado === 'activo').map(c => cochadaFila(v, c)),
    recientes: cochadas.filter(c => c.estado !== 'activo').slice(0, 20).map(c => cochadaFila(v, c))
  });
}

export async function getCochada(id) {
  const v = await vistaActual(await openDb());
  const co = v.cochadas.find(c => c.id === id);
  if (!co) return fail(CODES.NOT_FOUND, 'Cochada no encontrada.');
  const registros = [
    registro(v, 'cochada', co, 'Al horno', `${kgTxt(co.peso_inicial_kg)} kg`, { fecha: co.horno_at }),
    ...co.origenes.map(o => registro(v, 'cochada_origen', o, `Del 98 % de ${o.caja?.codigo || '?'}`, `${kgTxt(o.kg)} kg`)),
    ...co.lecturas.map(l => registro(v, 'cochada_lectura', l, l.momento === 'final' ? 'Lectura final' : 'Mitad del horno',
      `${kgTxt(l.temperatura_c)} °C${l.peso_kg != null ? ` · ${kgTxt(l.peso_kg)} kg` : ''}`))
  ].sort(porFechaDesc);
  const merma = co.final && Number(co.peso_inicial_kg) > 0
    ? `${kgTxt(Math.round((1 - Number(co.final.peso_kg) / Number(co.peso_inicial_kg)) * 1000) / 10)} %` : '—';
  return ok({
    cochada: cochadaFila(v, co),
    facts: [
      ['Al horno', fechaHoraTxt(co.horno_at)], ['Peso inicial', `${kgTxt(co.peso_inicial_kg)} kg`],
      ['Del 98 %', `${kgTxt(co.kg_origen)} kg de ${co.origenes.length} separaci${co.origenes.length === 1 ? 'ón' : 'ones'}`],
      ['Mitad', co.media ? `${kgTxt(co.media.temperatura_c)} °C` : '—'],
      ['Final', co.final ? `${kgTxt(co.final.temperatura_c)} °C · ${kgTxt(co.final.peso_kg)} kg` : '—'],
      ['Pérdida de peso', merma]
    ],
    cierre: cierreTxt(co),
    pasos: co.pasos.map(paso),
    registros,
    activa: co.estado === 'activo',
    tiene_media: Boolean(co.media)
  });
}

/* ── food ─────────────────────────────────────────────────────────────────── */

function ensiladoFila(v, e) {
  return {
    id: e.id, codigo: e.codigo, estado: e.estado, estadoTxt: ensiladoTxt(e),
    linea: e.estado === 'madurando'
      ? `${kgTxt(e.kg_total)} kg · se abre el ${diaTxt(e.apertura_prevista)}`
      : e.estado === 'abierto'
        ? `Quedan ${kgTxt(e.kg_restante)} de ${kgTxt(e.kg_total)} kg · vence ${horaLocal(e.vence_at)}`
        : `${kgTxt(e.kg_usado)} kg consumidos · ${kgTxt(e.kg_descartado)} kg descartados`,
    paso: primerPaso(e.pasos),
    revisar: motivosRevisar(v, 'ensilado', e.id).length > 0
  };
}

export async function getAlimento() {
  const db = await openDb();
  const v = await vistaActual(db);
  const ens = [...v.ensilados].sort((a, b) =>
    ({ abierto: 0, madurando: 1, vencido: 2 }[a.estado] - { abierto: 0, madurando: 1, vencido: 2 }[b.estado]) ||
    String(a.dia0).localeCompare(String(b.dia0)));
  const recepciones = [...v.recepciones].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ok({
    stock: [...v.stock.porMaterial.values()].sort((a, b) => a.material.localeCompare(b.material, 'es')),
    ensilados: [
      ...ens.filter(e => e.estado !== 'vencido').map(e => ensiladoFila(v, e)),
      ...ens.filter(e => e.estado === 'vencido').reverse().slice(0, 15).map(e => ensiladoFila(v, e))
    ],
    recepciones: recepciones.slice(0, 30).map(r => {
      const s = v.stock.porRecepcion.get(r.id);
      return { id: r.id, disponible: s.kg_disponible,
               registro: registro(v, 'recepcion', r, r.material,
                 `${kgTxt(r.kg)} kg · quedan ${kgTxt(s.kg_disponible)} kg sin ensilar`) };
    }),
    sin_ensilado: [...v.alimento.consumos.values()].filter(c => c.sin_ensilado_kg > 0).length
  });
}

export async function getEnsilado(id) {
  const v = await vistaActual(await openDb());
  const e = v.ensilados.find(x => x.id === id);
  if (!e) return fail(CODES.NOT_FOUND, 'Ensilado no encontrado.');
  const consumos = [];
  for (const [cid, c] of v.alimento.consumos) {
    for (const p of c.partes) {
      if (p.ensilado_id !== id) continue;
      const inc = c.tabla === 'incubadora' ? v.por.incubadora.get(cid) : null;
      const carga = c.tabla === 'alimentacion' ? v.alimentaciones.find(a => a.id === cid) : null;
      const caja = carga ? v.por.caja.get(carga.caja_id) : null;
      consumos.push({ que: inc ? `Recolecta ${inc.codigo}` : `Carga ${carga?.carga} · ${caja?.codigo || '?'}`,
                      kg: kgTxt(p.kg), fecha: inc ? inc.recolecta_at : carga?.fecha });
    }
  }
  consumos.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  const registros = [
    registro(v, 'ensilado', e, 'Ensilado', `${e.contenedor?.codigo || '?'} · ${kgTxt(e.kg_total)} kg` +
             (e.abierto_at ? ` · abierto ${cuandoTxt(e.abierto_at, v.hoy)} por ${e.abierto_por || '—'}` : ''),
             { fecha: e.ensilado_at }),
    ...e.insumos.map(i => registro(v, 'ensilado_insumo', i, i.recepcion?.material || 'Material',
      `${kgTxt(i.kg)} kg · recepción del ${i.recepcion ? diaTxt(farmDay(i.recepcion.fecha)) : '?'}`))
  ].sort(porFechaDesc);
  return ok({
    ensilado: ensiladoFila(v, e),
    facts: [
      ['Contenedor', e.contenedor?.codigo || '?'], ['Ensilado', diaTxt(e.dia0)],
      ['Apertura', e.abierto_at ? fechaHoraTxt(e.abierto_at) : `prevista ${diaTxt(e.apertura_prevista)}`],
      ['Total', `${kgTxt(e.kg_total)} kg`], ['Consumido', `${kgTxt(e.kg_usado)} kg`],
      [e.estado === 'vencido' ? 'Descartado' : 'Queda', `${kgTxt(e.estado === 'vencido' ? e.kg_descartado : e.kg_restante)} kg`]
    ],
    pasos: e.pasos.map(paso),
    consumos: consumos.map(c => ({ ...c, cuando: cuandoTxt(c.fecha, v.hoy) })),
    registros,
    puede_abrir: e.estado === 'madurando' && (!v.cfg.reglas_estrictas || v.hoy >= e.apertura_prevista)
  });
}

/* ── what needs a second look ─────────────────────────────────────────────── */

/** The object page a record lives on, so "revisar" can take you there. */
function dondeVive(v, tabla, id) {
  const fila = {
    incubadora: () => ({ pantalla: 'incubadora', id }),
    chequeo: () => {
      const c = v.chequeos.find(x => x.id === id);
      return c?.incubadora_id ? { pantalla: 'incubadora', id: c.incubadora_id } : { pantalla: 'caja', id: c?.caja_id };
    },
    distribucion: () => ({ pantalla: 'incubadora', id: v.distribuciones.find(x => x.id === id)?.incubadora_id }),
    cochada_origen: () => ({ pantalla: 'cochada', id: v.origenes.find(x => x.id === id)?.cochada_id }),
    ingreso: () => ({ pantalla: 'jaula', id: v.ingresos.find(x => x.id === id)?.jaula_id }),
    ensilado: () => ({ pantalla: 'ensilado', id })
  }[tabla];
  return fila ? fila() : null;
}

const NOMBRE_DE = {
  incubadora: (v, id) => `Incubadora ${v.por.incubadora.get(id)?.codigo || ''}`,
  chequeo: (v, id) => { const c = v.chequeos.find(x => x.id === id);
    const o = c?.incubadora_id ? v.por.incubadora.get(c.incubadora_id) : v.por.caja.get(c?.caja_id);
    return `Chequeo día ${c?.dia} · ${o?.codigo || ''}`; },
  distribucion: (v, id) => `Distribución de ${v.por.incubadora.get(v.distribuciones.find(x => x.id === id)?.incubadora_id)?.codigo || ''}`,
  cochada_origen: (v, id) => `Cochada ${v.cochadas.find(c => c.id === v.origenes.find(x => x.id === id)?.cochada_id)?.codigo || ''}`,
  ingreso: (v, id) => { const i = v.por.ingreso.get(id); return `Ingreso en ${i?.jaula?.nombre || ''} (${diaTxt(farmDay(i?.fecha))})`; },
  ensilado: (v, id) => `Ensilado ${v.ensilados.find(e => e.id === id)?.codigo || ''}`
};

export async function getRevisar() {
  const v = await vistaActual(await openDb());
  const out = [];
  for (const [k, motivos] of v.revisar) {
    const [tabla, id] = k.split(':');
    out.push({ tabla, id, nombre: (NOMBRE_DE[tabla] || (() => tabla))(v, id), motivos, abre: dondeVive(v, tabla, id) });
  }
  return ok(out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')));
}

/* ── forms: what each one starts from ─────────────────────────────────────── */

export async function getFormRecolecta() {
  const v = await vistaActual(await openDb());
  const codigos = v.incubadoras.map(i => i.codigo);
  return ok({
    jaulas: v.jaulas.filter(j => !v.cfg.reglas_estrictas || j.fase === 'activa')
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
      .map(j => ({ id: j.id, nombre: j.nombre, letra: j.letra, generacion: j.generacion,
                   siguiente: siguienteIncubadora(j.generacion, j.letra, codigos).codigo,
                   hoy: v.incubadoras.some(i => i.jaula_id === j.id && i.dia0 === v.hoy) })),
    // What the screen works the bandejas out with, as it is typed (protocolo.js).
    ajustes: { huevos_bandeja_min_g: v.cfg.huevos_bandeja_min_g, huevos_bandeja_max_g: v.cfg.huevos_bandeja_max_g },
    alimento_bandeja_g: v.cfg.alimento_bandeja_g,
    hoy: v.hoy
  });
}

/** The code a recolecta would get on a past day (excepción): the cage may have
 *  had another generation then. */
export async function previewRecolecta({ jaula_id, fecha } = {}) {
  const v = await vistaActual(await openDb());
  const j = v.por.jaula.get(jaula_id);
  if (!j) return ok(null);
  const gen = generacionDeJaula(jaula_id, fecha || new Date().toISOString(), { jaulas: v.jaulas, ingresos: v.ingresos });
  return ok({ generacion: gen, codigo: siguienteIncubadora(gen, j.letra, v.incubadoras.map(i => i.codigo)).codigo });
}

export async function getFormChequeo({ objeto, ids = [], dia } = {}) {
  const v = await vistaActual(await openDb());
  const enCaja = objeto === 'caja';
  const fuente = enCaja ? v.cajas : v.incubadoras;
  const elegidas = ids.length ? ids : fuente.filter(o => o.pasos.some(p => p.paso === 'chequeo' && p.dia === Number(dia))).map(o => o.id);
  return ok({
    objeto, dia: Number(dia), unidad: enCaja ? 'kg' : 'g',
    items: elegidas.map(id => (enCaja ? v.por.caja : v.por.incubadora).get(id)).filter(Boolean)
      .map(o => ({ id: o.id, codigo: o.codigo, dia_actual: o.dia,
                   hecho: o.chequeos.some(c => Number(c.dia) === Number(dia)) }))
  });
}

export async function getFormDistribucion(incubadora_id) {
  const v = await vistaActual(await openDb());
  const i = v.por.incubadora.get(incubadora_id);
  if (!i) return fail(CODES.NOT_FOUND, 'Incubadora no encontrada.');
  const plan = cargaDistribucion(v.cfg);
  return ok({
    incubadora: { id: i.id, codigo: i.codigo, dia: i.dia, activa: i.estado === 'activo' },
    carga: plan ? { n: plan.n, kg: plan.kg } : null,
    // The cajas will be {codigo}-01, -02… (ids.js cajaCodigo).
    primera: cajaCodigo(i.codigo, 1)
  });
}

export async function getFormCargas({ caja_ids = [], carga } = {}) {
  const v = await vistaActual(await openDb());
  const def = cargaDef(v.cfg, carga);
  return ok({
    carga: def,
    items: caja_ids.map(id => v.por.caja.get(id)).filter(Boolean).map(c => ({
      id: c.id, codigo: c.codigo, dia: c.dia, en_ayuno: v.cfg.reglas_estrictas && c.en_ayuno,
      dada: c.cargas.some(x => Number(x.carga) === Number(carga)),
      espera_chequeo: Boolean(v.cfg.reglas_estrictas && def && v.cfg.dias_chequeo_caja.includes(def.dia) &&
                              !c.chequeos.some(x => Number(x.dia) === def.dia))
    }))
  });
}

export async function getFormSeparacion({ caja_ids = [] } = {}) {
  const v = await vistaActual(await openDb());
  const ids = caja_ids.length ? caja_ids
    : v.cajas.filter(c => c.estado === 'activo' && c.dia >= v.cfg.dia_separacion).map(c => c.id);
  return ok({
    pct_coccion: v.cfg.pct_coccion,
    items: ids.map(id => v.por.caja.get(id)).filter(Boolean)
      .map(c => ({ id: c.id, codigo: c.codigo, dia: c.dia, separada: Boolean(c.separacion), activa: c.estado === 'activo' }))
  });
}

export async function getFormCochada() {
  const v = await vistaActual(await openDb());
  const hoyCodigos = v.cochadas.filter(c => farmDay(c.horno_at) === v.hoy).map(c => c.codigo);
  return ok({ pendientes: pendientesHorno(v), codigo: siguienteCochada(new Date().toISOString(), hoyCodigos) });
}

export async function getFormIngreso(jaula_id) {
  const v = await vistaActual(await openDb());
  const j = v.jaulas.find(x => x.id === jaula_id);
  return ok({
    jaula: j ? jaulaFila(v, j) : null,
    jaulas_limpias: v.jaulas.filter(x => x.fase === 'limpia').map(x => ({ id: x.id, nombre: x.nombre })),
    pool_kg: v.pool.kg_pendiente,
    pendientes: v.pool.pendientes.map(p => ({ caja: p.caja_codigo, kg: p.kg, dia0: p.dia0, generacion: p.generacion })),
    kg_bandeja: v.cfg.kg_bandeja_pupacion
  });
}

/**
 * What a repopulation would draw from the 2 %, as it is typed: the larvae's
 * ages and generation, a mix of generations, kilos the 2 % has no record of,
 * and the codes the trays will get.
 */
export async function previewIngreso({ kg_larvas, n_bandejas = 1 } = {}) {
  const v = await vistaActual(await openDb());
  const kg = Number(String(kg_larvas ?? '').replace(',', '.'));
  if (!Number.isFinite(kg) || kg <= 0) return ok(null);
  const ahora = new Date().toISOString();
  const r = pool2({ separaciones: v.separaciones, cajas: v.cajas, incubadoras: v.incubadoras, ingresos: v.ingresos },
                  v.cfg, { fecha: ahora, kg_larvas: kg }).nuevo;
  const gen = r.generacion_larvas;
  return ok({
    ...r,
    generacion_jaula: gen === null ? null : gen + 1,
    codigos: gen === null ? [] : siguientesBandejas(gen, ahora, Math.max(1, Number(n_bandejas) || 1),
                                                    v.bandejas.map(b => b.codigo)).map(c => c.codigo)
  });
}

export async function getFormEnsilado() {
  const db = await openDb();
  const v = await vistaActual(db);
  return ok({
    contenedores: v.contenedores.map(c => ({ id: c.id, codigo: c.codigo, codigo_hoy: ensiladoCodigo(c.codigo, new Date().toISOString()) })),
    recepciones: [...v.stock.porRecepcion.values()].filter(r => r.kg_disponible > 0)
      .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)))
      .map(r => ({ id: r.id, material: r.material, fecha: diaTxt(farmDay(r.fecha)), disponible: r.kg_disponible }))
  });
}

export async function listMateriales() {
  return listCatalogo('material_alimento');
}

/* ── one record, for the correction form ──────────────────────────────────── */

export async function getRegistro(tabla, id) {
  const db = await openDb();
  if (!EDITABLE[tabla]) return fail(CODES.VALIDATION, 'Ese registro no se puede corregir.');
  const row = await rowById(db, tabla, id);
  if (!row || row.deleted_at) return fail(CODES.NOT_FOUND, 'Registro no encontrado.');
  const v = await vistaActual(db);
  const materiales = (await listCatalogo('material_alimento')).data;
  const valorForm = (kind, val) => kind === 'fecha' ? (val ? toNaiveLocal(val) : '') : (val ?? '');
  return ok({
    tabla, id, titulo: EDITABLE[tabla].titulo,
    campos: camposDe(tabla, row).map(([col, kind, label]) => ({ col, kind, label, valor: valorForm(kind, row[col]) })),
    nota: row.nota || '',
    foto_key: row.foto_key || null,
    revisar: motivosRevisar(v, tabla, id),
    borrable: !v.cfg.reglas_estrictas,
    opciones: {
      jaulas: v.jaulas.map(j => ({ id: j.id, nombre: j.nombre })),
      materiales,
      fases: [{ id: 'activa', nombre: 'Con moscas' }, { id: 'limpia', nombre: 'Limpio' }]
    }
  });
}

/** The warning before deleting a record. */
export async function getBorrado({ tabla, id } = {}) {
  const v = await vistaActual(await openDb());
  return ok({ aviso: avisoBorrado(v, tabla, id) });
}

/* ── people and lists ─────────────────────────────────────────────────────── */

/**
 * The names to offer as one-tap chips.
 *
 * Names are plain text, tapped or typed — never a table with a foreign key,
 * which is what once made a whole day's capture fail on a device that had not
 * synced the roster yet. Merged from the names picked on this phone (most
 * recent first), the shared roster, and the names already on records.
 */
const NAME_STORES = ['incubadora', 'chequeo', 'distribucion', 'alimentacion', 'separacion',
                     'cochada', 'ingreso', 'jaula_evento', 'recepcion', 'ensilado'];

export async function listOperators() {
  const db = await openDb();
  const picked = new Map();
  ((await metaGet(db, 'nombres_usados', [])) || []).forEach((r, i) => {
    const n = str(r?.nombre);
    if (n && !picked.has(n.toLowerCase())) picked.set(n.toLowerCase(), { nombre: n, rank: i });
  });

  const registered = new Map();
  for (const c of await allRows(db, 'catalogo')) {
    if (c.tipo !== 'operario' || c.activo === false) continue;
    const n = str(c.valor);
    if (!n || picked.has(n.toLowerCase())) continue;
    registered.set(n.toLowerCase(), { nombre: n, orden: c.orden ?? 0 });
  }

  const derived = new Map();
  for (const store of NAME_STORES) {
    for (const row of await allRows(db, store)) {
      const n = str(row.registrado_por);
      if (!n) continue;
      const k = n.toLowerCase();
      if (picked.has(k) || registered.has(k)) continue;
      const last = String(row.fecha || row.created_at || '');
      const prev = derived.get(k);
      if (!prev || last > prev.last) derived.set(k, { nombre: n, last });
    }
  }

  return ok([
    ...[...picked.values()].sort((a, b) => a.rank - b.rank),
    ...[...registered.values()].sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, 'es')),
    ...[...derived.values()].sort((a, b) => b.last.localeCompare(a.last) || a.nombre.localeCompare(b.nombre, 'es'))
  ].map(r => r.nombre));
}

/**
 * Catalogue values. Each value once: a phone seeds the lists before its first
 * sync so the pickers work offline, and the server's copies of the same values
 * arrive later with different ids.
 */
export async function listCatalogo(tipo) {
  const db = await openDb();
  const rows = (await rowsByIndex(db, 'catalogo', 'by_tipo', tipo))
    .filter(c => c.activo !== false)
    .sort((a, b) => Number(Boolean(a._seeded)) - Number(Boolean(b._seeded)));
  const byValue = new Map();
  for (const c of rows) {
    const k = String(c.valor ?? '').trim().toLowerCase();
    if (k && !byValue.has(k)) byValue.set(k, c);
  }
  return ok([...byValue.values()]
    .sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || String(a.valor).localeCompare(String(b.valor)))
    .map(c => c.valor));
}
