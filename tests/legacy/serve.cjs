// Servidor estático local con las reescrituras de vercel.json (para pruebas).
const http = require("http"), fs = require("fs"), path = require("path");
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".webp": "image/webp", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json", ".mp4": "video/mp4", ".woff2": "font/woff2" };
module.exports = function serve(root, port) {
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/track") { res.writeHead(204); return res.end(); }
    let p = decodeURIComponent(u.pathname);
    // Reescrituras de vercel.json (sin las de robots por User-Agent)
    for (const r of vercel.rewrites ?? []) {
      if (r.has) continue;
      const re = new RegExp("^" + r.source.replace(/:[a-z]+/g, "[^/]+") + "/?$");
      if (re.test(p)) { p = r.destination; break; }
    }
    if (p === "/") p = "/index.html";
    if (p.endsWith("/")) p += "index.html";
    if (p.startsWith("/_vercel/image")) {
      const s = u.searchParams.get("url") || "";
      if (/^https?:/.test(s)) { res.writeHead(302, { location: s }); return res.end(); }
      p = s;
    }
    fs.readFile(path.join(root, p), (e, d) => {
      if (e) { res.writeHead(404); return res.end("404"); }
      res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" });
      res.end(d);
    });
  });
  return new Promise((r) => srv.listen(port, () => r(srv)));
};
