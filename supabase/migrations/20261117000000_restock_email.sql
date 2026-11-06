-- Polling worker, independent of inventory transactions. OFF until server configuration.
begin;
alter table public.restock_requests
  add column email_consent_at timestamptz,
  add column unsubscribe_token uuid not null default gen_random_uuid();
create unique index restock_unsubscribe_token on public.restock_requests(unsubscribe_token);
-- Existing requests intentionally remain without email consent. Explicit renewal required.
alter function public.request_restock_alert(bigint) rename to request_restock_alert_before_email;
-- PL/pgSQL qualified parameter references must follow the renamed function.
do $$ begin
  execute replace(pg_get_functiondef('public.request_restock_alert_before_email(bigint)'::regprocedure),
    'request_restock_alert.variant_id', 'request_restock_alert_before_email.variant_id');
end $$;
revoke all on function public.request_restock_alert_before_email(bigint) from public, anon, authenticated;
create function public.request_restock_alert(variant_id bigint, email_consent boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  r := public.request_restock_alert_before_email(variant_id);
  -- Older clients may still register an alert, but never grant email consent.
  if request_restock_alert.email_consent is true then
    update public.restock_requests x set email_consent_at = coalesce(x.email_consent_at, now())
      where x.id = (r->>'id')::bigint and x.user_id = auth.uid() and x.status='activa';
  end if;
  return r;
end;
$$;
revoke all on function public.request_restock_alert(bigint,boolean) from public, anon, authenticated;
grant execute on function public.request_restock_alert(bigint,boolean) to authenticated;

-- A customer cancellation also wins over a concurrent provider acknowledgement.
-- Only the latest request for this account/presentation is affected.
create or replace function public.cancel_restock_alert(variant_id bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_user uuid := auth.uid(); v_n integer;
begin
  if v_user is null then
    raise exception 'Ingresá a tu cuenta.' using errcode='insufficient_privilege';
  end if;
  update public.restock_requests r set status='cancelada',cancelled_at=now(),notified_at=null,notified_by=null
    where r.id=(select x.id from public.restock_requests x
      where x.user_id=v_user and x.variant_id=cancel_restock_alert.variant_id order by x.id desc limit 1)
      and r.status in ('activa','avisada');
  get diagnostics v_n = row_count;
  return v_n>0;
end;
$$;

create table private.restock_email_jobs (
  request_id bigint primary key references public.restock_requests(id) on delete cascade,
  state text not null default 'pending' check(state in ('pending','sending','sent','failed')),
  attempts integer not null default 0,
  first_attempt_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  payload jsonb,
  provider_id text,
  last_error text,
  sent_at timestamptz
);
alter table private.restock_email_jobs enable row level security;
revoke all on private.restock_email_jobs from public, anon, authenticated;

-- Availability comes from commitments (including the exact expiration timestamp).
-- Covers manual receipts, cancelled orders and time alone releasing reservations.
create function private.restock_email_eligible(p_request bigint) returns boolean
language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.restock_requests r
 join public.product_variants v on v.id=r.variant_id and v.is_active and v.price>0
 join public.products p on p.id=v.product_id and p.is_active
 join public.categories c on c.id=p.category_id and c.is_active and c.slug='yerbas'
 join auth.users u on u.id=r.user_id
 where r.id=p_request and r.status='activa' and r.email_consent_at is not null
 and u.email = r.email and r.email <> ''
 and coalesce(private.variant_available(v.id),1)>0)
$$;

create function public.restock_email_claim(p_from text, p_limit integer default 5) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r record; result jsonb := '[]'; token uuid; data jsonb;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Solo el servidor puede procesar avisos por email.' using errcode='insufficient_privilege';
  end if;
  if coalesce(p_from,'') !~ '^[a-zA-Z0-9._+-]+@povmatero[.]com$' then
    raise exception 'Remitente inválido' using errcode='invalid_parameter_value';
  end if;
  insert into private.restock_email_jobs(request_id)
    select x.id from public.restock_requests x where private.restock_email_eligible(x.id)
    on conflict do nothing;
  -- Never retry beyond Resend's 24-hour idempotency retention. Ambiguous jobs need review.
  update private.restock_email_jobs set state='failed', lease_until=null, lease_token=null,
    last_error=case when first_attempt_at < now()-interval '20 hours' then 'retry_window_expired' else 'attempt_limit_exhausted' end
    where state in ('pending','sending') and (first_attempt_at < now()-interval '20 hours'
      or (attempts>=8 and (lease_until is null or lease_until<=now())));
  for r in select j.*, x.unsubscribe_token, x.email, p.name product_name, v.name variant_name
    from private.restock_email_jobs j join public.restock_requests x on x.id=j.request_id
    join public.product_variants v on v.id=x.variant_id join public.products p on p.id=v.product_id
    where j.state in ('pending','sending') and j.attempts<8 and j.next_attempt_at<=now()
      and (j.lease_until is null or j.lease_until<now())
      and private.restock_email_eligible(x.id)
    order by j.request_id limit greatest(1,least(p_limit,10)) for update of j skip locked
  loop
    token := gen_random_uuid();
    -- Freeze recipient, sender and content for identical provider retries.
    data := coalesce(r.payload, jsonb_build_object('from',p_from,'to',r.email,
      'subject','Volvió tu yerba · Povmatero',
      'text','Volvió ' || r.product_name || ' · ' || r.variant_name || E'\n\n'
        || E'Pedila en https://povmatero.com/yerbas\nLa disponibilidad puede cambiar; este aviso no reserva stock.\n\n'
        || 'Cancelar este aviso: https://povmatero.com/api/restock-unsubscribe?token=' || r.unsubscribe_token));
    update private.restock_email_jobs set state='sending', attempts=attempts+1,
      first_attempt_at=coalesce(first_attempt_at,now()), lease_until=now()+interval '5 minutes',
      lease_token=token,payload=data where request_id=r.request_id;
    result := result || jsonb_build_array(jsonb_build_object('id',r.request_id,'token',token,'payload',data));
  end loop;
  return result;
end;
$$;

-- Recheck cancellation and availability immediately before the network call.
create function public.restock_email_check(p_id bigint,p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
 if (auth.jwt() ->> 'role') is distinct from 'service_role' then
   raise exception 'Solo el servidor puede procesar avisos por email.' using errcode='insufficient_privilege';
 end if;
 return exists(select 1 from private.restock_email_jobs j where j.request_id=p_id
 and j.state='sending' and j.lease_token=p_token and j.lease_until>now()
 and j.first_attempt_at>=now()-interval '20 hours'
 and private.restock_email_eligible(p_id));
end;
$$;

create function public.restock_email_report(p_id bigint,p_token uuid,p_outcome text,p_provider_id text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare j private.restock_email_jobs;
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Solo el servidor puede procesar avisos por email.' using errcode='insufficient_privilege';
  end if;
  if p_outcome is null or p_outcome not in ('sent','retry','failed') then
    raise exception 'Resultado de envío inválido' using errcode='invalid_parameter_value';
  end if;
  select * into j from private.restock_email_jobs where request_id=p_id and state='sending'
    and lease_token=p_token and lease_until>now()
    and first_attempt_at>=now()-interval '20 hours' for update;
  if not found then return false; end if;
  update private.restock_email_jobs set
    state=case when p_outcome='sent' then 'sent' when p_outcome='retry' and attempts<8 then 'pending' else 'failed' end,
    lease_until=null,lease_token=null,
    next_attempt_at=now()+make_interval(mins=>power(2,attempts)::integer),
    provider_id=left(p_provider_id,200),last_error=case when p_outcome='sent' then null else left(p_outcome,100) end,
    sent_at=case when p_outcome='sent' then now() end where request_id=p_id;
  if p_outcome='sent' then
    update public.restock_requests set status='avisada',notified_at=now()
      where id=p_id and status='activa';
  end if;
  return true;
end;
$$;

create function public.restock_email_unsubscribe(p_token uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if (auth.jwt() ->> 'role') is distinct from 'service_role' then
    raise exception 'Solo el servidor puede cancelar avisos por email.' using errcode='insufficient_privilege';
  end if;
  -- A cancellation also wins if provider acceptance was recorded immediately before it.
  update public.restock_requests set status='cancelada',cancelled_at=now(),notified_at=null,notified_by=null
    where unsubscribe_token=p_token and status in ('activa','avisada');
  return true; -- no account enumeration
end;
$$;
revoke all on function private.restock_email_eligible(bigint) from public,anon,authenticated;
revoke all on function public.restock_email_claim(text,integer) from public,anon,authenticated;
revoke all on function public.restock_email_check(bigint,uuid) from public,anon,authenticated;
revoke all on function public.restock_email_report(bigint,uuid,text,text) from public,anon,authenticated;
revoke all on function public.restock_email_unsubscribe(uuid) from public,anon,authenticated;
grant execute on function public.restock_email_claim(text,integer) to service_role;
grant execute on function public.restock_email_check(bigint,uuid) to service_role;
grant execute on function public.restock_email_report(bigint,uuid,text,text) to service_role;
grant execute on function public.restock_email_unsubscribe(uuid) to service_role;
-- Automatic delivery owns the status; remove the old manual sending operation.
revoke execute on function public.admin_mark_restock_notified(bigint[]) from authenticated;
commit;
