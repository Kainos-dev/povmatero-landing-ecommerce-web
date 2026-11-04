// Tienda: una presentación nueva (Canarias Suave 500 g, otra variante del mismo
// producto) aparece junto a la de 1 kg en /yerbas (góndola y carrito) y en la
// ficha del catálogo tradicional. Catálogo simulado; imágenes vía guard.cjs.
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5204";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

const row = (o) => ({ description: "", category_slug: "yerbas", category_name: "Yerbas", cover_image: null, track_stock: true, variant_image: null, product_sort: 0, shelf_image: null, variant_shelf_image: null, ...o });
const CATALOG = [
  row({ product_id: 61, product_slug: "canarias-suave", product_name: "Canarias Suave", brand: "Canarias", variant_id: 102, variant_name: "1kg", price: 13900, stock: 1, variant_sort: 0 }),
  row({ product_id: 61, product_slug: "canarias-suave", product_name: "Canarias Suave", brand: "Canarias", variant_id: 777, variant_name: "500gr", price: 7300, stock: 4, variant_sort: 1, variant_shelf_image: `${SB}/storage/v1/object/public/product-images/products/61/shelf-v777-1.png` }),
  row({ product_id: 3, product_slug: "canarias-tradicional", product_name: "Canarias Tradicional", brand: "Canarias", variant_id: 5, variant_name: "500gr", price: 5600, stock: 1, variant_sort: 0 }),
  row({ product_id: 2, product_slug: "mate-imperial", product_name: "Mate Imperial", brand: null, category_slug: "mates", category_name: "Mates", variant_id: 21, variant_name: "Único", price: 30000, stock: 3, variant_sort: 0 }),
];

(async () => {
  const srv = await serve(ROOT, 5204);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  async function open(url, vp) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/rest/v1/**", (route) => {
      const u = new URL(route.request().url());
      const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (u.pathname === "/rest/v1/storefront_catalog") {
        const cat = (u.searchParams.get("category_slug") ?? "").replace("eq.", "");
        return json(CATALOG.filter((r) => !cat || r.category_slug === cat));
      }
      if (u.pathname === "/rest/v1/categories") return json([{ slug: "mates", sort_order: 1 }, { slug: "yerbas", sort_order: 5 }]);
      return json([]);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + url);
    await page.waitForTimeout(3500);
    await page.evaluate(() => document.getElementById("preloader")?.remove());
    return { ctx, page, errors };
  }

  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { ctx, page, errors } = await open("/yerbas", vp);
    const t = await page.evaluate(() => document.body.textContent.replace(/\s+/g, " "));
    check(`/yerbas (${vp.width}px): Canarias Suave muestra 500 g ($7.300) y 1 kg`, /Suave/.test(t) && /500\s*g/.test(t) && /7\.300/.test(t) && /1\s*kg/.test(t), t.slice(0, 300));
    const groupVariants = await page.evaluate(() => {
      const els = [...document.querySelectorAll("[data-variant]")];
      return [...new Set(els.map((e) => e.getAttribute("data-variant")))];
    });
    check(`/yerbas (${vp.width}px): las dos presentaciones (102 y 777) en la góndola`, groupVariants.includes("102") && groupVariants.includes("777"), groupVariants.join(","));
    check(`/yerbas (${vp.width}px): la 500 g usa su propia imagen de góndola`, await page.evaluate(() => [...document.images].some((i) => /shelf-v777-1\.png/.test(i.currentSrc || i.src))));
    check(`/yerbas (${vp.width}px): sin desplazamiento horizontal ni errores`, (await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) && !errors.length, errors.join(" | "));
    await page.screenshot({ path: path.join(OUT, `yerbas-${vp.width}.png`) });
    await ctx.close();
  }
  { const { ctx, page, errors } = await open("/producto/canarias-suave", { width: 1440, height: 900 });
    const t = await page.evaluate(() => document.body.innerText);
    check("ficha tienda: Canarias Suave ofrece 500gr y 1kg", /500\s?gr?/i.test(t) && /1\s?kg/i.test(t), t.slice(0, 300));
    check("ficha tienda: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
