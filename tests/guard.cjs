// Protección para TODAS las pruebas de navegador. Se precarga:
//   node -r ./guard.cjs suite.cjs …
//
// 1. Imágenes de Supabase Storage y del optimizador de Vercel (/_vercel/image):
//    nunca salen a la red por defecto. Se sirven desde una CACHÉ LOCAL
//    persistente (tests/.image-cache, fuera de git) y, si la imagen no está,
//    una imagen PNG generada acá (2:3, con margen transparente abajo).
//      · GUARD_FETCH=N      permite descargar hasta N imágenes que falten (una
//                           sola vez: quedan guardadas para siempre).
//      · GUARD_FETCH_MAX_MB tope total de esas descargas (por defecto 25 MB).
//    Sembrar la caché con copias que ya tenés en disco (sin red):
//      node seed-image-cache.cjs <carpeta>
// 2. Escrituras a Supabase (POST/PATCH/PUT/DELETE a /rest, /storage o /auth):
//    si una suite no las simuló, se cortan y la corrida falla (código 3).
//    Las lecturas JSON del catálogo pasan (son chicas) y se cuentan.
// Al terminar imprime cuántas solicitudes hubo de cada tipo.
const path = require("path");
const fs = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");
const PW = process.env.PW;
const pwc = path.join(PW, "node_modules/playwright-core/lib/client");
const { Route } = require(path.join(pwc, "network.js"));
const { BrowserContext } = require(path.join(pwc, "browserContext.js"));
const { Browser } = require(path.join(pwc, "browser.js"));
const SB_HOST = "gubrehbalkfvzwsndbcv.supabase.co";
const CACHE_DIR = process.env.GUARD_CACHE_DIR || path.join(__dirname, ".image-cache");
const FETCH_LEFT = { n: Number(process.env.GUARD_FETCH || 0), bytes: Number(process.env.GUARD_FETCH_MAX_MB || 25) * 1048576 };

const stats = { cacheHits: 0, synthetic: 0, fetched: 0, fetchedBytes: 0, storageNetwork: 0, writesBlocked: [], authBlocked: 0, restGets: 0, vercelImages: 0 };

// ---------- Imagen generada (si no está en la caché) ----------
function makePng(w = 200, h = 300) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 4 + 1) + 1 + x * 4;
      const body = y < h * 0.94 && x > w * 0.04 && x < w * 0.96;
      raw[o] = 180; raw[o + 1] = 150; raw[o + 2] = 60; raw[o + 3] = body ? 255 : 0;
    }
  }
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (buf) => { let x = 0xffffffff; for (const b of buf) x = table[(x ^ b) & 0xff] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = makePng();
const TYPE_BY_EXT = { png: "image/png", webp: "image/webp", jpg: "image/jpeg", jpeg: "image/jpeg", avif: "image/avif" };

// ---------- Caché local ----------
const keyOf = (storagePath) => crypto.createHash("sha1").update(storagePath).digest("hex").slice(0, 20);
function cachePaths(storagePath) {
  const ext = (storagePath.match(/\.([a-z0-9]+)$/i)?.[1] ?? "bin").toLowerCase();
  return { exact: path.join(CACHE_DIR, `${keyOf(storagePath)}.${ext}`), byName: path.join(CACHE_DIR, "by-name", path.basename(storagePath)), ext };
}
function fromCache(storagePath) {
  const { exact, byName, ext } = cachePaths(storagePath);
  for (const f of [exact, byName]) if (fs.existsSync(f)) return { body: fs.readFileSync(f), type: TYPE_BY_EXT[ext] ?? "application/octet-stream" };
  return null;
}
async function fetchIntoCache(url, storagePath) {
  if (FETCH_LEFT.n <= 0 || FETCH_LEFT.bytes <= 0) return null;
  FETCH_LEFT.n--;
  stats.storageNetwork++;   // descarga real (autorizada con GUARD_FETCH)
  const res = await fetch(url);
  if (!res.ok) return null;
  const body = Buffer.from(await res.arrayBuffer());
  FETCH_LEFT.bytes -= body.length;
  stats.fetched++; stats.fetchedBytes += body.length;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePaths(storagePath).exact, body);
  return { body, type: res.headers.get("content-type") ?? "image/png" };
}

const isSb = (u) => { try { return new URL(u).hostname === SB_HOST; } catch { return false; } };
const storagePathOf = (u) => { try { const p = new URL(u).pathname; const m = p.match(/^\/storage\/v1\/object\/(?:public\/)?product-images\/(.+)$/); return m ? decodeURIComponent(m[1]) : null; } catch { return null; } };
const isStorage = (u) => isSb(u) && new URL(u).pathname.startsWith("/storage/v1/object/");
const isVercelImage = (u) => { try { return new URL(u).pathname === "/_vercel/image"; } catch { return false; } };
const isWrite = (m) => !["GET", "HEAD", "OPTIONS"].includes(m);

async function serveImage(route, url) {
  const sp = storagePathOf(url);
  let hit = sp ? fromCache(sp) : null;
  if (hit) stats.cacheHits++;
  else if (sp && (hit = await fetchIntoCache(url, sp))) { /* descargada y guardada */ }
  else { stats.synthetic++; hit = { body: PNG, type: "image/png" }; }
  return route.fulfill({ status: 200, contentType: hit.type, headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000" }, body: route.request().method() === "HEAD" ? "" : hit.body });
}

async function bottomHandler(route) {
  const req = route.request(), u = req.url(), m = req.method();
  if (isVercelImage(u) && process.env.GUARD_ALLOW_VERCEL_IMAGES !== "1") {
    stats.vercelImages++;
    return serveImage(route, new URL(u).searchParams.get("url") ?? "");
  }
  if (!isSb(u)) return route.fallback();
  if (isStorage(u) && !isWrite(m)) return serveImage(route, u);
  if (isWrite(m)) {
    if (new URL(u).pathname.startsWith("/auth/")) { stats.authBlocked++; return route.fulfill({ status: 204, body: "" }); }
    stats.writesBlocked.push(`${m} ${new URL(u).pathname}`);
    return route.abort("blockedbyclient");
  }
  stats.restGets++;
  return route.continue();
}

// Si una suite deja pasar algo a la red, se controla acá también.
const origContinue = Route.prototype.continue;
Route.prototype.continue = async function (options = {}) {
  const req = this.request(), u = options.url ?? req.url(), m = options.method ?? req.method();
  if (isSb(u) && isStorage(u) && !isWrite(m)) return serveImage(this, u);
  if (isSb(u) && isWrite(m)) {
    if (new URL(u).pathname.startsWith("/auth/")) { stats.authBlocked++; return this.fulfill({ status: 204, body: "" }); }
    stats.writesBlocked.push(`${m} ${new URL(u).pathname}`);
    return this.abort("blockedbyclient");
  }
  return origContinue.call(this, options);
};
const origFetch = Route.prototype.fetch;
Route.prototype.fetch = async function (options = {}) {
  const req = this.request(), u = options.url ?? req.url(), m = options.method ?? req.method();
  if (isSb(u) && isWrite(m)) { stats.writesBlocked.push(`${m} ${new URL(u).pathname} (fetch)`); throw new Error("guard: escritura bloqueada"); }
  if (isStorage(u)) stats.storageNetwork++;
  return origFetch.call(this, options);
};

// La barrera se registra al crear el contexto (antes que los simulacros de
// cada suite): recibe solo lo que NADIE simuló.
const origRoute = BrowserContext.prototype.route;
const origNewContext = Browser.prototype.newContext;
Browser.prototype.newContext = async function (...args) {
  const ctx = await origNewContext.apply(this, args);
  await origRoute.call(ctx, (url) => isSb(url.toString()) || isVercelImage(url.toString()), bottomHandler);
  return ctx;
};

process.on("exit", () => {
  const unexpected = stats.writesBlocked.length || (stats.storageNetwork - stats.fetched);
  console.log(`[protección] imágenes: caché local ${stats.cacheHits} · generadas ${stats.synthetic} · descargadas (autorizadas) ${stats.fetched} (${(stats.fetchedBytes / 1048576).toFixed(2)} MB) · descargas no autorizadas ${stats.storageNetwork - stats.fetched} · optimizador de Vercel interceptado ${stats.vercelImages} · lecturas JSON reales ${stats.restGets} · escrituras bloqueadas ${stats.writesBlocked.length}${stats.writesBlocked.length ? " → " + [...new Set(stats.writesBlocked)].join(", ") : ""} · cierres de sesión simulados ${stats.authBlocked}`);
  if (unexpected) process.exitCode = 3;
});
