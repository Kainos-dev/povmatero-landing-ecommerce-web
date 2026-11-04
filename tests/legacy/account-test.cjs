// Bloques 1 y 2: menú de cuenta igual en toda la web y «Mi cuenta» en escritorio.
// Supabase simulado (sesión, perfil, pedidos, admin_users): no escribe nada.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5195";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const session = (id, email, meta = {}) => ({ access_token: `${b64({ alg: "HS256" })}.${b64({ sub: id, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: meta } });
const USERS = {
  cliente: { s: session("22222222-2222-4222-8222-222222222222", "agus@test.com", { first_name: "agustin", last_name: "acevedo" }), profile: { first_name: "agustin", last_name: "acevedo", phone: null, email: "agus@test.com", marketing_opt_in: false }, admin: false, expect: "Agustin Acevedo" },
  admin: { s: session("33333333-3333-4333-8333-333333333333", "admin@test.com"), profile: { first_name: "maría josé", last_name: "de la fuente-PAZ", phone: null, email: "admin@test.com", marketing_opt_in: true }, admin: true, expect: "María José De La Fuente-PAZ" },
  sinNombre: { s: session("44444444-4444-4444-8444-444444444444", "x@test.com"), profile: null, admin: false, expect: "TU CUENTA" },
};

(async () => {
  const srv = await serve(ROOT, 5195);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  let slug = null;

  async function open(path, who, vp = { width: 1440, height: 900 }) {
    const u = who ? USERS[who] : null;
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    if (u) await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__init", "1"); } }, u.s);
    const writes = [];
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (p === "/auth/v1/logout") { writes.push("logout"); return route.fulfill({ status: 204 }); }
      if (p === "/auth/v1/user") return json(u?.s.user ?? {});
      if (p === "/rest/v1/customer_profiles") return u?.profile ? json(u.profile) : route.fulfill({ status: 406, contentType: "application/json", body: '{"code":"PGRST116"}' });
      if (p === "/rest/v1/admin_users") return u?.admin ? json({ role: "admin" }) : route.fulfill({ status: 406, contentType: "application/json", body: '{"code":"PGRST116"}' });
      if (p === "/rest/v1/orders") return json([]);
      if (req.method() !== "GET") { writes.push(req.method() + " " + p); return json([]); }
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + path);
    await page.waitForTimeout(2500);
    await page.evaluate(() => document.getElementById("preloader")?.remove());
    return { ctx, page, errors, writes };
  }

  // Un producto para probar la ficha
  { const { ctx, page } = await open("/");
    slug = await page.evaluate(() => document.querySelector('a[href^="/producto/"]')?.getAttribute("href"));
    await ctx.close(); }

  const pages = [["inicio", "/"], ["ficha", slug], ["mi cuenta", "/cuenta"], ["yerbas", "/yerbas"]];
  for (const [label, path] of pages) {
    for (const who of ["cliente", "admin", "sinNombre"]) {
      const { ctx, page, errors, writes } = await open(path, who);
      const before = await page.evaluate(() => location.pathname + location.search);
      await page.click("#accountBtn");
      await page.waitForTimeout(600);
      await page.waitForFunction((t) => document.getElementById("accountMenuTitle")?.textContent === t, USERS[who].expect, { timeout: 8000 }).catch(() => {});
      const st = await page.evaluate(() => {
        const m = document.getElementById("accountMenu");
        const l = m && getComputedStyle(m.querySelector("[data-menu-logout]"));
        return { menus: document.querySelectorAll("#accountMenu").length, open: m?.classList.contains("open"), login: document.getElementById("accountModal").classList.contains("open"),
          path: location.pathname + location.search, title: m?.querySelector("#accountMenuTitle").textContent, acc: m?.querySelector("[data-menu-account]").className,
          lc: l?.color, lbg: l?.backgroundColor, lb: l?.borderTopColor };
      });
      check(`${label} (${who}): el ícono abre el menú, no navega a /cuenta`, st.menus === 1 && st.open && !st.login && st.path === before, JSON.stringify(st));
      check(`${label} (${who}): arriba dice «${USERS[who].expect}»`, st.title === USERS[who].expect, st.title);
      check(`${label} (${who}): «Mi cuenta» botón original y «Cerrar sesión» ghost rojo`, /account-submit/.test(st.acc) && st.lc === "rgb(255, 90, 78)" && st.lbg === "rgba(0, 0, 0, 0)" && st.lb === "rgba(0, 0, 0, 0)");
      if (who === "cliente") {
        await page.hover("[data-menu-logout]"); await page.waitForTimeout(300);
        const hv = await page.evaluate(() => { const l = getComputedStyle(document.querySelector("[data-menu-logout]")); return [l.backgroundColor, l.borderTopColor]; });
        check(`${label}: hover de «Cerrar sesión» = borde rojo sutil sin fondo`, hv[0] === "rgba(0, 0, 0, 0)" && /^rgba\(255, 90, 78, 0\.4/.test(hv[1]), hv.join(" "));
        if (OUT && label === "inicio") await page.screenshot({ path: `${OUT}/menu-inicio.png` });
        // Mi cuenta → /cuenta
        await page.click("[data-menu-account]");
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => ({ path: location.pathname, open: document.getElementById("accountMenu")?.classList.contains("open"), acc: document.documentElement.classList.contains("route-account") || !!document.querySelector(".acc-page") }));
        check(`${label}: «Mi cuenta» lleva a /cuenta`, after.path === "/cuenta" && !after.open, JSON.stringify(after));
      }
      if (who === "admin") {
        await page.click("[data-menu-logout]");
        await page.waitForFunction(() => !localStorage.getItem("sb-gubrehbalkfvzwsndbcv-auth-token"), null, { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(500);
        const lo = await page.evaluate(() => ({ open: document.getElementById("accountMenu").classList.contains("open"), signed: document.getElementById("accountBtn").classList.contains("is-signed-in") }));
        check(`${label}: «Cerrar sesión» cierra la sesión y el menú`, !lo.open && !lo.signed && writes.includes("logout"), JSON.stringify(lo) + writes);
        await page.click("#accountBtn"); await page.waitForTimeout(800);
        const lg = await page.evaluate(() => ({ login: document.getElementById("accountModal").classList.contains("open"), menu: document.getElementById("accountMenu").classList.contains("open"), text: document.getElementById("accountBody").innerText }));
        check(`${label}: sin sesión abre el ingreso, sin opciones de cuenta`, lg.login && !lg.menu && !/Cerrar sesión/.test(lg.text), JSON.stringify(lg).slice(0, 200));
      }
      check(`${label} (${who}): sin errores ni escrituras`, !errors.length && !writes.some((w) => w !== "logout"), errors.join(" | ") + writes.join(","));
      await ctx.close();
    }
  }

  // Escape y foco
  { const { ctx, page } = await open("/", "cliente");
    await page.click("#accountBtn"); await page.waitForTimeout(500);
    const f = await page.evaluate(() => document.activeElement?.dataset.menuAccount !== undefined);
    await page.keyboard.press("Escape"); await page.waitForTimeout(400);
    const closed = await page.evaluate(() => !document.getElementById("accountMenu").classList.contains("open") && document.activeElement?.id === "accountBtn");
    check("Escape cierra el menú y el foco vuelve al ícono (foco inicial en «Mi cuenta»)", f && closed);
    await ctx.close(); }

  // Celular: el menú también (tienda y yerbas)
  for (const path of ["/", "/yerbas"]) {
    const { ctx, page, errors } = await open(path, "cliente", { width: 390, height: 844 });
    await page.click("#accountBtn"); await page.waitForTimeout(1200);
    const st = await page.evaluate(() => ({ open: document.getElementById("accountMenu").classList.contains("open"), path: location.pathname, title: document.getElementById("accountMenuTitle").textContent }));
    check(`celular ${path}: menú con el nombre, sin navegar`, st.open && st.path === path && st.title === "Agustin Acevedo", JSON.stringify(st));
    check(`celular ${path}: sin errores`, !errors.length, errors.join(" | "));
    await ctx.close();
  }

  // Bloque 2: /cuenta en escritorio
  for (const vp of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    const { ctx, page, errors } = await open("/cuenta", "cliente", vp);
    for (const sec of ["datos", "preferencias", "pedidos"]) {
      await page.click(`.acc-tab[data-section="${sec}"]`); await page.waitForTimeout(600);
      await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(200);
      const r = await page.evaluate(() => ({ footTop: document.querySelector(".site-footer").getBoundingClientRect().top, vh: innerHeight, scrollable: document.documentElement.scrollHeight > innerHeight }));
      check(`${vp.width}×${vp.height} «${sec}»: el footer no aparece en la pantalla inicial (empieza en ${Math.round(r.footTop)} px, pantalla ${r.vh})`, r.footTop >= r.vh - 1);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)); await page.waitForTimeout(200);
      const r2 = await page.evaluate(() => document.querySelector(".site-footer").getBoundingClientRect().top < innerHeight);
      check(`${vp.width}×${vp.height} «${sec}»: al bajar aparece el footer`, r2);
    }
    await page.click('.acc-tab[data-section="datos"]'); await page.waitForTimeout(400);
    await page.evaluate(() => window.scrollTo(0, 0));
    const lo = await page.evaluate(() => {
      const b = document.querySelector("#acc-panel-datos [data-logout]"); if (!b) return null;
      const r = b.getBoundingClientRect(), cs = getComputedStyle(b);
      return { inView: r.bottom <= innerHeight && r.top >= 0, color: cs.color, bg: cs.backgroundColor, border: cs.borderTopColor, others: document.querySelectorAll("#accountPageBody [data-logout]").length };
    });
    check(`${vp.width}×${vp.height}: «Cerrar sesión» en «Mis datos», visible sin bajar`, lo && lo.inView && lo.others === 1, JSON.stringify(lo));
    check(`${vp.width}×${vp.height}: «Cerrar sesión» ghost rojo sin fondo ni borde`, lo && lo.color === "rgb(255, 90, 78)" && lo.bg === "rgba(0, 0, 0, 0)" && lo.border === "rgba(0, 0, 0, 0)", JSON.stringify(lo));
    if (vp.width === 1440) {
      await page.hover("#acc-panel-datos [data-logout]"); await page.waitForTimeout(300);
      const hv = await page.evaluate(() => { const c = getComputedStyle(document.querySelector("#acc-panel-datos [data-logout]")); return [c.backgroundColor, c.borderTopColor]; });
      check("«Mi cuenta»: hover de «Cerrar sesión» = borde rojo sutil sin fondo", hv[0] === "rgba(0, 0, 0, 0)" && /^rgba\(255, 90, 78, 0\.4/.test(hv[1]), hv.join(" "));
      if (OUT) await page.screenshot({ path: `${OUT}/cuenta-datos.png` });
      await page.click("#acc-panel-datos [data-logout]");
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.querySelector(".acc-title")?.textContent);
      check("«Mi cuenta»: cerrar sesión desde «Mis datos» funciona", /Ingresá/.test(t ?? ""), t);
    }
    check(`${vp.width}×${vp.height}: sin errores`, !errors.length, errors.join(" | "));
    await ctx.close();
  }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
