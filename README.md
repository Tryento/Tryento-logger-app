# TryEnto — Registro de Producción

Offline-first production logger for a black soldier fly farm. Replaces an
AppSheet app backed by a single Google Sheet.

Operators record the whole pipeline from a phone, in a shed, with no signal:
colonies → egg harvests → rearing trays → feeding / inspection / fasting →
harvest → oven runs → packing → dispatch. Everything is captured locally and
syncs to Postgres when a connection appears.

---

## Why it was rebuilt

The old app worked, but its storage layer made three failures unavoidable, all
of them visible in the live data:

| Problem | What it cost |
|---|---|
| State was **inferred** from blank cells (`ISBLANK([Related Separacions])`) | The active/archive view was silently wrong for months. Every tray since March 2026 still showed as active. |
| `Ayuno` had **no link to a tray** | Fasting data could not be attributed to anything, so `merma_pct` was meaningless. |
| A deviation formula read a blank date as the epoch | Values like **−20,676 days** sitting in the sheet. |

Plus a bulk-feed automation whose `LOOKUP(MAXROW(...))` race wrote ~20 rows with
a valid tray reference but blank date, type and quantity.

Every one of those is structural. They are fixed here by construction, not by
being more careful.

---

## Quick start

```bash
npm install
npm run vendor    # self-host React, Supabase, fonts; generate PWA icons
npm run build     # -> dist/   (the only thing that gets published)
npm run serve     # http://localhost:8137
npm run check     # tests + UI binding checks + SQL syntax
```

The app runs immediately with **no backend configured** — fully functional
against IndexedDB, it just never syncs. That is the intended behaviour for a
demo and for a misconfigured deploy: a missing setting must never cost an
operator their day's work.

Once Supabase is configured, `npm run check:backend` writes a real colony →
tray → feeding → fast → harvest → oven run to it, verifies the computed values
and the state machine, and deletes everything it created. Run it before
trusting the database.

To connect it to Supabase, fill in [`app-config.js`](app-config.js) and apply
the migrations in [`supabase/migrations/`](supabase/migrations/) in order.

**Deploying to Netlify → [DEPLOY.md](DEPLOY.md).** Read its first section before
putting real data behind a no-login URL.

> `npm run build` publishes an explicit allow-list into `dist/` and **fails** if
> anything matching `*.csv` or `*.sql` lands there. Publishing the repo root
> would expose `migration/csv/` — the farm's exported production data.

---

## How it is put together

```
index.html  (built from "BSF Production Log.dc.html")
   │
   ├── support.js          generated DC runtime — DO NOT EDIT
   ├── vendor/             React, ReactDOM, supabase-js, self-hosted
   ├── fonts/              Inter + IBM Plex Mono, self-hosted
   │
   └── dataClient.js       ← THE ONLY SEAM between UI and storage
         └── src/data/
              ├── read.js / write.js      the 28-name public API
              ├── idb/                    IndexedDB: the device's source of truth
              ├── outbox.js               the durable write queue
              ├── sync/{push,pull,blobs,loop}.js
              ├── cache.js                per-tray rollup + local estado
              ├── conflicts.js            writes the server refused
              └── photo.js                capture → downscale → queue
```

**`dataClient.js` keeps the exact public surface the UI already used** — same 28
names, same `{ok, data}` / `{ok, error:{code, message}}` envelope — so swapping
an in-memory mock for an offline-first Supabase client required almost no
changes to the 783-line template.

### The write path

Every write applies locally **and** enqueues for the server in one IndexedDB
transaction, then returns immediately. The operator never waits for a network.

```
tap "Guardar"
  → build row with a CLIENT-generated UUID
  → [ local row + outbox entry ]   ← one transaction, both or neither
  → ok()  ─ screen updates instantly
  → later: push → pull → photos
```

Splitting that transaction is the bug to avoid in both directions: a row without
its queue entry is data that can never reach the server with nothing to say so;
a queue entry without its row makes the operator's entry vanish and get typed
twice.

---

## Design rules

These are invariants. Breaking any one reintroduces something this rebuild exists
to eliminate.

**1. `estado` is a real column, never inferred at read time.**
The mechanism is forced by where the inputs live — it is not a preference:

| Entity | Inputs | Mechanism |
|---|---|---|
| `insectario`, `cochada` | same row | `GENERATED ALWAYS AS … STORED` |
| `bandeja` | other tables (`ayuno`, `separacion`) | trigger — a cross-table generated column is *impossible* in Postgres |

**2. Tray state is monotonic.** `cosechada > en_ayuno > en_crecimiento`, and no
event moves a tray backwards. This is what makes out-of-order offline sync safe:
an `ayuno` that syncs three days late cannot un-harvest a tray.

**3. Deletes are admin-only and online-only, never queued.** A queued
soft-delete of a `separacion` would drag a tray from `cosechada` back to
`en_ayuno` — the exact regression rule 2 prevents, re-entering through the back
door.

**4. Two writes carry cross-row uniqueness that append-only cannot protect:**
`logSeparacion` and `createLote`. Two offline devices both pass the local check
and both sync; Postgres rejects one. The constraints are hard, and the loser
goes to the conflict inbox — **not** softened to `ON CONFLICT DO NOTHING`, which
would silently discard a recorded harvest.

**5. Nothing in the capture path can fail for a reason the operator can't act
on.** There is no login, and `registrado_por` is plain text rather than a
foreign key to a roster — so a write can never be rejected because a device
hasn't synced yet. When real logins arrive, auth will gate *sync*, never
capture: an expired token pauses uploading, it does not put a login wall in
front of someone standing in a shed.

**6. Rows first, photos second.** A 300-byte record must never queue behind a
400 KB image on a rural link.

**7. One poison item never stalls the queue.** Terminal failures are parked in
the conflict inbox and the drain continues. This is the single most common
hand-rolled-sync bug.

**8. The pull cursor overlaps by 5 minutes.** `updated_at` is transaction-*start*
time, so a transaction beginning before the cursor and committing after it writes
rows already in the cursor's past. A bare `> last_sync` loses them permanently,
and nearly invisibly.

---

## Timezone

Every calendar decision resolves against **`America/Caracas`**, never the
device's timezone. A phone left on the wrong zone still writes the correct
farm-local day.

This fixes a live bug. The prototype mixed two clocks:

```js
today() → new Date().toISOString().slice(0,10)   // UTC
ddmm()  → new Date(str + 'T00:00')               // device-local
```

At UTC-4 those disagree after 20:00, so evening entries were stamped with
**tomorrow's date**. Nine months of existing data carry this; the migration
corrects it on import. See [`test/time.test.mjs`](test/time.test.mjs) for the
regression test.

Instants are stored as UTC `Z` — one format everywhere, because lists sort dates
with a plain string compare and a mix of `Z` and `-04:00` would silently
misorder timelines. Calendar facts (`fecha_inicio`, `fecha_vencimiento`) stay
`DATE`; they are days, not instants.

---

## Migrating from the Google Sheet

```bash
# 1. export every tab of Tryento_App_Data as CSV into migration/csv/
npm run migration:csv          # -> migration/generated/01_staging_load.sql
```

Then, in the Supabase SQL editor, in order:

1. `supabase/migrations/0001_schema.sql`
2. `supabase/migrations/0002_views.sql`
3. `supabase/migrations/0003_seed.sql` — **replace the placeholder operator
   names with the real roster first**
4. `migration/generated/01_staging_load.sql`
5. `migration/02_transform.sql` — read its header before running
6. `migration/03_checks.sql` — **read every result**

Three things the migration will surface, all of them findings rather than bugs:

- **`Ayuno` rows have no tray.** They land in `app.ayuno_huerfano`, a quarantine
  the FK and the trigger cannot see, with ranked suggestions for a human to
  confirm. A sentinel "unknown tray" was rejected: it would poison every
  downstream metric and is exactly the infer-from-a-blank failure being removed.
- **`Separacion` and `Lotes` have zero rows.** The back half of the process has
  never been recorded. Yield, FCR and rendimiento have no denominator until new
  data arrives — those views will legitimately be empty.
- **Every historical tray computes to `en_crecimiento`.** Step 12 of the
  transform closes them out with an explicit, attributable `cerrada_admin_at`,
  kept in its own column so `estado` stays a pure function of physical events.

Run the whole migration into a scratch project **twice** and diff the output.
Every id is derived with `uuid_generate_v5`, so it is deterministic and
re-runnable — which you will need, because you will run it more than once.

---

## Analytics

Exposed as SQL views in [`0002_views.sql`](supabase/migrations/0002_views.sql)
so the Streamlit dashboard (`Tryento/Dashboard-demo`) stays thin:

`v_rendimiento_bandeja` · `v_fcr_bandeja` · `v_tiempos_ciclo` ·
`v_productividad_insectario` · `v_rendimiento_cochada` · `v_actividad_operario` ·
`v_consumo_alimento` · `v_calidad_datos`

**Connection model matters.** Streamlit must connect as `analytics_ro` through
**Supavisor in transaction mode** — not the anon key through PostgREST, which
RLS returns zero rows for, and not a direct connection, which will exhaust the
pool PostgREST is also using.

Put `v_calidad_datos` on the dashboard home. It is what turns "the active view
has been wrong for months" into something noticed in a day.

> `v_actividad_operario` is a coaching and workload view, **not** an audit
> record — operator identity is self-asserted from a picker. Say so to the team
> before it goes live, or the quality of what gets logged will quietly drop.

---

## Device provisioning

Each phone must be set up **at the office, online**, before it goes to the field:

1. Sign in with Google (OAuth needs an online redirect — a fresh device in a
   shed has no path to a session)
2. **Install to home screen** — on iOS this is what makes storage persistence
   stick; without it Safari clears site data after 7 days of non-use
3. Confirm persistent storage was granted (the sync screen reports it)
4. Let the first full pull finish
5. Verify the tray list is populated, then go offline and reload to prove the
   shell is cached

Step 2 is not cosmetic. An evicted database takes every unsynced capture with
it, silently.

---

## Testing

```bash
npm run check        # offline: tests, UI bindings, SQL syntax
npm run check:all    # the above, plus both live checks against Supabase
```

- `test/time.test.mjs` — timezone correctness, including the off-by-one regression
- `test/outbox.test.mjs` — queue ordering, dependencies, poison quarantine, error taxonomy
- `test/dataflow.test.mjs` — the full public API end to end, offline
- `test/schema-contract.test.mjs` — **parses the real migration and asserts every
  payload the app would send matches a real, non-generated column.** This is the
  failure that silently breaks storage on day one: post one column the table
  does not have and PostgREST rejects *every* write, with nothing in the UI
  looking wrong
- `tools/check-ui.mjs` — the logic script parses; every `{{ binding }}` resolves;
  the offline blockers stay fixed
- `tools/check-sql.mjs` — every migration parses against the real Postgres grammar
- `tools/check-backend.mjs` — the live round trip against a real project:
  proves the DATABASE works (schema, grants, triggers, constraints, storage)
- `tools/check-sync.mjs` — proves the APP works: runs the real outbox, push and
  pull against the live project, then wipes the local database and pulls from
  scratch to confirm a second device sees the same data. This is the one that
  catches a wrong RPC argument or an over-eager column filter — both of which it
  has already caught

What these do **not** cover: the React UI actually painting (no browser in CI).
That needs the manual pass in [DEPLOY.md](DEPLOY.md#part-d--verify-on-a-real-phone-5-min).

---

## Operating notes

- **Back up.** This becomes the company's only production record. Supabase PITR
  is a paid feature; the free tier is daily snapshots. A nightly `pg_dump` to
  Drive via a GitHub Action is a few lines and the cheapest insurance available.
- **Offline RLS is client-side nothing.** Every phone holds a full local copy of
  everything that syncs. Never put costs, client names or admin-only data in a
  synced table.
- **Device loss is data loss.** An unsynced phone takes its outbox with it. The
  sync chip escalates after 12 hours for exactly this reason.
- **`support.js` is generated.** Do not edit it. React is loaded from `vendor/`
  before it, which it detects and defers to (`support.js:1840`).
- **`BSF Production Log.dc.html` is the source of truth**, not `index.html`. The
  filename is kept because the DC runtime derives component identity from it and
  because it round-trips with Claude Design.
