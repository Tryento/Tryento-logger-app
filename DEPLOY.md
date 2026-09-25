# Deploying the demo

About 20 minutes. Two services, both free tier:

- **Supabase** — the database. This is where the data actually lives.
- **Netlify** — serves the app. Static files only, no secrets.

> **This demo has no login.** Anyone with the URL can read and change
> everything. That is what you asked for and it is fine for testing. Before it
> becomes the real system, see [Before this is real](#before-this-is-real) — it
> is a settings change, not a rebuild.

---

## Part A — Supabase (10 min)

### A1. Create the project

[supabase.com](https://supabase.com) → **New project**. Region closest to the
farm (Venezuela → `East US`). **Save the database password** — you can reset it
but not recover it.

Wait for it to finish provisioning (~2 min).

### A2. Run the setup SQL

**One file, one paste.** In Supabase: **SQL Editor** → **New query**.

You need the CONTENTS of the file, not its name — pasting
`supabase/SETUP_COMPLETO.sql` into the editor makes Postgres try to run that
text as SQL and it fails with `syntax error at or near "supabase"`.

Easiest way, in VS Code: open **`supabase/SETUP_COMPLETO.sql`**, `Ctrl+A`,
`Ctrl+C`, paste into the editor, **Run**.

Or copy it straight to the clipboard from PowerShell:

```powershell
[System.IO.File]::ReadAllText("$PWD\supabase\SETUP_COMPLETO.sql") | Set-Clipboard
```

It should report success and create 13 tables. That one file contains all three
migrations in order:

| Part | Creates |
|---|---|
| `0001_schema.sql` | Tables, constraints, triggers, permissions |
| `0002_views.sql` | Analytics views |
| `0003_seed.sql` | Dropdown values, the names Maria and Ricardo, photo bucket |

If it errors, run the three files in `supabase/migrations/` one at a time
instead — you get a much clearer idea of where it stopped.

> Editing a migration later? Run `bash tools/build-setup-sql.sh` to regenerate
> the combined file. `npm run check:sql` fails if you forget.

### A3. One setting that will otherwise waste your afternoon

**Settings → API → Exposed schemas** → add **`app`** → Save.

The tables live in a schema called `app`, and Supabase only publishes `public`
by default. Miss this and *every single request returns 404* with an error that
looks nothing like a settings problem. It is the most common failure by far.

### A4. Copy two values

**Settings → API**:

- **Project URL** — like `https://abcdefgh.supabase.co`
- **anon public** key — the long one starting `eyJ...`

Take the **anon public** key, not `service_role`. The anon key is meant to be
public; `service_role` bypasses everything and must never leave the dashboard.

---

## Part B — Configure and push (5 min)

### B1. Fill in `app-config.js`

```js
window.__TRYENTO_CONFIG__ = {
  supabaseUrl: 'https://abcdefgh.supabase.co',
  supabaseAnonKey: 'eyJhbGciOi...',
  authMode: 'none',
  dbSchema: 'app',
  storageBucket: 'fotos',
  farmTz: 'America/Caracas',
  ovenCapacidad: 8
};
```

### B2. Prove the database works before you deploy anything

```bash
npm install
npm run check:backend
```

This writes a real colony, tray, feeding, fast, harvest and oven run to **your**
Supabase, checks the computed values and the state machine came out right, and
then deletes everything it created. It is the difference between "the SQL ran"
and "storage actually works".

Every line should say `ok`. If one says `FAIL`, it tells you exactly what to
fix. **Do not continue until this is clean.**

### B3. Push to GitHub

The repo is already set up (`Tryento/Tryento-logger-app`, branch `main`):

```bash
git add .
git commit -m "App de registro de producción"
git push
```

`.gitignore` already excludes `node_modules/`, `dist/` and `migration/csv/` —
verified, so your exported farm data cannot be committed by accident.

---

## Part C — Netlify (5 min)

1. [app.netlify.com](https://app.netlify.com) → **Add new site** → **Import an
   existing project** → **GitHub** → pick the repo.
2. The build settings are read from `netlify.toml` — **do not change them**:
   ```
   Build command:      npm run vendor && npm run build
   Publish directory:  dist
   ```
3. **Deploy**. First build takes ~2 minutes.
4. **Site configuration → Build & deploy → Deploy Previews → disable.**
   Every preview gets its own public URL pointing at the same database, and an
   unlisted URL is your only protection.

Every `git push` now redeploys automatically.

> **Publish `dist`, never the repo root.** The root holds `migration/csv/` —
> your exported farm data. The build enforces this and fails if anything
> matching `*.csv` or `*.sql` ends up in the output.

---

## Part D — Verify on a real phone (5 min)

Open the Netlify URL on a phone and do these **in order**:

1. **The page looks right** — dark background, green accents, proper fonts.
   (Proves nothing is being fetched from a CDN.)
2. **Tap "Maria"** on the first screen. (Anyone not on the list types their
   name in the box below it — it then appears for everyone.)
3. **Header chip says "Al día"** within a few seconds. Anything else — tap it;
   the sync screen explains the problem in plain Spanish.
4. Create: **Insectarios → + Nuevo insectario**, then open it → **+ Nueva
   recolección**, then **Inicio → Nueva bandeja**.
5. **Check Supabase** → Table Editor → `app.bandeja`. Your tray is there.
6. **Airplane mode. Reload the page.** The app must still open and show your
   data. ← *If this fails, nothing else matters. Fix it first.*
7. Still offline, log a feeding. It saves instantly; the chip shows "1 en
   espera".
8. Turn the radio back on. Within a minute the chip returns to "Al día" and the
   feeding appears in Supabase.

Then **install it to the home screen** (Share → Add to Home Screen). On iPhone
this is what stops Safari deleting the offline data after a week — it matters,
it is not cosmetic.

---

## Loading your historical data

Send me the 9 tabs of `Tryento_App_Data` as CSV and I will run it. The
procedure, for reference:

```bash
# CSVs into migration/csv/ — one per sheet tab
npm run migration:csv          # -> migration/generated/01_staging_load.sql
```

Then in the SQL editor: `01_staging_load.sql` → `migration/02_transform.sql` →
`migration/03_checks.sql`, reading every result of the last one.

Do it in a **scratch Supabase project first**. Every id is derived
deterministically, so the whole migration is safely re-runnable — which you
will need, because nobody gets it right the first time.

Three things it will tell you, all findings rather than failures:

- **Fasting records have no tray.** The AppSheet `Ayuno` tab never had that
  link. They go to a quarantine table with ranked suggestions for a human.
- **`Separacion` and `Lotes` are empty.** The back half of the process has never
  been recorded, so yield and FCR have no denominator yet.
- **Every historical tray would show as active.** The transform closes them out
  explicitly rather than letting them flood the home screen.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `syntax error at or near "supabase"` | You pasted the file NAME, not its contents | Open the file, `Ctrl+A`, `Ctrl+C`, paste that |
| Everything 404s / no data ever loads | `app` not in Exposed schemas | **A3** — this is almost always it |
| `permission denied for schema app` | Migration didn't finish | Re-run `0001_schema.sql` to the end |
| Chip says "Sólo local" | `app-config.js` is empty or wrong | **B1**, then redeploy |
| Data saves but never syncs | Wrong URL or key | Tap the chip; the sync screen shows the error |
| Blank page offline | Service worker not installed | Must be HTTPS (Netlify is). Force-close and reopen |
| Dropdowns are empty | `0003_seed.sql` not run | Run it |
| Photos don't upload | Bucket missing | `0003_seed.sql` creates it |
| "Ya existe la bandeja Nº N" | Two trays share a number in one collection | A real duplicate — check the rack |
| Dates a day off | Device clock wrong | The sync screen warns above 5 minutes of drift |
| Old version stuck on a phone | Cached | Force-close the app and reopen; `sw.js` is sent no-cache |

**Re-run `npm run check:backend` any time something looks wrong.** It isolates
database problems from app problems in about ten seconds.

---

## Before this is real

Not needed for the demo. Needed before the farm depends on it:

- [ ] **Nightly backups.** This becomes the company's only production record;
      the free tier gives daily snapshots and no point-in-time recovery. A
      `pg_dump` on a schedule is the cheapest insurance you will buy.
- [ ] **Real logins.** Enable Google in Supabase, set `authMode: 'google'`, and
      replace the open policy on each table. The exact SQL is at the bottom of
      `0001_schema.sql`. **No schema change is required** — `created_by` is
      already on every table waiting to be populated.
- [ ] **A custom domain**, so the URL isn't a guessable `*.netlify.app`.
- [ ] Deploy previews still disabled.

One thing worth knowing now: `registrado_por` is the name someone typed. It is
not authentication and never will be — which is exactly why it is a separate
column from `created_by`. When real logins arrive, both are meaningful and
neither has to be migrated.
