// Auditoría de solo lectura: tamaños y caché de las imágenes en Storage.
// Solo pide el catálogo (JSON) y hace HEAD a cada imagen (sin descargar el contenido).
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";
const KEY = "sb_publishable_cMxTBYTgJm1wQ2FkJ37uZg_XNyogu7M";
const rest = async (path) => (await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY } })).json();

(async () => {
  const cat = await rest("storefront_catalog?select=product_id,product_name,category_slug,cover_image,variant_image,shelf_image,variant_shelf_image&limit=2000");
  const imgs = await rest("product_images?select=product_id,src,is_cover,variant_id&limit=5000");
  const roles = new Map();   // url → set de usos
  const add = (u, r) => { if (u && /^https?:/.test(u)) { if (!roles.has(u)) roles.set(u, new Set()); roles.get(u).add(r); } };
  const yerba = new Set(cat.filter((r) => r.category_slug === "yerbas").map((r) => r.product_id));
  for (const r of cat) {
    add(r.cover_image, r.category_slug === "yerbas" ? "portada-yerba" : "portada");
    add(r.variant_image, "variante");
    add(r.shelf_image, "gondola");
    add(r.variant_shelf_image, "gondola-presentacion");
  }
  for (const i of imgs) add(i.src, yerba.has(i.product_id) ? "galeria-yerba" : "galeria");
  const local = imgs.filter((i) => !/^https?:/.test(i.src)).length;

  const rows = [];
  const urls = [...roles.keys()];
  for (let i = 0; i < urls.length; i += 12) {
    await Promise.all(urls.slice(i, i + 12).map(async (u) => {
      try {
        const res = await fetch(u, { method: "HEAD" });
        rows.push({ u, bytes: Number(res.headers.get("content-length") || 0), type: res.headers.get("content-type"),
          cc: res.headers.get("cache-control"), cf: res.headers.get("cf-cache-status"), roles: [...roles.get(u)] });
      } catch (e) { rows.push({ u, bytes: 0, err: e.message, roles: [...roles.get(u)] }); }
    }));
  }
  const mb = (b) => (b / 1048576).toFixed(2) + " MB";
  const by = (role) => rows.filter((r) => r.roles.includes(role));
  const sum = (list) => list.reduce((s, r) => s + r.bytes, 0);
  console.log(`Productos publicados: ${new Set(cat.map((r) => r.product_id)).size} (yerbas ${yerba.size}); imágenes en Storage: ${rows.length}; en el repo (/images): ${local}`);
  console.log(`Total en Storage referenciado: ${mb(sum(rows))}`);
  for (const role of ["portada", "portada-yerba", "galeria", "galeria-yerba", "variante", "gondola", "gondola-presentacion"]) {
    const l = by(role);
    if (!l.length) continue;
    const s = l.map((r) => r.bytes).sort((a, b) => a - b);
    console.log(`${role.padEnd(22)} n=${String(l.length).padStart(3)}  total ${mb(sum(l)).padStart(9)}  mediana ${mb(s[Math.floor(s.length / 2)])}  máx ${mb(s.at(-1))}`);
  }
  const types = {}; rows.forEach((r) => { types[r.type] = (types[r.type] ?? 0) + 1; });
  console.log("Tipos:", JSON.stringify(types));
  const ccs = {}; rows.forEach((r) => { ccs[r.cc] = (ccs[r.cc] ?? 0) + 1; });
  console.log("Cache-Control:", JSON.stringify(ccs));
  const cfs = {}; rows.forEach((r) => { cfs[r.cf] = (cfs[r.cf] ?? 0) + 1; });
  console.log("cf-cache-status (HEAD):", JSON.stringify(cfs));
  console.log("Más pesadas:");
  rows.sort((a, b) => b.bytes - a.bytes).slice(0, 8).forEach((r) => console.log(`  ${mb(r.bytes).padStart(9)}  ${r.roles.join(",")}  ${r.u.split("/").slice(-3).join("/")}`));
})();
