-- =====================================================================
-- Pedidos a proveedor: recepción completa o con variaciones.
--
-- Reemplaza SOLO public.admin_receive_supplier_order (misma firma). No crea
-- tablas ni columnas y no toca pedidos ni movimientos existentes.
--
-- Qué cambia respecto de 20261109:
--   * items = null  → «Confirmar pedido completo»: se recibe todo lo pedido.
--   * items = lista → «Confirmar con variaciones»: la lista ES lo recibido.
--       - Lo que no figura en la lista cuenta como 0 (antes contaba como lo
--         pedido): nunca se suma una cantidad original que se cambió o quitó.
--       - Cada presentación tiene que ser del pedido y figurar una sola vez.
--   * Si todo lo recibido da 0, no se registra una recepción vacía: se
--     rechaza (hint 'empty_reception') y el pedido queda como estaba. Si el
--     proveedor no tiene nada, el pedido se cancela.
-- Igual que antes:
--   * Se guarda lo pedido (quantity) y lo recibido (received_quantity) de
--     cada línea, para consultar las diferencias después.
--   * Una entrada de stock por presentación, vinculada al pedido, en la misma
--     transacción que el cambio a «recibido».
--   * El pedido se bloquea (FOR UPDATE): confirmar dos veces, o a la vez, no
--     duplica stock (la segunda vez devuelve already_received = true).
--   * Solo administradores.
--
-- Requiere 20261109000000_stock_tools.sql. Se puede ejecutar más de una vez
-- (create or replace).
-- =====================================================================

begin;

create or replace function public.admin_receive_supplier_order(order_id bigint, items jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id    bigint := admin_receive_supplier_order.order_id;
  v_items jsonb := admin_receive_supplier_order.items;
  v_order public.supplier_orders;
  v_total integer;
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

  if v_items is not null then
    -- Formato: [{ "variant_id": 12, "quantity": 7 }], enteros de 0 a 9999.
    if jsonb_typeof(v_items) is distinct from 'array' or exists (
         select 1 from jsonb_array_elements(v_items) e
          where jsonb_typeof(e) is distinct from 'object'
             or jsonb_typeof(e -> 'variant_id') is distinct from 'number'
             or jsonb_typeof(e -> 'quantity') is distinct from 'number'
             or (e ->> 'quantity')::numeric <> trunc((e ->> 'quantity')::numeric)
             or (e ->> 'quantity')::numeric not between 0 and 9999) then
      raise exception 'Revisá las cantidades recibidas (enteros de 0 a 9999).'
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
    -- Cada presentación una sola vez y solo las de este pedido.
    if exists (select 1 from jsonb_array_elements(v_items) e
                group by (e ->> 'variant_id') having count(*) > 1)
       or exists (select 1 from jsonb_array_elements(v_items) e
                   where not exists (select 1 from public.supplier_order_items i
                                      where i.supplier_order_id = v_id
                                        and i.variant_id = (e ->> 'variant_id')::bigint)) then
      raise exception 'La recepción tiene presentaciones repetidas o que no son de este pedido.'
        using errcode = 'invalid_parameter_value', hint = 'invalid_items';
    end if;
  end if;

  -- Lo recibido de cada línea: completo = lo pedido; con variaciones = lo
  -- indicado (lo que no está, 0). Lo pedido (quantity) no se toca.
  update public.supplier_order_items i
     set received_quantity = case
           when v_items is null then i.quantity
           else coalesce((select (e ->> 'quantity')::integer
                            from jsonb_array_elements(v_items) e
                           where (e ->> 'variant_id')::bigint = i.variant_id), 0)
         end
   where i.supplier_order_id = v_id;

  select coalesce(sum(i.received_quantity), 0)::integer into v_total
    from public.supplier_order_items i
   where i.supplier_order_id = v_id and i.variant_id is not null;
  if v_total = 0 then
    -- Se deshace todo (incluido el update de arriba): nada queda registrado.
    raise exception 'No hay unidades para recibir. Si el proveedor no tiene nada, cancelá el pedido.'
      using errcode = 'check_violation', hint = 'empty_reception';
  end if;

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

revoke all on function public.admin_receive_supplier_order(bigint, jsonb) from public, anon, authenticated;
grant execute on function public.admin_receive_supplier_order(bigint, jsonb) to authenticated;

commit;

-- Verificación (solo lectura) después de aplicar: tiene que dar true.
-- select prosrc like '%empty_reception%' as recepcion_nueva
--   from pg_proc where oid = 'public.admin_receive_supplier_order(bigint,jsonb)'::regprocedure;
