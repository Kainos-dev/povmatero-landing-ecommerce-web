// Mide la conversión a WebP (mismo código del panel: convertKeepingAlpha /
// convertToWebp) sobre copias LOCALES de las imágenes. No toca la red.
// Calidad: PSNR del color (ponderado por opacidad) y diferencia del canal alfa,
// contra el original llevado al mismo tamaño. También compara el margen
// transparente de abajo (lo usa /yerbas para apoyar el envase).
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const SETS = process.argv.slice(4);   // carpetas con imágenes: "etiqueta=carpeta"
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = await serve(ROOT, 5206);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage();
  const files = [];
  for (const s of SETS) {
    const [label, dir] = s.split("=");
    for (const f of fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))) files.push({ label, file: path.join(dir, f), name: f });
  }
  await page.route("http://localhost:5206/__local/**", (r) => {
    const i = Number(new URL(r.request().url()).pathname.split("/").pop());
    const f = files[i].file;
    r.fulfill({ status: 200, contentType: /png$/i.test(f) ? "image/png" : /webp$/i.test(f) ? "image/webp" : "image/jpeg", body: fs.readFileSync(f) });
  });
  await page.goto("http://localhost:5206/admin/");   // mismo origen: importa el módulo del panel
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const r = await page.evaluate(async ({ i, mode }) => {
      const m = await import("/admin/js/imageConvert.js");
      const res = await fetch(`/__local/${i}`);
      const blob = await res.blob();
      const file = new File([blob], "x", { type: blob.type });
      const t0 = performance.now();
      const out = mode === "alpha" ? await m.convertKeepingAlpha(file) : await m.convertToWebp(file);
      const ms = performance.now() - t0;
      const W = out.width, H = out.height;
      const draw = async (b) => {
        const bm = await createImageBitmap(b, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
        const c = new OffscreenCanvas(W, H), x = c.getContext("2d", { willReadFrequently: true });
        x.imageSmoothingQuality = "high"; x.drawImage(bm, 0, 0, W, H);
        return x.getImageData(0, 0, W, H).data;
      };
      const a = await draw(blob), b = await draw(out.blob);
      let se = 0, wsum = 0, maxA = 0, sumA = 0, n = W * H;
      for (let p = 0; p < a.length; p += 4) {
        const w = a[p + 3] / 255;
        for (let k = 0; k < 3; k++) { const d = a[p + k] - b[p + k]; se += w * d * d; }
        wsum += 3 * w;
        const da = Math.abs(a[p + 3] - b[p + 3]); maxA = Math.max(maxA, da); sumA += da;
      }
      const mse = se / Math.max(wsum, 1);
      const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
      const trim = (d) => { for (let y = H - 1; y >= 0; y--) for (let x = 0; x < W; x += 2) if (d[(y * W + x) * 4 + 3] > 24) return H - 1 - y; return H; };
      const transparentA = (() => { let t = 0; for (let p = 3; p < a.length; p += 4) if (a[p] < 8) t++; return t / n; })();
      const transparentB = (() => { let t = 0; for (let p = 3; p < b.length; p += 4) if (b[p] < 8) t++; return t / n; })();
      return { before: blob.size, after: out.blob.size, type: out.blob.type, w: W, h: H, psnr, maxA, meanA: sumA / n, trimA: trim(a), trimB: trim(b), transparentA, transparentB, ms, changed: out.changed ?? true };
    }, { i, mode: files[i].label === "foto" ? "photo" : "alpha" });
    rows.push({ ...files[i], ...r });
    // Muestra visual: original y WebP lado a lado (para revisar a ojo)
  }
  const mb = (b) => (b / 1048576).toFixed(2);
  let lines = ["conjunto | archivo | antes MB | después MB | ahorro | medidas | PSNR dB | alfa máx/medio | margen abajo px (antes→después) | transp. %"];
  const groups = {};
  for (const r of rows) {
    (groups[r.label] ??= []).push(r);
    lines.push(`${r.label} | ${r.name} | ${mb(r.before)} | ${mb(r.after)} | ${Math.round((1 - r.after / r.before) * 100)} % | ${r.w}×${r.h} | ${r.psnr.toFixed(1)} | ${r.maxA}/${r.meanA.toFixed(2)} | ${r.trimA}→${r.trimB} | ${(r.transparentA * 100).toFixed(1)}→${(r.transparentB * 100).toFixed(1)}`);
  }
  lines.push("");
  for (const [g, list] of Object.entries(groups)) {
    const b = list.reduce((s, r) => s + r.before, 0), a = list.reduce((s, r) => s + r.after, 0);
    const minP = Math.min(...list.map((r) => r.psnr));
    lines.push(`TOTAL ${g}: ${list.length} archivos · ${mb(b)} MB → ${mb(a)} MB (−${Math.round((1 - a / b) * 100)} %) · PSNR mínimo ${minP.toFixed(1)} dB · márgenes iguales: ${list.filter((r) => Math.abs(r.trimA - r.trimB) <= 1).length}/${list.length}`);
  }
  const text = lines.join("\n");
  fs.writeFileSync(path.join(OUT, "medicion-webp.txt"), text);
  fs.writeFileSync(path.join(OUT, "medicion-webp.json"), JSON.stringify(rows.map(({ file, ...r }) => r), null, 1));
  console.log(text);

  // Comparación visual de 2 envases: original | WebP sobre fondo de tabla oscuro
  const samples = rows.filter((r) => r.label === "gondola").slice(0, 2).map((r) => files.findIndex((f) => f.file === r.file));
  const html = await page.evaluate(async (idx) => {
    const m = await import("/admin/js/imageConvert.js");
    const parts = [];
    for (const i of idx) {
      const blob = await (await fetch(`/__local/${i}`)).blob();
      const out = await m.convertKeepingAlpha(new File([blob], "x", { type: blob.type }));
      parts.push([URL.createObjectURL(blob), URL.createObjectURL(out.blob)]);
    }
    document.body.innerHTML = `<div style="background:#2a1d14;display:flex;gap:24px;padding:24px;flex-wrap:wrap">${parts.map(([a, b]) =>
      `<figure style="margin:0;color:#fff;font:12px sans-serif"><img src="${a}" style="height:420px"><figcaption>PNG original</figcaption></figure><figure style="margin:0;color:#fff;font:12px sans-serif"><img src="${b}" style="height:420px"><figcaption>WebP</figcaption></figure>`).join("")}</div>`;
    await new Promise((r) => setTimeout(r, 800));
    return true;
  }, samples);
  if (html) await page.screenshot({ path: path.join(OUT, "comparacion-gondola.png"), fullPage: true });
  await browser.close(); srv.close();
})().catch((e) => { console.error(e); process.exit(2); });
