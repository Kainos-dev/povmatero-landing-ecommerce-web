-- Verificación (SOLO LECTURA) después de aplicar
--   20261106000000_shelf_images.sql
-- No modifica nada. Son dos consultas: correlas por separado.

-- 1) Todas las columnas tienen que dar true.
select
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'products' and column_name = 'shelf_image') as columna_shelf_image,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 17
    and (select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 16) = 'brand'
    and (select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 17) = 'shelf_image'
                                                                                      as vista_con_shelf_image_al_final,
  has_column_privilege('anon', 'public.products', 'shelf_image', 'select')            as tienda_lee_shelf_image,
  has_column_privilege('authenticated', 'public.products', 'shelf_image', 'update')   as panel_actualiza_shelf_image,
  not has_column_privilege('anon', 'public.products', 'shelf_image', 'update')        as anon_no_actualiza,
  -- La tienda sigue mostrando lo disponible (físico − comprometido)
  not exists (select 1 from public.storefront_catalog s
                join public.product_variants v on v.id = s.variant_id
                left join public.variant_commitments() cm on cm.variant_id = s.variant_id
               where s.stock is distinct from
                     case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0) end)
                                                                                      as stock_mostrado_correcto;

-- 2) Yerbas y su imagen de góndola (vacía = paquete genérico en /yerbas).
select p.id, p.name, coalesce(p.brand, 'Otras marcas') as marca, p.shelf_image
  from public.products p
  join public.categories c on c.id = p.category_id
 where c.slug = 'yerbas'
 order by marca, p.name;
