-- =====================================================================
-- Orden de las góndolas de /yerbas, administrado desde el panel.
--
-- Qué agrega:
--   * public.shelf_brands: una fila por marca de yerba (clave normalizada,
--     nombre como se muestra y posición de su góndola). La llena la base sola:
--     una marca nueva se agrega al final, sin mover las que ya tienen lugar.
--     «Otras marcas» no es una fila: siempre va al final.
--   * products.shelf_other: «Otras marcas». Marcada, la yerba se muestra en la
--     góndola «Otras marcas» aunque tenga marca (la marca real se conserva en
--     products.brand). Es del producto: todas sus presentaciones van juntas.
--   * products.shelf_position: lugar de la yerba dentro de su góndola. Al crear
--     una yerba, o al cambiarla de góndola (marca, «Otras marcas» o
--     categoría), la base la pone al final de la góndola de destino.
--   * Marcas sin duplicados: «canarias», «CANARIAS » o «Canárias» se guardan
--     como la marca ya registrada («Canarias»). Lo hace un trigger, así vale
--     también para el panel publicado hoy.
--   * Dos funciones para el panel (solo administradores), con control de
--     cambios simultáneos: reciben el orden nuevo y el orden que el panel tenía
--     a la vista; si mientras tanto otro administrador lo cambió (o apareció
--     una marca o una yerba nueva), rechazan con hint 'stale_order' y no
--     cambian nada.
--       public.admin_set_shelf_brand_order(brand_keys, expected_keys)
--       public.admin_set_shelf_product_order(group_key, product_ids, expected_ids)
--   * storefront_catalog suma al final shelf_other, shelf_position y
--     brand_position (las demás columnas no cambian en nombre, tipo ni orden).
--
-- Datos existentes: arrancan con el MISMO orden que muestra hoy /yerbas
-- (Canarias, Rei Verde, Sara, Armiño, el resto alfabético, «Otras marcas» al
-- final; dentro de cada góndola por products.sort_order y id). Ninguna yerba
-- arranca en «Otras marcas» por la casilla (shelf_other = false para todas).
-- Si una marca está escrita de dos formas, se unifica con la más usada (la
-- consulta previa lo muestra antes de aplicar).
--
-- No toca precios, costos, stock, imágenes, presentaciones ni pedidos.
--
-- Se ejecuta UNA vez: si ya existe la tabla o alguna columna nueva, falla al
-- empezar y no cambia nada. Verificar antes y después con
-- supabase/checks/20261113_orden_gondolas.sql.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Clave de una marca: minúsculas, sin tildes, solo letras y números.
--    «Rei Verde», «rei  verde», «REI-VERDE» → «reiverde».
--    Pública e inmutable (la usa la vista; no lee ninguna tabla).
-- ---------------------------------------------------------------------
create function public.shelf_brand_key(brand text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(
    regexp_replace(
      translate(lower(btrim(coalesce(brand, ''))),
                'áàâäãåéèêëíìîïóòôöõúùûüñç',
                'aaaaaaeeeeiiiiooooouuuunc'),
      '[^a-z0-9]+', '', 'g'),
    '')
$$;

-- Góndola de una yerba: '' = «Otras marcas»; si no, la clave de su marca.
create function private.shelf_group(brand text, shelf_other boolean)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when coalesce(shelf_other, false) or public.shelf_brand_key(brand) is null
              then '' else public.shelf_brand_key(brand) end
$$;

-- ---------------------------------------------------------------------
-- 2. Marcas y su orden
-- ---------------------------------------------------------------------
create table public.shelf_brands (
  key        text primary key check (key ~ '^[a-z0-9]+$'),
  name       text not null check (char_length(btrim(name)) between 1 and 60),
  position   integer not null check (position > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shelf_brands_position_key unique (position) deferrable initially deferred
);

comment on table public.shelf_brands is
  'Marcas de yerba y orden de sus góndolas en /yerbas. La llena un trigger de products; el orden lo cambia admin_set_shelf_brand_order. «Otras marcas» va siempre al final.';

-- Leer: cualquiera (la vista la usa). Escribir: solo por las funciones de abajo.
revoke all on public.shelf_brands from public, anon, authenticated;
grant select on public.shelf_brands to anon, authenticated;
alter table public.shelf_brands enable row level security;
create policy "shelf_brands: lectura pública"
  on public.shelf_brands for select to anon, authenticated
  using (true);

-- ---------------------------------------------------------------------
-- 3. Columnas nuevas de products
-- ---------------------------------------------------------------------
alter table public.products
  add column shelf_other    boolean not null default false,
  add column shelf_position integer not null default 0 check (shelf_position >= 0);

comment on column public.products.shelf_other is
  'Yerbas: true = se muestra en la góndola «Otras marcas» aunque tenga marca (la marca se conserva).';
comment on column public.products.shelf_position is
  'Lugar dentro de su góndola de /yerbas (menor = antes). Lo fija la base; se cambia con admin_set_shelf_product_order.';

grant select (shelf_other, shelf_position) on public.products to anon, authenticated;
grant insert (shelf_other), update (shelf_other) on public.products to authenticated;
-- shelf_position no se escribe directo: solo el trigger y la función de orden.

-- ---------------------------------------------------------------------
-- 4. Datos existentes
-- ---------------------------------------------------------------------
-- 4a. Espacios de más en las marcas («Rei  Verde » → «Rei Verde»).
update public.products
   set brand = regexp_replace(btrim(brand), '\s+', ' ', 'g')
 where brand is not null
   and brand <> regexp_replace(btrim(brand), '\s+', ' ', 'g');

-- 4b. Una marca sin letras ni números no se puede ordenar: se cancela todo.
do $$
begin
  if exists (select 1 from public.products where brand is not null and public.shelf_brand_key(brand) is null) then
    raise exception 'Hay marcas sin letras ni números (ver la consulta previa). No se aplicó nada.';
  end if;
end;
$$;

-- 4c. Marcas de las yerbas, con la escritura más usada de cada una.
with yerbas as (
  select p.id, p.brand, public.shelf_brand_key(p.brand) as key
    from public.products p
    join public.categories c on c.id = p.category_id and c.slug = 'yerbas'
   where p.brand is not null
),
spelling as (
  select key, brand, count(*) as n, min(id) as first_id
    from yerbas group by key, brand
),
canonical as (
  select distinct on (key) key, brand as name
    from spelling
   order by key, n desc, first_id
),
-- Orden de hoy: Canarias, Rei Verde, Sara, Armiño y el resto alfabético.
ranked as (
  select c.key, c.name,
         row_number() over (
           order by coalesce(array_position(array['canarias', 'reiverde', 'sara', 'armino'], c.key), 1000),
                    lower(c.name), c.key) as position
    from canonical c
)
insert into public.shelf_brands (key, name, position)
select key, name, position from ranked;

-- 4d. Las yerbas escritas distinto pasan a la escritura registrada.
update public.products p
   set brand = b.name
  from public.shelf_brands b
 where p.brand is not null
   and public.shelf_brand_key(p.brand) = b.key
   and p.brand <> b.name
   and p.category_id = (select c.id from public.categories c where c.slug = 'yerbas');

-- 4e. Lugar de cada producto en su góndola: el orden de hoy (sort_order, id).
update public.products p
   set shelf_position = r.position
  from (
    select id, row_number() over (
             partition by category_id, private.shelf_group(brand, shelf_other)
             order by sort_order, id) as position
      from public.products
  ) r
 where r.id = p.id;

-- ---------------------------------------------------------------------
-- 5. Trigger: marca registrada y lugar al final de la góndola
-- ---------------------------------------------------------------------
create function private.products_shelf()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_yerbas  boolean;
  v_key     text;
  v_name    text;
  v_group   text;
  v_move    boolean;
begin
  v_yerbas := exists (select 1 from public.categories c where c.id = new.category_id and c.slug = 'yerbas');

  -- Marca: sin espacios de más; vacía = sin marca.
  if new.brand is not null then
    new.brand := regexp_replace(btrim(new.brand), '\s+', ' ', 'g');
    if new.brand = '' then new.brand := null; end if;
  end if;

  if new.brand is not null then
    v_key := public.shelf_brand_key(new.brand);
    if v_key is null then
      raise exception 'La marca tiene que tener letras o números.'
        using errcode = 'check_violation', hint = 'invalid_brand';
    end if;
    select b.name into v_name from public.shelf_brands b where b.key = v_key;
    if v_name is not null then
      new.brand := v_name;                          -- la escritura ya registrada
    elsif v_yerbas then
      -- Marca nueva de yerba: al final del orden de góndolas.
      perform pg_advisory_xact_lock(hashtext('povmatero.shelf_brands'));
      insert into public.shelf_brands (key, name, position)
      select v_key, new.brand, coalesce(max(b.position), 0) + 1 from public.shelf_brands b
      on conflict (key) do nothing;
      select b.name into v_name from public.shelf_brands b where b.key = v_key;
      new.brand := coalesce(v_name, new.brand);
    end if;
  end if;

  -- Lugar en la góndola: al crear, o al cambiar de góndola, va al final.
  v_group := private.shelf_group(new.brand, new.shelf_other);
  if tg_op = 'INSERT' then
    v_move := true;
  else
    v_move := new.category_id is distinct from old.category_id
           or v_group is distinct from private.shelf_group(old.brand, old.shelf_other);
  end if;

  if v_move then
    perform pg_advisory_xact_lock(hashtext('povmatero.shelf:' || new.category_id || ':' || v_group));
    select coalesce(max(p.shelf_position), 0) + 1 into new.shelf_position
      from public.products p
     where p.category_id = new.category_id
       and p.id is distinct from new.id
       and private.shelf_group(p.brand, p.shelf_other) = v_group;
  elsif tg_op = 'UPDATE' then
    new.shelf_position := old.shelf_position;
  end if;

  return new;
end;
$$;

create trigger products_shelf
  before insert or update of brand, shelf_other, category_id on public.products
  for each row execute function private.products_shelf();

-- ---------------------------------------------------------------------
-- 6. Orden de las góndolas (solo administradores)
--   brand_keys:    todas las claves de shelf_brands, en el orden nuevo
--   expected_keys: el orden que el panel tenía a la vista
-- ---------------------------------------------------------------------
create function public.admin_set_shelf_brand_order(brand_keys text[], expected_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new     text[] := admin_set_shelf_brand_order.brand_keys;
  v_current text[];
  v_changed integer;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden ordenar las góndolas.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;

  perform pg_advisory_xact_lock(hashtext('povmatero.shelf_brands'));
  perform 1 from public.shelf_brands for update;
  select coalesce(array_agg(b.key order by b.position, b.key), '{}') into v_current from public.shelf_brands b;

  if admin_set_shelf_brand_order.expected_keys is distinct from v_current then
    raise exception 'Otro administrador cambió las marcas mientras ordenabas. Recargá para ver el orden actual.'
      using errcode = 'check_violation', hint = 'stale_order';
  end if;
  if v_new is null
     or array_position(v_new, null) is not null
     or cardinality(v_new) <> cardinality(v_current)
     or (select count(distinct k) from unnest(v_new) k) <> cardinality(v_new)
     or not (v_new @> v_current and v_current @> v_new) then
    raise exception 'El orden enviado no coincide con las marcas registradas.'
      using errcode = 'check_violation', hint = 'invalid_order';
  end if;

  update public.shelf_brands b
     set position = o.n, updated_at = now()
    from unnest(v_new) with ordinality as o (key, n)
   where b.key = o.key and b.position <> o.n;
  get diagnostics v_changed = row_count;

  return jsonb_build_object('keys', to_jsonb(v_new), 'changed', v_changed);
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Orden de las yerbas dentro de una góndola (solo administradores)
--   group_key:    clave de la marca, o '' para «Otras marcas»
--   product_ids:  todas las yerbas de esa góndola (publicadas o no), en el orden nuevo
--   expected_ids: el orden que el panel tenía a la vista
-- ---------------------------------------------------------------------
create function public.admin_set_shelf_product_order(group_key text, product_ids bigint[], expected_ids bigint[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_group   text := coalesce(admin_set_shelf_product_order.group_key, '');
  v_new     bigint[] := admin_set_shelf_product_order.product_ids;
  v_cat     bigint;
  v_current bigint[];
  v_changed integer;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden ordenar las góndolas.'
      using errcode = 'insufficient_privilege', hint = 'admin_only';
  end if;
  select c.id into v_cat from public.categories c where c.slug = 'yerbas';
  if v_cat is null then
    raise exception 'No existe la categoría «Yerbas».' using errcode = 'check_violation', hint = 'invalid_order';
  end if;

  perform pg_advisory_xact_lock(hashtext('povmatero.shelf:' || v_cat || ':' || v_group));
  perform 1 from public.products p
    where p.category_id = v_cat and private.shelf_group(p.brand, p.shelf_other) = v_group
    order by p.id for update;
  select coalesce(array_agg(p.id order by p.shelf_position, p.id), '{}') into v_current
    from public.products p
   where p.category_id = v_cat and private.shelf_group(p.brand, p.shelf_other) = v_group;

  if admin_set_shelf_product_order.expected_ids is distinct from v_current then
    raise exception 'Otro administrador cambió esta góndola mientras ordenabas. Recargá para ver el orden actual.'
      using errcode = 'check_violation', hint = 'stale_order';
  end if;
  if v_new is null
     or array_position(v_new, null) is not null
     or cardinality(v_new) <> cardinality(v_current)
     or (select count(distinct k) from unnest(v_new) k) <> cardinality(v_new)
     or not (v_new @> v_current and v_current @> v_new) then
    raise exception 'El orden enviado no coincide con las yerbas de esta góndola.'
      using errcode = 'check_violation', hint = 'invalid_order';
  end if;

  update public.products p
     set shelf_position = o.n
    from unnest(v_new) with ordinality as o (id, n)
   where p.id = o.id and p.shelf_position <> o.n;
  get diagnostics v_changed = row_count;

  return jsonb_build_object('group_key', v_group, 'ids', to_jsonb(v_new), 'changed', v_changed);
end;
$$;

revoke all on function public.shelf_brand_key(text)                                   from public, anon, authenticated;
revoke all on function private.shelf_group(text, boolean)                             from public, anon, authenticated;
revoke all on function private.products_shelf()                                       from public, anon, authenticated;
revoke all on function public.admin_set_shelf_brand_order(text[], text[])             from public, anon, authenticated;
revoke all on function public.admin_set_shelf_product_order(text, bigint[], bigint[]) from public, anon, authenticated;
grant execute on function public.shelf_brand_key(text)                                   to anon, authenticated;
grant execute on function public.admin_set_shelf_brand_order(text[], text[])             to authenticated;
grant execute on function public.admin_set_shelf_product_order(text, bigint[], bigint[]) to authenticated;

-- ---------------------------------------------------------------------
-- 8. Vista de la tienda: misma que en 20261107000000_variant_shelf_images.sql
--    + shelf_other, shelf_position y brand_position al final.
-- ---------------------------------------------------------------------
create or replace view public.storefront_catalog
with (security_invoker = true)
as
select
  p.id          as product_id,
  p.slug        as product_slug,
  p.name        as product_name,
  p.description,
  c.slug        as category_slug,
  c.name        as category_name,
  cover.src     as cover_image,
  v.id          as variant_id,
  v.name        as variant_name,
  v.price,
  v.track_stock,
  case when v.track_stock then greatest(v.stock - coalesce(cm.quantity, 0), 0)::integer end as stock,
  vimg.src      as variant_image,
  p.sort_order  as product_sort,
  v.sort_order  as variant_sort,
  p.brand       as brand,
  p.shelf_image as shelf_image,
  v.shelf_image as variant_shelf_image,
  p.shelf_other    as shelf_other,
  p.shelf_position as shelf_position,
  sb.position      as brand_position
from public.products p
join public.categories c        on c.id = p.category_id
join public.product_variants v  on v.product_id = p.id
left join public.variant_commitments() cm on cm.variant_id = v.id
left join public.shelf_brands sb on sb.key = public.shelf_brand_key(p.brand)
left join lateral (
  select i.src from public.product_images i
  where i.product_id = p.id and i.is_cover
  limit 1
) cover on true
left join lateral (
  select i.src from public.product_images i
  where i.variant_id = v.id
  order by i.sort_order, i.id
  limit 1
) vimg on true
where p.is_active and v.is_active and c.is_active;

commit;
