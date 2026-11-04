// Panel: stock rápido (movimiento, proveedor, venta), avisos de reposición y
// estados Pendiente/Listo/Entregado. Supabase simulado en memoria: no escribe
// nada en la base real. La lógica de la base está probada aparte (db-test).
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5197";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const ADMIN = "99999999-9999-4999-8999-999999999999";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: ADMIN, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: ADMIN, email: "admin@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };

function freshState({ migrated = true } = {}) {
  const variants = [
    { id: 11, name: "1kg", price: 11600, stock: 5, track_stock: true, is_active: true, sort_order: 1, product: { id: 1, name: "Canarias Tradicional", brand: "Canarias", is_active: true, sort_order: 1, category: { slug: "yerbas", name: "Yerbas" } } },
    { id: 12, name: "500gr", price: 5600, stock: 0, track_stock: true, is_active: true, sort_order: 0, product: { id: 1, name: "Canarias Tradicional", brand: "Canarias", is_active: true, sort_order: 1, category: { slug: "yerbas", name: "Yerbas" } } },
    { id: 21, name: "Único", price: 30000, stock: 3, track_stock: true, is_active: true, sort_order: 0, product: { id: 2, name: "Mate Imperial", brand: null, is_active: true, sort_order: 5, category: { slug: "mates", name: "Mates" } } },
  ];
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const orders = [
    { id: 101, kind: "yerbas", status: "pendiente", expires_at: iso(now + 3600e3), created_at: iso(now - 3600e3), customer_name: "Ana Pérez", customer_phone: "11 4444 1234", item_count: 1, total: 11600, order_items: [{ id: 1, variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", unit_price: 11600, quantity: 1, line_total: 11600 }] },
    { id: 102, kind: "yerbas", status: "confirmado", expires_at: null, created_at: iso(now - 7200e3), customer_name: "Beto", item_count: 1, total: 11600, order_items: [{ id: 2, variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", unit_price: 11600, quantity: 1, line_total: 11600 }] },
    { id: 103, kind: "yerbas", status: "listo", ready_at: iso(now - 25 * 3600e3), auto_deliver: true, created_at: iso(now - 30 * 3600e3), customer_name: "Caro", item_count: 1, total: 5600, order_items: [] },
    { id: 104, kind: "yerbas", status: "entregado", auto_delivered: true, delivered_at: iso(now - 3600e3), created_at: iso(now - 50 * 3600e3), customer_name: "Dani", item_count: 1, total: 5600, order_items: [] },
  ].map((o) => ({ updated_at: o.created_at, status_changed_at: o.created_at, stock_applied: ["listo", "entregado"].includes(o.status), customer_id: null, customer_email: "", note: "", ready_at: null, delivered_at: null, auto_delivered: false, auto_deliver: true, ...o }));
  return { migrated, variants, orders, moves: [], keys: new Set(), supplier: [], nextId: 500, calls: [], events: {}, alerts: [
    { id: 1, product_id: 1, variant_id: 11, product_name: "Canarias Tradicional", variant_name: "1kg", user_id: "u1", customer_name: "Ana Pérez", email: "ana@test.com", phone: "11 4444 1234", created_at: iso(now - 86400e3), available: 5, due: true },
    { id: 2, product_id: 1, variant_id: 12, product_name: "Canarias Tradicional", variant_name: "500gr", user_id: "u2", customer_name: "Beto Gómez", email: "beto@test.com", phone: null, created_at: iso(now - 86400e3), available: 0, due: false },
  ], notified: new Set(), slowMove: 0, failNextMove: false };
}

(async () => {
  const srv = await serve(ROOT, 5197);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });

  async function open(hash, st, vp = { width: 1440, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript((s) => { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); }, SESSION);
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: BASE });
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      const err = (status, code, message, hint) => json({ code, message, hint, details: null }, status);
      const body = () => { try { return JSON.parse(req.postData() || "null"); } catch { return null; } };
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (p === "/rest/v1/admin_users") return json({ role: "owner" });
      if (p.startsWith("/rest/v1/rpc/")) {
        const fn = p.slice(13), a = body() ?? {};
        st.calls.push([fn, a]);
        const newOnly = ["admin_stock_movement", "admin_stock_preview", "admin_create_supplier_order", "admin_receive_supplier_order", "admin_cancel_supplier_order", "admin_create_sale", "admin_link_order_customer", "admin_cancel_sale", "admin_restock_alerts", "admin_mark_restock_notified", "deliver_due_yerba_orders", "run_order_maintenance"];
        if (!st.migrated && newOnly.includes(fn)) return err(404, "PGRST202", "Could not find the function");
        if (fn === "variant_commitments") return json([{ variant_id: 11, quantity: 1 }]);
        // 20261112: el panel llama al mantenimiento (cancelación 72 h + entrega 24 h).
        if (fn === "run_order_maintenance") {
          const due = st.orders.filter((o) => o.kind === "yerbas" && o.status === "listo" && o.auto_deliver && Date.now() - new Date(o.ready_at) >= 24 * 3600e3);
          due.forEach((o) => { o.status = "entregado"; o.auto_delivered = true; o.delivered_at = new Date().toISOString(); });
          const late = st.orders.filter((o) => o.kind === "yerbas" && o.status === "pendiente" && o.expires_at && new Date(o.expires_at) <= new Date());
          late.forEach((o) => { o.status = "cancelado"; o.auto_cancelled = true; o.cancel_reason = "Cancelado por falta de respuesta"; });
          return json({ cancelados: late.map((o) => o.id), entregados: due.map((o) => o.id) });
        }
        if (fn === "deliver_due_yerba_orders") {
          const due = st.orders.filter((o) => o.kind === "yerbas" && o.status === "listo" && o.auto_deliver && Date.now() - new Date(o.ready_at) >= 24 * 3600e3);
          due.forEach((o) => { o.status = "entregado"; o.auto_delivered = true; o.delivered_at = new Date().toISOString(); });
          return json(due.map((o) => o.id));
        }
        if (fn === "admin_set_order_status") {
          const o = st.orders.find((x) => x.id === a.order_id);
          const allowedOld = { pendiente: ["confirmado", "cancelado"], confirmado: ["preparando", "cancelado"], preparando: ["listo", "cancelado"], listo: ["entregado", "preparando", "cancelado"] };
          const allowedNew = { pendiente: ["confirmado", "cancelado", "listo"], confirmado: ["preparando", "cancelado", "listo"], preparando: ["listo", "cancelado"], listo: ["entregado", "preparando", "cancelado"], entregado: ["listo"] };
          const allowed = (st.migrated ? allowedNew : allowedOld)[o.status] ?? [];
          if (a.status !== o.status && !allowed.includes(a.status)) return err(400, "23514", `No se puede pasar un pedido de «${o.status}» a «${a.status}».`, "invalid_transition");
          const from = o.status;
          o.status = a.status; o.stock_applied = ["listo", "entregado"].includes(a.status);
          if (a.status === "listo") { o.ready_at = new Date().toISOString(); o.auto_deliver = from !== "entregado"; }
          return json({ id: o.id, status: o.status });
        }
        if (fn === "admin_create_supplier_order") {
          const prev = st.supplier.find((s) => s.client_key && s.client_key === a.client_key);
          if (prev) return json({ ...prev, items: prev.supplier_order_items, repeated: true });
          const s = { id: st.nextId++, supplier: a.supplier ?? "", note: a.note ?? "", status: "pedido", client_key: a.client_key, created_at: new Date().toISOString(), received_at: null, cancelled_at: null,
            supplier_order_items: a.items.map((i, k) => { const v = st.variants.find((x) => x.id === i.variant_id); return { id: k + 1, variant_id: i.variant_id, product_name: v.product.name, variant_name: v.name, quantity: i.quantity, received_quantity: null }; }) };
          st.supplier.unshift(s);
          return json({ ...s, items: s.supplier_order_items });
        }
        if (fn === "admin_receive_supplier_order") {
          const s = st.supplier.find((x) => x.id === a.order_id);
          if (s.status === "recibido") return json({ ...s, already_received: true });
          for (const i of s.supplier_order_items) {
            const q = (a.items ?? []).find((x) => x.variant_id === i.variant_id)?.quantity ?? i.quantity;
            i.received_quantity = q;
            st.variants.find((v) => v.id === i.variant_id).stock += q;
          }
          s.status = "recibido"; s.received_at = new Date().toISOString();
          return json(s);
        }
        if (fn === "admin_cancel_supplier_order") { const s = st.supplier.find((x) => x.id === a.order_id); s.status = "cancelado"; s.cancelled_at = new Date().toISOString(); return json(s); }
        if (fn === "admin_create_sale") {
          const prev = st.orders.find((o) => o.client_key && o.client_key === a.client_key);
          if (prev) return json({ id: prev.id, repeated: true });
          if (!a.customer_id && !a.customer_name) return err(400, "22023", "Escribí el nombre del cliente o elegí una cuenta.", "customer_required");
          const id = st.nextId++;
          const items = a.items.map((i, k) => { const v = st.variants.find((x) => x.id === i.variant_id); v.stock -= i.quantity; return { id: 900 + k, variant_id: v.id, product_name: v.product.name, variant_name: v.name === "Único" ? null : v.name, unit_price: v.price, quantity: i.quantity, line_total: v.price * i.quantity }; });
          st.orders.unshift({ id, kind: "presencial", status: "entregado", stock_applied: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), status_changed_at: null, expires_at: null,
            customer_id: a.customer_id, customer_name: a.customer_name ?? "Beto Gómez", customer_email: "", customer_phone: null, note: a.note ?? "", client_key: a.client_key,
            item_count: items.reduce((n, i) => n + i.quantity, 0), total: items.reduce((n, i) => n + i.line_total, 0), order_items: items, ready_at: null, delivered_at: null, auto_delivered: false, auto_deliver: true });
          st.events[id] = [{ id: 1, event: "creado", from_status: null, to_status: "entregado", detail: {}, created_at: new Date().toISOString() }];
          return json({ id, kind: "presencial", status: "entregado" });
        }
        if (fn === "admin_link_order_customer") { const o = st.orders.find((x) => x.id === a.order_id); o.customer_id = a.customer_id; (st.events[o.id] ??= []).push({ id: 2, event: "vinculado", detail: {}, created_at: new Date().toISOString() }); return json({ id: o.id }); }
        if (fn === "admin_cancel_sale") { const o = st.orders.find((x) => x.id === a.order_id); if (o.status !== "cancelado") { o.status = "cancelado"; o.order_items.forEach((i) => { st.variants.find((v) => v.id === i.variant_id).stock += i.quantity; }); } return json({ id: o.id }); }
        if (fn === "admin_restock_alerts") return json(st.alerts.filter((x) => !st.notified.has(x.id)));
        if (fn === "admin_mark_restock_notified") { const done = a.ids.filter((i) => !st.notified.has(i)); done.forEach((i) => st.notified.add(i)); return json(done); }
        return json(null);
      }
      if (p === "/rest/v1/product_variants") return json(st.variants);
      if (p === "/rest/v1/inventory_movements") {
        if (m === "POST") {
          const row = body();
          st.calls.push(["movement", row]);
          if (st.slowMove) await new Promise((r) => setTimeout(r, st.slowMove));
          if (row.client_key && !st.migrated) return err(400, "PGRST204", "Could not find the 'client_key' column");
          if (row.client_key && st.keys.has(row.client_key)) return err(409, "23505", 'duplicate key value violates unique constraint "inventory_movements_client_key_idx" (client_key)');
          const v = st.variants.find((x) => x.id === row.variant_id);
          if (v.stock + row.quantity < 0) return err(400, "23514", 'new row violates check constraint "product_variants_stock_check"');
          v.stock += row.quantity;
          if (row.client_key) st.keys.add(row.client_key);
          const mv = { id: st.moves.length + 1, ...row, stock_after: v.stock, created_at: new Date().toISOString() };
          st.moves.unshift(mv);
          if (st.failNextMove) { st.failNextMove = false; return route.abort("failed"); }   // se guardó pero la respuesta no llegó
          return json(mv, 201);
        }
        if (url.searchParams.get("client_key")) return json(st.moves.find((x) => `eq.${x.client_key}` === url.searchParams.get("client_key")) ?? null);
        return json(st.moves.filter((x) => x.reference === "Movimiento rápido"));
      }
      if (p === "/rest/v1/supplier_orders") return st.migrated ? json(st.supplier) : err(404, "PGRST205", "Could not find the table");
      if (p === "/rest/v1/customer_profiles") return json([{ user_id: "b0b0b0b0-0000-4000-8000-000000000001", first_name: "Beto", last_name: "Gómez", email: "beto@test.com", phone: "11 5555 1234" }]);
      if (p === "/rest/v1/order_events") return json(st.events[Number((url.searchParams.get("order_id") ?? "").replace("eq.", ""))] ?? []);
      if (p === "/rest/v1/orders") {
        const sel = url.searchParams.get("select") ?? "";
        if (!st.migrated && /ready_at/.test(sel)) return err(400, "42703", "column orders.ready_at does not exist");
        if (m === "HEAD") return route.fulfill({ status: 200, headers: { "content-range": "0-0/2" }, body: "" });
        const idq = url.searchParams.get("id");
        if (idq) return json(st.orders.find((o) => `eq.${o.id}` === idq) ?? null);
        const kind = (url.searchParams.get("kind") ?? "").replace("eq.", "");
        return json(st.orders.filter((o) => !kind || o.kind === kind));
      }
      if (p === "/rest/v1/storefront_catalog") return json([]);
      return json([]);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource/.test(mm.text())) errors.push(mm.text()); });
    await page.goto(BASE + "/admin/" + hash);
    await page.waitForFunction(() => { const c = document.getElementById("adminContent"); return c && c.innerText.trim() && !/^Cargando/.test(c.innerText.trim()); }, null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { ctx, page, errors };
  }
  const text = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const toastText = (page) => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");

  // ---------- 5.1 (detalle en conciliation-test) ----------
  { const st = freshState(); const { ctx, page, errors } = await open("#/stock-rapido", st);
    const nav = await page.evaluate(() => [...document.querySelectorAll("#sideNav a")].map((a) => a.textContent.trim()));
    check("menú: «Stock rápido» y «Avisos de reposición»", nav.includes("Stock rápido") && nav.includes("Avisos de reposición"), nav.join(","));
    const items = await page.evaluate(() => [...document.querySelectorAll(".pick-item")].map((b) => b.innerText));
    check("movimiento: por defecto solo yerbas (2 presentaciones)", items.length === 2 && items.every((t) => /Canarias/.test(t)), items.join(" | "));
    await page.fill(".picker input[type=search]", "500");
    await page.waitForTimeout(200);
    check("movimiento: búsqueda filtra por presentación", (await page.$$(".pick-item")).length === 1);
    check("movimiento: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 5.1 sin migración: como antes (un movimiento directo) ----------
  { const st = freshState({ migrated: false }); const { ctx, page, errors } = await open("#/stock-rapido", st);
    await page.click(".pick-item");
    await page.fill('input[aria-label="Cantidad"]', "1");
    await page.click('.panel .actions .btn-primary');
    await page.waitForTimeout(1500);
    const posts = st.calls.filter(([k]) => k === "movement");
    check("movimiento sin migración: se registra directo, una vez, como antes", posts.length === 1 && st.moves.length === 1 && posts[0][1].quantity === 1, JSON.stringify(posts));
    check("movimiento sin migración: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 5.2 Proveedor: ver supplier-test.cjs ----------

  // ---------- 5.3 Venta presencial + vincular + anular ----------
  { const st = freshState(); const { ctx, page, errors } = await open("#/stock-rapido?tab=venta", st);
    await page.click('.seg-buttons button:has-text("Sin cuenta")');
    await page.fill('input[placeholder="Nombre y apellido"]', "Juan del barrio");
    await page.check(".check-inline input");
    await page.fill('.picker input[placeholder^="Buscar producto"]', "mate");
    await page.waitForTimeout(200);
    await page.click(".pick-item");
    await page.waitForTimeout(200);
    check("venta: todo el catálogo (mate) con precio y total", /\$\s?30\.000/.test(await text(page, ".order-total")), await text(page, ".order-total"));
    await page.click('button:has-text("Registrar venta")');
    await page.waitForTimeout(2000);
    const sale = st.calls.filter(([k]) => k === "admin_create_sale");
    check("venta: enviada una vez con nombre (Sin asignar) y clave", sale.length === 1 && sale[0][1].customer_name === "Juan del barrio" && !sale[0][1].customer_id && sale[0][1].client_key);
    check("venta: lleva al pedido creado", (await page.evaluate(() => location.hash)) === "#/pedidos/500");
    check("venta: detalle muestra «Sin asignar» y opción de vincular", /Sin asignar/.test(await text(page, "#adminContent")) && !!(await page.$('button:has-text("Vincular a una cuenta")')));
    await page.click('button:has-text("Vincular a una cuenta")');
    await page.waitForTimeout(700);
    await page.click(".pick-item");
    await page.click('button:has-text("Sí, vincular")');
    await page.waitForTimeout(1200);
    check("venta: vinculada a la cuenta (misma venta)", st.orders.find((o) => o.id === 500).customer_id === "b0b0b0b0-0000-4000-8000-000000000001" && !(await page.$('button:has-text("Vincular a una cuenta")')));
    const stockMate = st.variants.find((v) => v.id === 21).stock;
    await page.click('button:has-text("Anular venta")');
    await page.click('button:has-text("Sí, anular")');
    await page.waitForTimeout(1200);
    check("venta: anular devuelve el stock", st.variants.find((v) => v.id === 21).stock === stockMate + 1 && /anulada/i.test(await text(page, "#adminContent")));
    // lista de ventas
    await page.goto(BASE + "/admin/#/pedidos?tab=presencial"); await page.waitForSelector(".order-card", { timeout: 15000 }).catch(() => {});
    check("ventas: pestaña «Ventas» en Pedidos", /Venta anulada|Venta/.test(await text(page, ".order-list")));
    check("venta: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 3. Avisos de reposición (panel) ----------
  { const st = freshState(); const { ctx, page, errors } = await open("#/avisos", st);
    const body = await text(page, "#adminContent");
    check("avisos: «Para avisar (1)» y «Esperando (1)»", /Para avisar \(1\)/.test(body) && /Esperando reposición \(1\)/.test(body), body.slice(0, 300));
    const wa = await page.getAttribute('.alert-row a:has-text("WhatsApp")', "href");
    check("avisos: WhatsApp con el mensaje de la presentación", /wa\.me\/5491144441234\?text=.*Canarias%20Tradicional%201kg/.test(wa), wa);
    await page.click('.alert-row button:has-text("Marcar avisado")');
    await page.waitForTimeout(1200);
    check("avisos: marcado → sale de «Para avisar»", /Para avisar \(0\)/.test(await text(page, "#adminContent")) && st.notified.has(1));
    check("avisos: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }
  { const st = freshState({ migrated: false }); const { ctx, page } = await open("#/avisos", st);
    check("avisos sin migración: explica que falta aplicarla", /Falta aplicar la migración/.test(await text(page, "#adminContent")));
    await ctx.close(); }

  // ---------- 6. Estados ----------
  for (const migrated of [true, false]) {
    const tag = migrated ? "base migrada" : "base actual (sin 20261110)";
    const st = freshState({ migrated }); const { ctx, page, errors } = await open("#/pedidos", st);
    await page.waitForSelector(".order-card", { timeout: 15000 }).catch(() => {});
    const chips = await page.evaluate(() => [...document.querySelectorAll(".order-filter-main")].map((b) => b.innerText.replace(/\s+/g, " ")));
    check(`${tag}: filtros principales Pendientes / Listos / Entregados`, chips.length === 3 && /Pendientes/.test(chips[0]) && /Listos/.test(chips[1]) && /Entregados/.test(chips[2]), chips.join(","));
    if (migrated) {
      check(`${tag}: al abrir, la entrega automática pasa el «Listo» de hace 25 h`, st.orders.find((o) => o.id === 103).status === "entregado" && st.calls.some(([k]) => k === "run_order_maintenance" || k === "deliver_due_yerba_orders"));
    } else {
      check(`${tag}: sin la función, la lista carga igual`, (await page.$$(".order-card")).length > 0, (await text(page, "#adminContent")).slice(0, 300) + " | calls " + JSON.stringify(st.calls.map((c) => c[0])));
    }
    check(`${tag}: «Pendientes» agrupa pendiente y confirmado (2)`, /Pendientes\s*2/.test(chips[0]), chips[0]);
    // Marcar listo un confirmado
    await page.goto(BASE + "/admin/#/pedidos/102"); await page.waitForSelector(".order-steps", { timeout: 15000 }).catch(() => {});
    const steps = await page.evaluate(() => [...document.querySelectorAll(".order-step-label")].map((x) => x.textContent));
    check(`${tag}: pasos Pendiente → Listo → Entregado`, steps.join() === "Pendiente,Listo,Entregado", steps.join());
    await page.click('button:has-text("Marcar listo")');
    await page.waitForTimeout(1500);
    const seq = st.calls.filter(([k, a]) => k === "admin_set_order_status" && a.order_id === 102).map(([, a]) => a.status);
    check(`${tag}: «Marcar listo» desde confirmado → listo`, st.orders.find((o) => o.id === 102).status === "listo" && (migrated ? seq.join() === "listo" : seq.join() === "listo,preparando,listo"), seq.join());
    if (migrated) {
      check(`${tag}: muestra cuándo se entrega solo`, /pasa a «Entregado» solo/.test(await text(page, "#adminContent")));
      await page.click('button:has-text("Marcar entregado")'); await page.waitForTimeout(1200);
      await page.click('button:has-text("Volver a «Listo»")'); await page.waitForTimeout(1200);
      check(`${tag}: entregado → «Volver a Listo» (no lo retiró)`, st.orders.find((o) => o.id === 102).status === "listo" && st.orders.find((o) => o.id === 102).auto_deliver === false);
      check(`${tag}: avisa que ya no se entrega solo`, /No se entrega solo/.test(await text(page, "#adminContent")));
      if (OUT) await page.screenshot({ path: `${OUT}/admin-estados.png`, fullPage: true });
    } else {
      await page.goto(BASE + "/admin/#/pedidos/104"); await page.waitForSelector(".order-steps", { timeout: 15000 }).catch(() => {});
      await page.click('button:has-text("Volver a «Listo»")'); await page.waitForTimeout(1200);
      check(`${tag}: «Volver a Listo» explica que falta la migración`, /falta aplicar la migración 20261110/.test(await text(page, "#adminContent .form-error:not([hidden])")), await text(page, "#adminContent .form-error:not([hidden])"));
    }
    check(`${tag}: sin errores de JavaScript`, !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // Celular: stock rápido usable
  { const st = freshState(); const { ctx, page, errors } = await open("#/stock-rapido", st, { width: 390, height: 844 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check("celular: stock rápido sin desplazamiento de costado", !over);
    check("celular: sin errores", !errors.length, errors.join(" | "));
    if (OUT) await page.screenshot({ path: `${OUT}/admin-movimiento-m.png`, fullPage: true });
    await ctx.close(); }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
