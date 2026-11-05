-- Verificación (SOLO LECTURA) antes de aplicar
--   supabase/migrations/20261113000000_shelf_order.sql
-- No modifica nada. Correr cada consulta por separado en el SQL Editor.

-- 1. Requisitos: todas las columnas tienen que dar true.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 18             as vista_con_18_columnas,
  (select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 18) = 'variant_shelf_image'
                                                                                            as variant_shelf_image_al_final,
  exists (select 1 from information_schema.columns
           where table_schema = 'public' and table_name = 'products' and column_name = 'brand')
                                                                                            as marca_existe,
  exists (select 1 from public.categories where slug = 'yerbas')                            as categoria_yerbas,
  to_regclass('public.shelf_brands') is null                                                as tabla_libre,
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'products'
                 and column_name in ('shelf_other', 'shelf_position'))                      as columnas_libres,
  not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where (n.nspname, p.proname) in (('public', 'shelf_brand_key'), ('private', 'shelf_group'),
                     ('private', 'products_shelf'), ('public', 'admin_set_shelf_brand_order'),
                     ('public', 'admin_set_shelf_product_order')))                          as funciones_libres,
  -- Marcas sin letras ni números: la migración se cancelaría. Tiene que dar true.
  not exists (select 1 from public.products
               where brand is not null
                 and regexp_replace(translate(lower(btrim(brand)), 'áàâäãåéèêëíìîïóòôöõúùûüñç', 'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]+', '', 'g') = '')
                                                                                            as marcas_validas;

-- 2. Marcas de yerbas que se van a registrar, con el orden inicial (el de hoy)
--    y las escrituras distintas que se unifican (si «escrituras» tiene más de
--    una, todas pasan a «nombre»).
with y as (
  select p.id, p.is_active, regexp_replace(btrim(p.brand), '\s+', ' ', 'g') as brand,
         regexp_replace(translate(lower(btrim(p.brand)), 'áàâäãåéèêëíìîïóòôöõúùûüñç', 'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]+', '', 'g') as key
    from public.products p join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
   where p.brand is not null
),
s as (select key, brand, count(*) n, min(id) first_id from y group by key, brand),
canon as (select distinct on (key) key, brand as name from s order by key, n desc, first_id)
select row_number() over (order by coalesce(array_position(array['canarias', 'reiverde', 'sara', 'armino'], c.key), 1000), lower(c.name), c.key) as posicion,
       c.name as nombre,
       c.key  as clave,
       (select string_agg(format('%s (%s)', s.brand, s.n), ', ' order by s.n desc) from s where s.key = c.key) as escrituras,
       (select count(*) from y where y.key = c.key) as yerbas,
       (select count(*) from y where y.key = c.key and y.is_active) as publicadas
  from canon c
 order by posicion;

-- 3. Orden actual de /yerbas (para comparar después): góndola y yerbas por sort_order, id.
select coalesce(nullif(btrim(p.brand), ''), 'Otras marcas') as gondola,
       row_number() over (partition by coalesce(nullif(btrim(p.brand), ''), 'Otras marcas') order by p.sort_order, p.id) as lugar,
       p.id, p.name, p.is_active as publicada
  from public.products p join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
 order by gondola, lugar;

-- 4. Resumen para comparar después: nada de esto tiene que cambiar.
select
  (select count(*) from public.products)                    as productos,
  (select count(*) from public.product_variants)            as presentaciones,
  (select coalesce(sum(price), 0) from public.product_variants) as suma_precios,
  (select coalesce(sum(stock), 0) from public.product_variants) as suma_stock,
  (select count(*) from public.inventory_movements)         as movimientos,
  (select count(*) from public.orders)                      as pedidos,
  (select count(*) from public.product_images)              as imagenes,
  (select count(*) from public.products where shelf_image is not null) as imagenes_gondola;
