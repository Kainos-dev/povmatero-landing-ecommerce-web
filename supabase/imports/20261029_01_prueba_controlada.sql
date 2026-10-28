-- =====================================================================
-- Povmatero — Importación inicial · PRUEBA CONTROLADA
--
-- Importa SOLO:
--   1. Bombilla Uruguaya (js/products.js, id 6): 3 variantes + 4 imágenes del repo.
--   2. Canarias Tradicional (Google Sheet WEB, IDs 1 y 2): 2 variantes + 1 imagen del repo.
--
-- CÓMO USARLO (SQL Editor de Supabase, pegando el archivo completo):
--   1) Ejecutalo TAL CUAL. Con v_dry_run = true es una SIMULACIÓN: no escribe
--      nada y muestra el reporte de lo que haría.
--   2) Si el reporte es correcto, cambiá v_dry_run a false (línea marcada con ◀)
--      y ejecutalo de nuevo: escribe y muestra el reporte.
--   3) Ejecutalo otra vez con false: no debe crear nada (todo «ya existe»).
--
-- GARANTÍAS:
--   * Los productos se crean como BORRADOR (is_active = false).
--   * No toca stock: las variantes nacen con stock 0 (la base lo exige) y no
--     se registran movimientos. El stock de las yerbas se carga en otra etapa.
--   * No modifica registros existentes: solo crea lo que falta (ver "Estrategia").
--   * Todo el bloque DO es una única operación: si algo falla, no se guarda nada.
--   * Se ejecuta como postgres (dueño de las tablas), por eso no aplica RLS;
--     solo escribe en products, product_internal, product_variants,
--     variant_internal y product_images. No toca admin_users, costos ni stock.
--
-- ESTRATEGIA PARA NO DUPLICAR (si se ejecuta más de una vez):
--   * Producto de products.js → se busca por product_internal.legacy_id (= id de products.js).
--   * Producto de yerba       → la hoja no tiene ID de producto: se busca por sus
--                               variantes ya vinculadas (variant_internal.legacy_sheet_id).
--   * Si el producto YA existe: no se modifica, y no se le agregan variantes de
--     products.js ni imágenes (así no se reponen cosas que editaste o borraste en el panel).
--   * Variantes de yerba → se buscan por legacy_sheet_id (= columna ID de la hoja);
--     si falta alguna, se crea aunque el producto ya exista (sirve para sumar
--     más adelante las 8 presentaciones que hoy no tienen precio).
--   * Si un slug o un nombre de variante ya está usado por algo que NO vino de
--     esta importación, se cancela todo con un mensaje claro (nunca se adivina).
--
-- Datos copiados textualmente de las fuentes el 29/10/2026. No se completó
-- ningún dato faltante. Descripciones vacías, como en el origen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Datos de origen (tablas temporales: desaparecen al cerrar la sesión)
-- ---------------------------------------------------------------------
drop function if exists pg_temp.import_log(text, text, text, text);
drop table if exists pg_temp.src_products, pg_temp.src_variants, pg_temp.src_images, pg_temp.import_report;

create temp table src_products (
  slug          text primary key,
  name          text not null,
  category_slug text not null,
  description   text not null,
  sort_order    integer not null,  -- posición en su fuente
  legacy_id     integer            -- id en js/products.js (null para yerbas)
);

insert into pg_temp.src_products (slug, name, category_slug, description, sort_order, legacy_id) values
  ('bombilla-uruguaya',          'Bombilla Uruguaya',    'bombillas', '', 5, 6),
  ('yerba-canarias-tradicional', 'Canarias Tradicional', 'yerbas',    '', 0, null);

create temp table src_variants (
  product_slug text not null,
  name         text not null,
  price        numeric(12, 2) not null,
  track_stock  boolean not null,
  sort_order   integer not null,
  sheet_id     integer,            -- columna ID de la hoja (null para products.js)
  primary key (product_slug, name)
);

insert into pg_temp.src_variants (product_slug, name, price, track_stock, sort_order, sheet_id) values
  -- products.js id 6: las variantes no tienen precio propio, heredan 30720.
  ('bombilla-uruguaya',          'Chica',   30720, false, 0, null),
  ('bombilla-uruguaya',          'Mediana', 30720, false, 1, null),
  ('bombilla-uruguaya',          'Grande',  30720, false, 2, null),
  -- Hoja WEB: ID 1 "$5,600" y ID 2 "$11,600". Stock NO se importa acá.
  ('yerba-canarias-tradicional', '500gr',    5600, true,  0, 1),
  ('yerba-canarias-tradicional', '1kg',     11600, true,  1, 2);

create temp table src_images (
  product_slug text not null,
  variant_name text,               -- null = imagen de todo el producto
  src          text not null,      -- ruta relativa del repo (no se sube a Storage)
  is_cover     boolean not null,
  sort_order   integer not null,
  primary key (product_slug, src)
);

insert into pg_temp.src_images (product_slug, variant_name, src, is_cover, sort_order) values
  ('bombilla-uruguaya',          null,      'images/2300/medidas.webp',              true,  0),
  ('bombilla-uruguaya',          'Chica',   'images/2300/a.webp',                    false, 1),
  ('bombilla-uruguaya',          'Mediana', 'images/2300/b.webp',                    false, 2),
  ('bombilla-uruguaya',          'Grande',  'images/2300/c.webp',                    false, 3),
  -- Foto real (no la provisoria canarias-tradicional.png).
  ('yerba-canarias-tradicional', null,      'images/yerbas/canariasTradicional.png', true,  0);

-- ---------------------------------------------------------------------
-- 2. Reporte
-- ---------------------------------------------------------------------
create temp table import_report (
  orden   serial,
  entidad text,
  clave   text,
  accion  text,
  detalle text
);

create function pg_temp.import_log(p_entidad text, p_clave text, p_accion text, p_detalle text)
returns void
language sql
as $$
  insert into pg_temp.import_report (entidad, clave, accion, detalle)
  values (p_entidad, p_clave, p_accion, p_detalle);
$$;

-- ---------------------------------------------------------------------
-- 3. Importación (una sola operación)
-- ---------------------------------------------------------------------
do $$
declare
  v_dry_run   constant boolean := true;   -- ◀ true = SIMULACIÓN · false = ESCRIBE
  v_new       constant text := case when v_dry_run then 'se crearía' else 'creado' end;
  p           record;
  v           record;
  i           record;
  v_category  bigint;
  v_product   bigint;
  v_variant   bigint;
  v_conflict  bigint;
  v_count     integer;
  v_created   boolean;
begin
  perform pg_temp.import_log('modo', '—',
    case when v_dry_run then 'SIMULACIÓN' else 'ESCRITURA' end,
    case when v_dry_run then 'No se escribió nada en la base.' else 'Cambios guardados.' end);

  -- Validaciones previas: categorías e imágenes con variante existente en el origen.
  for p in select * from pg_temp.src_products loop
    if not exists (select 1 from public.categories c where c.slug = p.category_slug) then
      raise exception 'No existe la categoría "%". No se importó nada.', p.category_slug;
    end if;
  end loop;

  for i in select * from pg_temp.src_images si
           where si.variant_name is not null
             and not exists (select 1 from pg_temp.src_variants sv
                             where sv.product_slug = si.product_slug and sv.name = si.variant_name) loop
    raise exception 'La imagen % apunta a la variante "%", que no está en los datos de origen.', i.src, i.variant_name;
  end loop;

  for p in select * from pg_temp.src_products order by category_slug, sort_order loop
    v_product := null;
    v_created := false;

    -- 3.1 ¿Ya fue importado? (por ID de origen, nunca por nombre)
    if p.legacy_id is not null then
      select pi.product_id into v_product
      from public.product_internal pi
      where pi.legacy_id = p.legacy_id;
    else
      select count(distinct pv.product_id), min(pv.product_id) into v_count, v_product
      from public.variant_internal vi
      join public.product_variants pv on pv.id = vi.variant_id
      where vi.legacy_sheet_id in (select sv.sheet_id from pg_temp.src_variants sv
                                   where sv.product_slug = p.slug and sv.sheet_id is not null);
      if v_count > 1 then
        raise exception 'Las filas de la hoja de "%" están en % productos distintos. Revisalo antes de importar.', p.name, v_count;
      end if;
    end if;

    if v_product is not null then
      perform pg_temp.import_log('producto', p.name, 'ya existe',
        format('id %s · no se modifica', v_product));
    else
      -- 3.2 El slug no puede estar usado por un producto ajeno a la importación.
      select pr.id into v_conflict from public.products pr where pr.slug = p.slug;
      if v_conflict is not null then
        raise exception 'Ya existe el producto id % con slug "%" que no proviene de esta importación. No se importó nada.', v_conflict, p.slug;
      end if;

      select c.id into v_category from public.categories c where c.slug = p.category_slug;

      if not v_dry_run then
        insert into public.products (category_id, slug, name, description, is_active, sort_order)
        values (v_category, p.slug, p.name, p.description, false, p.sort_order)
        returning id into v_product;

        if p.legacy_id is not null then
          insert into public.product_internal (product_id, legacy_id) values (v_product, p.legacy_id);
        end if;
      end if;

      v_created := true;
      perform pg_temp.import_log('producto', p.name, v_new,
        format('borrador · categoría %s · slug %s%s', p.category_slug, p.slug,
               case when p.legacy_id is not null then format(' · products.js id %s', p.legacy_id) else '' end));
    end if;

    -- 3.3 Variantes
    for v in select * from pg_temp.src_variants sv where sv.product_slug = p.slug order by sv.sort_order loop
      v_variant := null;

      if v.sheet_id is not null then
        -- Yerba: se identifica por el ID de la hoja.
        select vi.variant_id into v_variant
        from public.variant_internal vi
        where vi.legacy_sheet_id = v.sheet_id;

        if v_variant is not null then
          perform pg_temp.import_log('variante', p.name || ' · ' || v.name, 'ya existe',
            format('hoja ID %s · id %s · no se modifica', v.sheet_id, v_variant));
          continue;
        end if;

        if v_product is not null and exists (
          select 1 from public.product_variants pv where pv.product_id = v_product and pv.name = v.name
        ) then
          raise exception 'El producto "%" ya tiene una variante "%" que no está vinculada a la hoja (ID %). No se importó nada.',
            p.name, v.name, v.sheet_id;
        end if;
      elsif not v_created then
        -- products.js: si el producto ya existía, sus variantes no se tocan.
        perform pg_temp.import_log('variante', p.name || ' · ' || v.name, 'omitida', 'el producto ya existía');
        continue;
      end if;

      if not v_dry_run then
        -- Sin columna stock: nace en 0 (el trigger de la base lo exige).
        insert into public.product_variants (product_id, name, price, track_stock, is_active, sort_order)
        values (v_product, v.name, v.price, v.track_stock, true, v.sort_order)
        returning id into v_variant;

        if v.sheet_id is not null then
          insert into public.variant_internal (variant_id, legacy_sheet_id) values (v_variant, v.sheet_id);
        end if;
      end if;

      perform pg_temp.import_log('variante', p.name || ' · ' || v.name, v_new,
        format('precio %s · %s · stock 0%s', v.price,
               case when v.track_stock then 'controla stock' else 'sin control de stock' end,
               coalesce(' · hoja ID ' || v.sheet_id, '')));
    end loop;

    -- 3.4 Imágenes: solo para productos creados en esta ejecución.
    for i in select * from pg_temp.src_images si where si.product_slug = p.slug order by si.sort_order loop
      if not v_created then
        perform pg_temp.import_log('imagen', i.src, 'omitida', 'el producto ya existía');
        continue;
      end if;

      if not v_dry_run then
        select pv.id into v_variant
        from public.product_variants pv
        where pv.product_id = v_product and pv.name = i.variant_name;

        insert into public.product_images (product_id, variant_id, src, alt, is_cover, sort_order)
        values (v_product, case when i.variant_name is null then null else v_variant end,
                i.src, p.name, i.is_cover, i.sort_order);
      end if;

      perform pg_temp.import_log('imagen', i.src, v_new,
        concat_ws(' · ', p.name,
                  case when i.is_cover then 'portada' end,
                  case when i.variant_name is not null then 'variante ' || i.variant_name else 'todo el producto' end));
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Resultado (el SQL Editor muestra esta tabla)
-- ---------------------------------------------------------------------
select orden, entidad, clave, accion, detalle
from pg_temp.import_report
order by orden;

-- ---------------------------------------------------------------------
-- Verificación opcional, DESPUÉS de la ejecución real (consulta aparte):
--
-- select p.id, p.slug, p.is_active, pi.legacy_id,
--        v.name as variante, v.price, v.stock, v.track_stock, vi.legacy_sheet_id,
--        (select count(*) from public.product_images im where im.product_id = p.id) as imagenes
-- from public.products p
-- left join public.product_internal pi on pi.product_id = p.id
-- left join public.product_variants v on v.product_id = p.id
-- left join public.variant_internal vi on vi.variant_id = v.id
-- where p.slug in ('bombilla-uruguaya', 'yerba-canarias-tradicional')
-- order by p.slug, v.sort_order;
-- ---------------------------------------------------------------------
