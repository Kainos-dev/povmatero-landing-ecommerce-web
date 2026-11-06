// Clave pública VAPID para que el panel suscriba un dispositivo (es pública:
// el navegador la necesita para pedir la suscripción). La privada nunca sale
// de Vercel. 503 si todavía no se configuró.
const { vapidKeys } = require("./_lib/webpush.js");

function handler(req, res, deps = {}) {
  if (req.method !== "GET") {
    res.statusCode = 405;
    return res.end();
  }
  const vapid = vapidKeys(deps.env ?? process.env);
  if (!vapid) {
    res.setHeader("Cache-Control", "no-store");
    res.statusCode = 503;
    return res.end();
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.end(JSON.stringify({ publicKey: vapid.publicKey }));
}

module.exports = handler;
