-- =====================================================================
-- Verificación de cuentas de clientes (correr DESPUÉS de la migración
-- 20261030000000_customer_accounts.sql) en el SQL Editor de Supabase.
--
-- NO deja datos: crea dos clientes de prueba dentro de una transacción,
-- verifica permisos como si fueran ellos y al final hace ROLLBACK.
-- Si algo falla, se detiene con un mensaje "FALLA: ..." y tampoco guarda nada.
-- Si todo está bien, el último resultado dice "Todo OK".
-- =====================================================================
begin;

-- Dos clientes de prueba (como los crearía el registro de la tienda)
insert into auth.users (id, aud, role, email, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'prueba-a@povmatero.invalid',
   '{"first_name":"Prueba","last_name":"Uno","phone":"11 5555-5555","marketing_opt_in":true,"marketing_method":"signup_prechecked","marketing_text":"Quiero recibir novedades, promociones y ofertas de Povmatero."}',
   now(), now()),
  ('00000000-0000-4000-8000-0000000000b2', 'authenticated', 'authenticated', 'prueba-b@povmatero.invalid',
   '{"first_name":"Prueba","last_name":"Dos","marketing_opt_in":false,"marketing_method":"signup_unchecked","role":"owner","is_admin":true}',
   now(), now());

do $$
begin
  if not exists (select 1 from public.customer_profiles
                 where user_id = '00000000-0000-4000-8000-0000000000a1'
                   and marketing_opt_in and marketing_consent_method = 'signup_prechecked'
                   and phone = '11 5555-5555') then
    raise exception 'FALLA: el registro no creó el perfil A con su preferencia';
  end if;
  if not exists (select 1 from public.customer_profiles
                 where user_id = '00000000-0000-4000-8000-0000000000b2' and not marketing_opt_in) then
    raise exception 'FALLA: el perfil B debería figurar sin novedades';
  end if;
  if (select count(*) from public.marketing_consent_events
      where user_id in ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2')) <> 2 then
    raise exception 'FALLA: falta el historial de consentimiento del registro';
  end if;
  if exists (select 1 from public.admin_users where user_id = '00000000-0000-4000-8000-0000000000b2') then
    raise exception 'FALLA: un cliente quedó como admin';
  end if;
end $$;

-- A partir de acá, actuamos como el cliente A (usuario logueado común)
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

do $$
declare n int;
begin
  select count(*) into n from public.customer_profiles;
  if n <> 1 then raise exception 'FALLA: el cliente ve % perfiles (debería ver solo el suyo)', n; end if;

  select count(*) into n from public.admin_users;
  if n <> 0 then raise exception 'FALLA: el cliente figura como admin'; end if;

  update public.customer_profiles set first_name = 'hack'
   where user_id = '00000000-0000-4000-8000-0000000000b2';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FALLA: el cliente pudo editar el perfil de otro'; end if;

  begin
    update public.customer_profiles set email = 'otro@x.com'
     where user_id = '00000000-0000-4000-8000-0000000000a1';
    raise exception 'FALLA: el cliente pudo cambiar su email en el perfil';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.admin_users (user_id, role)
    values ('00000000-0000-4000-8000-0000000000a1', 'owner');
    raise exception 'FALLA: el cliente pudo darse permisos de admin';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.marketing_consent_events (user_id, opted_in, method)
    values ('00000000-0000-4000-8000-0000000000a1', true, 'signup_checked');
    raise exception 'FALLA: el cliente pudo escribir el historial de consentimientos';
  exception when insufficient_privilege then null;
  end;

  select count(*) into n from public.variant_costs;
  if n <> 0 then raise exception 'FALLA: el cliente ve costos'; end if;

  -- Baja de novedades desde su cuenta: queda registrada
  update public.customer_profiles set marketing_opt_in = false
   where user_id = '00000000-0000-4000-8000-0000000000a1';
  if not exists (select 1 from public.customer_profiles
                 where marketing_consent_method = 'account_opt_out' and not marketing_opt_in) then
    raise exception 'FALLA: la baja de novedades no quedó registrada';
  end if;
  select count(*) into n from public.marketing_consent_events;
  if n <> 2 then raise exception 'FALLA: el historial del cliente debería tener 2 eventos (tiene %)', n; end if;
end $$;

-- Visitante sin sesión
reset role;
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
do $$
begin
  begin
    perform 1 from public.customer_profiles limit 1;
    raise exception 'FALLA: un visitante puede leer perfiles';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.storefront_catalog) = 0 then
    raise exception 'FALLA: el visitante no ve el catálogo';
  end if;
end $$;

reset role;
select 'Todo OK: permisos de clientes verificados (no se guardó nada)' as resultado;

rollback;
