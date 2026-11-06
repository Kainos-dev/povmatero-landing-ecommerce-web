const { configured, dispatch, safeEqual } = require('./_lib/restock-email.js');
module.exports = async function handler(req, res, deps = {}) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET','POST'].includes(req.method)) { res.statusCode=405; return res.end(); }
  const env = deps.env || process.env;
  if (!configured(env) || !env.CRON_SECRET || env.CRON_SECRET.length < 24) { res.statusCode=503; return res.end(); }
  if (!safeEqual(req.headers.authorization || '', `Bearer ${env.CRON_SECRET}`)) { res.statusCode=401; return res.end(); }
  try {
    const totals = await dispatch(deps);
    res.setHeader('Content-Type','application/json'); res.statusCode=200;
    return res.end(JSON.stringify(totals));
  } catch { res.statusCode=502; return res.end(); }
};
