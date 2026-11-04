// Tarea programada (Vercel Cron, ver "crons" en vercel.json): mantenimiento
// de pedidos de yerbas, una vez por día.
//   * Pendiente hace 72 h → «Cancelado» («Cancelado por falta de respuesta»).
//   * Listo hace 24 h → «Entregado».
// Lo hace la base (public.run_order_maintenance, migración 20261112000000):
// es idempotente, así que correrla de más no duplica nada.
//
// La reserva de stock de un pendiente se libera exactamente a las 72 h aunque
// esta tarea corra más tarde (la base cuenta la reserva por expires_at); la
// tarea deja asentado el estado, el motivo y el historial.
//
// Seguridad: solo responde a Vercel Cron. Vercel manda
// «Authorization: Bearer <CRON_SECRET>» si existe la variable CRON_SECRET.
// Sin CRON_SECRET o sin SUPABASE_SECRET_KEY no hace nada (responde 503).
// Nunca devuelve datos de clientes: solo los números de pedido que cambió.

const SUPABASE_URL = "https://gubrehbalkfvzwsndbcv.supabase.co";
const TIMEOUT_MS = 15000;

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const secret = process.env.CRON_SECRET;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!secret || !key) {
    console.error("cron-pedidos: falta CRON_SECRET o SUPABASE_SECRET_KEY en Vercel.");
    res.statusCode = 503;
    return res.end();
  }
  if (!safeEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`)) {
    res.statusCode = 401;
    return res.end();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/run_order_maintenance`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      console.error(`cron-pedidos: Supabase respondió ${response.status}: ${text.slice(0, 300)}`);
      res.statusCode = 502;
      return res.end();
    }
    const data = JSON.parse(text || "{}");
    const result = {
      cancelados: Array.isArray(data.cancelados) ? data.cancelados.map(Number) : [],
      entregados: Array.isArray(data.entregados) ? data.entregados.map(Number) : [],
    };
    console.log(`cron-pedidos: ${result.cancelados.length} cancelados [${result.cancelados.join(", ")}], ${result.entregados.length} entregados [${result.entregados.join(", ")}]`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(result));
  } catch (err) {
    console.error("cron-pedidos: error", err?.name === "AbortError" ? "timeout" : err?.message);
    res.statusCode = 502;
    return res.end();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = handler;
module.exports.safeEqual = safeEqual;
