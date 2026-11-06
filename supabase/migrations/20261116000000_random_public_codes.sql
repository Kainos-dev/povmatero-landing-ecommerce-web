-- Additive successor to 20261114/15. Internal keys and historical deadlines stay intact.
begin;
lock table public.orders in access exclusive mode;
alter table public.orders add column legacy_public_code text;
create table private.public_order_codes (code text primary key);
alter table private.public_order_codes enable row level security;
revoke all on private.public_order_codes from public, anon, authenticated;

-- Reserve atomically in a unique index, including against concurrent transactions.
-- Independent cryptographic UUID randomness; never derived from the order id.
create function private.random_public_order_code() returns text
language sql volatile set search_path = '' as $$
  select 'PV-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;
revoke all on function private.random_public_order_code() from public, anon, authenticated;
create function private.reserve_public_order_code() returns text
language plpgsql security definer set search_path = '' as $$
declare c text; n integer;
begin
  for n in 1..32 loop
    c := private.random_public_order_code();
    insert into private.public_order_codes values (c) on conflict do nothing;
    if found then return c; end if;
  end loop;
  raise exception 'No se pudo asignar el código del pedido. Reintentá.' using errcode = '40001';
end;
$$;
revoke all on function private.reserve_public_order_code() from public, anon, authenticated;

drop trigger orders_public_code on public.orders;
alter table public.orders drop constraint orders_public_code_format;
alter table public.orders drop constraint orders_public_code_required;
update public.orders set legacy_public_code = public_code,
  public_code = private.reserve_public_order_code();
alter table public.orders alter column public_code set not null;
alter table public.orders add constraint orders_public_code_format check (public_code ~ '^PV-[A-F0-9]{10}$');
alter table public.orders add constraint orders_public_code_unique unique (public_code);
-- Pending/historical push payloads retain their internal destination, with the new label.
update private.push_events e set payload = jsonb_set(e.payload, '{body}',
  to_jsonb(replace(e.payload->>'body', o.legacy_public_code, o.public_code)))
from public.orders o where e.event_key = 'order:' || o.id
  and o.legacy_public_code is not null and e.payload->>'body' is not null;
comment on column public.orders.public_code is 'Código público aleatorio, único global y fijo. No contiene el ID interno.';
comment on column public.orders.legacy_public_code is 'Referencia anterior, solo para conciliación histórica por cliente; no es única global.';

create or replace function private.assign_order_code() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.public_code is distinct from old.public_code
       or new.legacy_public_code is distinct from old.legacy_public_code
       or new.customer_seq is distinct from old.customer_seq then
      raise exception 'El código de un pedido no se puede cambiar.' using errcode = '23514', hint = 'code_immutable';
    end if;
  else
    new.public_code := private.reserve_public_order_code();
    new.customer_seq := null;
    new.legacy_public_code := null;
  end if;
  return new;
end;
$$;
create trigger orders_public_code before insert or update on public.orders
for each row execute function private.assign_order_code();
-- Keep legacy counters/columns for audit and compatibility, but never increment them.
-- Include the code in the general-store checkout RPC without a second network query.
alter function public.create_order(jsonb) rename to create_order_before_public_code;
revoke all on function public.create_order_before_public_code(jsonb) from public,anon,authenticated;
create function public.create_order(items jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  result := public.create_order_before_public_code(items);
  return result || jsonb_build_object('public_code',
    (select o.public_code from public.orders o where o.id=(result->>'id')::bigint));
end;
$$;
revoke all on function public.create_order(jsonb) from public,anon,authenticated;
grant execute on function public.create_order(jsonb) to authenticated;
commit;
