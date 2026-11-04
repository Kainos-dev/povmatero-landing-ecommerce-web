// Autoprueba de guard.cjs: node -r ./guard.cjs guard-selftest.cjs
// Comprueba que: la caché local se usa, lo que falta se genera (sin red), las
// escrituras se cortan y el optimizador de Vercel se intercepta.
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
(async () => {
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const ctx = await browser.newContext();
  await ctx.route("https://sitio.test/", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>t</title>" }));
  const page = await ctx.newPage();
  await page.goto("https://sitio.test/");
  const r = await page.evaluate(async (SB) => {
    const pub = `${SB}/storage/v1/object/public/product-images/products/61/`;
    const a = await fetch(pub + "shelf-1793662327309.png");          // está en la caché (sembrada)
    const b = await fetch(pub + "no-existe-en-cache.png");            // no está: generada
    const c = await fetch(`/_vercel/image?url=${encodeURIComponent(pub + "shelf-1793662327309.png")}&w=256&q=75`);
    let w = "ok"; try { await fetch(`${SB}/rest/v1/products`, { method: "POST", body: "{}" }); } catch { w = "cortada"; }
    return { a: (await a.arrayBuffer()).byteLength, b: (await b.arrayBuffer()).byteLength, c: (await c.arrayBuffer()).byteLength, w };
  }, SB);
  check("caché: la imagen sembrada se sirve completa (real, > 1 MB)", r.a > 1e6, String(r.a));
  check("sin caché: se genera una imagen chica, sin red", r.b > 0 && r.b < 20000, String(r.b));
  check("optimizador de Vercel: interceptado y servido desde la caché", r.c === r.a);
  check("escritura no simulada: cortada", r.w === "cortada");
  await browser.close();
  console.log(`\n${ok} OK · ${fail} fallas (la escritura cortada hace que la corrida termine con código 3, a propósito)`);
})();
