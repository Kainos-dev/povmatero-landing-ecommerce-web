-- Verificación (SOLO LECTURA) después de aplicar
--   supabase/migrations/20261113000000_shelf_order.sql
-- No modifica nada. Correr cada consulta por separado en el SQL Editor.

-- 1. Estructura y permisos: todas las columnas tienen que dar true.
select
  to_regclass('public.shelf_brands') is not null                                           as tabla_marcas,
  (select relrowsecurity from pg_class where oid = 'public.shelf_brands'::regclass)         as rls_marcas,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 21              as vista_con_21_columnas,
  (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position > 18)
    = 'shelf_other,shelf_position,brand_position'                                           as columnas_nuevas_al_final,
  exists (select 1 from pg_trigger where tgname = 'products_shelf' and tgrelid = 'public.products'::regclass)
                                                                                            as trigger_activo,
  -- Nadie escribe directo en la tabla de marcas ni en el lugar de las yerbas.
  not has_table_privilege('anon', 'public.shelf_brands', 'insert, update, delete')          as anon_no_escribe_marcas,
  not has_table_privilege('authenticated', 'public.shelf_brands', 'insert, update, delete') as clientes_no_escriben_marcas,
  not has_column_privilege('authenticated', 'public.products', 'shelf_position', 'update')  as lugar_no_editable_directo,
  not has_column_privilege('anon', 'public.products', 'shelf_other', 'update')              as anon_no_cambia_casilla,
  has_table_privilege('anon', 'public.shelf_brands', 'select')                              as tienda_lee_marcas,
  not has_function_privilege('anon', 'public.admin_set_shelf_brand_order(text[], text[])', 'execute')
                                                                                            as anon_no_ordena_marcas,
  not has_function_privilege('anon', 'public.admin_set_shelf_product_order(text, bigint[], bigint[])', 'execute')
                                                                                            as anon_no_ordena_yerbas;

-- 2. Datos: todas las columnas tienen que dar true.
with y as (
  select p.* from public.products p join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
)
select
  -- Cada marca de yerba tiene su fila, y con la misma escritura.
  not exists (select 1 from y left join public.shelf_brands b on b.key = public.shelf_brand_key(y.brand)
               where y.brand is not null and (b.key is null or b.name <> y.brand))          as marcas_registradas,
  -- Posiciones de góndola 1, 2, 3… sin huecos ni repetidas.
  (select coalesce(bool_and(position = n), true)
     from (select position, row_number() over (order by position) n from public.shelf_brands) s)
                                                                                            as orden_marcas_continuo,
  -- Nadie arrancó en «Otras marcas» por la casilla.
  not exists (select 1 from y where shelf_other)                                            as casilla_desmarcada,
  -- Cada yerba tiene lugar y no hay lugares repetidos dentro de una góndola.
  not exists (select 1 from y where shelf_position < 1)                                      as yerbas_con_lugar,
  not exists (select 1 from y
               group by (case when shelf_other or brand is null then '' else public.shelf_brand_key(brand) end), shelf_position
              having count(*) > 1)                                                          as lugares_sin_repetir;

-- 3. Orden de las góndolas (tiene que ser el mismo de antes: Canarias, Rei
--    Verde, Sara, Armiño, el resto alfabético; «Otras marcas» va al final y no
--    es una fila).
select b.position as posicion, b.name as marca, b.key as clave,
       count(p.id) filter (where p.is_active and not p.shelf_other) as yerbas_publicadas_en_su_gondola
  from public.shelf_brands b
  left join public.products p on public.shelf_brand_key(p.brand) = b.key
 group by b.position, b.name, b.key
 order by b.position;

-- 4. Yerbas por góndola, en el orden de /yerbas (compararlo con la consulta 3
--    de antes: tiene que coincidir).
select coalesce(b.position, 100000) as orden_gondola,
       case when p.shelf_other or b.key is null then 'Otras marcas' else b.name end as gondola,
       p.shelf_position as lugar, p.id, p.name, p.brand as marca_real, p.is_active as publicada
  from public.products p
  join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
  left join public.shelf_brands b on b.key = public.shelf_brand_key(p.brand) and not p.shelf_other
 order by orden_gondola, lugar, p.id;

-- 5. Resumen: tiene que dar exactamente lo mismo que la consulta 4 de antes.
select
  (select count(*) from public.products)                    as productos,
  (select count(*) from public.product_variants)            as presentaciones,
  (select coalesce(sum(price), 0) from public.product_variants) as suma_precios,
  (select coalesce(sum(stock), 0) from public.product_variants) as suma_stock,
  (select count(*) from public.inventory_movements)         as movimientos,
  (select count(*) from public.orders)                      as pedidos,
  (select count(*) from public.product_images)              as imagenes,
  (select count(*) from public.products where shelf_image is not null) as imagenes_gondola;
