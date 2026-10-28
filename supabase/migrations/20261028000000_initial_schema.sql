-- =====================================================================
-- Povmatero — Migración inicial
-- Catálogo (categorías, productos, variantes, imágenes), datos internos,
-- costos, movimientos de inventario y administradores, con RLS.
--
-- Principios:
--   * Visitantes (anon) y usuarios logueados (authenticated) solo pueden LEER
--     las columnas públicas de productos/variantes/imágenes activos.
--   * SKU, IDs de migración y costos viven en tablas internas solo para admins
--     (anon y authenticated comparten rol en Postgres, así que un permiso por
--     columna no alcanza para distinguir a un admin de un usuario común).
--   * Solo los usuarios listados en public.admin_users pueden escribir.
--   * admin_users NO se puede modificar desde la API: solo desde el SQL
--     Editor de Supabase (rol postgres) o con la service_role key.
--   * El stock solo cambia registrando un movimiento en inventory_movements.
--   * Nunca se usa user_metadata del JWT para autorizar (el usuario lo edita).
--
-- Supabase ejecuta el archivo completo como una única transacción.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. Schema privado (NO expuesto por la API) para funciones internas
-- ---------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
-- authenticated necesita USAGE para evaluar private.is_admin() en las políticas.
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------------
-- 1. Administradores
-- ---------------------------------------------------------------------
create table public.admin_users (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  role       text not null default 'admin' check (role in ('owner', 'admin')),
  created_at timestamptz not null default now()
);

comment on table public.admin_users is
  'Usuarios con acceso al panel. Solo se modifica desde el SQL Editor o con service_role.';

-- ¿El usuario que hace la consulta es admin?
-- SECURITY DEFINER: lee admin_users sin depender de sus políticas RLS.
create function private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admin_users a
    where a.user_id = (select auth.uid())
  );
$$;

-- updated_at automático (función de trigger)
create function private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 2. Catálogo (tablas públicas: sin datos internos)
-- ---------------------------------------------------------------------
create table public.categories (
  id         bigint generated always as identity primary key,
  slug       text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name       text not null,
  sort_order integer not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.products (
  id          bigint generated always as identity primary key,
  category_id bigint not null references public.categories (id) on delete restrict,
  slug        text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name        text not null,
  description text not null default '',
  is_active   boolean not null default false,  -- se publica explícitamente
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index products_category_id_idx on public.products (category_id);

-- Todo producto tiene al menos una variante. Los que hoy no tienen variantes
-- se cargan con una única variante (ej. "Único").
create table public.product_variants (
  id          bigint generated always as identity primary key,
  product_id  bigint not null references public.products (id) on delete cascade,
  name        text not null,                      -- "500gr", "Chica", "Negro"...
  price       numeric(12, 2) not null check (price >= 0),
  stock       integer not null default 0 check (stock >= 0),
  track_stock boolean not null default true,      -- false = se vende sin controlar stock
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (product_id, name),
  unique (id, product_id)                         -- para la FK compuesta de imágenes
);

create index product_variants_product_id_idx on public.product_variants (product_id);

create table public.product_images (
  id         bigint generated always as identity primary key,
  product_id bigint not null references public.products (id) on delete cascade,
  variant_id bigint,
  src        text not null,   -- ruta actual ("images/2300/a.webp") o ruta en Storage
  alt        text not null default '',
  is_cover   boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  -- la variante debe pertenecer al mismo producto
  foreign key (variant_id, product_id)
    references public.product_variants (id, product_id) on delete cascade
);

create index product_images_product_id_idx on public.product_images (product_id);
create index product_images_variant_id_idx on public.product_images (variant_id);
create unique index product_images_one_cover_idx
  on public.product_images (product_id) where is_cover;

-- ---------------------------------------------------------------------
-- 3. Datos internos (solo admins)
-- ---------------------------------------------------------------------
-- Vínculo con js/products.js durante la transición.
create table public.product_internal (
  product_id bigint primary key references public.products (id) on delete cascade,
  legacy_id  integer unique
);

-- SKU y vínculo con la columna ID de Google Sheets.
create table public.variant_internal (
  variant_id      bigint primary key references public.product_variants (id) on delete cascade,
  sku             text unique,
  legacy_sheet_id integer unique
);

-- Costo actual por variante.
create table public.variant_costs (
  variant_id bigint primary key references public.product_variants (id) on delete cascade,
  cost       numeric(12, 2) not null check (cost >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

-- Registra quién y cuándo modificó el costo (no lo elige el cliente).
create function private.set_cost_audit()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 4. Movimientos de inventario (registro inmutable)
-- ---------------------------------------------------------------------
create type public.inventory_movement_type as enum ('entrada', 'salida', 'ajuste');

create table public.inventory_movements (
  id            bigint generated always as identity primary key,
  variant_id    bigint not null references public.product_variants (id) on delete restrict,
  movement_type public.inventory_movement_type not null,
  quantity      integer not null,           -- variación con signo: +5 entra, -2 sale
  stock_after   integer,                    -- stock resultante (lo completa el trigger)
  unit_cost     numeric(12, 2) check (unit_cost >= 0),
  reason        text not null default '',
  reference     text,                       -- ej. n° de factura o, más adelante, de pedido
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,  -- null = carga inicial/sistema o usuario eliminado
  created_at    timestamptz not null default now(),
  check (
       (movement_type = 'entrada' and quantity > 0)
    or (movement_type = 'salida'  and quantity < 0)
    or (movement_type = 'ajuste'  and quantity <> 0)
  )
);

create index inventory_movements_variant_id_idx
  on public.inventory_movements (variant_id, created_at desc);

-- Impide cambiar product_variants.stock por fuera de un movimiento.
-- Segunda barrera: authenticated ya no tiene permiso de columna sobre stock,
-- y esto también frena cambios manuales desde el SQL Editor.
create function private.guard_variant_stock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('povmatero.allow_stock_write', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' and new.stock <> 0 then
    raise exception 'El stock inicial debe ser 0. Registrá una entrada en inventory_movements.'
      using errcode = 'check_violation';
  end if;

  if tg_op = 'UPDATE' and new.stock is distinct from old.stock then
    raise exception 'El stock solo se modifica registrando un movimiento de inventario.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

-- Aplica el movimiento sobre el stock de la variante, de forma atómica.
-- SECURITY DEFINER: es el único camino con permiso para escribir "stock".
-- Si el resultado fuera negativo, el CHECK (stock >= 0) cancela todo.
create function private.apply_inventory_movement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_stock integer;
begin
  -- Peticiones por la API (anon/authenticated): solo admins.
  -- (La política RLS de INSERT lo vuelve a exigir; esto evita depender del orden.)
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated')
     and not private.is_admin() then
    raise exception 'Solo los administradores pueden registrar movimientos de inventario.'
      using errcode = 'insufficient_privilege';
  end if;

  -- El cliente nunca define el resultado ni el autor.
  new.stock_after := null;
  if (auth.jwt() ->> 'role') in ('anon', 'authenticated') then
    new.created_by := (select auth.uid());
  end if;

  perform set_config('povmatero.allow_stock_write', 'on', true);

  update public.product_variants
     set stock = stock + new.quantity
   where id = new.variant_id
  returning stock into v_stock;

  perform set_config('povmatero.allow_stock_write', 'off', true);

  if v_stock is null then
    raise exception 'La variante % no existe.', new.variant_id;
  end if;

  new.stock_after := v_stock;
  return new;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. Permisos EXECUTE de funciones privadas
--    Los triggers no requieren EXECUTE del usuario al dispararse, así que
--    sus funciones quedan sin permisos para nadie. Solo is_admin() se usa
--    dentro de políticas y la necesita authenticated.
-- ---------------------------------------------------------------------
revoke all on function private.is_admin()                 from public, anon, authenticated;
revoke all on function private.set_updated_at()           from public, anon, authenticated;
revoke all on function private.set_cost_audit()           from public, anon, authenticated;
revoke all on function private.guard_variant_stock()      from public, anon, authenticated;
revoke all on function private.apply_inventory_movement() from public, anon, authenticated;

grant execute on function private.is_admin() to authenticated;

-- ---------------------------------------------------------------------
-- 6. Triggers
-- ---------------------------------------------------------------------
create trigger categories_updated_at before update on public.categories
  for each row execute function private.set_updated_at();
create trigger products_updated_at before update on public.products
  for each row execute function private.set_updated_at();
create trigger product_variants_updated_at before update on public.product_variants
  for each row execute function private.set_updated_at();
create trigger variant_costs_audit before insert or update on public.variant_costs
  for each row execute function private.set_cost_audit();

create trigger product_variants_guard_stock
  before insert or update on public.product_variants
  for each row execute function private.guard_variant_stock();

create trigger inventory_movements_apply
  before insert on public.inventory_movements
  for each row execute function private.apply_inventory_movement();

-- ---------------------------------------------------------------------
-- 7. Permisos de tabla y columna (explícitos, sin depender de defaults)
-- ---------------------------------------------------------------------
revoke all on public.admin_users, public.categories, public.products,
              public.product_variants, public.product_images,
              public.product_internal, public.variant_internal,
              public.variant_costs, public.inventory_movements
  from public, anon, authenticated;

-- Lectura: solo las columnas que usa la tienda (y las que usan las políticas).
-- Nota: con permisos por columna, la API rechaza "select=*" sobre estas tablas;
-- hay que pedir columnas explícitas o usar la vista storefront_catalog.
grant select (id, slug, name, sort_order, is_active)
  on public.categories to anon, authenticated;
grant select (id, category_id, slug, name, description, is_active, sort_order)
  on public.products to anon, authenticated;
grant select (id, product_id, name, price, stock, track_stock, is_active, sort_order)
  on public.product_variants to anon, authenticated;
grant select (id, product_id, variant_id, src, alt, is_cover, sort_order)
  on public.product_images to anon, authenticated;

-- Escritura del catálogo: authenticated (RLS exige admin). Nunca la columna stock.
grant insert (slug, name, sort_order, is_active),
      update (slug, name, sort_order, is_active)
  on public.categories to authenticated;
grant insert (category_id, slug, name, description, is_active, sort_order),
      update (category_id, slug, name, description, is_active, sort_order)
  on public.products to authenticated;
grant insert (product_id, name, price, track_stock, is_active, sort_order),
      update (name, price, track_stock, is_active, sort_order)
  on public.product_variants to authenticated;
grant insert (product_id, variant_id, src, alt, is_cover, sort_order),
      update (variant_id, src, alt, is_cover, sort_order)
  on public.product_images to authenticated;
grant delete on public.categories, public.products,
                public.product_variants, public.product_images
  to authenticated;

-- Datos internos y costos: solo authenticated (RLS exige admin). anon: nada.
grant select, insert, update, delete on public.product_internal to authenticated;
grant select, insert, update, delete on public.variant_internal to authenticated;
grant select on public.variant_costs to authenticated;
grant insert (variant_id, cost), update (cost) on public.variant_costs to authenticated;
grant delete on public.variant_costs to authenticated;

-- Movimientos: leer e insertar. Nunca editar ni borrar (registro inmutable).
-- stock_after y created_by los completa el trigger.
grant select on public.inventory_movements to authenticated;
grant insert (variant_id, movement_type, quantity, unit_cost, reason, reference)
  on public.inventory_movements to authenticated;

-- admin_users: solo lectura de la propia fila (RLS). Sin insert/update/delete.
grant select (user_id, role) on public.admin_users to authenticated;

-- ---------------------------------------------------------------------
-- 8. Row Level Security
-- ---------------------------------------------------------------------
alter table public.admin_users         enable row level security;
alter table public.categories          enable row level security;
alter table public.products            enable row level security;
alter table public.product_variants    enable row level security;
alter table public.product_images      enable row level security;
alter table public.product_internal    enable row level security;
alter table public.variant_internal    enable row level security;
alter table public.variant_costs       enable row level security;
alter table public.inventory_movements enable row level security;

-- admin_users: cada usuario ve solo su propia fila (para saber si es admin).
-- Sin políticas de escritura => nadie puede darse permisos desde la API.
create policy "admin_users: ver la propia fila"
  on public.admin_users for select to authenticated
  using (user_id = (select auth.uid()));

-- categories
create policy "categories: lectura pública de activas"
  on public.categories for select to anon, authenticated
  using (is_active);
create policy "categories: admins leen todo"
  on public.categories for select to authenticated
  using ((select private.is_admin()));
create policy "categories: admins insertan"
  on public.categories for insert to authenticated
  with check ((select private.is_admin()));
create policy "categories: admins actualizan"
  on public.categories for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "categories: admins borran"
  on public.categories for delete to authenticated
  using ((select private.is_admin()));

-- products: activos y de categoría activa
create policy "products: lectura pública de activos"
  on public.products for select to anon, authenticated
  using (
    products.is_active
    and exists (select 1 from public.categories c
                where c.id = products.category_id and c.is_active)
  );
create policy "products: admins leen todo"
  on public.products for select to authenticated
  using ((select private.is_admin()));
create policy "products: admins insertan"
  on public.products for insert to authenticated
  with check ((select private.is_admin()));
create policy "products: admins actualizan"
  on public.products for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "products: admins borran"
  on public.products for delete to authenticated
  using ((select private.is_admin()));

-- product_variants: activas, de producto activo y categoría activa
create policy "variants: lectura pública de activas"
  on public.product_variants for select to anon, authenticated
  using (
    product_variants.is_active
    and exists (select 1
                from public.products p
                join public.categories c on c.id = p.category_id
                where p.id = product_variants.product_id
                  and p.is_active and c.is_active)
  );
create policy "variants: admins leen todo"
  on public.product_variants for select to authenticated
  using ((select private.is_admin()));
create policy "variants: admins insertan"
  on public.product_variants for insert to authenticated
  with check ((select private.is_admin()));
create policy "variants: admins actualizan"
  on public.product_variants for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "variants: admins borran"
  on public.product_variants for delete to authenticated
  using ((select private.is_admin()));

-- product_images: de producto activo y, si es de una variante, variante activa
create policy "images: lectura pública de activas"
  on public.product_images for select to anon, authenticated
  using (
    exists (select 1
            from public.products p
            join public.categories c on c.id = p.category_id
            where p.id = product_images.product_id
              and p.is_active and c.is_active)
    and (
      product_images.variant_id is null
      or exists (select 1 from public.product_variants v
                 where v.id = product_images.variant_id and v.is_active)
    )
  );
create policy "images: admins leen todo"
  on public.product_images for select to authenticated
  using ((select private.is_admin()));
create policy "images: admins insertan"
  on public.product_images for insert to authenticated
  with check ((select private.is_admin()));
create policy "images: admins actualizan"
  on public.product_images for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "images: admins borran"
  on public.product_images for delete to authenticated
  using ((select private.is_admin()));

-- Tablas internas y costos: todo solo admins
create policy "product_internal: solo admins"
  on public.product_internal for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "variant_internal: solo admins"
  on public.variant_internal for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy "costs: solo admins"
  on public.variant_costs for all to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- inventory_movements: admins leen e insertan a su nombre. Sin update/delete.
create policy "movements: admins leen"
  on public.inventory_movements for select to authenticated
  using ((select private.is_admin()));
create policy "movements: admins insertan a su nombre"
  on public.inventory_movements for insert to authenticated
  with check ((select private.is_admin()) and created_by = (select auth.uid()));

-- ---------------------------------------------------------------------
-- 9. Vista para la tienda pública
--    security_invoker: respeta los permisos de columna y la RLS de las tablas
--    (solo filas activas). Solo usa columnas públicas: sin costos, SKU ni IDs
--    de migración.
-- ---------------------------------------------------------------------
create view public.storefront_catalog
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
  case when v.track_stock then v.stock end as stock,
  vimg.src      as variant_image,
  p.sort_order  as product_sort,
  v.sort_order  as variant_sort
from public.products p
join public.categories c        on c.id = p.category_id
join public.product_variants v  on v.product_id = p.id
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

revoke all on public.storefront_catalog from public, anon, authenticated;
grant select on public.storefront_catalog to anon, authenticated;

-- ---------------------------------------------------------------------
-- 10. Storage: bucket de imágenes (lectura pública por URL, escritura admins)
--     Sin política SELECT: nadie puede listar el contenido del bucket.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('product-images', 'product-images', true, 5242880,
        array['image/webp', 'image/jpeg', 'image/png', 'image/avif'])
on conflict (id) do nothing;

create policy "product-images: admins suben"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'product-images' and (select private.is_admin()));
create policy "product-images: admins actualizan"
  on storage.objects for update to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()))
  with check (bucket_id = 'product-images' and (select private.is_admin()));
create policy "product-images: admins borran"
  on storage.objects for delete to authenticated
  using (bucket_id = 'product-images' and (select private.is_admin()));

-- ---------------------------------------------------------------------
-- 11. Datos iniciales: las mismas categorías que los filtros actuales
-- ---------------------------------------------------------------------
insert into public.categories (slug, name, sort_order) values
  ('mates',     'Mates',     1),
  ('yerberos',  'Yerberos',  2),
  ('bombillas', 'Bombillas', 3),
  ('termeras',  'Termeras',  4),
  ('yerbas',    'Yerbas',    5)
on conflict (slug) do nothing;

-- =====================================================================
-- Alta del primer administrador (NO se ejecuta con esta migración).
-- 1) Crear el usuario en Supabase → Authentication → Users.
-- 2) Copiar su UUID y ejecutar en el SQL Editor:
--
--   insert into public.admin_users (user_id, role)
--   values ('00000000-0000-0000-0000-000000000000', 'owner');
--
-- Pruebas sugeridas después de ejecutar (en un proyecto de prueba):
--   * Con la anon key: select=* sobre product_variants debe fallar;
--     select=id,name,price debe funcionar; variant_costs, variant_internal
--     e inventory_movements deben devolver error de permisos.
--   * Con un usuario logueado NO admin: insertar en admin_users, actualizar
--     product_variants.stock o insertar en inventory_movements debe fallar.
--   * Con un admin: insertar un movimiento 'entrada' debe sumar stock;
--     una 'salida' mayor al stock debe fallar sin cambiar nada.
-- =====================================================================
