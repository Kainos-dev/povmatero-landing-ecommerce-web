// /yerbas: carrito flotante (más chico, pegado abajo en el celular, sin tapar
// nada), título del carrito con la letra de títulos de la góndola y el aviso
// «Ya agregaste todo el stock disponible.» (distinto de «Agotado»).
// Catálogo simulado; imágenes vía guard.cjs. No escribe nada real.
//   node -r ./guard.cjs yerbas-cart-test.cjs .. shots
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5209";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

const row = (o) => ({ description: "", category_slug: "yerbas", category_name: "Yerbas", cover_image: null, track_stock: true, variant_image: null, product_sort: 0, shelf_image: null, variant_shelf_image: null, ...o });
const CATALOG = [
  row({ product_id: 61, product_slug: "canarias-suave", product_name: "Canarias Suave", brand: "Canarias", variant_id: 102, variant_name: "1kg", price: 13900, stock: 1, variant_sort: 0 }),
  row({ product_id: 61, product_slug: "canarias-suave", product_name: "Canarias Suave", brand: "Canarias", variant_id: 777, variant_name: "500gr", price: 7300, stock: 4, variant_sort: 1 }),
  row({ product_id: 3, product_slug: "canarias-tradicional", product_name: "Canarias Tradicional", brand: "Canarias", variant_id: 5, variant_name: "500gr", price: 5600, stock: 0, variant_sort: 0 }),
  row({ product_id: 3, product_slug: "canarias-tradicional", product_name: "Canarias Tradicional", brand: "Canarias", variant_id: 6, variant_name: "1kg", price: 11600, stock: 30, variant_sort: 1 }),
];

(async () => {
  const srv = await serve(ROOT, 5209);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  async function open(vp) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript(() => localStorage.setItem("povmatero-no-track", "1"));
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/rest/v1/**", (route) => {
      const u = new URL(route.request().url());
      const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (u.pathname === "/rest/v1/storefront_catalog") return json(CATALOG);
      if (u.pathname === "/rest/v1/categories") return json([{ slug: "yerbas", sort_order: 5 }]);
      return json([]);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/yerbas");
    await page.waitForSelector(".y-item", { timeout: 20000 });
    await page.waitForTimeout(600);
    return { ctx, page, errors };
  }
  const rect = (page, sel) => page.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: innerHeight - r.bottom, right: r.right }; });
  const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  async function addOne(page, variantId, times = 1) {
    await page.click(`.y-variant[data-variant="${variantId}"]`);
    await page.waitForSelector(".y-presentations");
    for (let i = 0; i < times; i++) await page.click(`.y-pres[data-variant="${variantId}"] [data-step="1"]`);
    await page.click("[data-add]");
    await page.waitForTimeout(1200);
  }

  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
    const tag = `${vp.width}px`;
    const { ctx, page, errors } = await open(vp);
    const dock = await rect(page, "#cartDock");
    check(`${tag}: carrito más chico que antes (170 × 118)`, dock.w < 170 && dock.h < 118, JSON.stringify(dock));
    if (vp.width < 700) check(`${tag}: carrito casi pegado al borde inferior (≤ 4 px)`, dock.bottom >= 0 && dock.bottom <= 4, String(dock.bottom));
    else check(`${tag}: carrito a 10 px del borde`, Math.round(dock.bottom) === 10, String(dock.bottom));
    check(`${tag}: carrito centrado`, Math.abs(dock.x + dock.w / 2 - vp.width / 2) < 2);
    // No tapa otros controles (marcas, flechas, aviso de deslizar) ni la última fila de la góndola.
    const others = await page.$$eval(".y-brands, .y-pager:not([hidden]), .y-hint:not(.is-gone), .y-back, .y-icon-btn", (els) =>
      els.filter((e) => getComputedStyle(e).display !== "none" && getComputedStyle(e).visibility !== "hidden").map((e) => { const r = e.getBoundingClientRect(); return { n: e.className, x: r.x, y: r.y, w: r.width, h: r.height }; }));
    const hit = others.filter((o) => o.w && o.h && overlaps(dock, o));
    check(`${tag}: no se superpone con otros botones`, !hit.length, JSON.stringify(hit));
    const pad = await page.$eval(".y-aisle, .y-track", (e) => parseFloat(getComputedStyle(e).paddingBottom) || 0).catch(() => 0);
    check(`${tag}: la góndola deja lugar abajo para el carrito`, pad === 0 || pad >= dock.h, `${pad} < ${dock.h}`);
    // Última unidad: 1 kg de Canarias Suave (stock 1)
    await addOne(page, 102);
    await page.click("#cartDock");
    await page.waitForSelector("#cartSheetTitle");
    const title = await page.$eval("#cartSheetTitle", (e) => { const s = getComputedStyle(e); return { f: s.fontFamily, t: s.textTransform, w: s.fontWeight, text: e.textContent }; });
    check(`${tag}: título «Tu pedido de yerbas» con Inter en mayúsculas (letra de títulos de la góndola)`, /Inter/.test(title.f) && !/Times/.test(title.f) && title.t === "uppercase" && Number(title.w) >= 600 && title.text === "Tu pedido de yerbas", JSON.stringify(title));
    const h1 = await page.$eval(".y-heading h1", (e) => getComputedStyle(e).fontFamily);
    check(`${tag}: misma familia que «GÓNDOLA DE YERBAS»`, h1 === title.f, `${h1} vs ${title.f}`);
    const line = await page.$eval('.y-line[data-variant="102"]', (e) => e.innerText);
    check(`${tag}: última unidad agregada → «Ya agregaste todo el stock disponible.»`, /Ya agregaste todo el stock disponible\./.test(line), line);
    check(`${tag}: ya no dice «No hay más disponibles»`, !/No hay más disponibles/.test(await page.evaluate(() => document.body.innerText)));
    check(`${tag}: el botón + queda deshabilitado`, await page.$eval('.y-line[data-variant="102"] [data-step="1"]', (b) => b.disabled));
    check(`${tag}: ningún texto habla de 24 horas de reserva`, !/24 horas/.test(await page.$eval("#cartSheet", (e) => e.innerText)));
    await page.screenshot({ path: path.join(OUT, `yerbas-cart-${vp.width}.png`) });
    await page.click("#cartSheet [data-close]");
    await page.waitForTimeout(400);
    // 2 de 4 (500 g): sin aviso
    await addOne(page, 777, 2);
    await page.click("#cartDock");
    await page.waitForSelector('.y-line[data-variant="777"]');
    check(`${tag}: con stock de sobra (2 de 4) no muestra el aviso`, !/Ya agregaste/.test(await page.$eval('.y-line[data-variant="777"]', (e) => e.innerText)));
    // Sube a 4 desde el carrito: aparece
    await page.click('.y-line[data-variant="777"] [data-step="1"]');
    await page.click('.y-line[data-variant="777"] [data-step="1"]');
    await page.waitForTimeout(200);
    check(`${tag}: al llegar a 4 de 4 desde el carrito, aparece el aviso`, /Ya agregaste todo el stock disponible\./.test(await page.$eval('.y-line[data-variant="777"]', (e) => e.innerText)));
    await page.click("#cartSheet [data-close]");
    await page.waitForTimeout(400);
    // Ficha de la yerba: la presentación completa avisa; la agotada dice «Agotado» (no el aviso)
    await page.click('.y-variant[data-variant="102"]');
    await page.waitForSelector(".y-presentations");
    const p102 = await page.$eval('.y-pres[data-variant="102"]', (e) => e.innerText);
    check(`${tag}: ficha: «1 en tu carrito» + «Ya agregaste todo el stock disponible.»`, /1 en tu carrito/.test(p102) && /Ya agregaste todo el stock disponible\./.test(p102), p102);
    await page.click("#productSheet [data-close]");
    await page.waitForTimeout(400);
    await page.click('.y-variant[data-variant="5"]');
    await page.waitForSelector(".y-presentations");
    const p5 = await page.$eval('.y-pres[data-variant="5"]', (e) => e.innerText);
    check(`${tag}: agotada de antes: «Agotado», sin el aviso de stock agregado`, /Agotado/.test(p5) && !/Ya agregaste/.test(p5), p5);
    check(`${tag}: sin desplazamiento horizontal ni errores`, (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) && !errors.length, errors.join(" | "));
    await page.click("#productSheet [data-close]");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `yerbas-dock-${vp.width}.png`) });
    await ctx.close();
  }
  // Tope por presentación (20) con stock de sobra: aviso distinto
  { const { ctx, page } = await open({ width: 390, height: 844 });
    await addOne(page, 6, 20);
    await page.click("#cartDock");
    await page.waitForSelector('.y-line[data-variant="6"]');
    const t = await page.$eval('.y-line[data-variant="6"]', (e) => e.innerText);
    check("tope de 20 con stock 30: «Máximo 20 por presentación…», no «todo el stock»", /Máximo 20 por presentación/.test(t) && !/Ya agregaste/.test(t), t);
    await ctx.close(); }

  const src = fs.readFileSync(path.join(ROOT, "js/yerbas/main.js"), "utf8");
  check("reserva: el carrito y la confirmación dicen 12 horas (como la cancelación automática)", /const RESERVATION_HOURS = 12;/.test(src) && (src.match(/Reservamos tus paquetes por \$\{RESERVATION_HOURS\} horas/g) ?? []).length === 2 && !/por (24|72) horas/.test(src));
  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
