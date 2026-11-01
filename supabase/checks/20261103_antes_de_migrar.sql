-- Verificación (SOLO LECTURA) antes de aplicar
--   20261102000000_admin_delete_customer.sql
--   20261103000000_customer_orders.sql
-- No modifica nada. Todas las columnas tienen que dar true.
select
  -- Requisitos que ya tienen que estar aplicados
  to_regprocedure('private.is_admin()') is not null                   as is_admin_existe,
  to_regclass('public.admin_users') is not null                        as admin_users_existe,
  to_regclass('public.customer_profiles') is not null                  as perfiles_de_clientes_existe,
  to_regclass('public.marketing_consent_events') is not null           as historial_novedades_existe,
  -- Lo que van a crear las migraciones todavía no existe (no se pisa nada)
  to_regprocedure('public.admin_delete_customer(uuid)') is null        as funcion_borrado_libre,
  to_regprocedure('public.create_order(jsonb)') is null                as funcion_pedidos_libre,
  to_regclass('public.orders') is null                                 as tabla_orders_libre,
  to_regclass('public.order_items') is null                            as tabla_order_items_libre;
