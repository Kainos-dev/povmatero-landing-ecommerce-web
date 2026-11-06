-- =====================================================================
-- Notificaciones Web Push para administradores (PWA del panel).
--
-- Flujo:
--   1. Un administrador activa las notificaciones en un dispositivo (botón en
--      el panel). El navegador entrega una suscripción (endpoint + claves) y
--      el panel la guarda con public.admin_push_subscribe. Un administrador
--      puede tener varios dispositivos: cada endpoint es una fila propia.
--   2. Cuando un pedido web (yerbas o tienda) se registra, un trigger DIFERIDO
--      (corre al confirmar la transacción, con el pedido ya completo) anota
--      un evento en la cola private.push_events. Si el pedido falla, no queda
--      nada: el evento es parte de la misma transacción. Si la cola falla, el
--      pedido NO se bloquea (se registra un aviso y se sigue).
--   3. Después de anotar, la base «despierta» al servidor de envío
--      (/api/push-send en Vercel) con pg_net, si está configurado (ver más
--      abajo). La llamada sale recién cuando la transacción se confirma.
--   4. El servidor toma la cola con la clave secreta (public.push_claim),
--      cifra y envía cada notificación (Web Push + VAPID) y devuelve el
--      resultado (public.push_report).
--
-- Sin duplicados:
--   * Cada evento tiene una clave única (event_key: «order:<id>»,
--     «restock:<presentación>:<solicitud>»): anotarlo dos veces no hace nada.
--   * Cada envío es una fila (evento × dispositivo) con clave única; se toma
--     con FOR UPDATE SKIP LOCKED y un plazo (lease): dos servidores a la vez
--     nunca toman el mismo envío; uno enviado no se vuelve a enviar.
--   * La notificación lleva una etiqueta (tag) por pedido: si llegara dos
--     veces, el teléfono muestra una sola.
-- Errores:
--   * 404/410 del servicio de push = suscripción vencida: se desactiva.
--   * 429/5xx o sin respuesta: se reintenta hasta 5 veces, cada vez más
--     espaciado. Después queda como fallida (el pedido siempre está en el panel).
--   * Un envío que no se pudo hacer en 24 h se descarta (ya no sirve).
--
-- Avisos de reposición: cuando una presentación con avisos activos vuelve a
-- tener stock DISPONIBLE (entrada de stock, pedido cancelado o reserva
-- vencida), se anota un evento para los administradores («Volvió el stock…»),
-- una sola vez por cada grupo de solicitudes. El aviso al cliente sigue igual:
-- desde «Avisos de reposición» del panel, con «Marcar avisado».
--
-- Datos en la notificación: nombre de pila + inicial del apellido, código del
-- pedido, cantidad de productos y total. Sin teléfono, email ni dirección.
--
-- Seguridad:
--   * Suscripciones: solo administradores las crean o borran, y cada uno solo
--     las suyas (funciones). La API solo deja LEER las propias, sin las claves.
--   * La cola y los envíos están en el esquema private (sin acceso por la API).
--     push_claim y push_report solo los puede ejecutar service_role (la clave
--     secreta del servidor). La clave privada VAPID vive solo en Vercel.
--   * Endpoints aceptados: solo servicios de push conocidos (Apple, Google,
--     Mozilla, Microsoft), así el servidor nunca envía a otra dirección.
--
-- Configuración para el aviso inmediato (pg_net + Vault). Sin esto todo
-- funciona igual, pero los avisos salen recién cuando corre la tarea diaria:
--   create extension if not exists pg_net;
--   select vault.create_secret('https://<dominio>/api/push-send', 'povmatero_push_url');
--   select vault.create_secret('<mismo valor que PUSH_WEBHOOK_SECRET en Vercel>', 'povmatero_push_secret');
-- (ver supabase/checks/20261115_configurar_push.sql)
--
-- Requiere 20261114000000_order_codes_12h.sql. Se ejecuta UNA vez.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Suscripciones (una por dispositivo)
-- ---------------------------------------------------------------------
create table public.admin_push_subscriptions (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references auth.users (id) on delete cascade,
  endpoint        text not null unique check (char_length(endpoint) between 20 and 2048),
  p256dh          text not null check (p256dh ~ '^[A-Za-z0-9_-]{80,100}$'),
  auth_secret     text not null check (auth_secret ~ '^[A-Za-z0-9_-]{16,32}$'),
  label           text not null default '' check (char_length(label) <= 80),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_success_at timestamptz,
  last_error      text check (last_error is null or char_length(last_error) <= 300),
  failure_count   integer not null default 0 check (failure_count >= 0),
  disabled_at     timestamptz
);
create index admin_push_subscriptions_user_idx on public.admin_push_subscriptions (user_id);

comment on table public.admin_push_subscriptions is
  'Dispositivos de administradores que reciben notificaciones de pedidos. Se escriben solo con admin_push_subscribe / admin_push_unsubscribe.';

revoke all on public.admin_push_subscriptions from public, anon, authenticated;
-- Sin las claves del dispositivo (p256dh, auth_secret): no hacen falta en el navegador.
grant select (id, endpoint, label, created_at, updated_at, last_success_at, last_error, failure_count, disabled_at)
  on public.admin_push_subscriptions to authenticated;
alter table public.admin_push_subscriptions enable row level security;

create policy "admin_push_subscriptions: cada admin ve las suyas"
  on public.admin_push_subscriptions for select to authenticated
  using (user_id = (select auth.uid()) and (select private.is_admin()));

-- Servicios de push conocidos.
create function private.valid_push_endpoint(p text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(p ~ '^https://([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)/[^\s]+$', false)
$$;

-- ---------------------------------------------------------------------
-- 2. Cola de eventos y envíos (privado)
-- ---------------------------------------------------------------------
create table private.push_events (
  id          bigint generated always as identity primary key,
  event_key   text not null unique check (char_length(event_key) <= 120),
  kind        text not null check (kind in ('pedido', 'reposicion', 'prueba')),
  payload     jsonb not null,
  target_user uuid references auth.users (id) on delete cascade,   -- solo «prueba»: un administrador
  created_at  timestamptz not null default now(),
  fanned_out  boolean not null default false
);
alter table private.push_events enable row level security;
create index push_events_pending_idx on private.push_events (created_at) where not fanned_out;

create table private.push_deliveries (
  id              bigint generated always as identity primary key,
  event_id        bigint not null references private.push_events (id) on delete cascade,
  subscription_id bigint not null references public.admin_push_subscriptions (id) on delete cascade,
  status          text not null default 'pendiente'
                  check (status in ('pendiente', 'enviando', 'enviado', 'vencida', 'fallido', 'descartado')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (event_id, subscription_id)
);
alter table private.push_deliveries enable row level security;
create index push_deliveries_due_idx on private.push_deliveries (next_attempt_at)
  where status in ('pendiente', 'enviando');

revoke all on private.push_events, private.push_deliveries from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Despertar al servidor de envío (pg_net), sin bloquear nunca
-- ---------------------------------------------------------------------
-- Una vez por transacción. Si pg_net o los secretos no están, no hace nada
-- (la tarea diaria procesa la cola igual).
create function private.push_kick()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url    text;
  v_secret text;
begin
  if current_setting('povmatero.push_kicked', true) = 'on' then
    return;
  end if;
  if to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  begin
    execute $q$select max(decrypted_secret) filter (where name = 'povmatero_push_url'),
                      max(decrypted_secret) filter (where name = 'povmatero_push_secret')
                 from vault.decrypted_secrets
                where name in ('povmatero_push_url', 'povmatero_push_secret')$q$
      into v_url, v_secret;
    if v_url is null or v_secret is null or v_url !~ '^https://' then
      return;
    end if;
    execute 'select net.http_post(url := $1, body := $2, params := $3, headers := $4, timeout_milliseconds := $5)'
      using v_url, '{}'::jsonb, '{}'::jsonb,
            jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_secret), 5000;
    perform set_config('povmatero.push_kicked', 'on', true);
  exception when others then
    raise warning 'push_kick: no se pudo avisar al servidor de envío (%).', sqlerrm;
  end;
end;
$$;

-- «$24.500»
create function private.money_text(p numeric)
returns text
language sql
immutable
set search_path = ''
as $$ select '$' || replace(to_char(round(coalesce(p, 0)), 'FM999,999,999,990'), ',', '.') $$;

-- ---------------------------------------------------------------------
-- 4. Evento «nuevo pedido» (trigger diferido: corre al confirmar)
-- ---------------------------------------------------------------------
create function private.push_order_created()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  o       public.orders;
  v_first text;
  v_last  text;
  v_who   text;
  v_units text;
begin
  begin
    select * into o from public.orders where id = new.id;
    if not found or o.kind not in ('yerbas', 'tienda') then
      return null;
    end if;
    select p.first_name, p.last_name into v_first, v_last
      from public.customer_profiles p where p.user_id = o.customer_id;
    v_first := coalesce(nullif(btrim(v_first), ''), nullif(split_part(btrim(o.customer_name), ' ', 1), ''), 'Cliente');
    v_last := nullif(btrim(coalesce(v_last, '')), '');
    v_who := split_part(v_first, ' ', 1) || coalesce(' ' || upper(left(v_last, 1)) || '.', '');
    v_units := o.item_count || case when o.kind = 'yerbas'
                                    then case when o.item_count = 1 then ' paquete' else ' paquetes' end
                                    else case when o.item_count = 1 then ' producto' else ' productos' end end;

    insert into private.push_events (event_key, kind, payload)
    values ('order:' || o.id, 'pedido', jsonb_build_object(
      'title', case when o.kind = 'yerbas' then 'Nuevo pedido de yerbas' else 'Nuevo pedido' end,
      'body', concat_ws(' · ', v_who, coalesce(o.public_code, 'Pedido nuevo'), v_units, private.money_text(o.total)),
      'url', '/admin/#/pedidos/' || o.id,
      'tag', 'pedido-' || o.id,
      'ttl', 86400,
      'urgency', 'high'))
    on conflict (event_key) do nothing;

    perform private.push_kick();
  exception when others then
    -- Nunca bloquea el pedido.
    raise warning 'push_order_created: no se pudo anotar la notificación del pedido % (%).', new.id, sqlerrm;
  end;
  return null;
end;
$$;

create constraint trigger orders_push_created
  after insert on public.orders
  deferrable initially deferred
  for each row
  when (new.kind in ('yerbas', 'tienda'))
  execute function private.push_order_created();

-- ---------------------------------------------------------------------
-- 5. Evento «volvió el stock» para los administradores (avisos de reposición)
--    Misma regla que el panel: solicitudes activas cuya presentación tiene
--    disponible > 0. Una sola vez por grupo de solicitudes (la clave lleva la
--    última solicitud activa): repetirlo no duplica; una solicitud nueva
--    (cuando vuelva a agotarse) genera otro aviso.
-- ---------------------------------------------------------------------
create function private.queue_restock_push(p_variants bigint[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  insert into private.push_events (event_key, kind, payload)
  select 'restock:' || x.variant_id || ':' || x.last_id, 'reposicion', jsonb_build_object(
           'title', 'Volvió el stock',
           'body', x.label || ' · ' || x.waiting || case when x.waiting = 1 then ' cliente espera el aviso' else ' clientes esperan el aviso' end,
           'url', '/admin/#/avisos',
           'tag', 'reposicion-' || x.variant_id,
           'ttl', 43200,
           'urgency', 'normal')
    from (select r.variant_id, max(r.id) as last_id, count(*) as waiting,
                 min(p.name) || coalesce(' ' || nullif(min(v.name), 'Único'), '') as label
            from public.restock_requests r
            join public.product_variants v on v.id = r.variant_id
            join public.products p on p.id = r.product_id
           where r.status = 'activa'
             and (p_variants is null or r.variant_id = any (p_variants))
           group by r.variant_id) x
   where coalesce(private.variant_available(x.variant_id), 1) > 0
  on conflict (event_key) do nothing;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- Entrada de stock (cualquier origen: panel, proveedor, devolución de un pedido).
create function private.push_restock_from_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if private.queue_restock_push(array[new.variant_id]) > 0 then
      perform private.push_kick();
    end if;
  exception when others then
    raise warning 'push_restock_from_movement: %', sqlerrm;
  end;
  return null;
end;
$$;

create constraint trigger inventory_movements_push_restock
  after insert on public.inventory_movements
  deferrable initially deferred
  for each row
  when (new.quantity > 0)
  execute function private.push_restock_from_movement();

-- Pedido cancelado (a mano o por falta de respuesta): libera su reserva.
create function private.push_restock_from_order()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    if private.queue_restock_push(array(select distinct i.variant_id from public.order_items i
                                          where i.order_id = new.id and i.variant_id is not null)) > 0 then
      perform private.push_kick();
    end if;
  exception when others then
    raise warning 'push_restock_from_order: %', sqlerrm;
  end;
  return null;
end;
$$;

create constraint trigger orders_push_restock
  after update of status on public.orders
  deferrable initially deferred
  for each row
  when (new.status = 'cancelado' and old.status is distinct from 'cancelado')
  execute function private.push_restock_from_order();

-- Mantenimiento: igual que antes + avisos de reposición por reservas vencidas
-- (una reserva vencida libera stock sin que nada cambie en la base hasta acá).
create or replace function public.run_order_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled bigint[];
  v_delivered bigint[];
  v_restock   integer := 0;
begin
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') and not private.is_admin() then
    raise exception 'Solo los administradores pueden ejecutar el mantenimiento de pedidos.'
      using errcode = 'insufficient_privilege';
  end if;
  select coalesce(array_agg(x), '{}') into v_cancelled from public.cancel_unanswered_yerba_orders() x;
  select coalesce(array_agg(x), '{}') into v_delivered from public.deliver_due_yerba_orders() x;
  begin
    v_restock := private.queue_restock_push(null);
    if v_restock > 0 then
      perform private.push_kick();
    end if;
  exception when others then
    raise warning 'run_order_maintenance: avisos de reposición (%).', sqlerrm;
  end;
  return jsonb_build_object('cancelados', to_jsonb(v_cancelled), 'entregados', to_jsonb(v_delivered),
                            'avisos_reposicion', v_restock, 'hora', now());
end;
$$;

-- ---------------------------------------------------------------------
-- 6. Funciones del panel (administradores)
-- ---------------------------------------------------------------------
-- Guarda la suscripción de ESTE dispositivo. Si el endpoint ya existía (el
-- mismo dispositivo), se actualiza y pasa a ser del administrador actual.
create function public.admin_push_subscribe(endpoint text, p256dh text, auth_secret text, label text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_row  public.admin_push_subscriptions;
begin
  if v_user is null or not private.is_admin() then
    raise exception 'Solo los administradores pueden activar notificaciones.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;
  if not private.valid_push_endpoint(admin_push_subscribe.endpoint)
     or char_length(admin_push_subscribe.endpoint) > 2048
     or coalesce(admin_push_subscribe.p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}$'
     or coalesce(admin_push_subscribe.auth_secret, '') !~ '^[A-Za-z0-9_-]{16,32}$' then
    raise exception 'La suscripción del navegador no es válida.'
      using errcode = 'invalid_parameter_value', hint = 'invalid_subscription';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('povmatero:push_sub:' || v_user::text, 0));
  if (select count(*) from public.admin_push_subscriptions s
       where s.user_id = v_user and s.endpoint <> admin_push_subscribe.endpoint) >= 20 then
    raise exception 'Tenés demasiados dispositivos con notificaciones. Quitá alguno.'
      using errcode = 'check_violation', hint = 'too_many';
  end if;

  insert into public.admin_push_subscriptions as s (user_id, endpoint, p256dh, auth_secret, label)
  values (v_user, admin_push_subscribe.endpoint, admin_push_subscribe.p256dh, admin_push_subscribe.auth_secret,
          left(coalesce(private.clean_text(admin_push_subscribe.label, 80), ''), 80))
  on conflict on constraint admin_push_subscriptions_endpoint_key do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth_secret = excluded.auth_secret,
         label = excluded.label, updated_at = now(), disabled_at = null, failure_count = 0, last_error = null
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'label', v_row.label, 'created_at', v_row.created_at);
end;
$$;

-- Quita la suscripción de un dispositivo (solo las propias). true = había una.
create function public.admin_push_unsubscribe(endpoint text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if (select auth.uid()) is null or not private.is_admin() then
    raise exception 'Solo los administradores pueden cambiar notificaciones.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;
  delete from public.admin_push_subscriptions s
   where s.endpoint = admin_push_unsubscribe.endpoint and s.user_id = (select auth.uid());
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Quita un dispositivo propio por id (lista «Tus dispositivos»).
create function public.admin_push_remove(subscription_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if (select auth.uid()) is null or not private.is_admin() then
    raise exception 'Solo los administradores pueden cambiar notificaciones.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;
  delete from public.admin_push_subscriptions s
   where s.id = admin_push_remove.subscription_id and s.user_id = (select auth.uid());
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- Notificación de prueba a los dispositivos propios (una por minuto como máximo).
create function public.admin_push_test()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user    uuid := (select auth.uid());
  v_devices integer;
  v_minute  text := to_char(date_trunc('minute', now()), 'YYYYMMDDHH24MI');
  v_id      bigint;
begin
  if v_user is null or not private.is_admin() then
    raise exception 'Solo los administradores pueden enviar pruebas.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;
  select count(*) into v_devices from public.admin_push_subscriptions s
   where s.user_id = v_user and s.disabled_at is null;
  if v_devices = 0 then
    raise exception 'Primero activá las notificaciones en este dispositivo.'
      using errcode = 'check_violation', hint = 'no_devices';
  end if;
  insert into private.push_events (event_key, kind, payload, target_user)
  values ('test:' || v_user || ':' || v_minute, 'prueba', jsonb_build_object(
            'title', 'Notificaciones activadas',
            'body', 'Así vas a ver los pedidos nuevos de Povmatero.',
            'url', '/admin/#/notificaciones', 'tag', 'prueba', 'ttl', 600, 'urgency', 'high'), v_user)
  on conflict (event_key) do nothing
  returning id into v_id;
  if v_id is null then
    raise exception 'Ya enviaste una prueba hace instantes. Esperá un minuto.'
      using errcode = 'check_violation', hint = 'rate_limit';
  end if;
  perform private.push_kick();
  return jsonb_build_object('devices', v_devices);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Funciones del servidor de envío (solo service_role)
-- ---------------------------------------------------------------------
-- Toma hasta p_limit envíos para hacer ahora. Antes reparte los eventos nuevos
-- en envíos (uno por dispositivo activo de un administrador vigente).
create function public.push_claim(p_limit integer default 50)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  -- Lista positiva: también rechaza claims ausentes, nulos o roles inesperados.
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Solo el servidor puede enviar notificaciones.' using errcode = 'insufficient_privilege';
  end if;

  -- Reparto: eventos de las últimas 24 h todavía no repartidos. Un dispositivo
  -- activado después del evento no lo recibe.
  with ev as (
    select e.* from private.push_events e
     where not e.fanned_out and e.created_at > now() - interval '24 hours'
     order by e.id
       for update skip locked
     limit 200
  ), ins as (
    insert into private.push_deliveries (event_id, subscription_id)
    select ev.id, s.id
      from ev
      join public.admin_push_subscriptions s
        on s.disabled_at is null
       and s.created_at <= ev.created_at + interval '5 seconds'
       and (ev.target_user is null or s.user_id = ev.target_user)
      join public.admin_users a on a.user_id = s.user_id
    on conflict (event_id, subscription_id) do nothing
    returning 1
  )
  update private.push_events e set fanned_out = true
    from ev where e.id = ev.id and (select count(*) from ins) >= 0;

  update private.push_events e set fanned_out = true
   where not e.fanned_out and e.created_at <= now() - interval '24 hours';

  -- Vencidos: más de 24 h sin poder enviarse.
  update private.push_deliveries d set status = 'descartado', lease_until = null, last_error = 'Venció sin enviarse'
   where d.status in ('pendiente', 'enviando') and d.created_at <= now() - interval '24 hours';

  with due as (
    select d.id
      from private.push_deliveries d
      join public.admin_push_subscriptions s on s.id = d.subscription_id and s.disabled_at is null
     where (d.status = 'pendiente' and d.next_attempt_at <= now())
        or (d.status = 'enviando' and d.lease_until < now())
     order by d.id
       for update of d skip locked
     limit greatest(1, least(coalesce(p_limit, 50), 200))
  ), claimed as (
    update private.push_deliveries d
       set status = 'enviando', attempts = d.attempts + 1, lease_until = now() + interval '90 seconds'
      from due where d.id = due.id
    returning d.id, d.event_id, d.subscription_id, d.attempts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'attempt', c.attempts, 'event_key', e.event_key,
           'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth_secret,
           'payload', e.payload) order by c.id), '[]'::jsonb)
    into v_rows
    from claimed c
    join private.push_events e on e.id = c.event_id
    join public.admin_push_subscriptions s on s.id = c.subscription_id;

  return v_rows;
end;
$$;

-- Resultado de cada envío: [{ "id": 1, "outcome": "enviado" | "vencida" | "reintentar" | "fallido", "error": "..." }]
-- Solo cambia envíos que siguen «enviando» (un resultado repetido no hace nada).
create function public.push_report(results jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r       record;
  v_d     private.push_deliveries;
  v_n     integer := 0;
  v_error text;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Solo el servidor puede enviar notificaciones.' using errcode = 'insufficient_privilege';
  end if;
  if jsonb_typeof(results) is distinct from 'array' then
    return 0;
  end if;

  for r in
    select (x ->> 'id')::bigint as id, x ->> 'outcome' as outcome, left(coalesce(x ->> 'error', ''), 300) as error
      from jsonb_array_elements(results) x
     where jsonb_typeof(x -> 'id') = 'number'
  loop
    select * into v_d from private.push_deliveries d where d.id = r.id and d.status = 'enviando' for update;
    if not found then
      continue;
    end if;
    v_error := nullif(r.error, '');
    if r.outcome = 'enviado' then
      update private.push_deliveries set status = 'enviado', sent_at = now(), lease_until = null, last_error = null where id = r.id;
      update public.admin_push_subscriptions set last_success_at = now(), failure_count = 0, last_error = null where id = v_d.subscription_id;
    elsif r.outcome = 'vencida' then
      update private.push_deliveries set status = 'vencida', lease_until = null, last_error = v_error where id = r.id;
      update public.admin_push_subscriptions
         set disabled_at = coalesce(disabled_at, now()), last_error = coalesce(v_error, 'La suscripción venció')
       where id = v_d.subscription_id;
    elsif r.outcome = 'reintentar' and v_d.attempts < 5 then
      update private.push_deliveries
         set status = 'pendiente', lease_until = null, last_error = v_error,
             next_attempt_at = now() + make_interval(mins => (power(2, v_d.attempts))::integer)
       where id = r.id;
      update public.admin_push_subscriptions set failure_count = failure_count + 1, last_error = v_error where id = v_d.subscription_id;
    else
      update private.push_deliveries set status = 'fallido', lease_until = null, last_error = v_error where id = r.id;
      update public.admin_push_subscriptions set failure_count = failure_count + 1, last_error = v_error where id = v_d.subscription_id;
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------
-- 8. Permisos
-- ---------------------------------------------------------------------
revoke all on function private.valid_push_endpoint(text)                    from public, anon, authenticated;
revoke all on function private.push_kick()                                  from public, anon, authenticated;
revoke all on function private.money_text(numeric)                          from public, anon, authenticated;
revoke all on function private.push_order_created()                         from public, anon, authenticated;
revoke all on function private.queue_restock_push(bigint[])                 from public, anon, authenticated;
revoke all on function private.push_restock_from_movement()                 from public, anon, authenticated;
revoke all on function private.push_restock_from_order()                    from public, anon, authenticated;
revoke all on function public.admin_push_subscribe(text, text, text, text)  from public, anon, authenticated;
revoke all on function public.admin_push_unsubscribe(text)                  from public, anon, authenticated;
revoke all on function public.admin_push_remove(bigint)                     from public, anon, authenticated;
revoke all on function public.admin_push_test()                             from public, anon, authenticated;
revoke all on function public.push_claim(integer)                           from public, anon, authenticated;
revoke all on function public.push_report(jsonb)                            from public, anon, authenticated;

grant execute on function public.admin_push_subscribe(text, text, text, text) to authenticated;
grant execute on function public.admin_push_unsubscribe(text)                 to authenticated;
grant execute on function public.admin_push_remove(bigint)                    to authenticated;
grant execute on function public.admin_push_test()                            to authenticated;
grant execute on function public.push_claim(integer)                          to service_role;
grant execute on function public.push_report(jsonb)                           to service_role;

commit;
