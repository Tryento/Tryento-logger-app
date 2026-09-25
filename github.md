# Source repository

repo: Tryento/Dashboard-demo
branch: main
path: (whole repo — README.md, .streamlit/config.toml, 4_scripts/dashboard_v3.py, img/logo.png)

note: the link given in chat (Tryento/tryento-app) does not exist on GitHub. The two
Tryento repos visible to this connection are `Dashboard-demo` and `tryento-data-dash`
(same Streamlit environment dashboard; Dashboard-demo is the fuller copy). Brand and
farm facts below were read from Dashboard-demo.

## Last sync

date: 2026-08-13T20:27:00Z

### Updated in this project
- Brand tokens taken from `.streamlit/config.toml` + `dashboard_v3.py`: green #22C55E, dim green #15803D, black #0A0A0A, panel #141C16, text #EAF7EC, muted #9FB8A6, on-green text #061308.
- Type set to Inter (the dashboard's imported family); IBM Plex Mono kept for batch/generation codes.
- Header now carries the Tryento wordmark + `img/logo.png` mark over a 2px green rule, mirroring `.tryento-header`.
- Cage locations renamed to `Cage-1…Cage-3` to match `env_id` / `env_type: "cage"` in the sensor collection `devices.records`.

## Farm facts used

- Sensor devices write one document per reading to MongoDB `devices.records`: `ts`, `env_id`, `env_type`, `t` (°C), `h` (%), and boolean equipment states `intake`, `exhaust`, `atomizer`, `heating`.
- Enclosures are cages, addressed by `env_id` (1–3 in the demo data) and labelled "Cage N" in the dashboard.
- Environment/sensor analysis stays in the Streamlit dashboard; this app only logs production events (per the brief).

## Screen map

| Screen (in BSF Production Log.dc.html) | Built from |
|---|---|
| App header / wordmark | `4_scripts/dashboard_v3.py` (`.tryento-header`, BRAND_* constants), `img/logo.png` |
| Whole-app palette + type | `.streamlit/config.toml`, `dashboard_v3.py` `_THEME_CSS` |
| Location pickers (cage areas) | `dashboard_v3.py` cage handling (`env_id`, "Cage N" labels) |
| All other screens (quick log, batches, batch detail, log event, harvest, processing, generations) | project brief + `dataClient.js` mock layer |
