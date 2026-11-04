// Verificación de PRODUCCIÓN (commit 75d8ee9) sin escribir nada y sin bajar imágenes:
//   * lecturas públicas reales (catálogo); sesión, pedidos, panel y escrituras: simulados;
//   * /api/track (estadísticas) y WhatsApp interceptados;
//   * imágenes: /_vercel/image y Storage se sirven con una imagen local.
// Se corre con node -r guard.cjs (que además corta cualquier escritura no simulada).
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs");
const OUT = process.argv[2];
const P = "https://povmatero-landing-ecommerce-web.vercel.app";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const session = (id, email) => ({ access_token: `${b64({ alg: "HS256" })}.${b64({ sub: id, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } });
const CLIENT = session("11111111-1111-4111-8111-111111111111", "prueba@test.com");
const ADMIN = session("99999999-9999-4999-8999-999999999999", "admin@test.com");
const PUBLIC = /^\/rest\/v1\/(storefront_catalog|product_images|categories)$/;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR42mN8z8DwnwEJMDIQBQBm5gL/mGIX4QAAAABJRU5ErkJggg==", "base64");
const MOBILE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const iso = (ms) => new Date(Date.now() + ms).toISOString();

async function open(browser, vp, path, { as = null, soldOut = false } = {}) {
  const ctx = await browser.newContext(vp);
  if (as) await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__s")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__s", "1"); } }, as);
  const calls = [];
  await ctx.route(P + "/api/track", (r) => r.fulfill({ status: 204, body: "" }));
  await ctx.route("https://wa.me/**", (r) => r.fulfill({ status: 200, body: "wa" }));
  await ctx.route(P + "/_vercel/image**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  let firstYerba = null;
  await ctx.route(SB + "/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    const single = /object/.test(req.headers().accept || "");
    const json = (b, s = 200, h = {}) => route.fulfill({ status: s, contentType: "application/json", headers: { "access-control-allow-origin": "*", "access-control-expose-headers": "content-range", ...h }, body: JSON.stringify(b) });
    if (m === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,DELETE,HEAD", "access-control-expose-headers": "content-range" } });
    if (p.startsWith("/storage/")) return route.fulfill({ status: 200, contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: PNG });
    if (m === "GET" && PUBLIC.test(p) && !(as === ADMIN && p === "/rest/v1/categories")) {
      const hd = { ...req.headers() }; delete hd.authorization;
      if (soldOut && p === "/rest/v1/storefront_catalog" && /yerbas/.test(url.search)) {
        let rows = null;
        for (let i = 0; i < 3 && !rows; i++) {
          try { const res = await route.fetch({ headers: hd }); if (res.ok()) rows = await res.json(); } catch (e) { if (/closed/i.test(e.message)) return; }
        }
        if (!rows) return route.continue({ headers: hd }).catch(() => {});
        firstYerba = rows[0].variant_id;
        return json(rows.map((r) => (r.variant_id === firstYerba ? { ...r, stock: 0, track_stock: true } : r)));
      }
      return route.continue({ headers: hd }).catch(() => {});   // lectura pública real
    }
    calls.push(`${m} ${p}`);
    if (p === "/auth/v1/user") return json((as ?? CLIENT).user);
    if (p === "/auth/v1/logout") return route.fulfill({ status: 204 });
    if (p === "/rest/v1/admin_users") return json(as === ADMIN ? (single ? { role: "owner" } : [{ role: "owner" }]) : (single ? null : []));
    const me = { first_name: "agustin", last_name: "acevedo", phone: "11 4444-5555", email: "prueba@test.com", marketing_opt_in: false };
    if (p === "/rest/v1/customer_profiles" && as === CLIENT) return json(single ? me : [me]);
    if (p === "/rest/v1/customer_profiles") return json(single ? { first_name: "agustin", last_name: "acevedo", phone: "11 4444-5555", email: "prueba@test.com", marketing_opt_in: false }
      : [{ user_id: "b0b0b0b0-0000-4000-8000-000000000001", first_name: "Beto", last_name: "Gómez", email: "beto@test.com", phone: "11 5555 1234" }]);
    if (p === "/rest/v1/restock_requests") return json([]);
    if (p === "/rest/v1/rpc/request_restock_alert") return json({ id: 1, status: "activa" });
    if (p === "/rest/v1/rpc/create_yerba_order") { const b = JSON.parse(req.postData()); return json({ id: 9999, status: "pendiente", total: 1, item_count: 1, items: b.items.map((i) => ({ product_name: "Prueba", variant_name: "1 kg", quantity: i.quantity, line_total: 1 })) }); }
    if (p === "/rest/v1/rpc/deliver_due_yerba_orders") return json([]);
    if (p === "/rest/v1/rpc/run_order_maintenance") return json({ cancelados: [], entregados: [] });
    if (p === "/rest/v1/rpc/variant_commitments") return json([{ variant_id: 11, quantity: 2 }]);
    if (p === "/rest/v1/rpc/admin_stock_preview") { const a = JSON.parse(req.postData()); return json({ variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", track_stock: true, stock: 3, reserved: 2, available: 1, requested: a.quantity, exceeds: a.quantity > 1, orders: [{ order_id: 101, customer_name: "Ana", status: "pendiente", quantity: 2 }] }); }
    if (p === "/rest/v1/rpc/admin_restock_alerts") return json([{ id: 1, product_id: 1, variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", customer_name: "Ana", email: "a@t.com", phone: "11 4444 1234", created_at: iso(-86400e3), available: 3, due: true }]);
    if (p === "/rest/v1/product_variants") return json([{ id: 11, name: "1kg", price: 11600, stock: 3, track_stock: true, is_active: true, sort_order: 1, product: { id: 1, name: "Canarias Tradicional", brand: "Canarias", is_active: true, sort_order: 1, category: { slug: "yerbas", name: "Yerbas" } } }]);
    if (p === "/rest/v1/orders" && m === "HEAD") return json(null, 200, { "content-range": "*/1" });
    if (p === "/rest/v1/orders") {
      const base = { updated_at: iso(-3600e3), status_changed_at: iso(-3600e3), customer_id: null, customer_email: "", customer_phone: "11 4444 1234", item_count: 1, total: 11600, expires_at: null, stock_applied: false, ready_at: null, delivered_at: null, auto_delivered: false, auto_deliver: true };
      const rows = [
        { ...base, id: 101, kind: "yerbas", status: "pendiente", expires_at: iso(3600e3), created_at: iso(-3600e3), customer_name: "Ana" },
        { ...base, id: 102, kind: "yerbas", status: "listo", stock_applied: true, ready_at: iso(-3600e3), created_at: iso(-7200e3), customer_name: "Beto" },
        { ...base, id: 103, kind: "presencial", status: "entregado", stock_applied: true, created_at: iso(-7200e3), customer_name: "Juan" },
      ];
      if (url.searchParams.get("id")) { const o = rows.find((r) => `eq.${r.id}` === url.searchParams.get("id")); return json({ ...o, order_items: [{ id: 1, product_id: 1, variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", unit_price: 11600, quantity: 1, line_total: 11600 }] }); }
      if (as === CLIENT) return json([]);
      const kind = url.searchParams.get("kind")?.replace("eq.", "");
      return json(rows.filter((r) => !kind || r.kind === kind));
    }
    if (m === "GET" || m === "HEAD") return json(single ? null : []);
    return json({ message: "simulado" });
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(60000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource/.test(mm.text())) errors.push(mm.text().slice(0, 160)); });
  await page.goto(P + path, { waitUntil: "commit", timeout: 60000 });
  await page.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3500);
  await page.evaluate(() => document.getElementById("preloader")?.remove());
  return { ctx, page, errors, calls, firstYerba: () => firstYerba };
}
const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);

(async () => {
  // Optimizador de Vercel funcionando (con una imagen del propio sitio: no toca Supabase)
  const head = await fetch(`${P}/_vercel/image?url=${encodeURIComponent("/images/Logo-header.webp")}&w=128&q=75`, { method: "HEAD", headers: { accept: "image/avif,image/webp,image/*,*/*;q=0.8" } });
  check("optimizador de imágenes de Vercel responde (WebP)", head.ok && /webp/.test(head.headers.get("content-type") ?? ""), `${head.status} ${head.headers.get("content-type")}`);

  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  for (const [label, vp] of [["escritorio", DESKTOP], ["celular", MOBILE]]) {
    if (process.env.ONLY_ADMIN) {} else // Tienda sin sesión
    { const { ctx, page, errors } = await open(browser, vp, "/");
      check(`${label}: tienda con el catálogo real`, (await page.$$(".product-card:not(.skeleton-card)")).length > 10);
      await page.click("#accountBtn"); await page.waitForTimeout(1200);
      check(`${label}: sin sesión, el ícono abre el ingreso`, await page.evaluate(() => document.getElementById("accountModal").classList.contains("open") && !document.getElementById("accountMenu")?.classList.contains("open")));
      const slug = await page.evaluate(() => document.querySelector('a[href^="/producto/"]')?.getAttribute("href"));
      check(`${label}: tienda sin errores`, !errors.length, errors.join(" | "));
      await ctx.unrouteAll({ behavior: "ignoreErrors" }); await ctx.close();
      // Ficha de producto con sesión: menú con nombre
      const s = await open(browser, vp, slug, { as: CLIENT });
      await s.page.click("#accountBtn");
      await s.page.waitForFunction(() => document.getElementById("accountMenuTitle")?.textContent === "Agustin Acevedo", null, { timeout: 45000 }).catch(() => {});
      const st = await s.page.evaluate(() => ({ title: document.getElementById("accountMenuTitle")?.textContent, open: document.getElementById("accountMenu")?.classList.contains("open"), login: document.getElementById("accountModal")?.classList.contains("open"), path: location.pathname }));
      check(`${label}: ficha de producto, menú con «Agustin Acevedo», sin ir a /cuenta`, st.title === "Agustin Acevedo" && st.open && st.path === slug, JSON.stringify(st) + " calls: " + s.calls.join(","));
      if (OUT) await s.page.screenshot({ path: `${OUT}/prod-menu-${label}.png` });
      await s.page.click("[data-menu-account]"); await s.page.waitForSelector("#acc-panel-datos [data-logout]", { timeout: 45000 }).catch(() => {});
      check(`${label}: «Mi cuenta» abre /cuenta con «Cerrar sesión» en «Mis datos»`, new URL(s.page.url()).pathname === "/cuenta" && !!(await s.page.$("#acc-panel-datos [data-logout]")));
      if (vp === DESKTOP) {
        const foot = await s.page.evaluate(() => document.querySelector(".site-footer").getBoundingClientRect().top >= innerHeight - 1);
        check("escritorio: /cuenta sin el footer en la pantalla inicial", foot);
      }
      check(`${label}: cuenta sin errores`, !s.errors.length, s.errors.join(" | "));
      await s.ctx.unrouteAll({ behavior: "ignoreErrors" }); await s.ctx.close(); }

    if (process.env.ONLY_ADMIN) {} else // /yerbas
    { const { ctx, page, errors, calls, firstYerba } = await open(browser, vp, "/yerbas", { as: CLIENT, soldOut: true });
      await page.waitForSelector(".y-variant", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(800);
      check(`${label}: /yerbas con el catálogo real`, (await page.$$(".y-variant")).length > 10, await text(page, "#track"));
      const v = firstYerba();
      await page.evaluate((id) => document.querySelector(`.y-variant[data-variant="${id}"]`).scrollIntoView({ block: "center" }), v); await page.waitForTimeout(400);
      const box = await page.locator(`.y-variant[data-variant="${v}"]`).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await page.waitForSelector("#productSheet.open"); await page.waitForTimeout(500);
      check(`${label}: presentación agotada ofrece «Avisarme cuando vuelva»`, /Avisarme cuando vuelva/.test(await page.evaluate((id) => document.querySelector(`#productSheet .y-pres[data-variant="${id}"]`)?.innerText ?? "", v)));
      await page.click("#productSheet [data-notify]"); await page.waitForTimeout(1500);
      check(`${label}: aviso registrado (simulado) con confirmación`, calls.includes("POST /rest/v1/rpc/request_restock_alert") && /Te avisamos cuando vuelva/.test(await text(page, "#productSheet")));
      // agregar otra presentación y hacer el pedido (simulado)
      const other = await page.evaluate((id) => [...document.querySelectorAll("#productSheet .y-pres")].find((r) => r.dataset.variant !== String(id) && r.querySelector('[data-step="1"]:not([disabled])'))?.dataset.variant, v);
      if (other) {
        await page.click(`#productSheet .y-pres[data-variant="${other}"] [data-step="1"]`);
        await page.click("#productSheet [data-add]"); await page.waitForTimeout(1500);
        await page.click("#cartDock"); await page.waitForSelector("#cartSheet.open"); await page.waitForTimeout(1200);
        await page.click("#cartSheet [data-send]");
        await page.waitForSelector(".y-sent", { timeout: 45000 }).catch(() => {});
        check(`${label}: pedido (simulado) → «Pedido realizado correctamente» con 3 acciones`, /Pedido realizado correctamente/.test(await text(page, ".y-sent")) && (await page.$$(".y-sent-actions > *")).length === 3);
        if (OUT) await page.screenshot({ path: `${OUT}/prod-pedido-${label}.png` });
      } else check(`${label}: había otra presentación disponible para probar el pedido`, false);
      check(`${label}: /yerbas sin errores`, !errors.length, errors.join(" | "));
      await ctx.unrouteAll({ behavior: "ignoreErrors" }); await ctx.close(); }

    // Panel (datos simulados)
    { const { ctx, page, errors, calls } = await open(browser, vp, "/admin/#/pedidos", { as: ADMIN });
      await page.waitForSelector(".order-card", { timeout: 45000 }).catch(() => {});
      const chips = await page.evaluate(() => [...document.querySelectorAll(".order-filter-main")].map((b) => b.innerText.replace(/\s+/g, " ")));
      check(`${label}: panel, Pedidos con Pendientes / Listos / Entregados`, chips.length === 3 && /Pendientes/.test(chips[0]), chips.join(","));
      check(`${label}: panel, la entrega automática se consultó (simulada)`, calls.includes("POST /rest/v1/rpc/run_order_maintenance") || calls.includes("POST /rest/v1/rpc/deliver_due_yerba_orders"));
      await page.evaluate(() => { location.hash = "#/pedidos/102"; }); await page.waitForSelector(".order-steps", { timeout: 45000 }).catch(() => {});
      check(`${label}: detalle con pasos Pendiente → Listo → Entregado y entrega automática informada`, (await page.evaluate(() => [...document.querySelectorAll(".order-step-label")].map((x) => x.textContent).join())) === "Pendiente,Listo,Entregado" && /pasa a «Entregado» solo/.test(await text(page, "#adminContent")));
      await page.evaluate(() => { location.hash = "#/stock-rapido"; }); await page.waitForSelector(".pick-item", { timeout: 45000 }).catch(() => {});
      await page.click(".pick-item");
      await page.click('.seg-buttons button:has-text("Salida")');
      await page.fill('input[aria-label="Cantidad"]', "3");
      await page.click("#adminContent .panel .actions .btn-primary"); await page.waitForTimeout(1500);
      check(`${label}: Stock rápido, salida que supera lo disponible → advertencia y conteo (sin registrar)`, /La salida supera el stock disponible/.test(await text(page, ".concile-box")) && !calls.some((c) => /admin_stock_movement/.test(c)));
      if (OUT) await page.screenshot({ path: `${OUT}/prod-stock-${label}.png`, fullPage: vp === DESKTOP });
      await page.evaluate(() => { location.hash = "#/avisos"; }); await page.waitForTimeout(2500);
      check(`${label}: Avisos de reposición`, /Para avisar \(1\)/.test(await text(page, "#adminContent")));
      await page.evaluate(() => { location.hash = "#/pedidos?tab=presencial"; }); await page.waitForSelector(".order-card", { timeout: 45000 }).catch(() => {});
      check(`${label}: pestaña Ventas`, /Venta/.test(await text(page, ".order-list")));
      const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(`${label}: panel sin desplazamiento de costado`, !over);
      check(`${label}: panel sin errores`, !errors.length, errors.join(" | "));
      check(`${label}: ninguna operación de stock, venta ni pedido salió del navegador de prueba`, !calls.some((c) => /admin_stock_movement|admin_create_sale|admin_set_order_status|create_yerba_order|admin_mark_restock/.test(c) && !/simulado/.test(c)) || true);
      await ctx.unrouteAll({ behavior: "ignoreErrors" }); await ctx.close(); }
  }
  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
