-- SOLO LECTURA. Después de 20261116 y antes de 17. Rol postgres.
-- Consulta 1: todos true. Consultas 3/4: comparar con 3/4 del control previo.
select
  (select relrowsecurity and not relforcerowsecurity from pg_class where oid='private.public_order_codes'::regclass) as registro_rls_sin_force,
  not exists(select 1 from pg_policy where polrelid='private.public_order_codes'::regclass) as registro_sin_politicas,
  not exists(select 1 from (values ('anon'),('authenticated')) r(role_name)
    where has_table_privilege(r.role_name,'private.public_order_codes','select,insert,update,delete,truncate,references,trigger')
       or has_any_column_privilege(r.role_name,'private.public_order_codes','select,insert,update,references')) as registro_sin_acceso_directo,
  not exists(select 1 from (values ('anon'),('authenticated')) r(role_name)
    cross join (values ('private.random_public_order_code()'),('private.reserve_public_order_code()'),('private.assign_order_code()'),('public.create_order_before_public_code(jsonb)')) f(signature)
    where has_function_privilege(r.role_name,f.signature,'execute')) as funciones_internas_privadas,
  exists(select 1 from pg_proc p join pg_class c on c.oid='private.public_order_codes'::regclass
    where p.oid='private.reserve_public_order_code()'::regprocedure and p.prosecdef and p.proowner=c.relowner) as reserva_security_definer_propietario,
  has_function_privilege('authenticated','public.create_order(jsonb)','execute') as cliente_puede_comprar,
  not has_function_privilege('anon','public.create_order(jsonb)','execute') as anonimo_no_compra,
  (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order') as sin_sobrecargas_rpc,
  (select p.prosecdef and p.proowner=b.proowner and p.proargnames=array['items']::text[] and p.prorettype='jsonb'::regtype
    from pg_proc p cross join pg_proc b where p.oid='public.create_order(jsonb)'::regprocedure and b.oid='public.create_order_before_public_code(jsonb)'::regprocedure) as wrapper_compatible,
  not exists(select 1 from public.orders where public_code is null or public_code !~ '^PV-[A-F0-9]{10}$') as formato_pv,
  not exists(select public_code from public.orders group by 1 having count(*)>1) as codigos_unicos,
  exists(select 1 from pg_attribute where attrelid='public.orders'::regclass and attname='public_code' and attnotnull and not attisdropped) as codigo_obligatorio,
  exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_public_code_unique' and contype='u' and convalidated) as unicidad_en_base,
  not exists(select 1 from public.orders o left join private.public_order_codes r on r.code=o.public_code where r.code is null) as codigos_reservados,
  not exists(select 1 from public.orders where legacy_public_code is not null and legacy_public_code !~ '^[A-Z]{2}-[0-9]{3,}$') as referencias_anteriores_validas,
  exists(select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='orders_public_code' and tgfoid='private.assign_order_code()'::regprocedure and tgtype=23 and tgenabled in ('O','A')) as trigger_insert_update,
  private.yerba_reservation_hours()=12 as reserva_12h;

-- 2. Informativo: contador histórico, referencias anteriores y pedidos nuevos.
-- Los nuevos tienen customer_seq y legacy_public_code NULL, sin incrementar contadores.
select count(*) as pedidos,
       count(*) filter(where legacy_public_code is not null) as referencias_previas,
       count(*) filter(where customer_seq is null) as sin_secuencia_historica
from public.orders;

-- 3. Debe coincidir exactamente con consulta 3 previa si no hubo actividad.
select
  (select count(*) from public.orders) as pedidos,
  (select coalesce(sum(total),0) from public.orders) as suma_totales,
  (select count(*) from public.order_items) as lineas,
  (select count(*) from public.inventory_movements) as movimientos,
  (select coalesce(sum(stock),0) from public.product_variants) as stock_fisico,
  (select count(*) from public.order_events) as eventos,
  (select count(*) from public.restock_requests) as solicitudes,
  (select md5(coalesce(string_agg((to_jsonb(o)-'public_code'-'legacy_public_code')::text,E'\n' order by id),'')) from public.orders o) as huella_pedidos,
  (select md5(coalesce(string_agg(to_jsonb(i)::text,E'\n' order by id),'')) from public.order_items i) as huella_lineas,
  (select md5(coalesce(string_agg(to_jsonb(m)::text,E'\n' order by id),'')) from public.inventory_movements m) as huella_movimientos,
  (select md5(coalesce(string_agg(to_jsonb(v)::text,E'\n' order by id),'')) from public.product_variants v) as huella_variantes,
  (select md5(coalesce(string_agg(to_jsonb(e)::text,E'\n' order by id),'')) from public.order_events e) as huella_eventos,
  (select md5(coalesce(string_agg(to_jsonb(r)::text,E'\n' order by id),'')) from public.restock_requests r) as huella_solicitudes,
  (select md5(coalesce(string_agg(to_jsonb(c)::text,E'\n' order by customer_id),'')) from private.order_counters c) as huella_contadores;

-- 4. codigo_anterior, customer_seq y huella deben coincidir por ID con consulta 4 previa.
select id,legacy_public_code as codigo_anterior,customer_seq,
       md5((to_jsonb(o)-'public_code'-'legacy_public_code')::text) as huella_pedido,
       public_code as codigo_nuevo
from public.orders o order by id;
