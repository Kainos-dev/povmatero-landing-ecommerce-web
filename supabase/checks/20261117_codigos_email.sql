-- SOLO LECTURA. Ejecutar después de 20261114, 15, 16 y 17, en ese orden.
select
  not exists(select 1 from public.orders where public_code is null or public_code !~ '^PV-[A-F0-9]{10}$') as formato,
  not exists(select public_code from public.orders group by 1 having count(*)>1) as codigos_unicos,
  exists(select 1 from pg_constraint where conname='orders_public_code_unique') as restriccion_unica,
  private.yerba_reservation_hours()=12 as reserva_12h,
  not has_function_privilege('authenticated','public.restock_email_claim(text,integer)','execute') as cola_privada,
  not has_function_privilege('anon','public.restock_email_unsubscribe(uuid)','execute') as baja_solo_servidor,
  (select relrowsecurity and not relforcerowsecurity from pg_class where oid='private.restock_email_jobs'::regclass) as cola_rls_sin_force,
  not exists(select 1 from pg_policy where polrelid='private.restock_email_jobs'::regclass) as cola_sin_politicas,
  not exists(select 1 from (values ('anon'),('authenticated')) r(role_name)
    where has_table_privilege(r.role_name,'private.restock_email_jobs','select,insert,update,delete,truncate,references,trigger')
       or has_any_column_privilege(r.role_name,'private.restock_email_jobs','select,insert,update,references')
       or has_any_column_privilege(r.role_name,'public.restock_requests','insert,update')) as sin_escritura_directa,
  not exists(select 1 from (values ('public.restock_email_claim(text,integer)'),('public.restock_email_check(bigint,uuid)'),('public.restock_email_report(bigint,uuid,text,text)'),('public.restock_email_unsubscribe(uuid)')) f(signature)
    where has_function_privilege('anon',f.signature,'execute') or has_function_privilege('authenticated',f.signature,'execute')
       or not has_function_privilege('service_role',f.signature,'execute')) as funciones_solo_service_role,
  (select count(*)=4 and bool_and(p.prosecdef and p.proowner=c.relowner and
     position($guard$(auth.jwt() ->> 'role') is distinct from 'service_role'$guard$ in p.prosrc)>0)
   from pg_proc p cross join pg_class c where c.oid='private.restock_email_jobs'::regclass
     and p.oid in ('public.restock_email_claim(text,integer)'::regprocedure,'public.restock_email_check(bigint,uuid)'::regprocedure,'public.restock_email_report(bigint,uuid,text,text)'::regprocedure,'public.restock_email_unsubscribe(uuid)'::regprocedure)) as guardas_y_propietarios_correctos,
  to_regprocedure('public.request_restock_alert(bigint)') is null as sin_rpc_ambigua,
  has_function_privilege('authenticated','public.request_restock_alert(bigint,boolean)','execute')
    and not has_function_privilege('anon','public.request_restock_alert(bigint,boolean)','execute') as consentimiento_solo_cliente,
  not has_function_privilege('authenticated','public.request_restock_alert_before_email(bigint)','execute')
    and not has_function_privilege('anon','public.request_restock_alert_before_email(bigint)','execute') as cuerpo_anterior_privado,
  (select p.pronargdefaults=1 and pg_get_expr(p.proargdefaults,0)='false' and position('request_restock_alert.email_consent is true' in p.prosrc)>0
   from pg_proc p where p.oid='public.request_restock_alert(bigint,boolean)'::regprocedure) as consentimiento_explicito_por_defecto_no,
  not has_function_privilege('authenticated','public.admin_mark_restock_notified(bigint[])','execute') as marcado_manual_revocado;

-- Contadores agregados; no muestran emails, tokens ni datos de clientes.
select count(*) filter(where status='activa' and email_consent_at is null) as antiguas_sin_consentimiento,
       count(*) filter(where status='activa' and email_consent_at is not null) as activas_email
from public.restock_requests;
select state,count(*),min(first_attempt_at) as primer_intento
from private.restock_email_jobs group by state;

-- 4. Comparar con consulta 3 previa antes de actividad o envíos.
select
  (select count(*) from public.orders) as pedidos,
  (select md5(coalesce(string_agg(to_jsonb(o)::text,E'\n' order by id),'')) from public.orders o) as huella_pedidos,
  (select md5(coalesce(string_agg(to_jsonb(i)::text,E'\n' order by id),'')) from public.order_items i) as huella_lineas,
  (select md5(coalesce(string_agg(to_jsonb(v)::text,E'\n' order by id),'')) from public.product_variants v) as huella_variantes,
  (select md5(coalesce(string_agg(to_jsonb(m)::text,E'\n' order by id),'')) from public.inventory_movements m) as huella_movimientos,
  (select md5(coalesce(string_agg(to_jsonb(e)::text,E'\n' order by id),'')) from public.order_events e) as huella_eventos,
  (select count(*) from public.restock_requests) as solicitudes,
  (select md5(coalesce(string_agg((to_jsonb(r)-'email_consent_at'-'unsubscribe_token')::text,E'\n' order by id),'')) from public.restock_requests r) as huella_solicitudes;

-- 5. Para cada ID guardado antes: misma huella y email_consent_at NULL.
select id,status,md5((to_jsonb(r)-'email_consent_at'-'unsubscribe_token')::text) as huella,email_consent_at
from public.restock_requests r order by id;
