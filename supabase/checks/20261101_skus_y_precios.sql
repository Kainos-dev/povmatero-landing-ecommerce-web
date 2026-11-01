-- Revisión (SOLO LECTURA) antes de pasar SKU y precios a nivel de producto.
-- Correr en el SQL Editor de Supabase y pasar el resultado. No modifica nada.
--
-- Por producto: variantes, SKU cargados hoy en las variantes, rango de precios y
-- costos, y el código de artículo que aparece en las rutas de sus fotos
-- (ej. images/2559/... o products/12/2559-negro.webp), que coincide con el
-- ARTICULO de la lista mayorista de Darc Cuir & Yatay.
select
  p.id,
  p.name                                         as producto,
  c.slug                                         as categoria,
  case when p.is_active then 'publicado' else 'borrador' end as estado,
  count(v.id)                                    as variantes,
  count(vi.sku)                                  as variantes_con_sku,
  string_agg(distinct vi.sku, ', ')              as skus_actuales,
  min(v.price)                                   as precio_min,
  max(v.price)                                   as precio_max,
  min(vc.cost)                                   as costo_min,
  max(vc.cost)                                   as costo_max,
  (select string_agg(distinct substring(i.src from '(?:images/|/)(\d{4})[-/]'), ', ')
     from public.product_images i
    where i.product_id = p.id)                   as codigo_en_fotos
from public.products p
join public.categories c on c.id = p.category_id
left join public.product_variants v  on v.product_id = p.id
left join public.variant_internal vi on vi.variant_id = v.id
left join public.variant_costs vc    on vc.variant_id = v.id
group by p.id, p.name, c.slug, p.is_active
order by c.slug, p.name;
