// Salidas que superan lo disponible: advertencia, conteo, vista previa,
// faltante con confirmación, reintentos y lo mismo en Inventario.
// Supabase simulado: replica la lógica de admin_stock_movement (probada en
// la base con db-test y concurrency-test). No escribe en la base real.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5199";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const ADMIN = "99999999-9999-4999-8999-999999999999";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: ADMIN, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: ADMIN, email: "admin@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };

function state() {
  const prod = { id: 1, name: "Canarias Tradicional", brand: "Canarias", is_active: true, sort_order: 1, category: { slug: "yerbas", name: "Yerbas" } };
  return {
    variants: [
      { id: 11, name: "1kg", price: 11600, stock: 7, track_stock: true, is_active: true, sort_order: 1, product: prod },
      { id: 12, name: "500gr", price: 5600, stock: 4, track_stock: true, is_active: true, sort_order: 0, product: prod },
    ],
    reserved: { 11: 2, 12: 0 },
    orders: { 11: [{ order_id: 301, customer_name: "Ana Pérez", status: "pendiente", expires_at: new Date(Date.now() + 3600e3).toISOString(), quantity: 2 }] },
    ops: new Map(), moves: [], shortages: [], calls: [], failNext: false, forceCount: false,
  };
}
function plan(st, vid, qty, declared) {
  const v = st.variants.find((x) => x.id === vid);
  const res = st.reserved[vid] ?? 0, avail = Math.max(v.stock - res, 0);
  const exceeds = v.track_stock && (qty ?? 0) > avail;
  const after = exceeds ? declared : v.stock - (qty ?? 0);
  return { variant_id: vid, product_name: v.product.name, variant_name: v.name, track_stock: true, stock: v.stock, reserved: res, available: avail,
    requested: qty, exceeds, declared_physical: declared, adjustment: exceeds && declared != null ? declared + qty - v.stock : 0,
    stock_after: after, available_after: after == null ? null : Math.max(after - res, 0), shortage: after == null ? null : Math.max(res - after, 0),
    orders: res ? st.orders[vid] ?? [] : [] };
}

(async () => {
  const srv = await serve(ROOT, 5199);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });

  async function open(url, st) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((s) => { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); }, SESSION);
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    // Página de prueba con el panel de stock de Inventario (solo existe en el test)
    await ctx.route(BASE + "/__inventario.html", (r) => r.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/admin/admin.css"></head><body><main id="adminContent"><section id="s" class="card stock-panel"></section></main>
      <script type="module">
        import { renderStockPanel } from "/admin/js/views/stockPanel.js";
        const v = { id: 11, name: "1kg", stock: 7, cost: null };
        window.changed = 0;
        const draw = () => renderStockPanel(document.getElementById("s"), { variant: v, initialTab: "salida", onChanged: async () => { window.changed++; }, onClose: () => {} });
        draw();
      </script></body></html>` }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), u = new URL(req.url()), p = u.pathname;
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      const body = () => { try { return JSON.parse(req.postData() || "null"); } catch { return null; } };
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (p === "/rest/v1/admin_users") return json({ role: "owner" });
      if (p === "/rest/v1/product_variants") {
        if (u.searchParams.get("id")) { const v = st.variants.find((x) => `eq.${x.id}` === u.searchParams.get("id")); return json({ id: v.id, stock: v.stock, track_stock: true }); }
        return json(st.variants);
      }
      if (p === "/rest/v1/rpc/variant_commitments") return json(Object.entries(st.reserved).filter(([, q]) => q).map(([variant_id, quantity]) => ({ variant_id: Number(variant_id), quantity })));
      if (p === "/rest/v1/rpc/admin_stock_preview") { const a = body(); st.calls.push(["preview", a]); return json(plan(st, a.variant_id, a.quantity, a.declared_physical)); }
      if (p === "/rest/v1/rpc/admin_stock_movement") {
        const a = body(); st.calls.push(["movement", a]);
        if (st.ops.has(a.operation_id)) return json({ ...st.ops.get(a.operation_id), repeated: true });
        const v = st.variants.find((x) => x.id === a.variant_id);
        if (st.forceCount) { st.forceCount = false; st.reserved[v.id] = (st.reserved[v.id] ?? 0) + 3; }   // otro pedido reservó mientras tanto
        const pl = plan(st, v.id, a.movement_type === "salida" ? a.quantity : null, a.declared_physical);
        const err = (hint, message) => json({ code: "23514", message, hint, details: JSON.stringify(pl) }, 400);
        let adj = 0, after, short = 0;
        if (a.movement_type === "entrada") after = v.stock + a.quantity;
        else if (!pl.exceeds) after = v.stock - a.quantity;
        else {
          if (a.declared_physical == null) return err("count_required", "La salida supera el stock disponible: indicá el stock físico real que quedó.");
          adj = a.declared_physical + a.quantity - v.stock; after = a.declared_physical; short = Math.max(pl.reserved - after, 0);
          if (short && !a.confirm_shortage) return err("shortage_confirmation", "No cubre las reservas.");
        }
        const before = v.stock;
        if (adj) st.moves.push({ op: a.operation_id, variant_id: v.id, movement_type: "ajuste", quantity: adj, stock_after: before + adj, reason: "Conciliación", reference: a.source, created_at: new Date().toISOString() });
        st.moves.push({ op: a.operation_id, variant_id: v.id, movement_type: a.movement_type, quantity: a.movement_type === "salida" ? -a.quantity : a.quantity, stock_after: after, reason: a.reason, reference: a.source === "inventario" ? "Inventario" : "Movimiento rápido", created_at: new Date().toISOString() });
        v.stock = after;
        if (short) st.shortages.push({ id: st.shortages.length + 1, variant_id: v.id, physical: after, reserved: pl.reserved, missing: short, created_at: new Date().toISOString(), status: "abierto" });
        const res = { id: a.operation_id, variant_id: v.id, movement_type: a.movement_type, quantity: a.quantity, stock_before: before, reserved: pl.reserved, adjustment: adj, stock_after: after, shortage: short, movements: st.moves.filter((m) => m.op === a.operation_id) };
        st.ops.set(a.operation_id, res);
        if (st.failNext) { st.failNext = false; return route.abort("failed"); }
        return json(res);
      }
      if (p === "/rest/v1/rpc/admin_resolve_shortage") { const a = body(); const f = st.shortages.find((x) => x.id === a.shortage_id); f.status = "resuelto"; return json(f); }
      if (p === "/rest/v1/stock_shortages") return json(st.shortages.filter((f) => f.status === "abierto"));
      if (p === "/rest/v1/inventory_movements") return json(st.moves.slice().reverse().map((m, i) => ({ id: i + 1, ...m })));
      return json([]);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + url);
    await page.waitForFunction(() => document.querySelector(".pick-item, #s form"), null, { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(600);
    return { ctx, page, errors };
  }
  const txt = (page, sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const toast = (page) => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  const moveCalls = (st) => st.calls.filter(([k]) => k === "movement");

  // ================= Stock rápido =================
  { const st = state(); const { ctx, page, errors } = await open("/admin/#/stock-rapido", st);
    const pick = async (name) => { await page.fill(".picker input[type=search]", name); await page.waitForTimeout(150); await page.click(".pick-item"); };
    const go = async (type, qty) => { await page.click(`.seg-buttons button:has-text("${type}")`); await page.fill('input[aria-label="Cantidad"]', String(qty)); await page.click("#adminContent .panel .actions .btn-primary"); await page.waitForTimeout(900); };

    // Salida dentro de lo disponible (7 − 2 = 5): directa
    await pick("1kg");
    await go("Salida", 2);
    check("salida dentro de lo disponible: registrada sin pedir conteo", st.variants[0].stock === 5 && moveCalls(st).length === 1 && !(await page.$(".concile-box")), JSON.stringify(st.calls.map((c) => c[0])));

    // Salida que supera (5 − 2 = 3 disponibles, quiero 5)
    await go("Salida", 5);
    const warn = await txt(page, ".concile-warn");
    check("excede: advertencia con stock físico, reservado, disponible y lo que se retira", /Stock físico registrado\s*5/.test(warn) && /Reservado por pedidos web\s*2/.test(warn) && /Disponible según el sistema\s*3/.test(warn) && /Querés retirar\s*5/.test(warn), warn);
    check("excede: explica la inconsistencia", /no alcanzaría para las 2 unidades reservadas/.test(warn), warn);
    check("excede: no registró nada todavía", moveCalls(st).length === 1 && st.variants[0].stock === 5);
    check("excede: el campo de stock físico real es obligatorio (confirmar deshabilitado)", await page.$eval(".concile-box .btn-primary", (b) => b.disabled));
    await page.fill(".concile-box input[type=number]", "4");
    await page.waitForTimeout(150);
    const prev = await txt(page, ".concile-preview");
    check("vista previa: antes había 9, ajuste +4, salida −5, queda 4, disponible después 2", /Antes de la salida había: 9/.test(prev) && /\+4/.test(prev) && /−5/.test(prev) && /Stock físico después: 4/.test(prev) && /descontando reservas\): 2/.test(prev), prev);
    check("vista previa: alcanza para las reservas (sin faltante)", /Alcanza para las 2 unidades reservadas/.test(await txt(page, ".concile-box")));
    if (OUT) await page.screenshot({ path: `${OUT}/conciliacion.png`, fullPage: true });
    await page.click(".concile-box .btn-primary");
    await page.waitForTimeout(1000);
    const last = moveCalls(st).at(-1)[1];
    check("confirmada: una sola llamada con el stock declarado (4) y la misma operación", last.declared_physical === 4 && last.quantity === 5 && last.movement_type === "salida" && !last.confirm_shortage);
    check("confirmada: ajuste +4 y salida −5 en la misma operación; stock 4", st.variants[0].stock === 4 && st.moves.filter((m) => m.op === last.operation_id).map((m) => m.quantity).join() === "4,-5");
    check("confirmada: avisa la corrección", /corrección de inventario \+4/.test(await toast(page)), await toast(page));

    // Faltante: quedan 4, reservadas 2, disponible 2 → quiero 3 y declaro 0
    await go("Salida", 3);
    await page.fill(".concile-box input[type=number]", "0");
    await page.waitForTimeout(150);
    const danger = await txt(page, ".concile-danger");
    check("faltante: advertencia fuerte con los pedidos afectados", /Faltan 2 unidades/.test(danger) && /Pedido #301/.test(danger) && /Ana Pérez/.test(danger) && /no se cancelan ni se modifican/.test(danger), danger);
    check("faltante: confirmar exige marcar la confirmación administrativa", await page.$eval(".concile-box .btn-primary", (b) => b.disabled));
    await page.check(".concile-ack input");
    await page.click(".concile-box .btn-primary");
    await page.waitForTimeout(1200);
    const lc = moveCalls(st).at(-1)[1];
    check("faltante: registrado con confirm_shortage, stock 0, nunca negativo", lc.confirm_shortage === true && lc.declared_physical === 0 && st.variants[0].stock === 0);
    check("faltante: la presentación aparece en «Faltantes para resolver»", /Faltantes para resolver \(1\)/.test(await txt(page, "#adminContent")) && /Faltan 2/.test(await txt(page, ".panel-alert")));
    await page.click('.panel-alert button:has-text("Marcar resuelto")');
    await page.waitForTimeout(900);
    check("faltante: se marca resuelto", !(await page.$(".panel-alert")));

    // Reintento: se guardó pero no llegó la respuesta → mismo id → no duplica
    await pick("500");
    st.failNext = true;
    await go("Entrada", 3);
    const k1 = moveCalls(st).at(-1)[1].operation_id;
    await page.click("#adminContent .panel .actions .btn-primary");
    await page.waitForTimeout(900);
    const k2 = moveCalls(st).at(-1)[1].operation_id;
    check("reintento: misma operación, no suma dos veces", k1 === k2 && st.variants[1].stock === 7 && /ya estaba registrado/.test(await toast(page)), `${k1} ${k2} ${st.variants[1].stock}`);

    // Carrera: la vista previa no excedía pero otro pedido reservó → la base pide conteo → se abre la conciliación
    st.reserved[12] = 0;
    st.forceCount = true;
    await go("Salida", 6);   // 7 físicas, sin reservas → no excede en la vista previa
    check("carrera: la base pide el conteo y se abre la conciliación con los datos nuevos", !!(await page.$(".concile-box")) && /Reservado por pedidos web\s*3/.test(await txt(page, ".concile-warn")), await txt(page, ".concile-warn"));
    check("stock rápido: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ================= Inventario (mismo criterio) =================
  { const st = state(); const { ctx, page, errors } = await open("/__inventario.html", st);
    const fill = async (qty) => { await page.fill('#s form input[type=number]', String(qty)); await page.fill('#s form input[list="stock-reasons-salida"]', "Venta"); await page.click('#s form button[type=submit]'); await page.waitForTimeout(900); };
    await fill(6);   // 7 − 2 = 5 disponibles
    check("Inventario: salida que supera lo disponible → misma advertencia", /Disponible según el sistema\s*5/.test(await txt(page, "#s .concile-warn")) && moveCalls(st).length === 0);
    await page.fill("#s .concile-box input[type=number]", "3");
    await page.waitForTimeout(150);
    await page.click("#s .concile-box .btn-primary");
    await page.waitForTimeout(1000);
    const c = moveCalls(st).at(-1)?.[1];
    check("Inventario: registra con la misma función (origen «inventario», declarado 3)", c && c.source === "inventario" && c.declared_physical === 3 && st.variants[0].stock === 3 && (await page.evaluate(() => window.changed)) === 1, JSON.stringify(c));
    check("Inventario: ajuste y salida en la misma operación", st.moves.filter((m) => m.op === c.operation_id).map((m) => m.quantity).join() === "2,-6");
    check("Inventario: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
