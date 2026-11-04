// Pedido a proveedor (rediseño): armado visual, orden por marca, stock
// proyectado, resumen, WhatsApp, guardar sin sumar stock, recepción completa
// y con variaciones. Supabase simulado (la recepción imita la función de la
// base 20261111, probada aparte con db-test y concurrency-test).
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "https://povmatero-landing-ecommerce-web.vercel.app";   // PRODUCCIÓN
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
const STORE = SB + "/storage/v1/object/public/product-images/";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const ADMIN = "99999999-9999-4999-8999-999999999999";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: ADMIN, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: ADMIN, email: "admin@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };

function state() {
  // productos a propósito desordenados (como en la base real)
  const P = [
    [61, "Canarias Suave", "Canarias", 30, [["1kg", 2]]],
    [52, "Barao", null, 20, [["500gr", 1], ["1kg", 0]]],
    [3, "Canarias Tradicional", "Canarias", 1, [["500gr", 3], ["1kg", 4]]],
    [41, "Esmeralda", null, 8, [["1kg", 5]]],
    [56, "Uruguay", null, 24, [["1kg", 2]]],
    [40, "Baldo", null, 7, [["1kg", 6], ["500gr", 0]]],
    [53, "Verdecita", null, 21, [["500gr", 2]]],
    [42, "Rei Verde Tradicional", "Rei Verde", 9, [["1kg", 1]]],
    [58, "Armiño Clásica", "Armiño", 26, [["1kg", 3]]],
    [54, "Pindaré", null, 22, [["1kg", 4]]],
    [46, "Sara Tradicional", "Sara", 13, [["500gr", 6]]],
    [60, "Canabbis", null, 28, [["1kg", 1]]],
  ];
  const variants = [];
  let vid = 100;
  for (const [id, name, brand, sort, vs] of P) {
    for (const [vn, stock] of vs) {
      variants.push({ id: ++vid, name: vn, stock, track_stock: true, is_active: true, sort_order: 0,
        shelf_image: id === 3 && vn === "1kg" ? STORE + `products/3/shelf-v${vid}-1.png` : null,
        product: { id, name, brand, is_active: id !== 60, sort_order: sort, shelf_image: id === 3 || id === 40 ? STORE + `products/${id}/shelf-1.png` : null, category: { slug: "yerbas" } } });
    }
  }
  return { variants, supplier: [], nextId: 700, calls: [], covers: [{ product_id: 41, src: STORE + "products/41/cover.webp", is_cover: true, sort_order: 0 }] };
}
const vOf = (st, prod, vn) => st.variants.find((v) => v.product.name === prod && v.name === vn);

(async () => {
  const srv = { close() {} };   // sin servidor local: se prueba producción
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });

  async function open(st, vp = { width: 1440, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript((s) => { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); }, SESSION);
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route("**/_vercel/image**", (r) => r.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAFElEQVR42mN8z8DwnwEJMDIQBQBm5gL/mGIX4QAAAABJRU5ErkJggg==", "base64") }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), u = new URL(req.url()), p = u.pathname;
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      const err = (status, hint, message) => json({ code: "23514", message, hint }, status);
      const body = () => JSON.parse(req.postData() || "null");
      if (p.startsWith("/storage/")) return route.fallback();   // la protección sirve la imagen local
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (p === "/rest/v1/admin_users") return json({ role: "owner" });
      if (p === "/rest/v1/product_variants") return json(st.variants);
      if (p === "/rest/v1/product_images") return json(st.covers);
      if (p === "/rest/v1/rpc/variant_commitments") return json([]);
      if (p === "/rest/v1/supplier_orders") return json(st.supplier);
      if (p.startsWith("/rest/v1/rpc/")) {
        const fn = p.slice(13), a = body(); st.calls.push([fn, a]);
        if (fn === "admin_create_supplier_order") {
          const prev = st.supplier.find((s) => s.client_key === a.client_key);
          if (prev) return json({ ...prev, items: prev.supplier_order_items, repeated: true });
          const s = { id: st.nextId++, supplier: a.supplier ?? "", note: a.note ?? "", status: "pedido", client_key: a.client_key, created_at: new Date().toISOString(), received_at: null, cancelled_at: null,
            supplier_order_items: a.items.map((i, k) => { const v = st.variants.find((x) => x.id === i.variant_id); return { id: k + 1, variant_id: v.id, product_name: v.product.name, variant_name: v.name, quantity: i.quantity, received_quantity: null }; }) };
          st.supplier.unshift(s);
          return json({ ...s, items: s.supplier_order_items });
        }
        if (fn === "admin_receive_supplier_order") {
          const s = st.supplier.find((x) => x.id === a.order_id);
          if (s.status === "recibido") return json({ ...s, already_received: true });
          const fin = s.supplier_order_items.map((i) => a.items == null ? i.quantity : (a.items.find((x) => x.variant_id === i.variant_id)?.quantity ?? 0));
          if (fin.reduce((x, y) => x + y, 0) === 0) return err(400, "empty_reception", "No hay unidades para recibir. Si el proveedor no tiene nada, cancelá el pedido.");
          s.supplier_order_items.forEach((i, k) => { i.received_quantity = fin[k]; st.variants.find((v) => v.id === i.variant_id).stock += fin[k]; });
          s.status = "recibido"; s.received_at = new Date().toISOString();
          return json(s);
        }
        if (fn === "admin_cancel_supplier_order") { const s = st.supplier.find((x) => x.id === a.order_id); s.status = "cancelado"; s.cancelled_at = new Date().toISOString(); return json(s); }
        return json(null);
      }
      return json([]);
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(60000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + "/admin/#/stock-rapido?tab=proveedor");
    await page.waitForSelector(".sp-card", { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { ctx, page, errors };
  }
  const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const row = (st, prod, vn) => `.sp-row[data-variant="${vOf(st, prod, vn).id}"]`;

  // ================= Escritorio =================
  { const st = state(); const { ctx, page, errors } = await open(st);
    const chips = await page.evaluate(() => [...document.querySelectorAll(".sp-chip")].map((b) => b.textContent));
    check("orden de marcas: Canarias, Baldo, Esmeralda, Rei Verde, Sara, Barao, Pindaré, Verdecita, Otras", chips.slice(0, 9).join("|") === "Canarias|Baldo|Esmeralda|Rei Verde|Sara|Barao|Pindaré|Verdecita|Otras marcas", chips.join("|"));
    check("arranca mostrando solo Canarias (sin lista interminable)", (await page.$$eval(".sp-card", (c) => c.length)) === 2 && /Tradicional/.test(await txt(page, ".sp-card")));
    await page.click('.sp-chip:has-text("Todas")'); await page.waitForTimeout(200);
    const order = await page.evaluate(() => [...document.querySelectorAll(".sp-group")].map((g) => g.querySelector(".sp-group-title").textContent + ":" + [...g.querySelectorAll(".sp-name")].map((n) => n.textContent).join(",")));
    check("«Todas»: grupos en orden y Canarias Suave dentro de Canarias", order.join(" / ") === "Canarias:Tradicional,Suave / Baldo:Baldo / Esmeralda:Esmeralda / Rei Verde:Tradicional / Sara:Tradicional / Barao:Barao / Pindaré:Pindaré / Verdecita:Verdecita / Otras marcas:Armiño Clásica,Canabbis,Uruguay", order.join(" / "));
    const pres = await page.evaluate(() => [...document.querySelector('.sp-card[data-product="3"]').querySelectorAll(".sp-pres")].map((x) => x.textContent).join(","));
    check("presentaciones de un producto juntas y en orden (1 kg, 500 g)", pres === "1 kg,500 g", pres);
    check("sin precios", !/\$/.test(await txt(page, ".sp-grid")));
    const imgs = await page.evaluate(() => ({ canarias: document.querySelector('.sp-card[data-product="3"] .sp-pack img')?.getAttribute("src"), esmeralda: document.querySelector('.sp-card[data-product="41"] .sp-pack img')?.getAttribute("src"), uruguay: !!document.querySelector('.sp-card[data-product="56"] .sp-pack img') }));
    check("fotos de la góndola (presentación → general → portada → genérico)", /shelf-v\d+-1\.png/.test(imgs.canarias) && /cover\.webp/.test(imgs.esmeralda) && !imgs.uruguay, JSON.stringify(imgs));
    check("muestra el stock actual (Canarias 1 kg: 4)", /Stock actual 4/.test(await txt(page, row(st, "Canarias Tradicional", "1kg"))));
    // + seis veces → proyectado 10 al instante
    for (let i = 0; i < 6; i++) await page.click(`${row(st, "Canarias Tradicional", "1kg")} .sp-step:has-text("+")`);
    check("cantidad 6 → stock proyectado 10 inmediatamente", (await page.inputValue(`${row(st, "Canarias Tradicional", "1kg")} .sp-qty`)) === "6" && (await txt(page, `${row(st, "Canarias Tradicional", "1kg")} .sp-proj`)) === "10");
    await page.fill(`${row(st, "Baldo", "500gr")} .sp-qty`, "5"); await page.press(`${row(st, "Baldo", "500gr")} .sp-qty`, "Tab");
    await page.click(`${row(st, "Rei Verde Tradicional", "1kg")} .sp-step:has-text("+")`);
    await page.fill(`${row(st, "Rei Verde Tradicional", "1kg")} .sp-qty`, "8"); await page.press(`${row(st, "Rei Verde Tradicional", "1kg")} .sp-qty`, "Tab");
    await page.click(`${row(st, "Uruguay", "1kg")} .sp-step:has-text("+")`);
    await page.waitForTimeout(200);
    const sum = await txt(page, ".sp-summary");
    check("resumen claro por marca con cantidades y stock proyectado", /CANARIAS|Canarias/.test(sum) && /Tradicional 1 kg\s*4 → 10\s*× 6/.test(sum) && /Baldo 500 g\s*0 → 5\s*× 5/.test(sum) && /4 presentaciones\s*20 unidades/.test(sum), sum);
    const msg = await page.inputValue(".msg-preview");
    check("mensaje de WhatsApp ordenado por marca", msg.indexOf("*CANARIAS*") < msg.indexOf("*BALDO*") && msg.indexOf("*BALDO*") < msg.indexOf("*REI VERDE*") && msg.indexOf("*REI VERDE*") < msg.indexOf("*OTRAS MARCAS*")
      && /• Tradicional 1 kg × 6/.test(msg) && /• Baldo 500 g × 5/.test(msg) && /• Tradicional 1 kg × 8/.test(msg) && /Total: 20 unidades en 4 presentaciones\./.test(msg), msg);
    // «En el pedido»
    await page.click('.sp-chip:has-text("En el pedido")'); await page.waitForTimeout(200);
    check("filtro «En el pedido (4)» muestra solo lo elegido", /En el pedido \(4\)/.test(await txt(page, ".sp-chips")) && (await page.$$eval(".sp-card", (c) => c.length)) === 4);
    // borrador: recargar no pierde lo armado
    await page.reload(); await page.waitForSelector(".sp-card", { timeout: 60000 }); await page.waitForTimeout(400);
    check("el borrador se conserva al recargar", /20 unidades/.test(await txt(page, ".sp-summary")));
    // guardar: no suma stock
    const stockBefore = st.variants.map((v) => v.stock).join();
    await page.fill('input[aria-label="Proveedor"]', "Distribuidora Sur");
    await page.click('button:has-text("Guardar pedido y copiar mensaje")'); await page.waitForTimeout(1500);
    const created = st.calls.filter(([k]) => k === "admin_create_supplier_order");
    check("guardar: un pedido con las 4 presentaciones, SIN sumar stock", created.length === 1 && created[0][1].items.length === 4 && st.variants.map((v) => v.stock).join() === stockBefore && st.supplier[0].status === "pedido");
    const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ""));
    check("guardar: copia el mensaje con el proveedor", /Hola Distribuidora Sur!/.test(clip), clip.slice(0, 60));
    check("guardar: se vacía el armado y aparece en «Pedidos anteriores»", /0 unidades/.test(await txt(page, ".sp-summary")) && /#700 · Distribuidora Sur/.test(await txt(page, ".supplier-card")));
    if (OUT) await page.screenshot({ path: `${OUT}/proveedor-escritorio.png`, fullPage: true });

    // Confirmar con variaciones (ejemplo: 10/5/8 → 7/0/8). Pedido nuevo con esas cantidades.
    for (const [prod, vn, n] of [["Canarias Tradicional", "1kg", 10], ["Baldo", "500gr", 5], ["Rei Verde Tradicional", "1kg", 8]]) {
      await page.click('.sp-chip:has-text("Todas")'); await page.waitForTimeout(100);
      await page.fill(`${row(st, prod, vn)} .sp-qty`, String(n)); await page.press(`${row(st, prod, vn)} .sp-qty`, "Tab");
    }
    await page.click('button:has-text("Guardar pedido y copiar mensaje")'); await page.waitForTimeout(1500);
    const s0 = { c: vOf(st, "Canarias Tradicional", "1kg").stock, b: vOf(st, "Baldo", "500gr").stock, r: vOf(st, "Rei Verde Tradicional", "1kg").stock };
    await page.click('.supplier-card[data-order="701"] button:has-text("Confirmar con variaciones")'); await page.waitForSelector(".sp-recv");
    const rv = (prod) => `.sp-recv[data-variant="${vOf(st, prod, prod === "Baldo" ? "500gr" : "1kg").id}"]`;
    check("variaciones: muestra solicitado, stock actual y proyectado", /Solicitado 10/.test(await txt(page, rv("Canarias Tradicional"))) && new RegExp(`Stock actual ${s0.c} · Proyectado ${s0.c + 10}`).test(await txt(page, rv("Canarias Tradicional"))), await txt(page, rv("Canarias Tradicional")));
    await page.fill(`${rv("Canarias Tradicional")} .sp-qty`, "7"); await page.press(`${rv("Canarias Tradicional")} .sp-qty`, "Tab"); await page.waitForTimeout(150);
    check("variaciones: el proyectado se actualiza con la cantidad final", new RegExp(`Proyectado ${s0.c + 7}`).test(await txt(page, rv("Canarias Tradicional"))));
    await page.click(`${rv("Baldo")} button:has-text("Quitar")`); await page.waitForTimeout(150);
    check("variaciones: quitar un producto lo deja en 0 (tachado)", await page.$eval(rv("Baldo"), (e) => e.classList.contains("is-removed")) && (await page.inputValue(`${rv("Baldo")} .sp-qty`)) === "0");
    await page.click('button:has-text("Revisar diferencias")'); await page.waitForTimeout(200);
    const diffs = await txt(page, ".sp-diffs");
    check("variaciones: resumen de diferencias antes de confirmar", /Canarias Tradicional 1 kg: 10 → 7/.test(diffs) && /Baldo 500 g: no vino \(se pidieron 5\)/.test(diffs) && /1 presentación llega como se pidió/.test(diffs) && /Pedido: 23 · Se suman al stock: 15/.test(diffs), diffs);
    check("variaciones: todavía no se registró nada", !st.calls.some(([k]) => k === "admin_receive_supplier_order"));
    if (OUT) await page.screenshot({ path: `${OUT}/proveedor-variaciones.png`, fullPage: true });
    await page.click('.sp-diffs button:has-text("Confirmar recepción")'); await page.waitForTimeout(1500);
    const rc = st.calls.filter(([k]) => k === "admin_receive_supplier_order").at(-1)[1];
    check("variaciones: envía las cantidades finales (7, 0, 8), nunca las originales", JSON.stringify(rc.items.map((i) => i.quantity)) === "[7,0,8]", JSON.stringify(rc));
    check("variaciones: suma 7, 0 y 8 al stock", vOf(st, "Canarias Tradicional", "1kg").stock === s0.c + 7 && vOf(st, "Baldo", "500gr").stock === s0.b && vOf(st, "Rei Verde Tradicional", "1kg").stock === s0.r + 8);
    const hist = await txt(page, '.supplier-card[data-order="701"]');
    check("historial: conserva lo pedido y lo recibido (diferencias consultables)", /Se pidieron 10, llegaron 7/.test(hist) && /No vino \(se pidieron 5\)/.test(hist) && /Pedido: 23 · Recibido: 15/.test(hist), hist);
    check("historial: un pedido recibido no ofrece confirmar otra vez", !(await page.$('.supplier-card[data-order="701"] button:has-text("Confirmar")')));

    // Confirmar pedido completo (el #700) y doble confirmación
    const c0 = vOf(st, "Canarias Tradicional", "1kg").stock;
    await page.click('.supplier-card[data-order="700"] button:has-text("Confirmar pedido completo")');
    check("completo: muestra lo que se suma y cómo queda el stock", new RegExp(`Canarias Tradicional 1 kg: \\+6 \\(stock ${c0} → ${c0 + 6}\\)`).test(await txt(page, '.supplier-card[data-order="700"] .confirm-box')), await txt(page, '.supplier-card[data-order="700"] .confirm-box'));
    await page.click('.supplier-card[data-order="700"] button:has-text("Sí, sumar al stock")'); await page.waitForTimeout(1500);
    const last = st.calls.filter(([k]) => k === "admin_receive_supplier_order").at(-1)[1];
    check("completo: recibe todo lo pedido (sin lista) y suma 6", last.items === null && vOf(st, "Canarias Tradicional", "1kg").stock === c0 + 6);
    const again = await page.evaluate(async () => (await import("/admin/js/api/stockTools.js")).receiveSupplierOrder(700, null));
    check("doble confirmación: no suma de nuevo", again.already_received === true && vOf(st, "Canarias Tradicional", "1kg").stock === c0 + 6);

    // Todo en 0: no se registra
    await page.click('.sp-chip:has-text("Todas")');
    await page.fill(`${row(st, "Esmeralda", "1kg")} .sp-qty`, "3"); await page.press(`${row(st, "Esmeralda", "1kg")} .sp-qty`, "Tab");
    await page.click('button:has-text("Guardar pedido y copiar mensaje")'); await page.waitForTimeout(1500);
    await page.click('.supplier-card[data-order="702"] button:has-text("Confirmar con variaciones")'); await page.waitForSelector(".sp-recv");
    await page.click('.sp-recv button:has-text("Quitar")');
    await page.click('button:has-text("Revisar diferencias")'); await page.waitForTimeout(200);
    check("todo en 0: no deja confirmar y sugiere cancelar", await page.$eval('.sp-diffs button:has-text("Confirmar recepción")', (b) => b.disabled) && /No hay unidades para recibir/.test(await txt(page, ".sp-diffs")));
    const before = st.calls.filter(([k]) => k === "admin_receive_supplier_order").length;
    const forced = await page.evaluate(async () => { try { await (await import("/admin/js/api/stockTools.js")).receiveSupplierOrder(702, [{ variant_id: 0, quantity: 0 }]); return "ok"; } catch (e) { return e.hint; } });
    check("todo en 0: la base también lo rechaza (empty_reception), nada registrado", forced === "empty_reception" && st.supplier.find((s) => s.id === 702).status === "pedido" && st.calls.filter(([k]) => k === "admin_receive_supplier_order").length === before + 1);
    check("escritorio: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ================= Celular =================
  { const st = state(); const { ctx, page, errors } = await open(st, { width: 390, height: 844 });
    check("celular: una columna de tarjetas", await page.evaluate(() => { const c = [...document.querySelectorAll(".sp-card")]; return c.length >= 2 && c[0].getBoundingClientRect().left === c[1].getBoundingClientRect().left; }));
    check("celular: sin desplazamiento de costado", !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)));
    check("celular: la barra de resumen no aparece vacía", await page.$eval(".sp-bar", (b) => b.hidden));
    await page.click(`${row(st, "Canarias Tradicional", "1kg")} .sp-step:has-text("+")`);
    await page.click(`${row(st, "Canarias Tradicional", "1kg")} .sp-step:has-text("+")`);
    check("celular: botones + y − cómodos (≥ 40 px)", await page.$eval(`${row(st, "Canarias Tradicional", "1kg")} .sp-step`, (b) => b.getBoundingClientRect().height >= 40 && b.getBoundingClientRect().width >= 40));
    const bar = await page.evaluate(() => { const b = document.querySelector(".sp-bar"); const r = b.getBoundingClientRect(); const t = document.querySelector(".tabbar")?.getBoundingClientRect(); return { hidden: b.hidden, text: b.innerText, above: !t || r.bottom <= t.top + 1 }; });
    check("celular: barra fija con el total, encima de la barra de pestañas", !bar.hidden && /2 unidades/.test(bar.text) && bar.above, JSON.stringify(bar));
    await page.click('.sp-bar button:has-text("Ver resumen")'); await page.waitForTimeout(400);
    check("celular: «Ver resumen» abre la hoja con el resumen y el mensaje", await page.evaluate(() => { const s = document.querySelector(".sp-summary"); const r = s.getBoundingClientRect(); return s.classList.contains("open") && r.top < innerHeight && /Mensaje para WhatsApp/.test(s.innerText); }));
    if (OUT) await page.screenshot({ path: `${OUT}/proveedor-celular-resumen.png` });
    await page.click(".sp-close"); await page.waitForTimeout(300);
    if (OUT) await page.screenshot({ path: `${OUT}/proveedor-celular.png` });
    check("celular: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
