// Bloque 4: confirmación del pedido en /yerbas. Supabase simulado (no escribe nada).
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5196";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const UID = "22222222-2222-4222-8222-222222222222";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: UID, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: UID, email: "a@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: { first_name: "ana" } } };

(async () => {
  const srv = await serve(ROOT, 5196);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  let rows = null;

  // mode: "ok" | "stock" | "lost" (se guarda pero no llega la respuesta) | "down" (no se guarda) | "slow"
  async function open(vp, mode) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__init", "1"); } }, SESSION);
    const st = { mode, rpc: 0, saved: [], nextId: 501 };
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      if (p === "/rest/v1/storefront_catalog") {
        if (!rows) { const r = await route.fetch(); rows = await r.json(); }
        return json(rows.map((r) => ({ ...r, stock: 9, track_stock: true })));
      }
      if (p === "/rest/v1/customer_profiles") return json({ phone: "11 5555 1234", first_name: "Ana", last_name: "Paz", email: "a@test.com", marketing_opt_in: false });
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (p === "/rest/v1/rpc/create_yerba_order") {
        st.rpc++;
        const args = JSON.parse(req.postData()), items = args.items;
        const order = { id: st.nextId, public_code: "AP-00" + (st.nextId++ - 500), total: 1000, item_count: 1, status: "pendiente", created_at: new Date().toISOString(), items: items.map((i) => ({ ...i, product_name: "Yerba", variant_name: "1 kg", line_total: 1000 })) };
        if (st.mode === "stock") return json({ code: "23514", message: "No alcanza el stock de: Yerba 1 kg (quedan 0).", hint: "insufficient_stock", details: "[]" }, 400);
        if (st.mode === "down") return route.abort("failed");
        st.saved.push({ id: order.id, client_key: args.client_key, public_code: order.public_code, total: 1000, created_at: order.created_at, order_items: items.map((i) => ({ variant_id: i.variant_id, quantity: i.quantity })) });
        if (st.mode === "lost") return route.abort("failed");
        if (st.mode === "slow") await new Promise((r) => setTimeout(r, 2500));
        return json(order);
      }
      if (p === "/rest/v1/orders") {
        const key = url.searchParams.get('client_key')?.replace(/^eq\./,'');
        return json(key ? st.saved.find(o => o.client_key === key) ?? null : st.saved.slice().reverse());
      }
      if (req.method() !== "GET") return json([]);
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + "/yerbas");
    await page.waitForSelector(".y-variant", { timeout: 20000 });
    await page.waitForTimeout(1200);
    return { ctx, page, errors, st };
  }

  async function addAndOpenCart(page) {
    const v = await page.evaluate(() => { const b = [...document.querySelectorAll(".y-variant:not(.is-out)")][0]; b.scrollIntoView({ block: "center" }); return b.dataset.variant; });
    await page.waitForTimeout(300);
    const box = await page.locator(`.y-variant[data-variant="${v}"]`).first().boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("#productSheet.open");
    await page.waitForTimeout(300);
    await page.click('#productSheet [data-step="1"]:not([disabled])');
    await page.click("#productSheet [data-add]");
    await page.waitForTimeout(1500);
    await page.click("#cartDock");
    await page.waitForSelector("#cartSheet.open");
    await page.waitForTimeout(800);
  }
  const cartCount = (page) => page.evaluate(() => Number(document.getElementById("cartCount").textContent));

  for (const [label, vp] of [["escritorio", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    // 1. Éxito
    { const { ctx, page, errors, st } = await open(vp, "slow");
      const popups = [];
      ctx.on("page", (p) => popups.push(p));
      await addAndOpenCart(page);
      await page.click("#cartSheet [data-send]");
      await page.waitForTimeout(300);
      const during = await page.evaluate(() => ({ text: document.querySelector("#cartSheet [data-send]")?.textContent.trim(), dis: document.querySelector("#cartSheet [data-send]")?.disabled, sent: !!document.querySelector(".y-sent") }));
      check(`${label}: mientras se guarda, «Realizando pedido…» deshabilitado y sin éxito todavía`, during.text === "Realizando pedido…" && during.dis && !during.sent, JSON.stringify(during));
      // clic repetido mientras envía
      await page.evaluate(() => document.querySelector("#cartSheet [data-send]")?.click());
      await page.waitForSelector(".y-sent", { timeout: 10000 });
      await page.waitForTimeout(500);
      const done = await page.evaluate(() => ({
        title: document.querySelector(".y-sent h2")?.textContent, num: document.querySelector(".y-sent-number")?.textContent,
        actions: [...document.querySelectorAll(".y-sent-actions > *")].map((a) => [a.textContent.trim(), a.getAttribute("href"), a.className]),
      }));
      check(`${label}: «Pedido realizado» con el código público`, done.title === "Pedido realizado" && done.num === "Pedido AP-001", JSON.stringify(done));
      check(`${label}: cuatro acciones; «Ver mis pedidos» principal, «Avisar por WhatsApp» segunda`, done.actions.length === 4 && done.actions[0][0] === "Ver mis pedidos" && done.actions[0][1] === "/cuenta?seccion=pedidos" && /y-btn-primary/.test(done.actions[0][2])
        && done.actions[1][0] === "Avisar por WhatsApp" && /^https:\/\/wa\.me\/5491160554815\?text=.*AP-001/.test(done.actions[1][1]) && !/%23501/.test(done.actions[1][1])
        && done.actions[2][0] === "Volver a la góndola de yerbas" && done.actions[3][0] === "Volver a la web" && done.actions[3][1] === "/", JSON.stringify(done.actions));
      check(`${label}: un solo pedido aunque se toque dos veces`, st.rpc === 1, String(st.rpc));
      check(`${label}: el carrito se vació recién con el éxito`, (await cartCount(page)) === 0);
      check(`${label}: no se abre ninguna pestaña «Registrando…»`, popups.length === 0, String(popups.length));
      if (OUT) await page.screenshot({ path: `${OUT}/pedido-ok-${label}.png` });
      // Volver a la góndola
      await page.click(".y-sent-actions [data-close]");
      await page.waitForTimeout(500);
      check(`${label}: «Volver a la góndola» cierra la confirmación`, await page.evaluate(() => !document.getElementById("cartSheet").classList.contains("open")));
      // recargar no reenvía
      await page.reload(); await page.waitForSelector(".y-variant"); await page.waitForTimeout(1500);
      check(`${label}: recargar después del éxito no reenvía`, st.rpc === 1 && (await cartCount(page)) === 0);
      // Ver mis pedidos navega
      check(`${label}: sin errores de JavaScript`, !errors.length, errors.join(" | "));
      await ctx.close(); }

    // 2. Error (sin stock): mensaje, carrito intacto, reintentar
    { const { ctx, page, st } = await open(vp, "stock");
      await addAndOpenCart(page);
      await page.click("#cartSheet [data-send]");
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => ({ msg: document.querySelector("#cartSheet .y-msg:not([hidden])")?.textContent, btn: document.querySelector("#cartSheet [data-send]")?.textContent.trim(), sent: !!document.querySelector(".y-sent") }));
      check(`${label}: si falla, error comprensible y sin éxito`, /No alcanza el stock/.test(r.msg ?? "") && !r.sent, JSON.stringify(r));
      check(`${label}: si falla, el carrito no se vacía y se puede volver a enviar (sin «Reintentar»)`, (await cartCount(page)) === 1 && r.btn === "Realizar pedido", r.btn);
      st.mode = "ok";
      await page.click("#cartSheet [data-send]");
      await page.waitForSelector(".y-sent", { timeout: 10000 });
      check(`${label}: reintentar funciona`, st.rpc === 2 && (await cartCount(page)) === 0);
      await ctx.close(); }

    // 3. Se guardó pero no llegó la respuesta: éxito sin duplicar
    { const { ctx, page, st } = await open(vp, "lost");
      await addAndOpenCart(page);
      await page.click("#cartSheet [data-send]");
      await page.waitForSelector(".y-sent", { timeout: 10000 }).catch(() => {});
      const r = await page.evaluate(() => ({ num: document.querySelector(".y-sent-number")?.textContent }));
      check(`${label}: respuesta perdida pero guardado → éxito con el número, sin reenviar`, r.num === "Pedido AP-001" && st.rpc === 1 && (await cartCount(page)) === 0, JSON.stringify(r) + " rpc " + st.rpc);
      await ctx.close(); }

    // 4. Sin conexión (no se guardó): error y reintento
    { const { ctx, page, st } = await open(vp, "down");
      await addAndOpenCart(page);
      await page.click("#cartSheet [data-send]");
      await page.waitForTimeout(2500);
      const r = await page.evaluate(() => ({ msg: document.querySelector("#cartSheet .y-msg:not([hidden])")?.textContent, btn: document.querySelector("#cartSheet [data-send]")?.textContent.trim() }));
      check(`${label}: sin conexión → error claro, carrito intacto, reintentar`, /conect/i.test(r.msg ?? "") && r.btn === "Realizar pedido" && (await cartCount(page)) === 1, JSON.stringify(r));
      await ctx.close(); }
  }

  // 5. Recarga a mitad del envío: al volver, si se guardó, muestra el éxito y no deja reenviar
  { const { ctx, page, st } = await open({ width: 1440, height: 900 }, "slow");
    await addAndOpenCart(page);
    await page.click("#cartSheet [data-send]");
    await page.waitForTimeout(400);
    await page.reload();
    await page.waitForSelector(".y-variant"); await page.waitForTimeout(3000);
    const r = await page.evaluate(() => ({ sent: document.querySelector(".y-sent-number")?.textContent, open: document.getElementById("cartSheet").classList.contains("open") }));
    check("recarga a mitad del envío: al volver muestra el pedido realizado y vacía el carrito", r.sent === "Pedido AP-001" && r.open && (await cartCount(page)) === 0 && st.rpc === 1, JSON.stringify(r) + " rpc " + st.rpc);
    await ctx.close(); }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
