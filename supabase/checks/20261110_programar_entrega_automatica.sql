-- =====================================================================
-- OPCIONAL (requiere autorización): programar la entrega automática.
-- Ejecutar SOLO después de aplicar 20261110000000_simple_order_states.sql.
--
-- Qué hace: cada hora (minuto 15) pasa a «Entregado» los pedidos de yerbas
-- que están en «Listo» hace 24 h o más (public.deliver_due_yerba_orders(),
-- idempotente). Sin esto, la entrega automática igual se aplica cada vez que
-- alguien abre «Pedidos» en el panel.
--
-- Requiere la extensión pg_cron (Supabase → Database → Extensions → pg_cron).
-- =====================================================================

-- 1. Activar pg_cron (si no está activa):
-- create extension if not exists pg_cron with schema pg_catalog;

-- 2. Programar:
select cron.schedule(
  'povmatero-entrega-automatica-yerbas',
  '15 * * * *',
  $$select public.deliver_due_yerba_orders()$$
);

-- Ver que quedó programada y sus últimas ejecuciones:
-- select jobid, jobname, schedule, active from cron.job where jobname = 'povmatero-entrega-automatica-yerbas';
-- select status, start_time, return_message from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'povmatero-entrega-automatica-yerbas')
--  order by start_time desc limit 10;

-- Para quitarla:
-- select cron.unschedule('povmatero-entrega-automatica-yerbas');
