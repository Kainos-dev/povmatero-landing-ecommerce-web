-- Verificación (SOLO LECTURA) después de aplicar
--   20261105000000_yerba_orders.sql
-- No modifica nada. Son tres consultas: correlas por separado.

-- 1) Todas las columnas tienen que dar true.
select
  -- Estructura
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'products' and column_name = 'brand') as columna_brand,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'orders'
     and column_name in ('kind', 'status', 'expires_at', 'stock_applied', 'status_changed_at', 'updated_at')) = 6 as columnas_de_orders,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_movements' and column_name = 'order_id') as columna_order_id,
  to_regclass('public.order_events') is not null as tabla_order_events,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'storefront_catalog') = 16
    and (select column_name from information_schema.columns where table_schema = 'public' and table_name = 'storefront_catalog' and ordinal_position = 16) = 'brand'
    as vista_con_brand_al_final,
  -- Pedidos anteriores a la migración: los que no nacieron por create_yerba_order
  -- (todo pedido de yerbas tiene su evento «creado»; los de la tienda nunca
  -- tienen eventos). Tienen que seguir siendo de la tienda y sin estado.
  not exists (select 1 from public.orders o
               where not exists (select 1 from public.order_events e
                                  where e.order_id = o.id and e.event = 'creado')
                 and (o.kind is distinct from 'tienda' or o.status is not null)) as pedidos_previos_intactos,
  -- Y todo pedido de yerbas nació por la función (tiene su evento «creado»).
  not exists (select 1 from public.orders o
               where o.kind = 'yerbas'
                 and not exists (select 1 from public.order_events e
                                  where e.order_id = o.id and e.event = 'creado')) as pedidos_yerbas_con_origen,
  -- Reglas de estado presentes
  (select count(*) from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname in ('orders_kind_check', 'orders_status_check', 'orders_yerbas_status_required',
                      'orders_expires_check', 'orders_stock_applied_check')) = 5 as reglas_de_estado,
  -- La tienda muestra SIEMPRE físico − comprometido (0 como mínimo); sin control de stock, nada.
  not exists (select 1 from public.storefront_catalog s
                join public.product_variants v on v.id = s.variant_id
                left join public.variant_commitments() cm on cm.variant_id = s.variant_id
               where s.stock is distinct from
                     case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0) end) as stock_mostrado_correcto,
  -- Permisos
  has_function_privilege('anon', 'public.variant_commitments()', 'execute')                         as anon_lee_comprometido,
  not has_function_privilege('anon', 'public.create_yerba_order(jsonb, text)', 'execute')           as anon_no_crea_pedidos,
  has_function_privilege('authenticated', 'public.create_yerba_order(jsonb, text)', 'execute')      as clientes_crean_pedidos,
  not has_function_privilege('anon', 'public.admin_set_order_status(bigint, text)', 'execute')      as anon_no_cambia_estados,
  not has_function_privilege('authenticated', 'private.reconcile_order_stock(bigint, boolean, text)', 'execute') as ayudantes_privados_cerrados,
  has_column_privilege('anon', 'public.products', 'brand', 'select')                                as tienda_lee_marca,
  not has_column_privilege('authenticated', 'public.inventory_movements', 'order_id', 'insert')     as order_id_solo_por_funciones,
  not has_table_privilege('authenticated', 'public.order_events', 'insert')                         as historial_solo_por_funciones,
  not has_table_privilege('authenticated', 'public.orders', 'update')                               as pedidos_sin_update_directo;

-- 2) Marcas asignadas a las yerbas (vacío = «Otras marcas»).
select p.id, p.name, coalesce(p.brand, 'Otras marcas') as marca
  from public.products p
  join public.categories c on c.id = p.category_id
 where c.slug = 'yerbas'
 order by marca, p.name;

-- 3) Control de stock por pedido (sirve siempre, también más adelante).
--    Tiene que devolver 0 filas: cada pedido de yerbas tiene exactamente los
--    movimientos que corresponden a su estado (−cantidad en listo/entregado, 0 en el resto).
select o.id as pedido, o.status, x.variant_id, x.cantidad, x.movido
  from public.orders o
  cross join lateral (
    select v_id as variant_id, coalesce(sum(q), 0)::int as cantidad, coalesce(sum(m), 0)::int as movido
      from (select i.variant_id as v_id, i.quantity as q, null::int as m from public.order_items i where i.order_id = o.id
            union all
            select mv.variant_id, null, mv.quantity from public.inventory_movements mv where mv.order_id = o.id) u
     group by v_id) x
 where o.kind = 'yerbas'
   and x.movido <> case when o.stock_applied then -x.cantidad else 0 end;
