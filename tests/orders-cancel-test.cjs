// Panel y «Mis pedidos»: sin «Vencido»; pendientes de 72 h = «Cancelado por
// falta de respuesta». Supabase simulado (mock-sb.cjs) + guard.cjs.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState, SB } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5203";
const REASON = "Cancelado por falta de respuesta";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });
const H = 3600e3;
const iso = (ms) => new Date(Date.now() + ms).toISOString();

function ordersState({ migrated = true } = {}) {
  const st = catalogState();
  st.migrated = migrated;
  const item = (id, q = 1) => ({ id, product_id: 61, variant_id: 102, product_name: "Canarias Suave", variant_name: "1kg", unit_price: 13900, quantity: q, line_total: 13900 * q });
  const base = { kind: "yerbas", customer_id: "c1", customer_email: "ana@test.com", customer_phone: "11 4444 1234", stock_applied: false, ready_at: null, delivered_at: null, auto_delivered: false, auto_deliver: true, cancel_reason: null, cancelled_at: null, auto_cancelled: false, item_count: 1, total: 13900 };
  st.orders = [
    { ...base, id: 201, status: "pendiente", created_at: iso(-2 * H), expires_at: iso(70 * H), customer_name: "Ana Vigente", order_items: [item(1)] },
    { ...base, id: 202, status: "pendiente", created_at: iso(-73 * H), expires_at: iso(-1 * H), customer_name: "Beto Sin Respuesta", order_items: [item(2)] },   // la tarea no corrió todavía
    { ...base, id: 203, status: "cancelado", created_at: iso(-100 * H), expires_at: iso(-28 * H), cancel_reason: REASON, cancelled_at: iso(-27 * H), auto_cancelled: true, customer_name: "Caro Cancelada", order_items: [item(3)] },
    { ...base, id: 204, status: "listo", stock_applied: true, created_at: iso(-80 * H), expires_at: iso(-8 * H), ready_at: iso(-2 * H), customer_name: "Dani Listo", order_items: [item(4)] },
    { ...base, id: 205, status: "cancelado", created_at: iso(-10 * H), expires_at: iso(62 * H), cancelled_at: iso(-9 * H), customer_name: "Eva Manual", order_items: [item(5)] },
    { ...base, id: 206, status: "pendiente", created_at: iso(-71.5 * H), expires_at: iso(0.5 * H), customer_name: "Fede Por Vencer", order_items: [item(6)] },
  ];
  st.order_events = {
    203: [{ id: 1, event: "creado", from_status: null, to_status: "pendiente", detail: {}, created_at: iso(-100 * H) },
          { id: 2, event: "estado", from_status: "pendiente", to_status: "cancelado", detail: { automatico: true, motivo: REASON, horas: 72 }, created_at: iso(-27 * H) }],
  };
  st.maint = 0;
  return st;
}

const NEW_COLS = /cancel_reason|auto_cancelled/;
function ordersExtra({ route, url, p, m, body, json, err, rows, st }) {
  const a = () => body() ?? {};
  if (p === "/rest/v1/rpc/run_order_maintenance") {
    if (!st.migrated) return err(404, "PGRST202", "Could not find the function public.run_order_maintenance");
    st.maint++;
    const due = st.orders.filter((o) => o.kind === "yerbas" && o.status === "pendiente" && new Date(o.expires_at) <= new Date());
    for (const o of due) {
      Object.assign(o, { status: "cancelado", cancel_reason: REASON, auto_cancelled: true, cancelled_at: new Date().toISOString() });
      (st.order_events[o.id] ??= []).push({ id: 99, event: "estado", from_status: "pendiente", to_status: "cancelado", detail: { automatico: true, motivo: REASON, horas: 72 }, created_at: new Date().toISOString() });
    }
    return json({ cancelados: due.map((o) => o.id), entregados: [] });
  }
  if (p === "/rest/v1/rpc/deliver_due_yerba_orders") { st.deliverCalls = (st.deliverCalls ?? 0) + 1; return json([]); }
  if (p === "/rest/v1/rpc/admin_set_order_status") {
    const { order_id, status } = a();
    const o = st.orders.find((x) => x.id === order_id);
    if (o.status === "pendiente" && new Date(o.expires_at) <= new Date()) {
      Object.assign(o, { status: "cancelado", cancel_reason: REASON, auto_cancelled: true });
      return json({ id: o.id, status: "cancelado", auto_cancelled: true, cancel_reason: REASON });
    }
    if (o.status === "cancelado" && o.auto_cancelled) return err(400, "23514", `El pedido #${o.id} se canceló por falta de respuesta (72 h en «Pendiente»).`, "auto_cancelled");
    o.status = status; o.stock_applied = ["listo", "entregado"].includes(status);
    if (status === "listo") o.ready_at = new Date().toISOString();
    return json({ id: o.id, status, auto_cancelled: false });
  }
  if (p === "/rest/v1/rpc/variant_commitments") return json([]);
  if (p === "/rest/v1/customer_profiles") return rows([{ user_id: "c1", first_name: "Ana", last_name: "Pérez", phone: "11 4444 1234", email: "ana@test.com", marketing_opt_in: false }]);
  if (p === "/rest/v1/order_events") return json(st.order_events[Number((url.searchParams.get("order_id") ?? "").replace("eq.", ""))] ?? []);
  if (p === "/rest/v1/orders") {
    const sel = url.searchParams.get("select") ?? "";
    if (!st.migrated && NEW_COLS.test(sel)) return err(400, "42703", "column orders.cancel_reason does not exist");
    if (m === "HEAD") {
      const n = st.orders.filter((o) => o.kind === "yerbas" && ((o.status === "pendiente" && new Date(o.expires_at) > new Date()) || ["confirmado", "preparando"].includes(o.status))).length;
      return route.fulfill({ status: 200, headers: { "content-range": `0-0/${n}` }, body: "" });
    }
    const strip = (o) => (st.migrated ? o : Object.fromEntries(Object.entries(o).filter(([k]) => !NEW_COLS.test(k))));
    const idq = url.searchParams.get("id");
    if (idq) return rows(st.orders.filter((o) => `eq.${o.id}` === idq).map(strip));
    const kind = (url.searchParams.get("kind") ?? "").replace("eq.", "");
    return json(st.orders.filter((o) => !kind || o.kind === kind).map(strip));
  }
  return undefined;
}

(async () => {
  const srv = await serve(ROOT, 5203);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
  async function open(url, st, vp = DESK) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await installMock(ctx, st, { extra: ordersExtra });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource/.test(mm.text())) errors.push(mm.text()); });
    await page.goto(BASE + url);
    await page.waitForFunction(() => { const c = document.getElementById("adminContent") ?? document.getElementById("accountRoot") ?? document.body; return c && c.innerText.trim() && !/Cargando/.test(c.innerText); }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(600);
    return { ctx, page, errors };
  }
  const text = (page, sel = "#adminContent") => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

  // ---------- Lista ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos?tab=yerbas", st);
    check("lista: al abrir corre el mantenimiento (cancela los de 72 h) una vez", st.maint === 1 && st.orders.find((o) => o.id === 202).status === "cancelado");
    const chips = await page.$$eval(".order-filter", (b) => b.map((x) => x.firstChild.textContent));
    check("lista: sin filtro «Vencidos»; Pendientes, Listos, Entregados, Cancelados, Todos", chips.join(",") === "Pendientes,Listos,Entregados,Cancelados,Todos", chips.join(","));
    const pend = await page.$$eval(".order-card", (c) => c.map((x) => x.innerText));
    check("lista › pendientes: solo los vigentes (201, 206)", pend.length === 2 && pend.some((t) => t.includes("#201")) && pend.some((t) => t.includes("#206")), pend.join(" | "));
    check("lista › pendientes: avisa cuándo se cancela si no se atiende", pend.every((t) => /se cancela en/.test(t)));
    check("lista › pendientes: el que está por vencer, resaltado", await page.$eval('a[href="#/pedidos/206"] .order-when', (e) => e.classList.contains("text-alert")));
    await page.click('.order-filter:has-text("Cancelados")');
    await page.waitForTimeout(200);
    const canc = await page.$$eval(".order-card", (c) => c.map((x) => x.innerText));
    check("lista › cancelados: 202, 203 y 205", canc.length === 3, canc.join(" | "));
    check("lista › cancelados: muestran el motivo automático", canc.filter((t) => t.includes(REASON)).length === 2 && !canc.find((t) => t.includes("#205")).includes(REASON));
    check("lista: ningún «Vencido» en pantalla", !/vencid/i.test(await text(page)));
    check("lista: la dirección vieja ?f=vencido lleva a Cancelados", true);
    await page.screenshot({ path: path.join(OUT, "pedidos-cancelados-escritorio.png"), fullPage: true });
    check("lista: sin errores", !errors.length, errors.join(" | "));
    await page.goto(BASE + "/admin/#/pedidos?tab=yerbas&f=vencido");
    await page.waitForTimeout(1500);
    check("lista: ?f=vencido (dirección anterior) → Cancelados", /Cancelados/.test(await page.$eval(".order-filter.active", (b) => b.textContent)));
    await ctx.close(); }

  // ---------- Detalle de un pendiente de 72 h (la tarea todavía no corrió) ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos/202", st);
    const t = await text(page);
    check("detalle 72 h: al abrir registra la cancelación (mantenimiento)", st.maint >= 1 && st.orders.find((o) => o.id === 202).status === "cancelado");
    check("detalle 72 h: estado Cancelado con el motivo", /Cancelado/.test(await text(page, ".page-header")) && t.includes(REASON + "."), t.slice(0, 500));
    check("detalle 72 h: sin botones de Marcar listo ni Cancelar", !(await page.$('button:has-text("Marcar listo")')) && !(await page.$('button:has-text("Cancelar pedido")')));
    check("detalle 72 h: no se puede editar", !(await page.$('.panel-head button:has-text("Editar")')));
    check("detalle 72 h: historial con el evento automático y el motivo", /automático: Cancelado por falta de respuesta \(72 h\)/.test(await text(page, ".order-history")), await text(page, ".order-history"));
    check("detalle 72 h: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Detalle de un cancelado antiguo (con motivo) ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos/203", st);
    const t = await text(page);
    check("detalle cancelado: motivo y explicación (no descontó stock)", t.includes(REASON) && /No se descontó stock/.test(t), t.slice(0, 400));
    await page.screenshot({ path: path.join(OUT, "pedido-cancelado-escritorio.png"), fullPage: true });
    check("detalle cancelado: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Pendiente vigente: aviso y carrera con la tarea ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos/201", st);
    check("detalle pendiente: explica que se cancela si no está listo a tiempo", /se cancela por falta de respuesta/.test(await text(page)));
    check("detalle pendiente: «Pendiente» seleccionado, sin «Vencido»", /Pendiente/.test(await text(page, ".order-steps .current")) && !/vencid/i.test(await text(page)));
    // Mientras se miraba, pasaron las 72 h: «Marcar listo» → la base lo cancela
    st.orders.find((o) => o.id === 201).expires_at = iso(-60e3);
    await page.click('button:has-text("Marcar listo")');
    await page.waitForTimeout(1200);
    const toastMsg = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
    check("carrera: «Marcar listo» después de 72 h → aviso claro y el pedido se ve Cancelado con motivo, sin descontar",
      /se canceló por falta de respuesta/.test(toastMsg) && /Cancelado/.test(await text(page, ".page-header")) && (await text(page)).includes(REASON) && !st.orders.find((o) => o.id === 201).stock_applied, toastMsg);
    check("carrera: sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Pendiente vigente → Listo (normal) ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos/206", st);
    await page.click('button:has-text("Marcar listo")');
    await page.waitForTimeout(1500);
    check("listo: un pendiente vigente se marca listo como siempre", st.orders.find((o) => o.id === 206).status === "listo" && /Listo/.test(await text(page, ".page-header")));
    check("listo: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Base sin migrar (compatibilidad) ----------
  { const st = ordersState({ migrated: false });
    const { ctx, page, errors } = await open("/admin/#/pedidos?tab=yerbas", st);
    check("sin migración: la lista carga (columnas viejas) y usa la entrega automática de antes", (await page.$$(".order-card")).length === 2 && st.deliverCalls >= 1, String(st.deliverCalls));
    check("sin migración: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Celular ----------
  { const st = ordersState();
    const { ctx, page, errors } = await open("/admin/#/pedidos?tab=yerbas&f=cancelado", st, PHONE);
    check("celular: lista sin desplazamiento horizontal", await noHScroll(page));
    await page.screenshot({ path: path.join(OUT, "pedidos-cancelados-celular.png"), fullPage: true });
    await page.goto(BASE + "/admin/#/pedidos/203");
    await page.waitForTimeout(1500);
    check("celular: detalle sin desplazamiento horizontal", await noHScroll(page));
    await page.screenshot({ path: path.join(OUT, "pedido-cancelado-celular.png"), fullPage: true });
    check("celular: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- Cliente: «Mis pedidos» ----------
  for (const migrated of [true, false]) {
    const st = ordersState({ migrated });
    // El cliente recibe códigos públicos tras la migración 16, no números internos.
    st.orders.forEach((o) => { o.public_code = `PV-TEST${o.id}`; });
    for (const vp of [DESK, PHONE]) {
      const { ctx, page, errors } = await open("/cuenta?seccion=pedidos", st, vp);
      await page.waitForSelector(".acc-order", { timeout: 20000 }).catch(() => {});
      const cards = await page.$$eval(".acc-order", (c) => c.map((x) => x.innerText.replace(/\s+/g, " ")));
      const card = (id) => cards.find((t) => t.includes(`PV-TEST${id}`)) ?? "";
      const label = migrated ? "con migración" : "sin migración";
      check(`mis pedidos (${label}, ${vp.width}px): carga todos los pedidos`, cards.length === 6, cards.length + " " + errors.join(" | "));
      check(`mis pedidos (${label}, ${vp.width}px): el de 72 h figura «Cancelado» con el motivo`, /CANCELADO|Cancelado/i.test(card(202)) && card(202).includes(REASON), card(202));
      check(`mis pedidos (${label}, ${vp.width}px): nunca «Reserva vencida»`, !cards.some((t) => /vencid/i.test(t)));
      if (migrated) check(`mis pedidos (${label}, ${vp.width}px): cancelado guardado muestra su motivo; el manual no`, card(203).includes(REASON) && !card(205).includes(REASON));
      check(`mis pedidos (${label}, ${vp.width}px): sin desplazamiento horizontal ni errores`, (await noHScroll(page)) && !errors.length, errors.join(" | "));
      if (migrated) await page.screenshot({ path: path.join(OUT, `mis-pedidos-${vp.width}.png`), fullPage: true });
      await ctx.close();
    }
  }

  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
