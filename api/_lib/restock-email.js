const { safeEqual } = require('./webpush.js');
const SUPABASE_URL = 'https://gubrehbalkfvzwsndbcv.supabase.co';
function configured(env) {
  return env.RESTOCK_EMAIL_ENABLED === 'true' && env.RESEND_API_KEY && env.SUPABASE_SECRET_KEY
    && /^[a-zA-Z0-9._+-]+@povmatero\.com$/.test(env.RESTOCK_EMAIL_FROM || '');
}
async function rpc(name, args, { env = process.env, fetchImpl = fetch } = {}) {
  const baseUrl = (env.SUPABASE_URL || SUPABASE_URL).replace(/\/$/,'');
  const response = await fetchImpl(`${baseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`restock RPC ${name}: ${response.status}`);
  return response.json();
}
async function dispatch(deps = {}) {
  const deadline = Date.now() + 45000;
  const env = deps.env || process.env, fetchImpl = deps.fetchImpl || fetch;
  if (!configured(env)) return { disabled: true };
  const jobs = await rpc('restock_email_claim', { p_from: env.RESTOCK_EMAIL_FROM, p_limit: 5 }, deps);
  const counts = { sent: 0, retry: 0, failed: 0, skipped: 0 };
  for (const job of jobs) {
    // Leave enough time for check + provider + report within the 60s function budget.
    // Unprocessed leases expire safely; the next invocation reclaims them.
    if (Date.now() + 28000 > deadline) { counts.skipped++; continue; }
    if (!await rpc('restock_email_check', { p_id: job.id, p_token: job.token }, deps)) {
      counts.skipped++; continue;
    }
    let outcome = 'retry', providerId = null;
    try {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`,
          'Content-Type': 'application/json', 'Idempotency-Key': `restock-request/${job.id}` },
        body: JSON.stringify(job.payload), signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data.id === 'string' && data.id) { outcome = 'sent'; providerId = data.id; }
      } else if (res.status !== 429 && res.status !== 409 && res.status < 500) outcome = 'failed';
    } catch { /* unknown acceptance: retry with the same key and frozen payload */ }
    await rpc('restock_email_report', {
      p_id: job.id, p_token: job.token, p_outcome: outcome, p_provider_id: providerId,
    }, deps);
    counts[outcome]++;
  }
  return counts;
}
module.exports = { configured, rpc, dispatch, safeEqual };
