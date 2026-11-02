-- =====================================================================
-- Estadísticas propias (panel › Estadísticas).
--
--   public.analytics_events  un registro por evento de la tienda (13 meses)
--   public.analytics_daily   resúmenes diarios, sin límite de tiempo
--
-- Quién escribe: SOLO la función del sitio /api/track (Vercel), con la clave
-- secreta de Supabase guardada como variable de entorno del servidor. El
-- navegador nunca tiene esa clave ni permisos sobre estas tablas.
-- Quién lee: los administradores, a través de public.analytics_report().
--
-- Privacidad: no se guardan IP, nombres, emails ni cookies. Cada visitante es un
-- identificador al azar generado en su navegador; país y región los informa
-- Vercel y se guardan sin la IP.
--
-- No modifica ni borra datos existentes. Se ejecuta UNA vez (si las tablas ya
-- existen, falla al empezar y no cambia nada).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------
create table public.analytics_events (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  event          text not null check (event in ('page_view', 'product_view', 'add_to_cart', 'begin_checkout')),
  visitor_id     uuid not null,
  session_id     uuid not null,
  path           text not null check (char_length(path) between 1 and 300),
  product_id     bigint,   -- sin FK: el evento se conserva aunque el producto se borre
  referrer_host  text check (referrer_host is null or char_length(referrer_host) <= 120),
  utm_source     text check (utm_source is null or char_length(utm_source) <= 100),
  utm_medium     text check (utm_medium is null or char_length(utm_medium) <= 100),
  utm_campaign   text check (utm_campaign is null or char_length(utm_campaign) <= 100),
  device         text check (device is null or device in ('mobile', 'tablet', 'desktop')),
  browser        text check (browser is null or char_length(browser) <= 40),
  os             text check (os is null or char_length(os) <= 40),
  country        text check (country is null or country ~ '^[A-Z]{2}$'),
  region         text check (region is null or char_length(region) <= 80)
);

create index analytics_events_created_idx on public.analytics_events (created_at);
create index analytics_events_event_idx   on public.analytics_events (event, created_at);
create index analytics_events_product_idx on public.analytics_events (product_id, created_at) where product_id is not null;

-- Resumen por día y dimensión (total, página, producto, fuente, dispositivo, país).
create table public.analytics_daily (
  day        date not null,
  dimension  text not null,
  key        text not null,
  events     integer not null default 0,
  visitors   integer not null default 0,
  primary key (day, dimension, key)
);

comment on table public.analytics_events is
  'Eventos anónimos de la tienda (sin IP ni datos personales). Los escribe /api/track; los leen los administradores con analytics_report().';

-- Nadie desde la API (ni anon ni authenticated): se escribe con la clave del
-- servidor y se lee con las funciones de abajo.
revoke all on public.analytics_events, public.analytics_daily from public, anon, authenticated;
alter table public.analytics_events enable row level security;
alter table public.analytics_daily  enable row level security;

-- ---------------------------------------------------------------------
-- 2. Informe para el panel (solo administradores)
--    Fuente de una sesión: campaña UTM > sitio de origen > «Directo».
-- ---------------------------------------------------------------------
create or replace function public.analytics_report(p_from timestamptz, p_to timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if not private.is_admin() then
    raise exception 'Solo los administradores pueden ver las estadísticas.' using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '400 days' then
    raise exception 'Elegí un período válido (hasta 400 días).' using errcode = 'invalid_parameter_value';
  end if;

  with e as (
    select * from public.analytics_events where created_at >= p_from and created_at < p_to
  ),
  s as (   -- una fila por sesión: de dónde vino y hasta dónde llegó
    select session_id,
           max(visitor_id::text) as visitor_id,
           coalesce(max(nullif(utm_source, '')), max(nullif(referrer_host, '')), 'Directo') as source,
           max(utm_campaign) as campaign,
           bool_or(event = 'page_view')      as viewed,
           bool_or(event = 'product_view')   as saw_product,
           bool_or(event = 'add_to_cart')    as added,
           bool_or(event = 'begin_checkout') as checkout
      from e group by session_id
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'page_views',     (select count(*) from e where event = 'page_view'),
      'visitors',       (select count(distinct visitor_id) from e),
      'sessions',       (select count(*) from s),
      'product_views',  (select count(*) from e where event = 'product_view'),
      'add_to_cart',    (select count(*) from e where event = 'add_to_cart'),
      'begin_checkout', (select count(*) from e where event = 'begin_checkout'),
      'orders',         (select count(*) from public.orders where created_at >= p_from and created_at < p_to),
      'orders_total',   (select coalesce(sum(total), 0) from public.orders where created_at >= p_from and created_at < p_to)
    ),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object('day', d, 'views', views, 'visitors', visitors) order by d)
        from (select (created_at at time zone 'America/Argentina/Buenos_Aires')::date as d,
                     count(*) filter (where event = 'page_view') as views,
                     count(distinct visitor_id) as visitors
                from e group by 1) x), '[]'::jsonb),
    'pages', coalesce((
      select jsonb_agg(jsonb_build_object('key', path, 'views', views, 'visitors', visitors) order by views desc)
        from (select path, count(*) as views, count(distinct visitor_id) as visitors
                from e where event = 'page_view' group by path order by 2 desc limit 10) x), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('key', coalesce(p.name, 'Producto eliminado'), 'product_id', x.product_id,
                                          'views', x.views, 'added', x.added) order by x.views desc, x.added desc)
        from (select product_id,
                     count(*) filter (where event = 'product_view') as views,
                     count(*) filter (where event = 'add_to_cart') as added
                from e where product_id is not null group by product_id order by 2 desc, 3 desc limit 10) x
        left join public.products p on p.id = x.product_id), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object('key', source, 'sessions', n) order by n desc)
        from (select source, count(*) as n from s group by source order by 2 desc limit 10) x), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object('key', campaign, 'sessions', n) order by n desc)
        from (select campaign, count(*) as n from s where campaign is not null group by campaign order by 2 desc limit 10) x), '[]'::jsonb),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object('key', k, 'visitors', n) order by n desc)
        from (select coalesce(device, 'desconocido') as k, count(distinct visitor_id) as n from e group by 1) x), '[]'::jsonb),
    'browsers', coalesce((
      select jsonb_agg(jsonb_build_object('key', k, 'visitors', n) order by n desc)
        from (select coalesce(browser, 'Otro') as k, count(distinct visitor_id) as n from e group by 1 order by 2 desc limit 8) x), '[]'::jsonb),
    'countries', coalesce((
      select jsonb_agg(jsonb_build_object('key', k, 'region', r, 'visitors', n) order by n desc)
        from (select coalesce(country, '—') as k, region as r, count(distinct visitor_id) as n
                from e group by 1, 2 order by 3 desc limit 12) x), '[]'::jsonb),
    'funnel', jsonb_build_object(
      'sessions',       (select count(*) from s where viewed),
      'product_view',   (select count(*) from s where saw_product),
      'add_to_cart',    (select count(*) from s where added),
      'begin_checkout', (select count(*) from s where checkout)
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.analytics_report(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.analytics_report(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Mantenimiento: resúmenes diarios y borrado de eventos de más de 13 meses
--    Lo corre una tarea programada (ver el paso opcional al final). No lo puede
--    ejecutar nadie desde la API.
-- ---------------------------------------------------------------------
create or replace function public.analytics_maintenance()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day     date;
  v_deleted integer;
begin
  -- Resume cada día completo que tenga eventos y todavía no esté resumido.
  for v_day in
    select distinct (created_at at time zone 'America/Argentina/Buenos_Aires')::date
      from public.analytics_events
     where (created_at at time zone 'America/Argentina/Buenos_Aires')::date
           < (now() at time zone 'America/Argentina/Buenos_Aires')::date
       and (created_at at time zone 'America/Argentina/Buenos_Aires')::date
           not in (select day from public.analytics_daily where dimension = 'total')
  loop
    insert into public.analytics_daily (day, dimension, key, events, visitors)
    select v_day, dim, key, count(*), count(distinct visitor_id)
      from public.analytics_events e
     cross join lateral (values
       ('total',   e.event),
       ('page',    case when e.event = 'page_view' then e.path end),
       ('product', case when e.product_id is not null then e.product_id::text || ':' || e.event end),
       ('source',  coalesce(e.utm_source, e.referrer_host, 'Directo')),
       ('device',  coalesce(e.device, 'desconocido')),
       ('country', coalesce(e.country, '—'))
     ) as dims(dim, key)
     where (e.created_at at time zone 'America/Argentina/Buenos_Aires')::date = v_day
       and key is not null
     group by dim, key
    on conflict (day, dimension, key) do nothing;
  end loop;

  delete from public.analytics_events where created_at < now() - interval '13 months';
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.analytics_maintenance() from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------
-- Paso OPCIONAL, aparte (no es parte de la transacción): programar el
-- mantenimiento todos los días a las 4:00 de Argentina (7:00 UTC).
-- Requiere activar la extensión pg_cron en Supabase › Database › Extensions.
--
--   select cron.schedule('povmatero-analytics', '0 7 * * *',
--                        $$ select public.analytics_maintenance(); $$);
-- ---------------------------------------------------------------------
