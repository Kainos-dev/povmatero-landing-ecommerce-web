// Fase 2: optimización de imágenes en el panel.
//   * #/optimizar-imagenes: medir (solo HEAD), optimizar (1 descarga por original,
//     sube WebP nuevo, cambia la referencia solo si no cambió, NUNCA borra el
//     original), cambio concurrente, revertir, respaldo JSON, transparencia.
//   * #/gondola: una subida nueva se convierte sola a WebP liviano.
//   * Miniaturas del panel: pasan por el optimizador (nunca el original).
// El panel local se sirve como https://povmatero.test (así el optimizador está
// activo como en producción). Supabase simulado; imágenes reales LOCALES.
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3], REAL = process.argv[4];   // REAL: carpeta con PNG reales de góndola
const ORIGIN = "https://povmatero.test";
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
const PUB = `${SB}/storage/v1/object/public/product-images/`;
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });
const realFiles = fs.readdirSync(REAL).filter((f) => f.endsWith(".png")).map((f) => path.join(REAL, f));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2" };

function state() {
  const st = catalogState();
  st.products.find((p) => p.id === 61).shelf_image = PUB + "products/61/shelf-1793662327309.png";
  st.products.find((p) => p.id === 3).shelf_image = PUB + "products/3/shelf-1793663955869.png";
  st.variants.push({ id: 777, product_id: 61, name: "500gr", price: 7300, stock: 4, track_stock: true, is_active: true, sort_order: 1, price_inherited: false, cost_inherited: false, shelf_image: PUB + "products/61/shelf-v777-1793664000268.png" });
  st.product_images = [
    { id: 1, product_id: 2, variant_id: null, src: PUB + "products/2/mate-imperial.png", alt: "", is_cover: true, sort_order: 0 },
    { id: 2, product_id: 2, variant_id: null, src: PUB + "products/2/mate-lado.webp", alt: "", is_cover: false, sort_order: 1 },
  ];
  st.files = new Map();          // ruta → { buf, type } (lo que «está» en Storage)
  const real = (i) => ({ buf: fs.readFileSync(realFiles[i % realFiles.length]), type: "image/png" });
  st.files.set("products/61/shelf-1793662327309.png", real(0));
  st.files.set("products/3/shelf-1793663955869.png", real(3));
  st.files.set("products/61/shelf-v777-1793664000268.png", real(6));
  st.files.set("products/2/mate-imperial.png", real(1));
  st.files.set("products/2/mate-lado.webp", { buf: Buffer.alloc(40 * 1024, 1), type: "image/webp" });
  st.storageGets = []; st.storageHeads = []; st.storageDeletes = []; st.optimizer = [];
  return st;
}

// Como Supabase: de un multipart/form-data se guarda la parte del archivo con su tipo.
function fileFromUpload(req) {
  const raw = req.postDataBuffer() ?? Buffer.alloc(0), ct = req.headers()["content-type"] ?? "";
  const m = ct.match(/boundary=(.+)$/);
  if (!m) return { buf: raw, type: ct };
  const sep = Buffer.from("--" + m[1]);
  let pos = 0; const parts = [];
  while ((pos = raw.indexOf(sep, pos)) !== -1) { const next = raw.indexOf(sep, pos + sep.length); if (next === -1) break; parts.push(raw.subarray(pos + sep.length + 2, next - 2)); pos = next; }
  for (const part of parts) {
    const end = part.indexOf("\r\n\r\n"); const head = part.subarray(0, end).toString();
    if (/filename=/.test(head) || /Content-Type: image/i.test(head)) return { buf: part.subarray(end + 4), type: (head.match(/Content-Type: ([^\r\n]+)/i)?.[1] ?? "").trim() };
  }
  return { buf: raw, type: ct };
}

function extra({ route, req, url, p, m, json, rows, st }) {
  if (p.startsWith("/storage/v1/object/public/product-images/")) {
    const key = decodeURIComponent(p.slice("/storage/v1/object/public/product-images/".length));
    const f = st.files.get(key);
    (m === "HEAD" ? st.storageHeads : st.storageGets).push(key);
    if (!f) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: f.type, headers: { "access-control-allow-origin": "*", "content-length": String(f.buf.length) }, body: m === "HEAD" ? "" : f.buf });
  }
  if (p.startsWith("/storage/v1/object/product-images/") && m === "POST") {
    const key = decodeURIComponent(p.slice("/storage/v1/object/product-images/".length));
    if (st.files.has(key)) return json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, 400);
    const f = fileFromUpload(req);
    st.files.set(key, f);
    st.uploads.push({ path: key, type: f.type, size: f.buf.length });
    return json({ Key: "product-images/" + key });
  }
  if (p === "/storage/v1/object/product-images" && m === "DELETE") {
    let body = null; try { body = JSON.parse(req.postData() || "null"); } catch {}
    st.storageDeletes.push(...(body?.prefixes ?? []));
    for (const k of body?.prefixes ?? []) st.files.delete(k);
    return json((body?.prefixes ?? []).map((name) => ({ name })));
  }
  // Cambio concurrente simulado: alguien reemplazó la imagen justo antes.
  if (st.concurrent && m === "PATCH" && p === `/rest/v1/${st.concurrent.table}` && url.searchParams.get("id") === `eq.${st.concurrent.id}`) {
    const row = (st.concurrent.table === "products" ? st.products : st.variants).find((r) => `eq.${r.id}` === url.searchParams.get("id"));
    if (row && url.searchParams.get("shelf_image")) { row.shelf_image = PUB + "products/3/shelf-9999.png"; st.concurrent = null; return rows([]); }
  }
  return undefined;
}

(async () => {
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  async function open(hash, st, vp = { width: 1440, height: 900 }) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700, acceptDownloads: true });
    await installMock(ctx, st, { extra });
    // Sitio local servido como si fuera el publicado (https), con el optimizador simulado.
    await ctx.route(ORIGIN + "/**", (r) => {
      const u = new URL(r.request().url());
      if (u.pathname === "/_vercel/image") { st.optimizer.push(u.searchParams.get("url")); return r.fulfill({ status: 200, contentType: "image/webp", body: fs.readFileSync(path.join(__dirname, "test-pack.png")) }); }
      if (u.pathname === "/api/track") return r.fulfill({ status: 204 });
      let file = decodeURIComponent(u.pathname);
      if (file.endsWith("/")) file += "index.html";
      const full = path.join(ROOT, file);
      if (!fs.existsSync(full)) return r.fulfill({ status: 404, body: "" });
      return r.fulfill({ status: 200, contentType: TYPES[path.extname(full)] ?? "application/octet-stream", body: fs.readFileSync(full) });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource/.test(mm.text())) errors.push(mm.text()); });
    await page.goto(ORIGIN + "/admin/" + hash);
    await page.waitForFunction(() => { const c = document.getElementById("adminContent"); return c && c.innerText.trim() && !/Cargando/.test(c.innerText); }, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(800);
    return { ctx, page, errors };
  }
  const text = (page, sel = "#adminContent") => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);

  // ---------- 1. Optimizar existentes ----------
  { const st = state();
    const { ctx, page, errors } = await open("#/optimizar-imagenes", st);
    const t = await text(page);
    check("lista: góndola (2), góndola por presentación (1) y fotos (2)", /Góndola \(2\)/.test(t) && /Góndola \(presentación\) \(1\)/.test(t) && /Fotos del catálogo \(2\)/.test(t), t.slice(0, 400));
    check("al abrir: ningún original descargado ni medido", st.storageGets.length === 0 && st.storageHeads.length === 0, JSON.stringify(st.storageGets));
    check("miniaturas: pasan por el optimizador (128 px), no por el original", st.optimizer.length >= 5 && st.optimizer.every((u) => u.startsWith(PUB)));
    check("sin medir no se puede optimizar", await page.$eval('button:has-text("2. Optimizar")', (b) => b.disabled));
    await page.click('button:has-text("1. Medir tamaños")');
    await page.waitForFunction(() => /seleccionadas/.test(document.querySelector("#adminContent").innerText), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    check("medir: solo HEAD (5), ninguna descarga", st.storageHeads.length === 5 && st.storageGets.length === 0, `${st.storageHeads.length} HEAD / ${st.storageGets.length} GET`);
    const sel = await page.$$eval(".opt-row", (r) => r.map((x) => [x.dataset.key, x.querySelector("input").checked]));
    check("medir: PNG elegidos; el WebP liviano no", sel.filter(([, c]) => c).length === 4 && sel.find(([k]) => k === "img:2")[1] === false, JSON.stringify(sel));
    await page.screenshot({ path: path.join(OUT, "optimizar-escritorio.png"), fullPage: true });
    // Una imagen cambia mientras tanto (la general de Canarias Tradicional)
    st.concurrent = { table: "products", id: 3 };
    await page.click('button:has-text("2. Optimizar")');
    await page.waitForTimeout(200);
    check("confirmación: informa descarga única, copia nueva y que los originales NO se borran", /una sola vez/.test(await text(page, ".confirm-box")) && /NO se borran/.test(await text(page, ".confirm-box")));
    check("confirmación: todavía no descargó nada", st.storageGets.length === 0);
    const before = new Map(st.files);
    await page.click('.confirm-box button:has-text("Sí, optimizar")');
    await page.waitForFunction(() => /^Listo:/.test(document.querySelector('[role=status]')?.textContent ?? ""), null, { timeout: 60000 });
    const gets = st.storageGets;
    check("optimizar: cada original se descargó una sola vez (4)", gets.length === 4 && new Set(gets).size === 4, JSON.stringify(gets));
    const webps = st.uploads.filter((u) => u.type === "image/webp");
    check("optimizar: 4 copias WebP subidas con nombre nuevo (nunca pisan)", webps.length === 4 && webps.every((u) => !before.has(u.path)), JSON.stringify(st.uploads));
    check("optimizar: nombres compatibles (shelf-<ts>.webp / shelf-v777-<ts>.webp / -opt-)", webps.some((u) => /^products\/61\/shelf-\d+\.webp$/.test(u.path)) && webps.some((u) => /^products\/61\/shelf-v777-\d+\.webp$/.test(u.path)) && webps.some((u) => /^products\/2\/mate-imperial-opt-[a-z0-9]+\.webp$/.test(u.path)));
    const p61 = st.products.find((p) => p.id === 61), v777 = st.variants.find((v) => v.id === 777), img1 = st.product_images.find((i) => i.id === 1);
    check("optimizar: referencias cambiadas a las copias WebP", /shelf-\d+\.webp$/.test(p61.shelf_image) && /shelf-v777-\d+\.webp$/.test(v777.shelf_image) && /-opt-.*\.webp$/.test(img1.src), [p61.shelf_image, v777.shelf_image, img1.src].join(" | "));
    check("optimizar: los ORIGINALES siguen en Storage (respaldo)", ["products/61/shelf-1793662327309.png", "products/3/shelf-1793663955869.png", "products/61/shelf-v777-1793664000268.png", "products/2/mate-imperial.png"].every((k) => st.files.has(k)));
    check("cambio concurrente: Canarias Tradicional no se tocó y su copia nueva se borró", st.products.find((p) => p.id === 3).shelf_image.endsWith("shelf-9999.png")
      && st.storageDeletes.length === 1 && /^products\/3\/shelf-\d+\.webp$/.test(st.storageDeletes[0]) && /Cambió mientras tanto/.test(await page.$eval('[data-key="shelf:3"]', (r) => r.innerText)), JSON.stringify(st.storageDeletes));
    check("optimizar: nunca se borró un original", !st.storageDeletes.some((k) => before.has(k)));
    const sizes = webps.map((u) => u.size), orig = [0, 6, 1].map((i) => fs.statSync(realFiles[i]).size);
    check("optimizar: las copias pesan mucho menos (< 15 % del PNG)", Math.max(...sizes) < Math.min(...orig) * 0.15, `${sizes} vs ${orig}`);
    // transparencia de la copia de góndola
    const shelfUp = st.files.get(webps.find((u) => /shelf-\d+\.webp$/.test(u.path) && u.path.startsWith("products/61/")).path).buf;
    const alpha = await page.evaluate(async (b64) => {
      const blob = await (await fetch(`data:image/webp;base64,${b64}`)).blob();
      const bm = await createImageBitmap(blob); const c = new OffscreenCanvas(bm.width, bm.height); const x = c.getContext("2d"); x.drawImage(bm, 0, 0);
      const px = (X, Y) => x.getImageData(X, Y, 1, 1).data[3];
      return { w: bm.width, h: bm.height, corners: [px(0, 0), px(bm.width - 1, 0), px(0, bm.height - 1), px(bm.width - 1, bm.height - 1)], center: px(bm.width >> 1, bm.height >> 1) };
    }, shelfUp.toString("base64"));
    check("transparencia: esquinas transparentes y centro opaco en la copia WebP", alpha.corners.every((a) => a === 0) && alpha.center === 255 && Math.max(alpha.w, alpha.h) === 1200, JSON.stringify(alpha));
    const log = await text(page, "#adminContent");
    check("registro: 3 cambios con ahorro y opción de revertir", /Cambios hechos \(3\)/.test(log) && (await page.$$('button:has-text("Revertir")')).length === 3, log.slice(-400));
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click('button:has-text("Descargar respaldo")')]);
    const backup = JSON.parse(fs.readFileSync(await dl.path(), "utf8"));
    check("respaldo JSON: cada cambio con URL vieja y nueva", backup.cambios.length === 3 && backup.cambios.every((e) => e.old.startsWith(PUB) && e.new.startsWith(PUB) && e.before > e.after));
    // Revertir la de la presentación
    const newV = v777.shelf_image;
    await page.click('[data-log="shelfv:777"] button:has-text("Revertir")');
    await page.waitForTimeout(800);
    check("revertir: vuelve a la original sin borrar la copia", v777.shelf_image.endsWith("shelf-v777-1793664000268.png") && st.files.has(newV.slice(PUB.length)), v777.shelf_image);
    check("sin errores de JavaScript", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 2. Góndola: subida nueva optimizada ----------
  { const st = state();
    const { ctx, page, errors } = await open("#/gondola", st);
    check("góndola: miniaturas por el optimizador, ningún original descargado", st.storageGets.length === 0 && st.optimizer.length >= 3, `${st.storageGets.length} GET, ${st.optimizer.length} optimizadas`);
    const input = await page.$('input.shelf-file[aria-label*="Sara Tradicional"]') ?? (await page.$$("input.shelf-file"))[0];
    const big = realFiles[0];
    await input.setInputFiles(big);
    await page.waitForFunction(() => /Imagen de góndola guardada/.test(document.querySelector(".toast")?.textContent ?? ""), null, { timeout: 30000 }).catch(() => {});
    const up = st.uploads.at(-1);
    const toastMsg = await page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
    check("góndola: el PNG grande se sube como WebP liviano", up && up.type === "image/webp" && /\.webp$/.test(up.path) && up.size < fs.statSync(big).size * 0.15, JSON.stringify(up));
    check("góndola: el aviso muestra el ahorro", /Optimizada: 2,1 MB → \d+ KB/.test(toastMsg), toastMsg);
    check("góndola: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 3. Imágenes del producto (miniaturas) y celular ----------
  { const st = state();
    const { ctx, page, errors } = await open("#/productos/2?tab=imagenes", st);
    check("producto › imágenes: miniaturas optimizadas, sin descargar originales", st.storageGets.length === 0 && st.optimizer.some((u) => u.endsWith("mate-imperial.png")), JSON.stringify(st.storageGets));
    check("producto › imágenes: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }
  { const st = state();
    const { ctx, page, errors } = await open("#/optimizar-imagenes", st, { width: 390, height: 844 });
    check("celular: sin desplazamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(OUT, "optimizar-celular.png"), fullPage: true });
    check("celular: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  await browser.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
