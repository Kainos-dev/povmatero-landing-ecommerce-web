-- =====================================================================
-- Avisos de reposición de yerbas («Avisarme cuando vuelva»).
--
-- Un cliente con cuenta pide que le avisen cuando una presentación agotada
-- (por ejemplo Canarias 500 g) vuelva a estar disponible. El aviso es por
-- presentación: si se repone Canarias 1 kg, quien pidió 500 g no figura.
--
--   public.restock_requests   una solicitud por cliente y presentación
--     estado: activa → avisada  (o cancelada por el cliente)
--
-- Cuándo «vuelve»: cuando lo disponible (stock físico − lo comprometido por
-- pedidos de yerbas, el mismo número que muestra la tienda) pasa a ser > 0.
-- Se calcula al consultar (no se guarda aparte), así nunca queda desfasado:
-- cubre entradas de stock, pedidos cancelados y reservas vencidas, sin
-- tareas programadas.
--
-- Cómo se avisa HOY: no hay un servicio de email transaccional (Supabase Auth
-- solo manda los emails de la cuenta). Por eso el panel muestra «Avisos para
-- enviar» (solicitudes activas cuya presentación ya está disponible) con el
-- teléfono y el email del cliente, un mensaje listo para WhatsApp, y el botón
-- «Marcar avisado». Marcar avisado es idempotente: una solicitud se marca una
-- sola vez (nunca se avisa dos veces). Cuando haya un proveedor de email, una
-- función del servidor puede usar las mismas funciones (ver el final).
--
-- El aviso NO reserva ni descuenta stock.
--
-- Funciones (nada se escribe directo en la tabla desde la API):
--   public.request_restock_alert(variant_id)     cliente con cuenta
--   public.cancel_restock_alert(variant_id)      cliente con cuenta
--   public.admin_restock_alerts()                administradores: activas, con
--                                                lo disponible de cada una
--   public.admin_mark_restock_notified(ids)      administradores
--
-- RLS: cada cliente ve solo sus solicitudes; los administradores, todas.
-- No modifica tablas ni datos existentes. Se ejecuta UNA vez (si la tabla ya
-- existe, falla al empezar y no cambia nada).
-- =====================================================================

begin;

create table public.restock_requests (
  id           bigint generated always as identity primary key,
  product_id   bigint not null references public.products (id) on delete cascade,
  variant_id   bigint not null references public.product_variants (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  email        text not null default '' check (char_length(email) <= 254),
  status       text not null default 'activa' check (status in ('activa', 'avisada', 'cancelada')),
  created_at   timestamptz not null default now(),
  notified_at  timestamptz,
  notified_by  uuid references auth.users (id) on delete set null,
  cancelled_at timestamptz,
  constraint restock_requests_notified_check  check ((status = 'avisada') = (notified_at is not null)),
  constraint restock_requests_cancelled_check check ((status = 'cancelada') = (cancelled_at is not null))
);

-- Una sola solicitud activa por cliente y presentación (sin duplicados).
create unique index restock_requests_one_active
  on public.restock_requests (user_id, variant_id) where status = 'activa';
create index restock_requests_variant_idx on public.restock_requests (variant_id, status);

comment on table public.restock_requests is
  'Avisos de reposición: un cliente pide que le avisen cuando vuelva una presentación agotada. No reserva stock.';

revoke all on public.restock_requests from public, anon, authenticated;
grant select on public.restock_requests to authenticated;
alter table public.restock_requests enable row level security;

create policy "restock_requests: cada cliente ve las suyas"
  on public.restock_requests for select to authenticated
  using (user_id = (select auth.uid()));

create policy "restock_requests: admins leen todas"
  on public.restock_requests for select to authenticated
  using ((select private.is_admin()));

-- ---------------------------------------------------------------------
-- Lo disponible de una presentación (null = no controla stock).
-- Mismo cálculo que storefront_catalog.stock.
-- ---------------------------------------------------------------------
create function private.variant_available(p_variant bigint)
returns integer
language sql
stable
set search_path = ''
as $$
  select case when v.track_stock then greatest(v.stock - private.committed_qty(v.id), 0) end
    from public.product_variants v
   where v.id = p_variant
$$;

-- ---------------------------------------------------------------------
-- Pedir el aviso (cliente con cuenta). Devuelve la solicitud activa (la
-- nueva o la que ya tenía: pedirlo dos veces no duplica nada).
-- Solo yerbas publicadas que hoy están agotadas.
-- ---------------------------------------------------------------------
create function public.request_restock_alert(variant_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_user    uuid := (select auth.uid());
  v_variant bigint := request_restock_alert.variant_id;
  v_product bigint;
  v_email   text;
  v_row     public.restock_requests;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta para pedir el aviso.'
      using errcode = 'insufficient_privilege', hint = 'login_required';
  end if;

  select p.id into v_product
    from public.product_variants v
    join public.products p   on p.id = v.product_id and p.is_active
    join public.categories c on c.id = p.category_id and c.is_active and c.slug = 'yerbas'
   where v.id = v_variant and v.is_active;
  if v_product is null then
    raise exception 'Esta presentación ya no está publicada.'
      using errcode = 'check_violation', hint = 'unavailable';
  end if;

  -- Ya activa: se devuelve la misma.
  select * into v_row from public.restock_requests r
   where r.user_id = v_user and r.variant_id = v_variant and r.status = 'activa';
  if found then
    return jsonb_build_object('id', v_row.id, 'variant_id', v_row.variant_id, 'status', v_row.status, 'created_at', v_row.created_at);
  end if;

  if coalesce(private.variant_available(v_variant), 1) > 0 then
    raise exception 'Esta presentación ya está disponible: podés pedirla ahora.'
      using errcode = 'check_violation', hint = 'available';
  end if;

  if (select count(*) from public.restock_requests r
       where r.user_id = v_user and r.status = 'activa') >= 50 then
    raise exception 'Tenés demasiados avisos activos. Cancelá alguno para pedir otro.'
      using errcode = 'check_violation', hint = 'too_many';
  end if;

  select coalesce(nullif(p.email, ''), u.email, '') into v_email
    from auth.users u left join public.customer_profiles p on p.user_id = u.id
   where u.id = v_user;

  -- Dos pedidos simultáneos: el índice único deja uno solo.
  insert into public.restock_requests (product_id, variant_id, user_id, email)
  values (v_product, v_variant, v_user, left(coalesce(v_email, ''), 254))
  on conflict (user_id, variant_id) where status = 'activa' do nothing
  returning * into v_row;
  if v_row.id is null then
    select * into v_row from public.restock_requests r
     where r.user_id = v_user and r.variant_id = v_variant and r.status = 'activa';
  end if;

  return jsonb_build_object('id', v_row.id, 'variant_id', v_row.variant_id, 'status', v_row.status, 'created_at', v_row.created_at);
end;
$$;

-- ---------------------------------------------------------------------
-- Cancelar el aviso (cliente con cuenta). true = había uno activo.
-- ---------------------------------------------------------------------
create function public.cancel_restock_alert(variant_id bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_n    integer;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta.' using errcode = 'insufficient_privilege', hint = 'login_required';
  end if;
  update public.restock_requests r
     set status = 'cancelada', cancelled_at = now()
   where r.user_id = v_user and r.variant_id = cancel_restock_alert.variant_id and r.status = 'activa';
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- ---------------------------------------------------------------------
-- Panel: solicitudes activas con lo disponible hoy («due» = ya hay stock:
-- hay que avisar). Datos de contacto del perfil del cliente.
-- ---------------------------------------------------------------------
create function public.admin_restock_alerts()
returns table (
  id bigint, product_id bigint, variant_id bigint, product_name text, variant_name text,
  user_id uuid, customer_name text, email text, phone text,
  created_at timestamptz, available integer, due boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden ver los avisos.' using errcode = 'insufficient_privilege';
  end if;
  return query
    select r.id, r.product_id, r.variant_id, p.name, nullif(v.name, 'Único'),
           r.user_id,
           btrim(concat_ws(' ', nullif(btrim(cp.first_name), ''), nullif(btrim(cp.last_name), ''))),
           coalesce(nullif(cp.email, ''), r.email), cp.phone,
           r.created_at, a.available, coalesce(a.available, 1) > 0
      from public.restock_requests r
      join public.product_variants v on v.id = r.variant_id
      join public.products p on p.id = r.product_id
      left join public.customer_profiles cp on cp.user_id = r.user_id
      cross join lateral (select private.variant_available(r.variant_id) as available) a
     where r.status = 'activa'
     order by (coalesce(a.available, 1) > 0) desc, r.created_at;
end;
$$;

-- ---------------------------------------------------------------------
-- Panel: marcar como avisadas. Solo cambia las que siguen activas: repetirlo
-- no vuelve a marcar nada (devuelve las que cambió en esta llamada).
-- ---------------------------------------------------------------------
create function public.admin_mark_restock_notified(ids bigint[])
returns setof bigint
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden marcar avisos.' using errcode = 'insufficient_privilege';
  end if;
  return query
    update public.restock_requests r
       set status = 'avisada', notified_at = now(), notified_by = (select auth.uid())
     where r.id = any (ids) and r.status = 'activa'
    returning r.id;
end;
$$;

revoke all on function private.variant_available(bigint)                  from public, anon, authenticated;
revoke all on function public.request_restock_alert(bigint)               from public, anon, authenticated;
revoke all on function public.cancel_restock_alert(bigint)                from public, anon, authenticated;
revoke all on function public.admin_restock_alerts()                      from public, anon, authenticated;
revoke all on function public.admin_mark_restock_notified(bigint[])       from public, anon, authenticated;
grant execute on function public.request_restock_alert(bigint)            to authenticated;
grant execute on function public.cancel_restock_alert(bigint)             to authenticated;
grant execute on function public.admin_restock_alerts()                   to authenticated;
grant execute on function public.admin_mark_restock_notified(bigint[])    to authenticated;

commit;

-- ---------------------------------------------------------------------
-- Más adelante (NO incluido): aviso automático por email.
-- Falta: un proveedor de email transaccional (Resend, Postmark, SES…) con su
-- clave guardada en Vercel o en una Edge Function, y algo que lo dispare
-- (pg_cron cada N minutos o un webhook). Esa función leería las solicitudes
-- activas con lo disponible > 0, enviaría el email y las marcaría avisadas
-- con el mismo criterio de admin_mark_restock_notified (solo las activas).
-- ---------------------------------------------------------------------
