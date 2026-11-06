// Envía las notificaciones pendientes a los administradores (Web Push).
//
// Lo llama la base de datos con pg_net apenas se registra un pedido (ver la
// migración 20261115000000_admin_push.sql), con
// «Authorization: Bearer <PUSH_WEBHOOK_SECRET>». No recibe datos: solo procesa
// la cola que la base ya anotó, así que llamarlo de más no duplica nada.
// La tarea diaria (/api/cron-pedidos) también procesa la cola (reintentos).
//
// Variables de entorno (Vercel): PUSH_WEBHOOK_SECRET, SUPABASE_SECRET_KEY,
// VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Si falta alguna, responde
// 503 y no hace nada. Nunca devuelve ni registra datos de clientes.
const { vapidKeys, dispatch, safeEqual } = require("./_lib/webpush.js");

const SUPABASE_URL = "https://gubrehbalkfvzwsndbcv.supabase.co";

async function handler(req, res, deps = {}) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end();
  }
  const env = deps.env ?? process.env;
  const secret = env.PUSH_WEBHOOK_SECRET, key = env.SUPABASE_SECRET_KEY;
  const vapid = vapidKeys(env);
  if (!secret || secret.length < 24 || !key || !vapid) {
    console.error("push-send: faltan PUSH_WEBHOOK_SECRET (24+ caracteres), SUPABASE_SECRET_KEY o las claves VAPID en Vercel.");
    res.statusCode = 503;
    return res.end();
  }
  if (!safeEqual(String(req.headers.authorization ?? ""), `Bearer ${secret}`)) {
    res.statusCode = 401;
    return res.end();
  }
  try {
    const totals = await dispatch({ supabaseUrl: deps.supabaseUrl ?? SUPABASE_URL, secretKey: key, vapid, env, fetchImpl: deps.fetchImpl ?? fetch });
    console.log(`push-send: ${totals.enviado} enviadas, ${totals.reintentar} para reintentar, ${totals.vencida} vencidas, ${totals.fallido} fallidas`);
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(totals));
  } catch (err) {
    console.error("push-send: error", String(err?.message ?? err).slice(0, 200));
    res.statusCode = 502;
    return res.end();
  }
}

module.exports = handler;
