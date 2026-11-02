// Estadísticas: recibe eventos anónimos de la tienda y los guarda en Supabase.
//
// La tienda los envía con navigator.sendBeacon (js/lib/track.js). Esta función:
//   * acepta solo pedidos que vienen del propio sitio;
//   * descarta robots;
//   * agrega país y región con los datos de Vercel (la IP no se guarda);
//   * deduce tipo de dispositivo, navegador y sistema del User-Agent;
//   * valida y recorta todo antes de guardar.
// Escribe con la clave secreta de Supabase, guardada SOLO como variable de
// entorno del servidor (SUPABASE_SECRET_KEY en Vercel). Sin esa variable no
// guarda nada y responde igual (la tienda nunca se entera ni falla).

const SUPABASE_URL = "https://gubrehbalkfvzwsndbcv.supabase.co";
const EVENTS = new Set(["page_view", "product_view", "add_to_cart", "begin_checkout"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// El sitio publicado, sus Previews y las pruebas locales.
const ALLOWED_HOST_RE = /^(povmatero-landing-ecommerce-web\.vercel\.app|povmatero-landing-ecommerce[a-z0-9-]*\.vercel\.app|localhost(:\d+)?)$/;
const BOT_RE = /bot|crawl|spider|slurp|facebookexternalhit|whatsapp|telegram|preview|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|node-fetch|axios/i;
const MAX_EVENTS = 20;
const MAX_BODY = 16 * 1024;

const clip = (value, max) => {
  if (value == null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
};

function device(ua) {
  if (/ipad|tablet|(android(?!.*mobile))/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

function browser(ua) {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/instagram/i.test(ua)) return "Instagram";
  if (/fban|fbav/i.test(ua)) return "Facebook";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return "Otro";
}

function os(ua) {
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/android/i.test(ua)) return "Android";
  if (/windows/i.test(ua)) return "Windows";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/linux/i.test(ua)) return "Linux";
  return "Otro";
}

function headerText(req, name) {
  const value = req.headers[name];
  if (!value) return null;
  try { return decodeURIComponent(Array.isArray(value) ? value[0] : value); } catch { return null; }
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return null; }
}

async function readBody(req) {
  if (req.body != null) {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
    return JSON.stringify(req.body);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Convierte lo que manda el navegador en filas válidas (o las descarta).
function toRows(payload, req) {
  const ua = String(req.headers["user-agent"] ?? "");
  const country = clip(headerText(req, "x-vercel-ip-country"), 2);
  const base = {
    device: device(ua),
    browser: browser(ua),
    os: os(ua),
    country: country && /^[A-Z]{2}$/.test(country) ? country : null,
    region: clip(headerText(req, "x-vercel-ip-country-region"), 80),
  };
  const list = Array.isArray(payload?.events) ? payload.events.slice(0, MAX_EVENTS) : [];
  const rows = [];
  for (const e of list) {
    if (!EVENTS.has(e?.event)) continue;
    if (!UUID_RE.test(String(e.visitor_id)) || !UUID_RE.test(String(e.session_id))) continue;
    // Solo la ruta: sin parámetros ni fragmento (pueden traer datos que no corresponde guardar).
    const path = clip(String(e.path ?? "").split(/[?#]/)[0], 300);
    if (!path || !path.startsWith("/")) continue;
    const productId = Number(e.product_id);
    const referrer = clip(e.referrer_host, 120);
    rows.push({
      ...base,
      event: e.event,
      visitor_id: e.visitor_id,
      session_id: e.session_id,
      path,
      product_id: Number.isInteger(productId) && productId > 0 ? productId : null,
      referrer_host: referrer && /^[a-z0-9.-]+$/i.test(referrer) ? referrer.toLowerCase() : null,
      utm_source: clip(e.utm_source, 100),
      utm_medium: clip(e.utm_medium, 100),
      utm_campaign: clip(e.utm_campaign, 100),
    });
  }
  return rows;
}

async function handler(req, res) {
  const done = (status) => { res.statusCode = status; res.end(); };
  if (req.method !== "POST") return done(405);

  // Solo desde el propio sitio (Origin o, si no viene, Referer).
  const origin = hostOf(req.headers.origin) ?? hostOf(req.headers.referer);
  if (!origin || !ALLOWED_HOST_RE.test(origin)) return done(403);
  if (BOT_RE.test(String(req.headers["user-agent"] ?? ""))) return done(204);

  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) return done(204);   // todavía sin configurar: no se guarda nada

  let rows;
  try {
    rows = toRows(JSON.parse(await readBody(req)), req);
  } catch {
    return done(400);
  }
  if (!rows.length) return done(204);

  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/analytics_events`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(rows),
    });
    if (!response.ok) console.error("track: Supabase respondió", response.status, await response.text());
  } catch (err) {
    console.error("track: no se pudo guardar", err);
  }
  return done(204);
}

module.exports = handler;
module.exports.toRows = toRows;
