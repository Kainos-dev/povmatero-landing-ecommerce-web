// Góndola: orden de góndolas, orden de yerbas y casilla «Otras marcas»
// (migración 20261113). Panel y /yerbas con Supabase simulado + guard.cjs:
// no escribe nada real.
//   node -r ./guard.cjs shelf-order-test.cjs .. shots
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState, SB } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5211";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });
const key = (t) => String(t ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "") || null;

// ---------- Estado del panel: catálogo de mock-sb + góndolas ----------
function shelfState({ migrated = true } = {}) {
  const st = catalogState();
  st.migrated = migrated;
  // Más yerbas: Canarias Serena (en «Otras marcas»), Sara Coco, Baldo, Pindaré (sin marca)
  st.products.push(
    { id: 70, category_id: 5, slug: "canarias-serena", name: "Canarias Serena", description: "", is_active: true, sort_order: 0, base_price: null, brand: "Canarias", shelf_image: null },
    { id: 71, category_id: 5, slug: "sara-coco", name: "Sara Coco", description: "", is_active: true, sort_order: 0, base_price: null, brand: "Sara", shelf_image: "https://gubrehbalkfvzwsndbcv.supabase.co/storage/v1/object/public/product-images/products/71/shelf-1.png" },
    { id: 72, category_id: 5, slug: "baldo", name: "Baldo Tradicional", description: "", is_active: true, sort_order: 0, base_price: null, brand: "Baldo", shelf_image: null },
    { id: 73, category_id: 5, slug: "pindare", name: "Pindaré", description: "", is_active: true, sort_order: 0, base_price: null, brand: null, shelf_image: null },
  );
  st.variants.push(
    { id: 700, product_id: 70, name: "500gr", price: 6000, stock: 3, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
    { id: 710, product_id: 71, name: "1kg", price: 9000, stock: 3, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
    { id: 720, product_id: 72, name: "1kg", price: 11000, stock: 3, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
    { id: 730, product_id: 73, name: "500gr", price: 4500, stock: 3, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
  );
  const place = { 3: 1, 61: 2, 46: 1, 70: 3, 71: 2, 72: 1, 73: 1, 2: 1 };
  for (const p of st.products) { p.shelf_other = p.id === 70; p.shelf_position = place[p.id] ?? 1; }
  st.shelf_brands = [
    { key: "canarias", name: "Canarias", position: 1 },
    { key: "sara", name: "Sara", position: 2 },
    { key: "baldo", name: "Baldo", position: 3 },
    { key: "armino", name: "Armiño", position: 4 },   // sin yerbas: no tiene góndola
  ];
  st.rpc = [];
  return st;
}
const groupOf = (p) => (p.shelf_other || !key(p.brand) ? "" : key(p.brand));

// Reglas de la base que simula el mock (trigger y funciones de orden).
function extra({ p, m, url, body, json, err, rows, st }) {
  const sel = url.searchParams.get("select") ?? "";
  if (!st.migrated) {
    if (p === "/rest/v1/shelf_brands") return err(404, "PGRST205", "Could not find the table 'public.shelf_brands' in the schema cache");
    if (p === "/rest/v1/products" && m === "GET" && /shelf_other|shelf_position/.test(sel)) return err(400, "42703", "column products.shelf_other does not exist");
    if (p === "/rest/v1/products" && (m === "POST" || m === "PATCH") && "shelf_other" in (body() ?? {})) return err(400, "PGRST204", "Could not find the 'shelf_other' column of 'products' in the schema cache");
    return undefined;
  }
  if (p === "/rest/v1/shelf_brands") return rows(st.shelf_brands.slice().sort((a, b) => a.position - b.position));
  if (p === "/rest/v1/products" && (m === "POST" || m === "PATCH")) {
    // Trigger: marca registrada y lugar al final al crear o cambiar de góndola.
    const b = body() ?? {};
    const canon = (brand) => {
      if (brand == null) return null;
      const k = key(brand);
      let row = st.shelf_brands.find((x) => x.key === k);
      if (!row) { row = { key: k, name: brand.trim().replace(/\s+/g, " "), position: Math.max(0, ...st.shelf_brands.map((x) => x.position)) + 1 }; st.shelf_brands.push(row); }
      return row.name;
    };
    const end = (prod) => Math.max(0, ...st.products.filter((x) => x !== prod && x.category_id === prod.category_id && groupOf(x) === groupOf(prod)).map((x) => x.shelf_position)) + 1;
    if (m === "POST") {
      if (st.products.some((x) => x.slug === b.slug)) return err(409, "23505", 'duplicate key value violates unique constraint "products_slug_key"');
      const row = { id: st.nextId++, description: "", is_active: false, sort_order: 0, base_price: null, brand: null, shelf_image: null, shelf_other: false, ...b };
      row.brand = canon(row.brand);
      row.shelf_position = end(row);
      st.products.push(row);
      return rows([{ id: row.id }], 201);
    }
    const id = Number((url.searchParams.get("id") ?? "").replace("eq.", ""));
    const prod = st.products.find((x) => x.id === id);
    if (!prod) return rows([]);
    const before = groupOf(prod);
    Object.assign(prod, b);
    if ("brand" in b) prod.brand = canon(b.brand);
    if (groupOf(prod) !== before) prod.shelf_position = end(prod);
    return rows([{ id: prod.id, shelf_image: prod.shelf_image }]);
  }
  if (p === "/rest/v1/rpc/admin_set_shelf_brand_order") {
    const a = body();
    st.rpc.push(["brands", a]);
    const current = st.shelf_brands.slice().sort((x, y) => x.position - y.position).map((x) => x.key);
    if (JSON.stringify(a.expected_keys) !== JSON.stringify(current)) return err(400, "23514", "Otro administrador cambió las marcas mientras ordenabas.", "stale_order");
    a.brand_keys.forEach((k, i) => { st.shelf_brands.find((x) => x.key === k).position = i + 1; });
    return json({ keys: a.brand_keys, changed: 1 });
  }
  if (p === "/rest/v1/rpc/admin_set_shelf_product_order") {
    const a = body();
    st.rpc.push(["products", a]);
    const current = st.products.filter((x) => x.category_id === 5 && groupOf(x) === a.group_key).sort((x, y) => x.shelf_position - y.shelf_position || x.id - y.id).map((x) => x.id);
    if (JSON.stringify(a.expected_ids) !== JSON.stringify(current)) return err(400, "23514", "Otro administrador cambió esta góndola mientras ordenabas.", "stale_order");
    a.product_ids.forEach((id, i) => { st.products.find((x) => x.id === id).shelf_position = i + 1; });
    return json({ group_key: a.group_key, ids: a.product_ids, changed: 1 });
  }
  return undefined;
}

// ---------- Catálogo de /yerbas (vista storefront_catalog) ----------
const row = (o) => ({ description: "", category_slug: "yerbas", category_name: "Yerbas", cover_image: null, track_stock: true, variant_image: null, product_sort: 0, variant_sort: 0, shelf_image: null, variant_shelf_image: null, stock: 5, ...o });
const NEW_ROWS = [
  // Sara primero por el orden del panel; Canarias después; «Otras marcas» al final.
  row({ product_id: 10, product_slug: "canarias-serena", product_name: "Canarias Serena", brand: "Canarias", variant_id: 101, variant_name: "500gr", price: 7000, shelf_other: false, shelf_position: 2, brand_position: 2 }),
  row({ product_id: 10, product_slug: "canarias-serena", product_name: "Canarias Serena", brand: "Canarias", variant_id: 102, variant_name: "1kg", price: 13000, variant_sort: 1, shelf_other: false, shelf_position: 2, brand_position: 2 }),
  row({ product_id: 11, product_slug: "canarias-tradicional", product_name: "Canarias Tradicional", brand: "Canarias", variant_id: 111, variant_name: "1kg", price: 12000, shelf_other: false, shelf_position: 1, brand_position: 2 }),
  row({ product_id: 12, product_slug: "canarias-especial", product_name: "Canarias Especial", brand: "Canarias", variant_id: 121, variant_name: "1kg", price: 15000, shelf_other: true, shelf_position: 1, brand_position: 2 }),
  row({ product_id: 30, product_slug: "sara-coco", product_name: "Sara Coco", brand: "Sara", variant_id: 301, variant_name: "500gr", price: 5000, shelf_other: false, shelf_position: 1, brand_position: 1 }),
  row({ product_id: 40, product_slug: "pindare", product_name: "Pindaré", brand: null, variant_id: 401, variant_name: "500gr", price: 4500, shelf_other: false, shelf_position: 2, brand_position: null }),
  row({ product_id: 50, product_slug: "kurupi", product_name: "Kurupí Menta", brand: "Kurupí", variant_id: 501, variant_name: "500gr", price: 5500, shelf_other: false, shelf_position: 1, brand_position: 3 }),
];
// Sin la migración la vista no tiene esas columnas (y la consulta con ellas da 400).
const OLD_ROWS = NEW_ROWS.map(({ shelf_other, shelf_position, brand_position, ...r }) => r);

(async () => {
  const srv = await serve(ROOT, 5211);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const DESK = { width: 1440, height: 900 }, TABLET = { width: 820, height: 1180 }, PHONE = { width: 390, height: 844 };

  async function openAdmin(hash, st, vp = DESK) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await installMock(ctx, st, { extra });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(mm.text())) errors.push(mm.text()); });
    await page.goto(BASE + "/admin/" + hash);
    await ready(page);
    return { ctx, page, errors };
  }
  async function ready(page) {
    await page.waitForFunction(() => { const c = document.getElementById("adminContent"); return c && c.innerText.trim() && !/Cargando/.test(c.innerText); }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
  const text = (page, sel = "#adminContent") => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const names = (page) => page.$$eval(".so-list .so-row .so-name", (els) => els.map((e) => e.textContent));
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const toastText = (page) => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  const saveBarVisible = (page) => page.evaluate(() => { const b = document.querySelector(".so-savebar"); return !!b && !b.hidden; });

  // Arrastrar con el mouse desde el asa de la fila «from» hasta la fila «to».
  async function drag(page, fromName, toName) {
    const box = async (n) => page.evaluate((name) => {
      const li = [...document.querySelectorAll(".so-list .so-row")].find((r) => r.querySelector(".so-name").textContent === name);
      const g = li.querySelector(".so-grip").getBoundingClientRect(), r = li.getBoundingClientRect();
      return { gx: g.x + g.width / 2, gy: g.y + g.height / 2, top: r.top, h: r.height };
    }, n);
    const a = await box(fromName), b = await box(toName);
    await page.mouse.move(a.gx, a.gy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(a.gx, a.gy + ((b.top + 4) - a.gy) * (i / 8));
    await page.mouse.up();
    await page.waitForTimeout(200);
  }

  // =================== /yerbas ===================
  async function openStore(rowsFor, vp = DESK) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript(() => localStorage.setItem("povmatero-no-track", "1"));
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    const urls = [];
    await ctx.route(SB + "/rest/v1/**", (route) => {
      const u = new URL(route.request().url());
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      if (u.pathname === "/rest/v1/storefront_catalog") { urls.push(u.searchParams.get("select")); return rowsFor(u.searchParams.get("select") ?? "", json); }
      return json([]);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/yerbas");
    await page.waitForSelector(".y-item", { timeout: 20000 });
    await page.waitForTimeout(700);
    return { ctx, page, errors, urls };
  }
  const tabs = (page) => page.$$eval(".y-tab", (t) => t.map((x) => x.textContent.trim()));
  const shelfIds = (page, name) => page.evaluate((n) => [...document.querySelectorAll(`.y-gondola[aria-label="${n}"] .y-item`)].map((i) => Number(i.dataset.product)), name);

  { // Con la migración: orden del panel
    const { ctx, page, errors, urls } = await openStore((sel, json) => json(NEW_ROWS));
    check("/yerbas: pide las columnas de orden", /shelf_position/.test(urls[0] ?? ""), urls[0]);
    check("/yerbas: pestañas en el orden del panel, «Otras marcas» al final", (await tabs(page)).join(",") === "Sara,Canarias,Kurupí,Otras marcas", (await tabs(page)).join(","));
    check("/yerbas: dentro de Canarias, el lugar del panel (Tradicional, Serena)", JSON.stringify(await shelfIds(page, "Canarias")) === "[11,10]", JSON.stringify(await shelfIds(page, "Canarias")));
    check("/yerbas: Canarias Especial (casilla) va a «Otras marcas», primera", JSON.stringify(await shelfIds(page, "Otras marcas")) === "[12,40]", JSON.stringify(await shelfIds(page, "Otras marcas")));
    const serena = await page.$$eval('.y-item[data-product="10"] .y-variant', (b) => b.length);
    check("/yerbas: 500 g y 1 kg de Canarias Serena juntas en un solo lugar", serena === 2);
    const n = await page.$eval('.y-gondola[aria-label="Canarias"] .y-gondola-head p', (e) => e.textContent);
    check("/yerbas: Canarias cuenta 2 variedades (sin la que está en Otras marcas)", /2 variedades/.test(n), n);
    const otherName = await page.$eval('.y-item[data-product="12"] .y-item-name', (e) => e.textContent);
    check("/yerbas: en «Otras marcas» se ve el nombre completo", /Canarias Especial/.test(otherName), otherName);
    // Carrito: agregar desde «Otras marcas»
    await page.click('.y-tab:has-text("Otras marcas")');
    await page.waitForTimeout(700);
    await page.click('.y-variant[data-variant="121"]');
    await page.waitForSelector(".y-presentations");
    await page.click('.y-pres[data-variant="121"] [data-step="1"]');
    await page.click("[data-add]");
    await page.waitForTimeout(1200);
    check("/yerbas: el carrito suma la yerba de «Otras marcas»", /1/.test(await page.$eval("#cartDock", (e) => e.innerText)), await page.$eval("#cartDock", (e) => e.innerText));
    // Pestañas y deslizamiento
    await page.click('.y-tab:has-text("Sara")');
    await page.waitForTimeout(700);
    check("/yerbas: las pestañas siguen navegando", await page.$eval(".y-tab.active, .y-tab[aria-selected=true], .y-tab[aria-current]", (t) => t.textContent.trim()).catch(() => "") === "Sara");
    check("/yerbas: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await page.screenshot({ path: path.join(OUT, "yerbas-orden-escritorio.png") });
    await ctx.close();
  }
  { // Sin la migración: igual que antes
    const { ctx, page, errors, urls } = await openStore((sel, json) => /shelf_position/.test(sel) ? json({ code: "42703", message: "column storefront_catalog.shelf_position does not exist" }, 400) : json(OLD_ROWS));
    check("/yerbas sin migración: reintenta sin las columnas nuevas", urls.length >= 2 && !/shelf_position/.test(urls[1]));
    check("/yerbas sin migración: orden de siempre (Canarias, Sara, Kurupí, Otras marcas)", (await tabs(page)).join(",") === "Canarias,Sara,Kurupí,Otras marcas", (await tabs(page)).join(","));
    check("/yerbas sin migración: Canarias Especial sigue en Canarias", (await shelfIds(page, "Canarias")).includes(12));
    check("/yerbas sin migración: sin errores", !errors.length, errors.join(" | "));
    await ctx.close();
  }
  { // Celular
    const { ctx, page, errors } = await openStore((sel, json) => json(NEW_ROWS), PHONE);
    check("/yerbas celular: mismo orden de pestañas", (await tabs(page)).join(",") === "Sara,Canarias,Kurupí,Otras marcas");
    // Deslizar a la siguiente góndola
    const before = await page.evaluate(() => document.querySelector(".y-track").scrollLeft);
    await page.evaluate(() => { const t = document.querySelector(".y-track"); t.scrollBy({ left: t.clientWidth, behavior: "instant" }); });
    await page.waitForTimeout(800);
    check("/yerbas celular: se desliza entre góndolas", (await page.evaluate(() => document.querySelector(".y-track").scrollLeft)) > before);
    check("/yerbas celular: sin desplazamiento horizontal de la página", await noHScroll(page));
    check("/yerbas celular: sin errores", !errors.length, errors.join(" | "));
    await page.screenshot({ path: path.join(OUT, "yerbas-orden-celular.png") });
    await ctx.close();
  }

  // =================== Panel: Ordenar góndolas ===================
  { const st = shelfState();
    const { ctx, page, errors } = await openAdmin("#/gondola", st);
    const seg = await page.$$eval(".segmented a", (a) => a.map((x) => x.innerText.trim()));
    check("panel: «Góndola» con pestañas Imágenes · Ordenar góndolas · Ordenar yerbas", seg.join(",") === "Imágenes,Ordenar góndolas,Ordenar yerbas", seg.join(","));
    check("panel: Imágenes sigue funcionando (tarjetas de yerbas)", (await page.$$(".shelf-card")).length > 0);
    check("panel: el menú dice «Góndola»", await page.$eval('[data-nav][href="#/gondola"]', (a) => a.textContent.trim()) === "Góndola");
    await page.click('.segmented a:has-text("Ordenar góndolas")');
    await ready(page);
    check("góndolas: lista en el orden guardado", (await names(page)).join(",") === "Canarias,Sara,Baldo,Armiño", (await names(page)).join(","));
    const fixed = await text(page, ".so-row-fixed");
    check("góndolas: «Otras marcas» fija al final, sin botones para moverla", /Otras marcas/.test(fixed) && /Siempre al final/.test(fixed) && (await page.$$(".so-row-fixed .so-btn")).length === 0);
    check("góndolas: la marca sin yerbas avisa que no se muestra", /Sin yerbas: no se muestra/.test(await text(page, '.so-row[data-id="armino"]')));
    check("góndolas: cuenta las que fueron a «Otras marcas»", /1 en «Otras marcas»/.test(await text(page, '.so-row[data-id="canarias"]')), await text(page, '.so-row[data-id="canarias"]'));
    const chips = () => page.$$eval(".so-tabs-preview .so-chip", (c) => c.map((x) => x.textContent));
    check("góndolas: vista previa = pestañas de /yerbas (sin Armiño ni vacías)", (await chips()).join(",") === "Canarias,Sara,Baldo,Otras marcas", (await chips()).join(","));
    check("góndolas: sin cambios no hay barra de guardar", !(await saveBarVisible(page)));
    await page.click('button[aria-label="Bajar Canarias"]');
    await page.waitForTimeout(150);
    check("góndolas: «Bajar» mueve una posición", (await names(page)).join(",") === "Sara,Canarias,Baldo,Armiño");
    check("góndolas: el foco queda en el botón de la fila movida", await page.evaluate(() => document.activeElement?.getAttribute("aria-label")) === "Bajar Canarias");
    check("góndolas: la vista previa se actualiza antes de guardar", (await chips()).join(",") === "Sara,Canarias,Baldo,Otras marcas");
    check("góndolas: aparece «Guardar orden»", await saveBarVisible(page));
    await page.click('.so-savebar button:has-text("Descartar")');
    await page.waitForTimeout(150);
    check("góndolas: «Descartar» vuelve al orden guardado", (await names(page)).join(",") === "Canarias,Sara,Baldo,Armiño" && !(await saveBarVisible(page)));
    await drag(page, "Baldo", "Canarias");
    check("góndolas: arrastrar Baldo arriba de Canarias", (await names(page)).join(",") === "Baldo,Canarias,Sara,Armiño", (await names(page)).join(","));
    await page.screenshot({ path: path.join(OUT, "panel-ordenar-gondolas.png"), fullPage: true });
    await page.click('.so-savebar button:has-text("Guardar orden")');
    await page.waitForTimeout(600);
    const call = st.rpc.find((r) => r[0] === "brands")?.[1];
    check("góndolas: guarda con la función (orden nuevo + el que tenía a la vista)", call && call.brand_keys.join() === "baldo,canarias,sara,armino" && call.expected_keys.join() === "canarias,sara,baldo,armino", JSON.stringify(call));
    check("góndolas: quedó guardado y avisa", st.shelf_brands.find((b) => b.key === "baldo").position === 1 && /guardado/.test(await toastText(page)) && !(await saveBarVisible(page)));
    // Otro administrador cambia el orden mientras tanto
    st.shelf_brands.find((b) => b.key === "sara").position = 0;
    await page.click('button[aria-label="Subir Armiño"]');
    await page.click('.so-savebar button:has-text("Guardar orden")');
    await page.waitForTimeout(600);
    check("góndolas: si otro admin cambió el orden, no lo pisa y pide recargar", /Otro administrador cambió/.test(await text(page, ".so-error")) && st.shelf_brands.find((b) => b.key === "armino").position === 4);
    await page.click('.so-error button:has-text("Recargar")');
    await ready(page);
    check("góndolas: «Recargar» muestra el orden actual", (await names(page))[0] === "Sara", (await names(page)).join(","));
    check("góndolas: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // =================== Panel: Ordenar yerbas ===================
  { const st = shelfState();
    const { ctx, page, errors } = await openAdmin("#/gondola?tab=yerbas", st);
    const groups = await page.$$eval(".so-group", (g) => g.map((x) => x.innerText.replace(/\s+/g, " ")));
    check("yerbas: góndolas para elegir, «Otras marcas» al final (con cantidad)", groups.join("|") === "Canarias 2|Sara 2|Baldo 1|Otras marcas 2", groups.join("|"));
    check("yerbas: abre Canarias en el orden guardado (Tradicional, Suave)", (await names(page)).join(",") === "Canarias Tradicional,Canarias Suave", (await names(page)).join(","));
    check("yerbas: muestra presentaciones juntas (500 g · 1 kg) en una sola fila", /500 g · 1 kg/.test(await text(page, '.so-row[data-id="3"]')));
    await page.click('.so-group:has-text("Sara")');
    await ready(page);
    check("yerbas: Sara (borrador marcado, foto de góndola)", /Borrador/.test(await text(page, '.so-row[data-id="46"]')) && (await page.$$('.so-row[data-id="71"] .so-thumb img')).length === 1);
    check("yerbas: la vista previa muestra solo las publicadas", (await page.$$eval(".so-shelf .so-pack", (p) => p.length)) === 1);
    check("yerbas: la dirección recuerda la góndola", (await page.evaluate(() => location.hash)).includes("g=sara"));
    await page.click('button[aria-label="Subir Sara Coco"]');
    await page.waitForTimeout(150);
    // Cambiar de góndola con cambios sin guardar → pregunta
    await page.click('.so-group:has-text("Otras marcas")');
    await page.waitForTimeout(150);
    check("yerbas: cambiar de góndola con cambios sin guardar pregunta antes", /Tenés cambios sin guardar en Sara/.test(await text(page, ".confirm-box")));
    await page.click('.confirm-box button:has-text("Seguir ordenando")');
    await page.click('.so-savebar button:has-text("Guardar orden")');
    await page.waitForTimeout(600);
    let call = st.rpc.find((r) => r[0] === "products")?.[1];
    check("yerbas: guarda Sara (Coco primero) con el orden que tenía a la vista", call && call.group_key === "sara" && call.product_ids.join() === "71,46" && call.expected_ids.join() === "46,71", JSON.stringify(call));
    check("yerbas: no tocó precios, stock ni imágenes", st.calls.every(([m, p]) => !/product_variants|variant_costs|inventory|storage|product_images/.test(p)), JSON.stringify(st.calls.map((c) => c[1])));
    await page.click('.so-group:has-text("Otras marcas")');
    await ready(page);
    const other = await text(page, ".so-list");
    check("yerbas: «Otras marcas» junta marcas distintas y muestra la marca real", /Pindaré/.test(other) && /Canarias Serena/.test(other) && /Marca Canarias/.test(other), other);
    await drag(page, "Canarias Serena", "Pindaré");
    await page.click('.so-savebar button:has-text("Guardar orden")');
    await page.waitForTimeout(600);
    call = st.rpc.filter((r) => r[0] === "products").at(-1)[1];
    check("yerbas: «Otras marcas» se guarda con la clave vacía", call.group_key === "" && call.product_ids.join() === "70,73", JSON.stringify(call));
    await page.screenshot({ path: path.join(OUT, "panel-ordenar-yerbas.png"), fullPage: true });
    check("yerbas: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // =================== Casilla «Otras marcas» ===================
  { const st = shelfState();
    const { ctx, page, errors } = await openAdmin("#/productos/3", st);
    await page.waitForSelector('[data-field="shelf-other"]', { timeout: 10000 }).catch(() => {});
    const box = await page.$('[data-field="shelf-other"]');
    check("ficha (yerba con 2 presentaciones): casilla «Otras marcas» desmarcada", !!box && !(await box.isChecked()));
    check("ficha: explica a qué góndola va", /Se muestra en la góndola Canarias/.test(await text(page)));
    await box.check();
    check("ficha: al marcarla explica que conserva la marca", /Se muestra en «Otras marcas». La marca Canarias se conserva/.test(await text(page)));
    await page.fill('input[list="product-brands"]', "  canárias ");
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(800);
    const patch = st.calls.filter(([m, p]) => m === "PATCH" && p.includes("/products")).at(-1)?.[2];
    check("ficha: guarda shelf_other = true y no cambia la marca («canárias» = Canarias)", patch && patch.shelf_other === true && !("brand" in patch), JSON.stringify(patch));
    const prod = st.products.find((x) => x.id === 3);
    check("ficha: la yerba (con sus 2 presentaciones) pasó a «Otras marcas», al final", prod.shelf_other && prod.brand === "Canarias" && prod.shelf_position === 4, JSON.stringify(prod));
    await ready(page);
    const box2 = await page.waitForSelector('[data-field="shelf-other"]');
    await box2.uncheck();
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(800);
    check("ficha: desmarcarla la devuelve a Canarias (al final)", !prod.shelf_other && prod.shelf_position === 3, JSON.stringify(prod));
    check("ficha: ningún cambio en presentaciones", !st.calls.some(([m, p]) => m !== "GET" && /product_variants|variant_costs|inventory/.test(p)));
    check("ficha: sin errores", !errors.length, errors.join(" | "));
    await ctx.close();
  }
  { const st = shelfState();
    const { ctx, page, errors } = await openAdmin("#/productos/nueva-yerba?modo=nueva", st);
    const box = await page.waitForSelector('[data-field="shelf-other"]', { timeout: 10000 }).catch(() => null);
    check("alta: casilla «Otras marcas» disponible", !!box);
    await page.fill('input[aria-label="Marca"]', "Kurupí");
    await page.dispatchEvent('input[aria-label="Marca"]', "change");
    await page.fill('input[aria-label="Nombre"]', "Kurupí Menta");
    await page.dispatchEvent('input[aria-label="Nombre"]', "input");
    await box.check();
    await page.fill('input[aria-label="Precio de venta"]', "5500");
    await page.click('#adminContent form button[type=submit]');
    await page.waitForFunction(() => /#\/productos\/\d+/.test(location.hash), null, { timeout: 15000 }).catch(() => {});
    const post = st.calls.find(([m, p]) => m === "POST" && /\/products(\?|$)/.test(p))?.[2];
    check("alta: crea la yerba con shelf_other = true y la marca nueva", post && post.shelf_other === true && post.brand === "Kurupí", JSON.stringify(post));
    check("alta: la marca nueva queda al final del orden de góndolas", st.shelf_brands.at(-1).name === "Kurupí" && st.shelf_brands.at(-1).position === 5);
    check("alta: una sola yerba creada", st.products.filter((x) => x.name === "Kurupí Menta").length === 1);
    check("alta: sin errores", !errors.length, errors.join(" | "));
    await ctx.close();
  }
  { // Marca existente escrita distinto en el alta
    const st = shelfState();
    const { ctx, page } = await openAdmin("#/productos/nueva-yerba?modo=nueva", st);
    await page.fill('input[aria-label="Marca"]', "SARA ");
    await page.dispatchEvent('input[aria-label="Marca"]', "change");
    await page.waitForTimeout(100);
    check("alta: «SARA » se corrige a la marca existente «Sara»", await page.$eval('input[aria-label="Marca"]', (i) => i.value) === "Sara");
    await ctx.close();
  }

  // =================== Sin la migración: todo como antes ===================
  { const st = shelfState({ migrated: false });
    let { ctx, page, errors } = await openAdmin("#/productos/3", st);
    await page.waitForTimeout(600);
    check("sin migración: la ficha no muestra la casilla y no da error", !(await page.$('[data-field="shelf-other"]')) && !errors.length, errors.join(" | "));
    await page.click('#adminContent form button[type=submit]');
    await page.waitForTimeout(600);
    check("sin migración: guardar la ficha funciona (sin shelf_other)", /Cambios guardados/.test(await toastText(page)));
    await ctx.close();
    ({ ctx, page, errors } = await openAdmin("#/productos/nueva-yerba?modo=nueva", st));
    check("sin migración: el alta no muestra la casilla", !(await page.$('[data-field="shelf-other"]')));
    await ctx.close();
    ({ ctx, page, errors } = await openAdmin("#/gondola?tab=gondolas", st));
    check("sin migración: «Ordenar góndolas» explica qué migración falta", /20261113000000_shelf_order\.sql/.test(await text(page)));
    await page.click('.segmented a:has-text("Imágenes")');
    await ready(page);
    check("sin migración: Imágenes sigue funcionando", (await page.$$(".shelf-card")).length > 0 && !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // =================== Arrastre con el dedo (celular) ===================
  { const st = shelfState();
    const { ctx, page, errors } = await openAdmin("#/gondola?tab=gondolas", st, PHONE);
    const cdp = await ctx.newCDPSession(page);
    const pt = (n) => page.evaluate((name) => {
      const li = [...document.querySelectorAll(".so-list .so-row")].find((r) => r.querySelector(".so-name").textContent === name);
      const g = li.querySelector(".so-grip").getBoundingClientRect(), r = li.getBoundingClientRect();
      return { x: g.x + g.width / 2, y: g.y + g.height / 2, top: r.top };
    }, n);
    const a = await pt("Sara"), b = await pt("Canarias");
    const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] });
    await touch("touchStart", a.x, a.y);
    for (let i = 1; i <= 10; i++) { await touch("touchMove", a.x, a.y + ((b.top + 4) - a.y) * (i / 10)); await page.waitForTimeout(16); }
    await touch("touchEnd");
    await page.waitForTimeout(300);
    check("celular: arrastrar con el dedo desde el asa (Sara arriba de Canarias)", (await names(page)).join(",") === "Sara,Canarias,Baldo,Armiño" && await saveBarVisible(page), (await names(page)).join(","));
    check("celular: arrastrar no desplaza la página", await page.evaluate(() => scrollY) < 5);
    check("celular: sin errores al arrastrar", !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // =================== Responsive ===================
  for (const [tag, vp] of [["celular", PHONE], ["tablet", TABLET]]) {
    const st = shelfState();
    let { ctx, page, errors } = await openAdmin("#/gondola?tab=gondolas", st, vp);
    check(`${tag}: ordenar góndolas sin desplazamiento horizontal`, await noHScroll(page));
    await page.tap?.('button[aria-label="Bajar Canarias"]').catch(() => page.click('button[aria-label="Bajar Canarias"]'));
    await page.waitForTimeout(200);
    check(`${tag}: los botones mueven (tap)`, (await names(page)).join(",") === "Sara,Canarias,Baldo,Armiño", (await names(page)).join(","));
    const bar = await page.$eval(".so-savebar", (e) => { const r = e.getBoundingClientRect(); return { bottom: r.bottom, h: innerHeight }; });
    const tab = await page.$eval(".tabbar", (e) => e.getBoundingClientRect().top).catch(() => null);
    check(`${tag}: la barra de guardar queda visible${tab ? " sobre la barra inferior" : ""}`, bar.bottom <= (tab ?? bar.h) + 1, JSON.stringify({ bar, tab }));
    const btn = await page.$eval('button[aria-label="Subir Sara"]', (b) => { const r = b.getBoundingClientRect(); return Math.min(r.width, r.height); }).catch(() => 0);
    check(`${tag}: botones de mover de 36 px o más`, btn >= 36, String(btn));
    await page.screenshot({ path: path.join(OUT, `panel-ordenar-gondolas-${tag}.png`), fullPage: true });
    await ctx.close();
    ({ ctx, page, errors } = await openAdmin("#/gondola?tab=yerbas&g=_otras", st, vp));
    check(`${tag}: ordenar yerbas sin desplazamiento horizontal`, await noHScroll(page));
    check(`${tag}: ?g=_otras abre «Otras marcas»`, /Otras marcas/.test(await text(page, ".so-group.active")));
    await page.screenshot({ path: path.join(OUT, `panel-ordenar-yerbas-${tag}.png`), fullPage: true });
    check(`${tag}: sin errores`, !errors.length, errors.join(" | "));
    await ctx.close();
  }

  await browser.close();
  srv.close();
  console.log(`\n${ok} OK, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
