// Tanda final /yerbas: menú de cuenta (cliente común y admin), favicon, header
// igual al de la tienda, ancho del contenido, estantes de lado a lado,
// tipografía, escala de 500 g sola, carrito más chico y pie oscuro.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5194";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const session = (id, email) => ({ access_token: `${b64({ alg: "HS256" })}.${b64({ sub: id, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id, email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } });
const CUSTOMER = session("22222222-2222-4222-8222-222222222222", "cliente@test.com");
const ADMIN = session("33333333-3333-4333-8333-333333333333", "admin@test.com");
const near = (a, b, t = 2) => Math.abs(a - b) <= t;

(async () => {
  const srv = await serve(ROOT, 5194);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  let rows = null;

  async function open(vp, { sess = null, path = "/yerbas", wait = ".y-variant" } = {}) {
    const mob = vp.width < 700;
    const ctx = await browser.newContext({ viewport: vp, isMobile: mob, hasTouch: mob });
    if (sess) await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__init", "1"); } }, sess);
    const calls = [];
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      if (p.startsWith("/storage/")) return route.continue();
      if (p === "/rest/v1/storefront_catalog" && /category_slug=eq\.yerbas/.test(url.search)) {
        if (!rows) { const res = await route.fetch(); rows = await res.json(); }
        // Prueba de escala: una yerba solo de 500 g y otra solo de 1 kg
        const base = { ...rows[0], stock: 9, product_sort: 0, variant_sort: 0, shelf_image: null, variant_shelf_image: null, variant_image: null, cover_image: null };
        const extra = [
          { ...base, product_id: 900001, product_slug: "solo-500", product_name: "Canarias Solo Medio", variant_id: 990001, variant_name: "500 g", price: 5000 },
          { ...base, product_id: 900002, product_slug: "solo-1kg", product_name: "Canarias Solo Kilo", variant_id: 990002, variant_name: "1 kg", price: 9000 },
        ];
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([...extra, ...rows]) });
      }
      if (req.method() !== "GET" && p.startsWith("/rest/")) { calls.push(p); return route.fulfill({ status: 200, contentType: "application/json", body: "[]" }); }
      if (p === "/auth/v1/logout") { calls.push("logout"); return route.fulfill({ status: 204 }); }
      if (p === "/auth/v1/user") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify((sess ?? CUSTOMER).user) });
      if (p.startsWith("/rest/")) return route.continue();
      return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + path);
    if (wait) await page.waitForSelector(wait, { timeout: 20000 });
    await page.waitForTimeout(1500);
    return { ctx, page, errors, calls };
  }

  for (const [label, vp] of [["celular", { width: 390, height: 844 }], ["escritorio", { width: 1440, height: 900 }], ["tablet", { width: 820, height: 1180 }]]) {
    // --- Header de la tienda como referencia
    const home = await open(vp, { path: "/", wait: ".site-header" });
    const ref = await home.page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const grid = document.querySelector(".header-inner");
      const btns = [...document.querySelectorAll(".header-actions > button")].filter((b) => b.offsetParent);
      return { logo: r(".logo img"), right: btns.at(-1).getBoundingClientRect(), inner: r(".header-inner"), h: grid.getBoundingClientRect().height,
        eyebrowFont: getComputedStyle(document.querySelector(".filters-eyebrow")).fontFamily };
    });
    await home.ctx.close();

    const y = await open(vp);
    const got = await y.page.evaluate(async () => {
      await document.fonts.ready;
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const h1 = getComputedStyle(document.querySelector(".y-heading h1"));
      const eb = getComputedStyle(document.querySelector(".y-eyebrow"));
      const h2 = getComputedStyle(document.querySelector(".y-gondola-head h2"));
      const tab = getComputedStyle(document.querySelector(".y-tab"));
      const shelves = document.querySelector(".y-gondola .y-shelves");
      const sr = shelves.getBoundingClientRect(), scs = getComputedStyle(shelves);
      const shelf = document.querySelector(".y-gondola .y-shelf");
      const shr = shelf.getBoundingClientRect();
      const after = getComputedStyle(shelf, "::after"), before = getComputedStyle(shelf, "::before");
      const g = document.querySelector(".y-gondola");
      const heading = r(".y-heading"), top = r(".y-top-inner");
      return {
        logo: r(".y-back img"), btn: r("#accountBtn"), inner: top, h: top.height,
        rightButtons: [...document.querySelectorAll(".y-top button")].length,
        navCart: !!document.querySelector(".y-top .cart-btn, .y-top #cartBtn"),
        headingCenter: heading.left + heading.width / 2, vw: document.documentElement.clientWidth,
        h1: { ff: h1.fontFamily, text: document.querySelector(".y-heading h1").innerText },
        eb: { ff: eb.fontFamily, text: document.querySelector(".y-eyebrow").innerText },
        h2: { ff: h2.fontFamily, tt: h2.textTransform, text: document.querySelector(".y-gondola-head h2").innerText },
        tabFF: tab.fontFamily,
        shelvesContent: { left: sr.left + parseFloat(scs.paddingLeft), right: sr.right - parseFloat(scs.paddingRight) },
        shelfEdge: { left: shr.left + parseFloat(after.left), right: shr.right - parseFloat(after.right), bleft: shr.left + parseFloat(before.left) },
        gw: g.clientWidth, gsw: g.scrollWidth,
        favicon: document.querySelector('link[rel="icon"]')?.getAttribute("href"),
        interLoaded: [...document.fonts].some((f) => /Inter/.test(f.family) && f.status === "loaded"),
      };
    });
    check(`${label}: favicon de Povmatero (${got.favicon})`, got.favicon === "/images/iconoPestaña.ico");
    check(`${label}: navbar del mismo alto que la tienda (${got.h} vs ${ref.h})`, near(got.h, ref.h, 0.5));
    check(`${label}: logo en el mismo lugar y tamaño (x ${got.logo.left.toFixed(1)} vs ${ref.logo.left.toFixed(1)}, alto ${got.logo.height} vs ${ref.logo.height})`,
      near(got.logo.left, ref.logo.left) && near(got.logo.height, ref.logo.height) && near(got.logo.top - got.inner.top, ref.logo.top - ref.inner.top));
    check(`${label}: ícono de usuario en el borde derecho, mismo tamaño y alto que los íconos de la tienda (${got.btn.right.toFixed(1)} vs ${ref.right.right.toFixed(1)})`,
      near(got.btn.right, ref.right.right) && near(got.btn.width, ref.right.width) && near(got.btn.top - got.inner.top, ref.right.top - ref.inner.top));
    check(`${label}: a la derecha solo el ícono de usuario, sin carrito en el navbar`, got.rightButtons === 1 && !got.navCart);
    check(`${label}: título centrado`, near(got.headingCenter, got.vw / 2, 3), `${got.headingCenter} vs ${got.vw / 2}`);
    check(`${label}: «GÓNDOLA DE YERBAS» en mayúsculas`, got.eb.text === "GÓNDOLA DE" && got.h1.text === "YERBAS", `${got.eb.text} / ${got.h1.text}`);
    check(`${label}: título con la tipografía de los títulos de Povmatero (Inter, cargada)`, got.h1.ff === ref.eyebrowFont && got.eb.ff === ref.eyebrowFont && got.interLoaded, got.h1.ff);
    check(`${label}: nombre de la marca con la misma letra y en mayúsculas (${got.h2.text})`, got.h2.ff === got.h1.ff && got.h2.tt === "uppercase" && got.h2.text === got.h2.text.toUpperCase());
    check(`${label}: filtros de marcas con la misma letra de antes (la del sistema)`, /^system-ui/.test(got.tabFF), got.tabFF);
    const expL = got.vw * 0.05 + (vp.width >= 1024 ? 40 : vp.width >= 640 ? 24 : 0);
    check(`${label}: contenido con el mismo ancho y márgenes que el catálogo (${got.shelvesContent.left.toFixed(1)}–${got.shelvesContent.right.toFixed(1)})`,
      near(got.shelvesContent.left, expL, 5) && near(got.vw - got.shelvesContent.right, expL, 12));
    check(`${label}: estante de lado a lado de la pantalla (${got.shelfEdge.left.toFixed(1)}–${got.shelfEdge.right.toFixed(1)} de ${got.vw})`,
      got.shelfEdge.left <= 0.5 && got.shelfEdge.right >= got.gw - 0.5 && got.shelfEdge.bleft <= 0.5);
    check(`${label}: sin desplazamiento de costado dentro de la góndola`, got.gsw <= got.gw, `${got.gsw} > ${got.gw}`);
    if (label === "escritorio") {
      const home2 = await open(vp, { path: "/", wait: ".product-card" });
      const grid = await home2.page.evaluate(() => { const g = document.querySelector(".catalog-section"); const r = g.getBoundingClientRect(), cs = getComputedStyle(g); return { left: r.left + parseFloat(cs.paddingLeft), right: r.right - parseFloat(cs.paddingRight) }; });
      await home2.ctx.close();
      check(`escritorio: mismo contenedor que la grilla del catálogo (${grid.left}–${grid.right})`, near(got.shelvesContent.left, grid.left, 1) && near(got.shelvesContent.right, grid.right, 10));
    }

    // --- Escala: 500 g sola más chica que 1 kg sola
    const sc = await y.page.evaluate(() => {
      const w = (id) => document.querySelector(`.y-item[data-product="${id}"] .y-variant .y-pack`)?.getBoundingClientRect();
      const a = w(900001), b = w(900002);
      const two = [...document.querySelectorAll(".y-item--n2")][0];
      const back = two.querySelector(".y-variant--back .y-pack").getBoundingClientRect(), front = two.querySelector(".y-variant--front .y-pack").getBoundingClientRect();
      const tagA = document.querySelector('.y-item[data-product="900001"] .y-tag').getBoundingClientRect();
      return { a: { w: a.width, h: a.height }, b: { w: b.width, h: b.height }, ratio2: front.width / back.width, tagCenter: tagA.left + tagA.width / 2, packCenter: a.left + a.width / 2, bottomA: a.bottom, bottomB: b.bottom };
    });
    check(`${label}: 500 g sola a escala de 500 g (${sc.a.w.toFixed(1)} px vs 1 kg sola ${sc.b.w.toFixed(1)} px = ${(sc.a.w / sc.b.w).toFixed(2)})`, near(sc.a.w / sc.b.w, 0.82, 0.01));
    check(`${label}: sin deformar (proporción 2:3 en las dos)`, near(sc.a.h / sc.a.w, 1.5, 0.02) && near(sc.b.h / sc.b.w, 1.5, 0.02));
    check(`${label}: las dos apoyan en el mismo estante`, near(sc.bottomA, sc.bottomB, 1));
    check(`${label}: el precio de la 500 g sola queda centrado bajo su paquete`, near(sc.tagCenter, sc.packCenter, 2));
    check(`${label}: grupos con las dos presentaciones sin cambios (500 g = 0,82 del 1 kg)`, near(sc.ratio2, 0.82, 0.01));

    // --- Carrito y pie oscuro
    const dock = await y.page.evaluate(() => {
      const d = document.getElementById("cartDock"), t = document.getElementById("cartTotal");
      const aisle = document.getElementById("aisle");
      const a = getComputedStyle(aisle, "::after");
      return { h: d.getBoundingClientRect().height, w: d.getBoundingClientRect().width, text: d.innerText.trim(), totalVis: getComputedStyle(t).visibility,
        afterPos: a.position, afterBottom: a.bottom, aisleBottom: aisle.getBoundingClientRect().bottom, vh: innerHeight, dockBottom: d.getBoundingClientRect().bottom };
    });
    check(`${label}: carrito más chico (${dock.w}×${dock.h}; antes 200×138)`, dock.h === 118 && dock.w === 170);
    check(`${label}: sin el texto «Tu carrito»`, !/Tu carrito/.test(dock.text) && dock.totalVis === "hidden", JSON.stringify(dock.text));
    check(`${label}: pie oscuro pegado al borde de abajo del pasillo, que llega al borde de la pantalla`, dock.afterPos === "absolute" && dock.afterBottom === "0px" && near(dock.aisleBottom, dock.vh, 1));
    check(`${label}: el carrito sigue abajo al centro, dentro de la pantalla`, dock.dockBottom <= dock.vh && dock.dockBottom > dock.vh - 20);
    await y.page.evaluate(() => document.querySelector('.y-item[data-product="900001"] .y-variant').scrollIntoView({ block: "center" }));
    await y.page.waitForTimeout(300);
    const box = await y.page.locator('.y-item[data-product="900001"] .y-variant').boundingBox();
    await y.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await y.page.waitForSelector("#productSheet.open");
    await y.page.waitForTimeout(300);
    await y.page.click('#productSheet [data-step="1"]:not([disabled])');
    await y.page.click("#productSheet [data-add]");
    await y.page.waitForTimeout(1600);
    const after = await y.page.evaluate(() => ({ total: document.getElementById("cartTotal").innerText, vis: getComputedStyle(document.getElementById("cartTotal")).visibility, count: document.getElementById("cartCount").innerText, minis: document.querySelectorAll("#cartLoad .y-mini").length, scale: document.querySelector("#cartLoad .y-mini")?.style.getPropertyValue("--scale") }));
    check(`${label}: al agregar aparecen el total y la cantidad (${after.total}, ${after.count})`, after.total === "$5.000" && after.vis === "visible" && after.count === "1" && after.minis === 1);
    check(`${label}: dentro del carrito la 500 g sola también va a escala`, after.scale === "0.82");
    check(`${label}: sin errores de JavaScript`, y.errors.length === 0, y.errors.join(" | "));
    if (OUT) await y.page.screenshot({ path: `${OUT}/batch-${label}.png` });
    await y.ctx.close();

    // --- Menú de cuenta: cliente común y admin (mismo menú)
    for (const [who, sess] of [["cliente", CUSTOMER], ["admin", ADMIN]]) {
      const m = await open(vp, { sess });
      await m.page.click("#accountBtn");
      await m.page.waitForTimeout(400);
      const st = await m.page.evaluate(() => {
        const menu = document.getElementById("accountMenu"), acc = document.getElementById("accountModal");
        const a = getComputedStyle(menu.querySelector("[data-menu-account]")), l = getComputedStyle(menu.querySelector("[data-menu-logout]"));
        return { open: menu.classList.contains("open"), accOpen: acc.classList.contains("open"), path: location.pathname, email: document.getElementById("accountMenuEmail").innerText,
          accCls: menu.querySelector("[data-menu-account]").className, accBg: a.backgroundColor, accColor: a.color,
          lColor: l.color, lBg: l.backgroundColor, lBorder: l.borderTopColor };
      });
      check(`${label} (${who}): con sesión, el ícono abre el menú «Mi cuenta / Cerrar sesión»`, st.open && !st.accOpen && st.path === "/yerbas" && st.email === sess.user.email, JSON.stringify(st));
      check(`${label} (${who}): «Mi cuenta» con el botón original (account-submit)`, /account-submit/.test(st.accCls) && st.accBg === "rgb(255, 255, 255)" && st.accColor === "rgb(0, 0, 0)");
      check(`${label} (${who}): «Cerrar sesión» rojo, sin fondo ni borde visible`, st.lColor === "rgb(255, 90, 78)" && st.lBg === "rgba(0, 0, 0, 0)" && st.lBorder === "rgba(0, 0, 0, 0)", JSON.stringify(st));
      if (vp.width > 700) {
        await m.page.hover("[data-menu-logout]");
        await m.page.waitForTimeout(350);
        const hv = await m.page.evaluate(() => { const l = getComputedStyle(document.querySelector("[data-menu-logout]")); return { bg: l.backgroundColor, border: l.borderTopColor, w: l.borderTopWidth }; });
        check(`${label} (${who}): al pasar el cursor por «Cerrar sesión», borde rojo sutil sin fondo`, hv.bg === "rgba(0, 0, 0, 0)" && /^rgba\(255, 90, 78, 0\.4/.test(hv.border) && hv.w === "1px", JSON.stringify(hv));
        await m.page.hover("[data-menu-account]");
        await m.page.waitForTimeout(350);
        const ha = await m.page.evaluate(() => getComputedStyle(document.querySelector("[data-menu-account]")).backgroundColor);
        check(`${label} (${who}): «Mi cuenta» con el hover original (marrón)`, ha === "rgb(55, 39, 29)", ha);
        if (who === "cliente" && OUT) { await m.page.hover("[data-menu-logout]"); await m.page.waitForTimeout(300); await m.page.screenshot({ path: `${OUT}/menu-${label}.png` }); }
      }
      await m.page.click("[data-menu-logout]");
      await m.page.waitForFunction(() => !localStorage.getItem("sb-gubrehbalkfvzwsndbcv-auth-token"), null, { timeout: 10000 }).catch(() => {});
      await m.page.waitForTimeout(300);
      const out = await m.page.evaluate(() => ({ menu: document.getElementById("accountMenu").classList.contains("open"), stored: !!localStorage.getItem("sb-gubrehbalkfvzwsndbcv-auth-token") }));
      check(`${label} (${who}): «Cerrar sesión» cierra la sesión (el logout de siempre)`, !out.menu && !out.stored && m.calls.includes("logout"));
      await m.page.click("#accountBtn");
      await m.page.waitForTimeout(400);
      const login = await m.page.evaluate(() => ({ acc: document.getElementById("accountModal").classList.contains("open"), menu: document.getElementById("accountMenu").classList.contains("open") }));
      check(`${label} (${who}): sin sesión, el ícono abre el ingreso de siempre`, login.acc && !login.menu);
      check(`${label} (${who}): sin errores ni escrituras en la base`, m.errors.length === 0 && !m.calls.some((c) => c.startsWith("/rest/")), m.errors.join(" | ") + m.calls.join(","));
      await m.ctx.close();
    }

    // --- Invitación a la góndola en el catálogo
    const c = await open(vp, { path: "/", wait: ".product-card" });
    await c.page.evaluate(() => document.getElementById("preloader")?.remove());
    await c.page.evaluate(() => document.querySelector('.filter-chip[data-category="yerbas"]').click());
    await c.page.waitForTimeout(800);
    const pr = await c.page.evaluate(() => {
      const p = document.getElementById("yerbasPromo"), s = getComputedStyle(p), e = getComputedStyle(p.querySelector(".yerbas-promo-eyebrow")), l = getComputedStyle(p.querySelector(".yerbas-promo-link"));
      return { hidden: p.hidden, border: s.borderTopColor, left: s.borderLeftColor, leftW: s.borderLeftWidth, color: s.color, eb: e.color, lbg: l.backgroundColor, lc: l.color };
    });
    const black = "rgb(0, 0, 0)", white = "rgb(255, 255, 255)";
    check(`${label}: catálogo «Yerbas»: la invitación se muestra`, !pr.hidden);
    check(`${label}: ventana, texto y borde izquierdo en negro`, pr.border === black && pr.left === black && pr.leftW === "3px" && pr.color === black && pr.eb === black, JSON.stringify(pr));
    check(`${label}: botón negro con texto blanco`, pr.lbg === black && pr.lc === white, JSON.stringify(pr));
    if (vp.width > 700) {
      await c.page.evaluate(() => document.querySelector(".yerbas-promo-link").scrollIntoView({ block: "center" }));
      await c.page.hover(".yerbas-promo-link");
      await c.page.waitForTimeout(350);
      const h = await c.page.evaluate(() => { const l = getComputedStyle(document.querySelector(".yerbas-promo-link")); return [l.backgroundColor, l.color]; });
      check(`${label}: al pasar el cursor, botón marrón con texto blanco`, h[0] === "rgb(55, 39, 29)" && h[1] === white, h.join(" "));
    }
    await c.ctx.close();
  }

  // Celulares chicos: siguen entrando 2 yerbas por estante y nada se desborda
  for (const w of [320, 360, 375, 390, 414, 640, 1024, 1920]) {
    const s = await open({ width: w, height: 800 });
    const r = await s.page.evaluate(() => ({
      perRow: Math.max(...[...document.querySelectorAll(".y-gondola")[0].querySelectorAll(".y-shelf")].map((r) => r.querySelectorAll(".y-item").length)),
      // las yerbas (no la tabla, que va de lado a lado a propósito) quedan dentro del contenedor
      overflow: [...document.querySelectorAll(".y-gondola[data-index]")].some((g) => {
        const s = g.querySelector(".y-shelves"); const r = s.getBoundingClientRect(), cs = getComputedStyle(s);
        const L = r.left + parseFloat(cs.paddingLeft) - 1, R = r.right - parseFloat(cs.paddingRight) + 1;
        return [...s.querySelectorAll(".y-item")].some((i) => { const b = i.getBoundingClientRect(); return b.width && (b.left < L || b.right > R); });
      }),
      side: [...document.querySelectorAll(".y-gondola")].some((g) => g.scrollWidth > g.clientWidth),
    }));
    check(`${w} px: entran 2 yerbas por estante (${r.perRow})`, r.perRow >= 2);
    check(`${w} px: ningún estante se desborda ni hay scroll de costado`, !r.overflow && !r.side);
    await s.ctx.close();
  }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
