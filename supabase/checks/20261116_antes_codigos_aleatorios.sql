-- SOLO LECTURA. Antes de 20261116, con 14 y 15 aplicadas. Rol postgres.
-- Consulta 1: todos true. Si no, detenerse y revisar.
-- Guardar las consultas 3 y 4 para comparar con las homólogas del control posterior.
-- Ejecutar ambas etapas con la misma zona horaria y sin actividad concurrente.
select
  to_regprocedure('private.yerba_reservation_hours()') is not null as etapa_14,
  to_regclass('private.push_events') is not null as etapa_15,
  to_regclass('private.public_order_codes') is null as registro_nuevo_disponible,
  to_regtype('private.public_order_codes') is null as tipo_nuevo_disponible,
  to_regclass('private.public_order_codes_pkey') is null as indice_registro_disponible,
  to_regclass('public.orders_public_code_unique') is null as indice_unico_disponible,
  not exists(select 1 from pg_constraint where conrelid='public.orders'::regclass and conname='orders_public_code_unique') as constraint_unica_disponible,
  not exists(select 1 from pg_attribute where attrelid='public.orders'::regclass and attname='legacy_public_code' and not attisdropped) as columna_legacy_disponible,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('random_public_order_code','reserve_public_order_code')) as funciones_nuevas_disponibles,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order_before_public_code') as nombre_respaldo_disponible,
  (select count(*)=1 and bool_and(p.oid='public.create_order(jsonb)'::regprocedure and p.prorettype='jsonb'::regtype and p.proargnames=array['items']::text[] and p.prosecdef)
     from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='create_order') as rpc_original_compatible,
  to_regprocedure('pg_catalog.gen_random_uuid()') is not null as aleatoriedad_disponible,
  exists(select 1 from pg_trigger where tgrelid='public.orders'::regclass and tgname='orders_public_code' and tgfoid='private.assign_order_code()'::regprocedure and tgenabled in ('O','A')) as trigger_original_activo,
  (select count(*)=2 and bool_and(convalidated) from pg_constraint where conrelid='public.orders'::regclass and conname in ('orders_public_code_format','orders_public_code_required')) as constraints_originales,
  not exists(select 1 from public.orders where customer_id is not null and (public_code is null or customer_seq is null)) as historicos_con_codigo,
  not exists(select 1 from public.orders where public_code is not null and public_code !~ '^[A-Z]{2}-[0-9]{3,}$') as formato_intermedio,
  not exists(select 1 from pg_depend where refclassid='pg_proc'::regclass and refobjid='public.create_order(jsonb)'::regprocedure and deptype='n') as sin_dependientes_oid;

-- 2. Esperado: cero filas. El RENAME conserva el OID y estos dependientes
-- seguirían usando el cuerpo anterior, sin pasar por el nuevo wrapper.
select pg_describe_object(classid,objid,objsubid) as dependiente
from pg_depend
where refclassid='pg_proc'::regclass
  and refobjid='public.create_order(jsonb)'::regprocedure and deptype='n';

-- 3. Línea base. Huellas de contenido, sin exponer datos de contacto.
-- Los códigos públicos son lo único que se excluye de la huella de pedidos.
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

-- 4. Comparar por ID: código actual = legacy_public_code posterior.
-- Los pedidos sin código previo deben conservar legacy_public_code NULL.
select id,public_code as codigo_anterior,customer_seq,
       md5((to_jsonb(o)-'public_code'-'legacy_public_code')::text) as huella_pedido
from public.orders o order by id;

-- 5. Revisión manual: llamadas textuales a create_order no siempre aparecen
-- en pg_depend (PL/pgSQL / SQL dinámico). No ejecutar estas definiciones.
select p.oid::regprocedure::text as funcion, p.prosrc as cuerpo
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname in ('public','private') and p.oid <> 'public.create_order(jsonb)'::regprocedure
  and p.prosrc ~ '\mcreate_order\M';
