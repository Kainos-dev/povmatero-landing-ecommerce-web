-- Verificación (SOLO LECTURA) antes de aplicar
--   20261105000000_yerba_orders.sql
-- No modifica nada. Son tres consultas: correlas por separado.

-- 1) Todas las columnas tienen que dar true.
select
  -- Requisitos que ya tienen que estar aplicados
  to_regprocedure('private.is_admin()') is not null                              as is_admin_existe,
  to_regprocedure('private.clean_text(text, integer)') is not null               as cuentas_de_clientes_aplicadas,
  to_regprocedure('public.create_order(jsonb)') is not null                      as pedidos_de_tienda_aplicados,
  to_regclass('public.orders') is not null and to_regclass('public.order_items') is not null as tablas_de_pedidos_existen,
  to_regprocedure('public.analytics_report(timestamp with time zone, timestamp with time zone)') is not null as estadisticas_aplicadas,
  to_regclass('public.storefront_catalog') is not null                           as vista_de_la_tienda_existe,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'storefront_catalog') = 15    as vista_con_15_columnas,
  -- Lo que va a crear la migración todavía no existe (no se pisa nada)
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'orders'
                 and column_name in ('kind', 'status', 'expires_at', 'stock_applied', 'status_changed_at', 'updated_at'))
                                                                                 as columnas_de_orders_libres,
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'products' and column_name = 'brand')
                                                                                 as columna_brand_libre,
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'inventory_movements' and column_name = 'order_id')
                                                                                 as columna_order_id_libre,
  to_regclass('public.order_events') is null                                     as tabla_order_events_libre,
  to_regprocedure('public.create_yerba_order(jsonb, text)') is null
    and to_regprocedure('public.admin_set_order_status(bigint, text)') is null
    and to_regprocedure('public.admin_update_order_items(bigint, jsonb)') is null
    and to_regprocedure('public.variant_commitments()') is null                  as funciones_nuevas_libres,
  -- Hoy no hay movimientos de stock negativos (la migración no los cambia, pero conviene saberlo)
  not exists (select 1 from public.product_variants where stock < 0)            as sin_stock_negativo;

-- 2) Pedidos que existen hoy (para comparar después: tienen que seguir siendo
--    todos de la tienda; ver «pedidos_previos_intactos» en el script de después).
select count(*) as pedidos_existentes, max(id) as ultimo_numero from public.orders;

-- 3) Qué marca va a recibir cada yerba (misma regla que la migración).
--    Lo que diga «Otras marcas» queda sin marca.
select p.id,
       p.name,
       p.is_active as publicado,
       coalesce((select b.brand
                   from (values ('Canarias'), ('Rei Verde'), ('Sara'), ('Armiño')) as b (brand)
                  where lower(p.name) = lower(b.brand) or lower(p.name) like lower(b.brand) || ' %'
                  limit 1), 'Otras marcas') as marca
  from public.products p
  join public.categories c on c.id = p.category_id
 where c.slug = 'yerbas'
 order by marca, p.name;
