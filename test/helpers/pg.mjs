/**
 * A real Postgres for tests: PGlite (Postgres compiled to WASM), plus the
 * minimum of Supabase that the migrations touch.
 *
 * Before this existed, SQL was only ever checked for SYNTAX. That missed
 * everything that actually broke production: a PL/pgSQL body still naming a
 * renamed table, a "create or replace" that silently added a second overload,
 * and a setup file that fails on its first line when run twice. Every one of
 * those only shows up when the SQL runs.
 */
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Just enough of Supabase for the migrations to apply: the three API roles,
 * auth.uid()/auth.jwt(), and the storage tables 0003 writes to. Deliberately
 * NOT a Supabase emulator — it exists so the SQL can run, not to test RLS.
 */
const SUPABASE_SHIM = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema auth;
  create table auth.users (
    id uuid primary key,
    is_anonymous boolean default false,
    raw_app_meta_data jsonb default '{}'::jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
  create function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;

  create schema storage;
  create table storage.buckets (
    id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]
  );
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text
  );
  alter table storage.objects enable row level security;
`;

export async function freshPg() {
  const db = new PGlite({ extensions: { uuid_ossp, pgcrypto } });
  await db.exec(SUPABASE_SHIM);
  return db;
}

export const readSql = rel => readFile(path.join(ROOT, rel), 'utf8');

/** A migration exactly as it was at a given commit — i.e. as it was APPLIED. */
export function sqlAt(commit, rel) {
  return execFileSync('git', ['show', `${commit}:${rel}`], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024
  });
}

/**
 * The live database as it actually exists: SETUP (0001-0003) from the first
 * commit, then 0004 as it was when it was applied — both BEFORE the
 * cochada -> lote rename touched those files.
 */
export const LIVE_BUILT_FROM = 'e929a7c';
export const LIVE_MIGRATIONS = [
  'supabase/migrations/0001_schema.sql',
  'supabase/migrations/0002_views.sql',
  'supabase/migrations/0003_seed.sql',
  'supabase/migrations/0004_atribucion_acciones.sql'
];

export async function liveReplica() {
  const db = await freshPg();
  for (const f of LIVE_MIGRATIONS) await db.exec(sqlAt(LIVE_BUILT_FROM, f));
  return db;
}

/** Every overload of a function in schema app, as "name(argtypes)". */
export async function overloads(db, name) {
  const r = await db.query(`
    select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = $1
     order by 1`, [name]);
  return r.rows.map(x => x.sig);
}

export async function tableExists(db, name) {
  const r = await db.query(
    `select 1 from information_schema.tables where table_schema = 'app' and table_name = $1`, [name]);
  return r.rows.length > 0;
}
