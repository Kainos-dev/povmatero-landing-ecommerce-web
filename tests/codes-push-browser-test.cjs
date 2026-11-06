// Navegador (Supabase simulado + guard): /yerbas (confirmación, cambio de stock
// en el checkout, clave de intento, avisos de reposición), «Mis pedidos»
// (código y «Consultar estado de mi pedido»), panel (códigos, Notificaciones,
// service worker, manifest) en 360, 390, tablet y escritorio. No escribe en
// Supabase ni envía notificaciones reales.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path"), vm = require("vm");
const ROOT = process.argv[2], OUT = process.argv[3];
const PORT = 5198, BASE = `http://localhost:${PORT}`;
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const UID = "22222222-2222-4222-8222-222222222222";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: UID, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: UID, email: "a@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: { first_name: "Agustín" } } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VAPID_TEST = require(require.resolve("web-push", { paths: [process.env.PW] })).generateVAPIDKeys();
const VIEWPORTS = [["360", { width: 360, height: 780 }], ["390", { width: 390, height: 844 }], ["tablet", { width: 820, height: 1180 }], ["escritorio", { width: 1440, height: 900 }]];
if (OUT) fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = await serve(ROOT, PORT);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  let catalogRows = null;

  // ---------------- Tienda ----------------
  async function store(vp, opts = {}) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__init", "1"); } }, SESSION);
    const st = { catalogHits: 0, rpc: [], writes: [], saved: [], stockOverride: {}, mode: opts.mode ?? "ok", ordersFail: false, restock: [], orders: opts.orders ?? [] };
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      if (m !== "GET" && m !== "HEAD") st.writes.push([m, p, req.postData()]);
      if (p === "/rest/v1/storefront_catalog") {
        st.catalogHits++;
        if (!catalogRows) { const r = await route.fetch(); catalogRows = await r.json(); }
        return json(catalogRows.map((r) => ({ ...r, stock: st.stockOverride[r.variant_id] ?? 3, track_stock: true })));
      }
      if (p === "/rest/v1/customer_profiles") return json({ phone: "11 6666 1234", first_name: "Agustín", last_name: "Acevedo", email: "a@test.com", marketing_opt_in: false });
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (p === "/rest/v1/restock_requests") return json(st.restock.map((v) => ({ variant_id: v, email_consent_at: st.legacyRestock ? null : new Date().toISOString() })));
      if (p === "/rest/v1/rpc/request_restock_alert") { const a = JSON.parse(req.postData()); if (!st.restock.includes(a.variant_id)) st.restock.push(a.variant_id); st.legacyRestock=false; return json({ id: 1, variant_id: a.variant_id, status: "activa" }); }
      if (p === "/rest/v1/rpc/cancel_restock_alert") { const a = JSON.parse(req.postData()); st.restock = st.restock.filter((v) => v !== a.variant_id); return json(true); }
      if (p === "/rest/v1/rpc/create_yerba_order") {
        const a = JSON.parse(req.postData());
        st.rpc.push(a);
        const prev = st.saved.find((o) => a.client_key && o.client_key === a.client_key);
        if (prev) return json({ ...prev, repeated: true });
        if (st.mode === "stock") {
          st.mode = "ok";
          const v = a.items[0].variant_id;
          st.stockOverride[v] = 1;
          return json({ code: "23514", message: "No alcanza el stock de: X (quedan 1).", hint: "insufficient_stock", details: JSON.stringify([{ variant_id: v, product_name: "Yerba", variant_name: "1kg", requested: a.items[0].quantity, available: 1 }]) }, 400);
        }
        const order = { id: 501 + st.saved.length, public_code: `PV-ABCDEF000${3 + st.saved.length}`, client_key: a.client_key, total: 11600, item_count: a.items[0].quantity, status: "pendiente", created_at: new Date().toISOString(),
          items: a.items.map((i) => ({ ...i, product_name: "Canarias Serena", variant_name: "1kg", line_total: 11600 })) };
        st.saved.push(order);
        if (st.mode === "lost") { st.mode = "ok"; st.ordersFail = true; return route.abort("failed"); }
        return json(order);
      }
      if (p === "/rest/v1/orders") {
        if (st.ordersFail) return json({ message: "down" }, 500);
        if (url.searchParams.get("select")?.includes("order_items (variant_id")) return json([]);
        return json(st.orders);
      }
      if (m !== "GET") return json([]);
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    st.warns = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => { if (msg.type() === "warning") st.warns.push(msg.text().slice(0, 160)); if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    return { ctx, page, st, errors };
  }
  async function openYerbas(page) {
    await page.goto(BASE + "/yerbas");
    await page.waitForSelector(".y-variant", { timeout: 20000 });
    await page.waitForTimeout(1000);
  }
  async function addToCart(page, qty = 1) {
    const v = await page.evaluate(() => { const b = [...document.querySelectorAll(".y-variant:not(.is-out)")][0]; b.scrollIntoView({ block: "center" }); return b.dataset.variant; });
    await page.waitForTimeout(250);
    const box = await page.locator(`.y-variant[data-variant="${v}"]`).first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("#productSheet.open");
    await page.waitForTimeout(250);
    for (let i = 0; i < qty; i++) await page.click(`#productSheet [data-variant="${v}"] [data-step="1"]:not([disabled])`);
    await page.click("#productSheet [data-add]");
    await page.waitForTimeout(1200);
    await page.click("#cartDock");
    await page.waitForSelector("#cartSheet.open");
    await page.waitForTimeout(600);
    return Number(v);
  }
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  for (const [label, vp] of VIEWPORTS) {
    // 1. Pedido realizado
    { const { ctx, page, st, errors } = await store(vp);
      await openYerbas(page);
      await addToCart(page, 1);
      const fine = await page.textContent("#cartSheet .y-fineprint");
      const btn = (await page.textContent("#cartSheet [data-send]")).trim();
      check(`${label}: checkout dice «12 horas» y el botón «Realizar pedido»`, /12 horas/.test(fine) && !/72/.test(fine) && btn === "Realizar pedido", fine + " | " + btn);
      await page.click("#cartSheet [data-send]");
      await page.waitForSelector(".y-sent", { timeout: 10000 });
      await page.waitForTimeout(400);
      const sent = await page.evaluate(() => {
        const t = document.querySelector(".y-sent-title");
        return { title: t.textContent, shown: t.innerText, transform: getComputedStyle(t).textTransform, font: getComputedStyle(t).fontFamily,
          num: document.querySelector(".y-sent-number")?.textContent, text: document.querySelector(".y-sent > p:not(.y-sent-number)")?.textContent,
          note: !!document.querySelector(".y-sent-note"), html: document.querySelector(".y-sent").innerHTML,
          actions: [...document.querySelectorAll(".y-sent-actions > *")].map((a) => [a.textContent.trim(), a.getAttribute("href")]) };
      });
      check(`${label}: título «PEDIDO REALIZADO» con la tipografía de títulos`, sent.title === "Pedido realizado" && sent.shown === "PEDIDO REALIZADO" && sent.transform === "uppercase" && /Inter/.test(sent.font), JSON.stringify(sent).slice(0, 200));
      check(`${label}: muestra el código público (PV-ABCDEF0003), no el número interno`, sent.num === "Pedido PV-ABCDEF0003" && !/#501|501/.test(sent.html), sent.num);
      check(`${label}: reserva de 12 horas y sin la aclaración «Avisar es opcional»`, /12 horas/.test(sent.text) && !sent.note && !/opcional/i.test(sent.html), sent.text);
      const wa = sent.actions[1]?.[1] ?? "";
      check(`${label}: se conservan los 4 botones; WhatsApp segundo, con el código`, sent.actions.length === 4 && sent.actions[1][0] === "Avisar por WhatsApp" && decodeURIComponent(wa).includes("pedido de yerbas PV-ABCDEF0003") && !decodeURIComponent(wa).includes("#501"), JSON.stringify(sent.actions));
      check(`${label}: el pedido viajó con una clave de intento (UUID)`, st.rpc.length === 1 && UUID.test(st.rpc[0].client_key ?? ""), JSON.stringify(st.rpc[0]));
      check(`${label}: sin desborde horizontal`, await noOverflow(page));
      if (OUT) await page.screenshot({ path: `${OUT}/pedido-realizado-${label}.png` });
      check(`${label}: sin errores de JavaScript`, !errors.length, errors.join(" | "));
      await ctx.close(); }

    // 2. Cambió el stock durante el checkout
    { const { ctx, page, st } = await store(vp, { mode: "stock" });
      await openYerbas(page);
      const v = await addToCart(page, 3);
      await page.click("#cartSheet [data-send]");
      await page.waitForFunction(() => /Cambió el stock/.test(document.querySelector("#cartSheet .y-msg:not([hidden])")?.textContent ?? ""), null, { timeout: 10000 });
      const r = await page.evaluate(() => ({ msg: document.querySelector("#cartSheet .y-msg:not([hidden])")?.textContent, btn: document.querySelector("#cartSheet [data-send]")?.textContent.trim(), count: Number(document.getElementById("cartCount").textContent), sent: !!document.querySelector(".y-sent") }));
      check(`${label}: cambio de stock → mensaje claro con lo que quedó y el carrito ajustado`, /Cambió el stock mientras hacías el pedido/.test(r.msg) && /queda 1/.test(r.msg) && /tenías 3/.test(r.msg) && r.count === 1 && !r.sent, JSON.stringify(r) + " avisos " + JSON.stringify(st.warns) + " catálogo " + st.catalogHits + " override " + JSON.stringify(st.stockOverride) + " v " + v);
      check(`${label}: sin botón «Reintentar»: sigue «Realizar pedido»`, r.btn === "Realizar pedido" && !(await page.evaluate(() => /Reintentar/.test(document.getElementById("cartSheet").textContent))));
      if (OUT) await page.screenshot({ path: `${OUT}/cambio-stock-${label}.png` });
      await page.click("#cartSheet [data-send]");
      await page.waitForSelector(".y-sent", { timeout: 10000 });
      check(`${label}: corregido, se envía una vez; clave nueva porque cambió el carrito`, st.saved.length === 1 && st.rpc.length === 2 && st.rpc[0].client_key !== st.rpc[1].client_key && st.rpc[1].items[0].quantity === 1, JSON.stringify(st.rpc.map((x) => [x.client_key?.slice(0, 8), x.items[0].quantity])));
      await ctx.close(); }

    if (label !== "390" && label !== "escritorio") continue;

    // 3. Respuesta perdida y sin poder comprobar → mismo intento, sin duplicar
    { const { ctx, page, st } = await store(vp, { mode: "lost" });
      await openYerbas(page);
      await addToCart(page, 1);
      await page.click("#cartSheet [data-send]");
      await page.waitForFunction(() => /No pudimos confirmar tu pedido/.test(document.querySelector("#cartSheet .y-msg:not([hidden])")?.textContent ?? ""), null, { timeout: 15000 });
      const btn = (await page.textContent("#cartSheet [data-send]")).trim();
      check(`${label}: respuesta perdida → explica que volver a tocar no duplica`, btn === "Realizar pedido" && (await page.textContent("#cartSheet .y-msg")).includes("no se va a duplicar"));
      st.ordersFail = false;
      await page.click("#cartSheet [data-send]");
      await page.waitForSelector(".y-sent", { timeout: 10000 });
      check(`${label}: segundo toque con la MISMA clave → el mismo pedido, sin duplicado`, st.rpc.length === 2 && st.rpc[0].client_key === st.rpc[1].client_key && st.saved.length === 1 && (await page.textContent(".y-sent-number")) === "Pedido PV-ABCDEF0003", JSON.stringify(st.rpc.map((x) => x.client_key)));
      await ctx.close(); }

    // 4. Avisos de reposición
    { const { ctx, page, st } = await store(vp);
      let stockRestored = false;
      await page.route(SB + "/rest/v1/storefront_catalog*", async (route) => {
        if (!catalogRows) { const r = await route.fetch(); catalogRows = await r.json(); }
        const firstYerba = catalogRows[0];
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(catalogRows.map((r) => ({ ...r, track_stock: true, stock: !stockRestored && r.variant_id === firstYerba.variant_id ? 0 : 3 }))) });
      });
      await openYerbas(page);
      const outId = await page.evaluate(() => document.querySelector(".y-variant.is-out")?.dataset.variant);
      await page.evaluate((id) => document.querySelector(`.y-variant[data-variant="${id}"]`).scrollIntoView({ block: "center" }), outId);
      await page.waitForTimeout(250);
      await page.locator(`.y-variant[data-variant="${outId}"]`).first().click({ force: true });
      await page.waitForSelector("#productSheet.open");
      const btnText = (await page.textContent(`#productSheet [data-variant="${outId}"] [data-notify]`)).trim();
      check(`${label}: botón «Avisarme por email cuando haya stock»`, btnText === "Avisarme por email cuando haya stock", btnText);
      check(`${label}: consentimiento inicialmente desmarcado`, !await page.isChecked(`#productSheet [data-variant="${outId}"] [data-notify-consent]`));
      await page.click(`#productSheet [data-variant="${outId}"] [data-notify]`);
      check(`${label}: sin aceptación no guarda solicitud`, !st.restock.includes(Number(outId)));
      await page.check(`#productSheet [data-variant="${outId}"] [data-notify-consent]`);
      await page.click(`#productSheet [data-variant="${outId}"] [data-notify]`);
      await page.waitForSelector(`#productSheet [data-variant="${outId}"] .y-notify.is-on`, { timeout: 5000 });
      const on = await page.evaluate((id) => {
        const box = document.querySelector(`#productSheet [data-variant="${id}"] .y-notify`);
        const s = box.querySelector(".y-notify-state"), c = box.querySelector(".y-notify-cancel"), how = box.querySelector(".y-notify-how");
        return { text: s.textContent, color: getComputedStyle(s).color, cancel: c.textContent, cancelColor: getComputedStyle(c).color, how: how?.textContent };
      }, outId);
      check(`${label}: «Te vamos a avisar cuando haya stock.» en negro y con punto`, on.text === "Te vamos a avisar cuando haya stock." && on.color === "rgb(0, 0, 0)", JSON.stringify(on));
      check(`${label}: «Cancelar aviso» en rojo`, on.cancel === "Cancelar aviso" && /^rgb\((19[0-9]|2\d\d), (\d|[1-5]\d), (\d|[1-5]\d)\)$/.test(on.cancelColor), on.cancelColor);
      check(`${label}: explica email y configuración pendiente`, /correo/.test(on.how) && /configurado/.test(on.how) && !/WhatsApp/.test(on.how), on.how);
      if (OUT) await page.screenshot({ path: `${OUT}/aviso-stock-${label}.png` });
      await page.click(`#productSheet [data-variant="${outId}"] [data-notify-cancel]`);
      await page.waitForSelector(`#productSheet [data-variant="${outId}"] [data-notify]`, { timeout: 5000 });
      check(`${label}: cancelar el aviso vuelve al botón`, st.restock.length === 0);
      st.legacyRestock=true; st.restock=[Number(outId)];
      await page.reload(); await page.waitForSelector(`.y-variant[data-variant="${outId}"]`);
      await page.locator(`.y-variant[data-variant="${outId}"]`).first().click({force:true});
      await page.waitForFunction(()=>document.querySelector('#productSheet.open [data-notify-cancel]')?.textContent==='Cancelar aviso anterior');
      check(`${label}: aviso antiguo requiere confirmación por email y permite cancelar`,/aviso anterior necesita/.test(await page.textContent('#productSheet')) && /Cancelar aviso anterior/.test(await page.textContent('#productSheet')));
      await page.check(`#productSheet [data-variant="${outId}"] [data-notify-consent]`);
      await page.click(`#productSheet [data-variant="${outId}"] [data-notify]`);
      await page.waitForSelector('#productSheet .y-notify.is-on');
      stockRestored=true;
      await page.reload(); await page.waitForSelector(`.y-variant[data-variant="${outId}"]`);
      await page.locator(`.y-variant[data-variant="${outId}"]`).first().click({force:true});
      await page.waitForSelector('#productSheet.open [data-notify-cancel]');
      check(`${label}: se puede cancelar también después de volver stock`,await page.locator(`#productSheet [data-variant="${outId}"] [data-notify-cancel]`).count()===1);
      check(`${label}: aviso con stock no desborda`,await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      if(OUT) await page.screenshot({path:`${OUT}/aviso-disponible-${label}.png`});
      await ctx.close(); }
  }

  // ---------------- Mis pedidos ----------------
  const myOrders = [
    { id: 777, public_code: "PV-ABCDEF0003", kind: "yerbas", status: "pendiente", total: 23200, item_count: 2, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 11 * 3600e3).toISOString(), cancel_reason: null, order_items: [{ product_name: "Canarias Serena", variant_name: "1kg", unit_price: 11600, quantity: 2, line_total: 23200 }] },
    { id: 650, public_code: "PV-ABCDEF0002", kind: "tienda", status: null, total: 30000, item_count: 1, created_at: "2026-11-01T15:00:00Z", expires_at: null, cancel_reason: null, order_items: [{ product_name: "Mate Imperial", variant_name: null, unit_price: 30000, quantity: 1, line_total: 30000 }] },
    { id: 610, public_code: "PV-ABCDEF0001", kind: "presencial", status: "entregado", total: 11600, item_count: 1, created_at: "2026-10-20T15:00:00Z", expires_at: null, cancel_reason: null, order_items: [{ product_name: "Baldo", variant_name: "1kg", unit_price: 11600, quantity: 1, line_total: 11600 }] },
  ];
  for (const [label, vp] of VIEWPORTS) {
    const { ctx, page, st, errors } = await store(vp, { orders: myOrders });
    const popups = [];
    ctx.on("page", (p) => popups.push(p));
    await page.goto(BASE + "/cuenta?seccion=pedidos");
    await page.waitForSelector(".acc-order", { timeout: 20000 });
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => [...document.querySelectorAll(".acc-order")].map((li) => {
      const a = li.querySelector(".acc-btn-wa");
      const cs = a && getComputedStyle(a);
      return { title: li.querySelector("h2").textContent, btn: a?.textContent.trim(), href: a?.getAttribute("href"), target: a?.target, iconFirst: a?.firstElementChild?.tagName === "svg",
        bg: cs?.backgroundColor, border: cs?.borderTopColor, color: cs?.color, w: a?.getBoundingClientRect().width, cardW: li.getBoundingClientRect().width, h: a?.getBoundingClientRect().height };
    }));
    check(`${label}: Mis pedidos muestra códigos, nunca el número interno`, r[0].title === "Yerbas · Pedido PV-ABCDEF0003" && r[1].title === "Pedido PV-ABCDEF0002" && r[2].title === "Compra PV-ABCDEF0001" && !(await page.evaluate(() => /#777|#650|#610/.test(document.body.textContent))), JSON.stringify(r.map((x) => x.title)));
    const btn = r[0];
    check(`${label}: botón «Consultar estado de mi pedido» con ícono de WhatsApp al principio`, btn.btn === "Consultar estado de mi pedido" && btn.iconFirst, JSON.stringify(btn));
    check(`${label}: fondo transparente, borde y texto verde WhatsApp`, btn.bg === "rgba(0, 0, 0, 0)" && btn.border === "rgb(37, 211, 102)" && btn.color === "rgb(37, 211, 102)", JSON.stringify([btn.bg, btn.border, btn.color]));
    const text = decodeURIComponent((btn.href ?? "").split("text=")[1] ?? "");
    check(`${label}: abre el WhatsApp comercial con el código, sin el número interno`, btn.href?.startsWith("https://wa.me/5491160554815?text=") && btn.target === "_blank" && text.includes("pedido de yerbas PV-ABCDEF0003") && !text.includes("777"), text);
    check(`${label}: también en el pedido de la tienda; no en la compra del local`, r[1].btn === "Consultar estado de mi pedido" && decodeURIComponent(r[1].href).includes("PV-ABCDEF0002") && !r[2].btn);
    check(`${label}: tamaño cómodo para tocar (≥ 44 px)${vp.width < 700 ? " y ancho completo en celular" : ""}`, btn.h >= 44 && (vp.width >= 700 || btn.w > btn.cardW * 0.8), JSON.stringify([btn.h, btn.w, btn.cardW]));
    const writesBefore = st.writes.length;
    const popup = ctx.waitForEvent("page", { timeout: 8000 }).catch(() => null);
    await page.click(".acc-order .acc-btn-wa");
    await popup;
    await page.waitForTimeout(300);
    check(`${label}: tocarlo abre WhatsApp en otra pestaña y no crea ni cambia pedidos`, popups.length === 1 && st.writes.length === writesBefore, JSON.stringify(st.writes.slice(writesBefore)));
    check(`${label}: sin desborde horizontal`, await noOverflow(page));
    if (OUT) await page.screenshot({ path: `${OUT}/mis-pedidos-${label}.png`, fullPage: true });
    check(`${label}: sin errores de JavaScript`, !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // ---------------- Tienda sin service worker ----------------
  { const { ctx, page } = await store({ width: 390, height: 844 });
    await openYerbas(page);
    const swYerbas = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    await page.goto(BASE + "/");
    await page.waitForTimeout(1500);
    const swHome = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);
    const manifestHome = await page.evaluate(() => !!document.querySelector('link[rel="manifest"]'));
    check("la tienda (/ y /yerbas) no registra service worker ni manifest: carrito y caché sin cambios", swYerbas === 0 && swHome === 0 && !manifestHome);
    await ctx.close(); }

  // ---------------- Panel ----------------
  function adminState() {
    const st = catalogState();
    const H = 3600e3, iso = (ms) => new Date(Date.now() + ms).toISOString();
    const base = { kind: "yerbas", customer_id: "c1", customer_email: "ana@test.com", customer_phone: "11 4444 1234", stock_applied: false, ready_at: null, delivered_at: null, auto_delivered: false, auto_deliver: true, cancel_reason: null, cancelled_at: null, auto_cancelled: false, item_count: 1, total: 13900 };
    const item = (id) => ({ id, product_id: 61, variant_id: 102, product_name: "Canarias Suave", variant_name: "1kg", unit_price: 13900, quantity: 1, line_total: 13900 });
    st.orders = [
      { ...base, id: 301, public_code: "PV-FEDCBA0003", status: "pendiente", created_at: iso(-1 * H), expires_at: iso(11 * H), customer_name: "Ana Pérez", order_items: [item(1)] },
      { ...base, id: 302, public_code: "PV-FEDCBA0001", status: "pendiente", created_at: iso(-2 * H), expires_at: iso(10 * H), customer_name: "Beto Gómez", order_items: [item(2)] },
    ];
    st.order_events = {};
    st.devices = [];
    st.push = [];
    return st;
  }
  function pushExtra({ p, m, body, json, rows, st, url }) {
    const a = () => body() ?? {};
    if (p === "/rest/v1/rpc/run_order_maintenance") return json({ cancelados: [], entregados: [] });
    if (p === "/rest/v1/rpc/admin_push_subscribe") { const x = a(); st.push.push(["subscribe", x]); st.devices = st.devices.filter((d) => d.endpoint !== x.endpoint); st.devices.push({ id: st.devices.length + 1, endpoint: x.endpoint, label: x.label, created_at: new Date().toISOString(), last_success_at: null, last_error: null, failure_count: 0, disabled_at: null }); return json({ id: 1 }); }
    if (p === "/rest/v1/rpc/admin_push_unsubscribe") { const x = a(); st.push.push(["unsubscribe", x]); const had = st.devices.some((d) => d.endpoint === x.endpoint); st.devices = st.devices.filter((d) => d.endpoint !== x.endpoint); return json(had); }
    if (p === "/rest/v1/rpc/admin_push_test") { st.push.push(["test"]); return json({ devices: st.devices.length }); }
    if (p === "/rest/v1/admin_push_subscriptions") return rows(st.devices);
    if (p === "/rest/v1/orders" && m === "GET") {
      const id = url.searchParams.get("id");
      const list = id ? st.orders.filter((o) => `eq.${o.id}` === id) : st.orders;
      return rows(list);
    }
    if (p === "/rest/v1/order_events") return rows([]);
    return undefined;
  }
  async function admin(vp, { ios = false } = {}) {
    const st = adminState();
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700,
      ...(ios ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" } : {}) });
    await installMock(ctx, st, { extra: pushExtra });
    await ctx.route("**/api/push-config", (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ publicKey: VAPID_TEST.publicKey }) }));
    // Servicio de push simulado (Chrome sin conexión a FCM): suscripción falsa.
    await ctx.addInitScript(() => {
      window.__perm = { asked: 0 };
      const origReq = Notification.requestPermission.bind(Notification);
      Notification.requestPermission = (...x) => { window.__perm.asked++; return origReq(...x); };
      let current = null;
      const fake = (key) => ({ endpoint: "https://fcm.googleapis.com/fcm/send/test-device-123", options: { applicationServerKey: key },
        toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "B" + "x".repeat(86), auth: "a".repeat(22) } }; },
        async unsubscribe() { current = null; return true; } });
      PushManager.prototype.subscribe = async function (opts) { current = fake(opts.applicationServerKey.buffer ?? opts.applicationServerKey); return current; };
      PushManager.prototype.getSubscription = async function () { return current; };
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (msg) => { if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) errors.push(msg.text()); });
    return { ctx, page, st, errors };
  }

  for (const [label, vp] of [["390", { width: 390, height: 844 }], ["escritorio", { width: 1440, height: 900 }]]) {
    // Códigos en la lista y el detalle
    { const { ctx, page, errors } = await admin(vp);
      await page.goto(BASE + "/admin/#/pedidos");
      await page.waitForSelector(".order-card", { timeout: 20000 });
      const nums = await page.$$eval(".order-num", (els) => els.map((e) => e.textContent));
      check(`panel ${label}: la lista muestra los códigos`, JSON.stringify(nums) === JSON.stringify(["PV-FEDCBA0003", "PV-FEDCBA0001"]), JSON.stringify(nums));
      await page.fill('input[type="search"]', "pvfedcba0001");
      await page.waitForTimeout(300);
      const filtered = await page.$$eval(".order-num", (els) => els.map((e) => e.textContent));
      check(`panel ${label}: se busca por código (sin guion)`, JSON.stringify(filtered) === '["PV-FEDCBA0001"]', JSON.stringify(filtered));
      await page.goto(BASE + "/admin/#/pedidos/301");
      await page.waitForSelector("h1", { timeout: 10000 });
      await page.waitForFunction(() => /Pedido PV-FEDCBA0003/.test(document.querySelector("h1")?.textContent ?? ""), null, { timeout: 10000 });
      const sub = await page.textContent(".page-sub");
      const waHref = await page.evaluate(() => [...document.querySelectorAll("a[href^='https://wa.me/']")].map((a) => decodeURIComponent(a.href)).join(" "));
      check(`panel ${label}: el detalle se titula con el código (Nº interno aparte) y el WhatsApp al cliente lo usa`, /Nº interno 301/.test(sub) && waHref.includes("PV-FEDCBA0003") && !waHref.includes("#301"), sub + " | " + waHref);
      check(`panel ${label}: sin errores de JavaScript`, !errors.length, errors.join(" | "));
      await ctx.close(); }

    // Notificaciones
    { const { ctx, page, st, errors } = await admin(vp);
      await ctx.grantPermissions(["notifications"], { origin: BASE });
      await page.goto(BASE + "/admin/#/notificaciones");
      await page.waitForSelector(".push-state", { timeout: 20000 });
      const before = await page.evaluate(async () => ({ state: document.querySelector(".push-state").textContent, asked: window.__perm.asked, sw: (await navigator.serviceWorker.getRegistrations()).length,
        btn: [...document.querySelectorAll(".actions button")].map((b) => b.textContent) }));
      check(`notificaciones ${label}: al entrar no pide permiso ni registra nada`, before.asked === 0 && before.sw === 0 && /Desactivadas/.test(before.state) && before.btn.includes("Activar notificaciones"), JSON.stringify(before));
      if (OUT) await page.screenshot({ path: `${OUT}/notificaciones-${label}.png`, fullPage: true });
      await page.click("text=Activar notificaciones");
      const activated = await page.waitForFunction(() => /Activadas/.test(document.querySelector(".push-state")?.textContent ?? ""), null, { timeout: 10000 }).then(() => true, () => false);
      if (!activated) {
        check(`notificaciones ${label}: activar`, false, JSON.stringify(await page.evaluate(() => document.querySelector(".toast")?.textContent)) + " " + errors.join(" | "));
        await ctx.close();
        continue;
      }
      const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration("/admin/"); return r && { scope: r.scope, script: (r.active || r.waiting || r.installing)?.scriptURL }; });
      const sub = st.push.find((x) => x[0] === "subscribe")?.[1];
      check(`notificaciones ${label}: el botón pide permiso, registra /admin/sw.js (alcance /admin/) y guarda la suscripción`, before.asked === 0 && reg?.scope === BASE + "/admin/" && reg.script === BASE + "/admin/sw.js"
        && sub?.endpoint === "https://fcm.googleapis.com/fcm/send/test-device-123" && /^B/.test(sub.p256dh) && sub.auth_secret?.length === 22 && !!sub.label, JSON.stringify([reg, sub]));
      await page.waitForSelector(".push-chip", { timeout: 5000 });
      check(`notificaciones ${label}: «Tus dispositivos» marca este dispositivo`, (await page.textContent(".push-chip")) === "Este");
      await page.click("text=Enviar notificación de prueba");
      await page.waitForTimeout(500);
      check(`notificaciones ${label}: «Enviar notificación de prueba» llama a la base`, st.push.some((x) => x[0] === "test"));
      await page.click("text=Desactivar en este dispositivo");
      await page.waitForFunction(() => /Desactivadas/.test(document.querySelector(".push-state")?.textContent ?? ""), null, { timeout: 10000 });
      check(`notificaciones ${label}: desactivar borra la suscripción de este dispositivo`, st.push.some((x) => x[0] === "unsubscribe" && x[1].endpoint.includes("test-device-123")) && st.devices.length === 0);
      check(`notificaciones ${label}: sin desborde ni errores`, (await noOverflow(page)) && !errors.length, errors.join(" | "));
      await ctx.close(); }
  }

  // iPhone en Safari (sin instalar): instrucciones, sin botón
  { const { ctx, page, errors } = await admin({ width: 393, height: 852 }, { ios: true });
    await page.goto(BASE + "/admin/#/notificaciones");
    await page.waitForSelector(".push-steps", { timeout: 20000 });
    const r = await page.evaluate(() => ({ steps: document.querySelector(".push-steps").innerText, btn: [...document.querySelectorAll("button")].some((b) => /Activar notificaciones/.test(b.textContent)), asked: window.__perm.asked }));
    check("iPhone sin instalar: instrucciones (Safari → Compartir → Agregar a inicio) y sin botón de activar", /Safari/.test(r.steps) && /Agregar a inicio/.test(r.steps) && /Permitir/.test(r.steps) && !r.btn && r.asked === 0, JSON.stringify(r));
    if (OUT) await page.screenshot({ path: `${OUT}/notificaciones-iphone.png`, fullPage: true });
    check("iPhone: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // Manifest e íconos
  { const { ctx, page } = await admin({ width: 1440, height: 900 });
    await page.goto(BASE + "/admin/");
    await page.waitForTimeout(800);
    const r = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
      const m = await (await fetch(link)).json();
      const sizes = await Promise.all(m.icons.map((i) => new Promise((res) => { const im = new Image(); im.onload = () => res(`${im.naturalWidth}x${im.naturalHeight}`); im.onerror = () => res("error"); im.src = i.src; })));
      const apple = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href");
      const appleSize = await new Promise((res) => { const im = new Image(); im.onload = () => res(`${im.naturalWidth}x${im.naturalHeight}`); im.onerror = () => res("error"); im.src = apple; });
      return { link, m, sizes, appleSize, capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content };
    });
    check("manifest del panel: standalone, alcance /admin/, inicio en el panel", r.m.display === "standalone" && r.m.scope === "/admin/" && r.m.start_url.startsWith("/admin/") && r.m.short_name === "Povmatero", JSON.stringify(r.m).slice(0, 200));
    check("íconos 192, 512, maskable 512 y apple-touch 180 cargan", JSON.stringify(r.sizes) === '["192x192","512x512","512x512"]' && r.appleSize === "180x180" && r.capable === "yes", JSON.stringify([r.sizes, r.appleSize]));
    await ctx.close(); }

  // Service worker: push y toque (en un entorno simulado del worker)
  { const code = fs.readFileSync(path.join(ROOT, "admin/sw.js"), "utf8");
    const listeners = {}, shown = [], opened = [], navigated = [];
    const windows = [];
    const self = {
      location: { origin: "https://povmatero.test" },
      addEventListener: (t, fn) => { listeners[t] = fn; },
      skipWaiting: () => {},
      registration: { showNotification: async (title, opts) => shown.push({ title, ...opts }) },
      clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async (u) => opened.push(u) },
    };
    vm.runInNewContext(code, { self, URL, console });
    const fire = async (type, ev) => { let p; listeners[type]({ ...ev, waitUntil: (x) => { p = x; } }); await p; };
    await fire("push", { data: { json: () => ({ title: "Nuevo pedido de yerbas", body: "Ana P. · PV-FEDCBA0003 · 2 paquetes · $23.200", url: "/admin/#/pedidos/301", tag: "pedido-301" }) } });
    check("SW: muestra la notificación con título, texto, etiqueta y enlace al pedido", shown[0]?.title === "Nuevo pedido de yerbas" && shown[0].body.includes("PV-FEDCBA0003") && shown[0].tag === "pedido-301" && shown[0].data.url === "/admin/#/pedidos/301", JSON.stringify(shown[0]));
    await fire("push", { data: { json: () => ({ title: "x", url: "https://evil.com/robo" }) } });
    check("SW: nunca abre direcciones fuera del panel", shown[1].data.url === "/admin/#/pedidos");
    await fire("push", { data: { json: () => { throw new Error("no json"); }, text: () => "hola" } });
    check("SW: un push sin formato igual muestra una notificación (iOS lo exige)", shown[2]?.title === "Povmatero" && shown[2].body === "hola");
    await fire("notificationclick", { notification: { close() {}, data: { url: "/admin/#/pedidos/301" } } });
    check("SW: tocarla con el panel cerrado abre el pedido", opened[0] === "https://povmatero.test/admin/#/pedidos/301", JSON.stringify(opened));
    windows.push({ url: "https://povmatero.test/admin/#/inicio", focus: async () => {}, navigate: async (u) => navigated.push(u) });
    await fire("notificationclick", { notification: { close() {}, data: { url: "/admin/#/pedidos/302" } } });
    check("SW: con el panel abierto lo reutiliza y navega al pedido", navigated[0] === "https://povmatero.test/admin/#/pedidos/302" && opened.length === 1);
    check("SW: no intercepta pedidos de red (sin «fetch»): la caché no cambia", !listeners.fetch && !/caches\./.test(code)); }

  // Service worker real en Chrome: push entregado por DevTools → el worker arma
  // la notificación. (El Chrome que maneja Playwright no muestra notificaciones
  // del sistema ni con showNotification directo: se espía esa llamada dentro del
  // worker real, que es lo que haría el teléfono.)
  { const { ctx, page } = await admin({ width: 1440, height: 900 });
    await ctx.grantPermissions(["notifications"], { origin: BASE });
    await page.goto(BASE + "/admin/#/notificaciones");
    await page.waitForSelector(".push-state");
    await page.click("text=Activar notificaciones");
    await page.waitForFunction(() => /Activadas/.test(document.querySelector(".push-state")?.textContent ?? ""), null, { timeout: 10000 });
    let worker = ctx.serviceWorkers().find((w) => w.url().endsWith("/admin/sw.js"));
    if (!worker) worker = await ctx.waitForEvent("serviceworker", { timeout: 5000 }).catch(() => null);
    const cdp = await ctx.newCDPSession(page);
    const regs = [];
    cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations));
    await cdp.send("ServiceWorker.enable");
    await page.waitForTimeout(800);
    const reg = regs.find((r) => r.scopeURL === BASE + "/admin/");
    let shown = [];
    if (reg && worker) {
      await worker.evaluate(() => { self.__shown = []; self.registration.showNotification = (title, opts) => { self.__shown.push({ title, ...opts }); return Promise.resolve(); }; });
      await cdp.send("ServiceWorker.deliverPushMessage", { origin: BASE, registrationId: reg.registrationId, data: JSON.stringify({ title: "Nuevo pedido de yerbas", body: "Beto G. · BG-002 · 1 paquete · $11.600", url: "/admin/#/pedidos/302", tag: "pedido-302" }) });
      for (let i = 0; i < 20 && !shown.length; i++) { await page.waitForTimeout(250); shown = await worker.evaluate(() => self.__shown); }
    }
    check("Chrome real: el push llega al service worker y arma la notificación del pedido", shown.length === 1 && shown[0].title === "Nuevo pedido de yerbas" && shown[0].tag === "pedido-302" && shown[0].data?.url === "/admin/#/pedidos/302" && /BG-002/.test(shown[0].body), JSON.stringify([!!reg, !!worker, shown]));
    await ctx.close(); }

  console.log(`\n${ok} OK · ${fail} fallas`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
