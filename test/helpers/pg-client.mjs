/**
 * A supabase-js-shaped client over PGlite — the calls the app and the tools make.
 *
 * It exists so a push test fails the way production would: an RPC name that
 * the SQL no longer defines comes back as PGRST202, a renamed argument is a
 * "function does not exist", a foreign key is a real 23503, and a privilege the
 * public key does not have is a real 42501. A hand-written stub that answers
 * "ok" to whatever it is given proves nothing.
 *
 * Mirrors PostgREST where it matters here:
 *   - everything runs AS THE anon ROLE, like a call with the public key, so the
 *     grants, the policies and the invoker's rights in triggers all apply;
 *   - rpc(name, args)  calls the function with NAMED arguments, so a stale
 *     argument name (p_cochada) fails exactly as it would over HTTP;
 *   - from(t).upsert(row, { onConflict, ignoreDuplicates }) inserts only the
 *     columns present, `on conflict (...) do nothing`.
 */
import { comoAnon } from './pg.mjs';

const ident = s => {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`identificador no válido: ${s}`);
  return s;
};

/** A JS value as the text form Postgres can cast to the parameter's type.
 *  PostgREST sends JSON: a json/jsonb parameter gets JSON even for an array;
 *  only a real array type (uuid[]) gets an array literal. */
function asText(v, type = '') {
  if (v === null || v === undefined) return null;
  if (/^jsonb?$/.test(type)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '{' + v.map(x => x === null ? 'NULL' : `"${String(x).replace(/["\\]/g, m => '\\' + m)}"`).join(',') + '}';
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const pgErr = e => ({ message: e.message, code: e.code || null, details: e.detail || null });

export function pgClient(db, { schema = 'app' } = {}) {
  const calls = [];

  return {
    calls,

    from(table) {
      return {
        /**
         * select('*' | 'a, b') with eq / gt / in / order / limit, awaited like
         * supabase-js. A column that does not exist is a real error. Rows come
         * back as `to_jsonb`, i.e. with timestamps in the same text form
         * PostgREST sends (microseconds and an offset) — that exact form is what
         * the pull pages on.
         */
        select(cols = '*') {
          const where = [], params = [], order = [];
          let limit = null;
          const campos = cols.trim() === '*' ? 'to_jsonb(t)'
            : `jsonb_build_object(${cols.split(',').map(c => `'${ident(c.trim())}', t.${ident(c.trim())}`).join(', ')})`;
          const run = async () => {
            calls.push({ kind: 'select', table, where: [...where] });
            try {
              const sql = `select ${campos} as j from ${ident(schema)}.${ident(table)} t`
                + (where.length ? ` where ${where.join(' and ')}` : '')
                + (order.length ? ` order by ${order.join(', ')}` : '')
                + (limit !== null ? ` limit ${Number(limit)}` : '');
              const res = await comoAnon(db, tx => tx.query(sql, params));
              return { data: res.rows.map(r => r.j), error: null };
            } catch (e) {
              return { data: null, error: pgErr(e) };
            }
          };
          const b = {
            eq(c, v) { params.push(v); where.push(`t.${ident(c)} = $${params.length}`); return b; },
            gt(c, v) { params.push(v); where.push(`t.${ident(c)} > $${params.length}`); return b; },
            in(c, vs) { params.push(vs.map(String)); where.push(`t.${ident(c)}::text = any($${params.length}::text[])`); return b; },
            order(c, { ascending = true } = {}) { order.push(`t.${ident(c)} ${ascending ? 'asc' : 'desc'}`); return b; },
            limit(n) { limit = n; return b; },
            then(ok, ko) { return run().then(ok, ko); }
          };
          return b;
        },

        /** insert(row | rows): only the columns present, like PostgREST. */
        async insert(row) {
          calls.push({ kind: 'insert', table, row });
          try {
            await comoAnon(db, async tx => {
              for (const r of Array.isArray(row) ? row : [row]) {
                const cols = Object.keys(r).map(ident);
                await tx.query(
                  `insert into ${ident(schema)}.${ident(table)} (${cols.join(', ')})
                   select ${cols.join(', ')} from jsonb_populate_record(null::${ident(schema)}.${ident(table)}, $1::jsonb)`,
                  [JSON.stringify(r)]);
              }
            });
            return { data: null, error: null };
          } catch (e) {
            return { data: null, error: pgErr(e) };
          }
        },

        /** update(values).eq(…) / .in(…), awaited like supabase-js. */
        update(values) {
          const where = [], params = [JSON.stringify(values)];
          const run = async () => {
            calls.push({ kind: 'update', table, values });
            try {
              const sets = Object.keys(values).map(c => `${ident(c)} = r.${ident(c)}`).join(', ');
              await comoAnon(db, tx => tx.query(
                `update ${ident(schema)}.${ident(table)} t set ${sets}
                   from jsonb_populate_record(null::${ident(schema)}.${ident(table)}, $1::jsonb) r
                  where ${where.join(' and ') || 'false'}`, params));
              return { data: null, error: null };
            } catch (e) {
              return { data: null, error: pgErr(e) };
            }
          };
          const b = {
            eq(c, v) { params.push(v); where.push(`t.${ident(c)} = $${params.length}`); return b; },
            in(c, vs) { params.push(vs.map(String)); where.push(`t.${ident(c)}::text = any($${params.length}::text[])`); return b; },
            is(c, v) { if (v === null) where.push(`t.${ident(c)} is null`); return b; },
            then(ok, ko) { return run().then(ok, ko); }
          };
          return b;
        },

        /** delete().eq(…) / .in(…): a refused DELETE is a real 42501 (0011), not
         *  the owner quietly deleting. */
        delete() {
          const where = [], params = [];
          const run = async () => {
            calls.push({ kind: 'delete', table, where: [...where] });
            try {
              await comoAnon(db, tx =>
                tx.query(`delete from ${ident(schema)}.${ident(table)} t where ${where.join(' and ') || 'false'}`, params));
              return { data: null, error: null };
            } catch (e) {
              return { data: null, error: pgErr(e) };
            }
          };
          const b = {
            eq(c, v) { params.push(v); where.push(`t.${ident(c)} = $${params.length}`); return b; },
            in(c, vs) { params.push(vs.map(String)); where.push(`t.${ident(c)}::text = any($${params.length}::text[])`); return b; },
            then(ok, ko) { return run().then(ok, ko); }
          };
          return b;
        },

        // push.js always sends ignoreDuplicates: true, so only `do nothing` is modelled.
        async upsert(row, { onConflict = 'id' } = {}) {
          calls.push({ kind: 'upsert', table, row });
          try {
            await comoAnon(db, async tx => {
              for (const r of Array.isArray(row) ? row : [row]) {
                const cols = Object.keys(r).map(ident);
                const target = onConflict.split(',').map(s => ident(s.trim())).join(', ');
                await tx.query(
                  `insert into ${ident(schema)}.${ident(table)} (${cols.join(', ')})
                   select ${cols.join(', ')}
                     from jsonb_populate_record(null::${ident(schema)}.${ident(table)}, $1::jsonb)
                   on conflict (${target}) do nothing`,
                  [JSON.stringify(r)]);
              }
            });
            return { data: null, error: null };
          } catch (e) {
            return { data: null, error: pgErr(e) };
          }
        }
      };
    },

    async rpc(name, args = {}) {
      calls.push({ kind: 'rpc', name, args });
      const sigs = (await db.query(
        `select p.proargnames as names,
                array(select format_type(t, null) from unnest(p.proargtypes::oid[]) t) as types
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = $1 and p.proname = $2`, [schema, name])).rows;

      // What PostgREST answers when the schema cache has no such function.
      if (!sigs.length) {
        return { data: null, error: { code: 'PGRST202', status: 404,
          message: `Could not find the function ${schema}.${name} in the schema cache` } };
      }

      const keys = Object.keys(args);
      const sig = sigs.find(s => keys.every(k => (s.names || []).includes(k)));
      if (!sig) {
        return { data: null, error: { code: 'PGRST202', status: 404,
          message: `Could not find the function ${schema}.${name}(${keys.join(', ')}) in the schema cache` } };
      }

      const typeOf = k => sig.types[sig.names.indexOf(k)];
      const named = keys.map((k, i) => `${ident(k)} => $${i + 1}::text::${typeOf(k)}`);
      try {
        const res = await comoAnon(db, tx => tx.query(
          `select ${ident(schema)}.${ident(name)}(${named.join(', ')}) as r`,
          keys.map(k => asText(args[k], typeOf(k)))));
        return { data: res.rows[0]?.r ?? null, error: null };
      } catch (e) {
        return { data: null, error: pgErr(e) };
      }
    },

    auth: {
      async getSession() { return { data: { session: null } }; },
      async refreshSession() { return { data: { session: null }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
    },
    storage: { from: () => ({ upload: async () => ({ error: null }), remove: async () => ({ error: null }) }) }
  };
}
