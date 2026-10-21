-- ============================================================================
-- TryEnto — INSTALACIÓN COMPLETA DE LA BASE DE DATOS
--
-- PARA UNA BASE NUEVA Y VACÍA. Empieza en el archivo marcado @setup-baseline:
-- los anteriores quedan en supabase/migrations como historia y no se corren.
--
-- OJO: en una base que todavía tiene el protocolo anterior, BORRA todos sus
-- datos (menos los nombres de las personas). Para actualizar una base que ya
-- existe se corren los archivos numerados que falten, uno por uno.
--
-- Cópialo ENTERO y pégalo en Supabase → SQL Editor → New query → Run.
-- Copia el CONTENIDO del archivo, no su nombre.
--
-- Después: Settings → API → "Exposed schemas" → agrega  app
--
-- GENERADO por tools/build-setup-sql.mjs (npm run setup:sql). No lo edites a
-- mano: las fuentes son supabase/migrations/00*.sql
-- ============================================================================


-- ############################################################################
-- 0010_ciclo_nuevo.sql
-- ############################################################################

-- ============================================================================
-- 0010 — Los protocolos nuevos: el ciclo de las larvas, el insectario y el
-- alimento.  @setup-baseline
--
-- BORRA TODOS LOS DATOS DE LA APP (todas las tablas del protocolo anterior) y
-- crea las nuevas desde cero. Sólo se conservan los nombres de las personas
-- (la lista de operarios), con sus mismos identificadores.
--
-- El historial de AppSheet nunca se cargó en esta base: se cargará aparte en el
-- esquema `historico`, que este archivo crea vacío y que la app no usa.
--
-- EN PRODUCCIÓN: correr UNA vez, ANTES de publicar la app que lo usa.
-- Correrlo otra vez no borra nada nuevo: la parte que borra sólo actúa si
-- encuentra las tablas del protocolo anterior.
--
-- @setup-baseline: SETUP_COMPLETO.sql empieza en este archivo. 0001–0009 quedan
-- en la carpeta como historia y no se vuelven a correr.
--
-- Dos grupos de tablas en la misma base:
--   OBJETOS   rack, contenedor, jaula, incubadora, caja, bandeja_pupacion,
--             cochada, ensilado — lo que existe, con su estado activo/inactivo.
--             Nada se borra: se marca inactivo.
--   REGISTROS recepcion, ensilado_insumo, chequeo, distribucion, alimentacion,
--             separacion, cochada_origen, cochada_lectura, ingreso,
--             jaula_evento, movimiento — lo que pasó, cuándo y quién.
-- Todas llevan las mismas columnas de sincronización que antes (id generado en
-- el teléfono, registrado_por, created_by, dispositivo_id, created_at,
-- updated_at del servidor, synced_at, deleted_at), más una nota, una foto y
-- quién las editó por última vez.
--
-- Se guarda lo que el operario registró o confirmó. Lo que se puede calcular
-- (edades, consumo de alimento, el 2 % pendiente, el stock) lo calcula la app
-- y no se guarda, así una corrección lo actualiza todo.
--
-- Los códigos (F8A-12, F8A-12-03, H-2810-1, S2-2810, F7-B2810-1) son lo que se
-- escribe en el recipiente: no cambian nunca, aunque se corrija la jaula, la
-- generación o la fecha de la que salieron.
-- ============================================================================

create extension if not exists pgcrypto;


-- ── 0. Del protocolo anterior: guardar los nombres, borrar todo lo demás ───

do $$
begin
  -- El esquema nuevo tiene `jaula`; el anterior no. Sin `jaula` y con el
  -- esquema `app` presente, lo que hay es el protocolo anterior.
  if to_regclass('app.jaula') is null
     and exists (select 1 from pg_namespace where nspname = 'app') then
    if to_regclass('app.catalogo') is not null then
      execute $q$
        create temp table _operarios on commit preserve rows as
          select id, valor, orden, activo from app.catalogo where tipo = 'operario'
      $q$;
    end if;
    drop schema app cascade;
  end if;
end $$;

create schema if not exists app;
set search_path = app, public;


-- ── 1. Funciones de apoyo ───────────────────────────────────────────────────

-- Día del calendario de la granja (America/Caracas).
create or replace function app.dia_local(ts timestamptz)
returns date language sql stable as $$
  select (ts at time zone 'America/Caracas')::date
$$;

create or replace function app.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.synced_at  := now();
  return new;
end $$;


-- ── 2. Apoyo: listas y ajustes ──────────────────────────────────────────────

create table if not exists app.catalogo (
  id         uuid primary key,
  tipo       text not null,           -- operario | material_alimento
  valor      text not null,
  orden      int  not null default 0,
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  synced_at  timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tipo, valor)
);

-- Los números del protocolo. Se cambian aquí (editor de tablas de Supabase),
-- sin publicar la app.
create table if not exists app.parametro (
  id          uuid primary key default gen_random_uuid(),
  clave       text not null unique,
  valor       jsonb,
  descripcion text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  synced_at   timestamptz not null default now()
);


-- ── 3. Objetos de infraestructura ───────────────────────────────────────────

create table if not exists app.rack (
  id             uuid primary key,
  codigo         text not null,
  estado         text not null default 'activo' check (estado in ('activo', 'inactivo')),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_rack_codigo on app.rack (upper(codigo)) where deleted_at is null;

-- Contenedor (silo) donde se hace un ensilado.
create table if not exists app.contenedor (
  id             uuid primary key,
  codigo         text not null,
  estado         text not null default 'activo' check (estado in ('activo', 'inactivo')),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_contenedor_codigo on app.contenedor (upper(codigo)) where deleted_at is null;

-- Jaula (insectario). Se reutiliza: ciclo tras ciclo se repuebla, da
-- recolectas ~14 días, se cierra y se limpia. Una generación por ciclo.
--   fase_inicial / generacion_inicial: lo que se escribió al registrarla.
--   fase / generacion / ciclo_desde: los mantienen los ingresos, cierres y
--   limpiezas (ver recalcular_jaula). ciclo_desde vacío = ciclo sin fecha
--   (jaula que ya tenía moscas al arrancar la app).
create table if not exists app.jaula (
  id                 uuid primary key,
  nombre             text not null,
  letra              text not null check (letra ~ '^[A-Z0-9]{1,3}$'),
  lugar              text not null default '',
  generacion_inicial int  not null check (generacion_inicial >= 0),
  fase_inicial       text not null check (fase_inicial in ('activa', 'limpia')),
  generacion         int  not null default 0,
  fase               text not null default 'limpia' check (fase in ('activa', 'cerrada', 'limpia')),
  estado             text generated always as
                       (case when fase = 'activa' then 'activo' else 'inactivo' end) stored,
  ciclo_desde        date,
  nota               text not null default '',
  foto_key           text,
  editado_at         timestamptz,
  editado_por        text,
  valores_editados_at timestamptz,
  revisado_at        timestamptz,
  registrado_por     text,
  created_by         uuid,
  dispositivo_id     uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  synced_at          timestamptz not null default now(),
  deleted_at         timestamptz
);
create unique index if not exists ux_jaula_letra  on app.jaula (letra) where deleted_at is null;
create unique index if not exists ux_jaula_nombre on app.jaula (upper(nombre)) where deleted_at is null;


-- ── 4. El alimento ──────────────────────────────────────────────────────────

create table if not exists app.recepcion (
  id             uuid primary key,
  fecha          timestamptz not null,
  material       text not null,
  kg             numeric(10,3) not null check (kg > 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);

-- Un ensilado: madura 21 días, se abre el día 21 y se consume en 72 horas.
-- Lo consumido y lo descartado no se guardan: se calculan de las cargas.
create table if not exists app.ensilado (
  id             uuid primary key,
  codigo         text not null,
  contenedor_id  uuid not null references app.contenedor(id),
  ensilado_at    timestamptz not null,
  dia0           date not null,           -- lo pone el trigger
  abierto_at     timestamptz,
  abierto_por    text,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
-- El código ({contenedor}-{ddmm}) no lleva el año: es único en su día.
create unique index if not exists ux_ensilado_codigo on app.ensilado (codigo, dia0) where deleted_at is null;

create table if not exists app.ensilado_insumo (
  id             uuid primary key,
  ensilado_id    uuid not null references app.ensilado(id),
  recepcion_id   uuid not null references app.recepcion(id),
  kg             numeric(10,3) not null check (kg > 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_insumo_ensilado on app.ensilado_insumo (ensilado_id);


-- ── 5. El ciclo de las larvas ───────────────────────────────────────────────

-- La recolecta crea la incubadora (día 0). Código F{gen}{letra}-{n}: n sigue a
-- los códigos ya dados en esa jaula y generación. Sólo el código es único:
-- corregir la jaula de una incubadora no debe chocar con la numeración de la
-- otra.
create table if not exists app.incubadora (
  id                  uuid primary key,
  codigo              text not null,
  jaula_id            uuid not null references app.jaula(id),
  generacion          int  not null check (generacion >= 0),
  numero              int  not null check (numero > 0),
  recolecta_at        timestamptz not null,
  dia0                date not null,       -- lo pone el trigger
  excepcion           boolean not null default false,
  rack_id             uuid references app.rack(id),
  peso_inicial_g      numeric(10,2) not null check (peso_inicial_g >= 0),
  alimento_inicial_kg numeric(10,3) not null check (alimento_inicial_kg >= 0),
  estado              text not null default 'activo' check (estado in ('activo', 'inactivo')),
  cerrado_at          timestamptz,
  cerrado_por         text,
  motivo_cierre       text,
  nota                text not null default '',
  foto_key            text,
  editado_at          timestamptz,
  editado_por         text,
  valores_editados_at timestamptz,
  revisado_at         timestamptz,
  registrado_por      text,
  created_by          uuid,
  dispositivo_id      uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  synced_at           timestamptz not null default now(),
  deleted_at          timestamptz
);
create unique index if not exists ux_incubadora_codigo on app.incubadora (codigo) where deleted_at is null;
create index if not exists ix_incubadora_jaula on app.incubadora (jaula_id, generacion);

-- Tamizado, pesado y distribución (día 7): una por incubadora.
create table if not exists app.distribucion (
  id             uuid primary key,
  incubadora_id  uuid not null references app.incubadora(id),
  fecha          timestamptz not null,
  peso_total_kg  numeric(10,3) not null check (peso_total_kg >= 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_distribucion_incubadora
  on app.distribucion (incubadora_id) where deleted_at is null;

-- Caja de engorde. La edad y la generación son las de su incubadora.
create table if not exists app.caja (
  id              uuid primary key,
  codigo          text not null,
  incubadora_id   uuid not null references app.incubadora(id),
  distribucion_id uuid not null references app.distribucion(id),
  numero          int  not null check (numero > 0),
  rack_id         uuid references app.rack(id),
  peso_inicial_kg numeric(10,3) not null check (peso_inicial_kg >= 0),
  estado          text not null default 'activo' check (estado in ('activo', 'inactivo')),
  cerrado_at      timestamptz,
  cerrado_por     text,
  motivo_cierre   text,
  nota            text not null default '',
  foto_key        text,
  editado_at      timestamptz,
  editado_por     text,
  valores_editados_at timestamptz,
  revisado_at     timestamptz,
  registrado_por  text,
  created_by      uuid,
  dispositivo_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz not null default now(),
  deleted_at      timestamptz
);
create unique index if not exists ux_caja_codigo on app.caja (codigo) where deleted_at is null;
create unique index if not exists ux_caja_numero on app.caja (incubadora_id, numero) where deleted_at is null;

-- Chequeo (días 3, 10 y 14): humedad y temperatura del sustrato, y peso.
-- Gramos en la incubadora, kilos en la caja.
create table if not exists app.chequeo (
  id             uuid primary key,
  incubadora_id  uuid references app.incubadora(id),
  caja_id        uuid references app.caja(id),
  dia            int not null check (dia > 0),
  fecha          timestamptz not null,
  humedad_pct    numeric(5,2) not null check (humedad_pct between 0 and 100),
  temperatura_c  numeric(5,2) not null check (temperatura_c between -10 and 90),
  peso_g         numeric(10,2) check (peso_g >= 0),
  peso_kg        numeric(10,3) check (peso_kg >= 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint ck_chequeo_objeto check (num_nonnulls(incubadora_id, caja_id) = 1),
  constraint ck_chequeo_peso check (
    (incubadora_id is null or (peso_g is not null and peso_kg is null)) and
    (caja_id is null or (peso_kg is not null and peso_g is null)))
);
create unique index if not exists ux_chequeo_incubadora
  on app.chequeo (incubadora_id, dia) where deleted_at is null and incubadora_id is not null;
create unique index if not exists ux_chequeo_caja
  on app.chequeo (caja_id, dia) where deleted_at is null and caja_id is not null;

-- Cargas de alimento de una caja. kg_plan / dia_plan: lo que proponía el plan.
create table if not exists app.alimentacion (
  id             uuid primary key,
  caja_id        uuid not null references app.caja(id),
  carga          int  not null check (carga > 0),
  fecha          timestamptz not null,
  kg             numeric(10,3) not null check (kg >= 0),
  kg_plan        numeric(10,3),
  dia_plan       int,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_alimentacion_carga
  on app.alimentacion (caja_id, carga) where deleted_at is null;

-- Separación de una caja: el peso total y el reparto 98 % horno / 2 % retorno.
-- El reparto se calcula aquí mismo, así una edición del peso lo recalcula.
create table if not exists app.separacion (
  id             uuid primary key,
  caja_id        uuid not null references app.caja(id),
  fecha          timestamptz not null,
  peso_total_kg  numeric(10,3) not null check (peso_total_kg >= 0),
  pct_coccion    numeric(5,2) not null default 98 check (pct_coccion between 0 and 100),
  coccion_kg     numeric(10,3) generated always as
                   (round(peso_total_kg * pct_coccion / 100, 3)) stored,
  retorno_kg     numeric(10,3) generated always as
                   (peso_total_kg - round(peso_total_kg * pct_coccion / 100, 3)) stored,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_separacion_caja on app.separacion (caja_id) where deleted_at is null;


-- ── 6. El horno ─────────────────────────────────────────────────────────────

create table if not exists app.cochada (
  id              uuid primary key,
  codigo          text not null,
  horno_at        timestamptz not null,
  peso_inicial_kg numeric(10,3) not null check (peso_inicial_kg > 0),
  estado          text not null default 'activo' check (estado in ('activo', 'inactivo')),
  cerrado_at      timestamptz,
  cerrado_por     text,
  motivo_cierre   text,
  nota            text not null default '',
  foto_key        text,
  editado_at      timestamptz,
  editado_por     text,
  valores_editados_at timestamptz,
  revisado_at     timestamptz,
  registrado_por  text,
  created_by      uuid,
  dispositivo_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz not null default now(),
  deleted_at      timestamptz
);
-- El código (H-{ddmm}-{n}) no lleva el año: es único en su día de la granja.
create unique index if not exists ux_cochada_codigo
  on app.cochada (codigo, ((horno_at at time zone 'America/Caracas')::date)) where deleted_at is null;

-- De qué separaciones sale una cochada y cuántos kg de cada una (el 98 % de una
-- separación se puede repartir entre varias cochadas).
create table if not exists app.cochada_origen (
  id             uuid primary key,
  cochada_id     uuid not null references app.cochada(id),
  separacion_id  uuid not null references app.separacion(id),
  kg             numeric(10,3) not null check (kg > 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_origen_cochada on app.cochada_origen (cochada_id);
create index if not exists ix_origen_separacion on app.cochada_origen (separacion_id);

-- Temperatura a mitad de horno, y la final con el peso final.
create table if not exists app.cochada_lectura (
  id             uuid primary key,
  cochada_id     uuid not null references app.cochada(id),
  momento        text not null check (momento in ('media', 'final')),
  fecha          timestamptz not null,
  temperatura_c  numeric(6,2) not null check (temperatura_c between -10 and 400),
  peso_kg        numeric(10,3) check (peso_kg >= 0),
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz,
  constraint ck_lectura_final check (momento <> 'final' or peso_kg is not null)
);
create unique index if not exists ux_lectura_momento
  on app.cochada_lectura (cochada_id, momento) where deleted_at is null;


-- ── 7. Del 2 % al insectario ────────────────────────────────────────────────

-- Ingreso al insectario: repuebla una jaula cerrada y limpia con bandejas de
-- pupación armadas con kg_larvas tomados del 2 % acumulado (el más antiguo
-- primero). De qué cajas salieron esas larvas, sus edades y su generación los
-- calcula la app con ese orden; aquí queda la generación que la app propuso y
-- el operario confirmó para la jaula: la de las larvas + 1.
create table if not exists app.ingreso (
  id                  uuid primary key,
  jaula_id            uuid not null references app.jaula(id),
  fecha               timestamptz not null,
  kg_larvas           numeric(10,3) not null check (kg_larvas > 0),
  generacion          int  not null check (generacion >= 1),
  nota                text not null default '',
  foto_key            text,
  editado_at          timestamptz,
  editado_por         text,
  valores_editados_at timestamptz,
  revisado_at         timestamptz,
  registrado_por      text,
  created_by          uuid,
  dispositivo_id      uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  synced_at           timestamptz not null default now(),
  deleted_at          timestamptz
);
create index if not exists ix_ingreso_jaula on app.ingreso (jaula_id, fecha);

-- Bandeja de pupación: 4,7 kg propuestos (larvas + acondicionamiento). Entra a
-- la jaula el mismo día, así que nace inactiva. Código F{gen}-B{ddmm}-{n}, con
-- la generación de sus larvas.
create table if not exists app.bandeja_pupacion (
  id             uuid primary key,
  codigo         text not null,
  ingreso_id     uuid not null references app.ingreso(id),
  jaula_id       uuid not null references app.jaula(id),
  numero         int  not null check (numero > 0),
  rack_id        uuid references app.rack(id),
  peso_kg        numeric(10,3) not null check (peso_kg > 0),
  estado         text not null default 'inactivo' check (estado in ('activo', 'inactivo')),
  cerrado_at     timestamptz,
  cerrado_por    text,
  motivo_cierre  text,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create unique index if not exists ux_bandeja_codigo on app.bandeja_pupacion (codigo) where deleted_at is null;
create index if not exists ix_bandeja_ingreso on app.bandeja_pupacion (ingreso_id);

-- Cierre y limpieza de una jaula.
create table if not exists app.jaula_evento (
  id             uuid primary key,
  jaula_id       uuid not null references app.jaula(id),
  tipo           text not null check (tipo in ('cierre', 'limpieza')),
  fecha          timestamptz not null,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_evento_jaula on app.jaula_evento (jaula_id, fecha);

-- Cambio de rack de una incubadora, una caja o una bandeja. El rack actual es
-- el del último movimiento; sin movimientos, el que tenía al crearse.
create table if not exists app.movimiento (
  id             uuid primary key,
  objeto         text not null check (objeto in ('incubadora', 'caja', 'bandeja_pupacion')),
  objeto_id      uuid not null,
  rack_desde     uuid references app.rack(id),
  rack_hasta     uuid not null references app.rack(id),
  fecha          timestamptz not null,
  nota           text not null default '',
  foto_key       text,
  editado_at     timestamptz,
  editado_por    text,
  valores_editados_at timestamptz,
  revisado_at    timestamptz,
  registrado_por text,
  created_by     uuid,
  dispositivo_id uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now(),
  deleted_at     timestamptz
);
create index if not exists ix_movimiento_objeto on app.movimiento (objeto_id, fecha);


-- ── 8. Estados que se derivan de los registros ──────────────────────────────
-- La app los calcula también por su cuenta; aquí quedan al día para quien
-- consulte la base directamente. Se recalculan con cualquier alta, edición o
-- borrado lógico del registro que los define.

create or replace function app.trg_incubadora_estado()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.dia0 := app.dia_local(new.recolecta_at);
  new.estado := case
    when new.cerrado_at is not null
      or exists (select 1 from app.distribucion d
                  where d.incubadora_id = new.id and d.deleted_at is null) then 'inactivo'
    else 'activo' end;
  return new;
end $$;
drop trigger if exists t_incubadora_estado on app.incubadora;
create trigger t_incubadora_estado before insert or update on app.incubadora
  for each row execute function app.trg_incubadora_estado();

create or replace function app.trg_caja_estado()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.estado := case
    when new.cerrado_at is not null
      or exists (select 1 from app.separacion s
                  where s.caja_id = new.id and s.deleted_at is null) then 'inactivo'
    else 'activo' end;
  return new;
end $$;
drop trigger if exists t_caja_estado on app.caja;
create trigger t_caja_estado before insert or update on app.caja
  for each row execute function app.trg_caja_estado();

create or replace function app.trg_cochada_estado()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.estado := case
    when new.cerrado_at is not null
      or exists (select 1 from app.cochada_lectura l
                  where l.cochada_id = new.id and l.momento = 'final' and l.deleted_at is null) then 'inactivo'
    else 'activo' end;
  return new;
end $$;
drop trigger if exists t_cochada_estado on app.cochada;
create trigger t_cochada_estado before insert or update on app.cochada
  for each row execute function app.trg_cochada_estado();

create or replace function app.trg_ensilado_dia0()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.dia0 := app.dia_local(new.ensilado_at);
  return new;
end $$;
drop trigger if exists t_ensilado_dia0 on app.ensilado;
create trigger t_ensilado_dia0 before insert or update on app.ensilado
  for each row execute function app.trg_ensilado_dia0();

-- Un registro que define el estado de su objeto lo "toca" para que se recalcule.
create or replace function app.trg_tocar_objeto()
returns trigger language plpgsql set search_path = app, public as $$
declare v_id uuid;
begin
  if tg_table_name = 'distribucion' then
    v_id := case when tg_op = 'DELETE' then old.incubadora_id else new.incubadora_id end;
    update app.incubadora set estado = estado where id = v_id;
  elsif tg_table_name = 'separacion' then
    v_id := case when tg_op = 'DELETE' then old.caja_id else new.caja_id end;
    update app.caja set estado = estado where id = v_id;
  elsif tg_table_name = 'cochada_lectura' then
    v_id := case when tg_op = 'DELETE' then old.cochada_id else new.cochada_id end;
    update app.cochada set estado = estado where id = v_id;
  end if;
  return null;
end $$;
drop trigger if exists t_distribucion_objeto on app.distribucion;
create trigger t_distribucion_objeto after insert or update or delete on app.distribucion
  for each row execute function app.trg_tocar_objeto();
drop trigger if exists t_separacion_objeto on app.separacion;
create trigger t_separacion_objeto after insert or update or delete on app.separacion
  for each row execute function app.trg_tocar_objeto();
drop trigger if exists t_lectura_objeto on app.cochada_lectura;
create trigger t_lectura_objeto after insert or update or delete on app.cochada_lectura
  for each row execute function app.trg_tocar_objeto();

-- La jaula: su fase sale del último ingreso / cierre / limpieza vivo; si no hay
-- ninguno, de cómo se registró. Su generación, del último ingreso.
create or replace function app.recalcular_jaula(p_id uuid)
returns void language plpgsql set search_path = app, public as $$
declare
  j app.jaula;
  v_fase text;
  ult_ingreso app.ingreso;
begin
  select * into j from app.jaula where id = p_id;
  if j.id is null then return; end if;

  select x.fase into v_fase from (
    select 'activa'::text as fase, i.fecha, i.created_at
      from app.ingreso i where i.jaula_id = p_id and i.deleted_at is null
    union all
    select case e.tipo when 'cierre' then 'cerrada' else 'limpia' end, e.fecha, e.created_at
      from app.jaula_evento e where e.jaula_id = p_id and e.deleted_at is null
  ) x order by x.fecha desc, x.created_at desc limit 1;

  select * into ult_ingreso from app.ingreso i
   where i.jaula_id = p_id and i.deleted_at is null
   order by i.fecha desc, i.created_at desc limit 1;

  update app.jaula set
    fase        = coalesce(v_fase, j.fase_inicial),
    generacion  = coalesce(ult_ingreso.generacion, j.generacion_inicial),
    ciclo_desde = case when ult_ingreso.id is null then null else app.dia_local(ult_ingreso.fecha) end
  where id = p_id;
end $$;

create or replace function app.trg_jaula_alta()
returns trigger language plpgsql set search_path = app, public as $$
begin
  new.fase := new.fase_inicial;
  new.generacion := new.generacion_inicial;
  return new;
end $$;
drop trigger if exists t_jaula_alta on app.jaula;
create trigger t_jaula_alta before insert on app.jaula
  for each row execute function app.trg_jaula_alta();

create or replace function app.trg_jaula_inicial()
returns trigger language plpgsql set search_path = app, public as $$
begin
  perform app.recalcular_jaula(new.id);
  return null;
end $$;
drop trigger if exists t_jaula_inicial on app.jaula;
create trigger t_jaula_inicial after update on app.jaula
  for each row
  when (old.fase_inicial is distinct from new.fase_inicial
        or old.generacion_inicial is distinct from new.generacion_inicial)
  execute function app.trg_jaula_inicial();

create or replace function app.trg_tocar_jaula()
returns trigger language plpgsql set search_path = app, public as $$
begin
  if tg_op = 'DELETE' then
    perform app.recalcular_jaula(old.jaula_id);
  else
    perform app.recalcular_jaula(new.jaula_id);
  end if;
  return null;
end $$;
drop trigger if exists t_ingreso_jaula on app.ingreso;
create trigger t_ingreso_jaula after insert or update or delete on app.ingreso
  for each row execute function app.trg_tocar_jaula();
drop trigger if exists t_evento_jaula on app.jaula_evento;
create trigger t_evento_jaula after insert or update or delete on app.jaula_evento
  for each row execute function app.trg_tocar_jaula();


-- ── 9. Acciones de varias filas: juntas o ninguna ───────────────────────────
-- Cada una valida su entrada ANTES de escribir (llamarla vacía no escribe
-- nada), y repetirla con los mismos datos no duplica nada.

-- Tamizado, pesado y distribución: la distribución, sus cajas y la carga 1.
create or replace function app.distribuir(p_distribucion jsonb, p_cajas jsonb, p_cargas jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_distribucion->>'id', '')::uuid;
  v_inc uuid := nullif(p_distribucion->>'incubadora_id', '')::uuid;
  v_por text := nullif(p_distribucion->>'registrado_por', '');
  inc   app.incubadora;
begin
  if v_id is null or v_inc is null or nullif(p_distribucion->>'fecha', '') is null
     or nullif(p_distribucion->>'peso_total_kg', '') is null
     or p_cajas is null or jsonb_typeof(p_cajas) <> 'array' or jsonb_array_length(p_cajas) = 0 then
    raise exception 'distribución incompleta' using errcode = '22023';
  end if;

  select * into inc from app.incubadora where id = v_inc and deleted_at is null;
  if inc.id is null then
    raise exception 'la incubadora % no existe en el servidor', v_inc using errcode = '23503';
  end if;
  if exists (select 1 from app.distribucion where id = v_id) then
    return;                                   -- la misma distribución otra vez
  end if;
  if exists (select 1 from app.distribucion where incubadora_id = v_inc and deleted_at is null) then
    raise exception 'La incubadora % ya fue distribuida desde otro teléfono.', inc.codigo
      using errcode = '23505';
  end if;

  insert into app.distribucion (id, incubadora_id, fecha, peso_total_kg, nota,
                                registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, v_inc, (p_distribucion->>'fecha')::timestamptz,
          (p_distribucion->>'peso_total_kg')::numeric, coalesce(p_distribucion->>'nota', ''),
          v_por, nullif(p_distribucion->>'created_by', '')::uuid,
          nullif(p_distribucion->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_distribucion->>'created_at', '')::timestamptz, now()));

  insert into app.caja (id, codigo, incubadora_id, distribucion_id, numero, rack_id, peso_inicial_kg,
                        nota, registrado_por, created_by, dispositivo_id, created_at)
  select (c->>'id')::uuid, c->>'codigo', v_inc, v_id, (c->>'numero')::int,
         nullif(c->>'rack_id', '')::uuid, (c->>'peso_inicial_kg')::numeric,
         coalesce(c->>'nota', ''), coalesce(nullif(c->>'registrado_por', ''), v_por),
         nullif(c->>'created_by', '')::uuid, nullif(c->>'dispositivo_id', '')::uuid,
         coalesce(nullif(c->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_cajas) c
  on conflict (id) do nothing;

  insert into app.alimentacion (id, caja_id, carga, fecha, kg, kg_plan, dia_plan, nota,
                                registrado_por, created_by, dispositivo_id, created_at)
  select (a->>'id')::uuid, (a->>'caja_id')::uuid, (a->>'carga')::int,
         (a->>'fecha')::timestamptz, (a->>'kg')::numeric,
         nullif(a->>'kg_plan', '')::numeric, nullif(a->>'dia_plan', '')::int,
         coalesce(a->>'nota', ''), coalesce(nullif(a->>'registrado_por', ''), v_por),
         nullif(a->>'created_by', '')::uuid, nullif(a->>'dispositivo_id', '')::uuid,
         coalesce(nullif(a->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_cargas, '[]'::jsonb)) a
  on conflict (id) do nothing;
end $$;

-- Cochada: la cochada y de qué separaciones sale.
create or replace function app.crear_cochada(p_cochada jsonb, p_origenes jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_cochada->>'id', '')::uuid;
  v_por text := nullif(p_cochada->>'registrado_por', '');
begin
  if v_id is null or nullif(p_cochada->>'codigo', '') is null
     or nullif(p_cochada->>'horno_at', '') is null or nullif(p_cochada->>'peso_inicial_kg', '') is null
     or p_origenes is null or jsonb_typeof(p_origenes) <> 'array' or jsonb_array_length(p_origenes) = 0 then
    raise exception 'cochada incompleta' using errcode = '22023';
  end if;
  if exists (select 1 from app.cochada where id = v_id) then return; end if;

  insert into app.cochada (id, codigo, horno_at, peso_inicial_kg, nota,
                           registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, p_cochada->>'codigo', (p_cochada->>'horno_at')::timestamptz,
          (p_cochada->>'peso_inicial_kg')::numeric, coalesce(p_cochada->>'nota', ''),
          v_por, nullif(p_cochada->>'created_by', '')::uuid,
          nullif(p_cochada->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_cochada->>'created_at', '')::timestamptz, now()));

  insert into app.cochada_origen (id, cochada_id, separacion_id, kg, nota,
                                  registrado_por, created_by, dispositivo_id, created_at)
  select (o->>'id')::uuid, v_id, (o->>'separacion_id')::uuid, (o->>'kg')::numeric,
         coalesce(o->>'nota', ''), coalesce(nullif(o->>'registrado_por', ''), v_por),
         nullif(o->>'created_by', '')::uuid, nullif(o->>'dispositivo_id', '')::uuid,
         coalesce(nullif(o->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_origenes) o
  on conflict (id) do nothing;
end $$;

-- Ingreso al insectario: el ingreso y sus bandejas de pupación. Sólo en una
-- jaula cerrada y limpia: si otro teléfono ya la repobló, se rechaza.
create or replace function app.ingresar(p_ingreso jsonb, p_bandejas jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id    uuid := nullif(p_ingreso->>'id', '')::uuid;
  v_jaula uuid := nullif(p_ingreso->>'jaula_id', '')::uuid;
  v_por   text := nullif(p_ingreso->>'registrado_por', '');
  j       app.jaula;
begin
  if v_id is null or v_jaula is null or nullif(p_ingreso->>'fecha', '') is null
     or nullif(p_ingreso->>'kg_larvas', '') is null or nullif(p_ingreso->>'generacion', '') is null
     or p_bandejas is null or jsonb_typeof(p_bandejas) <> 'array' or jsonb_array_length(p_bandejas) = 0 then
    raise exception 'ingreso incompleto' using errcode = '22023';
  end if;
  select * into j from app.jaula where id = v_jaula and deleted_at is null;
  if j.id is null then
    raise exception 'la jaula % no existe en el servidor', v_jaula using errcode = '23503';
  end if;
  if exists (select 1 from app.ingreso where id = v_id) then return; end if;
  if j.fase <> 'limpia' then
    raise exception 'La jaula % no está lista para repoblar: %.', j.nombre,
      case j.fase when 'activa' then 'ya está poblada' else 'falta la limpieza' end
      using errcode = '23514';
  end if;

  insert into app.ingreso (id, jaula_id, fecha, kg_larvas, generacion, nota,
                           registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, v_jaula, (p_ingreso->>'fecha')::timestamptz, (p_ingreso->>'kg_larvas')::numeric,
          (p_ingreso->>'generacion')::int, coalesce(p_ingreso->>'nota', ''),
          v_por, nullif(p_ingreso->>'created_by', '')::uuid,
          nullif(p_ingreso->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_ingreso->>'created_at', '')::timestamptz, now()));

  insert into app.bandeja_pupacion (id, codigo, ingreso_id, jaula_id, numero, rack_id,
                                    peso_kg, nota, registrado_por, created_by, dispositivo_id, created_at)
  select (b->>'id')::uuid, b->>'codigo', v_id, v_jaula, (b->>'numero')::int,
         nullif(b->>'rack_id', '')::uuid,
         (b->>'peso_kg')::numeric, coalesce(b->>'nota', ''),
         coalesce(nullif(b->>'registrado_por', ''), v_por),
         nullif(b->>'created_by', '')::uuid, nullif(b->>'dispositivo_id', '')::uuid,
         coalesce(nullif(b->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_bandejas) b
  on conflict (id) do nothing;
end $$;

-- Ensilado: el ensilado y qué recepciones entran, con sus kg.
create or replace function app.crear_ensilado(p_ensilado jsonb, p_insumos jsonb)
returns void language plpgsql set search_path = app, public as $$
declare
  v_id  uuid := nullif(p_ensilado->>'id', '')::uuid;
  v_por text := nullif(p_ensilado->>'registrado_por', '');
begin
  if v_id is null or nullif(p_ensilado->>'codigo', '') is null
     or nullif(p_ensilado->>'contenedor_id', '') is null or nullif(p_ensilado->>'ensilado_at', '') is null
     or p_insumos is null or jsonb_typeof(p_insumos) <> 'array' or jsonb_array_length(p_insumos) = 0 then
    raise exception 'ensilado incompleto' using errcode = '22023';
  end if;
  if exists (select 1 from app.ensilado where id = v_id) then return; end if;

  insert into app.ensilado (id, codigo, contenedor_id, ensilado_at, dia0, nota,
                            registrado_por, created_by, dispositivo_id, created_at)
  values (v_id, p_ensilado->>'codigo', (p_ensilado->>'contenedor_id')::uuid,
          (p_ensilado->>'ensilado_at')::timestamptz, app.dia_local((p_ensilado->>'ensilado_at')::timestamptz),
          coalesce(p_ensilado->>'nota', ''), v_por,
          nullif(p_ensilado->>'created_by', '')::uuid, nullif(p_ensilado->>'dispositivo_id', '')::uuid,
          coalesce(nullif(p_ensilado->>'created_at', '')::timestamptz, now()));

  insert into app.ensilado_insumo (id, ensilado_id, recepcion_id, kg, nota,
                                   registrado_por, created_by, dispositivo_id, created_at)
  select (i->>'id')::uuid, v_id, (i->>'recepcion_id')::uuid, (i->>'kg')::numeric,
         coalesce(i->>'nota', ''), coalesce(nullif(i->>'registrado_por', ''), v_por),
         nullif(i->>'created_by', '')::uuid, nullif(i->>'dispositivo_id', '')::uuid,
         coalesce(nullif(i->>'created_at', '')::timestamptz, now())
    from jsonb_array_elements(p_insumos) i
  on conflict (id) do nothing;
end $$;

-- Apertura del ensilado (el primero que llega gana; repetirla no cambia nada).
create or replace function app.abrir_ensilado(p_id uuid, p_at timestamptz, p_por text default null)
returns void language plpgsql set search_path = app, public as $$
begin
  update app.ensilado
     set abierto_at = coalesce(p_at, now()), abierto_por = nullif(p_por, '')
   where id = p_id and abierto_at is null;
end $$;

-- Cierre antes de tiempo (pérdida, contaminación…), con el motivo escrito.
create or replace function app.cerrar_objeto(p_tabla text, p_id uuid, p_motivo text,
                                             p_at timestamptz default null, p_por text default null)
returns void language plpgsql set search_path = app, public as $$
begin
  if p_tabla not in ('incubadora', 'caja', 'bandeja_pupacion', 'cochada') then
    raise exception 'no se puede cerrar %', p_tabla using errcode = '22023';
  end if;
  if nullif(trim(coalesce(p_motivo, '')), '') is null then
    raise exception 'falta el motivo del cierre' using errcode = '22023';
  end if;
  execute format(
    'update app.%I set cerrado_at = coalesce($1, now()), cerrado_por = nullif($2, ''''), motivo_cierre = $3
      where id = $4 and cerrado_at is null', p_tabla)
    using p_at, p_por, trim(p_motivo), p_id;
end $$;

-- Editar un registro: valores y fechas, nota y foto. Queda quién editó por
-- última vez y cuándo. Sólo los campos de la lista de cada tabla.
-- valores_editados_at cambia sólo si cambió un valor o una fecha (no una nota
-- o una foto): es lo que hace que los registros que dependían de este se
-- marquen «revisar».
create or replace function app.editar(p_tabla text, p_id uuid, p_cambios jsonb,
                                      p_por text default null, p_at timestamptz default null)
returns void language plpgsql set search_path = app, public as $$
declare
  permitidos text[];
  k          text;
  sets       text[] := array[]::text[];
  solo_notas boolean := true;
begin
  permitidos := case p_tabla
    when 'rack'             then array['codigo', 'nota', 'foto_key']
    when 'contenedor'       then array['codigo', 'nota', 'foto_key']
    when 'jaula'            then array['nombre', 'letra', 'lugar', 'generacion_inicial', 'fase_inicial', 'nota', 'foto_key']
    when 'recepcion'        then array['fecha', 'material', 'kg', 'nota', 'foto_key']
    when 'ensilado'         then array['ensilado_at', 'abierto_at', 'nota', 'foto_key']
    when 'ensilado_insumo'  then array['kg', 'nota', 'foto_key']
    when 'incubadora'       then array['jaula_id', 'generacion', 'recolecta_at', 'rack_id', 'peso_inicial_g',
                                       'alimento_inicial_kg', 'nota', 'foto_key']
    when 'distribucion'     then array['fecha', 'peso_total_kg', 'nota', 'foto_key']
    when 'caja'             then array['rack_id', 'peso_inicial_kg', 'nota', 'foto_key']
    when 'chequeo'          then array['fecha', 'humedad_pct', 'temperatura_c', 'peso_g', 'peso_kg', 'nota', 'foto_key']
    when 'alimentacion'     then array['fecha', 'kg', 'nota', 'foto_key']
    when 'separacion'       then array['fecha', 'peso_total_kg', 'nota', 'foto_key']
    when 'cochada'          then array['horno_at', 'peso_inicial_kg', 'nota', 'foto_key']
    when 'cochada_origen'   then array['kg', 'nota', 'foto_key']
    when 'cochada_lectura'  then array['fecha', 'temperatura_c', 'peso_kg', 'nota', 'foto_key']
    when 'ingreso'          then array['fecha', 'kg_larvas', 'generacion', 'nota', 'foto_key']
    when 'bandeja_pupacion' then array['rack_id', 'peso_kg', 'nota', 'foto_key']
    when 'jaula_evento'     then array['fecha', 'nota', 'foto_key']
    when 'movimiento'       then array['fecha', 'rack_hasta', 'nota', 'foto_key']
  end;
  if permitidos is null then
    raise exception 'no se puede editar %', p_tabla using errcode = '22023';
  end if;
  if p_cambios is null or jsonb_typeof(p_cambios) <> 'object' or p_cambios = '{}'::jsonb then
    raise exception 'edición vacía' using errcode = '22023';
  end if;

  for k in select jsonb_object_keys(p_cambios) loop
    if not (k = any (permitidos)) then
      raise exception 'el campo % no se puede editar en %', k, p_tabla using errcode = '22023';
    end if;
    if k not in ('nota', 'foto_key') then solo_notas := false; end if;
    sets := sets || format('%I = r.%I', k, k);
  end loop;
  sets := sets || array['editado_at = coalesce($2, now())', 'editado_por = nullif($3, '''')'];
  if not solo_notas then
    sets := sets || array['valores_editados_at = coalesce($2, now())'];
  end if;

  execute format(
    'update app.%I t set %s from jsonb_populate_record(null::app.%I, $1) r where t.id = $4',
    p_tabla, array_to_string(sets, ', '), p_tabla)
    using p_cambios, p_at, p_por, p_id;
end $$;

-- «Revisado»: quien revisó un registro marcado «revisar» lo confirma. No es
-- una edición, así que no marca a su vez los registros que dependen de él.
create or replace function app.marcar_revisado(p_tabla text, p_id uuid,
                                               p_at timestamptz default null, p_por text default null)
returns void language plpgsql set search_path = app, public as $$
begin
  if p_tabla not in ('incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion', 'separacion',
                     'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso', 'bandeja_pupacion',
                     'jaula', 'jaula_evento', 'movimiento', 'recepcion', 'ensilado', 'ensilado_insumo') then
    raise exception 'no se puede revisar %', p_tabla using errcode = '22023';
  end if;
  execute format('update app.%I set revisado_at = coalesce($1, now()) where id = $2', p_tabla)
    using p_at, p_id;
end $$;


-- ── 10. Mantenimiento, acceso ───────────────────────────────────────────────

do $$
declare t text;
begin
  foreach t in array array[
    'catalogo', 'parametro', 'rack', 'contenedor', 'jaula', 'recepcion', 'ensilado',
    'ensilado_insumo', 'incubadora', 'distribucion', 'caja', 'chequeo', 'alimentacion',
    'separacion', 'cochada', 'cochada_origen', 'cochada_lectura', 'ingreso',
    'bandeja_pupacion', 'jaula_evento', 'movimiento'
  ] loop
    -- Lo que la sincronización recorre: updated_at, y el id para desempatar.
    execute format('create index if not exists %I on app.%I (updated_at, id)', 'ix_' || t || '_updated', t);
    execute format('drop trigger if exists %I on app.%I', 't_' || t || '_touch', t);
    execute format('create trigger %I before update on app.%I for each row execute function app.touch_updated_at()',
                   't_' || t || '_touch', t);
    execute format('alter table app.%I enable row level security', t);
    execute format('drop policy if exists demo_abierto on app.%I', t);
    execute format('create policy demo_abierto on app.%I for all to anon, authenticated using (true) with check (true)', t);
  end loop;
end $$;

grant usage on schema app to anon, authenticated, service_role;
grant all on all tables    in schema app to anon, authenticated, service_role;
grant all on all routines  in schema app to anon, authenticated, service_role;
grant all on all sequences in schema app to anon, authenticated, service_role;
alter default privileges in schema app grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema app grant all on routines  to anon, authenticated, service_role;
alter default privileges in schema app grant all on sequences to anon, authenticated, service_role;


-- ── 11. Datos de partida ────────────────────────────────────────────────────

insert into app.parametro (clave, valor, descripcion) values
  ('dia_chequeo_incubadora', '3',
     'Día del chequeo de la incubadora (días desde la recolecta).'),
  ('dia_distribucion', '7',
     'Día del tamizado, pesado y distribución en cajas de engorde.'),
  ('dias_chequeo_caja', '[10, 14]',
     'Días de los chequeos de las cajas de engorde. El último inicia el ayuno.'),
  ('cargas', '[{"n":1,"dia":7,"kg":1.5},{"n":2,"dia":10,"kg":2},{"n":3,"dia":13,"kg":2}]',
     'Cargas de alimento de cada caja: número, día y kg que propone la app.'),
  ('dia_inicio_ayuno', '14',
     'Día en que empieza el ayuno (con su chequeo). No se alimenta hasta la separación.'),
  ('dia_separacion', '16',
     'Día previsto de la separación (orientativo).'),
  ('pct_coccion', '98',
     'Porcentaje de la separación que va al horno; el resto vuelve al insectario.'),
  ('kg_bandeja_pupacion', '4.7',
     'Peso que la app propone para cada bandeja de pupación (larvas + acondicionamiento).'),
  ('dias_ciclo_jaula', '14',
     'Días de un ciclo de insectario, del repoblado al cierre (orientativo).'),
  ('dias_recolecta', '[1, 3, 5]',
     'Días de la semana de la recolecta: 1 = lunes … 7 = domingo.'),
  ('dias_maduracion', '21',
     'Días de maduración de un ensilado; se abre ese día.'),
  ('horas_consumo', '72',
     'Horas para consumir un ensilado desde que se abre; lo que sobra se da por descartado.'),
  ('alimento_inicial_incubadora_kg', 'null',
     'Kg de alimento inicial que la app propone en cada recolecta. POR DEFINIR antes del arranque.')
on conflict (clave) do nothing;

insert into app.catalogo (id, tipo, valor, orden) values
  (gen_random_uuid(), 'material_alimento', 'Bagazo de cerveza (BSG)', 1),
  (gen_random_uuid(), 'material_alimento', 'Desecho de panadería',    2),
  (gen_random_uuid(), 'material_alimento', 'Desecho de fruta',        3),
  (gen_random_uuid(), 'material_alimento', 'Otro',                    4)
on conflict (tipo, valor) do nothing;

-- Las personas: las del protocolo anterior, con sus mismos ids (los teléfonos
-- ya las conocen así); en una base nueva, las de siempre.
do $$
begin
  if to_regclass('pg_temp._operarios') is not null then
    insert into app.catalogo (id, tipo, valor, orden, activo)
    select id, 'operario', valor, orden, activo from _operarios
    on conflict do nothing;
    drop table _operarios;
  end if;
  if not exists (select 1 from app.catalogo where tipo = 'operario') then
    insert into app.catalogo (id, tipo, valor, orden) values
      (gen_random_uuid(), 'operario', 'Maria',   1),
      (gen_random_uuid(), 'operario', 'Ricardo', 2)
    on conflict (tipo, valor) do nothing;
  end if;
end $$;


-- ── 12. Fotos ───────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public;

drop policy if exists fotos_todo on storage.objects;
create policy fotos_todo on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'fotos') with check (bucket_id = 'fotos');


-- ── 13. Historial de AppSheet (sólo consulta, la app no lo usa) ─────────────
-- Vacío por ahora. Se llena desde la exportación CSV de la hoja con
-- `node tools/csv-to-staging.mjs`. No se expone a la API: se consulta desde el
-- panel de Supabase.

create schema if not exists historico;
comment on schema historico is
  'Historial de AppSheet, sólo para consulta. La app no lo usa ni lo expone.';


-- PostgREST: que lea el esquema nuevo ya.
notify pgrst, 'reload schema';
