-- =====================================================================
-- Povmatero — Lectura de objetos del bucket product-images para admins
--
-- Por qué: Supabase Storage exige permiso SELECT (además de DELETE) para
-- borrar un archivo. Sin esto, el panel no puede eliminar archivos que ya
-- no se usan.
--
-- Qué NO cambia:
--   * El público sigue viendo las imágenes solo por URL directa (bucket público).
--   * anon y usuarios logueados que no son admin siguen sin poder listar,
--     subir, modificar ni borrar archivos.
-- =====================================================================

create policy "product-images: admins leen objetos"
  on storage.objects for select to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()));
