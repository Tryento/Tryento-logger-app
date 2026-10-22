# TryEnto — Registro de Producción

Offline-first production logger for a black soldier fly farm. Replaces an
AppSheet app backed by a single Google Sheet.

Operators record the whole cycle from a phone, in a shed, with no signal:
recolecta → incubadora → distribución into cajas de engorde → chequeos and
cargas → separación (98 % to the oven, 2 % back to the cages) → cochada → the
cage repopulated with the 2 % → the next generation's recolecta; plus the food
(recepción → ensilado → 21 days → apertura → 72 h). Everything is captured
locally and syncs to Postgres when a connection appears.

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

Once Supabase is configured, `npm run check:sql-applied` says whether the SQL
the app needs is live, and `npm run check:backend` runs a whole cycle through
it — a cage, a recolecta, its distribución, a separación and its 98/2, a
correction, a cochada, the cage repopulated, food ensiled and opened — checks
what the database computed, and marks everything it created as deleted (a soft
delete, which phones can see). Run both before trusting the database.

**The protocols (October 2026)** — the lab's real cycle, defined with them
step by step: [docs/protocolo.html](docs/protocolo.html) (in Spanish, for the
lab) and [docs/LAB_SPEC.md](docs/LAB_SPEC.md). Days, kilos and percentages
live in the `app.parametro` table, not in code. Migration
[`0010_ciclo_nuevo.sql`](supabase/migrations/0010_ciclo_nuevo.sql) rebuilt the
schema for them and removed everything of the earlier protocols; 0001–0009 stay
in the folder as history.

**Objects and registries** — objects exist and are active or inactive (racks,
contenedores, jaulas, incubadoras, cajas, bandejas de pupación, cochadas,
ensilados); registries say what happened, when and who. Nothing is deleted: an
object becomes inactive by its registries (distributed, separated, out of the
oven, closed) or by an early close with a written reason. Every registry can be
corrected at any time; a correction moves everything computed from it, and what
a person recorded on top of it is marked **«revisar»** until reviewed.

**Computed, never stored** — ages, the 2 % waiting and which cajas it came from
(oldest first), the 98 % waiting for the oven, which ensilado each feeding drew
from (the oldest open one) and what was discarded after 72 h, the raw material
in store. [`src/data/vista.js`](src/data/vista.js) works all of it out from the
rows on the phone, by the same rules as the database's triggers.

**What is due (home screen)** — [`src/data/monitor.js`](src/data/monitor.js)
turns that into one list: late, today, the next two days. Cajas of one
incubadora that need the same step are one line; each line opens its form
already filled in. Pure and clock-free, so it is tested on pinned days.

**The lab in numbers (Resumen tab)** — [`src/data/resumen.js`](src/data/resumen.js)
reads the same picture: what there is now, the last eight weeks (Monday to
Sunday on the farm's calendar), and how 7 days, 30 days or everything went —
yield per g recolectado, growth in the cajas, FCR, cycle days against the plan,
recolectas per cage, the oven's yield, how much ensilado was eaten. A larvae
cycle counts in the period it ended. The definitions are in
[docs/LAB_SPEC.md §9](docs/LAB_SPEC.md#9-kpis-and-how-they-are-computed).

To connect it to Supabase, fill in [`app-config.js`](app-config.js) and run
[`supabase/SETUP_COMPLETO.sql`](supabase/SETUP_COMPLETO.sql) (a new database) or
the numbered files you are missing (an existing one) — see [DEPLOY.md](DEPLOY.md).

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
              ├── read.js / write.js      what each screen reads, every action
              ├── vista.js                the lab worked out from the rows (pure)
              ├── protocolo.js            settings, day count, next steps (pure)
              ├── alimento.js · pool.js   food used / the 2 % and 98 % (pure)
              ├── revisar.js              what a correction leaves to review (pure)
              ├── monitor.js              "para hoy" (pure)
              ├── resumen.js              the Resumen tab: now, weeks, KPIs (pure)
              ├── registros.js            what can be corrected, per table
              ├── snapshot.js             the rows, read once and reused
              ├── idb/                    IndexedDB: the device's source of truth
              ├── outbox.js               the durable write queue
              ├── sync/{push,pull,blobs,loop}.js
              ├── conflicts.js            writes the server refused
              └── photo.js                capture → downscale → queue
```

Every function answers with the same envelope — `{ok, data}` or
`{ok, error:{code, message}}` — and the sync machinery (outbox, push, pull,
conflicts, photos) is the same one that ran before the October 2026 rebuild.

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

**1. A state comes from registries, by one rule in two places.** An
incubadora is inactive once distributed, a caja once separated, a cochada once
out of the oven, a cage's phase is its last ingreso, cierre or limpieza. The
database keeps `estado` up to date by trigger (for anyone querying it); the
phone works out the same thing from its own rows (`vista.js`), so it never
waits for the server, and a state can never flip between what this phone did
and what the last pull said.

**2. Store what a person recorded or confirmed; compute the rest.** Ages, the
2 % and 98 % waiting, food used and discarded, the stock: computed on read, so a
correction moves all of them with nothing to keep in step. What cannot move by
itself — a generation confirmed at a repopulation, kilos a cochada took — is
flagged «revisar» when something it was built on changes.

**3. Codes are labels and never change.** F8A-12, S2-2810 and the rest are
written on the container. A corrected cage, generation or date corrects the
data; the code stays, and numbering continues from the codes given.

**4. Cross-row uniqueness is the server's.** One distribución per incubadora,
one separación per caja, one chequeo per day, a code once per day. Two offline
devices both pass the local check and both sync; Postgres rejects one, and the
loser goes to the conflict inbox — **not** softened to `ON CONFLICT DO NOTHING`,
which would silently discard a recorded event.

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
misorder timelines. Calendar facts (`dia0`, `ciclo_desde`) stay `DATE`; they
are days on the farm's calendar, not instants.

---

## The AppSheet history

The years recorded in AppSheet are kept for looking things up, in their own
schema, `historico` — not turned into rows of the app: the protocols changed in
October 2026 and the old records do not fit the new cycle. `historico` is not
exposed to the API; it is read from the Supabase dashboard.

```bash
# 1. export every tab of Tryento_App_Data as CSV into migration/csv/
npm run migration:csv          # -> migration/generated/01_historico.sql
```

Then run `migration/generated/01_historico.sql` in the Supabase SQL editor.
Every column lands as `text` (a typed import turns "1,5" into 15 and a blank
date into 1970), and every row keeps its sheet row number in `fila_origen`.
Running it again replaces each table with what the CSVs hold now.

`migration/csv/` and `migration/generated/` hold farm data and are never
committed or published.

---

## Analytics

The views of the earlier protocols (`v_rendimiento_bandeja`, `v_fcr_bandeja`,
…) went with their tables in 0010. The Streamlit dashboard
(`Tryento/Dashboard-demo`) keeps reading `devices.records`; its production
section needs new views over the new tables, which are not built yet.

When they are: the dashboard must connect as a read-only role through
**Supavisor in transaction mode** — not the anon key through PostgREST, and not
a direct connection, which would exhaust the pool PostgREST is also using.

---

## Device provisioning

Each phone must be set up **at the office, online**, before it goes to the field:

1. Sign in with Google (OAuth needs an online redirect — a fresh device in a
   shed has no path to a session)
2. **Install to home screen** — on iOS this is what makes storage persistence
   stick; without it Safari clears site data after 7 days of non-use
3. Confirm persistent storage was granted (the sync screen reports it)
4. Let the first full pull finish
5. Verify the cages (Insectarios) are listed, then go offline and reload to
   prove the shell is cached

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
- `test/protocolo.test.mjs`, `alimento`, `pool`, `revisar`, `monitor` — the pure
  rules on pinned farm days: the 98/2 split rounding exactly like Postgres, the
  steps of each object, food drawn oldest-first, the 2 % and its ages, what a
  correction flags, "para hoy"
- `test/flujo.test.mjs` — **a whole day in the lab through the data layer**:
  every action offline, then pushed by the real sync engine to a real Postgres
  built from `SETUP_COMPLETO.sql`, pulled back, and two phones separating the
  same caja
- `test/sql-migrations.test.mjs` — 0010 on an empty database, over a replica of
  production with data (people kept, everything else gone), run twice, and every
  trigger and call
- `test/contrato.test.mjs` — what the phone may correct equals what
  `app.editar` accepts; every store has its table; generated columns never sent
- `test/herramientas.test.mjs`, `test/check-sync.test.mjs` — the production
  checks below, run against a local Postgres so their verdict can be trusted
- `tools/check-ui.mjs` — the logic script parses; every `{{ binding }}` resolves;
  the offline blockers stay fixed
- `tools/check-sql.mjs` — every migration parses against the real Postgres grammar
- `tools/check-idb-browser.mjs` — **real Chrome at phone size**: the whole cycle
  driven on screen like a person (`npm run build` first; `SHOTS=<folder>` saves
  screenshots)
- `tools/check-sql-applied.mjs` — is the SQL the app needs live? Read-only
- `tools/check-backend.mjs` — proves the live DATABASE works (schema, grants,
  triggers, constraints, storage), then marks its rows deleted
- `tools/check-sync.mjs` — proves the APP works against the live project: the
  real outbox, push and pull, then a wiped phone pulling from scratch

What these do **not** cover: a real phone's camera and storage eviction. That
needs the manual pass in [DEPLOY.md](DEPLOY.md#part-d--verify-on-a-real-phone-5-min).

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
