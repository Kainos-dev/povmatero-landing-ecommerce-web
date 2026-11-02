-- Verificación (SOLO LECTURA) antes de aplicar
--   20261107000000_variant_shelf_images.sql
-- No modifica nada. Todas las columnas tienen que dar true.
select
  -- Requisito: la imagen de góndola general ya está aplicada (shelf_image al final de la vista)
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 17            as vista_con_17_columnas,
  (select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 17) = 'shelf_image'
                                                                                           as shelf_image_al_final,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'products' and column_name = 'shelf_image')
                                                                                           as imagen_general_aplicada,
  -- Lo que va a crear la migración todavía no existe
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'product_variants' and column_name = 'shelf_image')
                                                                                           as columna_de_presentacion_libre;
