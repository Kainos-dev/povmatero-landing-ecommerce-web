-- =====================================================================
-- Pedidos de yerbas (/yerbas) sobre las tablas de pedidos existentes.
--
-- Reutiliza: products / product_variants (el catálogo de yerbas es la
-- categoría «yerbas»), inventory_movements (el stock solo cambia con
-- movimientos) y orders / order_items (mismo número correlativo para pedidos
-- de la tienda y de yerbas).
--
-- Qué agrega:
--   * products.brand: marca, para armar las góndolas de /yerbas. Se completa
--     para Canarias, Rei Verde, Sara y Armiño; el resto queda vacío y se
--     muestra en «Otras marcas».
--   * orders.kind ('tienda' | 'yerbas') y, SOLO para yerbas, el estado:
--       pendiente → confirmado → preparando → listo → entregado, y cancelado.
--     Los pedidos de la tienda siguen igual, sin estados.
--   * order_events: historial de cada pedido (creación, estados, ediciones).
--   * inventory_movements.order_id: los movimientos que genera un pedido
--     quedan vinculados a él.
--
-- Stock:
--   * Físico = product_variants.stock (solo cambia con movimientos).
--   * Comprometido = lo pedido en pedidos de yerbas CONFIRMADOS, EN
--     PREPARACIÓN y PENDIENTES de menos de 24 horas. Se calcula siempre desde
--     los pedidos (no se guarda aparte), así nunca queda desfasado. Un
--     pendiente vencido deja de comprometer solo, sin tareas programadas.
--   * Disponible = físico − comprometido. Es lo que muestra la tienda
--     (storefront_catalog.stock).
--   * Al pasar a LISTO se registra la salida real (un movimiento por
--     presentación, con el número de pedido). Al volver a PREPARANDO o al
--     cancelar desde LISTO, la entrada que lo devuelve.
--   * Sin movimientos duplicados: cada cambio lleva el stock del pedido a lo
--     que corresponde según su estado, descontando los movimientos que el
--     pedido ya tiene (repetir una acción no mueve nada).
--   * Movimientos: quantity es la variación CON SIGNO que el trigger suma al
--     stock (stock = stock + quantity); la tabla exige salida < 0 y entrada > 0.
--     Las funciones de acá respetan eso: salida con cantidad negativa, entrada
--     con positiva (igual que el panel de inventario).
--   * Sin sobreventa: crear, editar (al aumentar) y confirmar un pendiente
--     vencido bloquean las presentaciones involucradas (siempre en el mismo
--     orden) y recién ahí calculan lo disponible.
--   * Datos al día: al crear o editar, primero se bloquean categoría, producto
--     y presentación, y recién después se valida publicación, precio y
--     categoría. Lo que se despublique o cambie a la vez espera a que el pedido
--     termine (o el pedido ve el cambio y se rechaza).
--   * Un pedido por vez por cliente: dos solicitudes simultáneas de la misma
--     cuenta se ordenan (bloqueo por cliente), así el límite de 3 pendientes
--     no se puede superar.
--
-- Funciones nuevas (nada se escribe directo en las tablas desde la API):
--   public.create_yerba_order(items, contact_phone)   cliente con cuenta
--   public.admin_set_order_status(order_id, status)   administradores
--   public.admin_update_order_items(order_id, items)  administradores
--   public.variant_commitments()                      comprometido por presentación
--
-- Compatibilidad con lo que ya está publicado (misma base):
--   * public.create_order (carrito de la tienda) NO cambia: sus pedidos
--     quedan como kind = 'tienda'.
--   * storefront_catalog conserva sus columnas (stock pasa a ser el
--     disponible; sin pedidos de yerbas es el mismo número) y suma «brand» al final.
--   * No borra ni modifica pedidos existentes (solo completa updated_at).
--
-- Se ejecuta UNA vez: si ya existe alguna de las columnas o tablas nuevas,
-- falla al empezar y no cambia nada. Verificar antes con
-- supabase/checks/20261105_antes_de_pedidos_yerbas.sql y después con
-- supabase/checks/20261105_despues_de_pedidos_yerbas.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Marca de cada producto
-- ---------------------------------------------------------------------
alter table public.products
  add column brand text check (brand is null or char_length(btrim(brand)) between 1 and 60);

comment on column public.products.brand is
  'Marca (yerbas: arma las góndolas de /yerbas). Vacía = «Otras marcas».';

grant select (brand) on public.products to anon, authenticated;
grant insert (brand), update (brand) on public.products to authenticated;

-- Yerbas actuales: la marca es el comienzo del nombre («Canarias Serena» → Canarias).
-- Solo la categoría yerbas y solo nombres que empiezan con la marca + espacio
-- (o son exactamente la marca): «Sarandí» no sería Sara.
update public.products p
   set brand = b.brand
  from (values ('Canarias'), ('Rei Verde'), ('Sara'), ('Armiño')) as b (brand)
 where p.category_id = (select c.id from public.categories c where c.slug = 'yerbas')
   and (lower(p.name) = lower(b.brand) or lower(p.name) like lower(b.brand) || ' %');

-- ---------------------------------------------------------------------
-- 2. Pedidos: tipo, estado y stock
-- ---------------------------------------------------------------------
alter table public.orders
  add column kind              text not null default 'tienda',
  add column status            text,
  add column expires_at        timestamptz,
  add column stock_applied     boolean not null default false,
  add column status_changed_at timestamptz,
  add column updated_at        timestamptz not null default now();

update public.orders set updated_at = created_at;

-- Los pedidos que ya existían quedan como de la tienda, sin estado. Si no fuera
-- así, se cancela toda la migración.
do $$
begin
  if exists (select 1 from public.orders where kind <> 'tienda' or status is not null or stock_applied) then
    raise exception 'Hay pedidos existentes que no quedaron como «tienda» sin estado. No se aplicó nada.';
  end if;
end;
$$;

-- Reglas por separado y sin depender de NULL (un CHECK con resultado NULL se
-- da por cumplido: por eso cada una se escribe para dar siempre true o false).
alter table public.orders
  add constraint orders_kind_check check (kind in ('tienda', 'yerbas')),
  -- Tienda: nunca tiene estado. Yerbas: SIEMPRE tiene uno de los seis estados.
  add constraint orders_status_check check (
       (kind = 'tienda' and status is null)
    or (kind = 'yerbas' and status is not null
        and status in ('pendiente', 'confirmado', 'preparando', 'listo', 'entregado', 'cancelado'))
  ),
  add constraint orders_yerbas_status_required check (kind <> 'yerbas' or status is not null),
  -- Vencimiento: obligatorio en pendientes de yerbas; los de tienda no tienen.
  add constraint orders_expires_check check (
       (kind = 'tienda' and expires_at is null)
    or (kind = 'yerbas' and (status is distinct from 'pendiente' or expires_at is not null))
  ),
  -- El stock está descontado exactamente en LISTO y ENTREGADO (nunca en la tienda).
  add constraint orders_stock_applied_check check (
    stock_applied = (kind = 'yerbas' and status is not null and status in ('listo', 'entregado'))
  );

create index orders_kind_status_idx on public.orders (kind, status, created_at desc);
create index order_items_variant_idx on public.order_items (variant_id);

comment on column public.orders.kind is
  'tienda = carrito de la tienda (sin estados); yerbas = /yerbas (con estados y stock).';
comment on column public.orders.status is
  'Solo yerbas: pendiente, confirmado, preparando, listo, entregado, cancelado.';
comment on column public.orders.expires_at is
  'Solo yerbas: un pedido pendiente deja de comprometer stock después de esta fecha.';
comment on column public.orders.stock_applied is
  'Solo yerbas: true = la salida de stock está registrada (estados listo y entregado).';

-- ---------------------------------------------------------------------
-- 3. Historial de cada pedido (solo administradores)
-- ---------------------------------------------------------------------
create table public.order_events (
  id          bigint generated always as identity primary key,
  order_id    bigint not null references public.orders (id) on delete cascade,
  event       text not null check (event in ('creado', 'estado', 'editado')),
  from_status text,
  to_status   text,
  detail      jsonb not null default '{}'::jsonb,
  created_by  uuid default auth.uid() references auth.users (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index order_events_order_idx on public.order_events (order_id, created_at);

comment on table public.order_events is
  'Historial de pedidos: creación, cambios de estado y ediciones. Lo escriben las funciones de pedidos.';

revoke all on public.order_events from public, anon, authenticated;
grant select on public.order_events to authenticated;
alter table public.order_events enable row level security;

create policy "order_events: admins leen todos"
  on public.order_events for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- 4. Movimientos vinculados a pedidos
--    authenticated no tiene permiso de columna sobre order_id: solo lo
--    completan las funciones de esta migración.
-- ---------------------------------------------------------------------
alter table public.inventory_movements
  add column order_id bigint references public.orders (id) on delete restrict;

create index inventory_movements_order_idx
  on public.inventory_movements (order_id, variant_id) where order_id is not null;

-- ---------------------------------------------------------------------
-- 5. Ayudantes (privados)
-- ---------------------------------------------------------------------
-- ¿El pedido compromete stock en este estado?
create function private.order_commits_stock(p_status text, p_expires_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(p_status in ('confirmado', 'preparando')
      or (p_status = 'pendiente' and p_expires_at > now()), false)
$$;

-- Unidades comprometidas de una presentación, sin contar un pedido (si se indica).
create function private.committed_qty(p_variant bigint, p_exclude_order bigint default null)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(i.quantity), 0)::integer
    from public.order_items i
    join public.orders o on o.id = i.order_id
   where i.variant_id = p_variant
     and o.kind = 'yerbas'
     and private.order_commits_stock(o.status, o.expires_at)
     and (p_exclude_order is null or o.id <> p_exclude_order)
$$;

-- Teléfono razonable: 8 a 15 dígitos, con +, espacios, guiones o paréntesis.
create function private.valid_phone(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p ~ '^\+?[0-9 ()./-]{8,30}$'
     and char_length(regexp_replace(p, '[^0-9]', '', 'g')) between 8 and 15
$$;

-- «Canarias Serena 1kg (quedan 1), Sara Coco 500gr (quedan 0)».
create function private.shortage_text(p_short jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select string_agg(format('%s%s (quedan %s)', s ->> 'product_name',
                           coalesce(' ' || nullif(s ->> 'variant_name', 'Único'), ''),
                           s ->> 'available'), ', ')
    from jsonb_array_elements(p_short) s
$$;

-- Bloquea las presentaciones (en orden de id) y comprueba que alcance lo disponible.
--   p_lines: [{ variant_id, quantity, previous }]
--   previous = unidades que este mismo pedido ya compromete de esa presentación:
--   solo se controla lo que aumenta (bajar o mantener nunca falla).
--   p_exclude_order: el pedido que se está editando o confirmando (no se cuenta
--   como comprometido por otros).
-- Si no alcanza, cancela todo con hint 'insufficient_stock' y el detalle en JSON.
create function private.check_availability(p_lines jsonb, p_exclude_order bigint)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r       record;
  v       record;
  v_avail integer;
  v_short jsonb := '[]'::jsonb;
begin
  for r in
    select (e ->> 'variant_id')::bigint as variant_id,
           (e ->> 'quantity')::integer as qty,
           coalesce((e ->> 'previous')::integer, 0) as prev
      from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
     order by 1
  loop
    select pv.id, pv.stock, pv.track_stock, p.name as product_name, pv.name as variant_name
      into v
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.id = r.variant_id
       for update of pv;
    if not found then
      continue;
    end if;
    if v.track_stock and r.qty > r.prev then
      -- Después del bloqueo: ve todo lo que otros ya confirmaron.
      v_avail := v.stock - private.committed_qty(v.id, p_exclude_order);
      if r.qty > v_avail then
        v_short := v_short || jsonb_build_object(
          'variant_id', v.id, 'product_name', v.product_name, 'variant_name', v.variant_name,
          'requested', r.qty, 'available', greatest(v_avail, 0));
      end if;
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 then
    raise exception 'No alcanza el stock de: %.', private.shortage_text(v_short)
      using errcode = 'check_violation', hint = 'insufficient_stock', detail = v_short::text;
  end if;
end;
$$;

-- Lleva el stock de un pedido a lo que corresponde:
--   p_apply = true  → descontado (presentaciones con control de stock: −cantidad)
--   p_apply = false → sin descontar (0)
-- Registra solo la diferencia con los movimientos que el pedido ya tiene, así
-- repetirlo nunca duplica nada. Bloquea las presentaciones en orden de id.
-- Si falta stock físico para una salida, cancela todo (hint 'insufficient_stock').
-- La llama admin_set_order_status con el pedido ya bloqueado.
create function private.reconcile_order_stock(p_order bigint, p_apply boolean, p_reason text)
returns void
language plpgsql
set search_path = ''
as $$
declare
  r        record;
  v        record;
  v_target integer;
  v_delta  integer;
  v_short  jsonb := '[]'::jsonb;
begin
  for r in
    with lines as (
      select i.variant_id, sum(i.quantity)::integer as qty
        from public.order_items i
       where i.order_id = p_order and i.variant_id is not null
       group by i.variant_id
    ),
    moved as (
      select m.variant_id, sum(m.quantity)::integer as net
        from public.inventory_movements m
       where m.order_id = p_order
       group by m.variant_id
    ),
    ids as (select variant_id from lines union select variant_id from moved)
    select ids.variant_id, coalesce(l.qty, 0) as qty, coalesce(mv.net, 0) as net
      from ids
      left join lines l  on l.variant_id = ids.variant_id
      left join moved mv on mv.variant_id = ids.variant_id
     order by ids.variant_id
  loop
    select pv.id, pv.stock, pv.track_stock, p.name as product_name, pv.name as variant_name
      into v
      from public.product_variants pv
      join public.products p on p.id = pv.product_id
     where pv.id = r.variant_id
       for update of pv;
    if not found then
      continue;
    end if;

    v_target := case when p_apply and v.track_stock then -r.qty else 0 end;
    v_delta := v_target - r.net;

    if v_delta < 0 and v.stock + v_delta < 0 then
      v_short := v_short || jsonb_build_object(
        'variant_id', v.id, 'product_name', v.product_name, 'variant_name', v.variant_name,
        'requested', -v_delta, 'available', v.stock);
    elsif v_delta <> 0 then
      insert into public.inventory_movements (variant_id, movement_type, quantity, reason, reference, order_id)
      values (v.id,
              (case when v_delta > 0 then 'entrada' else 'salida' end)::public.inventory_movement_type,
              v_delta, p_reason, 'Pedido #' || p_order, p_order);
    end if;
  end loop;

  if jsonb_array_length(v_short) > 0 then
    raise exception 'No hay stock físico suficiente de: %. Revisá el inventario.', private.shortage_text(v_short)
      using errcode = 'check_violation', hint = 'insufficient_stock', detail = v_short::text;
  end if;
end;
$$;

-- Resumen de un pedido (lo devuelven las funciones públicas).
create function private.order_summary(p_order bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'kind', o.kind,
    'status', o.status,
    'expires_at', o.expires_at,
    'expired', (o.status = 'pendiente' and o.expires_at <= now()),
    'stock_applied', o.stock_applied,
    'total', o.total,
    'item_count', o.item_count,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'variant_id', i.variant_id, 'product_id', i.product_id,
               'product_name', i.product_name, 'variant_name', i.variant_name,
               'unit_price', i.unit_price, 'quantity', i.quantity, 'line_total', i.line_total)
             order by i.id)
        from public.order_items i where i.order_id = o.id), '[]'::jsonb))
    from public.orders o
   where o.id = p_order
$$;

-- Lee la lista de productos que llega de la API:
--   [{ "variant_id": 12, "quantity": 2 }, ...] → una línea por presentación,
--   ordenadas por id. Primero valida CADA elemento por separado (objeto,
--   variant_id entero positivo, quantity entero entre 1 y el máximo): una
--   cantidad negativa nunca puede compensarse con otra. Recién después suma
--   las presentaciones repetidas y vuelve a controlar el máximo.
create function private.parse_order_items(p_items jsonb, p_max_lines integer, p_max_qty integer)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  e       jsonb;
  v_id    numeric;
  v_qty   numeric;
  v_lines jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > p_max_lines then
    raise exception 'El pedido tiene que tener entre 1 y % productos.', p_max_lines
      using errcode = 'invalid_parameter_value', hint = 'invalid_items';
  end if;

  for e in select x from jsonb_array_elements(p_items) as t (x) loop
    if jsonb_typeof(e) is distinct from 'object'
       or jsonb_typeof(e -> 'variant_id') is distinct from 'number'
       or jsonb_typeof(e -> 'quantity') is distinct from 'number' then
      raise exception 'Hay un producto con datos no válidos.'
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
    v_id := (e ->> 'variant_id')::numeric;
    v_qty := (e ->> 'quantity')::numeric;
    if v_id <> trunc(v_id) or v_id < 1 or v_id > 9223372036854775807 then
      raise exception 'Hay un producto con datos no válidos.'
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
    if v_qty <> trunc(v_qty) or v_qty < 1 or v_qty > p_max_qty then
      raise exception 'Cada producto puede pedirse de 1 a % unidades.', p_max_qty
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
  end loop;

  select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'quantity', qty) order by variant_id)
    into v_lines
    from (select (x ->> 'variant_id')::bigint as variant_id, sum((x ->> 'quantity')::integer)::integer as qty
            from jsonb_array_elements(p_items) as t (x)
           group by 1) s;

  if exists (select 1 from jsonb_array_elements(v_lines) l
              where (l ->> 'quantity')::integer > p_max_qty) then
    raise exception 'Cada producto puede pedirse de 1 a % unidades.', p_max_qty
      using errcode = 'invalid_parameter_value', hint = 'invalid_items';
  end if;

  return v_lines;
end;
$$;

-- Bloquea lo que necesita un pedido, siempre en el mismo orden:
--   1) categoría y producto de cada presentación: FOR SHARE (nadie puede
--      despublicarlos ni cambiarles la categoría hasta que termine el pedido;
--      otros pedidos sí pueden leerlos a la vez);
--   2) las presentaciones: FOR UPDATE, por id (nadie puede cambiar precio,
--      publicación ni stock hasta que termine).
-- Las validaciones se hacen DESPUÉS de esto, con los datos ya bloqueados.
-- (count(*) recorre todas las filas: así se bloquean todas, no solo la primera.)
create function private.lock_order_lines(p_variants bigint[])
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform count(*) from (
    select 1 from public.products p
      join public.categories c on c.id = p.category_id
     where p.id in (select v.product_id from public.product_variants v where v.id = any (p_variants))
     order by p.id
       for share of p, c) a;
  perform count(*) from (
    select 1 from public.product_variants v
     where v.id = any (p_variants)
     order by v.id
       for update of v) b;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Comprometido por presentación (para la tienda: solo cantidades)
-- ---------------------------------------------------------------------
create function public.variant_commitments()
returns table (variant_id bigint, quantity integer)
language sql
stable
security definer
set search_path = ''
as $$
  select i.variant_id, sum(i.quantity)::integer
    from public.order_items i
    join public.orders o on o.id = i.order_id
   where o.kind = 'yerbas'
     and i.variant_id is not null
     and private.order_commits_stock(o.status, o.expires_at)
   group by i.variant_id
$$;

-- ---------------------------------------------------------------------
-- 7. Crear un pedido de yerbas (cliente con cuenta)
--    items: [{ "variant_id": 12, "quantity": 2 }, ...]
--    contact_phone: opcional; si llega, se guarda también en el perfil.
--    Sin teléfono (ni en el perfil) no se crea: hint 'phone_required'.
-- ---------------------------------------------------------------------
create function public.create_yerba_order(items jsonb, contact_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user          uuid := (select auth.uid());
  v_lines         jsonb;
  v_phone         text;
  v_given_phone   text := private.clean_text(contact_phone, 30);
  v_profile_phone text;
  v_has_profile   boolean := false;
  v_name          text;
  v_email         text;
  v_order         bigint;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta para hacer el pedido.'
      using errcode = 'insufficient_privilege', hint = 'login_required';
  end if;

  v_lines := private.parse_order_items(items, 30, 20);

  -- Un pedido por vez por cliente: dos solicitudes simultáneas de la misma
  -- cuenta esperan una a la otra, así los límites de abajo se cuentan bien.
  -- (Bloqueo de la transacción: se libera solo al terminar.)
  perform pg_advisory_xact_lock(hashtextextended('povmatero:create_yerba_order:' || v_user::text, 0));

  if (select count(*) from public.orders
       where customer_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Hiciste muchos pedidos seguidos. Esperá un rato e intentá de nuevo.'
      using errcode = 'check_violation', hint = 'rate_limit';
  end if;

  if (select count(*) from public.orders
       where customer_id = v_user and kind = 'yerbas'
         and status = 'pendiente' and expires_at > now()) >= 3 then
    raise exception 'Ya tenés 3 pedidos pendientes. Esperá a que los confirmemos o escribinos por WhatsApp.'
      using errcode = 'check_violation', hint = 'too_many_pending';
  end if;

  -- Teléfono: el que llega o el del perfil.
  select p.phone, true into v_profile_phone, v_has_profile
    from public.customer_profiles p where p.user_id = v_user;
  v_phone := coalesce(v_given_phone, private.clean_text(v_profile_phone, 30));
  if v_phone is null then
    raise exception 'Necesitamos un teléfono para coordinar el pedido.'
      using errcode = 'invalid_parameter_value', hint = 'phone_required';
  end if;
  if not private.valid_phone(v_phone) then
    raise exception 'Revisá el teléfono: tiene que tener entre 8 y 15 números.'
      using errcode = 'invalid_parameter_value', hint = 'phone_invalid';
  end if;
  if v_given_phone is not null and coalesce(v_has_profile, false)
     and v_profile_phone is distinct from v_phone then
    update public.customer_profiles set phone = v_phone where user_id = v_user;
  end if;

  -- Bloquea categoría, productos y presentaciones ANTES de validar: desde acá
  -- nadie puede despublicarlos ni cambiarles el precio hasta que termine.
  perform private.lock_order_lines(
    array(select (l ->> 'variant_id')::bigint from jsonb_array_elements(v_lines) l));

  -- Solo yerbas publicadas, con precio (leído ya con los datos bloqueados).
  if exists (
    select 1
      from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
      left join public.product_variants v on v.id = r.variant_id and v.is_active and v.price > 0
      left join public.products p on p.id = v.product_id and p.is_active
      left join public.categories c on c.id = p.category_id and c.is_active and c.slug = 'yerbas'
     where c.id is null
  ) then
    raise exception 'Un producto del pedido ya no está disponible. Actualizá la página y revisá tu pedido.'
      using errcode = 'check_violation', hint = 'unavailable';
  end if;

  -- Comprueba lo disponible (cancela todo si no alcanza).
  perform private.check_availability(v_lines, null);

  -- Contacto del momento.
  select btrim(concat_ws(' ', nullif(btrim(p.first_name), ''), nullif(btrim(p.last_name), ''))),
         coalesce(nullif(p.email, ''), u.email)
    into v_name, v_email
    from auth.users u
    left join public.customer_profiles p on p.user_id = u.id
   where u.id = v_user;

  insert into public.orders (customer_id, customer_name, customer_email, customer_phone,
                             item_count, total, kind, status, expires_at, status_changed_at)
  values (v_user, left(coalesce(v_name, ''), 170), left(coalesce(v_email, ''), 254), v_phone,
          1, 0, 'yerbas', 'pendiente', now() + interval '24 hours', now())
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

  insert into public.order_events (order_id, event, to_status, detail)
  values (v_order, 'creado', 'pendiente', jsonb_build_object('items', v_lines));

  return private.order_summary(v_order);
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Cambiar el estado (administradores)
--    pendiente  → confirmado | cancelado
--    confirmado → preparando | cancelado
--    preparando → listo      | cancelado
--    listo      → entregado  | preparando | cancelado
--    entregado y cancelado: finales.
--    Pedir el mismo estado que ya tiene no hace nada.
-- ---------------------------------------------------------------------
create function public.admin_set_order_status(order_id bigint, status text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     bigint := admin_set_order_status.order_id;
  v_to     text := admin_set_order_status.status;
  v_order  public.orders;
  v_lines  jsonb;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden cambiar pedidos.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders o where o.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.kind <> 'yerbas' then
    raise exception 'Los pedidos de la tienda no tienen estados.'
      using errcode = 'check_violation', hint = 'not_yerbas';
  end if;

  if v_to = v_order.status then
    return private.order_summary(v_id);
  end if;

  if not ((v_order.status, v_to) in (
      ('pendiente', 'confirmado'), ('pendiente', 'cancelado'),
      ('confirmado', 'preparando'), ('confirmado', 'cancelado'),
      ('preparando', 'listo'), ('preparando', 'cancelado'),
      ('listo', 'entregado'), ('listo', 'preparando'), ('listo', 'cancelado'))) then
    raise exception 'No se puede pasar un pedido de «%» a «%».', v_order.status, coalesce(v_to, '—')
      using errcode = 'check_violation', hint = 'invalid_transition';
  end if;

  -- Confirmar un pendiente vencido: vuelve a comprometer stock, se controla de nuevo.
  if v_to = 'confirmado' and not private.order_commits_stock(v_order.status, v_order.expires_at) then
    select jsonb_agg(jsonb_build_object('variant_id', x.variant_id, 'quantity', x.qty, 'previous', 0))
      into v_lines
      from (select i.variant_id, sum(i.quantity)::integer as qty
              from public.order_items i
             where i.order_id = v_id and i.variant_id is not null
             group by i.variant_id) x;
    perform private.check_availability(v_lines, v_id);
  end if;

  -- Stock físico: salida al llegar a LISTO; entrada al salir de LISTO hacia atrás o cancelado.
  if v_to = 'listo' then
    perform private.reconcile_order_stock(v_id, true, format('Pedido de yerbas #%s listo', v_id));
  elsif v_order.stock_applied and v_to in ('preparando', 'cancelado') then
    perform private.reconcile_order_stock(v_id, false,
      case when v_to = 'cancelado' then format('Pedido de yerbas #%s cancelado', v_id)
           else format('Pedido de yerbas #%s vuelve a preparación', v_id) end);
  end if;

  update public.orders o
     set status = v_to,
         stock_applied = v_to in ('listo', 'entregado'),
         status_changed_at = now(),
         updated_at = now()
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status, detail)
  values (v_id, 'estado', v_order.status, v_to,
          case when v_order.status = 'pendiente' and v_order.expires_at <= now()
               then jsonb_build_object('vencido', true) else '{}'::jsonb end);

  return private.order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 9. Editar productos y cantidades (administradores)
--    Solo en pendiente, confirmado o preparando. items = la lista completa
--    nueva: [{ "variant_id": 12, "quantity": 2 }, ...]. Lo que no está se quita.
--    Las líneas que ya estaban conservan su precio y nombre del momento; las
--    nuevas toman el precio vigente. Si el pedido compromete stock, lo que
--    aumenta se controla contra lo disponible.
-- ---------------------------------------------------------------------
create function public.admin_update_order_items(order_id bigint, items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id      bigint := admin_update_order_items.order_id;
  v_order   public.orders;
  v_lines   jsonb;
  v_before  jsonb;
  v_check   jsonb;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden cambiar pedidos.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from public.orders o where o.id = v_id for update;
  if not found then
    raise exception 'No existe el pedido #%.', v_id using errcode = 'no_data_found', hint = 'not_found';
  end if;
  if v_order.kind <> 'yerbas' then
    raise exception 'Los pedidos de la tienda no se editan desde acá.'
      using errcode = 'check_violation', hint = 'not_yerbas';
  end if;
  if v_order.status not in ('pendiente', 'confirmado', 'preparando') then
    raise exception 'Un pedido «%» no se puede editar.%', v_order.status,
      case when v_order.status = 'listo' then ' Pasalo a «preparando» primero.' else '' end
      using errcode = 'check_violation', hint = 'not_editable';
  end if;

  v_lines := private.parse_order_items(admin_update_order_items.items, 30, 99);

  -- Bloquea antes de validar (mismo orden que al crear pedidos).
  perform private.lock_order_lines(
    array(select (l ->> 'variant_id')::bigint from jsonb_array_elements(v_lines) l));

  -- Presentaciones nuevas en el pedido: tienen que ser yerbas publicadas con precio.
  -- (Las que ya estaban se aceptan aunque hoy no estén publicadas.)
  if exists (
    select 1
      from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
      left join public.product_variants v on v.id = r.variant_id
      left join public.products p on p.id = v.product_id
      left join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
     where c.id is null
        or (not exists (select 1 from public.order_items i
                         where i.order_id = v_id and i.variant_id = r.variant_id)
            and not (v.is_active and v.price > 0 and p.is_active))
  ) then
    raise exception 'Hay un producto que no es una yerba publicada con precio.'
      using errcode = 'check_violation', hint = 'unavailable';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('variant_id', x.variant_id, 'quantity', x.qty)
                            order by x.variant_id), '[]'::jsonb)
    into v_before
    from (select i.variant_id, sum(i.quantity)::integer as qty
            from public.order_items i where i.order_id = v_id group by i.variant_id) x;

  if v_lines = v_before then
    return private.order_summary(v_id);
  end if;

  -- Si el pedido compromete stock: controlar lo que aumenta (bloqueando).
  if private.order_commits_stock(v_order.status, v_order.expires_at) then
    select jsonb_agg(jsonb_build_object(
             'variant_id', r.variant_id, 'quantity', r.quantity,
             'previous', coalesce((select sum(i.quantity) from public.order_items i
                                    where i.order_id = v_id and i.variant_id = r.variant_id), 0)))
      into v_check
      from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer);
    perform private.check_availability(v_check, v_id);
  end if;

  -- Quitar lo que ya no está (y líneas repetidas de una misma presentación: queda la primera).
  delete from public.order_items i
   where i.order_id = v_id
     and (i.variant_id is null
          or i.variant_id not in (select r.variant_id from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer))
          or i.id <> (select min(j.id) from public.order_items j
                       where j.order_id = v_id and j.variant_id = i.variant_id));

  -- Lo que ya estaba: nueva cantidad con su precio original.
  update public.order_items i
     set quantity = r.quantity, line_total = i.unit_price * r.quantity
    from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
   where i.order_id = v_id and i.variant_id = r.variant_id;

  -- Lo nuevo: precio y nombre vigentes.
  insert into public.order_items (order_id, product_id, variant_id, product_name, variant_name,
                                  unit_price, quantity, line_total)
  select v_id, p.id, v.id, p.name, nullif(v.name, 'Único'), v.price, r.quantity, v.price * r.quantity
    from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
    join public.product_variants v on v.id = r.variant_id
    join public.products p on p.id = v.product_id
   where not exists (select 1 from public.order_items i where i.order_id = v_id and i.variant_id = r.variant_id)
   order by r.variant_id;

  update public.orders o
     set total = s.total, item_count = s.n, updated_at = now()
    from (select sum(line_total) as total, sum(quantity)::integer as n
            from public.order_items where order_items.order_id = v_id) s
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status, detail)
  values (v_id, 'editado', v_order.status, v_order.status,
          jsonb_build_object('antes', v_before, 'despues', v_lines));

  return private.order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 10. La tienda muestra lo disponible (físico − comprometido)
--     Mismas columnas y en el mismo orden; «brand» se agrega al final.
-- ---------------------------------------------------------------------
create or replace view public.storefront_catalog
with (security_invoker = true)
as
select
  p.id          as product_id,
  p.slug        as product_slug,
  p.name        as product_name,
  p.description,
  c.slug        as category_slug,
  c.name        as category_name,
  cover.src     as cover_image,
  v.id          as variant_id,
  v.name        as variant_name,
  v.price,
  v.track_stock,
  case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0)::integer end as stock,
  vimg.src      as variant_image,
  p.sort_order  as product_sort,
  v.sort_order  as variant_sort,
  p.brand       as brand
from public.products p
join public.categories c        on c.id = p.category_id
join public.product_variants v  on v.product_id = p.id
left join public.variant_commitments() cm on cm.variant_id = v.id
left join lateral (
  select i.src from public.product_images i
  where i.product_id = p.id and i.is_cover
  limit 1
) cover on true
left join lateral (
  select i.src from public.product_images i
  where i.variant_id = v.id
  order by i.sort_order, i.id
  limit 1
) vimg on true
where p.is_active and v.is_active and c.is_active;

-- ---------------------------------------------------------------------
-- 11. Permisos de las funciones
-- ---------------------------------------------------------------------
revoke all on function private.order_commits_stock(text, timestamptz)        from public, anon, authenticated;
revoke all on function private.committed_qty(bigint, bigint)                 from public, anon, authenticated;
revoke all on function private.valid_phone(text)                             from public, anon, authenticated;
revoke all on function private.shortage_text(jsonb)                          from public, anon, authenticated;
revoke all on function private.check_availability(jsonb, bigint)             from public, anon, authenticated;
revoke all on function private.reconcile_order_stock(bigint, boolean, text)  from public, anon, authenticated;
revoke all on function private.order_summary(bigint)                         from public, anon, authenticated;
revoke all on function private.parse_order_items(jsonb, integer, integer)    from public, anon, authenticated;
revoke all on function private.lock_order_lines(bigint[])                    from public, anon, authenticated;

revoke all on function public.variant_commitments()                    from public, anon, authenticated;
revoke all on function public.create_yerba_order(jsonb, text)          from public, anon, authenticated;
revoke all on function public.admin_set_order_status(bigint, text)     from public, anon, authenticated;
revoke all on function public.admin_update_order_items(bigint, jsonb)  from public, anon, authenticated;

-- La vista de la tienda (security_invoker) la usa con el rol de quien consulta.
grant execute on function public.variant_commitments()                   to anon, authenticated;
grant execute on function public.create_yerba_order(jsonb, text)         to authenticated;
grant execute on function public.admin_set_order_status(bigint, text)    to authenticated;
grant execute on function public.admin_update_order_items(bigint, jsonb) to authenticated;

commit;
