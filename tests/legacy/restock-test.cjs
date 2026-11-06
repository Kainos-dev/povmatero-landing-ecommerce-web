// Bloque 3 en /yerbas: «Avisarme por email cuando haya stock». Supabase simulado.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5198";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const UID = "22222222-2222-4222-8222-222222222222";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: UID, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: UID, email: "a@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: { first_name: "ana" } } };

(async () => {
  const srv = await serve(ROOT, 5198);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  let rows = null, OUTV = null;

  async function open({ signedIn = true, migrated = true, vp = { width: 1440, height: 900 } } = {}) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    if (signedIn) await ctx.addInitScript((s) => { if (!sessionStorage.getItem("__init")) { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); sessionStorage.setItem("__init", "1"); } }, SESSION);
    const st = { active: new Set(), calls: [] };
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/**", async (route) => {
      const req = route.request(), url = new URL(req.url()), p = url.pathname;
      const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
      if (p === "/rest/v1/storefront_catalog") {
        if (!rows) { const r = await route.fetch(); rows = await r.json(); OUTV = rows[0].variant_id; }
        return json(rows.map((r) => ({ ...r, track_stock: true, stock: r.variant_id === OUTV ? 0 : 9 })));
      }
      if (p === "/rest/v1/restock_requests") return migrated ? json([...st.active].map((v) => ({ variant_id: v, email_consent_at: new Date().toISOString() }))) : json({ code: "PGRST205", message: "Could not find the table" }, 404);
      if (p === "/rest/v1/rpc/request_restock_alert") { const a = JSON.parse(req.postData()); st.calls.push(["req", a.variant_id]); if (!migrated) return json({ code: "PGRST202", message: "x" }, 404); st.active.add(a.variant_id); return json({ id: 1, variant_id: a.variant_id, status: "activa" }); }
      if (p === "/rest/v1/rpc/cancel_restock_alert") { const a = JSON.parse(req.postData()); st.calls.push(["cancel", a.variant_id]); st.active.delete(a.variant_id); return json(true); }
      if (p === "/rest/v1/customer_profiles") return json({ phone: "11 5555 1234", first_name: "Ana", last_name: "Paz", email: "a@test.com", marketing_opt_in: false });
      if (p === "/auth/v1/user") return json(SESSION.user);
      if (req.method() !== "GET") return json([]);
      return route.continue();
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    await page.goto(BASE + "/yerbas");
    await page.waitForSelector(".y-variant", { timeout: 20000 });
    await page.waitForTimeout(1500);
    return { ctx, page, errors, st };
  }
  async function openSheetOfOut(page) {
    const v = OUTV;
    await page.evaluate((id) => { const b = document.querySelector(`.y-variant[data-variant="${id}"]`); const g = b.closest(".y-gondola"); document.querySelector(`.y-tab[data-index="${g.dataset.index}"]`).click(); }, v);
    await page.waitForTimeout(900);
    await page.evaluate((id) => document.querySelector(`.y-variant[data-variant="${id}"]`).scrollIntoView({ block: "center" }), v);
    await page.waitForTimeout(300);
    const box = await page.locator(`.y-variant[data-variant="${v}"]`).boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForSelector("#productSheet.open");
    await page.waitForTimeout(400);
  }
  const row = (page) => page.evaluate((id) => document.querySelector(`#productSheet .y-pres[data-variant="${id}"]`)?.innerText ?? "", OUTV);

  for (const [label, vp] of [["escritorio", { width: 1440, height: 900 }], ["celular", { width: 390, height: 844 }]]) {
    const { ctx, page, errors, st } = await open({ vp });
    await openSheetOfOut(page);
    check(`${label}: presentación agotada ofrece «Avisarme por email cuando haya stock»`, /Avisarme por email cuando haya stock/.test(await row(page)), await row(page));
    const others = await page.evaluate((id) => [...document.querySelectorAll("#productSheet .y-pres")].filter((r) => r.dataset.variant !== String(id)).some((r) => /Avisarme/.test(r.innerText)), OUTV);
    check(`${label}: solo en la presentación agotada (no en la otra)`, !others);
    await page.click("#productSheet [data-notify]");
    check(`${label}: sin consentimiento no registra nada`, st.calls.length === 0);
    await page.check("#productSheet [data-notify-consent]");
    await page.click("#productSheet [data-notify]");
    await page.waitForTimeout(1200);
    check(`${label}: registrado para esa presentación, con confirmación`, st.calls.length === 1 && st.calls[0][0] === "req" && st.calls[0][1] === OUTV && /Te vamos a avisar cuando haya stock./.test(await row(page)) && /te vamos a avisar cuando haya stock/i.test(await page.evaluate(() => document.getElementById("toast")?.textContent ?? "")));
    if (OUT && label === "celular") await page.screenshot({ path: `${OUT}/aviso-${label}.png` });
    await page.click("#productSheet [data-notify-cancel]");
    await page.waitForTimeout(1000);
    check(`${label}: se puede cancelar`, st.calls.at(-1)[0] === "cancel" && /Avisarme por email cuando haya stock/.test(await row(page)));
    // recarga: el aviso activo se recuerda
    await page.check("#productSheet [data-notify-consent]");
    await page.click("#productSheet [data-notify]"); await page.waitForTimeout(800);
    await page.reload(); await page.waitForSelector(".y-variant"); await page.waitForTimeout(1500);
    await openSheetOfOut(page);
    check(`${label}: al volver, muestra el aviso activo`, /Te vamos a avisar cuando haya stock./.test(await row(page)));
    check(`${label}: sin errores`, !errors.length, errors.join(" | "));
    await ctx.close();
  }
  { const { ctx, page, st } = await open({ signedIn: false });
    await openSheetOfOut(page);
    await page.check("#productSheet [data-notify-consent]");
    await page.click("#productSheet [data-notify]");
    await page.waitForTimeout(800);
    check("sin sesión: pide ingresar (no registra nada)", await page.evaluate(() => document.getElementById("accountModal").classList.contains("open")) && st.calls.length === 0);
    await ctx.close(); }
  { const { ctx, page, errors } = await open({ migrated: false });
    await openSheetOfOut(page);
    check("base sin migrar: la opción no aparece y nada se rompe", !/Avisarme/.test(await row(page)) && !errors.length, errors.join(" | "));
    await ctx.close(); }

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  await browser.close(); srv.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
