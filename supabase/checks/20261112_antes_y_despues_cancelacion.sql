-- =====================================================================
-- Controles de 20261112000000_order_auto_cancel.sql (solo lectura).
-- Ejecutar en el SQL Editor ANTES (parte A) y DESPUÉS (parte B) de la migración.
-- =====================================================================

-- A. ANTES: qué va a cambiar.
--    vencidos = pendientes con la reserva ya vencida → pasan a «Cancelado»
--    vigentes = pendientes con reserva → se extienden a 72 h desde la creación
select
  count(*) filter (where status = 'pendiente' and expires_at <= now()) as vencidos_que_se_cancelan,
  count(*) filter (where status = 'pendiente' and expires_at >  now()) as vigentes_que_se_extienden,
  count(*) filter (where status in ('confirmado', 'preparando'))         as en_preparacion_sin_cambios,
  count(*) filter (where status in ('listo', 'entregado', 'cancelado'))  as finales_sin_cambios
from public.orders where kind = 'yerbas';

-- Detalle de los que se van a cancelar (número, cliente, cuándo se pidió):
select id, created_at, expires_at, customer_name, item_count, total
  from public.orders
 where kind = 'yerbas' and status = 'pendiente' and expires_at <= now()
 order by id;

-- B. DESPUÉS: todo tiene que dar true.
select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'cancel_reason')  as columna_motivo,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'orders' and column_name = 'auto_cancelled') as columna_automatico,
  exists (select 1 from pg_trigger where tgname = 'orders_yerba_expiry')                                                              as trigger_72h,
  exists (select 1 from pg_proc where proname = 'cancel_unanswered_yerba_orders')                                                     as funcion_cancelar,
  exists (select 1 from pg_proc where proname = 'run_order_maintenance')                                                              as funcion_mantenimiento,
  not exists (select 1 from public.orders where kind = 'yerbas' and status = 'pendiente' and expires_at <= now())                     as sin_pendientes_vencidos,
  not exists (select 1 from public.orders where kind = 'yerbas' and status = 'pendiente'
                 and expires_at < created_at + interval '72 hours')                                                                   as pendientes_con_72h,
  not exists (select 1 from public.orders where status = 'cancelado' and auto_cancelled and stock_applied)                            as cancelados_sin_stock_descontado,
  not exists (select order_id from public.order_events where to_status = 'cancelado' group by order_id having count(*) > 1)           as sin_cancelaciones_dobles,
  has_function_privilege('service_role', 'public.run_order_maintenance()', 'execute')                                                 as service_role_puede_ejecutar,
  not has_function_privilege('anon', 'public.run_order_maintenance()', 'execute')                                                     as anon_no_puede;

-- Pedidos cancelados por falta de respuesta (con su historial):
select o.id, o.created_at, o.cancelled_at, o.cancel_reason, e.detail
  from public.orders o
  join public.order_events e on e.order_id = o.id and e.to_status = 'cancelado'
 where o.auto_cancelled
 order by o.id;

-- Prueba manual de la tarea (no cambia nada si no hay pendientes de 72 h):
-- select public.run_order_maintenance();
