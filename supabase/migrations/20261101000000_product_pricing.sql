-- =====================================================================
-- SKU, precio de venta y costo a nivel de PRODUCTO, con herencia en las variantes.
--
--   products.base_price            precio de venta general (público, como el precio)
--   product_internal.sku           SKU general del producto (único; solo admins)
--   product_internal.base_cost     costo general (solo admins)
--   product_variants.price_inherited / cost_inherited
--       true  = la variante usa el valor general
--       false = tiene un valor particular
--
-- La tienda NO cambia: sigue leyendo product_variants.price. El valor general se
-- copia a las variantes que lo heredan, dentro de la base (triggers), así nunca
-- quedan desincronizadas.
--
-- Compatibilidad con el panel anterior (producción, mientras no se publique el
-- nuevo): si alguien cambia el precio o el costo de una variante directamente,
-- la variante queda como "particular" (o "general" si coincide con el general).
-- Al insertar una variante se respeta el precio que se envía.
--
-- Reglas:
--   * Cambiar el general → se copia SOLO a las variantes que lo heredan.
--   * Borrar el general (null) → las variantes conservan sus valores.
--   * Volver una variante al general (flag a true) → toma el valor general.
--
-- Datos existentes (nada cambia de precio ni de costo):
--   * Si todas las variantes de un producto tienen el mismo precio (> 0), ese es
--     su precio general y todas lo heredan. Si no, no hay general y todas quedan
--     con precio particular.
--   * Costo: si todas tienen el mismo costo, ese es el general. Si ninguna tiene,
--     no hay general y todas heredarán el que se cargue. Si es mixto, las que
--     tienen costo quedan particulares y las que no, heredarán.
--   * variant_internal.sku queda sin uso (hoy no hay ningún SKU cargado).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Columnas
-- ---------------------------------------------------------------------
alter table public.products
  add column if not exists base_price numeric(12, 2)
    check (base_price is null or base_price > 0);

alter table public.product_internal
  add column if not exists sku text
    check (sku is null or (sku = btrim(sku) and sku <> '' and char_length(sku) <= 64)),
  add column if not exists base_cost numeric(12, 2)
    check (base_cost is null or base_cost >= 0);

create unique index if not exists product_internal_sku_key on public.product_internal (sku);

alter table public.product_variants
  add column if not exists price_inherited boolean not null default true,
  add column if not exists cost_inherited  boolean not null default true;

-- ---------------------------------------------------------------------
-- 2. Datos existentes (antes de crear los triggers)
-- ---------------------------------------------------------------------
-- Precio general: productos cuyas variantes tienen todas el mismo precio > 0.
with uniform as (
  select product_id, min(price) as price
  from public.product_variants
  group by product_id
  having count(distinct price) = 1 and min(price) > 0
)
update public.products p
   set base_price = u.price
  from uniform u
 where u.product_id = p.id
   and p.base_price is null;

-- Sin precio general: sus variantes quedan con precio particular.
update public.product_variants v
   set price_inherited = false
  from public.products p
 where p.id = v.product_id
   and p.base_price is null;

-- Costo general: productos cuyas variantes tienen todas el mismo costo.
with stats as (
  select v.product_id,
         count(*)              as variants,
         count(c.cost)         as with_cost,
         count(distinct c.cost) as distinct_costs,
         min(c.cost)           as cost
  from public.product_variants v
  left join public.variant_costs c on c.variant_id = v.id
  group by v.product_id
)
insert into public.product_internal (product_id, base_cost)
select product_id, cost
  from stats
 where with_cost = variants and distinct_costs = 1
on conflict (product_id) do update
  set base_cost = excluded.base_cost
  where public.product_internal.base_cost is null;

-- Costos mixtos: las variantes con costo propio quedan particulares.
update public.product_variants v
   set cost_inherited = false
 where exists (select 1 from public.variant_costs c where c.variant_id = v.id)
   and not exists (select 1 from public.product_internal pi
                    where pi.product_id = v.product_id and pi.base_cost is not null);

-- ---------------------------------------------------------------------
-- 3. Triggers
--    Todos corren con los permisos de quien edita (un admin, por RLS).
--    "povmatero.propagating" marca las copias del valor general, para que no
--    se interpreten como cambios a mano.
-- ---------------------------------------------------------------------
create or replace function private.is_propagating()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(current_setting('povmatero.propagating', true), '') = 'on';
$$;

-- 3.1 Precio general → variantes que lo heredan.
create or replace function private.propagate_base_price()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_price is not null and new.base_price is distinct from old.base_price then
    perform set_config('povmatero.propagating', 'on', true);
    update public.product_variants
       set price = new.base_price
     where product_id = new.id
       and price_inherited
       and price is distinct from new.base_price;
    perform set_config('povmatero.propagating', 'off', true);
  end if;
  return null;
end;
$$;

-- 3.2 Cambios en una variante: modo general/particular del precio.
create or replace function private.sync_variant_price_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_base numeric;
begin
  if private.is_propagating() then
    return new;
  end if;

  select base_price into v_base from public.products where id = new.product_id;

  if tg_op = 'INSERT' then
    -- Se respeta el precio enviado; hereda si coincide con el general.
    if v_base is not null then
      new.price_inherited := (new.price = v_base);
    end if;
    return new;
  end if;

  if new.price_inherited and not old.price_inherited
     and new.price is not distinct from old.price then
    -- Volver al precio general.
    if v_base is not null then
      new.price := v_base;
    end if;
  elsif new.price is distinct from old.price and v_base is not null then
    -- Precio cambiado a mano: particular, salvo que sea igual al general.
    new.price_inherited := (new.price = v_base);
  end if;
  return new;
end;
$$;

-- 3.3 Costo general → variantes que lo heredan.
create or replace function private.propagate_base_cost()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.base_cost is not null
     and (tg_op = 'INSERT' or new.base_cost is distinct from old.base_cost) then
    perform set_config('povmatero.propagating', 'on', true);
    insert into public.variant_costs (variant_id, cost)
    select v.id, new.base_cost
      from public.product_variants v
     where v.product_id = new.product_id
       and v.cost_inherited
    on conflict (variant_id) do update
      set cost = excluded.cost
      where public.variant_costs.cost is distinct from excluded.cost;
    perform set_config('povmatero.propagating', 'off', true);
  end if;
  return null;
end;
$$;

-- 3.4 Costo cargado a mano en una variante: particular (o general si coincide).
create or replace function private.sync_variant_cost_mode()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_product bigint;
  v_base    numeric;
begin
  if private.is_propagating() then
    return null;
  end if;

  select v.product_id, pi.base_cost
    into v_product, v_base
    from public.product_variants v
    left join public.product_internal pi on pi.product_id = v.product_id
   where v.id = new.variant_id;

  if v_base is not null then
    perform set_config('povmatero.propagating', 'on', true);
    update public.product_variants
       set cost_inherited = (new.cost = v_base)
     where id = new.variant_id
       and cost_inherited is distinct from (new.cost = v_base);
    perform set_config('povmatero.propagating', 'off', true);
  end if;
  return null;
end;
$$;

-- 3.5 Variante que vuelve al costo general, o variante nueva que lo hereda.
create or replace function private.apply_inherited_cost()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_base numeric;
begin
  if private.is_propagating() or not new.cost_inherited then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.cost_inherited then
    return null;
  end if;

  select base_cost into v_base from public.product_internal where product_id = new.product_id;
  if v_base is null then
    return null;
  end if;

  perform set_config('povmatero.propagating', 'on', true);
  insert into public.variant_costs (variant_id, cost)
  values (new.id, v_base)
  on conflict (variant_id) do update
    set cost = excluded.cost
    where public.variant_costs.cost is distinct from excluded.cost;
  perform set_config('povmatero.propagating', 'off', true);
  return null;
end;
$$;

revoke all on function private.is_propagating()          from public, anon, authenticated;
revoke all on function private.propagate_base_price()    from public, anon, authenticated;
revoke all on function private.sync_variant_price_mode() from public, anon, authenticated;
revoke all on function private.propagate_base_cost()     from public, anon, authenticated;
revoke all on function private.sync_variant_cost_mode()  from public, anon, authenticated;
revoke all on function private.apply_inherited_cost()    from public, anon, authenticated;
-- La usan los triggers de quien edita (authenticated).
grant execute on function private.is_propagating() to authenticated;

drop trigger if exists products_propagate_base_price on public.products;
create trigger products_propagate_base_price
  after update of base_price on public.products
  for each row execute function private.propagate_base_price();

drop trigger if exists product_variants_price_mode on public.product_variants;
create trigger product_variants_price_mode
  before insert or update of price, price_inherited on public.product_variants
  for each row execute function private.sync_variant_price_mode();

drop trigger if exists product_internal_propagate_base_cost on public.product_internal;
create trigger product_internal_propagate_base_cost
  after insert or update of base_cost on public.product_internal
  for each row execute function private.propagate_base_cost();

drop trigger if exists variant_costs_cost_mode on public.variant_costs;
create trigger variant_costs_cost_mode
  after insert or update of cost on public.variant_costs
  for each row execute function private.sync_variant_cost_mode();

drop trigger if exists product_variants_inherited_cost on public.product_variants;
create trigger product_variants_inherited_cost
  after insert or update of cost_inherited on public.product_variants
  for each row execute function private.apply_inherited_cost();

-- ---------------------------------------------------------------------
-- 4. Permisos de columna (el resto de las tablas ya tiene los suyos)
-- ---------------------------------------------------------------------
grant select (base_price) on public.products to authenticated;
grant insert (base_price), update (base_price) on public.products to authenticated;
grant select (price_inherited, cost_inherited) on public.product_variants to authenticated;
grant insert (price_inherited, cost_inherited),
      update (price_inherited, cost_inherited) on public.product_variants to authenticated;

commit;
