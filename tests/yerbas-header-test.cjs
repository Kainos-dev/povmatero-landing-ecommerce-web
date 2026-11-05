// /yerbas: encabezado de cada góndola. La marca alineada con el logo y el
// contador con el ícono de cuenta (celular y escritorio); el contador cuenta
// VARIEDADES (productos distintos por id), no presentaciones, e incluye las
// agotadas; ya no muestra «agotadas». Catálogo simulado; guard.cjs.
//   node -r ./guard.cjs yerbas-header-test.cjs .. shots
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = process.env.BASE_URL || "http://localhost:5210";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

const row = (o) => ({ description: "", category_slug: "yerbas", category_name: "Yerbas", cover_image: null, track_stock: true, variant_image: null, product_sort: 0, shelf_image: null, variant_shelf_image: null, stock: 5, ...o });
// Canarias: Serena (500 g + 1 kg, mismo producto), Tradicional 1 kg, Edición Especial 500 g agotada,
// y otra «Serena» con OTRO id (producto distinto con el mismo nombre: cuenta aparte).
const CATALOG = [
  row({ product_id: 10, product_slug: "canarias-serena", product_name: "Canarias Serena", brand: "Canarias", variant_id: 101, variant_name: "500gr", price: 7000 }),
  row({ product_id: 10, product_slug: "canarias-serena", product_name: "Canarias Serena", brand: "Canarias", variant_id: 102, variant_name: "1kg", price: 13000 }),
  row({ product_id: 11, product_slug: "canarias-tradicional", product_name: "Canarias Tradicional", brand: "Canarias", variant_id: 111, variant_name: "1kg", price: 12000 }),
  row({ product_id: 12, product_slug: "canarias-edicion-especial", product_name: "Canarias Edición Especial", brand: "Canarias", variant_id: 121, variant_name: "500gr", price: 8000, stock: 0 }),
  row({ product_id: 20, product_slug: "rei-verde-tradicional", product_name: "Rei Verde Tradicional", brand: "Rei Verde", variant_id: 201, variant_name: "500gr", price: 5000 }),
  row({ product_id: 20, product_slug: "rei-verde-tradicional", product_name: "Rei Verde Tradicional", brand: "Rei Verde", variant_id: 202, variant_name: "1kg", price: 9500, stock: 0 }),
  row({ product_id: 30, product_slug: "sara-serena", product_name: "Serena", brand: "Sara", variant_id: 301, variant_name: "1kg", price: 9000 }),
  row({ product_id: 31, product_slug: "sara-serena-2", product_name: "Serena", brand: "Sara", variant_id: 311, variant_name: "500gr", price: 5000 }),
  row({ product_id: 40, product_slug: "la-tranquera-con-palo-suave", product_name: "Tranquera Suave", brand: "Establecimiento Las Marías Tranquera", variant_id: 401, variant_name: "1kg", price: 9000 }),
];
const EXPECT = { "Canarias": "3 variedades", "Rei Verde": "1 variedad", "Sara": "2 variedades", "Establecimiento Las Marías Tranquera": "1 variedad" };

(async () => {
  const srv = process.env.BASE_URL ? { close() {} } : await serve(ROOT, 5210);
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
    await page.waitForTimeout(800);
    return { ctx, page, errors };
  }
  // Posiciones del encabezado de la góndola visible.
  const measure = (page) => page.evaluate(() => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom }; };
    const visible = [...document.querySelectorAll(".y-gondola[data-index]")].find((g) => { const b = g.getBoundingClientRect(); return b.left > -5 && b.left < 5; });
    const head = visible.querySelector(".y-gondola-head");
    return { logo: r(document.querySelector(".y-back img")), icon: r(document.querySelector(".y-icon-btn")),
      h2: r(head.querySelector("h2")), p: r(head.querySelector("p")), name: head.querySelector("h2").textContent, count: head.querySelector("p").textContent,
      tab: document.querySelector(".y-tab.active")?.textContent, idx: visible.dataset.index };
  });

  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
    const tag = `${vp.width}px`;
    const { ctx, page, errors } = await open(vp);
    const heads = await page.$$eval(".y-gondola-head", (hs) => hs.map((h) => ({ name: h.querySelector("h2").textContent, count: h.querySelector("p").textContent })));
    for (const h of heads) check(`${tag}: ${h.name} → «${EXPECT[h.name]}»`, h.count === EXPECT[h.name], h.count);
    check(`${tag}: ningún encabezado habla de agotadas`, heads.every((h) => !/agotad/i.test(h.count)));
    const n = heads.length;
    for (let i = 0; i < n; i++) {
      if (i > 0) { await page.click(`.y-tab[data-index="${i}"]`); await page.waitForTimeout(700); }
      const m = await measure(page);
      const where = `${tag} · ${m.name}`;
      check(`${where}: marca alineada con el logo (izquierda)`, Math.abs(m.h2.l - m.logo.l) <= 1.5, `${m.h2.l.toFixed(1)} vs ${m.logo.l.toFixed(1)}`);
      check(`${where}: contador alineado con el ícono de cuenta (derecha)`, Math.abs(m.p.r - m.icon.r) <= 1.5, `${m.p.r.toFixed(1)} vs ${m.icon.r.toFixed(1)}`);
      check(`${where}: marca y contador en la misma línea, sin superponerse`, m.h2.r <= m.p.l && m.p.t < m.h2.b && m.p.b > m.h2.t, JSON.stringify({ h2: m.h2, p: m.p }));
      check(`${where}: pestaña activa = góndola visible`, m.tab === m.name && Number(m.idx) === i, `${m.tab} / ${m.name}`);
    }
    if (vp.width < 700) {
      // Deslizar de vuelta a la primera marca.
      await page.evaluate(() => { const t = document.getElementById("track"); t.scrollTo({ left: 0, behavior: "instant" }); });
      await page.waitForTimeout(600);
      let m = await measure(page);
      check(`${tag}: al deslizar a la primera, encabezado y pestaña de Canarias`, m.name === "Canarias" && m.tab === "Canarias" && m.count === "3 variedades", JSON.stringify(m));
      await page.evaluate(() => { const t = document.getElementById("track"); t.scrollTo({ left: t.clientWidth, behavior: "instant" }); });
      await page.waitForTimeout(600);
      m = await measure(page);
      check(`${tag}: al deslizar a la segunda, encabezado y pestaña de Rei Verde`, m.name === "Rei Verde" && m.tab === "Rei Verde" && m.count === "1 variedad", JSON.stringify(m));
      check(`${tag}: alineación igual después de deslizar`, Math.abs(m.h2.l - m.logo.l) <= 1.5 && Math.abs(m.p.r - m.icon.r) <= 1.5);
    }
    // La góndola sigue igual: paquetes, presentaciones y agotada a la vista.
    check(`${tag}: la góndola muestra los 9 paquetes (presentaciones) y la agotada`, (await page.$$(".y-variant")).length === 9 && (await page.$$(".y-variant.is-out")).length === 2);
    check(`${tag}: sin desplazamiento horizontal de la página ni errores`, (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) && !errors.length, errors.join(" | "));
    await page.click('.y-tab[data-index="0"]'); await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, `yerbas-head-${vp.width}.png`), clip: { x: 0, y: 0, width: vp.width, height: 300 } });
    await ctx.close();
  }
  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
