-- Controles (SOLO LECTURA) para
--   supabase/migrations/20261115000000_admin_push.sql
-- No modifica nada. Correr cada consulta por separado en el SQL Editor.

-- A. ANTES de aplicar: todas las columnas tienen que dar true.
select
  to_regclass('public.admin_push_subscriptions') is null                            as todavia_sin_suscripciones,
  to_regprocedure('private.yerba_reservation_hours()') is not null                  as migracion_20261114_aplicada,
  (select count(*) from public.admin_users) > 0                                     as hay_administradores,
  -- Solo informativo: si ya están pg_net y Vault (para el aviso inmediato).
  exists (select 1 from pg_extension where extname = 'pg_net')                      as pg_net_instalado,
  exists (select 1 from pg_extension where extname = 'supabase_vault')              as vault_instalado;

-- B. DESPUÉS de aplicar: todas las columnas tienen que dar true.
select
  to_regclass('public.admin_push_subscriptions') is not null                       as tabla_suscripciones,
  (select relrowsecurity from pg_class where oid = 'public.admin_push_subscriptions'::regclass) as rls_activa,
  not has_table_privilege('authenticated', 'public.admin_push_subscriptions', 'insert, update, delete') as sin_escritura_directa,
  not has_column_privilege('authenticated', 'public.admin_push_subscriptions', 'p256dh', 'select')      as claves_ocultas,
  not has_column_privilege('authenticated', 'public.admin_push_subscriptions', 'auth_secret', 'select') as secreto_oculto,
  not has_table_privilege('anon', 'public.admin_push_subscriptions', 'select')     as anonimos_no_leen,
  not has_table_privilege('authenticated', 'private.push_events', 'select')        as cola_privada,
  not has_table_privilege('authenticated', 'private.push_deliveries', 'select')    as envios_privados,
  (select bool_and(c.relrowsecurity and not c.relforcerowsecurity)
     from pg_class c where c.oid in ('private.push_events'::regclass, 'private.push_deliveries'::regclass)) as colas_rls_activa_sin_force,
  not exists (select 1 from pg_policy where polrelid in ('private.push_events'::regclass, 'private.push_deliveries'::regclass)) as colas_sin_politicas,
  not exists (
    select 1 from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values ('private.push_events'), ('private.push_deliveries')) t(table_name)
    where has_table_privilege(r.role_name, t.table_name, 'select,insert,update,delete,truncate,references,trigger')
       or has_any_column_privilege(r.role_name, t.table_name, 'select,insert,update,references')
  ) as colas_sin_acceso_directo,
  not exists (
    select 1 from (values ('anon'), ('authenticated')) r(role_name)
    where has_table_privilege(r.role_name, 'public.admin_push_subscriptions', 'insert,update,delete,truncate,references,trigger')
       or has_any_column_privilege(r.role_name, 'public.admin_push_subscriptions', 'insert,update,references')
       or has_column_privilege(r.role_name, 'public.admin_push_subscriptions', 'p256dh', 'select')
       or has_column_privilege(r.role_name, 'public.admin_push_subscriptions', 'auth_secret', 'select')
  ) as suscripciones_sin_escritura_ni_claves,
  not has_function_privilege('authenticated', 'public.push_claim(integer)', 'execute') as solo_servidor_toma_envios,
  not has_function_privilege('authenticated', 'public.push_report(jsonb)', 'execute')  as solo_servidor_informa,
  has_function_privilege('service_role', 'public.push_claim(integer)', 'execute')  as servidor_puede_enviar,
  has_function_privilege('service_role', 'public.push_report(jsonb)', 'execute') as servidor_puede_informar,
  not has_function_privilege('anon', 'public.push_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.push_report(jsonb)', 'execute') as anonimos_no_envian,
  not exists (
    select 1 from (values ('anon'), ('authenticated')) r(role_name)
    cross join (values
      ('private.valid_push_endpoint(text)'), ('private.push_kick()'), ('private.money_text(numeric)'),
      ('private.push_order_created()'), ('private.queue_restock_push(bigint[])'),
      ('private.push_restock_from_movement()'), ('private.push_restock_from_order()')
    ) f(signature)
    where has_function_privilege(r.role_name, f.signature, 'execute')
  ) as funciones_privadas_no_ejecutables,
  (select count(*) = 2 and bool_and(p.prosecdef and
      position($guard$if (auth.jwt() ->> 'role') is distinct from 'service_role' then$guard$ in p.prosrc) > 0)
     from pg_proc p where p.oid in ('public.push_claim(integer)'::regprocedure, 'public.push_report(jsonb)'::regprocedure)) as guardas_service_role_presentes,
  not exists (
    select 1 from pg_proc p
    cross join pg_class c
    where p.oid in (
      'private.push_order_created()'::regprocedure, 'private.queue_restock_push(bigint[])'::regprocedure,
      'private.push_restock_from_movement()'::regprocedure, 'private.push_restock_from_order()'::regprocedure,
      'public.run_order_maintenance()'::regprocedure, 'public.admin_push_test()'::regprocedure,
      'public.push_claim(integer)'::regprocedure, 'public.push_report(jsonb)'::regprocedure)
      and c.oid in ('private.push_events'::regclass, 'private.push_deliveries'::regclass)
      and (not p.prosecdef or p.proowner <> c.relowner)
  ) as funciones_con_permisos_del_propietario,
  has_function_privilege('authenticated', 'public.admin_push_subscribe(text,text,text,text)', 'execute') as panel_puede_suscribir,
  not has_function_privilege('anon', 'public.admin_push_subscribe(text,text,text,text)', 'execute')      as anonimos_no_suscriben,
  not exists (
    select 1 from (values
      ('public.admin_push_subscribe(text,text,text,text)'), ('public.admin_push_unsubscribe(text)'),
      ('public.admin_push_remove(bigint)'), ('public.admin_push_test()')
    ) f(signature)
    where has_function_privilege('anon', f.signature, 'execute')
       or not has_function_privilege('authenticated', f.signature, 'execute')
  ) as permisos_funciones_panel_correctos,
  exists (select 1 from pg_trigger where tgname = 'orders_push_created')            as trigger_pedidos,
  exists (select 1 from pg_trigger where tgname = 'inventory_movements_push_restock') as trigger_entradas,
  exists (select 1 from pg_trigger where tgname = 'orders_push_restock')            as trigger_cancelaciones;

-- C. Totales (tienen que ser iguales antes y después: la migración no toca pedidos ni stock).
select
  (select count(*) from public.orders)                                     as pedidos,
  (select count(*) from public.order_items)                                as lineas,
  (select coalesce(sum(total), 0) from public.orders)                      as suma_totales,
  (select count(*) from public.inventory_movements)                        as movimientos,
  (select coalesce(sum(stock), 0) from public.product_variants)            as stock_fisico_total,
  (select count(*) from public.restock_requests)                           as avisos_reposicion;

-- D. Después de activar el iPhone en el panel: dispositivos y últimos envíos.
select s.id, s.label, s.created_at, s.last_success_at, s.failure_count, s.last_error, s.disabled_at
  from public.admin_push_subscriptions s
 order by s.created_at;

select e.kind, e.event_key, e.created_at, d.status, d.attempts, d.last_error, d.sent_at
  from private.push_events e
  left join private.push_deliveries d on d.event_id = e.id
 order by e.id desc, d.id
 limit 30;

-- E. ¿Está configurado el aviso inmediato? (pg_net + secretos en Vault)
select
  exists (select 1 from pg_extension where extname = 'pg_net')                      as pg_net_instalado,
  exists (select 1 from vault.decrypted_secrets where name = 'povmatero_push_url')    as url_guardada,
  exists (select 1 from vault.decrypted_secrets where name = 'povmatero_push_secret') as secreto_guardado;

-- F. Últimas llamadas de pg_net al servidor de envío (código 200 = bien).
--    Solo existe con pg_net instalado. No muestra el secreto.
select id, status_code, created, left(coalesce(error_msg, ''), 120) as error
  from net._http_response
 order by created desc
 limit 10;
