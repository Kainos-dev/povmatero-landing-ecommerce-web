-- =====================================================================
-- Povmatero — Importación del CATÁLOGO COMPLETO
--
-- Importa:
--   * js/products.js: 41 productos (73 variantes; los que no tienen variantes
--     llevan una única variante "Único", porque la tienda exige al menos una).
--   * Hoja WEB (Google Sheets): 28 yerbas con 43 presentaciones con precio.
--   * 101 imágenes del repo (rutas relativas, no se suben a Storage).
--   Total: 69 productos · 116 variantes · 101 imágenes.
--
--   Incluye los 2 productos de la prueba controlada (20261029_01): ya existen,
--   así que el reporte debe mostrarlos como «ya existe» y no tocarlos.
--
-- QUEDA AFUERA (aparece en el reporte como «excluido»):
--   * 8 presentaciones de yerba sin precio en la hoja (no se inventan precios).
--   * 19 imágenes que no se usan: archivos inexistentes o fotos provisorias.
--     Esos productos/variantes se crean igual, sin esa imagen.
--
-- CÓMO USARLO (SQL Editor de Supabase, pegando el archivo completo):
--   1) Ejecutalo TAL CUAL. Con v_dry_run = true es una SIMULACIÓN: no escribe
--      nada en el catálogo y muestra el reporte de lo que haría.
--   2) Si el reporte es correcto, cambiá v_dry_run a false (línea marcada con ◀)
--      y ejecutalo de nuevo: escribe y muestra el reporte.
--   3) Ejecutalo otra vez con false: no debe crear nada (todo «ya existe»).
--
-- GARANTÍAS (iguales a la prueba controlada):
--   * Los productos se crean como BORRADOR (is_active = false).
--   * No toca stock: las variantes nacen con stock 0 (la base lo exige) y no
--     se registran movimientos. El stock se carga después con movimientos.
--   * No modifica registros existentes: solo crea lo que falta.
--   * Todo el bloque DO es una única operación: si algo falla, no se guarda nada.
--   * Los DROP del inicio solo afectan objetos temporales de la sesión (pg_temp).
--   * Se ejecuta como postgres (dueño de las tablas), por eso no aplica RLS;
--     solo escribe en products, product_internal, product_variants,
--     variant_internal y product_images. No toca admin_users, costos ni stock.
--
-- ESTRATEGIA PARA NO DUPLICAR (si se ejecuta más de una vez):
--   * Producto de products.js → se busca por product_internal.legacy_id (= id de products.js).
--   * Producto de yerba       → se busca por sus variantes ya vinculadas
--                               (variant_internal.legacy_sheet_id = columna ID de la hoja).
--   * Si el producto YA existe: no se modifica, y no se le agregan variantes de
--     products.js ni imágenes (así no se reponen cosas editadas o borradas en el panel).
--   * Variantes de yerba → se buscan por legacy_sheet_id; si falta alguna, se crea
--     aunque el producto ya exista (sirve para sumar después las presentaciones
--     que hoy no tienen precio).
--   * Si un slug o un nombre de variante ya está usado por algo que NO vino de
--     esta importación, se cancela todo con un mensaje claro (nunca se adivina).
--
-- CRITERIOS:
--   * Slug: nombre en minúsculas, sin tildes, palabras separadas por guiones.
--     Las yerbas llevan el prefijo "yerba-" (como en la prueba controlada).
--   * Orden: posición en su fuente (products.js / primera aparición en la hoja).
--     Las presentaciones de yerba conservan su posición dentro del producto
--     aunque alguna esté excluida (500gr = 0, 1kg = 1).
--   * Variantes de products.js: heredan el precio del producto y no controlan
--     stock (track_stock = false, como en la prueba). Yerbas: controlan stock.
--   * Imágenes de products.js: la "image" del producto es la portada (de todo el
--     producto) y cada variante suma su propia imagen, aunque repita archivo.
--   * Yerbas: solo se usan las fotos reales mapeadas en js/yerbas.js. La foto
--     provisoria (canarias-tradicional.png) no se importa.
--
-- AVISO SOBRE PRECIOS: js/products.js tiene el comentario
--   "HASTA ACÁ SE ACTUALIZARON LOS PRECIOS 14/7/26" después del id 4.
--   Los ids 5 a 41 se importan con el precio que hoy muestra la tienda, pero
--   conviene revisarlos en el panel antes de publicarlos (entran como borrador).
--
-- Datos generados textualmente desde las fuentes el 29/10/2026. No se completó
-- ningún dato faltante. Descripciones vacías, como en el origen.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Datos de origen (tablas temporales: desaparecen al cerrar la sesión)
-- ---------------------------------------------------------------------
drop function if exists pg_temp.import_log(text, text, text, text);
drop table if exists pg_temp.src_products, pg_temp.src_variants, pg_temp.src_images,
                     pg_temp.src_excluded, pg_temp.import_report;

create temp table src_products (
  slug          text primary key,
  name          text not null,
  category_slug text not null,
  description   text not null,
  sort_order    integer not null,  -- posición en su fuente
  legacy_id     integer unique     -- id en js/products.js (null para yerbas)
);

insert into pg_temp.src_products (slug, name, category_slug, description, sort_order, legacy_id) values
  -- js/products.js (slug, nombre, categoría, descripción, orden, id)
  ('mate-imperial', 'Mate Imperial', 'mates', '', 0, 1),
  ('mate-torpedo-alpaca', 'Mate Torpedo Alpaca', 'mates', '', 1, 2),
  ('mate-torpedo-cincelado', 'Mate Torpedo Cincelado', 'mates', '', 2, 3),
  ('mate-torpedo-aluminio', 'Mate Torpedo Aluminio', 'mates', '', 3, 4),
  ('mate-camionero-cincelado', 'Mate Camionero Cincelado', 'mates', '', 4, 5),
  ('bombilla-uruguaya', 'Bombilla Uruguaya', 'bombillas', '', 5, 6),
  ('bombilla-con-resorte', 'Bombilla con Resorte', 'bombillas', '', 6, 7),
  ('mate-imperial-crudo', 'Mate Imperial Crudo', 'mates', '', 7, 8),
  ('mate-imperial-premium', 'Mate Imperial Premium', 'mates', '', 8, 9),
  ('mate-tejido', 'Mate Tejido', 'mates', '', 9, 10),
  ('mate-porito', 'Mate Porito', 'mates', '', 10, 11),
  ('mate-copita', 'Mate Copita', 'mates', '', 11, 12),
  ('mate-camionero-alpaca', 'Mate Camionero Alpaca', 'mates', '', 12, 13),
  ('mate-camionero-acero', 'Mate Camionero Acero', 'mates', '', 13, 14),
  ('mate-camionero-aluminio', 'Mate Camionero Aluminio', 'mates', '', 14, 15),
  ('termera-canasta-rigida-chica', 'Termera Canasta Rígida Chica', 'termeras', '', 15, 16),
  ('termera-canasta-rigida', 'Termera Canasta Rígida', 'termeras', '', 16, 17),
  ('termera-rigida-grande', 'Termera Rígida Grande', 'termeras', '', 17, 18),
  ('termera-rigida', 'Termera Rígida', 'termeras', '', 18, 19),
  ('termera-mochila-cuero', 'Termera Mochila Cuero', 'termeras', '', 19, 20),
  ('bombillon-alpaca', 'Bombillón Alpaca', 'bombillas', '', 20, 21),
  ('termera-mochila-lona', 'Termera Mochila Lona', 'termeras', '', 21, 22),
  ('termera-morral-cuero', 'Termera Morral Cuero', 'termeras', '', 22, 23),
  ('termera-morral-lona', 'Termera Morral Lona', 'termeras', '', 23, 24),
  ('termera-doble-cierre', 'Termera Doble Cierre', 'termeras', '', 24, 25),
  ('termera-canasta', 'Termera Canasta', 'termeras', '', 25, 26),
  ('termera-canasta-chica', 'Termera Canasta Chica', 'termeras', '', 26, 27),
  ('termera-cartera', 'Termera Cartera', 'termeras', '', 27, 28),
  ('yerbero-redondo-chico', 'Yerbero Redondo Chico', 'yerberos', '', 28, 29),
  ('yerbero-redondo-grande', 'Yerbero Redondo Grande', 'yerberos', '', 29, 30),
  ('yerbero-rectangular-grande', 'Yerbero Rectangular Grande', 'yerberos', '', 30, 31),
  ('yerbero-rectangular-mediano', 'Yerbero Rectangular Mediano', 'yerberos', '', 31, 32),
  ('yerbero-rectangular-chico', 'Yerbero Rectangular Chico', 'yerberos', '', 32, 33),
  ('yerbero-grande-de-cuero', 'Yerbero Grande de Cuero', 'yerberos', '', 33, 34),
  ('yerbero-de-cuero', 'Yerbero de Cuero', 'yerberos', '', 34, 35),
  ('yerbero-de-descarne', 'Yerbero de Descarne', 'yerberos', '', 35, 36),
  ('yerbero-de-lona', 'Yerbero de Lona', 'yerberos', '', 36, 37),
  ('mate-imperial-roma', 'Mate Imperial Roma', 'mates', '', 37, 38),
  ('cartera-termera-descarne', 'Cartera Termera Descarne', 'termeras', '', 38, 39),
  ('cartera-termera-descarne-chica', 'Cartera Termera Descarne Chica', 'termeras', '', 39, 40),
  ('bombillon-alpaca-punta-de-bronce', 'Bombillon Alpaca Punta de Bronce', 'bombillas', '', 40, 41),
  -- Hoja WEB
  ('yerba-canarias-tradicional', 'Canarias Tradicional', 'yerbas', '', 0, null),
  ('yerba-canarias-serena', 'Canarias Serena', 'yerbas', '', 1, null),
  ('yerba-canarias-ed-especial', 'Canarias Ed. Especial', 'yerbas', '', 2, null),
  ('yerba-canarias-te-verde-y-jengibre', 'Canarias Te Verde y Jengibre', 'yerbas', '', 3, null),
  ('yerba-canarias-te-rojo-y-centella', 'Canarias Te Rojo y Centella', 'yerbas', '', 4, null),
  ('yerba-canarias-contigo', 'Canarias Contigo', 'yerbas', '', 5, null),
  ('yerba-baldo', 'Baldo', 'yerbas', '', 6, null),
  ('yerba-esmeralda', 'Esmeralda', 'yerbas', '', 7, null),
  ('yerba-rei-verde-tradicional', 'Rei Verde Tradicional', 'yerbas', '', 8, null),
  ('yerba-rei-verde-premium', 'Rei Verde Premium', 'yerbas', '', 9, null),
  ('yerba-rei-verde-organica', 'Rei Verde Orgánica', 'yerbas', '', 10, null),
  ('yerba-rei-verde-compuesta', 'Rei Verde Compuesta', 'yerbas', '', 11, null),
  ('yerba-sara-tradicional', 'Sara Tradicional', 'yerbas', '', 12, null),
  ('yerba-sara-extrasuave', 'Sara Extrasuave', 'yerbas', '', 13, null),
  ('yerba-sara-esplendida', 'Sara Espléndida', 'yerbas', '', 14, null),
  ('yerba-sara-coco', 'Sara Coco', 'yerbas', '', 15, null),
  ('yerba-sara-curcuma-y-pimienta', 'Sara Cúrcuma y Pimienta', 'yerbas', '', 16, null),
  ('yerba-sara-compuesta', 'Sara Compuesta', 'yerbas', '', 17, null),
  ('yerba-barao', 'Barao', 'yerbas', '', 18, null),
  ('yerba-verdecita', 'Verdecita', 'yerbas', '', 19, null),
  ('yerba-pindare', 'Pindaré', 'yerbas', '', 20, null),
  ('yerba-consentina-con-colageno', 'Consentina con Colágeno', 'yerbas', '', 21, null),
  ('yerba-uruguay', 'Uruguay', 'yerbas', '', 22, null),
  ('yerba-la-selva-para-nerviosos', 'La Selva para Nerviosos', 'yerbas', '', 23, null),
  ('yerba-armino-clasica', 'Armiño Clásica', 'yerbas', '', 24, null),
  ('yerba-armino-suave', 'Armiño Suave', 'yerbas', '', 25, null),
  ('yerba-canabbis', 'Canabbis', 'yerbas', '', 26, null),
  ('yerba-canarias-suave', 'Canarias Suave', 'yerbas', '', 27, null);

create temp table src_variants (
  product_slug text not null,
  name         text not null,
  price        numeric(12, 2) not null check (price > 0),
  track_stock  boolean not null,
  sort_order   integer not null,
  sheet_id     integer unique,     -- columna ID de la hoja (null para products.js)
  primary key (product_slug, name)
);

insert into pg_temp.src_variants (product_slug, name, price, track_stock, sort_order, sheet_id) values
  -- js/products.js: heredan el precio del producto
  ('mate-imperial', 'Único', 54300, false, 0, null),
  ('mate-torpedo-alpaca', 'Único', 46800, false, 0, null),
  ('mate-torpedo-cincelado', 'Único', 24350, false, 0, null),
  ('mate-torpedo-aluminio', 'Único', 22780, false, 0, null),
  ('mate-camionero-cincelado', 'Único', 22320, false, 0, null),
  ('bombilla-uruguaya', 'Chica', 30720, false, 0, null),
  ('bombilla-uruguaya', 'Mediana', 30720, false, 1, null),
  ('bombilla-uruguaya', 'Grande', 30720, false, 2, null),
  ('bombilla-con-resorte', 'Caño Redondo', 21360, false, 0, null),
  ('bombilla-con-resorte', 'Caño Plano', 21360, false, 1, null),
  ('mate-imperial-crudo', 'Único', 58340, false, 0, null),
  ('mate-imperial-premium', 'Único', 71450, false, 0, null),
  ('mate-tejido', 'Único', 46150, false, 0, null),
  ('mate-porito', 'Único', 17470, false, 0, null),
  ('mate-copita', 'Único', 22780, false, 0, null),
  ('mate-camionero-alpaca', 'Único', 40560, false, 0, null),
  ('mate-camionero-acero', 'Único', 30890, false, 0, null),
  ('mate-camionero-aluminio', 'Único', 21220, false, 0, null),
  ('termera-canasta-rigida-chica', 'Negro', 85340, false, 0, null),
  ('termera-canasta-rigida-chica', 'Marrón', 85340, false, 1, null),
  ('termera-canasta-rigida-chica', 'Azul', 85340, false, 2, null),
  ('termera-canasta-rigida', 'Negro', 133080, false, 0, null),
  ('termera-canasta-rigida', 'Marrón', 133080, false, 1, null),
  ('termera-canasta-rigida', 'Azul', 133080, false, 2, null),
  ('termera-canasta-rigida', 'Rojo', 133080, false, 3, null),
  ('termera-canasta-rigida', 'Verde', 133080, false, 4, null),
  ('termera-rigida-grande', 'Marrón', 165890, false, 0, null),
  ('termera-rigida-grande', 'Negro', 165890, false, 1, null),
  ('termera-rigida-grande', 'Suela', 165890, false, 2, null),
  ('termera-rigida', 'Negro', 152760, false, 0, null),
  ('termera-rigida', 'Marrón', 152760, false, 1, null),
  ('termera-rigida', 'Azul', 152760, false, 2, null),
  ('termera-rigida', 'Rojo', 152760, false, 3, null),
  ('termera-mochila-cuero', 'Marrón', 171890, false, 0, null),
  ('termera-mochila-cuero', 'Suela', 171890, false, 1, null),
  ('bombillon-alpaca', 'Chica', 40320, false, 0, null),
  ('bombillon-alpaca', 'Mediana', 40320, false, 1, null),
  ('bombillon-alpaca', 'Grande', 40320, false, 2, null),
  ('termera-mochila-lona', 'Cemento', 142870, false, 0, null),
  ('termera-mochila-lona', 'Azul', 142870, false, 1, null),
  ('termera-morral-cuero', 'Marrón', 171890, false, 0, null),
  ('termera-morral-cuero', 'Suela', 171890, false, 1, null),
  ('termera-morral-lona', 'Único', 142870, false, 0, null),
  ('termera-doble-cierre', 'Negro', 166800, false, 0, null),
  ('termera-doble-cierre', 'Suela Bridge', 166800, false, 1, null),
  ('termera-canasta', 'Negro', 90340, false, 0, null),
  ('termera-canasta', 'Marrón', 90340, false, 1, null),
  ('termera-canasta', 'Suela', 90340, false, 2, null),
  ('termera-canasta-chica', 'Negro', 84620, false, 0, null),
  ('termera-canasta-chica', 'Marrón', 84620, false, 1, null),
  ('termera-canasta-chica', 'Suela', 84620, false, 2, null),
  ('termera-cartera', 'Negro', 145440, false, 0, null),
  ('termera-cartera', 'Marrón', 145440, false, 1, null),
  ('termera-cartera', 'Suela', 145440, false, 2, null),
  ('yerbero-redondo-chico', 'Único', 23810, false, 0, null),
  ('yerbero-redondo-grande', 'Único', 28580, false, 0, null),
  ('yerbero-rectangular-grande', 'Único', 30550, false, 0, null),
  ('yerbero-rectangular-mediano', 'Único', 26140, false, 0, null),
  ('yerbero-rectangular-chico', 'Único', 24190, false, 0, null),
  ('yerbero-grande-de-cuero', 'Negro', 30530, false, 0, null),
  ('yerbero-grande-de-cuero', 'Marrón', 30530, false, 1, null),
  ('yerbero-grande-de-cuero', 'Suela', 30530, false, 2, null),
  ('yerbero-de-cuero', 'Negro', 22780, false, 0, null),
  ('yerbero-de-cuero', 'Suela', 22780, false, 1, null),
  ('yerbero-de-descarne', 'Marrón', 20500, false, 0, null),
  ('yerbero-de-descarne', 'Óxido', 20500, false, 1, null),
  ('yerbero-de-lona', 'Azul', 16010, false, 0, null),
  ('yerbero-de-lona', 'Cemento', 16010, false, 1, null),
  ('yerbero-de-lona', 'Verde', 16010, false, 2, null),
  ('mate-imperial-roma', 'Único', 71450, false, 0, null),
  ('cartera-termera-descarne', 'Chocolate', 92760, false, 0, null),
  ('cartera-termera-descarne-chica', 'Único', 92760, false, 0, null),
  ('bombillon-alpaca-punta-de-bronce', 'Único', 40320, false, 0, null),
  -- Hoja WEB: precio de la columna Precio · sheet_id = columna ID
  ('yerba-canarias-tradicional', '500gr', 5600, true, 0, 1),
  ('yerba-canarias-tradicional', '1kg', 11600, true, 1, 2),
  ('yerba-canarias-serena', '500gr', 6700, true, 0, 3),
  ('yerba-canarias-serena', '1kg', 12500, true, 1, 4),
  ('yerba-canarias-ed-especial', '500gr', 6800, true, 0, 5),
  ('yerba-canarias-ed-especial', '1kg', 12600, true, 1, 6),
  ('yerba-canarias-te-verde-y-jengibre', '500gr', 6800, true, 0, 7),
  ('yerba-canarias-te-verde-y-jengibre', '1kg', 12600, true, 1, 8),
  ('yerba-canarias-te-rojo-y-centella', '1kg', 14000, true, 1, 10),
  ('yerba-canarias-contigo', '1kg', 13200, true, 1, 12),
  ('yerba-baldo', '500gr', 6200, true, 0, 13),
  ('yerba-baldo', '1kg', 11300, true, 1, 14),
  ('yerba-esmeralda', '1kg', 12000, true, 1, 16),
  ('yerba-rei-verde-tradicional', '500gr', 5100, true, 0, 17),
  ('yerba-rei-verde-tradicional', '1kg', 9700, true, 1, 18),
  ('yerba-rei-verde-premium', '500gr', 6300, true, 0, 19),
  ('yerba-rei-verde-premium', '1kg', 11600, true, 1, 20),
  ('yerba-rei-verde-organica', '500gr', 6600, true, 0, 21),
  ('yerba-rei-verde-compuesta', '500gr', 5300, true, 0, 23),
  ('yerba-sara-tradicional', '500gr', 7500, true, 0, 24),
  ('yerba-sara-tradicional', '1kg', 12400, true, 1, 25),
  ('yerba-sara-extrasuave', '500gr', 7500, true, 0, 26),
  ('yerba-sara-extrasuave', '1kg', 12400, true, 1, 27),
  ('yerba-sara-esplendida', '1kg', 15300, true, 1, 29),
  ('yerba-sara-coco', '500gr', 8000, true, 0, 30),
  ('yerba-sara-curcuma-y-pimienta', '500gr', 8800, true, 0, 32),
  ('yerba-sara-compuesta', '500gr', 8500, true, 0, 34),
  ('yerba-sara-compuesta', '1kg', 11600, true, 1, 35),
  ('yerba-barao', '500gr', 4900, true, 0, 36),
  ('yerba-barao', '1kg', 8600, true, 1, 37),
  ('yerba-verdecita', '500gr', 4100, true, 0, 38),
  ('yerba-verdecita', '1kg', 7600, true, 1, 39),
  ('yerba-pindare', '500gr', 4600, true, 0, 40),
  ('yerba-pindare', '1kg', 8700, true, 1, 41),
  ('yerba-consentina-con-colageno', '500gr', 6500, true, 0, 42),
  ('yerba-consentina-con-colageno', '1kg', 12000, true, 1, 43),
  ('yerba-uruguay', '500gr', 5100, true, 0, 44),
  ('yerba-uruguay', '1kg', 8800, true, 1, 45),
  ('yerba-la-selva-para-nerviosos', '1kg', 13600, true, 0, 46),
  ('yerba-armino-clasica', '1kg', 13400, true, 0, 47),
  ('yerba-armino-suave', '1kg', 13800, true, 0, 48),
  ('yerba-canabbis', '1kg', 17400, true, 0, 49),
  ('yerba-canarias-suave', '1kg', 13900, true, 1, 51);

create temp table src_images (
  product_slug text not null,
  variant_name text,               -- null = imagen de todo el producto
  src          text not null,      -- ruta relativa del repo (no se sube a Storage)
  is_cover     boolean not null,
  sort_order   integer not null,
  primary key (product_slug, sort_order)
);

insert into pg_temp.src_images (product_slug, variant_name, src, is_cover, sort_order) values
  -- js/products.js: portada + imagen de cada variante
  ('mate-imperial', null, 'images/2329/varios-motivos.webp', true, 0),
  ('mate-torpedo-alpaca', null, 'images/2330/ambas-virolas.webp', true, 0),
  ('mate-torpedo-cincelado', null, 'images/2328/colores-varios.webp', true, 0),
  ('mate-torpedo-aluminio', null, 'images/2327/colores-varios.webp', true, 0),
  ('mate-camionero-cincelado', null, 'images/2306/colores-varios.webp', true, 0),
  ('bombilla-uruguaya', null, 'images/2300/medidas.webp', true, 0),
  ('bombilla-uruguaya', 'Chica', 'images/2300/a.webp', false, 1),
  ('bombilla-uruguaya', 'Mediana', 'images/2300/b.webp', false, 2),
  ('bombilla-uruguaya', 'Grande', 'images/2300/c.webp', false, 3),
  ('bombilla-con-resorte', null, 'images/2295/detalle-dije.webp', true, 0),
  ('bombilla-con-resorte', 'Caño Redondo', 'images/2295/varios-motivos.webp', false, 1),
  ('bombilla-con-resorte', 'Caño Plano', 'images/2295/varios-motivos.webp', false, 2),
  ('mate-imperial-crudo', null, 'images/2294/segunda.webp', true, 0),
  ('mate-imperial-premium', null, 'images/2293/portada.webp', true, 0),
  ('mate-tejido', null, 'images/2292/marron.webp', true, 0),
  ('mate-porito', null, 'images/2290/negro.webp', true, 0),
  ('mate-copita', null, 'images/2289/detalle.webp', true, 0),
  ('mate-camionero-alpaca', null, 'images/2287/suela-bridge.webp', true, 0),
  ('mate-camionero-acero', null, 'images/2286/negro.webp', true, 0),
  ('mate-camionero-aluminio', null, 'images/2285/colores-varios.webp', true, 0),
  ('termera-canasta-rigida-chica', null, 'images/2573/portada.webp', true, 0),
  ('termera-canasta-rigida-chica', 'Negro', 'images/2573/negro.webp', false, 1),
  ('termera-canasta-rigida-chica', 'Marrón', 'images/2573/marron.webp', false, 2),
  ('termera-canasta-rigida-chica', 'Azul', 'images/2573/azul.webp', false, 3),
  ('termera-canasta-rigida', null, 'images/2572/negro.webp', true, 0),
  ('termera-canasta-rigida', 'Negro', 'images/2572/negro.webp', false, 1),
  ('termera-canasta-rigida', 'Azul', 'images/2572/azul.webp', false, 2),
  ('termera-canasta-rigida', 'Rojo', 'images/2572/rojo.webp', false, 3),
  ('termera-canasta-rigida', 'Verde', 'images/2572/verde.webp', false, 4),
  ('termera-rigida-grande', null, 'images/2571/portada.webp', true, 0),
  ('termera-rigida-grande', 'Marrón', 'images/2571/marron.webp', false, 1),
  ('termera-rigida-grande', 'Negro', 'images/2571/negro.webp', false, 2),
  ('termera-rigida-grande', 'Suela', 'images/2571/suela.webp', false, 3),
  ('termera-rigida', null, 'images/2570/portada.webp', true, 0),
  ('termera-rigida', 'Negro', 'images/2570/negro.webp', false, 1),
  ('termera-rigida', 'Marrón', 'images/2570/marron.webp', false, 2),
  ('termera-rigida', 'Azul', 'images/2570/azul.webp', false, 3),
  ('termera-rigida', 'Rojo', 'images/2570/rojo.webp', false, 4),
  ('termera-mochila-cuero', null, 'images/2569/colores-varios.webp', true, 0),
  ('termera-mochila-cuero', 'Marrón', 'images/2569/chocolate.webp', false, 1),
  ('termera-mochila-cuero', 'Suela', 'images/2569/suela.webp', false, 2),
  ('bombillon-alpaca', null, 'images/2301/portada.webp', true, 0),
  ('bombillon-alpaca', 'Chica', 'images/2301/a.webp', false, 1),
  ('bombillon-alpaca', 'Mediana', 'images/2301/b.webp', false, 2),
  ('bombillon-alpaca', 'Grande', 'images/2301/c.webp', false, 3),
  ('termera-mochila-lona', null, 'images/2568/colores-varios.webp', true, 0),
  ('termera-mochila-lona', 'Cemento', 'images/2568/cemento.webp', false, 1),
  ('termera-mochila-lona', 'Azul', 'images/2568/azul.webp', false, 2),
  ('termera-morral-cuero', null, 'images/2565/portada.webp', true, 0),
  ('termera-morral-cuero', 'Marrón', 'images/2565/chocolate.webp', false, 1),
  ('termera-morral-cuero', 'Suela', 'images/2565/suela.webp', false, 2),
  ('termera-morral-lona', null, 'images/2564/portada.webp', true, 0),
  ('termera-doble-cierre', null, 'images/2563/portada.webp', true, 0),
  ('termera-doble-cierre', 'Negro', 'images/2563/negro.webp', false, 1),
  ('termera-doble-cierre', 'Suela Bridge', 'images/2563/suela-bridge.webp', false, 2),
  ('termera-canasta', null, 'images/2562/chocolate.webp', true, 0),
  ('termera-canasta', 'Negro', 'images/2562/negro.webp', false, 1),
  ('termera-canasta', 'Marrón', 'images/2562/chocolate.webp', false, 2),
  ('termera-canasta', 'Suela', 'images/2562/suela.webp', false, 3),
  ('termera-canasta-chica', null, 'images/2561/portada.webp', true, 0),
  ('termera-canasta-chica', 'Negro', 'images/2561/negro.webp', false, 1),
  ('termera-canasta-chica', 'Marrón', 'images/2561/chocolate.webp', false, 2),
  ('termera-canasta-chica', 'Suela', 'images/2561/suela.webp', false, 3),
  ('termera-cartera', null, 'images/2555/portada.webp', true, 0),
  ('termera-cartera', 'Negro', 'images/2555/negro.webp', false, 1),
  ('termera-cartera', 'Marrón', 'images/2555/chocolate.webp', false, 2),
  ('termera-cartera', 'Suela', 'images/2555/suela.webp', false, 3),
  ('yerbero-redondo-chico', null, 'images/2274/portada.webp', true, 0),
  ('yerbero-redondo-grande', null, 'images/2273/portada.webp', true, 0),
  ('yerbero-rectangular-grande', null, 'images/2272/marron.webp', true, 0),
  ('yerbero-rectangular-mediano', null, 'images/2271/marron.webp', true, 0),
  ('yerbero-rectangular-chico', null, 'images/2270/marron.webp', true, 0),
  ('yerbero-grande-de-cuero', null, 'images/2267/colores-varios.webp', true, 0),
  ('yerbero-grande-de-cuero', 'Negro', 'images/2267/negro.webp', false, 1),
  ('yerbero-grande-de-cuero', 'Marrón', 'images/2267/chocolate.webp', false, 2),
  ('yerbero-grande-de-cuero', 'Suela', 'images/2267/suela.webp', false, 3),
  ('yerbero-de-cuero', null, 'images/2266/colores-varios.webp', true, 0),
  ('yerbero-de-cuero', 'Negro', 'images/2266/negro.webp', false, 1),
  ('yerbero-de-cuero', 'Suela', 'images/2266/suela.webp', false, 2),
  ('yerbero-de-descarne', null, 'images/2265/colores-varios.webp', true, 0),
  ('yerbero-de-descarne', 'Marrón', 'images/2265/chocolate.webp', false, 1),
  ('yerbero-de-descarne', 'Óxido', 'images/2265/oxido.webp', false, 2),
  ('yerbero-de-lona', null, 'images/2264/colores-varios.webp', true, 0),
  ('yerbero-de-lona', 'Azul', 'images/2264/azul.webp', false, 1),
  ('yerbero-de-lona', 'Cemento', 'images/2264/cemento.webp', false, 2),
  ('yerbero-de-lona', 'Verde', 'images/2264/verde.webp', false, 3),
  ('mate-imperial-roma', null, 'images/2284/portada.webp', true, 0),
  ('cartera-termera-descarne', null, 'images/2552/portada.webp', true, 0),
  ('cartera-termera-descarne', 'Chocolate', 'images/2552/chocolate.webp', false, 1),
  ('cartera-termera-descarne-chica', null, 'images/2550/portada.webp', true, 0),
  ('bombillon-alpaca-punta-de-bronce', null, 'images/2302/portada.webp', true, 0),
  -- Hoja WEB: solo fotos reales
  ('yerba-canarias-tradicional', null, 'images/yerbas/canariasTradicional.png', true, 0),
  ('yerba-canarias-contigo', null, 'images/yerbas/canariasContigo.png', true, 0),
  ('yerba-baldo', null, 'images/yerbas/baldo.png', true, 0),
  ('yerba-esmeralda', null, 'images/yerbas/esmeralda.png', true, 0),
  ('yerba-rei-verde-tradicional', null, 'images/yerbas/reiverdeTradicional.png', true, 0),
  ('yerba-sara-tradicional', null, 'images/yerbas/saraTradicional.png', true, 0),
  ('yerba-sara-extrasuave', null, 'images/yerbas/saraExtrasuave.png', true, 0),
  ('yerba-barao', null, 'images/yerbas/barao.png', true, 0),
  ('yerba-verdecita', null, 'images/yerbas/verdecita.png', true, 0),
  ('yerba-pindare', null, 'images/yerbas/pindare.png', true, 0);

-- Casos que NO se importan (solo para el reporte).
create temp table src_excluded (
  orden   integer primary key,
  tipo    text not null,
  clave   text not null,
  motivo  text not null
);

insert into pg_temp.src_excluded (orden, tipo, clave, motivo) values
  (1, 'sin precio', 'Canarias Te Rojo y Centella · 500gr (hoja ID 9)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (2, 'sin precio', 'Canarias Contigo · 500gr (hoja ID 11)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (3, 'sin precio', 'Esmeralda · 500gr (hoja ID 15)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (4, 'sin precio', 'Rei Verde Orgánica · 1kg (hoja ID 22)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (5, 'sin precio', 'Sara Espléndida · 500gr (hoja ID 28)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (6, 'sin precio', 'Sara Coco · 1kg (hoja ID 31)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (7, 'sin precio', 'Sara Cúrcuma y Pimienta · 1kg (hoja ID 33)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (8, 'sin precio', 'Canarias Suave · 500gr (hoja ID 50)', 'La hoja no tiene precio: no se importa (no se inventan precios).'),
  (9, 'imagen faltante', 'Termera Canasta Rígida · Marrón · images/2572/marron.webp', 'products.js id 17: el archivo no existe en el repo (la carpeta tiene: azul.webp, chocolate.webp, negro.webp, rojo.webp, verde.webp). Se crea sin esta imagen.'),
  (10, 'sin imagen', 'Canarias Serena', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (11, 'sin imagen', 'Canarias Ed. Especial', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (12, 'sin imagen', 'Canarias Te Verde y Jengibre', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (13, 'sin imagen', 'Canarias Te Rojo y Centella', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (14, 'sin imagen', 'Rei Verde Premium', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (15, 'sin imagen', 'Rei Verde Orgánica', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (16, 'sin imagen', 'Rei Verde Compuesta', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (17, 'sin imagen', 'Sara Espléndida', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (18, 'sin imagen', 'Sara Coco', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (19, 'sin imagen', 'Sara Cúrcuma y Pimienta', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (20, 'sin imagen', 'Sara Compuesta', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (21, 'sin imagen', 'Consentina con Colágeno', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (22, 'sin imagen', 'Uruguay', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (23, 'sin imagen', 'La Selva para Nerviosos', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (24, 'sin imagen', 'Armiño Clásica', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (25, 'sin imagen', 'Armiño Suave', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (26, 'sin imagen', 'Canabbis', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.'),
  (27, 'sin imagen', 'Canarias Suave', 'Solo tiene la foto provisoria (images/yerbas/canarias-tradicional.png): se crea sin imagen.');

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
  r           record;
  v_category  bigint;
  v_product   bigint;
  v_variant   bigint;
  v_conflict  bigint;
  v_count     integer;
  v_created   boolean;
begin
  perform pg_temp.import_log('modo', '—',
    case when v_dry_run then 'SIMULACIÓN' else 'ESCRITURA' end,
    case when v_dry_run then 'No se escribió nada en el catálogo.' else 'Cambios guardados.' end);

  -- Validaciones previas (antes de escribir nada).
  for p in select * from pg_temp.src_products loop
    if not exists (select 1 from public.categories c where c.slug = p.category_slug) then
      raise exception 'No existe la categoría "%". No se importó nada.', p.category_slug;
    end if;
    if p.slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
      raise exception 'El slug "%" no tiene un formato válido. No se importó nada.', p.slug;
    end if;
    if not exists (select 1 from pg_temp.src_variants sv where sv.product_slug = p.slug) then
      raise exception 'El producto "%" no tiene ninguna variante en los datos de origen.', p.name;
    end if;
  end loop;

  for v in select * from pg_temp.src_variants sv
           where not exists (select 1 from pg_temp.src_products sp where sp.slug = sv.product_slug) loop
    raise exception 'La variante "%" apunta al producto "%", que no está en los datos de origen.', v.name, v.product_slug;
  end loop;

  for i in select * from pg_temp.src_images si
           where not exists (select 1 from pg_temp.src_products sp where sp.slug = si.product_slug)
              or (si.variant_name is not null
                  and not exists (select 1 from pg_temp.src_variants sv
                                  where sv.product_slug = si.product_slug and sv.name = si.variant_name)) loop
    raise exception 'La imagen % apunta a un producto o variante que no está en los datos de origen.', i.src;
  end loop;

  for r in select si.product_slug from pg_temp.src_images si where si.is_cover
           group by si.product_slug having count(*) > 1 loop
    raise exception 'El producto "%" tiene más de una portada en los datos de origen.', r.product_slug;
  end loop;

  -- Casos excluidos (informativos).
  for r in select * from pg_temp.src_excluded order by orden loop
    perform pg_temp.import_log('excluido', r.clave, r.tipo, r.motivo);
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
               case when p.legacy_id is not null then format(' · products.js id %s', p.legacy_id) else ' · hoja WEB' end));
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
        v_variant := null;
        if i.variant_name is not null then
          select pv.id into v_variant
          from public.product_variants pv
          where pv.product_id = v_product and pv.name = i.variant_name;

          if v_variant is null then
            raise exception 'No se encontró la variante "%" de "%" para la imagen %.', i.variant_name, p.name, i.src;
          end if;
        end if;

        insert into public.product_images (product_id, variant_id, src, alt, is_cover, sort_order)
        values (v_product, v_variant, i.src, p.name, i.is_cover, i.sort_order);
      end if;

      perform pg_temp.import_log('imagen', i.src, v_new,
        concat_ws(' · ', p.name,
                  case when i.is_cover then 'portada' end,
                  case when i.variant_name is not null then 'variante ' || i.variant_name else 'todo el producto' end));
    end loop;
  end loop;

  -- 3.5 Resumen (aparece al principio del reporte).
  for r in select entidad, accion, count(*) as n
           from pg_temp.import_report
           where entidad in ('producto', 'variante', 'imagen', 'excluido')
           group by entidad, accion
           order by entidad, accion loop
    perform pg_temp.import_log('resumen', r.entidad, r.accion, r.n::text);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 4. Resultado (el SQL Editor muestra esta tabla; el resumen va primero)
-- ---------------------------------------------------------------------
select orden, entidad, clave, accion, detalle
from pg_temp.import_report
order by (entidad = 'modo') desc, (entidad = 'resumen') desc, orden;

-- ---------------------------------------------------------------------
-- Verificación opcional, DESPUÉS de la ejecución real (consulta aparte):
--
-- select c.slug as categoria,
--        count(distinct p.id) as productos,
--        count(distinct v.id) as variantes,
--        count(distinct im.id) as imagenes,
--        count(distinct p.id) filter (where p.is_active) as activos,
--        count(distinct v.id) filter (where v.stock <> 0) as variantes_con_stock
-- from public.products p
-- join public.categories c on c.id = p.category_id
-- left join public.product_variants v on v.product_id = p.id
-- left join public.product_images im on im.product_id = p.id
-- group by c.slug
-- order by c.slug;
-- ---------------------------------------------------------------------
