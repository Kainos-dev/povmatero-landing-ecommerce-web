// Vista previa al compartir un producto (WhatsApp, Facebook, X, Telegram…).
//
// Esos servicios no ejecutan JavaScript: leen solo las etiquetas <meta> del
// HTML. vercel.json manda a esta función únicamente a sus robots (por el
// User-Agent); las personas reciben la página normal (index.html).
// Lee el producto publicado desde la vista pública de Supabase, con la misma
// clave pública que usa la tienda.

const SITE_URL = "https://povmatero-landing-ecommerce-web.vercel.app";
const SUPABASE_URL = "https://gubrehbalkfvzwsndbcv.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_cMxTBYTgJm1wQ2FkJ37uZg_XNyogu7M";
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (ch) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
));

function absoluteImage(src) {
  if (!src) return `${SITE_URL}/images/Logo.jpeg`;
  const url = /^https?:\/\//.test(src) ? src : `/${String(src).replace(/^\.?\//, "")}`;
  // Versión liviana por el optimizador de Vercel (las fotos originales pesan
  // hasta 2,5 MB y algunas apps no muestran imágenes tan pesadas).
  return `${SITE_URL}/_vercel/image?url=${encodeURIComponent(url)}&w=1200&q=75`;
}

function page({ title, description, image, url, type = "product", noindex = false }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : ""}
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="povmatero">
<meta property="og:type" content="${esc(type)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:locale" content="es_AR">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
</head>
<body>
<h1>${esc(title)}</h1>
<p>${esc(description)}</p>
<p><a href="${esc(url)}">Ver en povmatero</a></p>
</body>
</html>`;
}

function send(res, status, html, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", cache);
  res.end(html);
}

async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || "").toLowerCase();
  const notFound = () => send(res, 404, page({
    title: "Producto no disponible — povmatero",
    description: "Mirá el catálogo de povmatero: mates, bombillas, yerberos, termeras y yerbas.",
    image: `${SITE_URL}/images/Logo.jpeg`,
    url: `${SITE_URL}/`,
    type: "website",
    noindex: true,
  }), "public, s-maxage=60");

  if (!SLUG_RE.test(slug)) return notFound();

  let rows;
  try {
    const query = `${SUPABASE_URL}/rest/v1/storefront_catalog?select=product_name,description,category_name,cover_image,variant_image,price&product_slug=eq.${encodeURIComponent(slug)}&order=variant_sort.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`;
    const response = await fetch(query);
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    rows = (await response.json()).filter((r) => Number(r.price) > 0);
  } catch (err) {
    console.error("producto-meta:", err);
    return send(res, 503, page({
      title: "povmatero",
      description: "Todo para tu kit matero.",
      image: `${SITE_URL}/images/Logo.jpeg`,
      url: `${SITE_URL}/producto/${slug}`,
    }), "no-store");
  }
  if (!rows.length) return notFound();

  const first = rows[0];
  const prices = rows.map((r) => Number(r.price));
  const min = Math.min(...prices);
  const price = `${prices.length > 1 && new Set(prices).size > 1 ? "Desde " : ""}$${min.toLocaleString("es-AR")}`;
  const text = String(first.description || "").trim().replace(/\s+/g, " ");
  const description = `${text || `${first.product_name} en povmatero. ${first.category_name || ""}`.trim()} ${price}.`.slice(0, 200);

  return send(res, 200, page({
    title: `${first.product_name} — povmatero`,
    description,
    image: absoluteImage(first.cover_image || first.variant_image),
    url: `${SITE_URL}/producto/${slug}`,
  }), "public, s-maxage=600, stale-while-revalidate=86400");
}

module.exports = handler;
