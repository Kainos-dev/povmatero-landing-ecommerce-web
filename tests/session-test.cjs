// Cuentas de clientes: sesión, saludo, pedido de yerbas y menú.
//   * La sesión no se pierde: recarga, navegación, cerrar y abrir el navegador,
//     pedido de yerbas, dos pestañas renovando a la vez, respuesta perdida.
//   * Sesión vencida o revocada: se muestra cerrada (no aparenta seguir) y el
//     carrito queda guardado en la cuenta.
//   * Saludo «¡Hola de nuevo, NOMBRE!» solo al ingresar (no al recargar ni
//     navegar); bienvenida distinta al registrarse; sin «null»/«undefined».
//   * Pantalla de pedido realizado: «Avisar por WhatsApp» en segundo lugar, con
//     el pedido confirmado; título con la letra Inter en mayúsculas.
//   * Menú hamburguesa: «GÓNDOLA DE YERBAS» y divisores finos.
// Supabase Auth simulado con las reglas reales: access token de 1 h, refresh
// token de un solo uso que rota, 10 s de gracia para reusarlo y, pasado ese
// tiempo, reuso = sesión revocada. Navegador con perfil persistente (cerrar y
// volver a abrir conserva lo guardado). Nada sale a Supabase real (guard.cjs).
//   node -r ./guard.cjs session-test.cjs .. shots
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path"), os = require("os");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5212";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
const KEY = "sb-gubrehbalkfvzwsndbcv-auth-token";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "ana@test.com", aud: "authenticated", role: "authenticated", app_metadata: { provider: "email" }, user_metadata: { first_name: "Ana" }, created_at: "2026-10-01T00:00:00Z" };

// ---------- Supabase Auth simulado ----------
function authServer() {
  const s = { tokens: new Map(), log: [], n: 0, dropNextRefreshResponse: false, profileName: "Ana", signupConfirm: false };
  s.issue = (user = USER) => {
    const refresh = `rt-${++s.n}`;
    const iat = Math.floor(Date.now() / 1000);
    const access = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: user.id, role: "authenticated", aud: "authenticated", email: user.email, iat, exp: iat + 3600, session_id: "s1" })}.sig`;
    s.tokens.set(refresh, { usedAt: null, child: null, revoked: false, user });
    return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: iat + 3600, refresh_token: refresh, user };
  };
  s.revokeAll = () => { for (const x of s.tokens.values()) x.revoked = true; };
  s.count = (kind) => s.log.filter((l) => l[0] === kind).length;
  return s;
}

async function installRoutes(ctx, auth, { catalog }) {
  await ctx.addInitScript(() => {
    localStorage.setItem("povmatero-no-track", "1");
    // Registro de todos los avisos (toast) que aparecen en la página.
    window.__toasts = [];
    const watch = () => {
      const t = document.getElementById("toast");
      if (!t) return setTimeout(watch, 50);
      new MutationObserver(() => { const x = t.textContent.trim(); if (x && window.__toasts.at(-1) !== x) window.__toasts.push(x); }).observe(t, { childList: true, characterData: true, subtree: true });
    };
    document.addEventListener("DOMContentLoaded", watch);
  });
  await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
  await ctx.route("https://wa.me/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>WhatsApp</title>wa" }));
  await ctx.route(SB + "/**", async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname, m = req.method();
    const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(req.postData() || "{}"); } catch { return {}; } };
    const bearer = (req.headers()["authorization"] ?? "").replace("Bearer ", "");
    const err = (code, message) => json({ code, error_code: code, msg: message, message }, 400);
    if (p === "/auth/v1/token") {
      const grant = u.searchParams.get("grant_type");
      if (grant === "password") {
        const b = body();
        auth.log.push(["password", b.email]);
        if (b.password !== "secreta123") return err("invalid_credentials", "Invalid login credentials");
        return json(auth.issue());
      }
      if (grant === "refresh_token") {
        const rt = body().refresh_token;
        const t = auth.tokens.get(rt);
        auth.log.push(["refresh", rt]);
        if (!t || t.revoked) return err("refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
        if (t.usedAt) {
          if (Date.now() - t.usedAt < 10000 && t.child) return json(t.child);       // gracia de 10 s
          auth.revokeAll();                                                      // reuso: se revoca todo
          return err("refresh_token_already_used", "Invalid Refresh Token: Already Used");
        }
        t.usedAt = Date.now();
        t.child = auth.issue(t.user);
        if (auth.dropNextRefreshResponse) { auth.dropNextRefreshResponse = false; return route.abort("connectionreset"); }
        return json(t.child);
      }
    }
    if (p === "/auth/v1/signup") {
      const b = body();
      auth.log.push(["signup", b.email]);
      const user = { ...USER, id: "33333333-3333-4333-8333-333333333333", email: b.email, user_metadata: b.data ?? {} };
      if (auth.signupConfirm) return json({ ...user, identities: [{ id: "i1" }], confirmation_sent_at: new Date().toISOString() });
      return json(auth.issue(user));
    }
    if (p === "/auth/v1/user") return json(USER);
    if (p === "/auth/v1/logout") { auth.log.push(["logout"]); auth.revokeAll(); return route.fulfill({ status: 204, body: "" }); }
    if (p.startsWith("/auth/")) return json({});
    if (p === "/rest/v1/storefront_catalog") return json(catalog);
    if (p === "/rest/v1/customer_profiles") {
      const row = { first_name: auth.profileName, last_name: "Pérez", phone: "11 4444 1234", email: USER.email, marketing_opt_in: true };
      return json(req.headers().accept?.includes("pgrst.object") ? row : [row]);
    }
    if (p === "/rest/v1/rpc/create_yerba_order") {
      auth.log.push(["order"]);
      const items = body().items;
      return json({ id: 4321, status: "pendiente", total: 13000 * items[0].quantity, item_count: items.length, items: items.map((i) => ({ variant_id: i.variant_id, product_name: "Canarias Serena", variant_name: "1kg", unit_price: 13000, quantity: i.quantity, line_total: 13000 * i.quantity })) });
    }
    return json([]);
  });
}

const row = (o) => ({ description: "", category_slug: "yerbas", category_name: "Yerbas", cover_image: null, track_stock: true, variant_image: null, product_sort: 0, variant_sort: 0, shelf_image: null, variant_shelf_image: null, stock: 5, shelf_other: false, shelf_position: 1, brand_position: 1, ...o });
const CATALOG = [
  row({ product_id: 10, product_slug: "canarias-serena", product_name: "Canarias Serena", brand: "Canarias", variant_id: 102, variant_name: "1kg", price: 13000 }),
  row({ product_id: 20, product_slug: "mate-imperial", product_name: "Mate Imperial", brand: null, category_slug: "mates", category_name: "Mates", variant_id: 201, variant_name: "Único", price: 30000, brand_position: null }),
];

(async () => {
  const srv = await serve(ROOT, 5212);
  const exe = "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "pov-session-"));
  const auth = authServer();
  let ctx, page, errors;
  async function launch(vp = { width: 390, height: 844 }) {
    ctx = await chromium.launchPersistentContext(profileDir, { executablePath: exe, viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await installRoutes(ctx, auth, { catalog: CATALOG });
    page = ctx.pages()[0] ?? await ctx.newPage();
    errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
  }
  const stored = () => page.evaluate((k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }, KEY);
  const signedInIcon = () => page.$eval("#accountBtn", (b) => b.classList.contains("is-signed-in")).catch(() => null);
  const toasts = () => page.evaluate(() => window.__toasts ?? []);
  const go = async (url, wait = "#accountBtn") => { await page.goto(BASE + url); await page.waitForSelector(wait, { timeout: 30000 }); await page.waitForTimeout(2200); };
  // Envejecer la sesión guardada: como si hubieran pasado horas (access token vencido).
  const age = () => page.evaluate((k) => { const s = JSON.parse(localStorage.getItem(k)); s.expires_at = Math.floor(Date.now() / 1000) - 7200; localStorage.setItem(k, JSON.stringify(s)); }, KEY);
  async function login(email = "ana@test.com", password = "secreta123") {
    await page.click("#accountBtn");
    await page.waitForSelector(".account-form [name=email]");
    await page.fill(".account-form [name=email]", email);
    await page.fill(".account-form [name=password]", password);
    await page.click(".account-form .account-submit");
    await page.waitForTimeout(2500);
  }
  async function addAndOrder() {
    await page.click('.y-variant[data-variant="102"]');
    await page.waitForSelector(".y-presentations");
    await page.click('.y-pres[data-variant="102"] [data-step="1"]');
    await page.click("[data-add]");
    await page.waitForTimeout(1200);
    await page.click("#cartDock");
    await page.waitForSelector("[data-send]");
    await page.click("[data-send]");
    await page.waitForTimeout(2500);
  }
  const yerbasCart = () => page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.startsWith("povmatero-yerbas-v1:")).map((k) => [k, localStorage.getItem(k)])));

  await launch();

  // ---------- 1. Ingreso y saludo ----------
  await go("/");
  await login();
  check("ingreso: la sesión queda guardada", !!(await stored())?.refresh_token);
  check("ingreso: el ícono muestra la sesión", await signedInIcon());
  check("saludo: «¡Hola de nuevo, Ana!»", (await toasts()).includes("¡Hola de nuevo, Ana!"), JSON.stringify(await toasts()));
  await page.screenshot({ path: path.join(OUT, "saludo-390.png") });

  // ---------- 2. Recarga y navegación: sin saludo repetido ----------
  await page.reload(); await page.waitForTimeout(2500);
  check("recarga: sigue con sesión", (await stored())?.refresh_token && await signedInIcon());
  check("recarga: no repite el saludo", !(await toasts()).some((t) => /Hola de nuevo/.test(t)), JSON.stringify(await toasts()));
  await go("/yerbas", ".y-item");
  check("/yerbas: sigue con sesión", await signedInIcon());
  check("/yerbas: no repite el saludo ni avisa nada", (await toasts()).length === 0, JSON.stringify(await toasts()));
  await go("/cuenta");
  check("/cuenta: muestra la cuenta (no pide ingresar)", !/Ingresá para ver tu cuenta/.test(await page.evaluate(() => document.body.innerText)));

  // ---------- 3. Cerrar y volver a abrir el navegador ----------
  await ctx.close();
  await launch();
  await go("/");
  check("navegador cerrado y abierto: sigue con sesión", (await stored())?.refresh_token && await signedInIcon());
  check("navegador cerrado y abierto: sin saludo ni aviso", (await toasts()).length === 0, JSON.stringify(await toasts()));

  // ---------- 4. Horas después (token vencido) + pedido en /yerbas ----------
  await age();
  await ctx.close();
  await launch();
  const r0 = auth.count("refresh");
  await go("/yerbas", ".y-item");
  check("horas después: /yerbas confirma y renueva la sesión al cargar", await signedInIcon() && auth.count("refresh") === r0 + 1, JSON.stringify(auth.log.slice(-3)));
  await addAndOrder();
  check("pedido: confirmado (pantalla de éxito)", !!(await page.$(".y-sent")));
  check("pedido: la sesión sigue guardada después de confirmar", !!(await stored())?.refresh_token);
  check("pedido: un solo pedido creado", auth.count("order") === 1);
  // Pantalla de éxito
  const actions = await page.$$eval(".y-sent-actions > *", (els) => els.map((e) => e.textContent.trim()));
  check("éxito: «Avisar por WhatsApp» en segundo lugar, se mantienen los demás", actions.join("|") === "Ver mis pedidos|Avisar por WhatsApp|Volver a la góndola de yerbas|Volver a la web", actions.join("|"));
  const wa = await page.$eval("[data-whatsapp]", (a) => ({ href: a.href, target: a.target, rel: a.rel, ...(() => { const s = getComputedStyle(a); const p = a.previousElementSibling.getBoundingClientRect(), r = a.getBoundingClientRect(); return { color: s.color, border: s.borderTopColor, bg: s.backgroundColor, h: r.height, w: r.width, ph: p.height, pw: p.width, radius: s.borderRadius }; })() }));
  const msg = decodeURIComponent(new URL(wa.href).searchParams.get("text") ?? "");
  check("WhatsApp: abre wa.me (app o WhatsApp Web) al número de la tienda, en otra pestaña", wa.href.startsWith("https://wa.me/5491160554815?text=") && wa.target === "_blank" && /noopener/.test(wa.rel), wa.href);
  check("WhatsApp: mensaje con número de pedido, nombre, detalle y total", /#4321/.test(msg) && /Soy Ana\./.test(msg) && /Canarias Serena 1kg x1/.test(msg) && /Total: \$\s?13\.000/.test(msg), msg);
  check("WhatsApp: sin datos sensibles (teléfono, email)", !/ana@test\.com|4444|1234/.test(msg), msg);
  check("WhatsApp: fondo transparente, borde y texto verdes", wa.bg === "rgba(0, 0, 0, 0)" && wa.border === "rgb(37, 211, 102)" && /rgb\(17, 131, 59\)/.test(wa.color), JSON.stringify(wa));
  check("WhatsApp: mismo tamaño que los otros botones", Math.abs(wa.h - wa.ph) < 1 && Math.abs(wa.w - wa.pw) < 1, JSON.stringify(wa));
  const title = await page.$eval(".y-sent h2", (h) => { const s = getComputedStyle(h); return { f: s.fontFamily, t: s.textTransform, ls: s.letterSpacing, text: h.textContent }; });
  check("título: «Pedido realizado correctamente» con Inter en mayúsculas espaciadas", /Inter/.test(title.f) && title.t === "uppercase" && parseFloat(title.ls) > 1 && /Pedido realizado correctamente/.test(title.text), JSON.stringify(title));
  await page.screenshot({ path: path.join(OUT, "exito-390.png") });
  const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 10000 }).catch(() => null), page.click("[data-whatsapp]")]);
  await page.waitForTimeout(800);
  check("WhatsApp: tocar el botón abre WhatsApp y NO crea otro pedido", !!popup && /wa\.me/.test(popup.url()) && auth.count("order") === 1, popup?.url());
  await popup?.close();
  check("WhatsApp: la pantalla de éxito sigue visible al volver", !!(await page.$(".y-sent")));
  // «Volver a la web» y «Ver mis pedidos»
  await page.click('.y-sent a[href="/"]'); await page.waitForTimeout(2500);
  check("después del pedido → web: sigue con sesión", await signedInIcon());
  await go("/cuenta?seccion=pedidos");
  check("después del pedido → Mis pedidos: no pide ingresar", !/Ingresá para ver tu cuenta/.test(await page.evaluate(() => document.body.innerText)));
  await ctx.close();
  await launch();
  await go("/yerbas", ".y-item");
  check("después del pedido, navegador cerrado y abierto: sigue con sesión", (await stored())?.refresh_token && await signedInIcon());

  // ---------- 5. Dos pestañas renovando a la vez ----------
  await age();
  const r1 = auth.count("refresh");
  const p2 = await ctx.newPage();
  await Promise.all([page.goto(BASE + "/cuenta"), p2.goto(BASE + "/cuenta")]);
  await page.waitForTimeout(5000);
  check("dos pestañas a la vez: una sola renovación, sin revocar la sesión", auth.count("refresh") - r1 === 1 && !!(await stored())?.refresh_token, JSON.stringify(auth.log.slice(-3)));
  await p2.close();

  // ---------- 6. Respuesta de renovación perdida (app cambiada, corte) ----------
  await age();
  auth.dropNextRefreshResponse = true;
  await go("/");
  await page.waitForTimeout(12000);   // pasa la gracia de 10 s
  await ctx.close();
  await launch();
  await go("/cuenta");
  check("respuesta perdida: supabase-js reintenta enseguida y la sesión sigue", (await stored())?.refresh_token && await signedInIcon() && !/Ingresá para ver tu cuenta/.test(await page.evaluate(() => document.body.innerText)), JSON.stringify(auth.log.slice(-3)));

  // ---------- 7. Sesión revocada: no aparenta seguir ----------
  await go("/yerbas", ".y-item");
  await page.click('.y-variant[data-variant="102"]');
  await page.waitForSelector(".y-presentations");
  await page.click('.y-pres[data-variant="102"] [data-step="1"]');
  await page.click("[data-add]");
  await page.waitForTimeout(1000);
  await page.keyboard.press("Escape").catch(() => {});
  const cartBefore = await yerbasCart();
  auth.revokeAll();
  await age();
  await go("/", ".site-header");
  await page.waitForTimeout(2500);
  check("revocada: al entrar a la tienda se muestra la sesión cerrada", !(await stored()) && !(await signedInIcon()), JSON.stringify({ stored: !!(await stored()), icon: await signedInIcon() }));
  check("revocada: aviso claro («Tu sesión venció…»)", (await toasts()).some((t) => /Tu sesión venció/.test(t)), JSON.stringify(await toasts()));
  check("revocada: el carrito de la cuenta queda guardado", JSON.stringify(await yerbasCart()) === JSON.stringify(cartBefore), JSON.stringify([cartBefore, await yerbasCart()]));
  await login();
  await go("/yerbas", ".y-item");
  const dock = await page.$eval("#cartDock", (e) => e.innerText);
  check("revocada: al volver a ingresar, el carrito de la cuenta vuelve", /1/.test(dock), dock);

  // ---------- 8. Revocada en el momento de enviar el pedido ----------
  // Página recién cargada con la sesión válida; justo antes de enviar, la
  // sesión se revoca y el token vence (pasaron horas con la página abierta).
  await go("/yerbas", ".y-item");
  const orders0 = auth.count("order");
  await page.click("#cartDock");
  await page.waitForSelector("[data-send]");
  auth.revokeAll();
  await age();
  await page.click("[data-send]");
  await page.waitForTimeout(3000);
  const modalText = await page.$eval("#accountModal", (m) => m.classList.contains("open") ? m.innerText : "").catch(() => "");
  check("revocada al enviar: abre el ingreso con «Tu sesión venció… tu carrito quedó guardado»", /Tu sesión venció\. Ingresá de nuevo para enviar el pedido/.test(modalText), modalText.slice(0, 160));
  check("revocada al enviar: no se creó ningún pedido", auth.count("order") === orders0);
  await page.fill(".account-form [name=email]", "ana@test.com");
  await page.fill(".account-form [name=password]", "secreta123");
  await page.click(".account-form .account-submit");
  await page.waitForTimeout(3000);
  check("revocada al enviar: después de ingresar se abre el carrito con lo que tenía", /Canarias Serena/.test(await page.$eval("#cartSheet", (e) => e.innerText).catch(() => "")));

  // ---------- 9. Cerrar sesión voluntariamente ----------
  await page.keyboard.press("Escape").catch(() => {});
  await go("/", ".site-header");
  await page.evaluate(() => { window.__toasts = []; });
  await page.click("#accountBtn");
  await page.waitForSelector("[data-menu-logout]");
  await page.click("[data-menu-logout]");
  await page.waitForTimeout(2000);
  check("cerrar sesión: se cierra y avisa «Cerraste sesión.» (no «venció»)", !(await stored()) && !(await signedInIcon()) && (await toasts()).includes("Cerraste sesión.") && !(await toasts()).some((t) => /venció/.test(t)), JSON.stringify(await toasts()));
  await ctx.close();
  await launch();
  await go("/");
  check("cerrar sesión: sigue cerrada al volver a abrir el navegador", !(await stored()) && !(await signedInIcon()));

  // ---------- 10. Saludo sin nombre / nombre raro ----------
  auth.profileName = "null";
  const saveMeta = USER.user_metadata; USER.user_metadata = {};
  await login();
  check("saludo sin nombre: «¡Hola de nuevo!» (nunca «null»/«undefined»)", (await toasts()).includes("¡Hola de nuevo!") && !(await toasts()).some((t) => /null|undefined/.test(t)), JSON.stringify(await toasts()));
  USER.user_metadata = saveMeta; auth.profileName = "  María   José ";
  await page.click("#accountBtn"); await page.waitForSelector("[data-menu-logout]"); await page.click("[data-menu-logout]"); await page.waitForTimeout(1500);
  await login();
  check("saludo: usa el nombre de pila sin espacios de más («María»)", (await toasts()).includes("¡Hola de nuevo, María!"), JSON.stringify(await toasts()));
  auth.profileName = "Ana";
  await page.click("#accountBtn"); await page.waitForSelector("[data-menu-logout]"); await page.click("[data-menu-logout]"); await page.waitForTimeout(1500);

  // ---------- 11. Registro: bienvenida distinta ----------
  await page.evaluate(() => { window.__toasts = []; });
  await page.click("#accountBtn");
  await page.waitForSelector('[data-tab="signup"]');
  await page.click('[data-tab="signup"]');
  await page.fill(".account-form [name=firstName]", "Lucía");
  await page.fill(".account-form [name=lastName]", "Gómez");
  await page.fill(".account-form [name=email]", "lucia@test.com");
  await page.fill(".account-form [name=password]", "secreta123");
  await page.fill(".account-form [name=password2]", "secreta123");
  await page.click(".account-form .account-submit");
  await page.waitForTimeout(2500);
  check("registro: «¡Te damos la bienvenida, Lucía!…» (no «Hola de nuevo»)", (await toasts()).some((t) => /^¡Te damos la bienvenida, Lucía! Tu cuenta ya está creada\.$/.test(t)) && !(await toasts()).some((t) => /Hola de nuevo/.test(t)), JSON.stringify(await toasts()));
  check("registro: queda con sesión", await signedInIcon());
  await page.click("#accountBtn"); await page.waitForSelector("[data-menu-logout]"); await page.click("[data-menu-logout]"); await page.waitForTimeout(1500);
  auth.signupConfirm = true;
  await page.evaluate(() => { window.__toasts = []; });
  await page.click("#accountBtn");
  await page.waitForSelector('[data-tab="signup"]');
  await page.click('[data-tab="signup"]');
  await page.fill(".account-form [name=firstName]", "Pedro");
  await page.fill(".account-form [name=lastName]", "Sosa");
  await page.fill(".account-form [name=email]", "pedro@test.com");
  await page.fill(".account-form [name=password]", "secreta123");
  await page.fill(".account-form [name=password2]", "secreta123");
  await page.click(".account-form .account-submit");
  await page.waitForTimeout(2500);
  check("registro con confirmación por email: pide revisar el email, sin saludo", /Te enviamos un email/.test(await page.$eval("#accountModal", (m) => m.innerText)) && (await toasts()).length === 0);
  await page.keyboard.press("Escape");

  // ---------- 12. Menú hamburguesa (360, 390, tablet) ----------
  for (const [tag, vp] of [["360", { width: 360, height: 740 }], ["390", { width: 390, height: 844 }], ["tablet", { width: 768, height: 1024 }]]) {
    await ctx.close();
    await launch(vp);
    await go("/", ".site-header");
    const btn = await page.$("#menuBtn");
    if (!btn || !(await btn.isVisible())) { check(`menú ${tag}: (sin botón de menú en este ancho)`, true); continue; }
    await btn.click();
    await page.waitForTimeout(500);
    const links = await page.$$eval(".mobile-menu-panel a", (as) => as.map((a) => { const r = a.getBoundingClientRect(), s = getComputedStyle(a); return { text: a.innerText.trim(), href: a.getAttribute("href"), h: r.height, border: s.borderBottomWidth + " " + s.borderBottomStyle, w: r.width }; }));
    check(`menú ${tag}: «GÓNDOLA DE YERBAS» con el mismo destino (/yerbas)`, links.some((l) => l.text === "GÓNDOLA DE YERBAS" && l.href === "/yerbas"), JSON.stringify(links.map((l) => l.text)));
    check(`menú ${tag}: mismos enlaces y destinos`, links.map((l) => l.href).join() === "/#productos,/yerbas,#,#", links.map((l) => l.href).join());
    check(`menú ${tag}: líneas finas entre opciones (no después de la última)`, links.slice(0, -1).every((l) => l.border === "1px solid") && links.at(-1).border.startsWith("0px"), JSON.stringify(links.map((l) => l.border)));
    check(`menú ${tag}: áreas táctiles de 48 px o más`, links.every((l) => l.h >= 48), JSON.stringify(links.map((l) => l.h)));
    check(`menú ${tag}: sin desplazamiento horizontal`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(OUT, `menu-${tag}.png`) });
    await page.click("#mobileMenuClose");
  }

  // ---------- 13. Pantalla de éxito en 360, tablet y escritorio ----------
  for (const [tag, vp] of [["360", { width: 360, height: 740 }], ["tablet", { width: 820, height: 1180 }], ["escritorio", { width: 1440, height: 900 }]]) {
    await ctx.close();
    await launch(vp);
    await go("/yerbas", ".y-item");
    if (!(await signedInIcon())) { await login(); await page.waitForTimeout(500); }
    await addAndOrder();
    const sz = await page.$$eval(".y-sent-actions > *", (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
    check(`éxito ${tag}: los 4 botones con el mismo ancho y alto`, sz.length === 4 && sz.every((s) => s[0] === sz[0][0] && s[1] === sz[0][1]), JSON.stringify(sz));
    check(`éxito ${tag}: sin desplazamiento horizontal`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(OUT, `exito-${tag}.png`) });
  }

  check("sin errores de JavaScript", !errors.length, errors.join(" | "));
  await ctx.close();
  srv.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
  console.log(`\n${ok} OK, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
