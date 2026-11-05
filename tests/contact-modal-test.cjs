// Modal de contacto: TikTok en lugar de X. Se abre desde todas las entradas
// (pie, header, menú del celular) en inicio y en la ficha de un producto, en
// escritorio, tablet y celular. Catálogo simulado; guard.cjs. No escribe nada.
//   node -r ./guard.cjs contact-modal-test.cjs .. shots      (BASE_URL=… para producción)
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = process.env.BASE_URL || "http://localhost:5211";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

const CATALOG = [{ product_id: 2, product_slug: "mate-imperial", product_name: "Mate Imperial", brand: null, description: "", category_slug: "mates", category_name: "Mates",
  cover_image: null, track_stock: true, variant_image: null, product_sort: 0, shelf_image: null, variant_shelf_image: null, variant_id: 21, variant_name: "Único", price: 30000, stock: 3, variant_sort: 0 }];

(async () => {
  const srv = process.env.BASE_URL ? { close() {} } : await serve(ROOT, 5211);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  async function open(vp, url) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await ctx.addInitScript(() => localStorage.setItem("povmatero-no-track", "1"));
    await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
    await ctx.route(SB + "/rest/v1/**", (route) => {
      const u = new URL(route.request().url());
      const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
      if (u.pathname === "/rest/v1/storefront_catalog") return json(CATALOG);
      if (u.pathname === "/rest/v1/categories") return json([{ slug: "mates", sort_order: 1 }]);
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
  const isOpen = (page) => page.$eval("#contactModal", (m) => m.classList.contains("open"));
  const closeModal = async (page) => { await page.click("#contactClose", { force: true }); await page.waitForTimeout(400); };

  async function inspect(page, where) {
    const r = await page.evaluate(() => {
      const items = [...document.querySelectorAll("#contactModal .contact-item")];
      const t = items.find((a) => a.href.includes("tiktok"));
      const box = (e) => { const b = e.getBoundingClientRect(); return { w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; };
      // Tamaño visible del dibujo (sin el margen del viewBox)
      const glyph = (svg) => { const g = svg.getBBox(); const vb = svg.viewBox.baseVal; const k = svg.getBoundingClientRect().width / vb.width; return { w: g.width * k, h: g.height * k }; };
      return {
        n: items.length,
        order: items.map((a) => new URL(a.href, location.href).hostname || a.href.split(":")[0]),
        href: t?.getAttribute("href"), target: t?.target, rel: t?.rel, label: t?.getAttribute("aria-label"),
        color: t && getComputedStyle(t.querySelector("svg")).color, fill: t && getComputedStyle(t.querySelector("path")).fill,
        stroke: t && getComputedStyle(t.querySelector("path")).stroke,
        item: t && box(t), svg: t && box(t.querySelector("svg")), others: items.filter((a) => a !== t).map((a) => ({ item: box(a), glyph: glyph(a.querySelector("svg")) })),
        glyph: t && glyph(t.querySelector("svg")),
        oldX: !!document.querySelector('a[href*="x.com"], a[href*="twitter.com"]'),
        text: document.getElementById("contactModal").innerText,
      };
    });
    check(`${where}: 4 opciones; TikTok en el lugar de X (WhatsApp, Instagram, TikTok, mail)`, r.n === 4 && r.order[2].includes("tiktok"), JSON.stringify(r.order));
    check(`${where}: enlace https://www.tiktok.com/@povmatero`, r.href === "https://www.tiktok.com/@povmatero", r.href);
    check(`${where}: pestaña nueva con rel="noopener noreferrer"`, r.target === "_blank" && r.rel === "noopener noreferrer", `${r.target} ${r.rel}`);
    check(`${where}: nombre accesible «TikTok» y sin rastro de X/Twitter`, r.label === "TikTok" && !r.oldX && !/twitter|\bX\b/i.test(r.text));
    check(`${where}: ícono blanco de un solo color (relleno = blanco, sin trazo)`, r.color === "rgb(255, 255, 255)" && r.fill === "rgb(255, 255, 255)" && r.stroke === "none", `${r.color} ${r.fill} ${r.stroke}`);
    const sameBox = r.others.every((o) => Math.abs(o.item.w - r.item.w) < 1 && Math.abs(o.item.h - r.item.h) < 1);
    check(`${where}: mismo tamaño de casilla que los demás`, sameBox, JSON.stringify([r.item, ...r.others.map((o) => o.item)]));
    check(`${where}: ícono centrado en su casilla`, Math.abs(r.svg.cx - r.item.cx) < 1 && Math.abs(r.svg.cy - r.item.cy) < 1);
    const sizes = r.others.map((o) => Math.max(o.glyph.w, o.glyph.h));
    const mine = Math.max(r.glyph.w, r.glyph.h);
    check(`${where}: ícono del mismo tamaño visual que los otros (±2 px)`, mine >= Math.min(...sizes) - 2 && mine <= Math.max(...sizes) + 2, `${mine.toFixed(1)} vs ${sizes.map((s) => s.toFixed(1)).join(", ")}`);
  }

  const VPS = [["escritorio", { width: 1440, height: 900 }], ["tablet", { width: 820, height: 1180 }], ["celular", { width: 390, height: 844 }], ["celular chico", { width: 360, height: 640 }]];
  for (const [name, vp] of VPS) {
    for (const url of ["/", "/producto/mate-imperial"]) {
      const where = `${name} ${url}`;
      const { ctx, page, errors } = await open(vp, url);
      // Pie de página
      await page.evaluate(() => document.getElementById("footerContacto")?.scrollIntoView());
      await page.click("#footerContacto");
      await page.waitForTimeout(500);
      check(`${where}: se abre desde el pie`, await isOpen(page));
      await inspect(page, `${where} (pie)`);
      if (url === "/" ) await page.screenshot({ path: path.join(OUT, `contacto-${vp.width}.png`) });
      await closeModal(page);
      // Header (escritorio/tablet) o menú del celular
      const nav = await page.$('.header-nav a[href="#"]');
      if (nav && await nav.isVisible()) {
        await page.evaluate(() => scrollTo(0, 0));
        await nav.click();
        await page.waitForTimeout(500);
        check(`${where}: se abre desde el header`, await isOpen(page));
        await closeModal(page);
      } else if (await page.$("#menuBtn") && await page.isVisible("#menuBtn")) {
        await page.evaluate(() => scrollTo(0, 0));
        await page.click("#menuBtn");
        await page.waitForTimeout(400);
        await page.click("#mobileContacto");
        await page.waitForTimeout(500);
        check(`${where}: se abre desde el menú del celular`, await isOpen(page));
        await inspect(page, `${where} (menú)`);
        await closeModal(page);
      } else check(`${where}: hay una entrada en el header o el menú`, false);
      check(`${where}: sin errores`, !errors.length, errors.join(" | "));
      await ctx.close();
    }
  }
  // Etiquetas de vista previa de enlaces (twitter:card) siguen: no son una cuenta de Povmatero.
  if (!process.env.BASE_URL) check("las etiquetas twitter:card de las vistas previas no se tocaron", /twitter:card/.test(fs.readFileSync(path.join(ROOT, "js/router.js"), "utf8")));

  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
