// Pruebas locales (PGlite) de 20261112000000_order_auto_cancel.sql:
// cancelación por falta de respuesta (72 h), migración de pedidos existentes,
// reservas, permisos, idempotencia y compatibilidad.
const { PGlite } = require(process.env.PW + "/node_modules/@electric-sql/pglite");
const fs = require("fs"), path = require("path");
const MIG = path.join(process.argv[2], "supabase/migrations");
const NEW = "20261112000000_order_auto_cancel.sql";
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];

let ok = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) ok++; else fail++;
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${!cond && detail ? "  → " + detail : ""}`);
}
const U = {
  ana:   { id: "11111111-1111-4111-8111-111111111111", email: "ana@test.com",   meta: { first_name: "Ana", phone: "11 4444-1234" } },
  beto:  { id: "22222222-2222-4222-8222-222222222222", email: "beto@test.com",  meta: { first_name: "Beto", phone: "11 5555-1234" } },
  admin: { id: "99999999-9999-4999-8999-999999999999", email: "admin@test.com", meta: {} },
};
const REASON = "Cancelado por falta de respuesta";

(async () => {
  const db = new PGlite();
  const q = (sql, params) => db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  async function as(user) {
    if (!user) { await db.exec("reset role"); await q("select set_config('request.jwt.claims', '', false)"); return; }
    if (user === "anon") { await db.exec("set role anon"); await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]); return; }
    if (user === "service") { await db.exec("set role service_role"); await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "service_role" })]); return; }
    await db.exec("set role authenticated");
    await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U[user].id, role: "authenticated" })]);
  }
  async function call(user, sql, params) {
    await as(user);
    try { const r = await q(sql, params); return { ok: true, rows: r.rows, val: r.rows[0] && Object.values(r.rows[0])[0] }; }
    catch (e) { return { ok: false, msg: e.message, hint: e.hint, code: e.code }; }
    finally { await as(null); }
  }
  const J = (x) => JSON.stringify(x);
  const yorder = (user, items) => call(user, "select public.create_yerba_order($1::jsonb, null) as r", [J(items)]);
  const setStatus = (user, id, s) => call(user, "select public.admin_set_order_status($1, $2) as r", [id, s]);
  const stock = async (v) => (await one("select stock from public.product_variants where id = $1", [v])).stock;
  const avail = async (v) => (await one("select stock from public.storefront_catalog where variant_id = $1", [v])).stock;
  const moves = async () => Number((await one("select count(*) n from public.inventory_movements")).n);
  const orderRow = (id) => one("select * from public.orders where id = $1", [id]);
  const events = async (id) => (await q("select * from public.order_events where order_id = $1 order by id", [id])).rows;
  const age = (id, hours) => q("update public.orders set created_at = now() - make_interval(hours => $2), expires_at = now() - make_interval(hours => $2) + interval '24 hours' where id = $1", [id, hours]);

  await db.exec(STUB);
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < NEW)) await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
  for (const u of Object.values(U)) await q("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [u.id, u.email, J(u.meta)]);
  await q("insert into public.admin_users (user_id, role) values ($1, 'owner')", [U.admin.id]);
  const yerbas = (await one("select id from public.categories where slug = 'yerbas'")).id;
  const mk = async (name, vname, price, st) => {
    const p = await one("insert into public.products (category_id, slug, name, is_active) values ($1, $2, $3, true) returning id", [yerbas, name.toLowerCase().replace(/\W+/g, "-") + "-" + vname, name]);
    const v = await one("insert into public.product_variants (product_id, name, price) values ($1, $2, $3) returning id", [p.id, vname, price]);
    if (st) await q("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga')", [v.id, st]);
    return Number(v.id);
  };
  const A = await mk("Canarias Suave", "1kg", 13900, 10), B = await mk("Sara Coco", "500gr", 8000, 10);

  // ---------- Pedidos antes de la migración ----------
  const id = async (r) => { if (!r.ok) throw new Error(r.msg); return Number(r.val.id); };
  const vigente = await id(await yorder("ana", [{ variant_id: A, quantity: 2 }]));        // 1 h
  const vencido30 = await id(await yorder("ana", [{ variant_id: A, quantity: 1 }]));      // 30 h: vencido (24 h)
  const vencido80 = await id(await yorder("beto", [{ variant_id: B, quantity: 1 }]));     // 80 h
  const listo = await id(await yorder("beto", [{ variant_id: B, quantity: 2 }]));
  const confirmado = await id(await yorder("beto", [{ variant_id: B, quantity: 1 }]));
  const cancelado = await id(await yorder("ana", [{ variant_id: B, quantity: 1 }]));
  check("antes: el pedido nuevo reserva 24 h (regla anterior)", Math.round((new Date((await orderRow(vigente)).expires_at) - new Date((await orderRow(vigente)).created_at)) / 3600e3) === 24);
  await setStatus("admin", listo, "listo");
  await setStatus("admin", confirmado, "confirmado");
  await setStatus("admin", cancelado, "cancelado");
  await age(vigente, 1); await age(vencido30, 30); await age(vencido80, 80);
  await q("update public.orders set created_at = now() - interval '100 hours' where id = any($1)", [[listo, confirmado, cancelado]]);
  check("antes: el de 30 h figura vencido (sin reserva)", !(await one("select private.order_commits_stock(status, expires_at) c from public.orders where id = $1", [vencido30])).c);
  const stockA0 = await stock(A), stockB0 = await stock(B), moves0 = await moves();
  const eventsBefore = Number((await one("select count(*) n from public.order_events")).n);

  // ---------- Migración ----------
  try { await db.exec(fs.readFileSync(path.join(MIG, NEW), "utf8")); check(`se aplica ${NEW}`, true); }
  catch (e) { check(`se aplica ${NEW}`, false, e.message); throw e; }

  let o = await orderRow(vigente);
  check("migración: pendiente vigente sigue pendiente", o.status === "pendiente");
  check("migración: su reserva pasa a 72 h desde la creación", Math.round((new Date(o.expires_at) - new Date(o.created_at)) / 3600e3) === 72);
  for (const [label, oid] of [["30 h", vencido30], ["80 h", vencido80]]) {
    o = await orderRow(oid);
    check(`migración: vencido de ${label} → cancelado con motivo`, o.status === "cancelado" && o.cancel_reason === REASON && o.auto_cancelled && o.cancelled_at, J(o));
    const ev = (await events(oid)).filter((e) => e.to_status === "cancelado");
    check(`migración: vencido de ${label} → un evento con motivo y marca de migración`, ev.length === 1 && ev[0].detail.migracion === true && ev[0].detail.motivo === REASON && ev[0].created_by === null, J(ev));
    check(`migración: vencido de ${label} conserva su historial anterior (creado)`, (await events(oid)).some((e) => e.event === "creado"));
  }
  check("migración: listo, confirmado y cancelado sin cambios", (await orderRow(listo)).status === "listo" && (await orderRow(confirmado)).status === "confirmado" && (await orderRow(cancelado)).status === "cancelado" && (await orderRow(cancelado)).cancel_reason === null);
  check("migración: no mueve stock ni registra movimientos", (await stock(A)) === stockA0 && (await stock(B)) === stockB0 && (await moves()) === moves0);
  check("migración: exactamente 2 eventos nuevos", Number((await one("select count(*) n from public.order_events")).n) === eventsBefore + 2);

  // ---------- Pedido nuevo: 72 h ----------
  const nuevo = await id(await yorder("ana", [{ variant_id: A, quantity: 1 }]));
  o = await orderRow(nuevo);
  check("nuevo pedido: reserva hasta creación + 72 h", Math.abs(new Date(o.expires_at) - new Date(o.created_at) - 72 * 3600e3) < 1000, `${o.created_at} → ${o.expires_at}`);
  check("nuevo pedido: reserva stock (disponible = físico − reservado)", (await avail(A)) === stockA0 - 2 - 1);

  // ---------- Reservas: se liberan a las 72 h aunque la tarea no haya corrido ----------
  await q("update public.orders set created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' where id = $1", [vigente]);
  check("72 h: la reserva se libera sola en el momento (antes de la tarea)", (await avail(A)) === stockA0 - 1);
  check("72 h: el stock físico no cambia", (await stock(A)) === stockA0);

  // ---------- Permisos ----------
  let r = await call("anon", "select * from public.cancel_unanswered_yerba_orders()");
  check("permisos: anon no puede ejecutar la cancelación", !r.ok, r.msg);
  r = await call("ana", "select * from public.cancel_unanswered_yerba_orders()");
  check("permisos: un cliente no puede ejecutar la cancelación", !r.ok, r.msg);
  r = await call("ana", "select public.run_order_maintenance()");
  check("permisos: un cliente no puede ejecutar el mantenimiento", !r.ok, r.msg);
  r = await call("ana", "select private.auto_cancel_orders(array[1::bigint])");
  check("permisos: la función privada no se puede llamar desde la API", !r.ok, r.msg);
  r = await call("ana", "update public.orders set status = 'cancelado' where id = $1", [nuevo]);
  check("permisos: un cliente no puede cambiar su pedido directo", !r.ok || (await orderRow(nuevo)).status === "pendiente");

  // ---------- Tarea (service_role = clave secreta de Vercel) ----------
  r = await call("service", "select public.run_order_maintenance() as r");
  check("tarea: service_role ejecuta el mantenimiento", r.ok, r.msg);
  check("tarea: cancela solo el pendiente de más de 72 h", r.ok && J(r.val.cancelados) === J([vigente]), J(r.val));
  o = await orderRow(vigente);
  check("tarea: queda cancelado con el motivo", o.status === "cancelado" && o.cancel_reason === REASON && o.auto_cancelled && !o.stock_applied);
  check("tarea: sin movimientos de stock y el físico igual", (await moves()) === moves0 && (await stock(A)) === stockA0);
  r = await call("service", "select public.run_order_maintenance() as r");
  check("tarea: segunda ejecución no cancela nada (idempotente)", r.ok && r.val.cancelados.length === 0);
  check("tarea: un solo evento de cancelación", (await events(vigente)).filter((e) => e.to_status === "cancelado").length === 1);
  check("tarea: el pedido nuevo (menos de 72 h) sigue pendiente", (await orderRow(nuevo)).status === "pendiente");
  check("tarea: confirmado viejo (ya atendido) no se cancela", (await orderRow(confirmado)).status === "confirmado");
  r = await call("admin", "select array_agg(x) a from public.cancel_unanswered_yerba_orders() x");
  check("tarea: un admin también puede ejecutarla", r.ok);

  // ---------- Panel: un pendiente vencido no se revive ----------
  const p2 = await id(await yorder("beto", [{ variant_id: A, quantity: 3 }]));
  await q("update public.orders set expires_at = now() - interval '1 minute' where id = $1", [p2]);
  const sA = await stock(A), m0 = await moves();
  r = await setStatus("admin", p2, "listo");
  check("panel: marcar listo un pendiente de 72 h → queda cancelado por falta de respuesta", r.ok && r.val.status === "cancelado" && r.val.auto_cancelled === true && r.val.cancel_reason === REASON, J(r));
  check("panel: no descuenta stock", (await stock(A)) === sA && (await moves()) === m0);
  r = await setStatus("admin", p2, "listo");
  check("panel: después no se puede pasar a listo (mensaje claro: auto_cancelled)", !r.ok && r.hint === "auto_cancelled" && /falta de respuesta/.test(r.msg), r.msg);
  check("panel: sigue un solo evento de cancelación", (await events(p2)).filter((e) => e.to_status === "cancelado").length === 1);

  const p3 = await id(await yorder("beto", [{ variant_id: A, quantity: 1 }]));
  await q("update public.orders set expires_at = now() - interval '1 minute' where id = $1", [p3]);
  r = await call("admin", "select public.admin_update_order_items($1, $2::jsonb) as r", [p3, J([{ variant_id: A, quantity: 2 }])]);
  check("panel: editar un pendiente de 72 h → se cancela, no se edita", r.ok && r.val.status === "cancelado" && r.val.items[0].quantity === 1, J(r));

  // Cancelar a mano: sin motivo automático, con hora.
  const p4 = await id(await yorder("beto", [{ variant_id: B, quantity: 1 }]));
  r = await setStatus("admin", p4, "cancelado");
  o = await orderRow(p4);
  check("panel: cancelar a mano guarda la hora, sin motivo automático", r.ok && o.status === "cancelado" && o.cancelled_at && !o.auto_cancelled && o.cancel_reason === null);

  // Un pendiente vigente se marca listo normalmente (descuenta una vez).
  const p5 = await id(await yorder("ana", [{ variant_id: B, quantity: 2 }]));
  const sB = await stock(B);
  r = await setStatus("admin", p5, "listo");
  check("panel: pendiente vigente → listo descuenta el stock una vez", r.ok && (await stock(B)) === sB - 2);
  await q("update public.orders set expires_at = now() - interval '5 days', created_at = now() - interval '6 days' where id = $1", [p5]);
  r = await call("service", "select public.run_order_maintenance() as r");
  check("tarea: un listo viejo nunca se cancela", (await orderRow(p5)).status !== "cancelado");
  r = await setStatus("admin", p5, "cancelado");
  check("panel: cancelar un listo devuelve el stock (una vez)", r.ok && (await stock(B)) === sB);
  r = await setStatus("admin", p5, "cancelado");
  check("panel: cancelar dos veces no devuelve dos veces", r.ok && (await stock(B)) === sB);

  // ---------- Entrega automática sigue igual ----------
  await q("update public.orders set ready_at = now() - interval '25 hours' where id = $1", [listo]);
  r = await call("service", "select public.run_order_maintenance() as r");
  check("tarea: también entrega los listos de 24 h", r.ok && r.val.entregados.includes(listo), J(r.val));

  // ---------- Cliente ----------
  r = await call("ana", "select id, status, cancel_reason from public.orders where id = $1", [vencido30]);
  check("cliente: ve el motivo de su pedido cancelado", r.ok && r.rows[0]?.cancel_reason === REASON, J(r));
  r = await call("beto", "select id from public.orders where id = $1", [vencido30]);
  check("cliente: no ve pedidos de otros", r.ok && r.rows.length === 0);
  r = await call("ana", "select * from public.order_events where order_id = $1", [vencido30]);
  check("cliente: no ve el historial interno", r.ok && r.rows.length === 0);

  // ---------- Límite de 3 pendientes: los cancelados no cuentan ----------
  for (let i = 0; i < 2; i++) await yorder("ana", [{ variant_id: B, quantity: 1 }]);
  r = await yorder("ana", [{ variant_id: B, quantity: 1 }]);
  check("cliente: con 3 pendientes vigentes no puede hacer un 4.º", !r.ok && r.hint === "too_many_pending", r.msg);

  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
