-- Verificación (SOLO LECTURA) después de aplicar
--   supabase/migrations/20261114000000_order_codes_12h.sql
-- No modifica nada. Correr cada consulta por separado en el SQL Editor.

-- 1. Estructura y permisos: todas las columnas tienen que dar true.
select
  to_regprocedure('public.create_yerba_order(jsonb,text,uuid)') is not null           as funcion_con_client_key,
  to_regprocedure('public.create_yerba_order(jsonb,text)') is null                    as sin_version_duplicada,
  has_function_privilege('authenticated', 'public.create_yerba_order(jsonb,text,uuid)', 'execute') as clientes_pueden_pedir,
  not has_function_privilege('anon', 'public.create_yerba_order(jsonb,text,uuid)', 'execute')      as anonimos_no,
  private.yerba_reservation_hours() = 12                                              as reserva_12_horas,
  exists (select 1 from pg_trigger where tgname = 'orders_public_code' and tgrelid = 'public.orders'::regclass) as trigger_codigo,
  exists (select 1 from pg_trigger where tgname = 'orders_yerba_expiry' and tgrelid = 'public.orders'::regclass) as trigger_vencimiento,
  to_regclass('private.order_counters') is not null                                   as contadores,
  not has_table_privilege('authenticated', 'private.order_counters', 'select')        as contadores_privados,
  (select relrowsecurity from pg_class where oid = 'private.order_counters'::regclass) as contadores_rls_activa,
  not exists (select 1 from pg_policy where polrelid = 'private.order_counters'::regclass) as contadores_sin_politicas_publicas,
  not has_table_privilege('anon', 'private.order_counters', 'select,insert,update,delete')
    and not has_any_column_privilege('anon', 'private.order_counters', 'select,insert,update') as contadores_anon_sin_acceso_directo,
  not has_table_privilege('authenticated', 'private.order_counters', 'select,insert,update,delete')
    and not has_any_column_privilege('authenticated', 'private.order_counters', 'select,insert,update') as contadores_clientes_sin_acceso_directo,
  exists (select 1 from pg_proc p join pg_class c on c.oid = 'private.order_counters'::regclass
           where p.oid = 'private.assign_order_code()'::regprocedure
             and p.prosecdef and p.proowner = c.relowner and not c.relforcerowsecurity) as asignacion_con_permisos_del_propietario,
  not has_function_privilege('anon', 'private.assign_order_code()', 'execute')
    and not has_function_privilege('authenticated', 'private.assign_order_code()', 'execute') as asignacion_sin_ejecucion_directa,
  not has_column_privilege('authenticated', 'public.orders', 'public_code', 'update')  as codigo_no_editable,
  exists (select 1 from pg_indexes where indexname = 'orders_customer_seq_key')       as indice_unico_por_cliente;

-- 2. Datos: todas las columnas tienen que dar true.
select
  private.order_code('Ñandú', 'Íñiguez', 1) = 'NI-001'                                  as iniciales_independientes_del_locale,
  private.order_code(null, '', 1) = 'XX-001'                                           as iniciales_vacias,
  not exists (select 1 from public.orders where customer_id is not null and (public_code is null or customer_seq is null))
                                                                                      as todo_pedido_con_cliente_tiene_codigo,
  not exists (select 1 from public.orders where public_code !~ '^[A-Z]{2}-[0-9]{3,}$') as formato_correcto,
  not exists (select customer_id, customer_seq from public.orders where customer_id is not null
               group by 1, 2 having count(*) > 1)                                     as sin_numeros_repetidos,
  -- Numeración 1, 2, 3… por cliente, sin huecos, en orden de fecha.
  not exists (select 1 from (select customer_seq, row_number() over (partition by customer_id order by created_at, id) n
                               from public.orders where customer_id is not null) s
               where s.customer_seq <> s.n)                                           as numeracion_continua_por_fecha,
  not exists (select 1 from private.order_counters c
               where c.last_seq <> (select max(o.customer_seq) from public.orders o where o.customer_id = c.customer_id))
                                                                                      as contadores_al_dia;

-- 3. Totales: tienen que ser IGUALES a la consulta 2 de «antes».
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

-- 4. Pendientes: tienen que tener el MISMO vencimiento que en «antes» (72 h).
select o.id, o.public_code, o.created_at, o.expires_at,
       round(extract(epoch from o.expires_at - o.created_at) / 3600) as horas_reserva
  from public.orders o
 where o.kind = 'yerbas' and o.status = 'pendiente'
 order by o.created_at;

-- 5. Muestra de códigos (los últimos 20 pedidos).
select o.id as interno, o.public_code as codigo, o.kind, o.created_at,
       coalesce(nullif(btrim(p.first_name), ''), '—') as nombre, coalesce(nullif(btrim(p.last_name), ''), '—') as apellido
  from public.orders o
  left join public.customer_profiles p on p.user_id = o.customer_id
 order by o.created_at desc
 limit 20;
