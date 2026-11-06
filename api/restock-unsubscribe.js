const { rpc } = require('./_lib/restock-email.js');
module.exports = async function handler(req,res,deps = {}) {
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const token = String(req.query?.token || '');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(token)) {
    res.statusCode=400; return res.end('Enlace inválido.');
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  if (req.method === 'GET') {
    // Link scanners cannot cancel a subscription merely by opening the email.
    res.statusCode=200;
    return res.end(`<!doctype html><html lang="es"><meta name="viewport" content="width=device-width"><title>Cancelar aviso · Povmatero</title><h1>Cancelar este aviso</h1><form method="post" action="?token=${token}"><button>Confirmar cancelación</button></form></html>`);
  }
  if (req.method !== 'POST') { res.statusCode=405; return res.end(); }
  if (!(deps.env || process.env).SUPABASE_SECRET_KEY) { res.statusCode=503; return res.end('Intentá más tarde.'); }
  try {
    await rpc('restock_email_unsubscribe',{p_token:token},deps);
    res.statusCode=200; return res.end('Aviso cancelado. Podés volver a suscribirte desde la tienda.');
  } catch { res.statusCode=502; return res.end('No pudimos cancelar el aviso. Intentá más tarde.'); }
};
