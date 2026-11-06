-- =====================================================================
-- Pedidos: reserva de 12 horas, código público por cliente y pedidos de
-- yerbas sin duplicados.
--
-- 1. Reserva de 12 h (antes 72 h)
--    * Los pedidos de yerbas NUEVOS reservan su stock 12 h desde que se
--      crean (orders.expires_at = created_at + 12 h, hora de la base).
--    * La reserva no genera movimientos de inventario: lo reservado se
--      calcula desde los pedidos (variant_commitments / committed_qty), así
--      que se descuenta de lo disponible en el momento en que el pedido se
--      confirma y se libera exactamente a las 12 h, aunque la tarea programada
--      corra después. No hay nada que «devolver», y por eso no puede
--      devolverse dos veces.
--    * La salida física de stock sigue registrándose al pasar a «Listo»
--      (reconcile_order_stock, que nunca duplica movimientos). «Entregado» no
--      mueve stock.
--    * PEDIDOS PENDIENTES QUE YA EXISTEN: conservan su vencimiento actual
--      (72 h). Esta migración no los toca. Si se quiere acortarlos, ver la
--      consulta opcional al final (no se ejecuta sola).
--
-- 2. Código público de cada pedido (ej. «AA-003»)
--    * orders.public_code = inicial del nombre + inicial del apellido + número
--      de pedido de ESE cliente (001, 002, …). orders.customer_seq = el número.
--    * El id interno sigue siendo la clave primaria; nada cambia en las
--      relaciones (order_items, order_events, inventory_movements).
--    * Se asigna una sola vez, al crear el pedido (o al vincular una venta
--      «Sin asignar» a una cuenta). No cambia si el cliente cambia su nombre:
--      un trigger impide modificarlo.
--    * Sin colisiones por concurrencia: el número sale de un contador por
--      cliente (private.order_counters) que se incrementa con una sola
--      sentencia atómica; dos pedidos simultáneos del mismo cliente esperan uno
--      al otro y obtienen números distintos. Además hay un índice único
--      (customer_id, customer_seq). Si un pedido falla, el número no se
--      consume (el contador vuelve atrás con la transacción).
--    * Clientes distintos con las mismas iniciales pueden tener el mismo
--      código (dos «AA-003»): el código identifica el pedido DENTRO de la
--      cuenta del cliente. En el panel siempre se muestra junto al nombre.
--    * Sin nombre o apellido: «X» en su lugar (ej. «AX-001»). Letras con
--      acento o ñ: sin acento (Á → A, Ñ → N).
--    * Pedidos históricos: se numeran por cliente según su fecha de creación,
--      con el nombre actual del perfil.
--    * No es una medida de seguridad: la RLS de siempre decide quién ve cada
--      pedido (cada cliente solo los suyos). No hay ninguna función que busque
--      pedidos por código.
--
-- 3. Pedidos de yerbas sin duplicados (reintentos)
--    * create_yerba_order(items, contact_phone, client_key): client_key es un
--      identificador que genera el navegador para cada intento de compra. Si
--      la respuesta se pierde y se vuelve a enviar con la misma clave, la base
--      devuelve el pedido ya creado ("repeated": true) en vez de crear otro.
--      La misma clave de otra cuenta se rechaza. Sin clave, igual que antes.
--
-- Compatibilidad con lo publicado: la tienda actual llama
-- create_yerba_order(items, contact_phone) y sigue funcionando (client_key es
-- opcional). Las columnas nuevas no cambian ninguna consulta existente.
--
-- Requiere 20261112000000_order_auto_cancel.sql. Se ejecuta UNA vez (si la
-- columna public_code ya existe, falla al empezar y no cambia nada).
-- Controles: supabase/checks/20261114_antes_codigos_12h.sql y
-- supabase/checks/20261114_despues_codigos_12h.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Reserva de 12 h
-- ---------------------------------------------------------------------
create function private.yerba_reservation_hours()
returns integer
language sql
immutable
set search_path = ''
as $$ select 12 $$;

create or replace function private.set_yerba_order_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'yerbas' and new.status = 'pendiente' then
    new.expires_at := coalesce(new.created_at, now()) + make_interval(hours => private.yerba_reservation_hours());
  end if;
  return new;
end;
$$;

-- Cancelación por falta de respuesta: igual que antes; el historial guarda
-- las horas reales de la reserva de cada pedido (72 los viejos, 12 los nuevos).
create or replace function private.auto_cancel_orders(p_ids bigint[], p_detail jsonb default '{}'::jsonb)
returns bigint[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_done bigint[];
begin
  with done as (
    update public.orders o
       set status = 'cancelado',
           cancel_reason = 'Cancelado por falta de respuesta',
           cancelled_at = now(),
           auto_cancelled = true,
           status_changed_at = now(),
           updated_at = now()
     where o.id = any (p_ids)
       and o.kind = 'yerbas'
       and o.status = 'pendiente'
       and not o.stock_applied
       and o.expires_at <= now()
    returning o.id, o.expires_at, o.created_at
  ), ev as (
    insert into public.order_events (order_id, event, from_status, to_status, detail, created_by)
    select d.id, 'estado', 'pendiente', 'cancelado',
           jsonb_build_object('automatico', true, 'motivo', 'Cancelado por falta de respuesta',
                              'horas', round(extract(epoch from d.expires_at - d.created_at) / 3600),
                              'reserva_hasta', d.expires_at) || coalesce(p_detail, '{}'::jsonb),
           null
      from done d
    returning order_id
  )
  select coalesce(array_agg(order_id order by order_id), '{}') into v_done from ev;
  return v_done;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Código público
-- ---------------------------------------------------------------------
alter table public.orders
  add column public_code  text,
  add column customer_seq integer;

comment on column public.orders.public_code is
  'Código que ve el cliente (iniciales + número de pedido de ese cliente, ej. AA-003). Se fija al crear el pedido y no cambia.';
comment on column public.orders.customer_seq is
  'Número de pedido dentro de la cuenta del cliente (1, 2, 3…).';

create table private.order_counters (
  customer_id uuid primary key references auth.users (id) on delete cascade,
  last_seq    integer not null check (last_seq >= 0)
);
alter table private.order_counters enable row level security;
revoke all on private.order_counters from public, anon, authenticated;

-- Primera letra (A-Z) de un texto, sin acentos; «X» si no hay ninguna.
-- Traducción explícita de ambos casos: no depende de lower/upper ni del locale.
-- La búsqueda ASCII usa C incluso si el argumento tiene otra collation.
create function private.name_initial(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    substring(translate(coalesce(p, ''),
                        'abcdefghijklmnopqrstuvwxyzáàäâãåéèëêíìïîóòöôõúùüûñçýÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇÝ',
                        'ABCDEFGHIJKLMNOPQRSTUVWXYZAAAAAAEEEEIIIIOOOOOUUUUNCYAAAAAAEEEEIIIIOOOOOUUUUNCY')
              collate pg_catalog."C" from '[A-Z]'),
    'X')
$$;

create function private.order_code(p_first text, p_last text, p_seq integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select private.name_initial(p_first) || private.name_initial(p_last) || '-'
         || case when p_seq < 1000 then lpad(p_seq::text, 3, '0') else p_seq::text end
$$;

-- Pedidos que ya existen: número por cliente según la fecha, con el nombre actual.
-- Si el perfil no tiene nombre, se usa el nombre guardado en el pedido.
with numbered as (
  select o.id,
         row_number() over (partition by o.customer_id order by o.created_at, o.id)::integer as seq,
         coalesce(nullif(btrim(p.first_name), ''), split_part(btrim(o.customer_name), ' ', 1)) as first_name,
         case when nullif(btrim(p.first_name), '') is not null or nullif(btrim(p.last_name), '') is not null
              then p.last_name
              else nullif(regexp_replace(btrim(o.customer_name), '^\S+\s*', ''), '') end as last_name
    from public.orders o
    left join public.customer_profiles p on p.user_id = o.customer_id
   where o.customer_id is not null
)
update public.orders o
   set customer_seq = n.seq,
       public_code = private.order_code(n.first_name, n.last_name, n.seq)
  from numbered n
 where o.id = n.id;

insert into private.order_counters (customer_id, last_seq)
select o.customer_id, max(o.customer_seq)
  from public.orders o
 where o.customer_id is not null
 group by o.customer_id;

create unique index orders_customer_seq_key
  on public.orders (customer_id, customer_seq) where customer_id is not null;
create index orders_public_code_idx on public.orders (public_code) where public_code is not null;

alter table public.orders
  add constraint orders_public_code_format check (public_code is null or public_code ~ '^[A-Z]{2}-[0-9]{3,}$'),
  -- Todo pedido con cliente tiene código. (Si se borra la cuenta, el pedido
  -- conserva su código aunque customer_id quede vacío.)
  add constraint orders_public_code_required check (customer_id is null or (public_code is not null and customer_seq is not null));

-- Asigna el código al crear (o al vincular a una cuenta) y no deja cambiarlo.
create function private.assign_order_code()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seq   integer;
  v_first text;
  v_last  text;
begin
  if tg_op = 'UPDATE' and old.public_code is not null then
    if new.public_code is distinct from old.public_code or new.customer_seq is distinct from old.customer_seq then
      raise exception 'El código de un pedido no se puede cambiar.'
        using errcode = 'check_violation', hint = 'code_immutable';
    end if;
    return new;
  end if;

  if new.customer_id is null then
    new.public_code := null;
    new.customer_seq := null;
    return new;
  end if;

  -- Una sola sentencia: bloquea la fila del cliente hasta el final de la
  -- transacción (otro pedido simultáneo del mismo cliente espera y toma el siguiente).
  insert into private.order_counters as c (customer_id, last_seq)
  values (new.customer_id, 1)
  on conflict (customer_id) do update set last_seq = c.last_seq + 1
  returning c.last_seq into v_seq;

  select p.first_name, p.last_name into v_first, v_last
    from public.customer_profiles p where p.user_id = new.customer_id;
  if nullif(btrim(coalesce(v_first, '')), '') is null and nullif(btrim(coalesce(v_last, '')), '') is null then
    v_first := split_part(btrim(coalesce(new.customer_name, '')), ' ', 1);
    v_last := nullif(regexp_replace(btrim(coalesce(new.customer_name, '')), '^\S+\s*', ''), '');
  end if;

  new.customer_seq := v_seq;
  new.public_code := private.order_code(v_first, v_last, v_seq);
  return new;
end;
$$;

create trigger orders_public_code
  before insert or update of customer_id, public_code, customer_seq on public.orders
  for each row execute function private.assign_order_code();

-- Resumen de un pedido: suma el código.
create or replace function private.order_summary(p_order bigint)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', o.id,
    'public_code', o.public_code,
    'kind', o.kind,
    'status', o.status,
    'created_at', o.created_at,
    'expires_at', o.expires_at,
    'expired', (o.status = 'pendiente' and o.expires_at <= now()),
    'stock_applied', o.stock_applied,
    'cancel_reason', o.cancel_reason,
    'auto_cancelled', o.auto_cancelled,
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

-- ---------------------------------------------------------------------
-- 3. Crear un pedido de yerbas, con clave de intento (client_key)
--    Igual que en 20261105, salvo la clave. Se reemplaza la función (no se
--    agrega otra con el mismo nombre: dos versiones confundirían a la API).
-- ---------------------------------------------------------------------
drop function public.create_yerba_order(jsonb, text);

create function public.create_yerba_order(items jsonb, contact_phone text default null, client_key uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user          uuid := (select auth.uid());
  v_key           uuid := create_yerba_order.client_key;
  v_lines         jsonb;
  v_phone         text;
  v_given_phone   text := private.clean_text(contact_phone, 30);
  v_profile_phone text;
  v_has_profile   boolean := false;
  v_name          text;
  v_email         text;
  v_order         bigint;
  v_prev          public.orders;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta para hacer el pedido.'
      using errcode = 'insufficient_privilege', hint = 'login_required';
  end if;

  v_lines := private.parse_order_items(items, 30, 20);

  -- Un pedido por vez por cliente (y la clave se revisa ya ordenada).
  perform pg_advisory_xact_lock(hashtextextended('povmatero:create_yerba_order:' || v_user::text, 0));

  -- Mismo intento (respuesta perdida, doble toque): se devuelve el pedido ya creado.
  if v_key is not null then
    select * into v_prev from public.orders o where o.client_key = v_key;
    if found then
      if v_prev.customer_id is distinct from v_user or v_prev.kind <> 'yerbas' then
        raise exception 'No pudimos registrar el pedido. Actualizá la página e intentá de nuevo.'
          using errcode = 'check_violation', hint = 'invalid_key';
      end if;
      return private.order_summary(v_prev.id) || jsonb_build_object('repeated', true);
    end if;
  end if;

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

  -- Bloquea categoría, productos y presentaciones ANTES de validar.
  perform private.lock_order_lines(
    array(select (l ->> 'variant_id')::bigint from jsonb_array_elements(v_lines) l));

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

  -- Lo disponible, con las presentaciones bloqueadas: dos pedidos por la
  -- última unidad se ordenan y el segundo recibe 'insufficient_stock'.
  perform private.check_availability(v_lines, null);

  select btrim(concat_ws(' ', nullif(btrim(p.first_name), ''), nullif(btrim(p.last_name), ''))),
         coalesce(nullif(p.email, ''), u.email)
    into v_name, v_email
    from auth.users u
    left join public.customer_profiles p on p.user_id = u.id
   where u.id = v_user;

  -- expires_at lo fija el trigger orders_yerba_expiry (12 h); public_code, orders_public_code.
  insert into public.orders (customer_id, customer_name, customer_email, customer_phone,
                             item_count, total, kind, status, expires_at, status_changed_at, client_key)
  values (v_user, left(coalesce(v_name, ''), 170), left(coalesce(v_email, ''), 254), v_phone,
          1, 0, 'yerbas', 'pendiente', now() + make_interval(hours => private.yerba_reservation_hours()), now(), v_key)
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
-- 4. Cambiar el estado: igual que en 20261112; solo cambia el texto del
--    rechazo (ya no dice «72 h»: depende de la reserva de cada pedido).
-- ---------------------------------------------------------------------
create or replace function public.admin_set_order_status(order_id bigint, status text)
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

  -- Reserva vencida en «Pendiente»: queda cancelado por falta de respuesta.
  if v_order.status = 'pendiente' and v_order.expires_at <= now() then
    perform private.auto_cancel_orders(array[v_id]);
    return private.order_summary(v_id);
  end if;

  if v_to = v_order.status then
    return private.order_summary(v_id);
  end if;

  if v_order.status = 'cancelado' and v_order.auto_cancelled then
    raise exception 'El pedido % se canceló por falta de respuesta (venció su reserva en «Pendiente»).',
      coalesce(v_order.public_code, '#' || v_id)
      using errcode = 'check_violation', hint = 'auto_cancelled';
  end if;

  if not ((v_order.status, v_to) in (
      ('pendiente', 'confirmado'), ('pendiente', 'cancelado'), ('pendiente', 'listo'),
      ('confirmado', 'preparando'), ('confirmado', 'cancelado'), ('confirmado', 'listo'),
      ('preparando', 'listo'), ('preparando', 'cancelado'),
      ('listo', 'entregado'), ('listo', 'preparando'), ('listo', 'cancelado'),
      ('entregado', 'listo'))) then
    raise exception 'No se puede pasar un pedido de «%» a «%».', v_order.status, coalesce(v_to, '—')
      using errcode = 'check_violation', hint = 'invalid_transition';
  end if;

  if v_to in ('confirmado', 'listo') and v_order.status in ('pendiente', 'confirmado', 'preparando')
     and not private.order_commits_stock(v_order.status, v_order.expires_at) then
    select jsonb_agg(jsonb_build_object('variant_id', x.variant_id, 'quantity', x.qty, 'previous', 0))
      into v_lines
      from (select i.variant_id, sum(i.quantity)::integer as qty
              from public.order_items i
             where i.order_id = v_id and i.variant_id is not null
             group by i.variant_id) x;
    perform private.check_availability(v_lines, v_id);
  end if;

  if v_to = 'listo' and not v_order.stock_applied then
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
         updated_at = now(),
         ready_at = case when v_to = 'listo' then now()
                         when v_to in ('preparando', 'cancelado') then null
                         else o.ready_at end,
         delivered_at = case when v_to = 'entregado' then now() else null end,
         auto_delivered = false,
         auto_deliver = case when v_order.status = 'entregado' and v_to = 'listo' then false
                             when v_to = 'listo' then true
                             else o.auto_deliver end,
         cancelled_at = case when v_to = 'cancelado' then now() else o.cancelled_at end
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status, detail)
  values (v_id, 'estado', v_order.status, v_to, '{}'::jsonb);

  return private.order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permisos
-- ---------------------------------------------------------------------
revoke all on function private.yerba_reservation_hours()                   from public, anon, authenticated;
revoke all on function private.name_initial(text)                          from public, anon, authenticated;
revoke all on function private.order_code(text, text, integer)             from public, anon, authenticated;
revoke all on function private.assign_order_code()                         from public, anon, authenticated;
revoke all on function public.create_yerba_order(jsonb, text, uuid)        from public, anon, authenticated;
grant execute on function public.create_yerba_order(jsonb, text, uuid)     to authenticated;

commit;

-- ---------------------------------------------------------------------
-- OPCIONAL (no se ejecuta sola; solo si lo decidimos): acortar a 12 h la
-- reserva de los pendientes que ya existían al aplicar la migración.
-- Los que ya superaron las 12 h quedarían vencidos en ese momento (su stock se
-- libera y la próxima tarea los cancela por falta de respuesta).
--
-- update public.orders o
--    set expires_at = o.created_at + interval '12 hours', updated_at = now()
--  where o.kind = 'yerbas' and o.status = 'pendiente'
--    and o.expires_at > o.created_at + interval '12 hours';
-- ---------------------------------------------------------------------
