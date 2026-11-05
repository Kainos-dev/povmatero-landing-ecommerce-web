-- =====================================================================
-- SOLO EN CASO DE EMERGENCIA: deshace supabase/migrations/20261113000000_shelf_order.sql
--
-- Vuelve la vista storefront_catalog a sus 18 columnas y borra la tabla de
-- marcas, el trigger, las funciones y las columnas shelf_other / shelf_position.
-- Se PIERDE el orden configurado en el panel y la casilla «Otras marcas».
-- No toca precios, stock, presentaciones, imágenes ni pedidos. Las marcas que
-- la migración unificó («canarias» → «Canarias») quedan unificadas.
--
-- Después de correrlo, /yerbas vuelve sola al orden de antes (Canarias, Rei
-- Verde, Sara, Armiño, resto alfabético): el código nuevo lo detecta.
-- =====================================================================

begin;

-- Vista exactamente como en 20261107000000_variant_shelf_images.sql.
-- (Quitar columnas de una vista exige borrarla y crearla; se repiten sus permisos.)
drop view public.storefront_catalog;
create view public.storefront_catalog
with (security_invoker = true)
as
select
  p.id          as product_id,
  p.slug        as product_slug,
  p.name        as product_name,
  p.description,
  c.slug        as category_slug,
  c.name        as category_name,
  cover.src     as cover_image,
  v.id          as variant_id,
  v.name        as variant_name,
  v.price,
  v.track_stock,
  case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0)::integer end as stock,
  vimg.src      as variant_image,
  p.sort_order  as product_sort,
  v.sort_order  as variant_sort,
  p.brand       as brand,
  p.shelf_image as shelf_image,
  v.shelf_image as variant_shelf_image
from public.products p
join public.categories c        on c.id = p.category_id
join public.product_variants v  on v.product_id = p.id
left join public.variant_commitments() cm on cm.variant_id = v.id
left join lateral (
  select i.src from public.product_images i
  where i.product_id = p.id and i.is_cover
  limit 1
) cover on true
left join lateral (
  select i.src from public.product_images i
  where i.variant_id = v.id
  order by i.sort_order, i.id
  limit 1
) vimg on true
where p.is_active and v.is_active and c.is_active;

revoke all on public.storefront_catalog from public, anon, authenticated;
grant select on public.storefront_catalog to anon, authenticated;

drop trigger products_shelf on public.products;
drop function private.products_shelf();
drop function public.admin_set_shelf_brand_order(text[], text[]);
drop function public.admin_set_shelf_product_order(text, bigint[], bigint[]);
drop function private.shelf_group(text, boolean);
drop function public.shelf_brand_key(text);
drop table public.shelf_brands;
alter table public.products drop column shelf_other, drop column shelf_position;

commit;
