// Estadísticas de la tienda (ver api/track.js y la migración 20261104000000).
//
// Anónimas: un identificador al azar por navegador (visitante) y otro por visita
// (sesión, que se renueva tras 30 minutos sin actividad). Sin cookies, sin IP,
// sin nombres ni emails. Los eventos se juntan y se envían en segundo plano:
// nunca demoran ni rompen la tienda.
//
// No se cuenta:
//   * un navegador donde un administrador ingresó al panel (marca
//     "povmatero-no-track", la pone admin/js/main.js);
//   * quien tiene activado «No rastrear» en el navegador.

const ENDPOINT = "/api/track";
const VISITOR_KEY = "povmatero-visitor";
const SESSION_KEY = "povmatero-session";
export const NO_TRACK_KEY = "povmatero-no-track";
const SESSION_IDLE_MS = 30 * 60 * 1000;
const FLUSH_DELAY_MS = 1500;

const queue = [];
let timer = null;

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function read(storage, key) {
  try { return JSON.parse(storage.getItem(key) ?? "null"); } catch { return null; }
}
function write(storage, key, value) {
  try { storage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
}

function disabled() {
  try {
    if (localStorage.getItem(NO_TRACK_KEY) === "1") return true;
  } catch { /* sin almacenamiento: se cuenta igual */ }
  return navigator.doNotTrack === "1" || window.doNotTrack === "1";
}

function visitorId() {
  let id = read(localStorage, VISITOR_KEY);
  if (typeof id !== "string") { id = uuid(); write(localStorage, VISITOR_KEY, id); }
  return id;
}

// Sesión: id, de dónde vino (sitio externo o campaña UTM) y última actividad.
function session() {
  const now = Date.now();
  let s = read(sessionStorage, SESSION_KEY);
  if (!s || typeof s.id !== "string" || now - (s.last ?? 0) > SESSION_IDLE_MS) {
    const params = new URLSearchParams(location.search);
    let referrer = null;
    try {
      const host = document.referrer ? new URL(document.referrer).host : "";
      if (host && host !== location.host) referrer = host.replace(/^www\./, "");
    } catch { /* referrer inválido */ }
    s = {
      id: uuid(),
      referrer_host: referrer,
      utm_source: params.get("utm_source"),
      utm_medium: params.get("utm_medium"),
      utm_campaign: params.get("utm_campaign"),
    };
  }
  s.last = now;
  write(sessionStorage, SESSION_KEY, s);
  return s;
}

function flush() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue.splice(0, 20) });
  try {
    // text/plain: se envía sin consulta previa del navegador y sobrevive al cerrar la pestaña.
    const sent = navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "text/plain" }));
    if (!sent) fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
  } catch { /* las estadísticas nunca rompen la tienda */ }
  if (queue.length) flush();
}

// event: "page_view" | "product_view" | "add_to_cart" | "begin_checkout"
export function track(event, { path = location.pathname, productId = null } = {}) {
  try {
    if (disabled()) return;
    const s = session();
    queue.push({
      event,
      visitor_id: visitorId(),
      session_id: s.id,
      path: String(path).split("?")[0].slice(0, 300) || "/",
      product_id: productId,
      referrer_host: s.referrer_host,
      utm_source: s.utm_source,
      utm_medium: s.utm_medium,
      utm_campaign: s.utm_campaign,
    });
    if (!timer) timer = setTimeout(flush, FLUSH_DELAY_MS);
  } catch { /* nada */ }
}

// Lo pendiente se envía al salir o al pasar a otra app.
addEventListener("pagehide", flush);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
