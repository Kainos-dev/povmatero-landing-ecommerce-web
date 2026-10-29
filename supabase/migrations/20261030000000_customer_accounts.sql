-- =====================================================================
-- Povmatero — Cuentas de clientes
--
-- Qué agrega:
--   * public.customer_profiles: un perfil por cuenta (nombre, apellido,
--     teléfono, email) y su preferencia actual de comunicaciones comerciales.
--   * public.marketing_consent_events: historial de cada alta o baja de
--     comunicaciones (cuándo, desde dónde, con qué texto y cómo se manifestó).
--     Sirve como constancia del consentimiento. Nadie lo edita desde la API.
--   * Triggers que crean el perfil al registrarse (desde los datos que manda
--     el formulario) y mantienen el email al día.
--
-- Seguridad:
--   * Un cliente solo ve y edita SU perfil; solo puede cambiar nombre,
--     apellido, teléfono y su preferencia de novedades. Nunca su email, fechas
--     ni el origen del consentimiento (eso lo escriben los triggers).
--   * Los administradores (public.admin_users, vía private.is_admin()) pueden
--     leer perfiles e historial. Nadie puede borrar ni editar el historial.
--   * Registrarse NO da permisos de administrador: admin_users sigue sin
--     políticas de escritura (solo se modifica desde el SQL Editor).
--   * Los datos del formulario (user_metadata) se usan solo para completar el
--     perfil, nunca para autorizar.
--
-- No modifica ni borra datos existentes. Se puede ejecutar una sola vez en el
-- SQL Editor (Supabase lo corre como una transacción).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------
create table public.customer_profiles (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  email                    text not null,
  first_name               text not null default '' check (char_length(first_name) <= 80),
  last_name                text not null default '' check (char_length(last_name) <= 80),
  phone                    text check (phone is null or char_length(phone) <= 30),
  -- Preferencia actual. false hasta que la persona la acepte.
  marketing_opt_in         boolean not null default false,
  -- Cómo se manifestó la última preferencia (ver marketing_consent_events.method).
  marketing_consent_method text,
  marketing_updated_at     timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.customer_profiles is
  'Perfil de cada cliente registrado en la tienda. Cada cliente ve y edita solo el suyo.';
comment on column public.customer_profiles.marketing_consent_method is
  'signup_prechecked = dejó marcada la casilla que venía marcada; signup_checked = la marcó él; '
  'signup_unchecked = la desmarcó; account_opt_in / account_opt_out = cambio desde su cuenta.';

create table public.marketing_consent_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  opted_in     boolean not null,
  method       text not null check (method in (
                 'signup_prechecked', 'signup_checked', 'signup_unchecked',
                 'account_opt_in', 'account_opt_out')),
  consent_text text check (consent_text is null or char_length(consent_text) <= 300),
  created_at   timestamptz not null default now()
);

create index marketing_consent_events_user_idx
  on public.marketing_consent_events (user_id, created_at desc);

comment on table public.marketing_consent_events is
  'Historial de consentimientos de comunicaciones comerciales. Solo lo escriben los triggers.';

-- ---------------------------------------------------------------------
-- 2. Funciones (schema private, no expuesto por la API)
-- ---------------------------------------------------------------------

-- Texto de la casilla de la cuenta (el del registro llega desde el formulario).
create function private.marketing_label()
returns text
language sql
immutable
set search_path = ''
as $$ select 'Quiero recibir novedades, promociones y ofertas de Povmatero.'::text $$;

-- Recorta y limpia un texto del formulario. Nunca falla.
create function private.clean_text(value text, max_len int)
returns text
language sql
immutable
set search_path = ''
as $$ select nullif(left(btrim(coalesce(value, '')), max_len), '') $$;

-- Al registrarse: crea el perfil con los datos del formulario y deja
-- constancia de la preferencia de comunicaciones.
-- SECURITY DEFINER: lo dispara Supabase Auth, que no tiene permisos sobre
-- estas tablas. Está escrito para no fallar nunca (un error acá impediría
-- crear la cuenta).
create function private.handle_new_customer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  opted_in boolean := coalesce(meta ->> 'marketing_opt_in', '') = 'true';
  method   text := meta ->> 'marketing_method';
begin
  if method is null
     or method not in ('signup_prechecked', 'signup_checked', 'signup_unchecked')
     or (opted_in and method = 'signup_unchecked')
     or (not opted_in and method <> 'signup_unchecked') then
    method := case when opted_in then 'signup_checked' else 'signup_unchecked' end;
  end if;

  insert into public.customer_profiles
    (user_id, email, first_name, last_name, phone,
     marketing_opt_in, marketing_consent_method, marketing_updated_at)
  values
    (new.id,
     coalesce(new.email, ''),
     coalesce(private.clean_text(meta ->> 'first_name', 80), ''),
     coalesce(private.clean_text(meta ->> 'last_name', 80), ''),
     private.clean_text(meta ->> 'phone', 30),
     opted_in, method, now())
  on conflict (user_id) do nothing;

  insert into public.marketing_consent_events (user_id, opted_in, method, consent_text)
  values (new.id, opted_in, method,
          coalesce(private.clean_text(meta ->> 'marketing_text', 300), private.marketing_label()));

  return new;
end;
$$;

-- Si la persona cambia su email (y lo confirma), el perfil se actualiza.
create function private.sync_customer_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customer_profiles
     set email = coalesce(new.email, email)
   where user_id = new.id;
  return new;
end;
$$;

-- Cambio de preferencia desde la cuenta: fecha, método e historial.
-- SECURITY DEFINER: el cliente no tiene permiso para escribir el historial.
create function private.track_marketing_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.marketing_opt_in is distinct from old.marketing_opt_in then
    new.marketing_consent_method := case when new.marketing_opt_in
                                         then 'account_opt_in' else 'account_opt_out' end;
    new.marketing_updated_at := now();
    insert into public.marketing_consent_events (user_id, opted_in, method, consent_text)
    values (new.user_id, new.marketing_opt_in, new.marketing_consent_method,
            private.marketing_label());
  end if;
  return new;
end;
$$;

revoke all on function private.marketing_label()           from public, anon, authenticated;
revoke all on function private.clean_text(text, int)       from public, anon, authenticated;
revoke all on function private.handle_new_customer()       from public, anon, authenticated;
revoke all on function private.sync_customer_email()       from public, anon, authenticated;
revoke all on function private.track_marketing_change()    from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 3. Triggers
-- ---------------------------------------------------------------------
create trigger on_auth_user_created_customer_profile
  after insert on auth.users
  for each row execute function private.handle_new_customer();

create trigger on_auth_user_email_changed_customer_profile
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function private.sync_customer_email();

create trigger customer_profiles_marketing_change
  before update on public.customer_profiles
  for each row execute function private.track_marketing_change();

create trigger customer_profiles_updated_at
  before update on public.customer_profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------
-- 4. Permisos (Supabase da permisos amplios por defecto en public: se quitan)
-- ---------------------------------------------------------------------
revoke all on public.customer_profiles, public.marketing_consent_events
  from public, anon, authenticated;

grant select on public.customer_profiles to authenticated;
grant update (first_name, last_name, phone, marketing_opt_in)
  on public.customer_profiles to authenticated;

grant select on public.marketing_consent_events to authenticated;

-- ---------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------
alter table public.customer_profiles        enable row level security;
alter table public.marketing_consent_events enable row level security;

create policy "customer_profiles: cada cliente ve el suyo"
  on public.customer_profiles for select to authenticated
  using (user_id = (select auth.uid()));

create policy "customer_profiles: admins leen todos"
  on public.customer_profiles for select to authenticated
  using ((select private.is_admin()));

create policy "customer_profiles: cada cliente edita el suyo"
  on public.customer_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy "marketing_consent_events: cada cliente ve los suyos"
  on public.marketing_consent_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "marketing_consent_events: admins leen todos"
  on public.marketing_consent_events for select to authenticated
  using ((select private.is_admin()));

-- =====================================================================
-- Consultas útiles (SQL Editor):
--
--   -- Clientes que aceptaron recibir novedades
--   select email, first_name, last_name, marketing_consent_method, marketing_updated_at
--   from public.customer_profiles where marketing_opt_in order by marketing_updated_at;
--
--   -- Solo quienes la marcaron activamente (sin contar la casilla premarcada)
--   ... where marketing_opt_in and marketing_consent_method <> 'signup_prechecked';
-- =====================================================================
