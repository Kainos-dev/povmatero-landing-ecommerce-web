-- =====================================================================
-- Povmatero — Estado real del catálogo en Supabase (SOLO LECTURA)
--
-- Es una única consulta SELECT: no crea, modifica ni borra nada.
-- Compara lo que hay en la base contra lo que la importación completa
-- (supabase/imports/20261029_02_catalogo_completo.sql) debería haber creado:
-- 69 productos · 116 variantes · 101 imágenes.
--
-- CÓMO USARLO: SQL Editor de Supabase → pegar el archivo completo → Run.
-- Devuelve una tabla: primero el resumen y después el detalle de lo que
-- falta o sobra. Copiá el resultado completo (o exportalo a CSV).
--
-- Cruce (igual que la importación):
--   * products.js → product_internal.legacy_id
--   * yerbas      → variant_internal.legacy_sheet_id de sus variantes
--   * si no hay vínculo, por slug
-- Datos esperados generados desde el script de importación el 28/10/2026.
-- =====================================================================
with
exp_products (slug, name, category_slug, legacy_id) as (
  values
    ('mate-imperial', 'Mate Imperial', 'mates', 1::int),
    ('mate-torpedo-alpaca', 'Mate Torpedo Alpaca', 'mates', 2::int),
    ('mate-torpedo-cincelado', 'Mate Torpedo Cincelado', 'mates', 3::int),
    ('mate-torpedo-aluminio', 'Mate Torpedo Aluminio', 'mates', 4::int),
    ('mate-camionero-cincelado', 'Mate Camionero Cincelado', 'mates', 5::int),
    ('bombilla-uruguaya', 'Bombilla Uruguaya', 'bombillas', 6::int),
    ('bombilla-con-resorte', 'Bombilla con Resorte', 'bombillas', 7::int),
    ('mate-imperial-crudo', 'Mate Imperial Crudo', 'mates', 8::int),
    ('mate-imperial-premium', 'Mate Imperial Premium', 'mates', 9::int),
    ('mate-tejido', 'Mate Tejido', 'mates', 10::int),
    ('mate-porito', 'Mate Porito', 'mates', 11::int),
    ('mate-copita', 'Mate Copita', 'mates', 12::int),
    ('mate-camionero-alpaca', 'Mate Camionero Alpaca', 'mates', 13::int),
    ('mate-camionero-acero', 'Mate Camionero Acero', 'mates', 14::int),
    ('mate-camionero-aluminio', 'Mate Camionero Aluminio', 'mates', 15::int),
    ('termera-canasta-rigida-chica', 'Termera Canasta Rígida Chica', 'termeras', 16::int),
    ('termera-canasta-rigida', 'Termera Canasta Rígida', 'termeras', 17::int),
    ('termera-rigida-grande', 'Termera Rígida Grande', 'termeras', 18::int),
    ('termera-rigida', 'Termera Rígida', 'termeras', 19::int),
    ('termera-mochila-cuero', 'Termera Mochila Cuero', 'termeras', 20::int),
    ('bombillon-alpaca', 'Bombillón Alpaca', 'bombillas', 21::int),
    ('termera-mochila-lona', 'Termera Mochila Lona', 'termeras', 22::int),
    ('termera-morral-cuero', 'Termera Morral Cuero', 'termeras', 23::int),
    ('termera-morral-lona', 'Termera Morral Lona', 'termeras', 24::int),
    ('termera-doble-cierre', 'Termera Doble Cierre', 'termeras', 25::int),
    ('termera-canasta', 'Termera Canasta', 'termeras', 26::int),
    ('termera-canasta-chica', 'Termera Canasta Chica', 'termeras', 27::int),
    ('termera-cartera', 'Termera Cartera', 'termeras', 28::int),
    ('yerbero-redondo-chico', 'Yerbero Redondo Chico', 'yerberos', 29::int),
    ('yerbero-redondo-grande', 'Yerbero Redondo Grande', 'yerberos', 30::int),
    ('yerbero-rectangular-grande', 'Yerbero Rectangular Grande', 'yerberos', 31::int),
    ('yerbero-rectangular-mediano', 'Yerbero Rectangular Mediano', 'yerberos', 32::int),
    ('yerbero-rectangular-chico', 'Yerbero Rectangular Chico', 'yerberos', 33::int),
    ('yerbero-grande-de-cuero', 'Yerbero Grande de Cuero', 'yerberos', 34::int),
    ('yerbero-de-cuero', 'Yerbero de Cuero', 'yerberos', 35::int),
    ('yerbero-de-descarne', 'Yerbero de Descarne', 'yerberos', 36::int),
    ('yerbero-de-lona', 'Yerbero de Lona', 'yerberos', 37::int),
    ('mate-imperial-roma', 'Mate Imperial Roma', 'mates', 38::int),
    ('cartera-termera-descarne', 'Cartera Termera Descarne', 'termeras', 39::int),
    ('cartera-termera-descarne-chica', 'Cartera Termera Descarne Chica', 'termeras', 40::int),
    ('bombillon-alpaca-punta-de-bronce', 'Bombillon Alpaca Punta de Bronce', 'bombillas', 41::int),
    ('yerba-canarias-tradicional', 'Canarias Tradicional', 'yerbas', null::int),
    ('yerba-canarias-serena', 'Canarias Serena', 'yerbas', null::int),
    ('yerba-canarias-ed-especial', 'Canarias Ed. Especial', 'yerbas', null::int),
    ('yerba-canarias-te-verde-y-jengibre', 'Canarias Te Verde y Jengibre', 'yerbas', null::int),
    ('yerba-canarias-te-rojo-y-centella', 'Canarias Te Rojo y Centella', 'yerbas', null::int),
    ('yerba-canarias-contigo', 'Canarias Contigo', 'yerbas', null::int),
    ('yerba-baldo', 'Baldo', 'yerbas', null::int),
    ('yerba-esmeralda', 'Esmeralda', 'yerbas', null::int),
    ('yerba-rei-verde-tradicional', 'Rei Verde Tradicional', 'yerbas', null::int),
    ('yerba-rei-verde-premium', 'Rei Verde Premium', 'yerbas', null::int),
    ('yerba-rei-verde-organica', 'Rei Verde Orgánica', 'yerbas', null::int),
    ('yerba-rei-verde-compuesta', 'Rei Verde Compuesta', 'yerbas', null::int),
    ('yerba-sara-tradicional', 'Sara Tradicional', 'yerbas', null::int),
    ('yerba-sara-extrasuave', 'Sara Extrasuave', 'yerbas', null::int),
    ('yerba-sara-esplendida', 'Sara Espléndida', 'yerbas', null::int),
    ('yerba-sara-coco', 'Sara Coco', 'yerbas', null::int),
    ('yerba-sara-curcuma-y-pimienta', 'Sara Cúrcuma y Pimienta', 'yerbas', null::int),
    ('yerba-sara-compuesta', 'Sara Compuesta', 'yerbas', null::int),
    ('yerba-barao', 'Barao', 'yerbas', null::int),
    ('yerba-verdecita', 'Verdecita', 'yerbas', null::int),
    ('yerba-pindare', 'Pindaré', 'yerbas', null::int),
    ('yerba-consentina-con-colageno', 'Consentina con Colágeno', 'yerbas', null::int),
    ('yerba-uruguay', 'Uruguay', 'yerbas', null::int),
    ('yerba-la-selva-para-nerviosos', 'La Selva para Nerviosos', 'yerbas', null::int),
    ('yerba-armino-clasica', 'Armiño Clásica', 'yerbas', null::int),
    ('yerba-armino-suave', 'Armiño Suave', 'yerbas', null::int),
    ('yerba-canabbis', 'Canabbis', 'yerbas', null::int),
    ('yerba-canarias-suave', 'Canarias Suave', 'yerbas', null::int)
),
exp_variants (product_slug, name, price, sheet_id) as (
  values
    ('mate-imperial', 'Único', 54300::numeric, null::int),
    ('mate-torpedo-alpaca', 'Único', 46800::numeric, null::int),
    ('mate-torpedo-cincelado', 'Único', 24350::numeric, null::int),
    ('mate-torpedo-aluminio', 'Único', 22780::numeric, null::int),
    ('mate-camionero-cincelado', 'Único', 22320::numeric, null::int),
    ('bombilla-uruguaya', 'Chica', 30720::numeric, null::int),
    ('bombilla-uruguaya', 'Mediana', 30720::numeric, null::int),
    ('bombilla-uruguaya', 'Grande', 30720::numeric, null::int),
    ('bombilla-con-resorte', 'Caño Redondo', 21360::numeric, null::int),
    ('bombilla-con-resorte', 'Caño Plano', 21360::numeric, null::int),
    ('mate-imperial-crudo', 'Único', 58340::numeric, null::int),
    ('mate-imperial-premium', 'Único', 71450::numeric, null::int),
    ('mate-tejido', 'Único', 46150::numeric, null::int),
    ('mate-porito', 'Único', 17470::numeric, null::int),
    ('mate-copita', 'Único', 22780::numeric, null::int),
    ('mate-camionero-alpaca', 'Único', 40560::numeric, null::int),
    ('mate-camionero-acero', 'Único', 30890::numeric, null::int),
    ('mate-camionero-aluminio', 'Único', 21220::numeric, null::int),
    ('termera-canasta-rigida-chica', 'Negro', 85340::numeric, null::int),
    ('termera-canasta-rigida-chica', 'Marrón', 85340::numeric, null::int),
    ('termera-canasta-rigida-chica', 'Azul', 85340::numeric, null::int),
    ('termera-canasta-rigida', 'Negro', 133080::numeric, null::int),
    ('termera-canasta-rigida', 'Marrón', 133080::numeric, null::int),
    ('termera-canasta-rigida', 'Azul', 133080::numeric, null::int),
    ('termera-canasta-rigida', 'Rojo', 133080::numeric, null::int),
    ('termera-canasta-rigida', 'Verde', 133080::numeric, null::int),
    ('termera-rigida-grande', 'Marrón', 165890::numeric, null::int),
    ('termera-rigida-grande', 'Negro', 165890::numeric, null::int),
    ('termera-rigida-grande', 'Suela', 165890::numeric, null::int),
    ('termera-rigida', 'Negro', 152760::numeric, null::int),
    ('termera-rigida', 'Marrón', 152760::numeric, null::int),
    ('termera-rigida', 'Azul', 152760::numeric, null::int),
    ('termera-rigida', 'Rojo', 152760::numeric, null::int),
    ('termera-mochila-cuero', 'Marrón', 171890::numeric, null::int),
    ('termera-mochila-cuero', 'Suela', 171890::numeric, null::int),
    ('bombillon-alpaca', 'Chica', 40320::numeric, null::int),
    ('bombillon-alpaca', 'Mediana', 40320::numeric, null::int),
    ('bombillon-alpaca', 'Grande', 40320::numeric, null::int),
    ('termera-mochila-lona', 'Cemento', 142870::numeric, null::int),
    ('termera-mochila-lona', 'Azul', 142870::numeric, null::int),
    ('termera-morral-cuero', 'Marrón', 171890::numeric, null::int),
    ('termera-morral-cuero', 'Suela', 171890::numeric, null::int),
    ('termera-morral-lona', 'Único', 142870::numeric, null::int),
    ('termera-doble-cierre', 'Negro', 166800::numeric, null::int),
    ('termera-doble-cierre', 'Suela Bridge', 166800::numeric, null::int),
    ('termera-canasta', 'Negro', 90340::numeric, null::int),
    ('termera-canasta', 'Marrón', 90340::numeric, null::int),
    ('termera-canasta', 'Suela', 90340::numeric, null::int),
    ('termera-canasta-chica', 'Negro', 84620::numeric, null::int),
    ('termera-canasta-chica', 'Marrón', 84620::numeric, null::int),
    ('termera-canasta-chica', 'Suela', 84620::numeric, null::int),
    ('termera-cartera', 'Negro', 145440::numeric, null::int),
    ('termera-cartera', 'Marrón', 145440::numeric, null::int),
    ('termera-cartera', 'Suela', 145440::numeric, null::int),
    ('yerbero-redondo-chico', 'Único', 23810::numeric, null::int),
    ('yerbero-redondo-grande', 'Único', 28580::numeric, null::int),
    ('yerbero-rectangular-grande', 'Único', 30550::numeric, null::int),
    ('yerbero-rectangular-mediano', 'Único', 26140::numeric, null::int),
    ('yerbero-rectangular-chico', 'Único', 24190::numeric, null::int),
    ('yerbero-grande-de-cuero', 'Negro', 30530::numeric, null::int),
    ('yerbero-grande-de-cuero', 'Marrón', 30530::numeric, null::int),
    ('yerbero-grande-de-cuero', 'Suela', 30530::numeric, null::int),
    ('yerbero-de-cuero', 'Negro', 22780::numeric, null::int),
    ('yerbero-de-cuero', 'Suela', 22780::numeric, null::int),
    ('yerbero-de-descarne', 'Marrón', 20500::numeric, null::int),
    ('yerbero-de-descarne', 'Óxido', 20500::numeric, null::int),
    ('yerbero-de-lona', 'Azul', 16010::numeric, null::int),
    ('yerbero-de-lona', 'Cemento', 16010::numeric, null::int),
    ('yerbero-de-lona', 'Verde', 16010::numeric, null::int),
    ('mate-imperial-roma', 'Único', 71450::numeric, null::int),
    ('cartera-termera-descarne', 'Chocolate', 92760::numeric, null::int),
    ('cartera-termera-descarne-chica', 'Único', 92760::numeric, null::int),
    ('bombillon-alpaca-punta-de-bronce', 'Único', 40320::numeric, null::int),
    ('yerba-canarias-tradicional', '500gr', 5600::numeric, 1::int),
    ('yerba-canarias-tradicional', '1kg', 11600::numeric, 2::int),
    ('yerba-canarias-serena', '500gr', 6700::numeric, 3::int),
    ('yerba-canarias-serena', '1kg', 12500::numeric, 4::int),
    ('yerba-canarias-ed-especial', '500gr', 6800::numeric, 5::int),
    ('yerba-canarias-ed-especial', '1kg', 12600::numeric, 6::int),
    ('yerba-canarias-te-verde-y-jengibre', '500gr', 6800::numeric, 7::int),
    ('yerba-canarias-te-verde-y-jengibre', '1kg', 12600::numeric, 8::int),
    ('yerba-canarias-te-rojo-y-centella', '1kg', 14000::numeric, 10::int),
    ('yerba-canarias-contigo', '1kg', 13200::numeric, 12::int),
    ('yerba-baldo', '500gr', 6200::numeric, 13::int),
    ('yerba-baldo', '1kg', 11300::numeric, 14::int),
    ('yerba-esmeralda', '1kg', 12000::numeric, 16::int),
    ('yerba-rei-verde-tradicional', '500gr', 5100::numeric, 17::int),
    ('yerba-rei-verde-tradicional', '1kg', 9700::numeric, 18::int),
    ('yerba-rei-verde-premium', '500gr', 6300::numeric, 19::int),
    ('yerba-rei-verde-premium', '1kg', 11600::numeric, 20::int),
    ('yerba-rei-verde-organica', '500gr', 6600::numeric, 21::int),
    ('yerba-rei-verde-compuesta', '500gr', 5300::numeric, 23::int),
    ('yerba-sara-tradicional', '500gr', 7500::numeric, 24::int),
    ('yerba-sara-tradicional', '1kg', 12400::numeric, 25::int),
    ('yerba-sara-extrasuave', '500gr', 7500::numeric, 26::int),
    ('yerba-sara-extrasuave', '1kg', 12400::numeric, 27::int),
    ('yerba-sara-esplendida', '1kg', 15300::numeric, 29::int),
    ('yerba-sara-coco', '500gr', 8000::numeric, 30::int),
    ('yerba-sara-curcuma-y-pimienta', '500gr', 8800::numeric, 32::int),
    ('yerba-sara-compuesta', '500gr', 8500::numeric, 34::int),
    ('yerba-sara-compuesta', '1kg', 11600::numeric, 35::int),
    ('yerba-barao', '500gr', 4900::numeric, 36::int),
    ('yerba-barao', '1kg', 8600::numeric, 37::int),
    ('yerba-verdecita', '500gr', 4100::numeric, 38::int),
    ('yerba-verdecita', '1kg', 7600::numeric, 39::int),
    ('yerba-pindare', '500gr', 4600::numeric, 40::int),
    ('yerba-pindare', '1kg', 8700::numeric, 41::int),
    ('yerba-consentina-con-colageno', '500gr', 6500::numeric, 42::int),
    ('yerba-consentina-con-colageno', '1kg', 12000::numeric, 43::int),
    ('yerba-uruguay', '500gr', 5100::numeric, 44::int),
    ('yerba-uruguay', '1kg', 8800::numeric, 45::int),
    ('yerba-la-selva-para-nerviosos', '1kg', 13600::numeric, 46::int),
    ('yerba-armino-clasica', '1kg', 13400::numeric, 47::int),
    ('yerba-armino-suave', '1kg', 13800::numeric, 48::int),
    ('yerba-canabbis', '1kg', 17400::numeric, 49::int),
    ('yerba-canarias-suave', '1kg', 13900::numeric, 51::int)
),
exp_images (product_slug, src) as (
  values
    ('mate-imperial', 'images/2329/varios-motivos.webp'),
    ('mate-torpedo-alpaca', 'images/2330/ambas-virolas.webp'),
    ('mate-torpedo-cincelado', 'images/2328/colores-varios.webp'),
    ('mate-torpedo-aluminio', 'images/2327/colores-varios.webp'),
    ('mate-camionero-cincelado', 'images/2306/colores-varios.webp'),
    ('bombilla-uruguaya', 'images/2300/medidas.webp'),
    ('bombilla-uruguaya', 'images/2300/a.webp'),
    ('bombilla-uruguaya', 'images/2300/b.webp'),
    ('bombilla-uruguaya', 'images/2300/c.webp'),
    ('bombilla-con-resorte', 'images/2295/detalle-dije.webp'),
    ('bombilla-con-resorte', 'images/2295/varios-motivos.webp'),
    ('bombilla-con-resorte', 'images/2295/varios-motivos.webp'),
    ('mate-imperial-crudo', 'images/2294/segunda.webp'),
    ('mate-imperial-premium', 'images/2293/portada.webp'),
    ('mate-tejido', 'images/2292/marron.webp'),
    ('mate-porito', 'images/2290/negro.webp'),
    ('mate-copita', 'images/2289/detalle.webp'),
    ('mate-camionero-alpaca', 'images/2287/suela-bridge.webp'),
    ('mate-camionero-acero', 'images/2286/negro.webp'),
    ('mate-camionero-aluminio', 'images/2285/colores-varios.webp'),
    ('termera-canasta-rigida-chica', 'images/2573/portada.webp'),
    ('termera-canasta-rigida-chica', 'images/2573/negro.webp'),
    ('termera-canasta-rigida-chica', 'images/2573/marron.webp'),
    ('termera-canasta-rigida-chica', 'images/2573/azul.webp'),
    ('termera-canasta-rigida', 'images/2572/negro.webp'),
    ('termera-canasta-rigida', 'images/2572/negro.webp'),
    ('termera-canasta-rigida', 'images/2572/azul.webp'),
    ('termera-canasta-rigida', 'images/2572/rojo.webp'),
    ('termera-canasta-rigida', 'images/2572/verde.webp'),
    ('termera-rigida-grande', 'images/2571/portada.webp'),
    ('termera-rigida-grande', 'images/2571/marron.webp'),
    ('termera-rigida-grande', 'images/2571/negro.webp'),
    ('termera-rigida-grande', 'images/2571/suela.webp'),
    ('termera-rigida', 'images/2570/portada.webp'),
    ('termera-rigida', 'images/2570/negro.webp'),
    ('termera-rigida', 'images/2570/marron.webp'),
    ('termera-rigida', 'images/2570/azul.webp'),
    ('termera-rigida', 'images/2570/rojo.webp'),
    ('termera-mochila-cuero', 'images/2569/colores-varios.webp'),
    ('termera-mochila-cuero', 'images/2569/chocolate.webp'),
    ('termera-mochila-cuero', 'images/2569/suela.webp'),
    ('bombillon-alpaca', 'images/2301/portada.webp'),
    ('bombillon-alpaca', 'images/2301/a.webp'),
    ('bombillon-alpaca', 'images/2301/b.webp'),
    ('bombillon-alpaca', 'images/2301/c.webp'),
    ('termera-mochila-lona', 'images/2568/colores-varios.webp'),
    ('termera-mochila-lona', 'images/2568/cemento.webp'),
    ('termera-mochila-lona', 'images/2568/azul.webp'),
    ('termera-morral-cuero', 'images/2565/portada.webp'),
    ('termera-morral-cuero', 'images/2565/chocolate.webp'),
    ('termera-morral-cuero', 'images/2565/suela.webp'),
    ('termera-morral-lona', 'images/2564/portada.webp'),
    ('termera-doble-cierre', 'images/2563/portada.webp'),
    ('termera-doble-cierre', 'images/2563/negro.webp'),
    ('termera-doble-cierre', 'images/2563/suela-bridge.webp'),
    ('termera-canasta', 'images/2562/chocolate.webp'),
    ('termera-canasta', 'images/2562/negro.webp'),
    ('termera-canasta', 'images/2562/chocolate.webp'),
    ('termera-canasta', 'images/2562/suela.webp'),
    ('termera-canasta-chica', 'images/2561/portada.webp'),
    ('termera-canasta-chica', 'images/2561/negro.webp'),
    ('termera-canasta-chica', 'images/2561/chocolate.webp'),
    ('termera-canasta-chica', 'images/2561/suela.webp'),
    ('termera-cartera', 'images/2555/portada.webp'),
    ('termera-cartera', 'images/2555/negro.webp'),
    ('termera-cartera', 'images/2555/chocolate.webp'),
    ('termera-cartera', 'images/2555/suela.webp'),
    ('yerbero-redondo-chico', 'images/2274/portada.webp'),
    ('yerbero-redondo-grande', 'images/2273/portada.webp'),
    ('yerbero-rectangular-grande', 'images/2272/marron.webp'),
    ('yerbero-rectangular-mediano', 'images/2271/marron.webp'),
    ('yerbero-rectangular-chico', 'images/2270/marron.webp'),
    ('yerbero-grande-de-cuero', 'images/2267/colores-varios.webp'),
    ('yerbero-grande-de-cuero', 'images/2267/negro.webp'),
    ('yerbero-grande-de-cuero', 'images/2267/chocolate.webp'),
    ('yerbero-grande-de-cuero', 'images/2267/suela.webp'),
    ('yerbero-de-cuero', 'images/2266/colores-varios.webp'),
    ('yerbero-de-cuero', 'images/2266/negro.webp'),
    ('yerbero-de-cuero', 'images/2266/suela.webp'),
    ('yerbero-de-descarne', 'images/2265/colores-varios.webp'),
    ('yerbero-de-descarne', 'images/2265/chocolate.webp'),
    ('yerbero-de-descarne', 'images/2265/oxido.webp'),
    ('yerbero-de-lona', 'images/2264/colores-varios.webp'),
    ('yerbero-de-lona', 'images/2264/azul.webp'),
    ('yerbero-de-lona', 'images/2264/cemento.webp'),
    ('yerbero-de-lona', 'images/2264/verde.webp'),
    ('mate-imperial-roma', 'images/2284/portada.webp'),
    ('cartera-termera-descarne', 'images/2552/portada.webp'),
    ('cartera-termera-descarne', 'images/2552/chocolate.webp'),
    ('cartera-termera-descarne-chica', 'images/2550/portada.webp'),
    ('bombillon-alpaca-punta-de-bronce', 'images/2302/portada.webp'),
    ('yerba-canarias-tradicional', 'images/yerbas/canariasTradicional.png'),
    ('yerba-canarias-contigo', 'images/yerbas/canariasContigo.png'),
    ('yerba-baldo', 'images/yerbas/baldo.png'),
    ('yerba-esmeralda', 'images/yerbas/esmeralda.png'),
    ('yerba-rei-verde-tradicional', 'images/yerbas/reiverdeTradicional.png'),
    ('yerba-sara-tradicional', 'images/yerbas/saraTradicional.png'),
    ('yerba-sara-extrasuave', 'images/yerbas/saraExtrasuave.png'),
    ('yerba-barao', 'images/yerbas/barao.png'),
    ('yerba-verdecita', 'images/yerbas/verdecita.png'),
    ('yerba-pindare', 'images/yerbas/pindare.png')
),
-- Producto real que corresponde a cada producto esperado.
matched as (
  select e.*,
         coalesce(
           (select pi.product_id from public.product_internal pi where pi.legacy_id = e.legacy_id),
           (select pv.product_id
              from exp_variants ev
              join public.variant_internal vi on vi.legacy_sheet_id = ev.sheet_id
              join public.product_variants pv on pv.id = vi.variant_id
             where ev.product_slug = e.slug
             limit 1),
           (select p.id from public.products p where p.slug = e.slug)
         ) as product_id
  from exp_products e
),
matched_variants as (
  select ev.*, m.product_id,
         coalesce(
           (select vi.variant_id from public.variant_internal vi where vi.legacy_sheet_id = ev.sheet_id),
           (select pv.id from public.product_variants pv
             where pv.product_id = m.product_id and pv.name = ev.name)
         ) as variant_id
  from exp_variants ev
  join matched m on m.slug = ev.product_slug
),
matched_images as (
  select ei.*, m.product_id,
         exists (select 1 from public.product_images im
                  where im.product_id = m.product_id and im.src = ei.src) as found
  from exp_images ei
  join matched m on m.slug = ei.product_slug
),
report (orden, seccion, clave, estado, detalle) as (
  -- ---------- Resumen ----------
  select 1, 'resumen', 'productos esperados', (select count(*) from exp_products)::text, ''
  union all
  select 2, 'resumen', 'productos encontrados', (select count(*) from matched where product_id is not null)::text,
         'faltan ' || (select count(*) from matched where product_id is null)
  union all
  select 3, 'resumen', 'productos en la base (total)', (select count(*) from public.products)::text,
         'publicados ' || (select count(*) from public.products where is_active)
         || ' · borradores ' || (select count(*) from public.products where not is_active)
  union all
  select 4, 'resumen', 'variantes esperadas', (select count(*) from exp_variants)::text, ''
  union all
  select 5, 'resumen', 'variantes encontradas', (select count(*) from matched_variants where variant_id is not null)::text,
         'faltan ' || (select count(*) from matched_variants where variant_id is null)
  union all
  select 6, 'resumen', 'variantes en la base (total)', (select count(*) from public.product_variants)::text,
         'activas ' || (select count(*) from public.product_variants where is_active)
         || ' · controlan stock ' || (select count(*) from public.product_variants where track_stock)
         || ' · con stock > 0 ' || (select count(*) from public.product_variants where stock > 0)
  union all
  select 7, 'resumen', 'imágenes esperadas', (select count(*) from exp_images)::text, ''
  union all
  select 8, 'resumen', 'imágenes encontradas', (select count(*) from matched_images where found)::text,
         'faltan ' || (select count(*) from matched_images where not found)
  union all
  select 9, 'resumen', 'imágenes en la base (total)', (select count(*) from public.product_images)::text,
         'en Storage ' || (select count(*) from public.product_images where src not like 'images/%')
         || ' · rutas del repo ' || (select count(*) from public.product_images where src like 'images/%')
  union all
  select 10, 'resumen', 'costos cargados', (select count(*) from public.variant_costs)::text, 'variantes con costo'
  union all
  select 11, 'resumen', 'movimientos de stock', (select count(*) from public.inventory_movements)::text, ''
  union all
  select 12, 'resumen', 'categorías', (select count(*) from public.categories)::text,
         (select string_agg(slug || case when is_active then '' else ' (inactiva)' end, ', ' order by sort_order)
            from public.categories)
  -- ---------- Detalle ----------
  union all
  select 100, 'falta producto', slug, 'no está en la base', category_slug || ' · ' || name
    from matched where product_id is null
  union all
  select 200, 'falta variante', product_slug || ' · ' || name,
         case when product_id is null then 'falta su producto' else 'no está en la base' end,
         'precio ' || price || coalesce(' · hoja ID ' || sheet_id, '')
    from matched_variants where variant_id is null
  union all
  select 300, 'falta imagen', product_slug, case when product_id is null then 'falta su producto' else 'no está en la base' end, src
    from matched_images where not found
  union all
  select 400, 'producto extra', p.slug, case when p.is_active then 'publicado' else 'borrador' end,
         'está en la base pero no en la importación · ' || p.name
    from public.products p
   where p.id not in (select product_id from matched where product_id is not null)
  union all
  select 500, 'publicado', p.slug, 'visible en la tienda', p.name
    from public.products p where p.is_active
)
select seccion, clave, estado, detalle
from report
order by orden, seccion, clave;
