-- ============================================================================
-- Reference data.
--
-- Catalogues are data, not code: adding a fifth cage or a new feed type is a
-- row here, never a redeploy. In AppSheet these lists were buried in column
-- metadata, which is why nobody could change them without opening the editor.
--
-- There is deliberately NO operator table. `registrado_por` is plain text —
-- whatever name the person typed or tapped — so there is nothing to seed and
-- nothing that can reject a write because a device has not synced yet.
-- ============================================================================

set search_path = app, public;

insert into app.catalogo (id, tipo, valor, orden) values
  (gen_random_uuid(), 'nombre_insectario', 'ICA',  1),
  (gen_random_uuid(), 'nombre_insectario', 'ICB',  2),
  (gen_random_uuid(), 'nombre_insectario', 'ICC',  3),
  (gen_random_uuid(), 'nombre_insectario', 'JN3A', 4),

  (gen_random_uuid(), 'tipo_iniciador', 'Bagazo',  1),
  (gen_random_uuid(), 'tipo_iniciador', 'Afrecho', 2),
  (gen_random_uuid(), 'tipo_iniciador', 'Yogurt',  3),
  (gen_random_uuid(), 'tipo_iniciador', 'Otro',    4),

  (gen_random_uuid(), 'tipo_alimento', 'Bagazo',  1),
  (gen_random_uuid(), 'tipo_alimento', 'Yogurt',  2),
  (gen_random_uuid(), 'tipo_alimento', 'Afrecho', 3),
  (gen_random_uuid(), 'tipo_alimento', 'Mezcla',  4),

  (gen_random_uuid(), 'qc_color_dorado', 'Blando',         1),
  (gen_random_uuid(), 'qc_color_dorado', 'Poco Crujiente', 2),
  (gen_random_uuid(), 'qc_color_dorado', 'Muy Crujiente',  3),
  (gen_random_uuid(), 'qc_color_dorado', 'Tostado',        4),

  -- The people already registered. These appear as one-tap chips on every
  -- device. Anyone whose name is not here types it once on the name screen and
  -- it joins this list automatically, so the roster maintains itself.
  --
  -- To add someone from SQL instead:
  --   insert into app.catalogo (id, tipo, valor, orden)
  --   values (gen_random_uuid(), 'operario', 'Jose', 3)
  --   on conflict (tipo, valor) do nothing;
  --
  -- To retire someone (never delete — records reference the name):
  --   update app.catalogo set activo = false
  --    where tipo = 'operario' and valor = 'Jose';
  (gen_random_uuid(), 'operario', 'Maria',   1),
  (gen_random_uuid(), 'operario', 'Ricardo', 2)
on conflict (tipo, valor) do nothing;


-- ── photo storage ──────────────────────────────────────────────────────────
-- Public bucket for the demo, matching the rest of the setup: no signed URLs to
-- manage, photos just load. Flip `public` to false when the database is closed.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = excluded.public;

-- Anyone may read and write photos, same as the tables.
-- `upsert: true` on a retry issues an UPDATE, so that policy is required for
-- the photo upload lane to be idempotent after a lost acknowledgement.
drop policy if exists fotos_todo on storage.objects;
create policy fotos_todo on storage.objects
  for all to anon, authenticated
  using (bucket_id = 'fotos') with check (bucket_id = 'fotos');
