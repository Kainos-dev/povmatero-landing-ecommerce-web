// 20261114 (reserva de 12 h, códigos públicos, pedidos sin duplicados) y
// 20261115 (Web Push de administradores, avisos de reposición). PGlite en
// memoria: nunca toca Supabase. Aplica las migraciones anteriores, carga datos
// y pedidos con las reglas de hoy y recién ahí aplica las nuevas.
const { PGlite } = require(process.env.PW + "/node_modules/@electric-sql/pglite");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const FIRST_NEW = "20261114000000_order_codes_12h.sql";
const PUSH = "20261115000000_admin_push.sql";
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];

const U = {
  ana:    { id: "11111111-1111-4111-8111-111111111111", meta: { first_name: "Ana", last_name: "Pérez", phone: "11 4444-1234" } },
  beto:   { id: "22222222-2222-4222-8222-222222222222", meta: { first_name: "Beto", last_name: "Gómez", phone: "11 5555-1234" } },
  agus:   { id: "33333333-3333-4333-8333-333333333333", meta: { first_name: "Agustín", last_name: "Acevedo", phone: "11 6666-1234" } },
  anto:   { id: "44444444-4444-4444-8444-444444444444", meta: { first_name: "Antonella", last_name: "Arce", phone: "11 7777-1234" } },
  nadie:  { id: "55555555-5555-4555-8555-555555555555", meta: { phone: "11 8888-1234" } },
  nandu:  { id: "66666666-6666-4666-8666-666666666666", meta: { first_name: "  ñandú", last_name: "Íñiguez", phone: "11 9999-1234" } },
  admin:  { id: "99999999-9999-4999-8999-999999999999", meta: {} },
  admin2: { id: "88888888-8888-4888-8888-888888888888", meta: {} },
};

let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const J = (x) => JSON.stringify(x);
const APPLE = (k) => `https://web.push.apple.com/QG${k}abcdefghijklmnopqrstuvwxyz0123456789`;
const P256 = "B" + "x".repeat(86);    // 87 caracteres base64url
const AUTH = "a".repeat(22);

(async () => {
  const db = new PGlite();
  const q = (sql, p) => db.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  async function as(user) {
    if (!user) { await db.exec("reset role"); await q("select set_config('request.jwt.claims', '', false)"); return; }
    if (user === "anon") { await db.exec("set role anon"); await q("select set_config('request.jwt.claims', $1, false)", [J({ role: "anon" })]); return; }
    if (user === "service") { await db.exec("set role service_role"); await q("select set_config('request.jwt.claims', $1, false)", [J({ role: "service_role" })]); return; }
    await db.exec("set role authenticated");
    await q("select set_config('request.jwt.claims', $1, false)", [J({ sub: U[user].id, role: "authenticated" })]);
  }
  async function call(user, sql, p) {
    await as(user);
    try { const r = await q(sql, p); return { ok: true, rows: r.rows, val: r.rows[0] && Object.values(r.rows[0])[0] }; }
    catch (e) { return { ok: false, msg: e.message, hint: e.hint, code: e.code }; }
    finally { await as(null); }
  }
  const yorder = (user, items, key = null) => call(user, "select public.create_yerba_order($1::jsonb, null, $2::uuid) as r", [J(items), key]);
  const yorderOld = (user, items) => call(user, "select public.create_yerba_order($1::jsonb, null) as r", [J(items)]);
  const setStatus = (user, id, s) => call(user, "select public.admin_set_order_status($1, $2) as r", [id, s]);
  const stock = async (v) => (await one("select stock from public.product_variants where id = $1", [v])).stock;
  const avail = async (v) => (await one("select stock from public.storefront_catalog where variant_id = $1", [v])).stock;
  const moves = async (v) => Number((await one("select count(*) n from public.inventory_movements where variant_id = $1", [v])).n);
  const orderRow = (id) => one("select * from public.orders where id = $1", [id]);
  const events = async (kind) => (await q("select * from private.push_events where kind = $1 order by id", [kind])).rows;
  const hours = (o) => Math.round((new Date(o.expires_at) - new Date(o.created_at)) / 3600000);

  // ---------- Esquema hasta hoy ----------
  await db.exec(STUB);
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < FIRST_NEW)) await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
  for (const [k, u] of Object.entries(U)) await q("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [u.id, k + "@test.com", J(u.meta)]);
  await q("insert into public.admin_users (user_id, role) values ($1, 'owner'), ($2, 'admin')", [U.admin.id, U.admin2.id]);
  const cat = async (slug) => (await one("select id from public.categories where slug = $1", [slug])).id;
  const Y = await cat("yerbas"), MATES = await cat("mates");
  const V = {}, P = {};
  let n = 0;
  for (const [name, catId, variants] of [
    ["Canarias Serena", Y, [["500gr", 5600, 0], ["1kg", 11600, 6]]],
    ["Sara Coco", Y, [["500gr", 8000, 1]]],
    ["Baldo", Y, [["1kg", 11300, 50]]],
    ["Rei Verde", Y, [["1kg", 9000, 2]]],
    ["Mate Imperial", MATES, [["Único", 30000, 4]]],
  ]) {
    const p = await one("insert into public.products (category_id, slug, name, is_active) values ($1, $2, $3, true) returning id", [catId, `p-${++n}`, name]);
    P[name] = p.id;
    for (const [vn, price, st] of variants) {
      const v = await one("insert into public.product_variants (product_id, name, price) values ($1, $2, $3) returning id", [p.id, vn, price]);
      V[`${name}|${vn}`] = v.id;
      if (st) await q("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga inicial')", [v.id, st]);
    }
  }
  const C500 = V["Canarias Serena|500gr"], C1 = V["Canarias Serena|1kg"], SARA = V["Sara Coco|500gr"], BALDO = V["Baldo|1kg"], REI = V["Rei Verde|1kg"];

  // Pedidos ANTES de la migración (reglas de hoy: 72 h)
  const old1 = (await yorderOld("ana", [{ variant_id: BALDO, quantity: 1 }])).val;
  await q("update public.orders set created_at = now() - interval '3 days' where id = $1", [old1.id]);
  for (const st of ["listo", "entregado"]) await setStatus("admin", old1.id, st);
  const oldTienda = await call("ana", "select public.create_order($1::jsonb) as r", [J([{ product_id: P["Mate Imperial"], variant: null, quantity: 1 }])]);
  await q("update public.orders set created_at = now() - interval '2 days' where id = $1", [oldTienda.val.id]);
  const oldPending = (await yorderOld("ana", [{ variant_id: BALDO, quantity: 2 }])).val;
  const sale = await call("admin", "select public.admin_create_sale($1::jsonb, null, 'Cliente de mostrador', null, null) as r", [J([{ variant_id: BALDO, quantity: 1 }])]);
  check("antes: pedidos de prueba con las reglas de hoy", !!old1?.id && oldTienda.ok && !!oldPending?.id && sale.ok, J([oldTienda.msg, sale.msg]));
  const oldPendingRow0 = await orderRow(oldPending.id);
  check("antes: un pendiente reserva 72 h", hours(oldPendingRow0) === 72, String(hours(oldPendingRow0)));
  const baldoPhys0 = await stock(BALDO);

  // ---------- 20261114 ----------
  await db.exec(fs.readFileSync(path.join(MIG, FIRST_NEW), "utf8"));

  // Históricos
  const anaCodes = (await q("select id, public_code, customer_seq from public.orders where customer_id = $1 order by created_at, id", [U.ana.id])).rows;
  check("históricos: Ana numerada por fecha (AP-001, AP-002, AP-003)", J(anaCodes.map((r) => r.public_code)) === J(["AP-001", "AP-002", "AP-003"]), J(anaCodes));
  check("históricos: venta sin cuenta no tiene código", (await orderRow(sale.val.id)).public_code === null);
  const oldPendingRow = await orderRow(oldPending.id);
  check("pendiente existente: conserva su vencimiento (72 h), sin tocar", hours(oldPendingRow) === 72 && new Date(oldPendingRow.expires_at).getTime() === new Date(oldPendingRow0.expires_at).getTime());
  check("migración: no cambia stock físico", (await stock(BALDO)) === baldoPhys0);
  check("contador de Ana = 3", (await one("select last_seq from private.order_counters where customer_id = $1", [U.ana.id])).last_seq === 3);

  // Reserva de 12 h
  const sAvail0 = await avail(C1), sPhys0 = await stock(C1), sMoves0 = await moves(C1);
  const o1 = await yorder("agus", [{ variant_id: C1, quantity: 2 }]);
  const o1row = o1.ok ? await orderRow(o1.val.id) : null;
  check("nuevo pedido: reserva exactamente 12 h (hora de la base)", o1.ok && new Date(o1row.expires_at) - new Date(o1row.created_at) === 12 * 3600000, o1.msg);
  check("nuevo pedido: AA-001 para Agustín Acevedo", o1.val?.public_code === "AA-001" && o1row.public_code === "AA-001", J(o1.val));
  check("nuevo pedido: lo disponible baja en el momento", (await avail(C1)) === sAvail0 - 2);
  check("nuevo pedido: el stock físico no cambia ni hay movimientos por la reserva", (await stock(C1)) === sPhys0 && (await moves(C1)) === sMoves0);
  const oldCall = await yorderOld("agus", [{ variant_id: BALDO, quantity: 1 }]);
  check("la tienda publicada (sin client_key) sigue funcionando → AA-002", oldCall.ok && oldCall.val.public_code === "AA-002", oldCall.msg);
  check("Antonella Arce tiene su propio número (AA-001: mismas iniciales, otra cuenta)", (await yorder("anto", [{ variant_id: BALDO, quantity: 1 }])).val?.public_code === "AA-001");
  check("sin nombre ni apellido → XX-001", (await yorder("nadie", [{ variant_id: BALDO, quantity: 1 }])).val?.public_code === "XX-001");
  check("ñ, acentos y espacios → NI-001", (await yorder("nandu", [{ variant_id: BALDO, quantity: 1 }])).val?.public_code === "NI-001");

  // Vence a las 12 h: libera exactamente lo reservado, una sola vez
  await q("update public.orders set created_at = now() - interval '12 hours 1 second', expires_at = now() - interval '1 second' where id = $1", [o1.val.id]);
  check("vencido: lo disponible vuelve solo, sin esperar la tarea", (await avail(C1)) === sAvail0);
  const m1 = await call("admin", "select public.run_order_maintenance() as r");
  const m2 = await call("admin", "select public.run_order_maintenance() as r");
  const o1after = await orderRow(o1.val.id);
  check("tarea: cancela por falta de respuesta una sola vez", m1.ok && m1.val.cancelados.map(Number).includes(Number(o1.val.id)) && m2.ok && !m2.val.cancelados.map(Number).includes(Number(o1.val.id)) && o1after.status === "cancelado", J([m1.val, m2.val, m1.msg]));
  const evCancel = (await q("select detail from public.order_events where order_id = $1 and to_status = 'cancelado'", [o1.val.id])).rows;
  check("historial: un solo evento, con «horas: 12»", evCancel.length === 1 && Number(evCancel[0].detail.horas) === 12, J(evCancel));
  check("cancelar no mueve stock físico ni devuelve dos veces", (await stock(C1)) === sPhys0 && (await moves(C1)) === sMoves0 && (await avail(C1)) === sAvail0);
  check("el pendiente viejo (72 h) no se canceló", (await orderRow(oldPending.id)).status === "pendiente");

  // Cancelación manual
  const o2 = (await yorder("beto", [{ variant_id: C1, quantity: 3 }])).val;
  check("cancelar a mano: reservado", (await avail(C1)) === sAvail0 - 3);
  await setStatus("admin", o2.id, "cancelado");
  const again = await setStatus("admin", o2.id, "cancelado");
  check("cancelar a mano: libera exactamente 3, repetir no cambia nada", again.ok && (await avail(C1)) === sAvail0 && (await moves(C1)) === sMoves0);

  // Listo → entregado → (cancelar desde listo)
  const o3 = (await yorder("beto", [{ variant_id: C1, quantity: 2 }])).val;
  await setStatus("admin", o3.id, "listo");
  await setStatus("admin", o3.id, "listo");
  check("listo: una sola salida física (repetir no duplica)", (await stock(C1)) === sPhys0 - 2 && (await moves(C1)) === sMoves0 + 1 && (await avail(C1)) === sAvail0 - 2);
  await setStatus("admin", o3.id, "entregado");
  check("entregado: no vuelve a descontar", (await stock(C1)) === sPhys0 - 2 && (await moves(C1)) === sMoves0 + 1);
  const o4 = (await yorder("beto", [{ variant_id: C1, quantity: 1 }])).val;
  await setStatus("admin", o4.id, "listo");
  await setStatus("admin", o4.id, "cancelado");
  await setStatus("admin", o4.id, "cancelado");
  const net4 = Number((await one("select coalesce(sum(quantity),0) s from public.inventory_movements where order_id = $1", [o4.id])).s);
  check("cancelar desde listo: devuelve lo descontado una sola vez (neto 0)", net4 === 0 && (await stock(C1)) === sPhys0 - 2);
  const consistency = await one(`select bool_and(v.stock = coalesce(m.s, 0)) ok from public.product_variants v
                                   left join (select variant_id, sum(quantity) s from public.inventory_movements group by 1) m on m.variant_id = v.id`);
  check("consistencia: stock físico = suma de movimientos en todas las presentaciones", consistency.ok === true);

  // client_key: sin duplicados
  const KEY = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const k1 = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }], KEY);
  const k2 = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }], KEY);
  const countKey = Number((await one("select count(*) n from public.orders where client_key = $1", [KEY])).n);
  check("misma clave: devuelve el mismo pedido («repeated»), no crea otro", k1.ok && k2.ok && k2.val.repeated === true && k2.val.id === k1.val.id && k2.val.public_code === k1.val.public_code && countKey === 1, J([k1.msg, k2.val]));
  const k3 = await yorder("ana", [{ variant_id: BALDO, quantity: 1 }], KEY);
  check("la clave de otra cuenta se rechaza (no devuelve el pedido ajeno)", !k3.ok && k3.hint === "invalid_key" && !/BG-/.test(k3.msg), J(k3));

  // Última unidad
  const lastA = await yorder("ana", [{ variant_id: SARA, quantity: 1 }]);
  const seqBefore = (await one("select last_seq from private.order_counters where customer_id = $1", [U.beto.id])).last_seq;
  const lastB = await yorder("beto", [{ variant_id: SARA, quantity: 1 }]);
  const seqAfter = (await one("select last_seq from private.order_counters where customer_id = $1", [U.beto.id])).last_seq;
  check("última unidad: el segundo recibe «insufficient_stock» con lo disponible", lastA.ok && !lastB.ok && lastB.hint === "insufficient_stock" && /quedan 0/.test(lastB.msg), J(lastB));
  check("un pedido rechazado no consume número del cliente", seqAfter === seqBefore);

  // Código inmutable y cambio de nombre
  const anaOrder = lastA.val;
  const upd = await call(null, "update public.orders set public_code = 'ZZ-999' where id = $1", [anaOrder.id]).catch((e) => ({ ok: false }));
  const updDirect = await (async () => { try { await q("update public.orders set public_code = 'ZZ-999' where id = $1", [anaOrder.id]); return { ok: true }; } catch (e) { return { ok: false, hint: e.hint }; } })();
  check("el código no se puede cambiar (ni con permisos de dueño)", !updDirect.ok && updDirect.hint === "code_immutable", J([upd, updDirect]));
  await q("update public.customer_profiles set first_name = 'Zoe', last_name = 'Zapata' where user_id = $1", [U.ana.id]);
  const anaCodes2 = (await q("select public_code from public.orders where customer_id = $1 order by customer_seq", [U.ana.id])).rows.map((r) => r.public_code);
  const anaNext = await yorder("ana", [{ variant_id: BALDO, quantity: 1 }]);
  check("cambiar el nombre no recalcula los códigos anteriores", anaCodes2[0] === "AP-001" && anaCodes2.at(-1) === "AP-004", J(anaCodes2));
  check("el siguiente pedido usa el nombre nuevo y sigue la numeración (ZZ-005)", anaNext.val?.public_code === "ZZ-005", J(anaNext));
  await q("update private.order_counters set last_seq = 999 where customer_id = $1", [U.nadie.id]);
  check("del 999 pasa a 1000 sin cortar el número", (await yorder("nadie", [{ variant_id: BALDO, quantity: 1 }])).val?.public_code === "XX-1000");

  // Vincular venta sin cuenta
  const link = await call("admin", "select public.admin_link_order_customer($1, $2) as r", [sale.val.id, U.beto.id]);
  const saleRow = await orderRow(sale.val.id);
  check("vincular una venta sin cuenta le asigna el siguiente código del cliente", link.ok && /^BG-\d{3}$/.test(saleRow.public_code ?? ""), J([link.msg, saleRow.public_code]));

  // RLS
  const anaSees = await call("ana", "select count(*)::int n from public.orders where public_code = 'BG-001'");
  const betoSees = await call("beto", "select count(*)::int n from public.orders where public_code = 'BG-001'");
  const anonSees = await call("anon", "select count(*)::int n from public.orders");
  check("RLS: un código ajeno no devuelve el pedido", anaSees.ok && anaSees.val === 0 && betoSees.val === 1, J([anaSees, betoSees]));
  check("RLS: sin sesión no se leen pedidos", !anonSees.ok || anonSees.val === 0);
  const counters = await call("ana", "select count(*) from private.order_counters");
  check("los contadores no son accesibles por la API", !counters.ok);

  // ---------- 20261115 ----------
  await db.exec(fs.readFileSync(path.join(MIG, PUSH), "utf8"));

  // Suscripciones
  const s1 = await call("admin", "select public.admin_push_subscribe($1, $2, $3, 'iPhone') as r", [APPLE("one"), P256, AUTH]);
  const s1b = await call("admin", "select public.admin_push_subscribe($1, $2, $3, 'iPhone 17') as r", [APPLE("one"), P256, AUTH]);
  const s2 = await call("admin", "select public.admin_push_subscribe($1, $2, $3, 'Mac') as r", ["https://fcm.googleapis.com/fcm/send/abcdefghijklmnop", P256, AUTH]);
  const subsCount = Number((await one("select count(*) n from public.admin_push_subscriptions where user_id = $1", [U.admin.id])).n);
  check("admin: suscribe dos dispositivos; repetir el mismo no duplica", s1.ok && s1b.ok && s2.ok && subsCount === 2, J([s1.msg, s2.msg]));
  const bad = await call("admin", "select public.admin_push_subscribe($1, $2, $3) as r", ["https://evil.example.com/push/abcdefghijklmnop", P256, AUTH]);
  const badHttp = await call("admin", "select public.admin_push_subscribe($1, $2, $3) as r", ["http://web.push.apple.com/abcdefghijklmnopq", P256, AUTH]);
  const badKey = await call("admin", "select public.admin_push_subscribe($1, $2, $3) as r", [APPLE("two"), "corto", AUTH]);
  check("rechaza endpoints de otros servicios, sin https o claves inválidas", bad.hint === "invalid_subscription" && badHttp.hint === "invalid_subscription" && badKey.hint === "invalid_subscription");
  const cust = await call("ana", "select public.admin_push_subscribe($1, $2, $3) as r", [APPLE("ana"), P256, AUTH]);
  const anonSub = await call("anon", "select public.admin_push_subscribe($1, $2, $3) as r", [APPLE("anon"), P256, AUTH]);
  check("un cliente o anónimo no puede suscribirse", !cust.ok && cust.hint === "admin_only" && !anonSub.ok);
  const own = await call("admin", "select count(*)::int n from public.admin_push_subscriptions");
  const other = await call("admin2", "select count(*)::int n from public.admin_push_subscriptions");
  const keys = await call("admin", "select p256dh from public.admin_push_subscriptions");
  check("RLS: cada admin ve solo sus dispositivos; las claves no se leen por la API", own.val === 2 && other.val === 0 && !keys.ok, J([own, other, keys.msg]));
  const unsubOther = await call("admin2", "select public.admin_push_unsubscribe($1) as r", [APPLE("one")]);
  check("otro admin no puede quitar un dispositivo ajeno", unsubOther.ok && unsubOther.val === false && subsCount === 2);
  const stolen = await call("admin2", "select public.admin_push_subscribe($1, $2, $3, 'otro') as r", [APPLE("shared"), P256, AUTH]);
  check("admin2 suscribe su dispositivo", stolen.ok);

  // Evento de pedido nuevo
  const sendQ = await call("service", "select public.push_claim(50) as r");     // vacía lo anterior (no hay eventos)
  const ord = await yorder("beto", [{ variant_id: BALDO, quantity: 2 }]);
  const evs = await events("pedido");
  const ev = evs.find((e) => e.event_key === "order:" + ord.val.id);
  check("pedido nuevo → un evento con nombre corto, código, cantidad y total", !!ev && ev.payload.title === "Nuevo pedido de yerbas" && ev.payload.body === `Beto G. · ${ord.val.public_code} · 2 paquetes · $22.600` && ev.payload.url === "/admin/#/pedidos/" + ord.val.id, J(ev?.payload));
  check("la notificación no lleva teléfono ni email", !/5555|@/.test(J(ev?.payload)));
  const tiendaNew = await call("beto", "select public.create_order($1::jsonb) as r", [J([{ product_id: P["Mate Imperial"], variant: null, quantity: 1 }])]);
  check("pedido de la tienda → evento «Nuevo pedido»", tiendaNew.ok && (await events("pedido")).some((e) => e.event_key === "order:" + tiendaNew.val.id && e.payload.title === "Nuevo pedido"));
  const failed = await yorder("beto", [{ variant_id: SARA, quantity: 1 }]);
  check("un pedido rechazado no deja evento", !failed.ok && (await events("pedido")).length === evs.length + 1);
  await call("admin", "select public.admin_create_sale($1::jsonb, null, 'Mostrador', null, null) as r", [J([{ variant_id: BALDO, quantity: 1 }])]);
  check("una venta presencial (la carga el admin) no notifica", (await events("pedido")).length === evs.length + 1);

  // Envío
  const denied = await call("admin", "select public.push_claim(50) as r");
  check("push_claim no lo puede ejecutar un administrador (solo el servidor)", !denied.ok);
  const c1 = await call("service", "select public.push_claim(50) as r");
  const c1rows = c1.val ?? [];
  const forOrder = c1rows.filter((r) => r.event_key === "order:" + ord.val.id);
  check("servidor: un envío por dispositivo de cada admin (3)", c1.ok && forOrder.length === 3 && forOrder.every((r) => r.p256dh && r.auth && r.endpoint), J(c1.msg ?? c1rows.map((r) => r.event_key)));
  const c2 = await call("service", "select public.push_claim(50) as r");
  check("tomarlos de nuevo no devuelve nada (sin duplicados)", c2.ok && c2.val.length === 0, J(c2.val?.length));
  const [dOk, dGone, dRetry] = forOrder;
  const rep = await call("service", "select public.push_report($1::jsonb) as r", [J([{ id: dOk.id, outcome: "enviado" }, { id: dGone.id, outcome: "vencida", error: "410 Gone" }, { id: dRetry.id, outcome: "reintentar", error: "503" }])]);
  const rep2 = await call("service", "select public.push_report($1::jsonb) as r", [J([{ id: dOk.id, outcome: "fallido" }])]);
  const dRows = Object.fromEntries((await q("select id, status, next_attempt_at from private.push_deliveries")).rows.map((r) => [r.id, r]));
  check("resultado: enviado / vencida / reintentar; repetir no cambia nada", rep.val === 3 && rep2.val === 0 && dRows[dOk.id].status === "enviado" && dRows[dGone.id].status === "vencida" && dRows[dRetry.id].status === "pendiente" && new Date(dRows[dRetry.id].next_attempt_at) > new Date(), J(dRows));
  const goneSub = await one("select s.disabled_at from public.admin_push_subscriptions s join private.push_deliveries d on d.subscription_id = s.id where d.id = $1", [dGone.id]);
  check("suscripción vencida (410) queda desactivada", goneSub.disabled_at !== null);
  check("un reintento no sale antes de tiempo", (await call("service", "select public.push_claim(50) as r")).val.length === 0);
  await q("update private.push_deliveries set next_attempt_at = now() - interval '1 second' where id = $1", [dRetry.id]);
  const c3 = await call("service", "select public.push_claim(50) as r");
  check("llegado el momento, se reintenta (intento 2)", c3.val.length === 1 && c3.val[0].id === dRetry.id && c3.val[0].attempt === 2);
  await q("update private.push_deliveries set lease_until = now() - interval '1 second' where id = $1", [dRetry.id]);
  const c4 = await call("service", "select public.push_claim(50) as r");
  check("si el servidor se cae a mitad (plazo vencido), otro lo retoma", c4.val.length === 1 && c4.val[0].attempt === 3);
  await q("update private.push_deliveries set attempts = 5 where id = $1", [dRetry.id]);
  await call("service", "select public.push_report($1::jsonb) as r", [J([{ id: dRetry.id, outcome: "reintentar" }])]);
  check("después de 5 intentos queda «fallido»", (await one("select status from private.push_deliveries where id = $1", [dRetry.id])).status === "fallido");

  // Dispositivo nuevo no recibe eventos viejos; admin dado de baja no recibe
  await q("update private.push_events set created_at = now() - interval '1 minute'");
  await call("admin", "select public.admin_push_subscribe($1, $2, $3, 'iPad') as r", [APPLE("ipad"), P256, AUTH]);
  await q("delete from public.admin_users where user_id = $1", [U.admin2.id]);
  const ord2 = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }]);
  const c5 = (await call("service", "select public.push_claim(50) as r")).val;
  check("el pedido nuevo va al iPad nuevo y a la Mac; no a un admin dado de baja", c5.filter((r) => r.event_key === "order:" + ord2.val.id).length === 2 && !c5.some((r) => r.event_key !== "order:" + ord2.val.id), J(c5.map((r) => [r.event_key, r.endpoint.slice(0, 30)])));
  await call("service", "select public.push_report($1::jsonb) as r", [J(c5.map((r) => ({ id: r.id, outcome: "enviado" })))]);

  // Prueba
  const t1 = await call("admin", "select public.admin_push_test() as r");
  const t2 = await call("admin", "select public.admin_push_test() as r");
  const tc = (await call("service", "select public.push_claim(50) as r")).val;
  check("prueba: solo a los dispositivos propios, una por minuto", t1.ok && t1.val.devices === 2 && t2.hint === "rate_limit" && tc.length === 2 && tc.every((r) => r.event_key.startsWith("test:")), J([t1, t2.hint, tc.length]));
  await call("service", "select public.push_report($1::jsonb) as r", [J(tc.map((r) => ({ id: r.id, outcome: "enviado" })))]);
  const t3 = await call("admin2", "select public.admin_push_test() as r");
  check("prueba sin ser admin: rechazada", !t3.ok && t3.hint === "admin_only");

  // Avisos de reposición
  const restock0 = (await events("reposicion")).length;
  const ask1 = await call("beto", "select public.request_restock_alert($1) as r", [C500]);
  const ask2 = await call("ana", "select public.request_restock_alert($1) as r", [C500]);
  check("avisos: dos clientes piden aviso de una presentación agotada", ask1.ok && ask2.ok, J([ask1.msg, ask2.msg]));
  await call("admin", "select public.admin_stock_movement($1::uuid, $2, 'entrada', 2, 'reposición') as r", ["bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb", C500]);
  const rs = await events("reposicion");
  check("entrada de stock → un evento «Volvió el stock» con 2 clientes", rs.length === restock0 + 1 && rs.at(-1).payload.body === "Canarias Serena 500gr · 2 clientes esperan el aviso", J(rs.at(-1)?.payload));
  await call("admin", "select public.admin_stock_movement($1::uuid, $2, 'entrada', 1, 'otra') as r", ["bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb", C500]);
  check("otra entrada con los mismos clientes esperando → sin aviso duplicado", (await events("reposicion")).length === restock0 + 1);
  // Cancelación que libera la última unidad
  const reiAll = await yorder("agus", [{ variant_id: REI, quantity: 2 }]);
  const askRei = await call("beto", "select public.request_restock_alert($1) as r", [REI]);
  check("Rei Verde: reservado todo (disponible 0) y un cliente pide aviso", reiAll.ok && (await avail(REI)) === 0 && askRei.ok, J([reiAll.msg, askRei.msg]));
  await setStatus("admin", reiAll.val.id, "cancelado");
  const rsRei = (await events("reposicion")).filter((e) => e.event_key.startsWith("restock:" + REI + ":"));
  check("cancelar el pedido libera stock → aviso de reposición (misma lógica que una entrada)", rsRei.length === 1 && (await avail(REI)) === 2);
  // Vencimiento
  const reiAgain = await yorder("agus", [{ variant_id: REI, quantity: 2 }]);
  await call("admin", "select public.admin_mark_restock_notified(array(select id from public.restock_requests where variant_id = $1 and status = 'activa')) as r", [REI]);
  const askRei2 = await call("ana", "select public.request_restock_alert($1) as r", [REI]);
  await q("update public.orders set expires_at = now() - interval '1 second' where id = $1", [reiAgain.val.id]);
  const mm = await call("service", "select public.run_order_maintenance() as r");
  const rsRei2 = (await events("reposicion")).filter((e) => e.event_key.startsWith("restock:" + REI + ":"));
  check("reserva vencida → la tarea genera el aviso (una vez)", askRei2.ok && mm.ok && mm.val.avisos_reposicion >= 1 && rsRei2.length === 2, J([askRei2.msg, mm.val, mm.msg]));
  await call("service", "select public.run_order_maintenance() as r");
  check("correr la tarea otra vez no duplica avisos", (await events("reposicion")).filter((e) => e.event_key.startsWith("restock:" + REI + ":")).length === 2);
  const rsNotDue = (await events("reposicion")).filter((e) => e.event_key.startsWith("restock:" + SARA + ":"));
  check("sin stock disponible no hay aviso", rsNotDue.length === 0);

  // pg_net + Vault (simulados): un solo aviso al servidor por transacción, nunca bloquea
  await db.exec(`
    create schema net; create schema vault;
    create table net.calls (id serial, url text, headers jsonb);
    create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000)
      returns bigint language plpgsql as $$ begin
        if current_setting('test.net_fail', true) = 'on' then raise exception 'red caída'; end if;
        insert into net.calls (url, headers) values (url, headers); return 1; end $$;
    create table vault.secrets_t (name text, decrypted_secret text);
    create view vault.decrypted_secrets as select * from vault.secrets_t;`);
  const calls = async () => Number((await one("select count(*) n from net.calls")).n);
  const clearPending = async () => { for (const r of (await q("select id from public.orders where customer_id = $1 and status = 'pendiente'", [U.beto.id])).rows) await setStatus("admin", r.id, "cancelado"); };
  await clearPending();
  const noSecret = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }]);
  check("sin secretos en Vault: el pedido se crea y no se llama al servidor", noSecret.ok && (await calls()) === 0);
  await q("insert into vault.secrets_t values ('povmatero_push_url', 'https://povmatero.test/api/push-send'), ('povmatero_push_secret', 's3cret')");
  await clearPending();
  const withSecret = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }]);
  const lastCall = await one("select * from net.calls order by id desc limit 1");
  check("con secretos: un aviso al servidor, con la clave en el encabezado", withSecret.ok && (await calls()) === 1 && lastCall.url === "https://povmatero.test/api/push-send" && lastCall.headers.Authorization === "Bearer s3cret");
  await clearPending();
  await q("select set_config('test.net_fail', 'on', false)");
  const netDown = await yorder("beto", [{ variant_id: BALDO, quantity: 1 }]);
  await q("select set_config('test.net_fail', 'off', false)");
  check("si pg_net falla, el pedido igual se registra (y el evento queda en la cola)", netDown.ok && (await events("pedido")).some((e) => e.event_key === "order:" + netDown.val.id));
  // Dos pedidos en una transacción → un solo aviso
  await clearPending();
  const before2 = await calls();
  await as("beto");
  await q("begin");
  await q("select public.create_yerba_order($1::jsonb, null, null)", [J([{ variant_id: BALDO, quantity: 1 }])]);
  await q("select public.create_order($1::jsonb)", [J([{ product_id: P["Mate Imperial"], variant: null, quantity: 1 }])]);
  await q("commit");
  await as(null);
  check("varios eventos en una transacción → un solo aviso al servidor", (await calls()) === before2 + 1);

  // Quitar dispositivos
  const subs = (await call("admin", "select id, endpoint from public.admin_push_subscriptions order by id")).rows;
  const rm = await call("admin", "select public.admin_push_remove($1) as r", [subs[0].id]);
  const un = await call("admin", "select public.admin_push_unsubscribe($1) as r", [subs[1].endpoint]);
  check("el admin quita sus dispositivos", rm.val === true && un.val === true);

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
