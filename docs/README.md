# Tryento lab documentation

Living documentation for the Tryento black soldier fly lab. Nothing in `docs/`
is published by the build (`tools/build.mjs` copies an explicit allow-list into
`dist/`).

| Document | What it is | Update it when |
|---|---|---|
| [protocolo.html](protocolo.html) | The production protocols, in Spanish, for the lab: the larvae cycle, the insectario, the food, what is recorded at each task, codes, corrections | The lab changes a protocol (and LAB_SPEC §2 with it) |
| [LAB_SPEC.md](LAB_SPEC.md) | How the lab is built, configured and operated: cages, sensors, pins, setpoints, lighting, data pipeline, production process, KPIs, open questions | The lab, the controller config or the production process changes |
| [reports/Black soldier fly farms and biology.md](reports/Black%20soldier%20fly%20farms%20and%20biology.md) | Research knowledge base: BSF biology, adult mating and light, colonies and eggs, larval rearing, processing and regulation, industry and automation | New research is done, or lab results confirm or contradict it |
| [research_notes/Black soldier fly farms and biology/](research_notes/Black%20soldier%20fly%20farms%20and%20biology/) | Source notes behind the knowledge base, with every citation | Only when new research is added (never rewrite old notes; add a new file) |

## How these documents evolve

1. **The lab spec follows the lab.** Any change to `config.json` on the Pi, a
   new experiment, a merged branch or a new catalogue value gets reflected in
   `LAB_SPEC.md` in the same week, with a changelog line and the *reason*.
2. **The knowledge base follows the evidence.** When a lab result confirms or
   contradicts a published figure (eggs per gram, weight per pupa, FCR,
   oven yield), record the farm's own number next to the literature value in
   the knowledge base's "Tryento measured values" section.
3. **Cross-link, don't duplicate.** The lab spec states what *is*; the
   knowledge base states what the literature says it *should* be. Flags marked
   🔬 in the lab spec point from one to the other.
4. **New research is additive.** Put new notes in a new file under
   `research_notes/` (next number), then update the knowledge base.
