-- =====================================================================
-- Herramientas de stock del panel: movimientos rápidos, pedidos a
-- proveedor y ventas presenciales.
--
-- No crea otro sistema de stock: todo pasa por inventory_movements (el
-- trigger existente suma la cantidad con signo al stock físico de forma
-- atómica y el CHECK stock >= 0 impide quedar en negativo).
--
-- 1. Entradas y salidas manuales (Stock rápido e Inventario) con
--    conciliación: ver la sección 4. Una salida que supera lo disponible
--    pide el stock físico real y registra, en una sola operación, el ajuste
--    de conciliación y la salida real. Nunca stock negativo; si no cubre las
--    reservas, exige confirmación y deja un faltante para resolver a mano.
--
-- 2. Pedidos a proveedor (reposición)
--    public.supplier_orders / supplier_order_items. Estados:
--      pedido → recibido | cancelado
--    Preparar el pedido NO mueve stock. Confirmar la recepción registra UNA
--    entrada por presentación (vinculada con supplier_order_id) y pasa a
--    «recibido» en la misma transacción. Confirmar dos veces no duplica: el
--    pedido se bloquea y, si ya está recibido, no hace nada.
--
-- 3. Ventas presenciales
--    Usan las tablas de pedidos existentes (orders / order_items), con
--    kind = 'presencial' y channel = 'presencial': mismo número correlativo,
--    mismo historial (order_events) y mismos movimientos (con order_id).
--    Se registran ya entregadas: la salida de stock se hace al crearla.
--      * Con cliente registrado: customer_id = la cuenta → aparece en
--        «Mis pedidos» del cliente (misma RLS de siempre).
--      * Sin cuenta: customer_id vacío y el nombre escrito a mano
--        («Sin asignar»). Más adelante se vincula a la cuenta con
--        admin_link_order_customer: se completa customer_id en la MISMA fila
--        (no se copia ni se duplica nada).
--      * Anular una venta (error de carga) devuelve el stock.
--    No vende lo reservado: controla lo disponible (físico − comprometido
--    por pedidos de yerbas), igual que los pedidos web.
--
-- Funciones nuevas (administradores):
--   public.admin_stock_movement(operation_id, variant_id, movement_type, quantity, …)
--   public.admin_stock_preview(variant_id, quantity, declared_physical)
--   public.admin_resolve_shortage(shortage_id, resolution)
--   public.admin_create_supplier_order(items, supplier, note, client_key)
--   public.admin_receive_supplier_order(order_id, items)
--   public.admin_cancel_supplier_order(order_id)
--   public.admin_create_sale(items, customer_id, customer_name, note, client_key)
--   public.admin_link_order_customer(order_id, customer_id)
--   public.admin_cancel_sale(order_id)
--
-- Cambia una función existente: private.apply_inventory_movement (el trigger
-- de movimientos) suma la regla de reservas para salidas directas por la API.
-- El resto de su comportamiento es idéntico.
--
-- Compatibilidad con lo publicado (misma base):
--   * Pedidos de la tienda y de yerbas: mismas reglas. Solo se amplían los
--     CHECK de orders para aceptar kind = 'presencial'.
--   * El panel publicado lista pedidos por kind 'yerbas' o 'tienda': las
--     ventas presenciales no le aparecen (no rompe nada).
--   * No modifica ni borra datos existentes.
--
-- Requiere 20261105000000_yerba_orders.sql. Se ejecuta UNA vez.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 2. Pedidos a proveedor
-- ---------------------------------------------------------------------
create table public.supplier_orders (
  id           bigint generated always as identity primary key,
  supplier     text not null default '' check (char_length(supplier) <= 120),
  note         text not null default '' check (char_length(note) <= 500),
  status       text not null default 'pedido' check (status in ('pedido', 'recibido', 'cancelado')),
  client_key   uuid unique,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  received_at  timestamptz,
  received_by  uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,
  constraint supplier_orders_received_check  check ((status = 'recibido') = (received_at is not null)),
  constraint supplier_orders_cancelled_check check ((status = 'cancelado') = (cancelled_at is not null))
);

create table public.supplier_order_items (
  id                bigint generated always as identity primary key,
  supplier_order_id bigint not null references public.supplier_orders (id) on delete cascade,
  variant_id        bigint references public.product_variants (id) on delete set null,
  product_name      text not null,
  variant_name      text,
  quantity          integer not null check (quantity between 1 and 9999),
  received_quantity integer check (received_quantity between 0 and 9999)
);

create index supplier_orders_created_idx on public.supplier_orders (created_at desc);
create index supplier_order_items_order_idx on public.supplier_order_items (supplier_order_id);

alter table public.inventory_movements
  add column supplier_order_id bigint references public.supplier_orders (id) on delete restrict;
create index inventory_movements_supplier_order_idx
  on public.inventory_movements (supplier_order_id) where supplier_order_id is not null;

comment on table public.supplier_orders is
  'Pedidos de reposición a proveedores. Prepararlos no mueve stock; la recepción registra las entradas.';

revoke all on public.supplier_orders, public.supplier_order_items from public, anon, authenticated;
grant select on public.supplier_orders, public.supplier_order_items to authenticated;
alter table public.supplier_orders      enable row level security;
alter table public.supplier_order_items enable row level security;

create policy "supplier_orders: admins leen"
  on public.supplier_orders for select to authenticated
  using ((select private.is_admin()));
create policy "supplier_order_items: admins leen"
  on public.supplier_order_items for select to authenticated
  using ((select private.is_admin()));

-- Resumen de un pedido a proveedor (lo devuelven las funciones).
create function private.supplier_order_summary(p_id bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', s.id, 'supplier', s.supplier, 'note', s.note, 'status', s.status,
    'created_at', s.created_at, 'received_at', s.received_at, 'cancelled_at', s.cancelled_at,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variant_id', i.variant_id, 'product_name', i.product_name, 'variant_name', i.variant_name,
               'quantity', i.quantity, 'received_quantity', i.received_quantity) order by i.id)
        from public.supplier_order_items i where i.supplier_order_id = s.id), '[]'::jsonb))
    from public.supplier_orders s
   where s.id = p_id
$$;

-- items: [{ "variant_id": 12, "quantity": 10 }, ...]. No mueve stock.
-- client_key: la misma clave devuelve el pedido ya creado (sin duplicar).
create function public.admin_create_supplier_order(items jsonb, supplier text default null,
                                                   note text default null, client_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key   uuid := admin_create_supplier_order.client_key;
  v_lines jsonb;
  v_id    bigint;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden hacer pedidos a proveedores.' using errcode = 'insufficient_privilege';
  end if;

  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('povmatero:supplier_order:' || v_key::text, 0));
    select s.id into v_id from public.supplier_orders s where s.client_key = v_key;
    if v_id is not null then
      return private.supplier_order_summary(v_id) || jsonb_build_object('repeated', true);
    end if;
  end if;

  v_lines := private.parse_order_items(items, 100, 9999);

  if exists (select 1 from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
              left join public.product_variants v on v.id = r.variant_id where v.id is null) then
    raise exception 'Hay una presentación que no existe.' using errcode = 'check_violation', hint = 'unavailable';
  end if;

  insert into public.supplier_orders (supplier, note, client_key)
  values (left(coalesce(private.clean_text(supplier, 120), ''), 120), left(coalesce(private.clean_text(note, 500), ''), 500), v_key)
  returning id into v_id;

  insert into public.supplier_order_items (supplier_order_id, variant_id, product_name, variant_name, quantity)
  select v_id, v.id, p.name, nullif(v.name, 'Único'), r.quantity
    from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
    join public.product_variants v on v.id = r.variant_id
    join public.products p on p.id = v.product_id
   order by r.variant_id;

  return private.supplier_order_summary(v_id);
end;
$$;

-- Confirmar la recepción: suma lo recibido al stock (una entrada por
-- presentación) y pasa a «recibido», todo junto.
-- items (opcional): [{ "variant_id": 12, "quantity": 8 }] = lo que llegó de
-- verdad; sin items = llegó todo lo pedido. 0 = no llegó esa presentación.
-- Si ya estaba recibido, no hace nada (devuelve already_received = true).
create function public.admin_receive_supplier_order(order_id bigint, items jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    bigint := admin_receive_supplier_order.order_id;
  v_order public.supplier_orders;
  r       record;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden recibir pedidos a proveedores.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.supplier_orders s where s.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido a proveedor #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.status = 'recibido' then
    return private.supplier_order_summary(v_id) || jsonb_build_object('already_received', true);
  end if;
  if v_order.status = 'cancelado' then
    raise exception 'El pedido a proveedor #% está cancelado.', v_id using errcode = 'check_violation', hint = 'invalid_transition';
  end if;

  if items is not null then
    if jsonb_typeof(items) is distinct from 'array' or exists (
         select 1 from jsonb_array_elements(items) e
          where jsonb_typeof(e -> 'variant_id') is distinct from 'number'
             or jsonb_typeof(e -> 'quantity') is distinct from 'number'
             or (e ->> 'quantity')::numeric <> trunc((e ->> 'quantity')::numeric)
             or (e ->> 'quantity')::numeric not between 0 and 9999) then
      raise exception 'Revisá las cantidades recibidas (enteros de 0 a 9999).'
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
  end if;

  -- Cantidad recibida de cada línea: la indicada o, si no se indicó, la pedida.
  update public.supplier_order_items i
     set received_quantity = coalesce(
           (select (e ->> 'quantity')::integer from jsonb_array_elements(coalesce(items, '[]'::jsonb)) e
             where (e ->> 'variant_id')::bigint = i.variant_id limit 1),
           i.quantity)
   where i.supplier_order_id = v_id;

  -- Una entrada por presentación (en orden de id: mismo orden de bloqueo que los pedidos).
  for r in
    select i.variant_id, sum(i.received_quantity)::integer as qty
      from public.supplier_order_items i
     where i.supplier_order_id = v_id and i.variant_id is not null and i.received_quantity > 0
     group by i.variant_id
     order by i.variant_id
  loop
    insert into public.inventory_movements (variant_id, movement_type, quantity, reason, reference, supplier_order_id)
    values (r.variant_id, 'entrada', r.qty,
            format('Pedido a proveedor #%s recibido', v_id),
            'Proveedor #' || v_id || coalesce(' · ' || nullif(v_order.supplier, ''), ''),
            v_id);
  end loop;

  update public.supplier_orders s
     set status = 'recibido', received_at = now(), received_by = (select auth.uid())
   where s.id = v_id;

  return private.supplier_order_summary(v_id);
end;
$$;

create function public.admin_cancel_supplier_order(order_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    bigint := admin_cancel_supplier_order.order_id;
  v_order public.supplier_orders;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden cancelar pedidos a proveedores.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_order from public.supplier_orders s where s.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido a proveedor #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.status = 'cancelado' then
    return private.supplier_order_summary(v_id);
  end if;
  if v_order.status <> 'pedido' then
    raise exception 'Un pedido ya recibido no se cancela (el stock ya entró).' using errcode = 'check_violation', hint = 'invalid_transition';
  end if;
  update public.supplier_orders s set status = 'cancelado', cancelled_at = now() where s.id = v_id;
  return private.supplier_order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 3. Ventas presenciales sobre orders
-- ---------------------------------------------------------------------
-- client_key: misma clave = misma venta (sin duplicar). La nota de la venta y
-- quién la cargó NO van en orders (el cliente vinculado lee su fila): quedan
-- en order_events (solo administradores), en el evento «creado».
alter table public.orders
  add column client_key uuid unique;

-- Tipos y reglas: se suma 'presencial' sin cambiar las de tienda y yerbas.
alter table public.orders drop constraint orders_kind_check;
alter table public.orders drop constraint orders_channel_check;
alter table public.orders drop constraint orders_status_check;
alter table public.orders drop constraint orders_expires_check;
alter table public.orders drop constraint orders_stock_applied_check;

alter table public.orders
  add constraint orders_kind_check check (kind in ('tienda', 'yerbas', 'presencial')),
  add constraint orders_channel_check check (
       (kind = 'presencial' and channel = 'presencial')
    or (kind <> 'presencial' and channel = 'whatsapp')
  ),
  add constraint orders_status_check check (
       (kind = 'tienda' and status is null)
    or (kind = 'yerbas' and status is not null
        and status in ('pendiente', 'confirmado', 'preparando', 'listo', 'entregado', 'cancelado'))
    or (kind = 'presencial' and status is not null and status in ('entregado', 'cancelado'))
  ),
  add constraint orders_expires_check check (
       (kind in ('tienda', 'presencial') and expires_at is null)
    or (kind = 'yerbas' and (status is distinct from 'pendiente' or expires_at is not null))
  ),
  add constraint orders_stock_applied_check check (
    stock_applied = (
         (kind = 'yerbas' and status is not null and status in ('listo', 'entregado'))
      or (kind = 'presencial' and status is not null and status = 'entregado'))
  ),
  -- Venta sin cuenta: tiene que tener un nombre.
  add constraint orders_presencial_name_check check (
    kind <> 'presencial' or customer_id is not null or char_length(btrim(customer_name)) > 0
  );

comment on column public.orders.kind is
  'tienda = carrito de la tienda (sin estados); yerbas = /yerbas (con estados y stock); presencial = venta cargada en el panel.';

-- Historial: se suma el evento de vinculación a una cuenta.
alter table public.order_events drop constraint order_events_event_check;
alter table public.order_events
  add constraint order_events_event_check check (event in ('creado', 'estado', 'editado', 'vinculado'));

-- Registrar una venta presencial (ya entregada: descuenta stock al crearla).
--   items: [{ "variant_id": 12, "quantity": 2 }, ...]  (cualquier presentación activa)
--   customer_id: cuenta del cliente, o null («Sin asignar»: entonces customer_name es obligatorio)
--   client_key: la misma clave devuelve la venta ya creada (sin duplicar)
create function public.admin_create_sale(items jsonb, customer_id uuid default null,
                                         customer_name text default null, note text default null,
                                         client_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_key    uuid := admin_create_sale.client_key;
  v_cust   uuid := admin_create_sale.customer_id;
  v_given  text := private.clean_text(admin_create_sale.customer_name, 170);
  v_lines  jsonb;
  v_name   text;
  v_email  text;
  v_phone  text;
  v_order  bigint;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden registrar ventas.' using errcode = 'insufficient_privilege';
  end if;

  if v_key is not null then
    perform pg_advisory_xact_lock(hashtextextended('povmatero:sale:' || v_key::text, 0));
    select o.id into v_order from public.orders o where o.client_key = v_key;
    if v_order is not null then
      return private.order_summary(v_order) || jsonb_build_object('repeated', true);
    end if;
  end if;

  v_lines := private.parse_order_items(items, 50, 999);

  if v_cust is not null then
    select btrim(concat_ws(' ', nullif(btrim(p.first_name), ''), nullif(btrim(p.last_name), ''))),
           coalesce(nullif(p.email, ''), u.email), p.phone
      into v_name, v_email, v_phone
      from auth.users u left join public.customer_profiles p on p.user_id = u.id
     where u.id = v_cust;
    if not found then
      raise exception 'No existe ese cliente.' using errcode = 'check_violation', hint = 'customer_not_found';
    end if;
    v_name := coalesce(nullif(v_name, ''), v_given, '');
  else
    if v_given is null then
      raise exception 'Escribí el nombre del cliente o elegí una cuenta.'
        using errcode = 'invalid_parameter_value', hint = 'customer_required';
    end if;
    v_name := v_given;
  end if;

  -- Bloquea y valida con los datos ya bloqueados (mismo orden que los pedidos).
  perform private.lock_order_lines(
    array(select (l ->> 'variant_id')::bigint from jsonb_array_elements(v_lines) l));
  if exists (select 1 from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
              left join public.product_variants v on v.id = r.variant_id and v.is_active
             where v.id is null) then
    raise exception 'Hay una presentación que no existe o no está activa.' using errcode = 'check_violation', hint = 'unavailable';
  end if;
  -- No vende lo reservado por pedidos de yerbas.
  perform private.check_availability(v_lines, null);

  insert into public.orders (customer_id, customer_name, customer_email, customer_phone, channel,
                             item_count, total, kind, status, stock_applied, status_changed_at, client_key)
  values (v_cust, left(coalesce(v_name, ''), 170), left(coalesce(v_email, ''), 254), left(v_phone, 30), 'presencial',
          1, 0, 'presencial', 'entregado', true, now(), v_key)
  returning id into v_order;

  insert into public.order_items (order_id, product_id, variant_id, product_name, variant_name,
                                  unit_price, quantity, line_total)
  select v_order, p.id, v.id, p.name, nullif(v.name, 'Único'), v.price, r.quantity, v.price * r.quantity
    from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
    join public.product_variants v on v.id = r.variant_id
    join public.products p on p.id = v.product_id
   order by r.variant_id;

  update public.orders o
     set total = s.total, item_count = s.n
    from (select sum(line_total) as total, sum(quantity)::integer as n
            from public.order_items where order_id = v_order) s
   where o.id = v_order;

  -- Salida de stock (una por presentación, con el número de venta).
  perform private.reconcile_order_stock(v_order, true, format('Venta presencial #%s', v_order));

  insert into public.order_events (order_id, event, to_status, detail)
  values (v_order, 'creado', 'entregado',
          jsonb_build_object('items', v_lines, 'presencial', true, 'sin_asignar', v_cust is null,
                             'nota', private.clean_text(admin_create_sale.note, 500)));

  return private.order_summary(v_order);
end;
$$;

-- Vincular una venta «Sin asignar» a la cuenta que el cliente creó después.
-- Completa customer_id en la misma fila (la venta aparece en sus pedidos).
-- Si ya está vinculada a esa cuenta, no hace nada; a otra cuenta, no se cambia.
create function public.admin_link_order_customer(order_id bigint, customer_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    bigint := admin_link_order_customer.order_id;
  v_cust  uuid := admin_link_order_customer.customer_id;
  v_order public.orders;
  v_email text;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden vincular ventas.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_order from public.orders o where o.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.kind <> 'presencial' then
    raise exception 'Solo se vinculan ventas presenciales.' using errcode = 'check_violation', hint = 'not_presencial';
  end if;
  if v_order.customer_id = v_cust then
    return private.order_summary(v_id);
  end if;
  if v_order.customer_id is not null then
    raise exception 'Esta venta ya está vinculada a otra cuenta.' using errcode = 'check_violation', hint = 'already_linked';
  end if;
  select coalesce(nullif(p.email, ''), u.email) into v_email
    from auth.users u left join public.customer_profiles p on p.user_id = u.id where u.id = v_cust;
  if not found then
    raise exception 'No existe ese cliente.' using errcode = 'check_violation', hint = 'customer_not_found';
  end if;

  update public.orders o
     set customer_id = v_cust,
         customer_email = left(coalesce(nullif(o.customer_email, ''), v_email, ''), 254),
         updated_at = now()
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status, detail)
  values (v_id, 'vinculado', v_order.status, v_order.status, jsonb_build_object('customer_id', v_cust));

  return private.order_summary(v_id);
end;
$$;

-- Anular una venta presencial cargada por error: devuelve el stock.
create function public.admin_cancel_sale(order_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    bigint := admin_cancel_sale.order_id;
  v_order public.orders;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden anular ventas.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_order from public.orders o where o.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.kind <> 'presencial' then
    raise exception 'Solo se anulan ventas presenciales desde acá.' using errcode = 'check_violation', hint = 'not_presencial';
  end if;
  if v_order.status = 'cancelado' then
    return private.order_summary(v_id);
  end if;

  perform private.reconcile_order_stock(v_id, false, format('Venta presencial #%s anulada', v_id));

  update public.orders o
     set status = 'cancelado', stock_applied = false, status_changed_at = now(), updated_at = now()
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status)
  values (v_id, 'estado', v_order.status, 'cancelado');

  return private.order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Entradas y salidas manuales con conciliación (Stock rápido e Inventario)
--
-- Una salida manual que supera lo DISPONIBLE (stock físico registrado −
-- reservas vigentes de pedidos web) no se bloquea para siempre: el stock del
-- sistema puede estar desactualizado. En ese caso se pide el stock físico
-- REAL que quedó después de la salida y, en una sola transacción, con la
-- presentación bloqueada:
--   1. un AJUSTE que lleva el stock registrado a lo que había de verdad antes
--      de la salida (declarado + cantidad que sale), si hace falta;
--   2. la SALIDA real de unidades.
-- El stock final queda igual al declarado (nunca negativo: el ajuste va
-- primero y el declarado es >= 0). Los dos movimientos quedan vinculados a la
-- misma operación (inventory_movements.operation_id → stock_operations), con
-- fecha, administrador y motivo.
-- Si el declarado no cubre las reservas, exige una confirmación explícita
-- (confirm_shortage) y deja la presentación señalada como FALTANTE
-- (stock_shortages) para resolverla a mano. Los pedidos y sus reservas no se
-- tocan.
-- Reintentos: la operación la identifica el id que genera el panel; repetirla
-- devuelve la misma operación sin registrar nada de nuevo.
-- Además, el trigger de movimientos rechaza una SALIDA directa por la API
-- (sin pedido, proveedor ni operación) que deje menos stock que lo reservado:
-- la regla no depende del panel.
-- ---------------------------------------------------------------------
create table public.stock_operations (
  id                uuid primary key,
  variant_id        bigint not null references public.product_variants (id) on delete restrict,
  movement_type     text not null check (movement_type in ('entrada', 'salida')),
  quantity          integer not null check (quantity between 1 and 9999),
  reason            text not null default '' check (char_length(reason) <= 200),
  reference         text check (reference is null or char_length(reference) <= 120),
  source            text not null default 'stock_rapido' check (source in ('stock_rapido', 'inventario')),
  stock_before      integer not null,
  reserved          integer not null default 0,
  declared_physical integer check (declared_physical >= 0),
  adjustment        integer not null default 0,
  stock_after       integer not null check (stock_after >= 0),
  shortage          integer not null default 0 check (shortage >= 0),
  created_by        uuid default auth.uid() references auth.users (id) on delete set null,
  created_at        timestamptz not null default now()
);
create index stock_operations_variant_idx on public.stock_operations (variant_id, created_at desc);

comment on table public.stock_operations is
  'Entradas y salidas manuales del panel. Una salida conciliada genera un ajuste y una salida, vinculados acá.';

create table public.stock_shortages (
  id           bigint generated always as identity primary key,
  variant_id   bigint not null references public.product_variants (id) on delete cascade,
  operation_id uuid references public.stock_operations (id) on delete set null,
  physical     integer not null check (physical >= 0),
  reserved     integer not null check (reserved >= 0),
  missing      integer not null check (missing > 0),
  status       text not null default 'abierto' check (status in ('abierto', 'resuelto')),
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  resolved_at  timestamptz,
  resolved_by  uuid references auth.users (id) on delete set null,
  resolution   text not null default '' check (char_length(resolution) <= 500),
  constraint stock_shortages_resolved_check check ((status = 'resuelto') = (resolved_at is not null))
);
create index stock_shortages_open_idx on public.stock_shortages (variant_id) where status = 'abierto';

comment on table public.stock_shortages is
  'Presentaciones con menos stock físico que lo reservado por pedidos web, para resolver a mano.';

alter table public.inventory_movements
  add column operation_id uuid references public.stock_operations (id) on delete restrict;
create index inventory_movements_operation_idx
  on public.inventory_movements (operation_id) where operation_id is not null;

revoke all on public.stock_operations, public.stock_shortages from public, anon, authenticated;
grant select on public.stock_operations, public.stock_shortages to authenticated;
alter table public.stock_operations enable row level security;
alter table public.stock_shortages  enable row level security;
create policy "stock_operations: admins leen"
  on public.stock_operations for select to authenticated
  using ((select private.is_admin()));
create policy "stock_shortages: admins leen"
  on public.stock_shortages for select to authenticated
  using ((select private.is_admin()));

-- Pedidos web que reservan una presentación (los que una falta afectaría).
create function private.reserving_orders(p_variant bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'order_id', o.id, 'customer_name', o.customer_name, 'status', o.status,
           'expires_at', o.expires_at, 'quantity', x.qty) order by o.created_at), '[]'::jsonb)
    from (select i.order_id, sum(i.quantity)::integer as qty
            from public.order_items i
           where i.variant_id = p_variant
           group by i.order_id) x
    join public.orders o on o.id = x.order_id
   where o.kind = 'yerbas' and private.order_commits_stock(o.status, o.expires_at)
$$;

-- Cálculo común (vista previa y validación): stock, reservas y resultado.
create function private.stock_exit_plan(p_variant bigint, p_qty integer, p_declared integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v        record;
  v_res    integer;
  v_avail  integer;
  v_exceed boolean;
  v_after  integer;
begin
  select pv.id, pv.stock, pv.track_stock, p.name as product_name, nullif(pv.name, 'Único') as variant_name
    into v
    from public.product_variants pv join public.products p on p.id = pv.product_id
   where pv.id = p_variant;
  if not found then
    return null;
  end if;
  v_res := case when v.track_stock then private.committed_qty(v.id) else 0 end;
  v_avail := greatest(v.stock - v_res, 0);
  v_exceed := v.track_stock and coalesce(p_qty, 0) > v_avail;
  v_after := case when v_exceed then p_declared else v.stock - coalesce(p_qty, 0) end;
  return jsonb_build_object(
    'variant_id', v.id, 'product_name', v.product_name, 'variant_name', v.variant_name,
    'track_stock', v.track_stock,
    'stock', v.stock, 'reserved', v_res, 'available', v_avail,
    'requested', p_qty, 'exceeds', v_exceed,
    'declared_physical', p_declared,
    'adjustment', case when v_exceed and p_declared is not null then p_declared + p_qty - v.stock else 0 end,
    'stock_after', v_after,
    'available_after', case when v_after is null then null else greatest(v_after - v_res, 0) end,
    'shortage', case when v_after is null then null else greatest(v_res - v_after, 0) end,
    'orders', case when v_res > 0 then private.reserving_orders(v.id) else '[]'::jsonb end);
end;
$$;

-- Vista previa para el panel (solo lectura).
create function public.admin_stock_preview(variant_id bigint, quantity integer default null,
                                           declared_physical integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan jsonb;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden ver el stock.' using errcode = 'insufficient_privilege';
  end if;
  v_plan := private.stock_exit_plan(admin_stock_preview.variant_id, admin_stock_preview.quantity,
                                    admin_stock_preview.declared_physical);
  if v_plan is null then
    raise exception 'No existe esa presentación.' using errcode = 'no_data_found', hint = 'not_found';
  end if;
  return v_plan;
end;
$$;

-- Resumen de una operación (con sus movimientos y el faltante, si hubo).
create function private.stock_operation_summary(p_op uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select to_jsonb(s) || jsonb_build_object(
    'movements', coalesce((select jsonb_agg(jsonb_build_object(
                    'id', m.id, 'movement_type', m.movement_type, 'quantity', m.quantity,
                    'stock_after', m.stock_after, 'reason', m.reason) order by m.id)
                  from public.inventory_movements m where m.operation_id = s.id), '[]'::jsonb),
    'shortage_id', (select f.id from public.stock_shortages f where f.operation_id = s.id limit 1))
    from public.stock_operations s
   where s.id = p_op
$$;

-- Registrar una entrada o salida manual (Stock rápido e Inventario).
--   operation_id: lo genera el panel; el mismo id = la misma operación (reintentos).
--   declared_physical: obligatorio si la salida supera lo disponible.
--   confirm_shortage: obligatorio si además el declarado no cubre las reservas.
-- Rechazos con hint: count_required, shortage_confirmation, operation_conflict,
-- invalid_items, not_found (detail = la vista previa en JSON).
create function public.admin_stock_movement(operation_id uuid, variant_id bigint, movement_type text,
                                            quantity integer, reason text default null,
                                            reference text default null, declared_physical integer default null,
                                            confirm_shortage boolean default false, source text default 'stock_rapido')
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_op       uuid := admin_stock_movement.operation_id;
  v_variant  bigint := admin_stock_movement.variant_id;
  v_type     text := admin_stock_movement.movement_type;
  v_qty      integer := admin_stock_movement.quantity;
  v_declared integer := admin_stock_movement.declared_physical;
  v_source   text := coalesce(admin_stock_movement.source, 'stock_rapido');
  v_reason   text;
  v_ref      text := private.clean_text(admin_stock_movement.reference, 120);
  v_label    text;
  v_prev     public.stock_operations;
  v_stock    integer;
  v_plan     jsonb;
  v_adj      integer := 0;
  v_after    integer;
  v_short    integer := 0;
  v_res      integer := 0;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden registrar movimientos de inventario.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_op is null or v_variant is null or v_type not in ('entrada', 'salida')
     or v_qty is null or v_qty not between 1 and 9999
     or v_source not in ('stock_rapido', 'inventario')
     or (v_declared is not null and v_declared not between 0 and 999999) then
    raise exception 'Revisá los datos: cantidad entera de 1 a 9999 y stock declarado mayor o igual a 0.'
      using errcode = 'invalid_parameter_value', hint = 'invalid_items';
  end if;
  v_reason := coalesce(private.clean_text(admin_stock_movement.reason, 200),
                       case when v_type = 'entrada' then 'Entrada' else 'Salida' end);
  v_label := case when v_source = 'inventario' then 'Inventario' else 'Movimiento rápido' end;

  -- Misma operación (reintento o doble clic): se devuelve sin registrar nada.
  perform pg_advisory_xact_lock(hashtextextended('povmatero:stock_op:' || v_op::text, 0));
  select * into v_prev from public.stock_operations o where o.id = v_op;
  if found then
    if v_prev.variant_id <> v_variant or v_prev.movement_type <> v_type or v_prev.quantity <> v_qty then
      raise exception 'Esa operación ya se registró con otros datos. Actualizá la pantalla.'
        using errcode = 'check_violation', hint = 'operation_conflict';
    end if;
    return private.stock_operation_summary(v_op) || jsonb_build_object('repeated', true);
  end if;

  -- La presentación queda bloqueada hasta el final: pedidos web, otras
  -- salidas y cambios de estado que muevan stock esperan.
  select pv.stock into v_stock from public.product_variants pv where pv.id = v_variant for update;
  if not found then
    raise exception 'No existe esa presentación.' using errcode = 'no_data_found', hint = 'not_found';
  end if;

  v_plan := private.stock_exit_plan(v_variant, case when v_type = 'salida' then v_qty end, v_declared);
  v_res := (v_plan ->> 'reserved')::integer;

  if v_type = 'entrada' then
    v_after := v_stock + v_qty;
    v_declared := null;
  elsif not (v_plan ->> 'exceeds')::boolean then
    -- Alcanza lo disponible: salida común.
    if v_stock - v_qty < 0 then
      raise exception 'No hay stock suficiente (stock registrado: %).', v_stock
        using errcode = 'check_violation', hint = 'insufficient_stock';
    end if;
    v_after := v_stock - v_qty;
    v_declared := null;
  else
    -- Supera lo disponible: hace falta el stock físico real.
    if v_declared is null then
      raise exception 'La salida supera el stock disponible: indicá el stock físico real que quedó.'
        using errcode = 'check_violation', hint = 'count_required', detail = v_plan::text;
    end if;
    v_adj := v_declared + v_qty - v_stock;
    v_after := v_declared;
    v_short := greatest(v_res - v_declared, 0);
    if v_short > 0 and not coalesce(confirm_shortage, false) then
      raise exception 'El stock físico declarado no cubre las reservas de pedidos web (faltan %).', v_short
        using errcode = 'check_violation', hint = 'shortage_confirmation', detail = v_plan::text;
    end if;
  end if;

  insert into public.stock_operations (id, variant_id, movement_type, quantity, reason, reference, source,
                                       stock_before, reserved, declared_physical, adjustment, stock_after, shortage)
  values (v_op, v_variant, v_type, v_qty, v_reason, v_ref, v_source,
          v_stock, v_res, v_declared, v_adj, v_after, v_short);

  -- 1. Ajuste de conciliación (primero: así el stock nunca pasa por negativo).
  if v_adj <> 0 then
    insert into public.inventory_movements (variant_id, movement_type, quantity, reason, reference, operation_id)
    values (v_variant, 'ajuste', v_adj,
            format('Conciliación: el sistema tenía %s y había %s antes de la salida (quedaron %s). %s',
                   v_stock, v_declared + v_qty, v_declared, v_reason),
            coalesce(v_ref, v_label), v_op);
  end if;

  -- 2. El movimiento real.
  insert into public.inventory_movements (variant_id, movement_type, quantity, reason, reference, operation_id)
  values (v_variant, v_type::public.inventory_movement_type,
          case when v_type = 'salida' then -v_qty else v_qty end,
          v_reason, coalesce(v_ref, v_label), v_op);

  -- 3. Faltante para resolver a mano (los pedidos no se tocan).
  if v_short > 0 then
    insert into public.stock_shortages (variant_id, operation_id, physical, reserved, missing)
    values (v_variant, v_op, v_after, v_res, v_short);
  end if;

  return private.stock_operation_summary(v_op);
end;
$$;

-- Marcar un faltante como resuelto (después de reponer o de ajustar los pedidos a mano).
create function public.admin_resolve_shortage(shortage_id bigint, resolution text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.stock_shortages;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden resolver faltantes.' using errcode = 'insufficient_privilege';
  end if;
  update public.stock_shortages f
     set status = 'resuelto', resolved_at = now(), resolved_by = (select auth.uid()),
         resolution = left(coalesce(private.clean_text(admin_resolve_shortage.resolution, 500), ''), 500)
   where f.id = admin_resolve_shortage.shortage_id and f.status = 'abierto'
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.stock_shortages f where f.id = admin_resolve_shortage.shortage_id;
    if not found then
      raise exception 'No existe ese faltante.' using errcode = 'no_data_found', hint = 'not_found';
    end if;
  end if;
  return to_jsonb(v_row);
end;
$$;

-- Trigger de movimientos: misma función de siempre + la regla de reservas.
-- Una SALIDA hecha directo por la API (sin pedido, proveedor ni operación
-- conciliada) no puede dejar menos stock que lo reservado por pedidos web.
create or replace function private.apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stock integer;
  v_track boolean;
  v_res   integer;
begin
  -- Peticiones por la API (anon/authenticated): solo admins.
  -- (La política RLS de INSERT lo vuelve a exigir; esto evita depender del orden.)
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated')
     and not private.is_admin() then
    raise exception 'Solo los administradores pueden registrar movimientos de inventario.'
      using errcode = 'insufficient_privilege';
  end if;

  -- El cliente nunca define el resultado ni el autor.
  new.stock_after := null;
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') then
    new.created_by := (select auth.uid());
  end if;

  perform set_config('povmatero.allow_stock_write', 'on', true);

  update public.product_variants
     set stock = stock + new.quantity
   where id = new.variant_id
  returning stock, track_stock into v_stock, v_track;

  perform set_config('povmatero.allow_stock_write', 'off', true);

  if v_stock is null then
    raise exception 'La variante % no existe.', new.variant_id;
  end if;

  -- Reservas: con la presentación ya bloqueada por el UPDATE de arriba.
  if new.movement_type = 'salida' and v_track
     and new.order_id is null and new.supplier_order_id is null and new.operation_id is null
     and (auth.jwt() ->> 'role') in ('anon', 'authenticated') then
    v_res := private.committed_qty(new.variant_id);
    if v_stock < v_res then
      raise exception 'La salida deja menos stock que lo reservado por pedidos web (reservado: %, quedaría: %). Registrala desde Inventario o Stock rápido para conciliar el stock. (stock_check)', v_res, v_stock
        using errcode = 'check_violation', hint = 'reserved_stock';
    end if;
  end if;

  new.stock_after := v_stock;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------
revoke all on function private.reserving_orders(bigint)                                    from public, anon, authenticated;
revoke all on function private.stock_exit_plan(bigint, integer, integer)                  from public, anon, authenticated;
revoke all on function private.stock_operation_summary(uuid)                              from public, anon, authenticated;
revoke all on function public.admin_stock_preview(bigint, integer, integer)                from public, anon, authenticated;
revoke all on function public.admin_stock_movement(uuid, bigint, text, integer, text, text, integer, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_resolve_shortage(bigint, text)                        from public, anon, authenticated;
grant execute on function public.admin_stock_preview(bigint, integer, integer)            to authenticated;
grant execute on function public.admin_stock_movement(uuid, bigint, text, integer, text, text, integer, boolean, text) to authenticated;
grant execute on function public.admin_resolve_shortage(bigint, text)                     to authenticated;
revoke all on function private.supplier_order_summary(bigint)                              from public, anon, authenticated;
revoke all on function public.admin_create_supplier_order(jsonb, text, text, uuid)         from public, anon, authenticated;
revoke all on function public.admin_receive_supplier_order(bigint, jsonb)                  from public, anon, authenticated;
revoke all on function public.admin_cancel_supplier_order(bigint)                          from public, anon, authenticated;
revoke all on function public.admin_create_sale(jsonb, uuid, text, text, uuid)             from public, anon, authenticated;
revoke all on function public.admin_link_order_customer(bigint, uuid)                      from public, anon, authenticated;
revoke all on function public.admin_cancel_sale(bigint)                                    from public, anon, authenticated;
grant execute on function public.admin_create_supplier_order(jsonb, text, text, uuid)     to authenticated;
grant execute on function public.admin_receive_supplier_order(bigint, jsonb)              to authenticated;
grant execute on function public.admin_cancel_supplier_order(bigint)                      to authenticated;
grant execute on function public.admin_create_sale(jsonb, uuid, text, text, uuid)         to authenticated;
grant execute on function public.admin_link_order_customer(bigint, uuid)                  to authenticated;
grant execute on function public.admin_cancel_sale(bigint)                                to authenticated;

commit;
