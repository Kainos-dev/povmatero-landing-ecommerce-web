-- =====================================================================
-- Imagen de góndola (/yerbas), independiente de las fotos del catálogo.
--
--   * products.shelf_image: URL pública del PNG del envase para la góndola
--     (vertical 2:3, idealmente con fondo transparente). Vacía = /yerbas
--     muestra el paquete genérico, como hasta ahora.
--   * El archivo vive en el mismo bucket que las fotos (product-images,
--     carpeta products/<id>/shelf-…). NO es un registro de product_images:
--     el catálogo tradicional no la ve ni la usa.
--   * storefront_catalog suma la columna «shelf_image» al final (las demás
--     columnas no cambian, en nombre, tipo ni orden).
--
-- No modifica datos: la columna arranca vacía para todos los productos.
-- Se ejecuta UNA vez: si la columna ya existe, falla al empezar y no cambia
-- nada. Verificar antes con supabase/checks/20261106_antes_de_imagenes_gondola.sql
-- y después con supabase/checks/20261106_despues_de_imagenes_gondola.sql.
-- =====================================================================

begin;

alter table public.products
  add column shelf_image text
    check (shelf_image is null or (shelf_image ~ '^https://' and char_length(shelf_image) <= 500));

comment on column public.products.shelf_image is
  'Imagen de góndola (/yerbas): URL pública del PNG del envase, vertical 2:3. Independiente de las fotos del catálogo.';

-- Leer: la tienda (por la vista). Escribir: el panel (la RLS exige administrador).
grant select (shelf_image) on public.products to anon, authenticated;
grant update (shelf_image) on public.products to authenticated;

-- Misma vista que en 20261105000000_yerba_orders.sql + «shelf_image» al final.
create or replace view public.storefront_catalog
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
  p.shelf_image as shelf_image
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

commit;
