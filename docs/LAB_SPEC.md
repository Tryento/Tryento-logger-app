# Tryento lab specification

**The single reference for how the Tryento black soldier fly (BSF) lab is built,
configured and operated.** It covers the climate controller
([`Tryento/tryento-app`](https://github.com/Tryento/tryento-app)), the production
log (this repo), and the physical process that connects them.

| | |
|---|---|
| Version | 0.6 — the Resumen tab: the lab's KPIs, computed in the app |
| Last updated | 2026-10-22 |
| Built from | `tryento-app` `main` @ `a2b5b73` (2026-04-23) plus branches `50`, `52`, `55`, `Trunk`; `Tryento-logger-app` branch `ciclo-nuevo` (2026-10-22) |
| Companion | [BSF research knowledge base](reports/Black%20soldier%20fly%20farms%20and%20biology.md) — the biology and industry evidence behind the numbers here |

> **This is a living document.** Anything marked **⚠ CONFIRM** was inferred from
> code or git history and has not been checked against the physical lab. Anything
> marked **🔬 RESEARCH** conflicts with, or is sharpened by, the published
> literature. See [§12 Keeping this document current](#12-keeping-this-document-current).

---

## Contents

1. [The lab at a glance](#1-the-lab-at-a-glance)
2. [Production process](#2-production-process)
3. [Environments and hardware](#3-environments-and-hardware)
4. [Climate control logic](#4-climate-control-logic)
5. [Lighting](#5-lighting)
6. [Setpoint and lighting history](#6-setpoint-and-lighting-history)
7. [Environment data pipeline](#7-environment-data-pipeline)
8. [Production log (this repo)](#8-production-log-this-repo)
9. [KPIs and how they are computed](#9-kpis-and-how-they-are-computed)
10. [Known issues and risks](#10-known-issues-and-risks)
11. [Open questions to confirm](#11-open-questions-to-confirm)
12. [Keeping this document current](#12-keeping-this-document-current)
13. [Changelog](#13-changelog)

---

## 1. The lab at a glance

| Item | Value |
|---|---|
| Organism | Black soldier fly, *Hermetia illucens* (Diptera: Stratiomyidae) |
| Location | Venezuela — tropical lowland. The species is native to the region. |
| Farm timezone | `America/Caracas` (UTC−4, no daylight saving). Every calendar decision in the software resolves against it. |
| Product | Whole larvae, fasted, separated and **oven-dried** to a golden, crunchy finish; packed with a 180-day best-before |
| Adult breeding | 3 climate-controlled mating cages (controller env 1–3) and 4 colony codes in the production log (`ICA`, `ICB`, `ICC`, `JN3A`) |
| Larval rearing | Trays (`bandejas`) seeded by egg mass, fed agro-industrial by-products (bagazo, afrecho, yogurt) |
| Climate controller | Raspberry Pi, Python, DHT22 sensors, GPIO relays; repo `Tryento/tryento-app` |
| Production log | Offline-first PWA over Supabase (Postgres); this repo |
| Analytics | Streamlit dashboard, repo `Tryento/Dashboard-demo` |

### Systems map

```
                 PHYSICAL LAB                                    SOFTWARE
 ┌──────────────────────────────────────┐
 │ Adult cages 1–3  (insectarios)       │◄── Raspberry Pi controller ──► MongoDB `devices.records`
 │  2× DHT22 each, 6 relays each        │     (tryento-app, every 20 s)      │   (Redis buffer offline)
 │ Exterior reference sensors 4–5       │     Flask dashboard :5000 (LAN)    │
 └───────────────┬──────────────────────┘                                    ▼
                 │ eggs                                          Streamlit dashboard
 ┌───────────────▼──────────────────────┐                        (Tryento/Dashboard-demo)
 │ Rearing trays → fast → separation    │◄── Phones: production log PWA ──► Supabase `app.*`
 │ Oven runs → QC → pack → dispatch     │     (this repo, offline-first)      analytics views ─┘
 └──────────────────────────────────────┘
```

The two data streams are **not linked today**. The controller knows cages by
`env_id` (1–3); the production log knows colonies by `nombre_insectario`
(`ICA`…). See [§11](#11-open-questions-to-confirm).

---

## 2. Production process

The protocols the production log follows from **October 2026**, defined with
the lab step by step (sessions of 19–20 October 2026). The lab's own document,
in Spanish: [`docs/protocolo.html`](protocolo.html). Migration
`0010_ciclo_nuevo.sql` rebuilt the production log for them; it ran in
production on 22 October 2026. Every number below is a row in
`app.parametro`, editable without a new app version. Notation: CAPS = a process
or period, lowercase = a task someone does.

```
recolecta (L/Mi/V) ─► INCUBADORA ─► tamizado, pesado y distribución (día 7) ─► CAJAS DE ENGORDE
 ─► separación (~día 16) ─┬─ 98 % ─► HORNO (cochada) ─► empaque (not built yet)
                          └─ 2 % ─► waits (kg) ─► bandejas de pupación ─► ingreso al insectario
INSECTARIO (one cage, one generation per cycle):
  repoblado ─► ~14 days of recolectas ─► cierre ─► limpieza ─► repoblado …
```

### 2.1 The larvae cycle

| When | Task | What happens physically | Recorded as | Rules and defaults |
|---|---|---|---|---|
| día 0, Mon/Wed/Fri | **recolecta** | Eggs/larvae collected from a cage with flies; they become **one incubadora** on a rack | `incubadora`: code **`F8A-12`** (generation 8, cage letter A, recolecta 12 of that generation), cage, rack, initial weight **g** (eggs/larvae only), initial food **kg** | The food usual amount is proposed (`alimento_inicial_incubadora_kg`, ⚠ to be set before go-live) and is taken from the open ensilado. Date = today; a past date only with the **excepción** switch (marked; steps due before it was entered are not chased) |
| día 3 | **chequeo** | Substrate humidity and temperature, weight | `chequeo` (`humedad_pct`, `temperatura_c`, `peso_g`) | Only the scheduled checks exist |
| día 7 | **tamizado, pesado y distribución** | Larvae sieved and weighed, split into cajas de engorde; carga 1 | `distribucion` (total kg) + N `caja` (`F8A-12-01…`, weight kg, rack) + carga 1 per caja — one atomic call | One incubadora → N cajas, never mixed; the incubadora becomes inactive. Carga 1: 1.5 kg proposed |
| día 10 | **chequeo**, then **carga 2** | Check, then feed 2 kg | `chequeo` (`peso_kg`) + `alimentacion` (`carga=2`) | The carga waits for the chequeo |
| día 13 | **carga 3** | 2 kg | `alimentacion` (`carga=3`) | Each carga: confirm the plan, or change the kg |
| día 14 | **chequeo** — starts the **AYUNO** | Check; no more feed until separación | `chequeo` | A carga not given by then is no longer asked |
| ~día 16 | **separación** | Per caja: total weight; 98 % to the oven, 2 % back to the cages | `separacion` (`peso_total_kg`; `coccion_kg`, `retorno_kg` computed by the database from `pct_coccion` 98) | Flexible day; the caja becomes inactive |
| — | **cochada** | The 98 % of several separaciones, weighed, into the oven; a mid temperature; a final temperature and weight | `cochada` (`H-2810-1`, initial kg) + `cochada_origen` (kg from each separación — one separación's 98 % may be split) + `cochada_lectura` (media; final with weight) | After the final reading it is ready for packing (inactive). Packing and inventory: not built yet |
| — | **redistribución, pesado y acondicionado + ingreso** | The 2 % waiting, weighed, into trays of ~4.7 kg (larvae + conditioning material) that go into a closed and cleaned cage the same day | `ingreso` (cage, kg of larvae, the cage's new generation) + `bandeja_pupacion` (`F7-B2810-1`, weight kg, rack) | The 2 % is used **oldest first**; ages = range and simple average of the cajas used; mixed generations → warning, most common wins; the cage becomes generation + 1 |
| ~14 days after | **cierre**, then **limpieza** | The cage's cycle ends; it is cleaned | `jaula_evento` | Only a closed and cleaned cage can be repopulated |
| any time | **cambio de rack** | An incubadora, caja or tray moves | `movimiento` | — |
| any time | **cierre antes de tiempo** | Loss, contamination… | `cerrado_at`, `motivo_cierre` (free text) | Incubadora, caja, tray, cochada; nothing is deleted |

**Age** is days since the recolecta (día 0); cajas inherit it. **Units:** grams
for the incubadora's initial weight and the día-3 chequeo weight, kilos for
everything else. **Codes** are written on the container and never change, even
if the cage, generation or date they came from is corrected.

### 2.2 The food

| Step | What happens physically | Recorded as | Rules and defaults |
|---|---|---|---|
| **recepción** | Material arrives | `recepcion` (`material`, `kg`) | Materials from catalogue `material_alimento` |
| **ensilado** | A container is filled from one or more receptions | `ensilado` (`S2-2810` = container + day) + `ensilado_insumo` (kg of each reception) | A reception can be split across ensilados |
| **MADURACIÓN** | 21 days | nothing | `dias_maduracion` 21 |
| **apertura** | Opened on its día 21 (not before) | `ensilado.abierto_at` / `abierto_por` | First opening wins |
| **consumption** | Eaten within **72 h** | nothing — every feeding (the incubadora's initial food, every carga) takes its kilos from the **oldest open** ensilado, splitting if needed | No open ensilado: the feeding is recorded as **sin ensilado**. At 72 h what is left counts as discarded |

Raw material in store = received − ensiled, per material. Ensilados already
maturing at go-live are not entered: food is tracked from the first ensilado
made in the app.

### 2.3 Corrections and "revisar"

Every record can be corrected at any time, values and dates; the last edit
wins, keeping who and when. What is computed (98/2, ages, the 2 % and 98 %
waiting, food used, stock) simply moves. What a person recorded or confirmed on
top of the corrected record is flagged **«revisar»** until someone taps
**«Revisado»**: a cochada that took a corrected separación's 98 %, a
repopulation whose larvae came from a corrected separación or incubadora, an
incubadora whose cage generation no longer matches. One photo and one note per
record; a note or photo flags nothing.

### State machines

```
Incubadora   activa ──► inactiva   (distributed, or closed early)
Caja         activa ──► inactiva   (separated, or closed early)        en ayuno from the día-14 chequeo
Cochada      activa ──► inactiva   (final reading, or closed early)
Jaula        con moscas ──► cerrada ──► limpia ──► con moscas (next generation)
Ensilado     madurando ──► abierto ──► consumido (72 h after opening)
```

States come from the registries, by the same rule in the database (triggers)
and on the phone.

### Inputs in use (catalogue `app.catalogo`)

| Catalogue | Values | Notes |
|---|---|---|
| `material_alimento` | Bagazo de cerveza (BSG), Desecho de panadería, Desecho de fruta, Otro | What arrives and goes into an ensilado |
| `operario` | Self-maintaining roster | Names are typed or tapped; not an audit identity |

Racks, containers and cages are not catalogue values: they are objects,
registered once in the app (a cage with its name, letter, place, current
generation and whether it has flies).

---

## 3. Environments and hardware

### 3.1 Controller host

| Item | Value |
|---|---|
| Board | Raspberry Pi — model ⚠ CONFIRM |
| OS user and path | `/home/tryento/tryento-app`, Python venv at `.venv` |
| Runs as | root (GPIO access) |
| Start-up | `src/scripts/on_boot.sh` backgrounds `python3 main.py`. No systemd unit yet, so **nothing restarts it after a crash**. |
| Pin numbering | BCM |
| Local services | Redis (`localhost:6379`), Flask on `0.0.0.0:5000` |
| Clock and timezone | Lights follow the Pi's **local time** — must be `America/Caracas` ⚠ CONFIRM |

### 3.2 Environments

| env_id | Type | Sensors | Devices | Loop period |
|---|---|---|---|---|
| 1 | cage | 2 × DHT22 | intake, exhaust, atomizer, heater, 2 light channels | 20 s |
| 2 | cage | 2 × DHT22 | same | 20 s |
| 3 | cage | 2 × DHT22 | same | 20 s |
| 4 | exterior | 1 × DHT22 | none (reference only) | 120 s |
| 5 | exterior | 1 × DHT22 | none (reference only) | 120 s |

### 3.3 GPIO map (BCM) — `main` as of 2026-04-23

| Env | Sensor pins | Intake | Exhaust | Light A (8 h) | Light B (14 h) | Atomizer | Heater |
|---|---|---|---|---|---|---|---|
| Cage 1 | 21, 22 | 2 | 3 | 27 | 9 | 4 | 17 |
| Cage 2 | 20, 10 | 5 | 6 | 11 | 23 | 13 | 19 |
| Cage 3 | 16, 18 | 12 | 7 | 8 | 26 | 25 | 24 |
| Exterior 4 | **0** | — | — | — | — | — | — |
| Exterior 5 | **0** | — | — | — | — | — | — |

- **18 relay outputs** (6 per cage) and **6 cage sensor inputs**.
- **Both exterior sensors point at BCM 0.** Their earlier pins (26 and 23) were
  reassigned to cage lights in April 2026. BCM 0 is reserved for the HAT ID
  EEPROM, and two sensors cannot share it, so the exterior readings are probably
  missing or duplicated. ⚠ CONFIRM whether the exterior sensors are still wired.
- Light A / Light B: branch `55` assumes **pin 27 / 11 / 8 = visible (warm)** and
  **pin 9 / 23 / 26 = blue**. ⚠ CONFIRM on hardware before any lighting change.
- **BCM 2 and 3 (cage 1 intake and exhaust)** are the I²C pins and have fixed
  pull-up resistors, so they sit HIGH at boot until `main.py` drives them LOW.
  If those relays are active-high, cage 1's fans may run briefly at every boot.
  ⚠ CONFIRM relay polarity (the code treats `HIGH` as ON).
- `.planning/codebase/INTEGRATIONS.md` in tryento-app still shows the old
  single-sensor map (D26/D23 for exteriors). This table supersedes it.

### 3.4 Sensors

| Property | Value |
|---|---|
| Model | DHT22 (AM2302), read with `adafruit_dht` in bit-bang mode (`use_pulseio=False`) |
| Spec accuracy | about ±0.5 °C and ±2–5 % RH (datasheet); drifts with age and high humidity |
| Read failures | 10–20 % of reads fail and return nothing; the loop tolerates this |
| Aggregation | Arithmetic mean of the sensors that answered this cycle; newest timestamp kept |
| Placement | ⚠ CONFIRM — height, distance from heater, lamps and atomizer |

The control band (±1 °C, ±3 % RH) is about the same size as the sensor's own
error, especially for humidity. 🔬 See research note
[02 §temperature and humidity](research_notes/Black%20soldier%20fly%20farms%20and%20biology/02_adult_mating_light.md).

### 3.5 Actuators

| Device | Physical role | ⚠ CONFIRM |
|---|---|---|
| Intake fan | Brings in outside air (cools when outside is cooler; dries or wets depending on outside RH) | fan model, airflow |
| Exhaust fan | Removes cage air (dries, removes heat) | fan model, airflow |
| Atomizer | Mists water to raise humidity (also cools by evaporation) | nozzle, water source, droplet size |
| Heater | Raises temperature | type, wattage, distance from flies |
| Light A / B | LED channels, on/off only (no dimming) | spectrum, µmol/m²/s at cage level |

---

## 4. Climate control logic

Source: `src/objects/environment.py` (`Environment.control`). It runs every 20 s
per cage on the averaged reading, rounded to 0.1.

**Current targets (all cages):** 30 °C ± 1 → band **29.0–31.0 °C**;
72 % RH ± 3 → band **69.0–75.0 % RH**. Values exactly on a limit count as in band.

### The 9-case rule

| Case | Temperature | Humidity | Intake | Exhaust | Atomizer | Heater | Reasoning |
|---|---|---|---|---|---|---|---|
| 1 | high | in band | **ON** | off | off | off | Bring in cooler air |
| 2 | in band | high | off | **ON** | off | off | Vent moist air |
| 3 | high | high | **ON** | **ON** | off | off | Full air exchange |
| 4 | in band | in band | off | off | off | off | Hold |
| 5 | low | in band | off | off | off | **ON** | Heat |
| 6 | in band | low | off | off | **ON** | off | Mist |
| 7 | low | low | off | off | **ON** | **ON** | Heat and mist |
| 8 | high | low | **ON** | off | **ON** | off | Ventilate and mist (evaporative cooling) |
| 9 | low | high | **ON** | **ON** | off | **ON** | Heat while venting to dry |

Behaviour to know:

- **Missing data.** If temperature *or* humidity is missing, every climate device
  keeps its previous state; lights still follow their schedule. If every sensor
  in a cage fails, the cycle is skipped and devices keep their state.
- **No hysteresis and no minimum run time.** A reading hovering at a band edge
  can switch a relay every 20 s (up to about 180 switches an hour). 🔬 See
  research note [06 §6](research_notes/Black%20soldier%20fly%20farms%20and%20biology/06_industry_operations_automation.md).
- **No sensor-failure fail-safe.** A stuck heater or atomizer stays in its last
  state for as long as sensors are silent, and **there is no alerting**.
- **Outside air assumptions.** Cases 1, 3, 8 and 9 assume that outside air helps.
  On a hot, humid afternoon it may not. The exterior sensors were added to judge
  this, but they are on BCM 0 today (§3.3).
- **Cage air only.** No sensor measures substrate temperature, CO₂, ammonia or
  light. Larval trays are not monitored at all. 🔬 Larval metabolism can heat a
  tray core 10 °C or more above room air (research note 01).

---

## 5. Lighting

Lights are `TimedDevice`s. They are evaluated on every control cycle,
independently of the 9-case rule.

### 5.1 In production (`main`) — noon-centred windows

Each channel is ON from `12:00 − interval/2` to `12:00 + interval/2`, local time
of the Pi.

| Channel | Pins (cage 1 / 2 / 3) | Interval | ON window |
|---|---|---|---|
| Light A (visible, assumed) | 27 / 11 / 8 | 8 h | 08:00–16:00 |
| Light B (blue, assumed) | 9 / 23 / 26 | 14 h | 05:00–19:00 |

If the assumed mapping is right, **blue currently runs 14 h/day and comes on 3 h
before the visible light.**

### 5.2 Planned experiment — cage 1 photoperiod (branch `55-cage-a-test-of-different-light-offsets`, 2026-09-16, not merged)

| Cage | Visible | Blue | Status |
|---|---|---|---|
| 1 (treatment) | 06:00–17:30 (11.5 h) | 08:30–14:30 (6 h, nested) | Planned |
| 2, 3 (control) | unchanged: 08:00–16:00 | unchanged: 05:00–19:00 | — |

The branch adds a second fixture schema (`role` + `on`/`off` in `HH:MM`) next to
the legacy `interval` schema, and rejects a blue window over 6 h or a visible
window other than exactly 11.5 h. Full plan: `plan.md` on that branch.

🔬 **Research flags on this design** (research note 02):

- No BSF study shows that long blue exposure harms adults. The "limit blue" idea
  comes from *Drosophila* work; two BSF studies ran blue-rich LEDs 16 h/day and
  saw the longest adult lifespans.
- Blue alone does not trigger mating. Every light that worked had strong green
  (505–540 nm), so the visible channel carries the mating signal.
- Cage 1 changes four things at once (total hours, blue hours, timing and total
  light) in a single cage, so any difference cannot be pinned on the blue cap.
  A cleaner design keeps visible identical across cages, varies only blue, splits
  each pupae batch across all three cages, and rotates treatments between cages.
- Same-age cohorts mattered more than lighting in the one study that compared
  them (about 6.6× more trapped eggs; unreviewed preprint).
- Intensity should be measured per channel in µmol/m²/s at cage level; lux
  under-counts blue and UV.

---

## 6. Setpoint and lighting history

Reconstructed from the git history of `src/configs/config.json` in tryento-app.
**The reason for each change was never recorded** — add it here when known. Light
values are hours per channel (cage 1 / cage 2 / cage 3).

| Date | Temp target ± | RH target ± | Lights (h) | Other changes |
|---|---|---|---|---|
| 2025-03-01 | 28 ± 2 | 70 ± 5 | 8 / 12 / 16 | First config with per-cage vars |
| 2025-06-12 | cage 1: 32 ± 2; others 28 ± 2 | cage 1: 72 ± 2; others 70 ± 5 | 12 / 12 / 16 | On-boot script added |
| 2025-08-12 | 31 ± 1 | 72 ± 2 | 12 / 14 / 16 | — |
| 2025-09-08 | 31 ± 1 | 72 ± 5 | 12 / **0** / 16 | Cage 2 lights off |
| 2025-10-23 | 31 ± 1 | 72 ± 5 | 12 / 12 / 12 | — |
| 2026-02-17 | **33** ± 1 | 72 ± 3 | 12 / 12 / 12 | — |
| 2026-04-11 | **30** ± 1 | 72 ± 3 | two channels: 14 + 8 | Blue and warm lights split onto separate relays |
| 2026-04-13 | 30 ± 1 | 72 ± 3 | 8 + 14 | Light pins reassigned |
| 2026-04-14 | 30 ± 1 | 72 ± 3 | 8 + 14 | Two sensors per cage, averaged |
| 2026-04-23 | 30 ± 1 | 72 ± 3 | 8 + 14 | Cage 3 second sensor on pin 18 — **current `main`** |
| 2026-09-16 | — | — | cage 1 windowed (§5.2) | Branch 55, not merged |

🔬 30 °C sits at the egg-output optimum in the literature. The 32–33 °C periods
sit on the declining side (research notes 01 and 02).

`src/configs/config.json.backup` in tryento-app is an older snapshot: 33 °C, one
sensor per cage, one 14 h light per cage, exterior sensors on pins 26 and 23.

---

## 7. Environment data pipeline

### 7.1 Record written per environment per cycle

```jsonc
{
  "uid": "uuid4",                 // also the Mongo _id on branch 50
  "ts": 1784264128.35,            // Unix epoch seconds, UTC
  "t": 30.4, "h": 72.2,           // averaged reading
  "individual_readings": [ {"t":…,"h":…,"ts":…,"uid":…}, … ],
  "env_id": 1, "type": "cage",
  // cages only:
  "vars": {"temp":30,"humi":72,"deviation":{"temp":1,"humi":3}},
  "intake": false, "exhaust": false, "atomizer": false, "heating": false,
  "fixtures": [ {"pin":27,"state":true}, {"pin":9,"state":true} ]
}
```

- `individual_readings` holds each sensor's **last good** reading. When a sensor
  fails this cycle, its entry is from an earlier cycle; check its `ts`.
- **Volume:** about 4,320 records per cage per day plus 720 per exterior sensor,
  so **about 14,400 documents/day, or about 5.3 million a year.**

### 7.2 Storage

| Layer | `main` | Branch `50` (2026-06-29, not merged) |
|---|---|---|
| Remote | MongoDB Atlas, db `devices`, collection `records` (mock mode: db `mockup`) | Self-hosted MongoDB on a Hostinger VPS; `_id = uid`; duplicates count as success |
| Local buffer | Redis, key = `uid`, value = Python `str(dict)` | Redis, JSON values (reads legacy format too); flush runs in background |
| Reconnect | Every 45 s | Same |

Credentials live in `.env` (`username`, `password`, `REDIS_HOST`, `REDIS_PORT`).
The Redis buffer has **no size limit**; a long outage fills the Pi's RAM.

⚠ CONFIRM which branch is actually running on the Pi and which MongoDB receives
data today.

### 7.3 Dashboards

| Dashboard | Where | State |
|---|---|---|
| Flask panel | `http://<pi-ip>:5000`, LAN only, no login | `main`: read-only, refreshes every 5 s |
| Flask **Dashboard v2** | Branch `52` (2026-08-03, not merged) | Status colours (in range / adjusting / stale after 6 missed cycles), gauges, sensor-disagreement warning (2 °C / 10 % RH), **manual overrides** behind `WEB_USER`/`WEB_PASSWORD`: 20 min max per override, 30 min per device per hour, each switch costs at least 5 min. Guide: `DASHBOARD.md` on that branch. |
| Streamlit | `Tryento/Dashboard-demo` | Reads `devices.records` and the production-log views (§9) |

There is **no alerting** anywhere. Nothing notifies anyone when a cage goes out
of range or stops reporting.

---

## 8. Production log (this repo)

Offline-first PWA used by operators on phones in the shed. Full engineering
detail: [`README.md`](../README.md), [`DEPLOY.md`](../DEPLOY.md). Summary for the
lab:

| Aspect | Value |
|---|---|
| Replaces | AppSheet app on the Google Sheet `Tryento_App_Data` (in use until September 2026) |
| Backend | Supabase Postgres, schema `app`; migrations in `supabase/migrations/` (append-only). `0010_ciclo_nuevo.sql` rebuilt it for the October 2026 protocols (run in production on 2026-10-22) |
| Tabs | Inicio (what is due today), Larvas, Insectarios, Horno, Alimento, Resumen (the lab in numbers, §9) |
| History | The AppSheet sheet goes, as it was, into schema `historico` (read-only, not used by the app) — ⚠ not loaded yet |
| Device storage | IndexedDB (`tryento-ciclo`); every write is local first, then synced through an outbox |
| Login | None in the demo configuration; the database is open (RLS with permissive policies) |
| Photos | Supabase Storage bucket `fotos` (public in the demo); one per record |
| Time | Calendar days in `America/Caracas`; instants in UTC |
| Deployment | Netlify, publishing only `dist/` (explicit allow-list) |

### 8.1 Tables

Two groups in one database. **Objects** exist and are active or inactive;
**registries** say what happened, when and who. Every table carries the sync
columns, a note, a photo, who corrected it last and when, and when it was
reviewed.

| Table | Group | One row = | Key fields |
|---|---|---|---|
| `rack` | object | a rack | `codigo` |
| `contenedor` | object | an ensilado container | `codigo` |
| `jaula` | object | a cage (insectario) | `nombre`, `letra`, `lugar`, `generacion_inicial` / `fase_inicial` (as registered); `fase`, `generacion`, `ciclo_desde` kept by trigger |
| `incubadora` | object | one recolecta's incubadora | `codigo`, `jaula_id`, `generacion`, `recolecta_at`, `dia0`, `excepcion`, `rack_id`, `peso_inicial_g`, `alimento_inicial_kg`, `estado` |
| `caja` | object | one caja de engorde | `codigo`, `incubadora_id`, `rack_id`, `peso_inicial_kg`, `estado` |
| `cochada` | object | one oven run | `codigo`, `horno_at`, `peso_inicial_kg`, `estado` |
| `bandeja_pupacion` | object | one tray of the 2 % into a cage | `codigo`, `ingreso_id`, `jaula_id`, `rack_id`, `peso_kg` |
| `ensilado` | object | one ensilado | `codigo`, `contenedor_id`, `ensilado_at`, `dia0`, `abierto_at` |
| `recepcion` | registry | a delivery | `material`, `kg` |
| `ensilado_insumo` | registry | kg of a reception in an ensilado | `ensilado_id`, `recepcion_id`, `kg` |
| `chequeo` | registry | a scheduled check | `incubadora_id` or `caja_id`, `dia`, `humedad_pct`, `temperatura_c`, `peso_g` / `peso_kg` |
| `distribucion` | registry | an incubadora's distribución | `incubadora_id`, `peso_total_kg` |
| `alimentacion` | registry | a carga of a caja | `caja_id`, `carga`, `kg`, `kg_plan`, `dia_plan` |
| `separacion` | registry | a caja's separación | `caja_id`, `peso_total_kg`, `pct_coccion`; `coccion_kg`, `retorno_kg` generated |
| `cochada_origen` | registry | kg of a separación's 98 % in a cochada | `cochada_id`, `separacion_id`, `kg` |
| `cochada_lectura` | registry | the mid or final oven reading | `momento`, `temperatura_c`, `peso_kg` (final) |
| `ingreso` | registry | a cage repopulated | `jaula_id`, `kg_larvas`, `generacion` (the cage's new one) |
| `jaula_evento` | registry | a cierre or limpieza | `jaula_id`, `tipo` |
| `movimiento` | registry | an object changing rack | `objeto`, `objeto_id`, `rack_desde`, `rack_hasta` |
| `catalogo` | support | a pick-list value | `tipo`, `valor` |
| `parametro` | support | a protocol setting | `clave`, `valor` (JSON), `descripcion` |

Calls for the actions that write several rows at once: `distribuir`,
`crear_cochada`, `ingresar` (only into a clean cage), `crear_ensilado`; plus
`abrir_ensilado`, `cerrar_objeto`, `editar` (an allowlist per table; codes are
never editable) and `marcar_revisado`.

**Settings** (`parametro`): chequeo days 3 / 10 / 14; distribución día 7; cargas
7 / 10 / 13 at 1.5 / 2 / 2 kg; ayuno from día 14; separación día 16; 98 % to the
oven; 4.7 kg per pupation tray; cage cycle 14 days; recolecta Mon/Wed/Fri;
maturing 21 days; consumption 72 h; the incubadora's usual initial food (⚠ to be
set before go-live).

### 8.2 Data caveats

- **Nothing from before October 2026 is in the app's tables**: 0010 removed
  the earlier protocols' data (little real data had been entered). The AppSheet
  history goes to `historico`, unconverted.
- Larvae already in incubadoras or cajas at go-live are entered as recolectas
  with a past date (excepción); steps due before they were entered are not
  chased. Cages with flies at go-live have no cycle start date: their cierre
  reminder starts with their next cycle.
- Ensilados maturing at go-live are not entered; until the first one made in
  the app opens, feedings are "sin ensilado".

---

## 9. KPIs and how they are computed

The views of the earlier protocols (`0002_views.sql` and later) were removed
with their tables in `0010`. Everything here is computed on the phone, from the
same picture of the lab every screen uses (`src/data/vista.js`); nothing is
stored, so a correction moves every figure that depended on it.

| Quantity | Computed from | Notes |
|---|---|---|
| Age (days) | `dia0` of the incubadora → its cajas | Farm days, `America/Caracas` |
| 98 % / 2 % of a separación | `peso_total_kg × pct_coccion / 100`, rounded to the gram | Stored by the database as generated columns |
| 98 % waiting for the oven | Σ `coccion_kg` − Σ `cochada_origen.kg`, per separación | Never negative; an over-assigned separación is a "revisar" |
| 2 % waiting | Σ `retorno_kg` − Σ `ingreso.kg_larvas`, oldest first | Each repopulation's ages (range, simple average) and generation from the cajas it drew on |
| Food used per ensilado | Every feeding (initial food + cargas) drawn from the oldest open ensilado | Leftover at 72 h = discarded |
| Raw material in store | Σ `recepcion.kg` − Σ `ensilado_insumo.kg`, per material | — |
| Oven weight loss | `1 − final kg / initial kg` per cochada | Shown on the cochada page; note 05 🔬 |

### 9.1 The Resumen tab

The app's **Resumen** tab (`src/data/resumen.js`) shows the lab in three parts:

- **Ahora** — cages with flies and their generations, active incubadoras and
  cajas (their days; how many in ayuno), cochadas in the oven, the 98 % and the
  2 % waiting, kg left in the open ensilado, raw material not yet ensiled, late
  steps and records to review. Each tile opens the tab it lives on.
- **Últimas 8 semanas** — g recolectados and kg separados per week, Monday to
  Sunday on the farm's calendar; a tap on a week reads it, and a table has every
  number.
- **Rendimiento** — over the last 7 days, the last 30 days or everything (farm
  days, today included):

| KPI | Definition | Notes |
|---|---|---|
| kg separated per g recolectado | Σ separación `peso_total_kg` ÷ Σ incubadora `peso_inicial_g`, over the incubadoras whose cycle **ended** in the period | A cycle ends when its last caja is separated or closed, or when the incubadora is closed before distribución. Early closures count, so losses lower the yield |
| Growth in the cajas | Σ kg separated ÷ Σ `distribucion.peso_total_kg`, same incubadoras | Shown as ×N |
| FCR | (Σ `alimento_inicial_kg` + Σ cargas) ÷ Σ kg separated, same incubadoras | **Wet basis** 🔬 — published FCRs are usually dry matter (note 04); not comparable without the feed's and the larvae's moisture |
| Día of distribución / separación | Average of (event's farm day − día 0) over the distributed incubadoras / separated cajas of those cycles | Against the plan: `dia_distribucion`, `dia_separacion` |
| Separaciones | Count, kg, 98 % and 2 % of those dated in the period | — |
| Chequeos | Average, minimum and maximum substrate humidity and temperature | All chequeo days together |
| Closed early | Incubadoras, cajas, cochadas and trays closed early in the period | — |
| Recolectas per cage | Count and g of the recolectas dated in the period, per cage | — |
| Cage cycle | Days from repopulation to cierre, and recolectas and g in between, averaged over the cycles closed in the period | A cage that had flies when the app started has no first cycle |
| Repopulations | Count, kg of 2 % larvae, trays | — |
| Oven yield | Σ final kg ÷ Σ initial kg of the cochadas finished in the period, and the range per cochada | Weight loss = 100 % − yield (note 05 🔬) |
| Ensilado eaten | kg eaten ÷ kg made, over the ensilados whose 72 h ended in the period | The rest was discarded |
| Food | kg given (initial food + cargas), of which with no open ensilado; kg received per material; ensilados made | — |

Still missing: these as views in the database. The Streamlit dashboard reads
the database, so its production section stays empty until they exist.

### 🔬 The 50,000 individuals/kg factor

The factor implies **20 mg per individual**. Published fresh weights are about
**150 mg per pupa** (about 6,500/kg) and **47–80 mg per adult** (about
12,000–20,000/kg). Any per-female figure derived from it is therefore too low.
**Fix:** weigh 3 × 100 counted pupae (or adults) at every colony start and
replace the constant with a measured one. Research notes 01 and 03.

### 🔬 Eggs per gram

Five independent measurements put an egg at 25–29 µg: **about 38,000 eggs/g**,
or roughly 26,000–36,000 hatched larvae per gram. A figure of about 77,000/g
comes from a single study. Count the farm's own eggs per gram before relying on
egg mass to set tray density (note 03).

---

## 10. Known issues and risks

Lab-relevant issues, highest impact first. Code-quality detail is in
tryento-app `.planning/codebase/CONCERNS.md`.

| # | Issue | Impact | Where |
|---|---|---|---|
| 1 | **No alerting** on out-of-range, stale data or controller crash | A cage can overheat or dry out unnoticed overnight | Controller, dashboards |
| 2 | **No auto-restart** (no systemd unit) | One crash stops climate control until someone notices | `on_boot.sh` |
| 3 | Exterior sensors both on BCM 0 | No valid outside reference | `config.json` |
| 4 | No hysteresis or minimum on/off time | Relay chatter and wear at band edges | `environment.py` |
| 5 | Band (±1 °C / ±3 % RH) about equal to sensor error | Control reacts to noise | Config and hardware |
| 6 | Larval trays unmonitored | Tray-core overheating goes unseen | Hardware gap |
| 7 | Unbounded Redis buffer | Long outage can exhaust Pi RAM | `db_handler.py` |
| 8 | Three unmerged feature branches (`50`, `52`, `55`) | Unclear what runs in production | Git |
| 9 | Pi timezone unverified | Every light window shifts if it is wrong | Pi OS |
| 10 | The dashboard reads the sensors again each cycle | The value shown can differ slightly from the value used for control | `web_panel.py` |
| 11 | Production database open with no login (demo) | Anyone with the URL can edit records | Supabase |
| 12 | No link between `env_id` and `jaula` | Climate cannot be joined to recolecta output | Both systems |
| 13 | No production KPI views in the database since 0010 | The app's Resumen tab computes the KPIs on the phone, but the dashboard's production section stays empty until views exist (§9) | Supabase |

---

## 11. Open questions to confirm

Tick these off and move the answers into the relevant section.

- [ ] Raspberry Pi model, OS version, and timezone set to `America/Caracas`.
- [ ] Which code runs on the Pi: `main`, or branch `50` / `52` / `55`?
- [ ] Which MongoDB receives data today: Atlas or the Hostinger VPS?
- [ ] Mapping `env_id` 1/2/3 ↔ the cages (`ICA`/`ICB`/`ICC`…); what is `JN3A`?
- [ ] Light channel mapping per cage (which pin is visible, which is blue), LED
      model, spectrum, and intensity at cage level in µmol/m²/s.
- [ ] Are the exterior sensors wired, and to which pins?
- [ ] Relay module polarity (active-high or active-low) and relay ratings.
- [ ] Cage dimensions, volume, mesh, and fly density at loading.
- [ ] Heater, atomizer and fan models and ratings.
- [ ] Sensor placement inside each cage.
- [ ] *Bagazo* = brewer's spent grain or sugarcane bagasse? Source and supplier.
- [x] ~~*Yogurt* feed: what exactly?~~ — not a material in the October 2026 protocols.
- [ ] Tray dimensions and material; the rearing room's climate (controlled or
      ambient?).
- [ ] Oven type, temperature profile and loading; is there a blanching or kill
      step before drying? (The app records the initial weight, a mid temperature, and the final temperature and weight.)
- [ ] Packaging (bag type, vacuum, oxygen absorber) — the oven QC grades were dropped in October 2026; packing is not built yet.
- [x] ~~Does `biomasa_kg` record pupae or adults?~~ — colony biomass is no longer recorded (October 2026).
- [ ] Customers and end use (poultry, fish, pets…) and any feed registration in
      Venezuela.
- [ ] Why each setpoint change in §6 was made, and what was observed.

---

## 12. Keeping this document current

This document must change whenever the lab changes. Rules of thumb:

| When this happens | Update |
|---|---|
| `config.json` changes on the Pi (setpoints, pins, lights) | §3.3, §4, §5, and a new row in §6 with the **reason** |
| A lighting or climate experiment starts or ends | §5 and §6; record the result, even a null one |
| A feature branch is merged or deployed | §7 and §10; bump "Built from" in the header |
| A new material, or a change in the protocol settings | §2 and §8.1 |
| A new migration or KPI view | §8 and §9 |
| An open question is answered | Move the answer into its section; tick it in §11 |
| Research contradicts a lab assumption | Add a 🔬 flag in the relevant section and a line in the research knowledge base |

Every edit adds a line to §13. Keep the version in the header in step with it:
bump the minor version for new content, the patch version for corrections.

---

## 13. Changelog

| Date | Version | Change |
|---|---|---|
| 2026-09-29 | 0.1 | First draft from tryento-app (`main` + branches 50, 52, 55, Trunk) and this repo's schema, views and README. Cross-referenced with research notes 01–06. |
| 2026-09-29 | 0.2 | Added §2.1, the v2 protocol (16-day cycle), and renamed the old process §2.2. **Reason:** the lab switched to a fixed recipe on a fixed calendar (document *"Régimen de alimentación optimizado"*); the production log implements it in migration `0007_protocolo_v2.sql` (pending deployment). Also: v2 feed identified as BSG ensilaje (partly answers the *bagazo* question in §11 for v2), new tables/columns (§8.1), protocol-split views, the `v_productividad_insectario` egg-sum fix and new data-quality flags (§9). |
| 2026-09-29 | 0.3 | Added feed tracking (§2.1 "Feed: from delivery to the load", catalogue `material_alimento`, four tables in §8.1, three views in §9). **Reason:** the lab now feeds a standardized ensilaje in fixed loads, so the question moved from "how much did each tray get" to "what came in, which batch is fermenting, and how long does what is ready last"; migration `0008_alimento.sql` (pending deployment). Also noted in §9 that day counts use the farm's day, not the server's (a correction made to `0007` before it ran anywhere). |
| 2026-09-30 | 0.4 | Bed temperature on días 11–12 is now recorded (`revision.temperatura_c`) and the home screen lists what the plan says is due (§2.1, §8.1, §9). **Reason:** the protocol's 36 °C limit had no record, and the fixed calendar means the app can tell each day what is late, due or coming; migration `0009_monitor.sql` (pending deployment). |
| 2026-10-21 | 0.5 | Rewrote §2, §8 and §9 for the protocols defined with the lab on 19–20 October 2026: the larvae cycle (recolecta → incubadora → distribución into cajas → chequeos días 3/10/14 and cargas 7/10/13 → separación 98 % horno / 2 % back → cochada; the 2 % into pupation trays repopulating a closed and cleaned cage), the cage cycle (one generation per cycle) and the food (recepción → ensilado → 21 days → apertura → 72 h, oldest open ensilado first). Objects vs registries, codes that never change, corrections with "revisar". **Reason:** the earlier protocols (v1 and the "16-day v2") followed the wrong flow and asked for data the lab does not need; migration `0010_ciclo_nuevo.sql` rebuilds the schema and removes their data (pending deployment); the AppSheet history goes to schema `historico`. The views of §9 went with the old tables; new KPI views are still to be built. |
| 2026-10-22 | 0.6 | §9.1: the KPIs are now computed in the app's new **Resumen** tab — what there is now, the last eight weeks, and yield per g recolectado, growth in the cajas, FCR (wet basis), cycle days against the plan, recolectas per cage and per cage cycle, oven yield and ensilado eaten over 7 days, 30 days or everything — each with its definition. §8: the six tabs. §2 and §8: `0010` ran in production on 22 October 2026, deleting the earlier protocols' data. **Reason:** the lab asked for a tab with the stats and an overview of the lab and its performance, and for the old data to be deleted. |
