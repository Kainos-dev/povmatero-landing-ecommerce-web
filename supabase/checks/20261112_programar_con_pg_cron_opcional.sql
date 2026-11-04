-- =====================================================================
-- OPCIONAL (requiere tu autorización): ejecutar el mantenimiento de pedidos
-- cada hora con pg_cron, dentro de Supabase. NO hace falta si ya está la
-- tarea diaria de Vercel (/api/cron-pedidos); esto la hace más frecuente.
-- pg_cron está incluido en el plan Free de Supabase (sin costo).
--
-- Ejecutar SOLO después de aplicar 20261112000000_order_auto_cancel.sql.
-- Reemplaza a supabase/checks/20261110_programar_entrega_automatica.sql
-- (run_order_maintenance ya incluye la entrega automática).
-- =====================================================================

-- 1. Activar pg_cron (Database → Extensions → pg_cron), o:
-- create extension if not exists pg_cron with schema pg_catalog;

-- 2. Programar (minuto 15 de cada hora):
select cron.schedule(
  'povmatero-mantenimiento-pedidos',
  '15 * * * *',
  $$select public.run_order_maintenance()$$
);

-- Si antes programaste la entrega automática sola, quitala (queda incluida):
-- select cron.unschedule('povmatero-entrega-automatica-yerbas');

-- Ver que quedó programada y sus últimas ejecuciones:
-- select jobid, jobname, schedule, active from cron.job where jobname = 'povmatero-mantenimiento-pedidos';
-- select status, start_time, return_message from cron.job_run_details
--  where jobid = (select jobid from cron.job where jobname = 'povmatero-mantenimiento-pedidos')
--  order by start_time desc limit 10;

-- Para quitarla:
-- select cron.unschedule('povmatero-mantenimiento-pedidos');
