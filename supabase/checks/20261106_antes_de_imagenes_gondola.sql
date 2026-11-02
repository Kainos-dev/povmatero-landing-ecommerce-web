-- Verificación (SOLO LECTURA) antes de aplicar
--   20261106000000_shelf_images.sql
-- No modifica nada. Todas las columnas tienen que dar true.
select
  -- Requisito: la migración de pedidos de yerbas ya está aplicada (la vista tiene «brand» al final)
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 16       as vista_con_16_columnas,
  (select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 16) = 'brand'
                                                                                      as brand_al_final,
  to_regprocedure('public.variant_commitments()') is not null                         as pedidos_de_yerbas_aplicados,
  -- Lo que va a crear la migración todavía no existe
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'products' and column_name = 'shelf_image')
                                                                                      as columna_shelf_image_libre;
