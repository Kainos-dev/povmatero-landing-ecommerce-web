// Prueba de api/cron-pedidos.js sin red (fetch simulado).
const path = require("path");
const handler = require(path.join(process.argv[2], "api/cron-pedidos.js"));
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
function call({ method = "GET", auth } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { resolve({ status: this.statusCode, body, headers: this.headers }); } };
    handler({ method, headers: auth ? { authorization: auth } : {} }, res);
  });
}
(async () => {
  const calls = [];
  let reply = { status: 200, body: JSON.stringify({ cancelados: [7, 9], entregados: [3], hora: "x" }) };
  global.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: reply.status < 400, status: reply.status, text: async () => reply.body }; };
  const log = console.log, err = console.error; const logs = [];
  console.error = (...a) => logs.push(a.join(" "));

  delete process.env.CRON_SECRET; delete process.env.SUPABASE_SECRET_KEY;
  check("sin variables → 503 y no llama a Supabase", (await call({ auth: "Bearer x" })).status === 503 && calls.length === 0);
  process.env.CRON_SECRET = "s3cret-largo-123"; process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
  check("POST → 405", (await call({ method: "POST", auth: "Bearer s3cret-largo-123" })).status === 405);
  check("sin Authorization → 401", (await call()).status === 401 && calls.length === 0);
  check("token incorrecto → 401", (await call({ auth: "Bearer otro" })).status === 401 && calls.length === 0);
  check("token de otro largo → 401", (await call({ auth: "Bearer s3cret-largo-1234" })).status === 401 && calls.length === 0);
  let r = await call({ auth: "Bearer s3cret-largo-123" });
  check("token correcto → 200 con los números cambiados", r.status === 200 && r.body === JSON.stringify({ cancelados: [7, 9], entregados: [3] }), r.body);
  check("llama a run_order_maintenance con la clave secreta (POST)", calls.length === 1 && calls[0].url.endsWith("/rest/v1/rpc/run_order_maintenance") && calls[0].opts.method === "POST" && calls[0].opts.headers.apikey === "sb_secret_test");
  check("no se guarda en caché", r.headers["cache-control"] === "no-store");
  reply = { status: 404, body: '{"code":"PGRST202"}' };
  r = await call({ auth: "Bearer s3cret-largo-123" });
  check("Supabase sin la función → 502 y lo registra en el log", r.status === 502 && logs.some((l) => l.includes("404")));
  global.fetch = async () => { throw new TypeError("network"); };
  check("sin red → 502", (await call({ auth: "Bearer s3cret-largo-123" })).status === 502);
  console.error = err;
  log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
