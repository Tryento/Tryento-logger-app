# Deploying the demo

About 20 minutes. Two services, both free tier:

- **Supabase** — the database. This is where the data actually lives.
- **Netlify** — serves the app. Static files only, no secrets.

> **This demo has no login.** Anyone with the URL can read and change
> everything. That is what you asked for and it is fine for testing. Before it
> becomes the real system, see [Before this is real](#before-this-is-real) — it
> is a settings change, not a rebuild.

---

> ### ⚠ Base que ya existe: corre el SQL que falte ANTES de hacer push
>
> Averigua qué falta (sólo lee, no cambia nada):
>
> ```powershell
> npm run check:sql-applied
> ```
>
> Corre en Supabase → SQL Editor → New query, **uno por uno y en este orden**,
> sólo los que salgan como `FALTA`. Copia el CONTENIDO del archivo, no su nombre.
>
> 1. **`0004_atribucion_acciones.sql`** — quién hizo cada acción de un toque.
>    (Aplicado en producción.)
> 2. **`0005_renombrar_lote.sql`** — `cochada` vuelve a llamarse `lote`, como en
>    AppSheet. Renombra en el lugar: no borra ni copia datos. Recrea las
>    funciones y vistas él mismo. (Aplicado en producción.)
> 3. **`0006_sobrecargas.sql`** — quita funciones duplicadas que dejó 0004.
>    (Aplicado en producción.)
> 4. **`0007_protocolo_v2.sql`** — el protocolo nuevo de 16 días: incubadora,
>    distribución en bandejas, cargas fijas, ayuno de un toque, 2 % al
>    laboratorio, y la tabla `parametro` con los días y kilos del plan. No
>    convierte ni borra datos viejos: todo lo existente queda marcado `v1`.
> 5. **`0008_alimento.sql`** — recepción de material, ensilajes (armado →
>    sellado → listo → en uso → agotado, con lecturas de temperatura), de qué
>    ensilaje sale cada carga, y las vistas de stock y consumo. Sólo agrega.
>
> Después vuelve a correr `npm run check:sql-applied`: cada línea del SQL que
> corriste debe decir `ok`. Recién entonces haz push.
>
> **Cada versión de la app necesita su SQL** (si publicas por partes):
>
> | Publicación | Qué trae | SQL que debe estar corrido antes del push |
> |---|---|---|
> | 1 | arreglo del arranque + protocolo v2 (recolecta, incubadora, cargas, ayuno, cosecha) | `0005`, `0006`, `0007` |
> | 2 | módulo de alimento (recepción, ensilaje, stock) | además `0008` |
>
> Correr `0008` antes de tiempo no rompe la publicación 1: las funciones que
> cambia conservan su firma y los teléfonos de la publicación 1 siguen igual.
>
> **El orden importa.** La app llama a las funciones de la base por su nombre.
> Si haces push antes del SQL, lo nuevo (recolecta con incubadora, distribución,
> cierre de ayuno con quién lo hizo, ensilajes) falla y queda en *Conflictos*
> hasta correr el SQL. Lo que ya existía sigue funcionando.
>
> **Nunca pegues `SETUP_COMPLETO.sql` en una base que ya tiene datos.** Es sólo
> para una base nueva y vacía; en una existente falla en la primera línea.
> `0005` a `0008` se pueden correr dos veces sin daño.
>
> **Cambiar el plan** (días, kilos por carga, larvas por bandeja, días de
> fermentación del ensilaje, fecha de inicio del protocolo nuevo): Supabase →
> Table Editor → esquema `app` → tabla `parametro`. Cada fila tiene una
> descripción. Los teléfonos lo toman en la siguiente sincronización; no hace
> falta publicar la app. `dias_fermentacion` (14) es provisional: confírmalo
> con el laboratorio.

## Step 0 — be in the right folder

The repo sits one level down from the GitHub folder. Every `npm` command below
must run from the folder that contains `package.json`:

```powershell
cd C:\Users\Zoned\Documents\GitHub\Tryento-logger-app\Tryento-logger-app
```

Check you are in the right place — this must print a file, not an error:

```powershell
dir package.json
```

If npm says `Could not read package.json`, you are one level too high.

In VS Code: **File -> Open Folder** -> pick the *inner* `Tryento-logger-app`, so
the built-in terminal always starts in the right place.

---

## Part A — Supabase

### A1. Create the project

1. Go to **https://supabase.com/dashboard** and sign in.
2. Click **New project**.
3. Fill in:
   - **Organization** — pick yours (or create one; any name).
   - **Name** — `tryento` (only you see this).
   - **Database Password** — click **Generate a password** and **save it in your
     password manager**. You will not need it for the app, but you cannot
     recover it later, only reset it.
   - **Region** — `East US (North Virginia)`.
4. Click **Create new project**.
5. Wait until the top of the page stops saying *"Setting up project"* — about
   2 minutes. Do not continue before it finishes.

### A2. Run the setup SQL

1. In the **left sidebar**, click **SQL Editor** (the `>_` icon).
2. Click **+ New query** (top left of that panel).
3. In VS Code, open **`supabase/SETUP_COMPLETO.sql`** from this repo. Press
   `Ctrl+A`, then `Ctrl+C`.

   > Copy the file's **contents**. Pasting the file *name* gives
   > `syntax error at or near "supabase"`.

   Or put it straight on your clipboard from PowerShell, run in the repo folder:
   ```powershell
   [System.IO.File]::ReadAllText("$PWD\supabase\SETUP_COMPLETO.sql") | Set-Clipboard
   ```
4. Click into the empty query box, press `Ctrl+V`.
5. Click **Run** (bottom right, or `Ctrl+Enter`).
6. Wait for the green **Success. No rows returned**. It takes a few seconds.

**Confirm it worked** — click **Table Editor** in the sidebar, and in the schema
dropdown at the top (it says `public`) choose **`app`**. You should see 12
tables: `alimentacion`, `ayuno`, `ayuno_huerfano`, `bandeja`, `catalogo`,
`insectario`, `lote`, `lote_separacion`, `migracion_log`, `recoleccion`,
`revision`, `separacion`.

If you see an error instead, run the three files in `supabase/migrations/` one
at a time — you get a clearer idea of where it stopped.

### A3. Expose the `app` schema

Without this every request returns 404 and the app will look broken.

1. Sidebar → **Settings** (gear icon, bottom of the sidebar).
2. Click **API**. *(If there is no "Exposed schemas" box on that page, look for
   **Data API** in the settings list — Supabase has moved this setting between
   the two.)*
3. Find **Exposed schemas**. It is a multi-select showing `public` and `graphql_public`.
4. Click it and tick **`app`** so all three are selected.
5. Click **Save**.

### A4. Copy the anon key

1. Still in **Settings**, open **API Keys** *(older projects: the keys are on
   the same **API** page under "Project API keys")*.
2. Copy the key labelled **`anon`** / **`public`** / **publishable**. It is long
   and starts with `eyJ`.

   **Not** the one labelled `service_role` / `secret`. That one ignores all
   security rules, and this file is downloadable by anyone who opens your site.
3. You do **not** need the Project URL — it is already filled in for your
   project (`https://roxgnhrdrgcrfybaevov.supabase.co`).

---

## Part B — Connect the app

### B1. Paste the key

Open **`app-config.js`** in the repo root. Put the key between the quotes:

```js
window.__TRYENTO_CONFIG__ = {
  supabaseUrl: 'https://roxgnhrdrgcrfybaevov.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',   // <-- aquí
  authMode: 'none',
  dbSchema: 'app',
  storageBucket: 'fotos',
  farmTz: 'America/Caracas',
  ovenCapacidad: 8
};
```

Save the file.

### B2. Check that the database actually works

In a terminal, in the repo folder:

```bash
npm install
npm run check:backend
```

This writes a real colony, tray, feeding, fast, harvest and oven run to your
Supabase (plus the new-protocol recolecta, incubadora and distribution once
0007 is applied, and a reception, an ensilaje and a load taken from it once
0008 is), checks the triggers fired and the computed values are right,
then marks everything it created as deleted (`deleted_at`). It never
hard-deletes: phones cannot see a hard delete, and a phone that had synced
those rows would keep them. To erase old test rows for good, a week later:
`node tools/cleanup-qa.mjs ZZTEST-… --purge`.

Expected output ends with:

```
La base está lista: escritura, claves foráneas, triggers, restricciones,
vistas y almacenamiento de fotos funcionan.
```

If any line says `FAIL`, it names the fix. **Do not continue until it is clean.**

### B3. Push

```bash
git add .
git commit -m "App de registro de producción"
git push
```

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
