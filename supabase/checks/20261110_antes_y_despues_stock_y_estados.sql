-- =====================================================================
-- Verificación de las migraciones 20261108 (avisos de reposición),
-- 20261109 (herramientas de stock) y 20261110 (estados simples).
-- Solo lectura: no cambia nada. Ejecutar en el SQL Editor.
-- =====================================================================

-- ---------- ANTES de aplicar (todo tiene que dar true) ----------
select
  -- las nuevas tablas todavía no existen
  to_regclass('public.restock_requests') is null                        as sin_avisos_todavia,
  to_regclass('public.supplier_orders') is null                         as sin_proveedores_todavia,
  to_regclass('public.stock_operations') is null                        as sin_operaciones_todavia,
  -- 20261109 reemplaza la función del trigger de movimientos: tiene que existir
  to_regprocedure('private.apply_inventory_movement()') is not null     as trigger_movimientos,
  -- 20261109 reemplaza estas reglas por nombre: tienen que existir así
  exists (select 1 from pg_constraint where conname = 'orders_kind_check')          as regla_kind,
  exists (select 1 from pg_constraint where conname = 'orders_channel_check')       as regla_channel,
  exists (select 1 from pg_constraint where conname = 'orders_status_check')        as regla_status,
  exists (select 1 from pg_constraint where conname = 'orders_expires_check')       as regla_expires,
  exists (select 1 from pg_constraint where conname = 'orders_stock_applied_check') as regla_stock_applied,
  exists (select 1 from pg_constraint where conname = 'order_events_event_check')   as regla_eventos,
  -- 20261110 agrega estas columnas: todavía no existen
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'orders' and column_name in ('ready_at', 'delivered_at', 'client_key')) as columnas_nuevas_libres;

-- Pedidos «Listo» que la primera entrega automática pasaría a «Entregado»
-- (llevan 24 h o más en «Listo»). Revisalos antes si querés.
select id, customer_name, status_changed_at
  from public.orders
 where kind = 'yerbas' and status = 'listo' and status_changed_at <= now() - interval '24 hours'
 order by id;

-- ---------- DESPUÉS de aplicar (todo tiene que dar true) ----------
select
  to_regclass('public.restock_requests') is not null                    as avisos,
  to_regclass('public.supplier_orders') is not null                     as proveedores,
  to_regclass('public.supplier_order_items') is not null                as proveedores_items,
  (select relrowsecurity from pg_class where oid = 'public.restock_requests'::regclass)     as avisos_rls,
  (select relrowsecurity from pg_class where oid = 'public.supplier_orders'::regclass)      as proveedores_rls,
  (select relrowsecurity from pg_class where oid = 'public.supplier_order_items'::regclass) as proveedores_items_rls,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_movements' and column_name = 'operation_id')      as movimientos_operacion,
  to_regclass('public.stock_operations') is not null                    as operaciones,
  to_regclass('public.stock_shortages') is not null                     as faltantes,
  (select relrowsecurity from pg_class where oid = 'public.stock_operations'::regclass) as operaciones_rls,
  (select relrowsecurity from pg_class where oid = 'public.stock_shortages'::regclass)  as faltantes_rls,
  not has_table_privilege('authenticated', 'public.stock_operations', 'insert')          as nadie_escribe_operaciones_directo,
  not has_column_privilege('authenticated', 'public.inventory_movements', 'operation_id', 'insert') as operacion_solo_desde_funcion,
  to_regprocedure('public.admin_stock_movement(uuid,bigint,text,integer,text,text,integer,boolean,text)') is not null as fn_movimiento,
  to_regprocedure('public.admin_stock_preview(bigint,integer,integer)') is not null      as fn_vista_previa,
  to_regprocedure('public.admin_resolve_shortage(bigint,text)') is not null             as fn_resolver_faltante,
  not has_function_privilege('anon', 'public.admin_stock_movement(uuid,bigint,text,integer,text,text,integer,boolean,text)', 'execute') as anon_sin_movimientos,
  (select prosrc like '%reserved_stock%' from pg_proc where oid = 'private.apply_inventory_movement()'::regprocedure) as trigger_con_regla_reservas,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'inventory_movements' and column_name = 'supplier_order_id') as movimientos_proveedor,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'ready_at')     as orders_ready_at,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'auto_deliver') as orders_auto_deliver,
  to_regprocedure('public.request_restock_alert(bigint)') is not null              as fn_pedir_aviso,
  to_regprocedure('public.cancel_restock_alert(bigint)') is not null               as fn_cancelar_aviso,
  to_regprocedure('public.admin_restock_alerts()') is not null                     as fn_avisos_panel,
  to_regprocedure('public.admin_mark_restock_notified(bigint[])') is not null      as fn_marcar_avisado,
  to_regprocedure('public.admin_create_supplier_order(jsonb,text,text,uuid)') is not null as fn_pedido_proveedor,
  to_regprocedure('public.admin_receive_supplier_order(bigint,jsonb)') is not null as fn_recibir,
  to_regprocedure('public.admin_cancel_supplier_order(bigint)') is not null        as fn_cancelar_proveedor,
  to_regprocedure('public.admin_create_sale(jsonb,uuid,text,text,uuid)') is not null as fn_venta,
  to_regprocedure('public.admin_link_order_customer(bigint,uuid)') is not null     as fn_vincular,
  to_regprocedure('public.admin_cancel_sale(bigint)') is not null                  as fn_anular_venta,
  to_regprocedure('public.deliver_due_yerba_orders()') is not null                 as fn_entrega_automatica,
  -- anon no puede ejecutar nada de esto
  not has_function_privilege('anon', 'public.admin_create_sale(jsonb,uuid,text,text,uuid)', 'execute') as anon_sin_ventas,
  not has_function_privilege('anon', 'public.request_restock_alert(bigint)', 'execute')               as anon_sin_avisos,
  not has_table_privilege('anon', 'public.restock_requests', 'select')                                 as anon_no_lee_avisos,
  not has_table_privilege('authenticated', 'public.restock_requests', 'insert')                        as nadie_escribe_avisos_directo,
  not has_table_privilege('authenticated', 'public.supplier_orders', 'insert')                         as nadie_escribe_proveedores_directo,
  -- los pedidos existentes siguen válidos
  (select count(*) from public.orders where kind not in ('tienda', 'yerbas', 'presencial')) = 0        as pedidos_validos;
