// Web Push del servidor (api/_lib/webpush.js, api/push-send.js,
// api/push-config.js) sin red: fetch simulado. El cifrado se verifica
// descifrando con http_ece (implementación de referencia) y la firma VAPID con
// la clave pública; las claves se generan con web-push. No envía nada real.
const path = require("path"), crypto = require("crypto");
const ROOT = process.argv[2];
const PW = process.env.PW;
const webpush = require(require.resolve("web-push", { paths: [PW] }));
const ece = require(require.resolve("http_ece", { paths: [PW] }));
const lib = require(path.join(ROOT, "api/_lib/webpush.js"));
const pushSend = require(path.join(ROOT, "api/push-send.js"));
const pushConfig = require(path.join(ROOT, "api/push-config.js"));

let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };

// Dispositivo simulado: par de claves P-256 + secreto de autenticación.
function device(endpoint) {
  const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { endpoint, ecdh, p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") };
}
function decrypt(dev, body) {
  return ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: dev.ecdh, authSecret: dev.auth }).toString("utf8");
}
function verifyJwt(authHeader, publicKeyB64u, audience) {
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(authHeader ?? "");
  if (!m || m[2] !== publicKeyB64u) return false;
  const [h, c, s] = m[1].split(".");
  const pub = Buffer.from(publicKeyB64u, "base64url");
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const valid = crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  return valid && claims.aud === audience && claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600 && /^mailto:/.test(claims.sub);
}
function call(handler, { method = "POST", auth, deps } = {}) {
  return new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(body) { resolve({ status: this.statusCode, body, headers: this.headers }); } };
    Promise.resolve(handler({ method, headers: auth ? { authorization: auth } : {} }, res, deps));
  });
}

(async () => {
  const keys = webpush.generateVAPIDKeys();
  const env = { PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: "mailto:avisos@povmatero.test", SUPABASE_SECRET_KEY: "sb_secret_test", PUSH_WEBHOOK_SECRET: "x".repeat(40) };
  const vapid = lib.vapidKeys(env);
  check("claves VAPID de web-push se leen bien", !!vapid && vapid.publicKey === keys.publicKey);
  check("claves VAPID inválidas o incompletas → null", lib.vapidKeys({ ...env, VAPID_PRIVATE_KEY: "abc" }) === null && lib.vapidKeys({ ...env, VAPID_SUBJECT: "" }) === null && lib.vapidKeys({ ...env, VAPID_SUBJECT: "http://inseguro" }) === null);

  // Cifrado: http_ece (referencia) descifra lo que ciframos
  const dev = device("https://web.push.apple.com/QGabc123");
  const payload = JSON.stringify({ title: "Nuevo pedido de yerbas", body: "Ana P. · AP-003 · 2 paquetes · $22.600 ñ áé", url: "/admin/#/pedidos/12", tag: "pedido-12" });
  const body = lib.encrypt(payload, dev.p256dh, dev.auth);
  check("cifrado aes128gcm: la implementación de referencia lo descifra igual", decrypt(dev, body) === payload);
  const body2 = lib.encrypt(payload, dev.p256dh, dev.auth);
  check("cada envío usa sal y claves nuevas (cifrados distintos)", !body.equals(body2) && decrypt(dev, body2) === payload);
  const other = device("https://web.push.apple.com/QGother");
  let wrongKey = false; try { decrypt(other, body); } catch { wrongKey = true; }
  check("otro dispositivo no puede descifrarlo", wrongKey);
  // Y al revés: lo que cifra web-push lo descifra el mismo receptor (control del receptor simulado)
  const wpBody = webpush.encrypt(dev.p256dh, dev.auth, payload, "aes128gcm");
  check("control: lo cifrado por web-push también se descifra con el receptor simulado", decrypt(dev, wpBody.cipherText) === payload);

  // JWT VAPID
  const jwt = lib.vapidJwt("https://web.push.apple.com", vapid);
  check("JWT VAPID ES256 válido (firma, aud, exp ≤ 24 h, sub)", verifyJwt(`vapid t=${jwt}, k=${keys.publicKey}`, keys.publicKey, "https://web.push.apple.com"));

  // Endpoints permitidos
  check("solo servicios de push conocidos", lib.validEndpoint("https://web.push.apple.com/x") && lib.validEndpoint("https://fcm.googleapis.com/fcm/send/x") && lib.validEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x")
    && !lib.validEndpoint("https://evil.com/x") && !lib.validEndpoint("http://web.push.apple.com/x") && !lib.validEndpoint("https://web.push.apple.com:8443/x") && !lib.validEndpoint("https://push.apple.com.evil.com/x"));
  const np = JSON.parse(lib.notificationPayload({ title: "t", body: "b", url: "https://evil.com", tag: "x", phone: "11 5555", ttl: 9 }));
  check("el contenido solo lleva título, texto, enlace del panel y etiqueta", JSON.stringify(Object.keys(np)) === JSON.stringify(["title", "body", "url", "tag"]) && np.url === "/admin/");

  // sendOne contra un servicio simulado
  const seen = [];
  const service = (status) => async (url, opts) => { seen.push({ url, opts }); return { status }; };
  const item = { id: 1, event_key: "order:12", endpoint: dev.endpoint, p256dh: dev.p256dh, auth: dev.auth, payload: { title: "Nuevo pedido de yerbas", body: "Ana P. · AP-003", url: "/admin/#/pedidos/12", tag: "pedido-12", ttl: 86400, urgency: "high" } };
  const r201 = await lib.sendOne(item, vapid, { fetchImpl: service(201) });
  const h = seen[0].opts.headers;
  check("201 → enviado, con encabezados correctos", r201.outcome === "enviado" && h["Content-Encoding"] === "aes128gcm" && h.TTL === "86400" && h.Urgency === "high" && /^[A-Za-z0-9_-]{32}$/.test(h.Topic) && verifyJwt(h.Authorization, keys.publicKey, "https://web.push.apple.com"), JSON.stringify(h));
  const got = JSON.parse(decrypt(dev, seen[0].opts.body));
  check("el dispositivo recibe título, texto y enlace al pedido", got.title === "Nuevo pedido de yerbas" && got.body === "Ana P. · AP-003" && got.url === "/admin/#/pedidos/12" && got.tag === "pedido-12");
  check("410 → vencida; 404 → vencida", (await lib.sendOne(item, vapid, { fetchImpl: service(410) })).outcome === "vencida" && (await lib.sendOne(item, vapid, { fetchImpl: service(404) })).outcome === "vencida");
  check("429 / 503 → reintentar; 400 / 403 → fallido", (await lib.sendOne(item, vapid, { fetchImpl: service(429) })).outcome === "reintentar" && (await lib.sendOne(item, vapid, { fetchImpl: service(503) })).outcome === "reintentar"
    && (await lib.sendOne(item, vapid, { fetchImpl: service(400) })).outcome === "fallido" && (await lib.sendOne(item, vapid, { fetchImpl: service(403) })).outcome === "fallido");
  check("sin red → reintentar", (await lib.sendOne(item, vapid, { fetchImpl: async () => { throw new TypeError("fetch failed"); } })).outcome === "reintentar");
  const slow = await lib.sendOne(item, vapid, { timeoutMs: 50, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" })))) });
  check("sin respuesta (timeout) → reintentar", slow.outcome === "reintentar" && slow.error === "Sin respuesta");
  const nBefore = seen.length;
  check("endpoint no permitido → no se llama a nada", (await lib.sendOne({ ...item, endpoint: "https://evil.com/x" }, vapid, { fetchImpl: service(201) })).outcome === "fallido" && seen.length === nBefore);

  // dispatch: cola simulada (push_claim / push_report)
  const devs = [device("https://web.push.apple.com/QGd1"), device("https://fcm.googleapis.com/fcm/send/d2"), device("https://web.push.apple.com/QGgone")];
  let queue = devs.map((d, i) => ({ id: i + 1, event_key: "order:99", endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth, payload: item.payload }));
  const reports = [], pushed = [], rpcCalls = [];
  const fakeFetch = async (url, opts) => {
    if (url.includes("/rest/v1/rpc/")) {
      rpcCalls.push({ url, headers: opts.headers });
      if (url.endsWith("/push_claim")) { const out = queue; queue = []; return { ok: true, status: 200, text: async () => JSON.stringify(out) }; }
      if (url.endsWith("/push_report")) { reports.push(JSON.parse(opts.body).results); return { ok: true, status: 200, text: async () => String(JSON.parse(opts.body).results.length) }; }
    }
    pushed.push(url);
    return { status: url.includes("gone") ? 410 : 201 };
  };
  const totals = await lib.dispatch({ supabaseUrl: "https://sb.test", secretKey: "sb_secret_test", vapid, env, fetchImpl: fakeFetch });
  check("dispatch: envía a cada dispositivo y devuelve los resultados", totals.enviado === 2 && totals.vencida === 1 && pushed.length === 3 && reports.length === 1 && reports[0].length === 3, JSON.stringify(totals));
  check("dispatch: usa la clave secreta solo contra Supabase", rpcCalls.every((c) => c.headers.apikey === "sb_secret_test") && rpcCalls.length === 2 && !pushed.some((u) => u.includes("sb.test")));

  // /api/push-send
  check("push-send: GET → 405", (await call(pushSend, { method: "GET", deps: { env } })).status === 405);
  check("push-send: sin configuración → 503", (await call(pushSend, { auth: "Bearer " + env.PUSH_WEBHOOK_SECRET, deps: { env: { ...env, VAPID_PRIVATE_KEY: "" } } })).status === 503);
  check("push-send: secreto corto → 503 (no se acepta)", (await call(pushSend, { auth: "Bearer corto", deps: { env: { ...env, PUSH_WEBHOOK_SECRET: "corto" } } })).status === 503);
  check("push-send: sin clave o clave incorrecta → 401", (await call(pushSend, { deps: { env } })).status === 401 && (await call(pushSend, { auth: "Bearer " + "y".repeat(40), deps: { env } })).status === 401);
  queue = [{ id: 7, event_key: "order:5", endpoint: devs[0].endpoint, p256dh: devs[0].p256dh, auth: devs[0].auth, payload: item.payload }];
  const okSend = await call(pushSend, { auth: "Bearer " + env.PUSH_WEBHOOK_SECRET, deps: { env, fetchImpl: fakeFetch, supabaseUrl: "https://sb.test" } });
  check("push-send: con la clave → procesa la cola (200, solo totales)", okSend.status === 200 && JSON.parse(okSend.body).enviado === 1 && !/Ana|AP-|pedido/i.test(okSend.body) && okSend.headers["cache-control"] === "no-store", okSend.body);
  const errSend = await call(pushSend, { auth: "Bearer " + env.PUSH_WEBHOOK_SECRET, deps: { env, supabaseUrl: "https://sb.test", fetchImpl: async () => ({ ok: false, status: 500, text: async () => "x" }) } });
  check("push-send: Supabase con error → 502", errSend.status === 502);

  // /api/push-config
  const cfg = await call(pushConfig, { method: "GET", deps: { env } });
  check("push-config: devuelve solo la clave pública", cfg.status === 200 && JSON.stringify(Object.keys(JSON.parse(cfg.body))) === '["publicKey"]' && !cfg.body.includes(keys.privateKey));
  check("push-config: sin claves → 503", (await call(pushConfig, { method: "GET", deps: { env: {} } })).status === 503);

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
