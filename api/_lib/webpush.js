// Web Push (RFC 8030) con cifrado aes128gcm (RFC 8291) y VAPID (RFC 8292),
// solo con el módulo crypto de Node: sin dependencias.
//
// Los archivos de api/ que empiezan con «_» no son funciones de Vercel: esto
// lo usan /api/push-send y /api/cron-pedidos.
//
// Claves VAPID (variables de entorno de Vercel, nunca en el navegador salvo la pública):
//   VAPID_PUBLIC_KEY   65 bytes (punto P-256 sin comprimir) en base64url
//   VAPID_PRIVATE_KEY  32 bytes en base64url
//   VAPID_SUBJECT      «mailto:…» o «https://…» (contacto para el servicio de push)
const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s ?? ""), "base64url");

// Servicios de push aceptados (mismo criterio que la base: private.valid_push_endpoint).
const PUSH_HOST = /^([a-z0-9-]+\.)*(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com)$/;
function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOST.test(u.hostname);
  } catch { return false; }
}

const pushEnabled = (env = process.env) => env.PUSH_ENABLED === "true";
function vapidKeys(env = process.env) {
  if (!pushEnabled(env)) return null;
  const publicKey = env.VAPID_PUBLIC_KEY, privateKey = env.VAPID_PRIVATE_KEY, subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  const pub = fromB64u(publicKey), priv = fromB64u(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || priv.length !== 32 || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  let key;
  try { key = crypto.createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: "jwk",
  }); } catch { return null; }
  return { publicKey, key, subject };
}

// JWT ES256 para «Authorization: vapid t=…, k=…». Vale 12 h.
function vapidJwt(audience, vapid, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: vapid.subject }));
  const data = `${header}.${claims}`;
  const sig = crypto.sign("sha256", Buffer.from(data), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64u(sig)}`;
}

// Cifra el contenido para un dispositivo (un solo registro, aes128gcm).
function encrypt(payload, p256dh, authSecret, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = fromB64u(p256dh), auth = fromB64u(authSecret);
  if (uaPublic.length !== 65 || auth.length < 16) throw new Error("bad_subscription_keys");
  const server = ecdh ?? crypto.createECDH("prime256v1");
  if (!ecdh) server.generateKeys();
  const asPublic = server.getPublicKey();
  const shared = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, auth, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // 0x02 = último registro
  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

// Clave corta para el encabezado Topic (el servicio reemplaza un aviso pendiente
// con el mismo Topic: otra protección contra duplicados).
const topicFor = (eventKey) => crypto.createHash("sha256").update(String(eventKey)).digest("base64url").slice(0, 32);

// Lo que viaja al dispositivo: solo lo necesario para mostrar la notificación.
function notificationPayload(p) {
  return JSON.stringify({
    title: String(p?.title ?? "Povmatero").slice(0, 80),
    body: String(p?.body ?? "").slice(0, 200),
    url: typeof p?.url === "string" && p.url.startsWith("/admin/") ? p.url : "/admin/",
    tag: String(p?.tag ?? "povmatero").slice(0, 64),
  });
}

// Envía un aviso. Devuelve { outcome: "enviado" | "vencida" | "reintentar" | "fallido", error? }.
async function sendOne(item, vapid, { fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  if (!validEndpoint(item.endpoint)) return { outcome: "fallido", error: "Servicio de push no permitido" };
  let body;
  try { body = encrypt(notificationPayload(item.payload), item.p256dh, item.auth); }
  catch { return { outcome: "fallido", error: "Claves del dispositivo inválidas" }; }
  const audience = new URL(item.endpoint).origin;
  const ttl = Math.max(60, Math.min(Number(item.payload?.ttl) || 86400, 2419200));
  try {
    const res = await timedRequest(signal => fetchImpl(item.endpoint, {
      method: "POST",
      headers: {
        Authorization: `vapid t=${vapidJwt(audience, vapid)}, k=${vapid.publicKey}`,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: item.payload?.urgency === "normal" ? "normal" : "high",
        Topic: topicFor(item.event_key),
      },
      body,
      signal,
      redirect: "error",
    }), timeoutMs);
    if (res.status >= 200 && res.status < 300) return { outcome: "enviado" };
    const error = `HTTP ${res.status}`;
    if (res.status === 404 || res.status === 410) return { outcome: "vencida", error };
    if (res.status === 429 || res.status >= 500) return { outcome: "reintentar", error };
    return { outcome: "fallido", error };
  } catch (err) {
    return { outcome: "reintentar", error: err?.name === "AbortError" ? "Sin respuesta" : "Error de red" };
  }
}

async function timedRequest(task, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(() => task(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
      }, Math.max(1, timeoutMs)); })]);
  } finally { clearTimeout(timer); }
}

// Procesa la cola: toma envíos (push_claim), los manda y devuelve el resultado
// (push_report). Repite hasta vaciarla o agotar el tiempo.
async function dispatch({ supabaseUrl, secretKey, vapid, fetchImpl = fetch, env = process.env,
  budgetMs = 20000, batch = 6, concurrency = 6, rpcTimeoutMs = 3000, sendTimeoutMs = 4000 }) {
  if (!pushEnabled(env) || !vapid || !secretKey) return { disabled: true };
  concurrency = Math.max(1, Math.min(6, Math.floor(concurrency) || 1));
  batch = Math.max(1, Math.min(concurrency, Math.floor(batch) || 1));
  rpcTimeoutMs = Math.max(10, Math.min(5000, rpcTimeoutMs));
  sendTimeoutMs = Math.max(10, Math.min(10000, sendTimeoutMs));
  const deadline = Date.now() + Math.max(0, Math.min(60000, budgetMs));
  const rpc = (name, args) => timedRequest(async signal => {
    const res = await fetchImpl(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal, redirect: "error",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }, Math.min(rpcTimeoutMs, Math.max(1, deadline - Date.now())));
  const totals = { enviado: 0, vencida: 0, reintentar: 0, fallido: 0 };
  for (let round = 0; round < 10 && deadline - Date.now() > 2 * rpcTimeoutMs + 10; round++) {
    const items = await rpc("push_claim", { p_limit: batch });
    if (!Array.isArray(items) || !items.length) break;
    const results = [];
    // One bounded wave per lease: reserve time for reporting every started send.
    await Promise.all(items.slice(0, batch).map(async item => {
        const remaining = deadline - Date.now() - rpcTimeoutMs;
        const r = remaining > 0
          ? await sendOne(item, vapid, { fetchImpl, timeoutMs: Math.min(sendTimeoutMs, remaining) })
          : { outcome: "reintentar", error: "Presupuesto de envío agotado" };
        totals[r.outcome]++;
        results.push({ id: item.id, outcome: r.outcome, error: r.error ?? null });
    }));
    await rpc("push_report", { results });
    if (items.length < batch) break;
  }
  return totals;
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

module.exports = { pushEnabled, vapidKeys, vapidJwt, encrypt, sendOne, dispatch, validEndpoint, notificationPayload, topicFor, safeEqual };
