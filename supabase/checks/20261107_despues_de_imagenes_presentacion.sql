-- Verificación (SOLO LECTURA) después de aplicar
--   20261107000000_variant_shelf_images.sql
-- No modifica nada. Son dos consultas: correlas por separado.

-- 1) Todas las columnas tienen que dar true.
select
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'product_variants' and column_name = 'shelf_image')
                                                                                           as columna_de_presentacion,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 18
    and (select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 17) = 'shelf_image'
    and (select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 18) = 'variant_shelf_image'
                                                                                           as vista_con_variant_shelf_image_al_final,
  has_column_privilege('anon', 'public.product_variants', 'shelf_image', 'select')         as tienda_lee_imagen_de_presentacion,
  has_column_privilege('authenticated', 'public.product_variants', 'shelf_image', 'update') as panel_actualiza_imagen_de_presentacion,
  not has_column_privilege('anon', 'public.product_variants', 'shelf_image', 'update')     as anon_no_actualiza,
  -- Sigue igual: stock solo por movimientos y la tienda muestra lo disponible
  not has_column_privilege('authenticated', 'public.product_variants', 'stock', 'update')  as stock_sigue_protegido,
  not exists (select 1 from public.storefront_catalog s
                join public.product_variants v on v.id = s.variant_id
                left join public.variant_commitments() cm on cm.variant_id = s.variant_id
               where s.stock is distinct from
                     case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0) end)
                                                                                           as stock_mostrado_correcto,
  -- La imagen general de cada yerba sigue igual (la migración no la toca)
  not exists (select 1 from public.storefront_catalog s
                join public.products p on p.id = s.product_id
               where s.shelf_image is distinct from p.shelf_image)                        as imagen_general_intacta;

-- 2) Presentaciones de yerbas y qué imagen usa cada una en /yerbas.
select p.id as producto, p.name, v.id as presentacion, v.name as presentacion_nombre,
       case when v.shelf_image is not null then 'propia'
            when p.shelf_image is not null then 'general del producto'
            else 'paquete genérico' end as imagen_en_gondola
  from public.products p
  join public.categories c on c.id = p.category_id
  join public.product_variants v on v.product_id = p.id
 where c.slug = 'yerbas'
 order by p.name, v.sort_order, v.id;
