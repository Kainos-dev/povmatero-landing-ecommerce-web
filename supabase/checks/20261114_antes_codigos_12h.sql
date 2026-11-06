-- Controles (SOLO LECTURA) ANTES de aplicar
--   supabase/migrations/20261114000000_order_codes_12h.sql
-- No modifica nada. Correr cada consulta por separado en el SQL Editor y
-- guardar los resultados: después se comparan con 20261114_despues_codigos_12h.sql.

-- 1. Requisitos: todas las columnas tienen que dar true.
select
  to_regprocedure('private.auto_cancel_orders(bigint[],jsonb)') is not null          as migracion_20261112_aplicada,
  to_regprocedure('public.create_yerba_order(jsonb,text)') is not null               as funcion_pedidos_actual,
  to_regprocedure('public.create_yerba_order(jsonb,text,uuid)') is null              as todavia_sin_client_key,
  not exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'orders' and column_name = 'public_code')
                                                                                      as todavia_sin_codigo,
  to_regclass('private.order_counters') is null                                      as todavia_sin_contadores,
  -- Los nombres que se van a usar para los códigos (no deberían tener problemas, solo se informa).
  (select count(*) from public.orders where customer_id is not null) >= 0            as hay_tabla_pedidos;

-- 2. Totales para comparar después (tienen que quedar IGUALES).
select
  (select count(*) from public.orders)                                     as pedidos,
  (select count(*) from public.orders where customer_id is not null)       as pedidos_con_cliente,
  (select count(*) from public.orders where customer_id is null)           as pedidos_sin_cliente,
  (select count(distinct customer_id) from public.orders where customer_id is not null) as clientes_con_pedidos,
  (select count(*) from public.order_items)                                as lineas,
  (select coalesce(sum(total), 0) from public.orders)                      as suma_totales,
  (select count(*) from public.inventory_movements)                        as movimientos,
  (select coalesce(sum(stock), 0) from public.product_variants)            as stock_fisico_total,
  (select coalesce(sum(stock), 0) from public.storefront_catalog where stock is not null) as disponible_total,
  (select count(*) from public.order_events)                               as eventos;

-- 3. Pedidos de yerbas PENDIENTES hoy (la migración NO cambia su vencimiento:
--    conservan las 72 h). Para decidir si se acortan (ver el final de la migración).
select o.id, o.created_at, o.expires_at,
       round(extract(epoch from o.expires_at - o.created_at) / 3600) as horas_reserva,
       o.expires_at > now() as reserva_vigente,
       o.expires_at > o.created_at + interval '12 hours' as quedaria_vencido_con_12h_si_se_acorta
  from public.orders o
 where o.kind = 'yerbas' and o.status = 'pendiente'
 order by o.created_at;

-- 4. Cantidad de pedidos por cliente (los códigos van a ir de 001 hasta este número).
select count(*) as pedidos_del_cliente, count(*) filter (where kind = 'yerbas') as de_yerbas
  from public.orders
 where customer_id is not null
 group by customer_id
 order by 1 desc
 limit 20;
