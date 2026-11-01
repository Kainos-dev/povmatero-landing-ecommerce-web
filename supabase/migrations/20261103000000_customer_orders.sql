-- =====================================================================
-- Pedidos de clientes con cuenta («Mi cuenta › Mis pedidos»).
--
-- Qué es un pedido acá: la SOLICITUD que el cliente envía por WhatsApp desde el
-- carrito. No implica pago, confirmación ni entrega: eso se coordina por
-- WhatsApp, como hasta ahora. Por eso no hay estados, pagos ni envíos.
--
--   public.orders       un registro por solicitud (cliente, datos de contacto
--                       del momento, total, fecha)
--   public.order_items  productos, presentación, cantidad y precio del momento
--
-- Cómo se crea: SOLO con public.create_order(items), que llama el carrito justo
-- antes de abrir WhatsApp, con la sesión del cliente.
--   * Toma el cliente de la sesión (auth.uid()), nunca de lo que envía el navegador.
--   * Toma precios y nombres de la base (no del navegador): el total no se puede
--     falsear. Solo acepta productos y presentaciones publicados con precio.
--   * No descuenta stock ni reserva nada.
--   * Límite: 30 pedidos por hora por cuenta (evita abusos).
--
-- Quién ve qué (RLS):
--   * Cada cliente ve solo SUS pedidos y sus líneas. Cambiar un id en la URL o
--     en la consulta no devuelve pedidos de otra cuenta.
--   * Los administradores ven todos (para una futura sección del panel).
--   * Nadie puede editar ni borrar pedidos desde la API.
--
-- Si se elimina la cuenta de un cliente desde Supabase, sus pedidos se conservan
-- (customer_id queda en null, con el nombre y contacto guardados en el pedido).
-- Desde el panel, public.admin_delete_customer se niega a borrar clientes con
-- pedidos (ver 20261102000000).
--
-- No modifica ni borra datos existentes.
--
-- Se ejecuta UNA vez. Si ya existiera una tabla public.orders o public.order_items
-- (de otra prueba), falla al empezar y no cambia nada: así nunca se le aplican
-- permisos ni políticas a una tabla ajena. Verificar antes con
-- supabase/checks/20261103_antes_de_migrar.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------
create table public.orders (
  id              bigint generated always as identity primary key,
  customer_id     uuid references auth.users (id) on delete set null,
  -- Datos de contacto en el momento del pedido (el perfil puede cambiar después).
  customer_name   text not null default '' check (char_length(customer_name) <= 170),
  customer_email  text not null default '' check (char_length(customer_email) <= 254),
  customer_phone  text check (customer_phone is null or char_length(customer_phone) <= 30),
  channel         text not null default 'whatsapp' check (channel in ('whatsapp')),
  item_count      integer not null check (item_count > 0),
  total           numeric(12, 2) not null check (total >= 0),
  created_at      timestamptz not null default now()
);

create index orders_customer_idx on public.orders (customer_id, created_at desc);

create table public.order_items (
  id            bigint generated always as identity primary key,
  order_id      bigint not null references public.orders (id) on delete cascade,
  product_id    bigint references public.products (id) on delete set null,
  variant_id    bigint references public.product_variants (id) on delete set null,
  -- Nombre y precio del momento (si el producto cambia o se borra, el pedido no cambia).
  product_name  text not null,
  variant_name  text,
  unit_price    numeric(12, 2) not null check (unit_price >= 0),
  quantity      integer not null check (quantity between 1 and 999),
  line_total    numeric(12, 2) not null check (line_total >= 0)
);

create index order_items_order_idx on public.order_items (order_id);

comment on table public.orders is
  'Solicitudes de pedido enviadas por WhatsApp por clientes con cuenta. No implica pago ni confirmación.';

-- ---------------------------------------------------------------------
-- 2. Crear un pedido (la única forma de escribir en estas tablas)
--    items: [{ "product_id": 12, "variant": "Negro" | null, "quantity": 2 }, ...]
--    variant null = producto simple (su modelo único).
-- ---------------------------------------------------------------------
create or replace function public.create_order(items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user     uuid := (select auth.uid());
  v_order    bigint;
  v_item     jsonb;
  v_qty      integer;
  v_product  bigint;
  v_vname    text;
  v_row      record;
  v_total    numeric(12, 2) := 0;
  v_count    integer := 0;
  v_name     text;
  v_email    text;
  v_phone    text;
  v_lines    jsonb := '[]'::jsonb;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta para guardar el pedido.' using errcode = 'insufficient_privilege';
  end if;

  if jsonb_typeof(items) is distinct from 'array'
     or jsonb_array_length(items) = 0 or jsonb_array_length(items) > 50 then
    raise exception 'El pedido tiene que tener entre 1 y 50 productos.' using errcode = 'invalid_parameter_value';
  end if;

  if (select count(*) from public.orders
       where customer_id = v_user and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Hiciste muchos pedidos seguidos. Esperá un rato e intentá de nuevo.'
      using errcode = 'check_violation', hint = 'rate_limit';
  end if;

  -- Contacto del momento: perfil del cliente (o el email de la cuenta).
  select btrim(concat_ws(' ', nullif(btrim(p.first_name), ''), nullif(btrim(p.last_name), ''))),
         p.phone, coalesce(nullif(p.email, ''), u.email)
    into v_name, v_phone, v_email
    from auth.users u
    left join public.customer_profiles p on p.user_id = u.id
   where u.id = v_user;

  insert into public.orders (customer_id, customer_name, customer_email, customer_phone, item_count, total)
  values (v_user, left(coalesce(v_name, ''), 170), left(coalesce(v_email, ''), 254), left(v_phone, 30), 1, 0)
  returning id into v_order;

  for v_item in select * from jsonb_array_elements(items) loop
    begin
      v_product := (v_item ->> 'product_id')::bigint;
      v_qty := (v_item ->> 'quantity')::integer;
    exception when others then
      raise exception 'Hay un producto con datos no válidos.' using errcode = 'invalid_parameter_value';
    end;
    v_vname := nullif(btrim(v_item ->> 'variant'), '');
    if v_product is null or v_qty is null or v_qty < 1 or v_qty > 999 then
      raise exception 'Hay un producto con una cantidad no válida.' using errcode = 'invalid_parameter_value';
    end if;

    -- Solo lo que la tienda muestra: producto, categoría y presentación publicados, con precio.
    select p.id as product_id, p.name as product_name, v.id as variant_id, v.name as variant_name, v.price
      into v_row
      from public.products p
      join public.categories c on c.id = p.category_id and c.is_active
      join public.product_variants v on v.product_id = p.id and v.is_active and v.price > 0
     where p.id = v_product
       and p.is_active
       and (
         (v_vname is not null and v.name = v_vname)
         or (v_vname is null and (v.name = 'Único'
             or (select count(*) from public.product_variants x where x.product_id = p.id and x.is_active) = 1))
       )
     order by (v.name = 'Único') desc
     limit 1;

    if not found then
      raise exception 'Un producto del carrito ya no está disponible. Actualizá la página y revisá tu pedido.'
        using errcode = 'check_violation', hint = 'unavailable';
    end if;

    insert into public.order_items (order_id, product_id, variant_id, product_name, variant_name, unit_price, quantity, line_total)
    values (v_order, v_row.product_id, v_row.variant_id, v_row.product_name,
            case when v_row.variant_name = 'Único' then null else v_row.variant_name end,
            v_row.price, v_qty, v_row.price * v_qty);

    v_total := v_total + v_row.price * v_qty;
    v_count := v_count + v_qty;
    v_lines := v_lines || jsonb_build_object(
      'product_name', v_row.product_name,
      'variant_name', case when v_row.variant_name = 'Único' then null else v_row.variant_name end,
      'unit_price', v_row.price, 'quantity', v_qty, 'line_total', v_row.price * v_qty);
  end loop;

  update public.orders set total = v_total, item_count = v_count where id = v_order;

  return jsonb_build_object('id', v_order, 'total', v_total, 'item_count', v_count, 'items', v_lines);
end;
$$;

revoke all on function public.create_order(jsonb) from public, anon, authenticated;
grant execute on function public.create_order(jsonb) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Permisos y RLS: solo lectura, cada uno lo suyo
-- ---------------------------------------------------------------------
revoke all on public.orders, public.order_items from public, anon, authenticated;
grant select on public.orders, public.order_items to authenticated;

alter table public.orders      enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "orders: cada cliente ve los suyos" on public.orders;
create policy "orders: cada cliente ve los suyos"
  on public.orders for select to authenticated
  using (customer_id = (select auth.uid()));

drop policy if exists "orders: admins leen todos" on public.orders;
create policy "orders: admins leen todos"
  on public.orders for select to authenticated
  using ((select private.is_admin()));

drop policy if exists "order_items: cada cliente ve los de sus pedidos" on public.order_items;
create policy "order_items: cada cliente ve los de sus pedidos"
  on public.order_items for select to authenticated
  using (exists (select 1 from public.orders o
                  where o.id = order_items.order_id
                    and o.customer_id = (select auth.uid())));

drop policy if exists "order_items: admins leen todos" on public.order_items;
create policy "order_items: admins leen todos"
  on public.order_items for select to authenticated
  using ((select private.is_admin()));

commit;
