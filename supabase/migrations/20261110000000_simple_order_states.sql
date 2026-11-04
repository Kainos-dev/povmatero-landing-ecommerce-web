-- =====================================================================
-- Pedidos de yerbas: tres estados para el panel (Pendiente, Listo,
-- Entregado) y entrega automática 24 h después de «Listo».
--
-- Qué cambia:
--   * Pasos directos (además de los de siempre, que siguen funcionando para
--     el panel publicado y para los pedidos que ya están en esos estados):
--       pendiente / confirmado / preparando → listo
--       entregado → listo            (el cliente todavía no lo retiró)
--     «Pendiente» en el panel agrupa pendiente, confirmado y preparando: los
--     tres comprometen stock igual (salvo el pendiente vencido).
--   * orders.ready_at: cuándo pasó a «Listo» (hora de la base).
--     orders.delivered_at: cuándo pasó a «Entregado».
--     orders.auto_delivered: true si lo marcó la entrega automática.
--     orders.auto_deliver: false si alguien lo volvió de «Entregado» a «Listo»
--       a mano: ese pedido ya no se entrega solo (se marca a mano cuando lo
--       retiran). Así no vuelve a pasar a «Entregado» al otro día.
--   * public.deliver_due_yerba_orders(): pasa a «Entregado» los pedidos en
--     «Listo» hace 24 h o más (con auto_deliver). Idempotente: toma cada
--     pedido bloqueado (SKIP LOCKED), solo si sigue en «Listo», y registra el
--     evento con detail {"automatico": true}.
--
-- Stock: exactamente las mismas reglas.
--   * La salida se registra al llegar a «Listo» (reconcile_order_stock, que
--     nunca duplica movimientos). Ir directo de pendiente a listo descuenta
--     lo mismo que el camino largo; si el pendiente estaba vencido, primero
--     se vuelve a controlar lo disponible (como al confirmarlo).
--   * Listo ↔ Entregado no mueve stock (en los dos ya está descontado).
--   * Volver a «preparando» (= «Pendiente» en el panel) o cancelar desde
--     «Listo» devuelve el stock, como hasta ahora.
--   * Reserva de 24 h de los pendientes y cancelación: sin cambios.
--
-- Entrega automática: la función NO se ejecuta sola. Dos formas de usarla:
--   1. El panel la llama al abrir «Pedidos» (ya incluido en el panel nuevo).
--   2. Programarla en Supabase con pg_cron (recomendado, requiere tu
--      autorización): ver supabase/checks/20261110_programar_entrega_automatica.sql.
--
-- Pedidos «Listo» que ya existen: ready_at = cuándo cambiaron de estado
-- (status_changed_at). Si hace más de 24 h, la primera ejecución los pasa a
-- «Entregado».
--
-- Requiere 20261105000000_yerba_orders.sql. Se ejecuta UNA vez.
-- =====================================================================

begin;

alter table public.orders
  add column ready_at       timestamptz,
  add column delivered_at   timestamptz,
  add column auto_delivered boolean not null default false,
  add column auto_deliver   boolean not null default true;

update public.orders set ready_at = coalesce(status_changed_at, updated_at)
 where kind = 'yerbas' and status = 'listo';
update public.orders set delivered_at = coalesce(status_changed_at, updated_at)
 where kind = 'yerbas' and status = 'entregado';

create index orders_ready_due_idx on public.orders (ready_at)
  where kind = 'yerbas' and status = 'listo';

comment on column public.orders.ready_at is 'Yerbas: cuándo pasó a «Listo» (la entrega automática cuenta 24 h desde acá).';
comment on column public.orders.delivered_at is 'Yerbas: cuándo pasó a «Entregado».';
comment on column public.orders.auto_delivered is 'Yerbas: true si lo pasó a «Entregado» la entrega automática.';
comment on column public.orders.auto_deliver is 'Yerbas: false = no se entrega solo (se volvió de «Entregado» a «Listo» a mano).';

-- ---------------------------------------------------------------------
-- Cambiar el estado (administradores). Misma función, más pasos.
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

  if v_to = v_order.status then
    return private.order_summary(v_id);
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

  -- Un pendiente vencido ya no compromete stock: al confirmarlo o pasarlo
  -- directo a listo se vuelve a controlar lo disponible.
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

  -- Stock físico: salida al llegar a LISTO (desde pendiente/confirmado/preparando);
  -- entrada al volver de LISTO a preparación o al cancelar. Entregado ↔ listo: nada.
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
         -- Vuelto a mano de «Entregado» a «Listo»: ya no se entrega solo.
         auto_deliver = case when v_order.status = 'entregado' and v_to = 'listo' then false
                             when v_to = 'listo' then true
                             else o.auto_deliver end
   where o.id = v_id;

  insert into public.order_events (order_id, event, from_status, to_status, detail)
  values (v_id, 'estado', v_order.status, v_to,
          case when v_order.status = 'pendiente' and v_order.expires_at <= now()
               then jsonb_build_object('vencido', true) else '{}'::jsonb end);

  return private.order_summary(v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- Entrega automática: «Listo» hace 24 h o más → «Entregado».
-- Devuelve los números de pedido que cambió en esta ejecución.
-- La pueden ejecutar los administradores (el panel) o pg_cron (sin sesión).
-- ---------------------------------------------------------------------
create function public.deliver_due_yerba_orders()
returns setof bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids bigint[];
begin
  -- Desde la API: solo administradores. pg_cron corre sin JWT (postgres).
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') and not private.is_admin() then
    raise exception 'Solo los administradores pueden ejecutar la entrega automática.'
      using errcode = 'insufficient_privilege';
  end if;

  with due as (
    select o.id
      from public.orders o
     where o.kind = 'yerbas' and o.status = 'listo' and o.auto_deliver
       and o.ready_at is not null and o.ready_at <= now() - interval '24 hours'
     order by o.id
       for update skip locked
  ), done as (
    update public.orders o
       set status = 'entregado', stock_applied = true, delivered_at = now(), auto_delivered = true,
           status_changed_at = now(), updated_at = now()
      from due
     where o.id = due.id and o.status = 'listo'
    returning o.id
  )
  select coalesce(array_agg(id order by id), '{}') into v_ids from done;

  insert into public.order_events (order_id, event, from_status, to_status, detail, created_by)
  select x, 'estado', 'listo', 'entregado', jsonb_build_object('automatico', true), null
    from unnest(v_ids) as x;

  return query select unnest(v_ids);
end;
$$;

revoke all on function public.deliver_due_yerba_orders() from public, anon, authenticated;
grant execute on function public.deliver_due_yerba_orders() to authenticated;

commit;
