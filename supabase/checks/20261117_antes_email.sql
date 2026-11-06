-- SOLO LECTURA, rol postgres. Antes de 17, con 14/15/16 aplicadas.
-- Consulta 1: todo true. Consulta 2: cero filas.
select
  to_regclass('private.public_order_codes') is not null as etapa_16,
  to_regclass('private.restock_email_jobs') is null as cola_disponible,
  to_regtype('private.restock_email_jobs') is null as tipo_disponible,
  to_regclass('private.restock_email_jobs_pkey') is null as indice_cola_disponible,
  to_regclass('public.restock_unsubscribe_token') is null as indice_token_disponible,
  not exists(select 1 from pg_attribute where attrelid='public.restock_requests'::regclass and attname in ('email_consent_at','unsubscribe_token') and not attisdropped) as columnas_disponibles,
  (select count(*)=1 and bool_and(p.oid='public.request_restock_alert(bigint)'::regprocedure and p.prorettype='jsonb'::regtype and p.proargnames=array['variant_id']::text[])
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='request_restock_alert') as rpc_original_compatible,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('request_restock_alert_before_email','restock_email_claim','restock_email_check','restock_email_report','restock_email_unsubscribe')) as funciones_publicas_disponibles,
  to_regprocedure('private.restock_email_eligible(bigint)') is null as funcion_privada_disponible,
  not exists(select 1 from pg_depend where refclassid='pg_proc'::regclass and refobjid='public.request_restock_alert(bigint)'::regprocedure and deptype='n') as sin_dependientes_oid,
  to_regprocedure('public.admin_mark_restock_notified(bigint[])') is not null as funcion_manual_existente;

select pg_describe_object(classid,objid,objsubid) as dependiente from pg_depend
where refclassid='pg_proc'::regclass and refobjid='public.request_restock_alert(bigint)'::regprocedure and deptype='n';

-- 3. Guardar y comparar con consulta 4 posterior, misma zona horaria y sin actividad concurrente.
select
  (select count(*) from public.orders) as pedidos,
  (select md5(coalesce(string_agg(to_jsonb(o)::text,E'\n' order by id),'')) from public.orders o) as huella_pedidos,
  (select md5(coalesce(string_agg(to_jsonb(i)::text,E'\n' order by id),'')) from public.order_items i) as huella_lineas,
  (select md5(coalesce(string_agg(to_jsonb(v)::text,E'\n' order by id),'')) from public.product_variants v) as huella_variantes,
  (select md5(coalesce(string_agg(to_jsonb(m)::text,E'\n' order by id),'')) from public.inventory_movements m) as huella_movimientos,
  (select md5(coalesce(string_agg(to_jsonb(e)::text,E'\n' order by id),'')) from public.order_events e) as huella_eventos,
  (select count(*) from public.restock_requests) as solicitudes,
  (select md5(coalesce(string_agg((to_jsonb(r)-'email_consent_at'-'unsubscribe_token')::text,E'\n' order by id),'')) from public.restock_requests r) as huella_solicitudes;

-- 4. Guardar IDs y huellas: después deben coincidir y tener consentimiento NULL.
select id,status,md5((to_jsonb(r)-'email_consent_at'-'unsubscribe_token')::text) as huella
from public.restock_requests r order by id;
