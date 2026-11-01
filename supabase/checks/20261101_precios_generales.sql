-- Verificación (SOLO LECTURA) después de aplicar
-- supabase/migrations/20261101000000_product_pricing.sql. No modifica nada.
--
-- 1) Resumen: cuántos productos quedaron con precio/costo general y cuántas
--    variantes los heredan.
select
  (select count(*) from public.products)                                  as productos,
  (select count(*) from public.products where base_price is not null)     as con_precio_general,
  (select count(*) from public.product_internal where base_cost is not null) as con_costo_general,
  (select count(*) from public.product_internal where sku is not null)    as con_sku,
  (select count(*) from public.product_variants)                          as variantes,
  (select count(*) from public.product_variants where price_inherited)    as heredan_precio,
  (select count(*) from public.product_variants where not price_inherited) as precio_particular;

-- 2) Control: ninguna variante que hereda puede tener un precio distinto del
--    general. Debe devolver 0 filas.
select p.name as producto, v.name as variante, v.price, p.base_price
from public.product_variants v
join public.products p on p.id = v.product_id
where v.price_inherited
  and p.base_price is not null
  and v.price <> p.base_price;
