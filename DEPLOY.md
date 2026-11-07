# Deploying the demo

About 20 minutes. Two services, both free tier:

- **Supabase** — the database. This is where the data actually lives.
- **Netlify** — serves the app. Static files only, no secrets.

> **This demo has no login.** Anyone with the URL can read and change
> everything. That is what you asked for and it is fine for testing. Before it
> becomes the real system, see [Before this is real](#before-this-is-real) — it
> is a settings change, not a rebuild.

---

> ### ⚠ El SQL va ANTES del push
>
> La app llama a las funciones de la base por su nombre: si haces push antes del
> SQL, todo lo que se registre queda en *Conflictos* hasta correrlo. Los archivos
> se pegan en Supabase → SQL Editor → New query (el CONTENIDO, no el nombre) → Run.
>
> | Archivo (en `supabase/`) | Qué es | Cuándo se corre |
> |---|---|---|
> | `esquema/0010_ciclo_nuevo.sql` | Los protocolos de octubre de 2026 | Ya corrió en producción (2026-10-22) |
> | `esquema/0011_bandejas_y_reglas.sql` | Sin racks, las bandejas de la recolecta, los dos modos, la llave pública sin borrar | **Una vez, antes del próximo push** |
> | `operaciones/permitir_cambios.sql` | Pasa a modo abierto | Cuando se decida, las veces que se quiera |
> | `operaciones/proteger_datos.sql` | Pasa a modo protegido | Cuando se decida, las veces que se quiera |
> | `operaciones/borrar_todos_los_datos.sql` | Borra todos los datos, para siempre | Sólo para empezar de cero |
> | `SETUP_COMPLETO.sql` | Todo `esquema/` junto | Sólo en una base nueva y vacía |
>
> Nada de esto vive en `supabase/migrations`, a propósito: la integración de
> Supabase con GitHub aplica esa carpeta a producción en cada push a `main`, y
> aquí el SQL se corre a mano, antes del push. Lo anterior a 0010 está en el
> historial de git.
>
> ### Actualizar producción: 0011, ANTES del push
>
> 1. Averigua qué falta (sólo lee, no cambia nada):
>    ```powershell
>    npm run check:sql-applied
>    ```
>    Hoy dice `FALTA` en las líneas `[0011]`.
> 2. SQL Editor → pega el contenido de
>    **`supabase/esquema/0011_bandejas_y_reglas.sql`** → Run. Elimina para siempre
>    los racks y los cambios de rack; lo demás queda. Correrlo otra vez no cambia
>    nada, y tampoco cambia de modo.
> 3. `npm run check:sql-applied` otra vez: **todas las líneas deben decir `ok`**, y
>    abajo dice el modo: abierto.
> 4. Recién entonces, push. Entre el paso 2 y el push la app publicada no puede
>    sincronizar: que nadie registre en ese rato.
> 5. `npm run check:backend` y `npm run check:sync`: ambos limpios.
>
> **En los teléfonos**, la versión nueva actualiza su base sola al abrir: conserva
> la cola, sin lo que sólo hablaba de racks.
>
> **Después del arranque**: registra los contenedores y los insectarios (con la
> generación que tienen hoy). Las larvas que ya están en incubadoras o cajas se
> anotan como recolecta con fecha pasada (interruptor *excepción*) y se distribuyen
> ese mismo día. Detalle en `docs/protocolo.html`.
>
> **Cambiar el plan** (días de chequeo, cargas y kilos, día de separación,
> porcentaje al horno, gramos de huevos y de alimento por bandeja, kilos por
> bandeja de pupación, días de recolecta, maduración y horas de consumo del
> ensilado): Supabase → Table Editor → esquema `app` → tabla `parametro`. Cada fila
> tiene una descripción. Los teléfonos lo toman en la siguiente sincronización; no
> hace falta publicar. El modo no se cambia ahí: se cambia con los archivos de abajo.

> ### Los dos modos
>
> | | Modo abierto (`permitir_cambios.sql`) | Modo protegido (`proteger_datos.sql`) |
> |---|---|---|
> | Fechas y orden de los protocolos | Se anota lo que haya; sólo lo muy raro pregunta | Se exigen |
> | Borrar desde la app | Sí (marca el registro y lo que cuelga de él) | No: la base lo rechaza y el botón desaparece |
> | Corregir un dato | Sí, queda quién y cuándo | Sí, queda quién y cuándo; sin nombre, la base lo rechaza |
> | Fechas de un día que no ha llegado | Pregunta | La base las rechaza |
> | Cambiar filas directamente con la llave pública | Sí (lo usan las herramientas de QA) | No: sólo las funciones que dejan constancia |
> | DELETE, TRUNCATE y cambiar ajustes con la llave pública | **Nunca** | **Nunca** |
>
> Cada archivo se corre cuando se quiera, las veces que se quiera, y no toca ningún
> dato. Los teléfonos cambian de modo en su siguiente sincronización. Una base nueva
> empieza en modo abierto.
>
> En modo protegido las herramientas de QA ya no limpian lo suyo: para
> `npm run check:backend`, `npm run check:sync` o
> `node tools/cleanup-qa.mjs --delete`, primero `permitir_cambios.sql`, y después
> `proteger_datos.sql` otra vez. `cleanup-qa --purge` nunca borra: imprime el SQL
> para pegarlo en el SQL Editor.
>
> ### Borrar todos los datos
>
> **`supabase/operaciones/borrar_todos_los_datos.sql` no se puede deshacer.** Elimina
> de verdad todo lo registrado en la app: insectarios, contenedores, recolectas,
> bandejas, cochadas, ensilados, recepciones y todos sus registros. Quedan los
> ajustes, la lista de materiales y los nombres (salvo los de prueba: «QA Claude»,
> check-backend, check-sync), y el modo no cambia. Al final muestra la lista de
> nombres que queda, para revisarla.
>
> Las fotos no salen con SQL: se vacían en Supabase → Storage → `fotos`. El esquema
> `historico` no se toca.
>
> **Los teléfonos:** una fila eliminada no les llega por sincronización, así que el
> archivo deja la hora del borrado en `parametro` (`datos_vaciados_at`). Cada teléfono
> la ve al sincronizar, ANTES de enviar nada, y borra lo suyo de antes de esa hora,
> también lo que tenía sin subir. Lo que registre después se conserva; si dependía de
> algo borrado, aparece en *Conflictos*.
>
> Para quitar sólo lo de una prueba, sin borrar todo:
> `node tools/cleanup-qa.mjs --delete --como "QA Claude"`.

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
dropdown at the top (it says `public`) choose **`app`**. You should see 19
tables, among them `jaula` (the insectarios), `incubadora`, `caja`, `chequeo`, `separacion`,
`cochada`, `ensilado` and `parametro`. Then run `npm run check:sql-applied`:
every line must say `ok`.

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

This runs a whole cycle through your Supabase — a cage, a recolecta and its
incubadora, the chequeo and distribución, a separación and its 98/2, a
correction, a cochada through the oven, the cage closed, cleaned and repopulated,
food ensiled and opened, an early close, a photo — checks the triggers fired and
the computed values are right, then marks everything it created as deleted
(`deleted_at`). It never hard-deletes: phones cannot see a hard delete, and a
phone that had synced those rows would keep them. To erase old test rows for
good, a week later: `node tools/cleanup-qa.mjs --purge`.

Expected output ends with:

```
La base está lista: escritura, llamadas, triggers, restricciones y fotos funcionan.
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
4. Create: **Laboratorio → Registrar insectario** (with flies), then **Inicio →
   Nueva recolecta**.
5. **Check Supabase** → Table Editor → `app.incubadora`. Your incubadora is there.
6. **Airplane mode. Reload the page.** The app must still open and show your
   data. ← *If this fails, nothing else matters. Fix it first.*
7. Still offline, open the incubadora and log its chequeo. It saves instantly;
   the chip shows "1 en espera".
8. Turn the radio back on. Within a minute the chip returns to "Al día" and the
   chequeo appears in Supabase.

Then **install it to the home screen** (Share → Add to Home Screen). On iPhone
this is what stops Safari deleting the offline data after a week — it matters,
it is not cosmetic.

---

## Loading your historical data

The AppSheet history is kept for looking things up, in the `historico` schema
(0010 creates it). It is not turned into rows of the app: the protocols changed
and the old records do not fit the new cycle.

```bash
# CSVs into migration/csv/ — one per sheet tab
npm run migration:csv          # -> migration/generated/01_historico.sql
```

Then run `01_historico.sql` in the SQL editor. Every column lands as text, and
every row keeps its sheet row number (`fila_origen`). Running it again replaces
each table with what the CSVs hold now. `historico` is not exposed to the app;
query it from the Supabase dashboard.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `syntax error at or near "supabase"` | You pasted the file NAME, not its contents | Open the file, `Ctrl+A`, `Ctrl+C`, paste that |
| Everything 404s / no data ever loads | `app` not in Exposed schemas | **A3** — this is almost always it |
| `permission denied for schema app` | The SQL didn't finish | Re-run the file in `supabase/esquema` to the end |
| Chip says "Sólo local" | `app-config.js` is empty or wrong | **B1**, then redeploy |
| Data saves but never syncs | Wrong URL or key | Tap the chip; the sync screen shows the error |
| Blank page offline | Service worker not installed | Must be HTTPS (Netlify is). Force-close and reopen |
| Materials list is empty | `supabase/esquema` not run | Run it |
| Photos don't upload | Bucket missing | `0010` creates it (section 12) |
| "Los datos están protegidos" in Conflictos | A delete queued offline while the data went to protected mode | *Descartar* it; correct the record instead |
| QA cleanup says `permission denied` | Protected mode | `permitir_cambios.sql`, repeat, then `proteger_datos.sql` |
| "Ya existe una incubadora F…" in Conflictos | Two phones gave out the same code offline | A real duplicate: keep one, *Descartar* the other |
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
- [ ] **Real logins.** Since `0011` the public key can no longer delete, and in
      protected mode it changes rows only through the functions that record who
      and when, but it can still read, add and correct everything: anyone with
      the URL can.
      Enable Google in Supabase (Authentication → Providers), set
      `authMode: 'google'`, keep a list of the lab's accounts, and change the
      `0011` policies (`app_leer`, `app_agregar`, `app_corregir`) from
      `to anon, authenticated using (true)` to those accounts only. **No schema
      change is required** — `created_by` is already on every table waiting to
      be populated.
- [ ] **A custom domain**, so the URL isn't a guessable `*.netlify.app`.
- [ ] Deploy previews still disabled.

One thing worth knowing now: `registrado_por` is the name someone typed. It is
not authentication and never will be — which is exactly why it is a separate
column from `created_by`. When real logins arrive, both are meaningful and
neither has to be migrated.
