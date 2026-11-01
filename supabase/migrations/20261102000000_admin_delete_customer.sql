-- =====================================================================
-- Eliminar una cuenta de cliente desde el panel.
--
-- Borra la cuenta de Supabase Auth (auth.users). Con eso el email queda libre
-- para registrarse de nuevo, y se borran en cascada:
--   * public.customer_profiles          (perfil)
--   * public.marketing_consent_events   (historial de novedades de esa persona)
--   * sesiones, identidades y tokens de Auth (los maneja Supabase)
-- Las referencias de auditoría del panel (inventory_movements.created_by,
-- variant_costs.updated_by) quedan en null; un cliente nunca las escribe.
--
-- Seguridad:
--   * Sin claves secretas en el navegador: el panel llama a esta función con la
--     sesión del administrador; la función corre con permisos del dueño
--     (SECURITY DEFINER) y verifica TODO adentro:
--       - quien llama es administrador (private.is_admin());
--       - no es su propia cuenta;
--       - la cuenta a borrar no es de un administrador;
--       - es un cliente (tiene perfil en customer_profiles): nunca borra
--         cuentas arbitrarias de Auth.
--   * Si en el futuro existe public.orders con customer_id, la función se niega
--     a borrar clientes con pedidos (los pedidos no se pierden por accidente).
--   * anon no puede ejecutarla; authenticated sí, pero la función rechaza a
--     quien no sea administrador.
--
-- No modifica ni borra datos al aplicarse. Solo crea la función.
-- =====================================================================

begin;

create or replace function public.admin_delete_customer(target uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email   text;
  v_events  integer;
  v_orders  integer := 0;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden eliminar clientes.'
      using errcode = 'insufficient_privilege';
  end if;

  if target is null then
    raise exception 'Falta el cliente a eliminar.' using errcode = 'invalid_parameter_value';
  end if;

  if target = (select auth.uid()) then
    raise exception 'No podés eliminar la cuenta con la que estás usando el panel.'
      using errcode = 'check_violation', hint = 'own_account';
  end if;

  if exists (select 1 from public.admin_users where user_id = target) then
    raise exception 'Es una cuenta de administrador: no se elimina desde el panel.'
      using errcode = 'check_violation', hint = 'admin_account';
  end if;

  -- Bloquea el perfil mientras se revisa y borra (evita dos borrados a la vez).
  select email into v_email
    from public.customer_profiles
   where user_id = target
   for update;
  if not found then
    raise exception 'No existe un cliente con esa cuenta (puede que ya se haya eliminado).'
      using errcode = 'no_data_found', hint = 'not_found';
  end if;

  -- Pedidos (cuando exista la tabla): nunca se borran por eliminar una cuenta.
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'orders' and column_name = 'customer_id') then
    execute 'select count(*) from public.orders where customer_id = $1' into v_orders using target;
    if v_orders > 0 then
      raise exception 'Este cliente tiene % pedido(s): no se elimina para no perder ese historial.', v_orders
        using errcode = 'check_violation', hint = 'has_orders';
    end if;
  end if;

  select count(*) into v_events from public.marketing_consent_events where user_id = target;

  delete from auth.users where id = target;

  return jsonb_build_object('email', v_email, 'consent_events', v_events);
end;
$$;

revoke all on function public.admin_delete_customer(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_customer(uuid) to authenticated;

comment on function public.admin_delete_customer(uuid) is
  'Panel: elimina la cuenta de Auth de un cliente (y en cascada su perfil e historial de novedades). Solo administradores; nunca la propia cuenta ni la de otro administrador.';

commit;
