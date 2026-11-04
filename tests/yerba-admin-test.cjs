// Panel: alta de presentaciones de yerbas (ej. Canarias Suave 500 g), yerba
// nueva, edición de presentaciones, importador por SKU de presentación.
// Supabase simulado en memoria (mock-sb.cjs) + guard.cjs: no escribe nada real.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5201";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = await serve(ROOT, 5201);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

  async function open(hash, st, vp = DESK) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await installMock(ctx, st);
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(mm.text())) errors.push(mm.text()); });
    page.on("dialog", (d) => d.accept());
    await page.goto(BASE + "/admin/" + hash);
    await ready(page);
    return { ctx, page, errors };
  }
  async function ready(page) {
    await page.waitForFunction(() => { const c = document.getElementById("adminContent"); return c && c.innerText.trim() && !/Cargando/.test(c.innerText); }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const text = (page, sel = "#adminContent") => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const toastText = (page) => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const posts = (st, frag) => st.calls.filter(([m, p]) => m === "POST" && p.includes(frag));

  // ---------- 1. Presentación nueva de una yerba existente (Canarias Suave 500 g) ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/nueva-yerba", st);
    const t = await text(page);
    check("alta: abre en «Presentación de una yerba existente»", /Presentación de una yerba existente/.test(t) && !!(await page.$('input[value="presentacion"]:checked')));
    await page.fill('input[aria-label="Buscar yerba"]', "suave");
    await page.waitForTimeout(150);
    const items = await page.$$eval(".pick-item", (b) => b.map((x) => x.innerText));
    check("buscador: «suave» encuentra solo Canarias Suave, con su presentación 1 kg", items.length === 1 && /Canarias Suave/.test(items[0]) && /1 kg/.test(items[0]), items.join(" | "));
    await page.fill('input[aria-label="Buscar yerba"]', "sara");
    await page.waitForTimeout(150);
    check("buscador: muestra también borradores (Sara Tradicional · Borrador)", /Borrador/.test(await text(page, ".pick-list")));
    await page.fill('input[aria-label="Buscar yerba"]', "canarias su");
    await page.waitForTimeout(150);
    await page.click('.pick-item[data-product="61"]');
    await page.waitForTimeout(200);
    check("elegida: la dirección recuerda la yerba (?producto=61)", (await page.evaluate(() => location.hash)).includes("producto=61"));
    const chips = await page.$$eval(".pres-chip", (b) => b.map((x) => ({ t: x.innerText.replace(/\s+/g, " "), dis: x.disabled, on: x.classList.contains("active") })));
    check("presentaciones: 1 kg deshabilitada («ya la tiene»)", chips.some((c) => /1 kg/.test(c.t) && c.dis && /ya la tiene/.test(c.t)), JSON.stringify(chips));
    check("presentaciones: 500 g elegida por defecto", chips.some((c) => /500 g/.test(c.t) && c.on && !c.dis));
    check("alta: aclara que reutiliza marca, fotos e imagen", /no se duplican/.test(await text(page)));
    await page.screenshot({ path: path.join(OUT, "alta-presentacion-escritorio.png"), fullPage: true });

    // Validaciones
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(200);
    check("validación: sin precio no se guarda", /precio de venta/i.test(await text(page, "#adminContent .form-error:not([hidden])")) && posts(st, "product_variants").length === 0);
    await page.fill('input[aria-label="SKU de la presentación"]', "2001");   // SKU de Canarias Tradicional 500 g
    await page.fill('input[aria-label="Precio de venta"]', "7.300");
    await page.fill('input[aria-label="Costo"]', "4900,50");
    await page.fill('input[aria-label="Stock inicial"]', "4");
    check("margen: se calcula en vivo", /Margen 33 %/.test(await text(page)), await text(page, ".margin-hint"));
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(800);
    check("validación: SKU de otra presentación → avisa a quién pertenece y no crea nada",
      /2001 ya lo usa «Canarias Tradicional · 500 g»/.test(await text(page, "#adminContent .form-error:not([hidden])")) && posts(st, "product_variants").length === 0, await text(page, "#adminContent .form-error:not([hidden])"));
    await page.fill('input[aria-label="SKU de la presentación"]', "M-1");   // SKU general del mate
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(800);
    check("validación: SKU de otro producto → avisa", /M-1 ya lo usa «Mate Imperial»/.test(await text(page, "#adminContent .form-error:not([hidden])")));
    await page.fill('input[aria-label="SKU de la presentación"]', "2101");
    await page.fill('input[aria-label="Stock inicial"]', "-2");
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(200);
    check("validación: stock negativo no", /stock inicial/i.test(await text(page, "#adminContent .form-error:not([hidden])")));
    await page.fill('input[aria-label="Stock inicial"]', "4");

    // Doble clic (con red lenta): una sola presentación, un solo stock inicial
    st.slow = 400;
    await page.evaluate(() => { const b = document.querySelector("#adminContent form button[type=submit]"); b.click(); b.click(); });
    await page.waitForFunction(() => location.hash.startsWith("#/productos/61"), null, { timeout: 20000 }).catch(() => {});
    st.slow = 0;
    await ready(page);
    const created = st.variants.filter((v) => v.product_id === 61);
    const v500 = created.find((v) => v.name === "500gr");
    check("guardado: una sola presentación nueva «500gr» en la MISMA yerba (61)", created.length === 2 && !!v500 && posts(st, "product_variants").length === 1, JSON.stringify(created));
    check("guardado: precio 7300 particular, visible, con control de stock", v500 && v500.price === 7300 && v500.price_inherited === false && v500.cost_inherited === false && v500.is_active && v500.track_stock);
    check("guardado: SKU propio 2101", st.variant_internal.some((r) => r.variant_id === v500?.id && r.sku === "2101"));
    check("guardado: costo propio 4900,50", st.variant_costs.some((c) => c.variant_id === v500?.id && c.cost === 4900.5));
    check("guardado: stock inicial 4 con UNA entrada «Stock inicial»", v500?.stock === 4 && st.inventory_movements.filter((x) => x.variant_id === v500.id).length === 1 && st.inventory_movements[0].reason === "Stock inicial");
    check("guardado: la 1 kg no cambia (precio, costo, stock)", st.variants.find((v) => v.id === 102).price === 13900 && st.variants.find((v) => v.id === 102).stock === 1 && st.variant_costs.find((c) => c.variant_id === 102).cost === 9000);
    check("guardado: no se creó otra yerba ni se tocaron sus datos", st.products.length === 4 && posts(st, "/products").length === 0);

    // Ficha de la yerba › Presentaciones
    check("ficha: abre en la pestaña «Presentaciones»", /Presentaciones/.test(await text(page, ".tabs .tab.active")), await text(page, ".tabs"));
    const cards = await page.$$eval(".variant-card", (c) => c.map((x) => x.querySelector(".pres-label").textContent));
    check("ficha: muestra 500 g y 1 kg (de menor a mayor)", cards.join(",") === "500 g,1 kg", cards.join(","));
    check("ficha: encabezado con marca y presentaciones", /Canarias · 500 g · 1 kg/.test(await text(page, ".page-sub")), await text(page, ".page-sub"));
    const skuVal = await page.$eval(`.variant-card[data-variant="${v500.id}"] input[aria-label^="SKU"]`, (i) => i.value);
    const skuPh = await page.$eval('.variant-card[data-variant="102"] input[aria-label^="SKU"]', (i) => i.placeholder);
    check("ficha: SKU propio en la 500 g; la 1 kg muestra el general como referencia", skuVal === "2101" && /General: 2100/.test(skuPh), `${skuVal} / ${skuPh}`);
    check("ficha: stock de la 500 g = 4", /Stock: 4/.test(await page.$eval(`.variant-card[data-variant="${v500.id}"]`, (c) => c.innerText)));
    check("sin errores de JavaScript (alta y ficha)", !errors.length, errors.join(" | "));

    // Editar la presentación
    await page.fill(`.variant-card[data-variant="${v500.id}"] input[aria-label^="Precio"]`, "7500");
    await page.fill(`.variant-card[data-variant="${v500.id}"] input[aria-label^="SKU"]`, "2102");
    await page.click(`.variant-card[data-variant="${v500.id}"] .variant-actions .btn-primary`);
    await page.waitForTimeout(1200);
    check("editar: precio y SKU de la 500 g guardados", st.variants.find((v) => v.id === v500.id).price === 7500 && st.variant_internal.find((r) => r.variant_id === v500.id).sku === "2102");
    await page.fill(`.variant-card[data-variant="${v500.id}"] input[aria-label="Presentación"]`, "1 kg");
    await page.click(`.variant-card[data-variant="${v500.id}"] .variant-actions .btn-primary`);
    await page.waitForTimeout(500);
    check("editar: no deja dos presentaciones del mismo peso", /Ya existe la presentación 1 kg/.test(await toastText(page)) && st.variants.find((v) => v.id === v500.id).name === "500gr", await toastText(page));
    await page.click(`.variant-card[data-variant="${v500.id}"] .variant-actions .btn-ghost`);   // descartar
    await page.waitForTimeout(600);
    await page.fill(`.variant-card[data-variant="${v500.id}"] input[aria-label^="SKU"]`, "2002");
    await page.click(`.variant-card[data-variant="${v500.id}"] .variant-actions .btn-primary`);
    await page.waitForTimeout(800);
    check("editar: SKU repetido de otra presentación → no se guarda", /2002 ya lo usa/.test(await toastText(page)) && st.variant_internal.find((r) => r.variant_id === v500.id).sku === "2102", await toastText(page));
    await page.click(`.variant-card[data-variant="${v500.id}"] .variant-actions .btn-ghost`);
    await page.waitForTimeout(600);

    // Agregar otra desde la ficha (Otra: 250 g)
    await page.click('button:has-text("Agregar presentación")');
    await page.waitForTimeout(200);
    const chips2 = await page.$$eval(".new-variant-card .pres-chip", (b) => b.map((x) => ({ t: x.innerText.replace(/\s+/g, " "), dis: x.disabled })));
    check("ficha › agregar: 500 g y 1 kg deshabilitadas", chips2.filter((c) => c.dis).length === 2, JSON.stringify(chips2));
    await page.click('.new-variant-card .pres-chip:has-text("Otra")');
    await page.fill('.new-variant-card input[aria-label="Otra presentación"]', "250 gramos");
    await page.fill('.new-variant-card input[aria-label="Precio de venta"]', "3900");
    await page.click('.new-variant-card button[type=submit]');
    await page.waitForTimeout(1500);
    const v250 = st.variants.find((v) => v.product_id === 61 && v.name === "250gr");
    check("ficha › agregar: «250 gramos» se guarda como 250gr, sin stock inicial (0, sin movimiento)", !!v250 && v250.stock === 0 && !st.inventory_movements.some((x) => x.variant_id === v250.id));
    check("ficha › agregar: aparece en la lista (3 presentaciones)", (await page.$$(".variant-card")).length === 3);

    // Ocultar una presentación
    await page.uncheck(`.variant-card[data-variant="${v250.id}"] input[type=checkbox]`);
    await page.click(`.variant-card[data-variant="${v250.id}"] .variant-actions .btn-primary`);
    await page.waitForTimeout(800);
    check("editar: ocultar una presentación (is_active false)", st.variants.find((v) => v.id === v250.id).is_active === false);
    check("sin errores de JavaScript (edición)", !errors.length, errors.join(" | "));
    await page.screenshot({ path: path.join(OUT, "ficha-presentaciones-escritorio.png"), fullPage: true });
    await ctx.close(); }

  // ---------- 2. Yerba nueva ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/nueva-yerba?modo=nueva", st);
    check("yerba nueva: abre el formulario de yerba nueva", /Datos de la yerba/.test(await text(page)));
    await page.fill('input[aria-label="Marca"]', "canarias");
    await page.dispatchEvent('input[aria-label="Marca"]', "change");
    await page.waitForTimeout(100);
    check("yerba nueva: la marca se escribe como la existente (Canarias) y sugiere el nombre", (await page.inputValue('input[aria-label="Marca"]')) === "Canarias" && (await page.inputValue('input[aria-label="Nombre"]')) === "Canarias ");
    await page.fill('input[aria-label="Nombre"]', "Canarias Suave");
    await page.waitForTimeout(100);
    check("yerba nueva: avisa si ya existe y ofrece agregarla como presentación", /Ya existe «Canarias Suave»/.test(await text(page, ".notice-warn")) && !!(await page.$('.notice-warn a[href*="producto=61"]')));
    await page.fill('input[aria-label="Nombre"]', "Canarias Hierbas Serranas");
    await page.waitForTimeout(100);
    check("yerba nueva: slug automático", (await page.inputValue('input[aria-label="Slug"]')) === "canarias-hierbas-serranas");
    await page.click('.pres-chip:has-text("1 kg")');
    await page.fill('input[aria-label="SKU de la presentación"]', "2300");
    await page.fill('input[aria-label="Precio de venta"]', "14500");
    await page.fill('input[aria-label="Stock inicial"]', "6");
    await page.setInputFiles('input.pres-file', { name: "pack.png", mimeType: "image/png", buffer: fs.readFileSync(path.join(__dirname, "test-pack.png")) });
    await page.waitForTimeout(600);
    check("yerba nueva: revisa la imagen elegida (medidas)", /pack\.png · 600 × 900 px/.test(await text(page)), await text(page, ".hint[role=status]"));
    await page.screenshot({ path: path.join(OUT, "yerba-nueva-escritorio.png"), fullPage: true });
    await page.click('#adminContent form button[type=submit]');
    await page.waitForFunction(() => /^#\/productos\/\d+/.test(location.hash), null, { timeout: 20000 }).catch(() => {});
    await ready(page);
    const pr = st.products.find((x) => x.name === "Canarias Hierbas Serranas");
    check("yerba nueva: producto en Yerbas con marca Canarias, en borrador", pr && pr.category_id === 5 && pr.brand === "Canarias" && pr.is_active === false, JSON.stringify(pr));
    const vs = st.variants.filter((v) => v.product_id === pr?.id);
    check("yerba nueva: primera presentación 1kg con SKU, precio y stock 6", vs.length === 1 && vs[0].name === "1kg" && vs[0].price === 14500 && vs[0].stock === 6 && st.variant_internal.some((r) => r.variant_id === vs[0].id && r.sku === "2300"));
    const up = st.uploads.find((u) => u.path.startsWith(`products/${pr?.id}/shelf-`));
    check("yerba nueva: imagen general de góndola subida a su carpeta (sin tocar otras)", !!up && st.uploads.length === 1 && pr.shelf_image?.includes(up.path), JSON.stringify(st.uploads));
    check("yerba nueva: lleva a su ficha", (await page.evaluate(() => location.hash)) === `#/productos/${pr?.id}?tab=precios`);
    check("yerba nueva: sin errores de JavaScript", !errors.length, errors.join(" | "));

    // Datos: marca editable
    await page.click('.tabs .tab:has-text("Datos")');
    const brand = await page.inputValue('input[list="product-brands"]');
    check("ficha › datos: campo Marca con el valor guardado", brand === "Canarias");
    await page.fill('input[list="product-brands"]', "rei verde");
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(1000);
    check("ficha › datos: marca cambiada (se guarda tal cual si no existe)", st.products.find((x) => x.id === pr.id).brand === "rei verde");
    await ctx.close(); }

  // ---------- 3. Desde «Nuevo producto» → Yerbas ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/nuevo", st);
    check("nuevo producto: ofrece el alta de yerbas", !!(await page.$('a[href="#/productos/nueva-yerba"]')));
    await page.selectOption("select.input", "5");
    await page.waitForTimeout(800);
    check("nuevo producto: al elegir «Yerbas» abre el alta de yerbas", (await page.evaluate(() => location.hash)).startsWith("#/productos/nueva-yerba"));
    await page.goto(BASE + "/admin/#/productos");
    await ready(page);
    check("productos: botón «Yerba o presentación»", !!(await page.$('a[href="#/productos/nueva-yerba"]')));
    check("sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 4. Un producto que no es yerba no cambia ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/2?tab=precios", st);
    check("mate: sigue con «Precios» (sin presentaciones ni marca)", /Precios/.test(await text(page, ".tabs")) && !/Presentaciones/.test(await text(page, ".tabs")) && !(await page.$(".pres-label")));
    check("mate: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 5. Celular ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/nueva-yerba?modo=presentacion&producto=61", st, PHONE);
    check("celular: alta sin desplazamiento horizontal", await noHScroll(page));
    const chipBox = await page.$eval(".pres-chip", (b) => b.getBoundingClientRect().height);
    check("celular: botones de presentación cómodos de tocar (≥ 44 px)", chipBox >= 44, String(chipBox));
    await page.screenshot({ path: path.join(OUT, "alta-presentacion-celular.png"), fullPage: true });
    await page.goto(BASE + "/admin/#/productos/61?tab=precios");
    await ready(page);
    check("celular: ficha de presentaciones sin desplazamiento horizontal", await noHScroll(page));
    await page.screenshot({ path: path.join(OUT, "ficha-presentaciones-celular.png"), fullPage: true });
    await page.goto(BASE + "/admin/#/productos/nueva-yerba?modo=nueva");
    await ready(page);
    check("celular: yerba nueva sin desplazamiento horizontal", await noHScroll(page));
    await page.screenshot({ path: path.join(OUT, "yerba-nueva-celular.png"), fullPage: true });
    check("celular: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 6. Falla de red a mitad del alta ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos/nueva-yerba?modo=presentacion&producto=61", st);
    await page.fill('input[aria-label="Precio de venta"]', "7300");
    await page.fill('input[aria-label="Stock inicial"]', "3");
    st.failNext = { path: "/rpc/admin_stock_movement", method: "POST" };   // la entrada de stock no llega
    await page.click('#adminContent form button[type=submit]');
    await page.waitForFunction(() => location.hash.startsWith("#/productos/61"), null, { timeout: 20000 }).catch(() => {});
    await ready(page);
    const v = st.variants.find((x) => x.product_id === 61 && x.name === "500gr");
    check("red: si falla el stock inicial, la presentación queda creada y avisa qué faltó", !!v && v.stock === 0 && /faltó guardar el stock inicial/.test(await toastText(page)), await toastText(page));
    check("red: sin otros errores de JavaScript (solo el corte simulado)", errors.every((x) => /Failed to fetch/.test(x)), errors.join(" | "));
    await ctx.close(); }

  // ---------- 7. Herramientas que listan presentaciones la ven sola ----------
  { const st = catalogState();
    st.variants.push({ id: 777, product_id: 61, name: "500gr", price: 7300, stock: 4, track_stock: true, is_active: true, sort_order: 1, price_inherited: false, cost_inherited: false, shelf_image: null });
    const { ctx, page, errors } = await open("#/stock-rapido", st);
    await page.fill(".picker input[type=search]", "suave");
    await page.waitForTimeout(300);
    const items = await page.$$eval(".pick-item", (b) => b.map((x) => x.innerText.replace(/\s+/g, " ")));
    check("stock rápido: Canarias Suave 500gr y 1kg disponibles", items.length === 2 && items.some((t) => /500gr/.test(t)) && items.some((t) => /1kg/.test(t)), items.join(" | "));
    await page.goto(BASE + "/admin/#/stock-rapido?tab=proveedor");
    await ready(page);
    const sp = await text(page);
    check("pedido a proveedor: la presentación nueva aparece en el armado", /Canarias Suave/.test(sp) && /500/.test(sp), sp.slice(0, 600));
    check("herramientas: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 8. Importador: SKU de presentación ----------
  { const st = catalogState();
    st.variants.push({ id: 777, product_id: 61, name: "500gr", price: 7300, stock: 4, track_stock: true, is_active: true, sort_order: 1, price_inherited: false, cost_inherited: false, shelf_image: null });
    st.variant_internal.push({ variant_id: 777, sku: "2101", legacy_sheet_id: null });
    st.variant_costs.push({ variant_id: 777, cost: 5000 });
    const { ctx, page, errors } = await open("#/importar-precios", st);
    const res = await page.evaluate(async () => {
      const m = await import("/admin/js/views/costImport.js");
      const products = [{ id: 61, name: "Canarias Suave", base_price: 13900 }, { id: 2, name: "Mate Imperial", base_price: 30000 }];
      const internals = new Map([[61, { sku: "2100", base_cost: 9000 }], [2, { sku: "M-1", base_cost: 20000 }]]);
      const variants = [{ id: 102, product_id: 61, name: "1kg", price: 13900, cost: 9000, price_inherited: true, cost_inherited: true }, { id: 777, product_id: 61, name: "500gr", price: 7300, cost: 5000, price_inherited: false, cost_inherited: false }, { id: 21, product_id: 2, name: "Único", price: 30000, cost: 20000, price_inherited: true, cost_inherited: true }];
      const rows = [["2100", "9500"], ["2101", "5200"], ["M-1", "20000"], ["9999", "100"]].map((cells, i) => ({ cells, row: i + 2 }));
      const a = m.analyzeRows({ rows, skuCol: 0, priceCol: 1, mode: "cost", products, internals, variants, variantSkus: new Map([[777, "2101"]]) });
      return { update: a.update.map((u) => [u.sku, u.product.id, u.variant?.id ?? null, u.before, u.value]), same: a.same.map((u) => u.sku), ignored: a.ignored.map((i) => i.sku) };
    });
    check("importador: SKU 2101 actualiza solo la presentación 500 g (5000 → 5200)", JSON.stringify(res.update.find((u) => u[0] === "2101")) === JSON.stringify(["2101", 61, 777, 5000, 5200]), JSON.stringify(res));
    check("importador: SKU 2100 sigue actualizando el general de la yerba", JSON.stringify(res.update.find((u) => u[0] === "2100")) === JSON.stringify(["2100", 61, null, 9000, 9500]));
    check("importador: sin cambios e ignorados como antes", res.same.join() === "M-1" && res.ignored.join() === "9999");
    check("importador: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
