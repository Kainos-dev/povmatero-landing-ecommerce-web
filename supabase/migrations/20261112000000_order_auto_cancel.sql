-- =====================================================================
-- Pedidos de yerbas: sin «Vencido». Un pedido que sigue en «Pendiente» 72 h
-- después de crearse pasa a «Cancelado», con el motivo
-- «Cancelado por falta de respuesta».
--
-- Qué cambia:
--   * La reserva de un pedido pendiente dura 72 h desde que se crea (antes 24 h):
--     orders.expires_at = created_at + 72 h (lo fija un trigger al crear el
--     pedido, sin importar qué función lo inserte).
--   * orders.cancel_reason / cancelled_at / auto_cancelled: motivo, hora y si
--     lo canceló el sistema. El cliente ve el motivo en «Mis pedidos».
--   * public.cancel_unanswered_yerba_orders(): cancela los pendientes con más
--     de 72 h. Idempotente: toma cada pedido bloqueado (SKIP LOCKED), solo si
--     sigue «pendiente» y sin stock descontado, y registra el evento una vez.
--   * public.run_order_maintenance(): cancelación + entrega automática (la
--     llama la tarea programada de Vercel, /api/cron-pedidos, con la clave
--     secreta; también la pueden ejecutar los administradores o pg_cron).
--   * admin_set_order_status y admin_update_order_items: un pendiente con más
--     de 72 h ya no se puede marcar listo ni editar: se cancela en ese momento
--     (mismo motivo) y la respuesta trae "auto_cancelled": true.
--
-- Stock: un pedido pendiente NUNCA tiene stock descontado (la salida se
-- registra recién en «Listo»): solo lo reserva mientras expires_at > now().
-- Por eso cancelarlo no mueve stock ni puede devolverlo dos veces; la reserva
-- se libera exactamente a las 72 h aunque la tarea programada corra después.
--
-- Pedidos que ya existen:
--   * Pendientes vencidos (su reserva de 24 h ya pasó): pasan a «Cancelado»
--     con el mismo motivo y un evento en el historial ({"migracion": true}).
--     No se reactivan: su stock ya quedó libre y pudo pedirlo otro cliente.
--   * Pendientes vigentes: su reserva se extiende a 72 h desde la creación
--     (ya reservaban ese stock, así que no se vende de más).
--   * Listos, entregados y cancelados: sin cambios. El historial se conserva.
--
-- Requiere 20261110000000_simple_order_states.sql. Se ejecuta UNA vez.
-- Compatible con el panel publicado antes de este cambio.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Columnas
-- ---------------------------------------------------------------------
alter table public.orders
  add column cancel_reason  text check (cancel_reason is null or char_length(cancel_reason) <= 200),
  add column cancelled_at   timestamptz,
  add column auto_cancelled boolean not null default false;

comment on column public.orders.cancel_reason is 'Motivo de la cancelación (ej. «Cancelado por falta de respuesta»). Lo ve el cliente.';
comment on column public.orders.cancelled_at is 'Cuándo se canceló.';
comment on column public.orders.auto_cancelled is 'true = lo canceló el sistema (72 h en «Pendiente»).';

create index orders_pending_due_idx on public.orders (expires_at)
  where kind = 'yerbas' and status = 'pendiente';

-- ---------------------------------------------------------------------
-- 2. Reserva de 72 h desde la creación
-- ---------------------------------------------------------------------
create function private.set_yerba_order_expiry()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'yerbas' and new.status = 'pendiente' then
    new.expires_at := coalesce(new.created_at, now()) + interval '72 hours';
  end if;
  return new;
end;
$$;

create trigger orders_yerba_expiry
  before insert on public.orders
  for each row execute function private.set_yerba_order_expiry();

-- ---------------------------------------------------------------------
-- 3. Cancelar por falta de respuesta (un solo lugar)
--    Solo pedidos de yerbas en «pendiente», sin stock descontado y con la
--    reserva ya vencida. Devuelve los números que cambió.
-- ---------------------------------------------------------------------
create function private.auto_cancel_orders(p_ids bigint[], p_detail jsonb default '{}'::jsonb)
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
    returning o.id, o.expires_at
  ), ev as (
    insert into public.order_events (order_id, event, from_status, to_status, detail, created_by)
    select d.id, 'estado', 'pendiente', 'cancelado',
           jsonb_build_object('automatico', true, 'motivo', 'Cancelado por falta de respuesta',
                              'horas', 72, 'reserva_hasta', d.expires_at) || coalesce(p_detail, '{}'::jsonb),
           null
      from done d
    returning order_id
  )
  select coalesce(array_agg(order_id order by order_id), '{}') into v_done from ev;
  return v_done;
end;
$$;

-- Tarea: cancela todos los pendientes con más de 72 h.
create function public.cancel_unanswered_yerba_orders()
returns setof bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  -- Desde la API: solo administradores (la tarea programada usa la clave
  -- secreta = service_role; pg_cron corre sin JWT).
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') and not private.is_admin() then
    raise exception 'Solo los administradores pueden ejecutar la cancelación automática.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(array_agg(id), '{}') into v_ids
    from (select o.id
            from public.orders o
           where o.kind = 'yerbas' and o.status = 'pendiente' and o.expires_at <= now()
           order by o.id
             for update skip locked) due;

  return query select unnest(private.auto_cancel_orders(v_ids));
end;
$$;

-- Mantenimiento de pedidos: cancelación (72 h en «Pendiente») y entrega
-- automática (24 h en «Listo»). Devuelve { cancelados: [..], entregados: [..] }.
create function public.run_order_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled bigint[];
  v_delivered bigint[];
begin
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') and not private.is_admin() then
    raise exception 'Solo los administradores pueden ejecutar el mantenimiento de pedidos.'
      using errcode = 'insufficient_privilege';
  end if;
  select coalesce(array_agg(x), '{}') into v_cancelled from public.cancel_unanswered_yerba_orders() x;
  select coalesce(array_agg(x), '{}') into v_delivered from public.deliver_due_yerba_orders() x;
  return jsonb_build_object('cancelados', to_jsonb(v_cancelled), 'entregados', to_jsonb(v_delivered), 'hora', now());
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Resumen de un pedido: suma el motivo de cancelación
-- ---------------------------------------------------------------------
create or replace function private.order_summary(p_order bigint)
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
-- 5. Cambiar el estado (administradores)
--    Igual que en 20261110, salvo: un pendiente con más de 72 h se cancela
--    por falta de respuesta (no se puede revivir). Cancelar a mano guarda
--    cancelled_at (sin motivo automático).
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

  -- 72 h en «Pendiente»: queda cancelado por falta de respuesta.
  if v_order.status = 'pendiente' and v_order.expires_at <= now() then
    perform private.auto_cancel_orders(array[v_id]);
    return private.order_summary(v_id);
  end if;

  if v_to = v_order.status then
    return private.order_summary(v_id);
  end if;

  -- Ya lo canceló la tarea (por ejemplo, mientras alguien lo miraba en el panel).
  if v_order.status = 'cancelado' and v_order.auto_cancelled then
    raise exception 'El pedido #% se canceló por falta de respuesta (72 h en «Pendiente»).', v_id
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

  -- Confirmado/preparando no vencen (ya los atendió alguien). Si por algún
  -- motivo no comprometen stock, al pasar a listo se vuelve a controlar.
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

  -- Stock físico: salida al llegar a LISTO; entrada al volver de LISTO a
  -- preparación o al cancelar. Entregado ↔ listo: nada.
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
-- 6. Editar productos (administradores)
--    Igual que en 20261105, salvo: un pendiente con más de 72 h se cancela
--    por falta de respuesta en vez de editarse.
-- ---------------------------------------------------------------------
create or replace function public.admin_update_order_items(order_id bigint, items jsonb)
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

  if v_order.status = 'pendiente' and v_order.expires_at <= now() then
    perform private.auto_cancel_orders(array[v_id]);
    return private.order_summary(v_id);
  end if;

  if v_order.status not in ('pendiente', 'confirmado', 'preparando') then
    raise exception 'Un pedido «%» no se puede editar.%', v_order.status,
      case when v_order.status = 'listo' then ' Pasalo a «preparando» primero.' else '' end
      using errcode = 'check_violation', hint = 'not_editable';
  end if;

  v_lines := private.parse_order_items(admin_update_order_items.items, 30, 99);

  perform private.lock_order_lines(
    array(select (l ->> 'variant_id')::bigint from jsonb_array_elements(v_lines) l));

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

  if private.order_commits_stock(v_order.status, v_order.expires_at) then
    select jsonb_agg(jsonb_build_object(
             'variant_id', r.variant_id, 'quantity', r.quantity,
             'previous', coalesce((select sum(i.quantity) from public.order_items i
                                    where i.order_id = v_id and i.variant_id = r.variant_id), 0)))
      into v_check
      from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer);
    perform private.check_availability(v_check, v_id);
  end if;

  delete from public.order_items i
   where i.order_id = v_id
     and (i.variant_id is null
          or i.variant_id not in (select r.variant_id from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer))
          or i.id <> (select min(j.id) from public.order_items j
                       where j.order_id = v_id and j.variant_id = i.variant_id));

  update public.order_items i
     set quantity = r.quantity, line_total = i.unit_price * r.quantity
    from jsonb_to_recordset(v_lines) as r (variant_id bigint, quantity integer)
   where i.order_id = v_id and i.variant_id = r.variant_id;

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
-- 7. Pedidos que ya existen
-- ---------------------------------------------------------------------
-- Pendientes vigentes: la reserva dura 72 h desde la creación.
update public.orders o
   set expires_at = greatest(o.expires_at, o.created_at + interval '72 hours')
 where o.kind = 'yerbas' and o.status = 'pendiente' and o.expires_at > now();

-- Pendientes vencidos («Vencido» en el panel anterior): cancelados por falta de respuesta.
select private.auto_cancel_orders(
  array(select o.id from public.orders o
         where o.kind = 'yerbas' and o.status = 'pendiente' and o.expires_at <= now()),
  jsonb_build_object('migracion', true));

-- ---------------------------------------------------------------------
-- 8. Permisos
--    service_role: la tarea programada (Vercel) llama con la clave secreta.
--    Este proyecto no da permisos a service_role solo: van explícitos.
-- ---------------------------------------------------------------------
revoke all on function private.set_yerba_order_expiry()               from public, anon, authenticated;
revoke all on function private.auto_cancel_orders(bigint[], jsonb)    from public, anon, authenticated;
revoke all on function public.cancel_unanswered_yerba_orders()        from public, anon, authenticated;
revoke all on function public.run_order_maintenance()                 from public, anon, authenticated;
grant execute on function public.cancel_unanswered_yerba_orders() to authenticated, service_role;
grant execute on function public.run_order_maintenance()          to authenticated, service_role;
grant execute on function public.deliver_due_yerba_orders()       to service_role;

commit;
