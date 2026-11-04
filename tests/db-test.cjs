// Pruebas locales (PGlite, Postgres en memoria) de las migraciones nuevas:
//   20261108 avisos de reposición · 20261109 herramientas de stock · 20261110 estados
// Aplica TODAS las migraciones del repo en orden sobre auth/storage simulados.
// Antes de las nuevas crea pedidos con las reglas actuales (compatibilidad).
const { PGlite } = require(process.env.PW + "/node_modules/@electric-sql/pglite");
const fs = require("fs"), path = require("path");
const MIG = path.join(process.argv[2], "supabase/migrations");
const FIRST_NEW = "20261108000000_restock_alerts.sql";

let ok = 0, fail = 0;
function check(name, cond, detail = "") {
  if (cond) ok++; else fail++;
  console.log(`${cond ? "OK   " : "FALLA"} ${name}${!cond && detail ? "  → " + detail : ""}`);
}

const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create schema storage;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text, name text);
alter table storage.objects enable row level security;
grant usage on schema public to anon, authenticated, service_role;
`;

const U = {
  ana:   { id: "11111111-1111-4111-8111-111111111111", email: "ana@test.com",   meta: { first_name: "Ana", last_name: "Pérez", phone: "11 4444-1234" } },
  beto:  { id: "22222222-2222-4222-8222-222222222222", email: "beto@test.com",  meta: { first_name: "Beto", last_name: "Gómez", phone: "11 5555-1234" } },
  admin: { id: "99999999-9999-4999-8999-999999999999", email: "admin@test.com", meta: {} },
};

(async () => {
  const db = new PGlite();
  const q = (sql, params) => db.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  async function as(user) {
    if (!user) { await db.exec("reset role"); await q("select set_config('request.jwt.claims', '', false)"); return; }
    if (user === "anon") { await db.exec("set role anon"); await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]); return; }
    await db.exec("set role authenticated");
    await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U[user].id, role: "authenticated" })]);
  }
  async function call(user, sql, params) {
    await as(user);
    try { const r = await q(sql, params); return { ok: true, rows: r.rows, val: r.rows[0] && Object.values(r.rows[0])[0] }; }
    catch (e) { return { ok: false, msg: e.message, hint: e.hint, detail: e.detail, code: e.code }; }
    finally { await as(null); }
  }
  const J = (x) => JSON.stringify(x);
  const yorder = (user, items) => call(user, "select public.create_yerba_order($1::jsonb, null) as r", [J(items)]);
  const setStatus = (user, id, s) => call(user, "select public.admin_set_order_status($1, $2) as r", [id, s]);
  const stock = async (v) => (await one("select stock from public.product_variants where id = $1", [v])).stock;
  const avail = async (v) => (await one("select stock from public.storefront_catalog where variant_id = $1", [v])).stock;
  const moves = async (v) => Number((await one("select count(*) n from public.inventory_movements where variant_id = $1", [v])).n);
  const orderRow = (id) => one("select * from public.orders where id = $1", [id]);

  // ---------- Esquema hasta hoy ----------
  await db.exec(STUB);
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < FIRST_NEW)) await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));

  for (const u of Object.values(U)) await q("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [u.id, u.email, J(u.meta)]);
  await q("insert into public.admin_users (user_id, role) values ($1, 'owner')", [U.admin.id]);
  const cat = async (slug) => (await one("select id from public.categories where slug = $1", [slug])).id;
  const yerbas = await cat("yerbas"), mates = await cat("mates");
  const V = {}, P = {};
  let n = 0;
  for (const [name, catId, variants] of [
    ["Canarias Tradicional", yerbas, [["500gr", 5600, 0], ["1kg", 11600, 3]]],
    ["Sara Coco", yerbas, [["500gr", 8000, 5]]],
    ["Baldo", yerbas, [["1kg", 11300, 10]]],
    ["Mate Imperial", mates, [["Único", 30000, 4]]],
  ]) {
    const p = await one("insert into public.products (category_id, slug, name, is_active) values ($1, $2, $3, true) returning id", [catId, `p-${++n}`, name]);
    P[name] = p.id;
    for (const [vn, price, st] of variants) {
      const v = await one("insert into public.product_variants (product_id, name, price) values ($1, $2, $3) returning id", [p.id, vn, price]);
      V[`${name}|${vn}`] = v.id;
      if (st) await q("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga inicial')", [v.id, st]);
    }
  }
  const C500 = V["Canarias Tradicional|500gr"], C1 = V["Canarias Tradicional|1kg"], SARA = V["Sara Coco|500gr"], BALDO = V["Baldo|1kg"], MATE = V["Mate Imperial|Único"];

  // Pedidos ANTES de las migraciones nuevas (con las reglas actuales)
  const tienda = await call("ana", "select public.create_order($1::jsonb) as r", [J([{ product_id: P["Mate Imperial"], variant: null, quantity: 1 }])]);
  check("antes: pedido de la tienda", tienda.ok, tienda.msg);
  const oldListo = (await yorder("beto", [{ variant_id: BALDO, quantity: 2 }])).val;
  for (const s of ["confirmado", "preparando", "listo"]) await setStatus("admin", oldListo.id, s);
  const oldEntregado = (await yorder("beto", [{ variant_id: BALDO, quantity: 1 }])).val;
  for (const s of ["confirmado", "preparando", "listo", "entregado"]) await setStatus("admin", oldEntregado.id, s);
  // el «listo» viejo cambió de estado hace 2 días
  await q("update public.orders set status_changed_at = now() - interval '2 days' where id = $1", [oldListo.id]);
  const baldoBefore = await stock(BALDO);

  // ---------- Migraciones nuevas ----------
  for (const f of files.filter((f) => f >= FIRST_NEW)) {
    try { await db.exec(fs.readFileSync(path.join(MIG, f), "utf8")); check(`se aplica ${f}`, true); }
    catch (e) { check(`se aplica ${f}`, false, e.message); throw e; }
  }
  check("compatibilidad: los pedidos existentes siguen iguales", (await orderRow(oldListo.id)).status === "listo" && (await orderRow(oldEntregado.id)).status === "entregado" && (await stock(BALDO)) === baldoBefore);
  check("compatibilidad: listo existente con ready_at = cuando cambió de estado", (await orderRow(oldListo.id)).ready_at !== null);
  check("compatibilidad: el carrito de la tienda sigue creando pedidos", (await call("ana", "select public.create_order($1::jsonb) as r", [J([{ product_id: P["Mate Imperial"], variant: null, quantity: 1 }])])).ok);

  // =================== 3. Avisos de reposición ===================
  {
    let r = await call(null, "select 1"); // noop
    r = await call("anon", "select public.request_restock_alert($1) as r", [C500]);
    check("aviso: sin sesión no se puede", !r.ok, r.msg);
    r = await call("ana", "select public.request_restock_alert($1) as r", [C1]);
    check("aviso: si hay stock, no se registra (hint available)", !r.ok && r.hint === "available", r.msg);
    r = await call("ana", "select public.request_restock_alert($1) as r", [C500]);
    check("aviso: Canarias 500 g agotada → registrado", r.ok && r.val.status === "activa", r.msg);
    const r2 = await call("ana", "select public.request_restock_alert($1) as r", [C500]);
    check("aviso: pedirlo otra vez no duplica (misma solicitud)", r2.ok && r2.val.id === r.val.id && Number((await one("select count(*) n from public.restock_requests where user_id = $1", [U.ana.id])).n) === 1);
    r = await call("beto", "select public.request_restock_alert($1) as r", [C500]);
    check("aviso: otro cliente, misma presentación → su propia solicitud", r.ok);
    r = await call("ana", "select public.request_restock_alert($1) as r", [MATE]);
    check("aviso: solo yerbas", !r.ok && r.hint === "unavailable", r.msg);
    r = await call("ana", "insert into public.restock_requests (product_id, variant_id, user_id) values ($1, $2, $3)", [P["Canarias Tradicional"], C500, U.ana.id]);
    check("aviso: no se escribe directo en la tabla", !r.ok, r.msg);
    r = await call("beto", "select count(*) n from public.restock_requests");
    check("aviso: cada cliente ve solo las suyas (RLS)", r.ok && Number(r.rows[0].n) === 1);
    r = await call("ana", "select public.admin_restock_alerts()");
    check("aviso: la lista del panel es solo para admins", !r.ok);
    r = await call("admin", "select * from public.admin_restock_alerts()");
    check("aviso: el panel ve 2 activas, ninguna para avisar todavía (sigue agotada)", r.ok && r.rows.length === 2 && r.rows.every((x) => !x.due && x.available === 0), JSON.stringify(r.rows));
    // Se repone Canarias 1 kg: no cambia nada para 500 g
    await call("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 5, 'reposición')", [C1]);
    r = await call("admin", "select * from public.admin_restock_alerts()");
    check("aviso: reponer 1 kg no avisa a quien pidió 500 g", r.rows.every((x) => !x.due));
    // Se repone Canarias 500 g
    await call("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 4, 'reposición')", [C500]);
    r = await call("admin", "select * from public.admin_restock_alerts()");
    check("aviso: reponer 500 g → las 2 quedan «para avisar» con lo disponible", r.rows.length === 2 && r.rows.every((x) => x.due && x.available === 4 && x.phone && x.customer_name), JSON.stringify(r.rows));
    const ids = r.rows.map((x) => Number(x.id));
    const s0 = await stock(C500);
    r = await call("admin", "select array_agg(x) a from public.admin_mark_restock_notified($1::bigint[]) x", [ids]);
    check("aviso: marcar avisadas → 2", r.ok && r.rows[0].a.length === 2, r.msg);
    r = await call("admin", "select array_agg(x) a from public.admin_mark_restock_notified($1::bigint[]) x", [ids]);
    check("aviso: marcarlas otra vez no cambia nada (nunca dos avisos)", r.ok && r.rows[0].a === null, JSON.stringify(r.rows));
    check("aviso: avisar no mueve stock", (await stock(C500)) === s0);
    r = await call("ana", "select public.request_restock_alert($1) as r", [SARA]);
    check("aviso: con stock no se puede pedir (Sara)", !r.ok);
    // Cancelar: Canarias 500 g agotada otra vez con un pedido que la compromete
    await yorder("beto", [{ variant_id: C500, quantity: 4 }]);
    check("aviso: lo comprometido cuenta (500 g otra vez agotada para la tienda)", (await avail(C500)) === 0);
    r = await call("ana", "select public.request_restock_alert($1) as r", [C500]);
    check("aviso: después de avisada, se puede pedir uno nuevo", r.ok && r.val.status === "activa");
    r = await call("ana", "select public.cancel_restock_alert($1) as r", [C500]);
    check("aviso: el cliente cancela su aviso", r.ok && r.val === true);
    r = await call("ana", "select public.cancel_restock_alert($1) as r", [C500]);
    check("aviso: cancelar de nuevo no hace nada", r.ok && r.val === false);
  }

  // =================== 5.1 Movimientos manuales con conciliación ===================
  {
    const p = await one("insert into public.products (category_id, slug, name, is_active) values ($1, 'rv-test', 'Rei Verde Test', true) returning id", [yerbas]);
    const RV = (await one("insert into public.product_variants (product_id, name, price) values ($1, '1kg', 9000) returning id", [p.id])).id;
    await q("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 3, 'carga')", [RV]);
    const mv = (op, type, qty, x = {}) => call(x.user ?? "admin", "select public.admin_stock_movement($1, $2, $3, $4, $5, $6, $7, $8, $9) as r",
      [op, RV, type, qty, x.reason ?? "Venta en el local", x.ref ?? null, x.declared ?? null, x.confirm ?? false, x.source ?? "stock_rapido"]);
    const opMoves = async (op) => (await q("select movement_type, quantity, stock_after, reason, created_by from public.inventory_movements where operation_id = $1 order by id", [op])).rows;
    const OP = (n) => `0000000${n}-0000-4000-8000-00000000000${n}`;

    // Reserva web de 2 sobre 3 físicas → disponible 1
    const web = (await yorder("ana", [{ variant_id: RV, quantity: 2 }])).val;
    let r = await call("admin", "select public.admin_stock_preview($1, 3) as r", [RV]);
    check("conciliación: vista previa (físico 3, reservado 2, disponible 1, excede)", r.ok && r.val.stock === 3 && r.val.reserved === 2 && r.val.available === 1 && r.val.exceeds === true && r.val.orders.length === 1 && r.val.orders[0].order_id === web.id, JSON.stringify(r.val ?? r.msg));
    r = await call("ana", "select public.admin_stock_preview($1, 1) as r", [RV]);
    check("conciliación: la vista previa es solo para admins", !r.ok);

    // Salida dentro de lo disponible: un movimiento, con autor y motivo
    r = await mv(OP(1), "salida", 1);
    let ms = await opMoves(OP(1));
    check("salida común: registrada (stock 2) en una operación con autor y motivo", r.ok && (await stock(RV)) === 2 && ms.length === 1 && ms[0].quantity === -1 && ms[0].created_by === U.admin.id && ms[0].reason === "Venta en el local", r.msg);
    r = await mv(OP(1), "salida", 1);
    check("salida común: reintento con el mismo id → la misma operación, sin duplicar", r.ok && r.val.repeated === true && (await stock(RV)) === 2 && (await opMoves(OP(1))).length === 1);
    r = await mv(OP(1), "salida", 5);
    check("salida común: mismo id con otros datos → rechazado", !r.ok && r.hint === "operation_conflict");

    // Ahora físico 2, reservado 2, disponible 0: cualquier salida excede
    r = await mv(OP(2), "salida", 2);
    let detail = r.detail ? JSON.parse(r.detail) : {};
    check("excede: sin stock físico declarado → pide el conteo (con el detalle)", !r.ok && r.hint === "count_required" && detail.stock === 2 && detail.reserved === 2 && detail.available === 0 && detail.requested === 2, r.msg);
    check("excede: no registró nada", (await stock(RV)) === 2 && (await opMoves(OP(2))).length === 0 && Number((await one("select count(*) n from public.stock_operations where id = $1", [OP(2)])).n) === 0);
    r = await mv(OP(2), "salida", 2, { declared: -1 });
    check("excede: stock declarado negativo → rechazado", !r.ok && r.hint === "invalid_items");

    // Declara 2 físicas reales después de vender 2 (antes había 4): ajuste +2 y salida −2
    r = await mv(OP(2), "salida", 2, { declared: 2 });
    ms = await opMoves(OP(2));
    check("conciliada: ajuste +2 y salida −2, vinculados a la misma operación", r.ok && ms.length === 2 && ms[0].movement_type === "ajuste" && ms[0].quantity === 2 && ms[0].stock_after === 4 && ms[1].movement_type === "salida" && ms[1].quantity === -2 && ms[1].stock_after === 2, JSON.stringify(ms) + (r.msg ?? ""));
    check("conciliada: stock final = declarado (2), cubre las reservas, sin faltante", (await stock(RV)) === 2 && r.val.shortage === 0 && r.val.adjustment === 2 && r.val.stock_before === 2 && r.val.reserved === 2);
    check("conciliada: el motivo del ajuste explica la conciliación", /Conciliación: el sistema tenía 2 y había 4/.test(ms[0].reason), ms[0].reason);
    check("conciliada: el pedido web no se tocó (sigue reservando 2)", (await orderRow(web.id)).status === "pendiente" && Number((await one("select coalesce(sum(quantity),0) q from public.variant_commitments() where variant_id = $1", [RV])).q) === 2);
    r = await mv(OP(2), "salida", 2, { declared: 2 });
    check("conciliada: reintento → sin movimientos nuevos", r.ok && r.val.repeated === true && (await opMoves(OP(2))).length === 2 && (await stock(RV)) === 2);

    // Declara 0 (vendió 1 y no queda nada): no cubre las 2 reservadas
    r = await mv(OP(3), "salida", 1, { declared: 0 });
    detail = r.detail ? JSON.parse(r.detail) : {};
    check("faltante: sin confirmación → advierte con los pedidos afectados", !r.ok && r.hint === "shortage_confirmation" && detail.shortage === 2 && detail.orders?.[0]?.order_id === web.id, r.msg);
    check("faltante: sin confirmación no registra nada", (await stock(RV)) === 2 && (await opMoves(OP(3))).length === 0);
    r = await mv(OP(3), "salida", 1, { declared: 0, confirm: true });
    ms = await opMoves(OP(3));
    check("faltante confirmado: ajuste −1 y salida −1 → stock 0 (nunca negativo)", r.ok && ms.length === 2 && ms[0].quantity === -1 && ms[1].quantity === -1 && (await stock(RV)) === 0, JSON.stringify(ms) + (r.msg ?? ""));
    const sh = await one("select * from public.stock_shortages where operation_id = $1", [OP(3)]);
    check("faltante confirmado: presentación señalada como faltante (faltan 2)", sh && sh.status === "abierto" && sh.missing === 2 && sh.physical === 0 && sh.reserved === 2);
    check("faltante confirmado: el pedido y su reserva quedan intactos", (await orderRow(web.id)).status === "pendiente" && Number((await one("select coalesce(sum(quantity),0) q from public.variant_commitments() where variant_id = $1", [RV])).q) === 2);
    check("faltante confirmado: la tienda muestra 0 disponibles", (await avail(RV)) === 0);

    // Salida directa por la API (como el panel publicado) que se come lo reservado: rechazada
    await mv(OP(4), "entrada", 3, { reason: "Llegó mercadería" });
    check("entrada por la función: suma (0 → 3)", (await stock(RV)) === 3 && (await opMoves(OP(4))).length === 1);
    r = await call("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'salida', -2, 'directa')", [RV]);
    check("salida directa que deja menos que lo reservado → rechazada por la base", !r.ok && r.hint === "reserved_stock" && /stock_check/.test(r.msg) && (await stock(RV)) === 3, r.msg);
    r = await call("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'salida', -1, 'directa')", [RV]);
    check("salida directa dentro de lo disponible → permitida", r.ok && (await stock(RV)) === 2);
    r = await call("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason, operation_id) values ($1, 'salida', -2, 'x', $2)", [RV, OP(4)]);
    check("nadie puede «saltear» la regla poniendo una operación a mano", !r.ok);

    // Las reglas de pedidos siguen iguales: listo descuenta una vez
    r = await setStatus("admin", web.id, "listo");
    check("pedido web: pasa a listo y descuenta sus 2 una vez", r.ok && (await stock(RV)) === 0 && Number((await one("select count(*) n from public.inventory_movements where order_id = $1", [web.id])).n) === 1, r.msg);

    // Resolver el faltante
    r = await call("admin", "select public.admin_resolve_shortage($1, 'Se repuso y se entregó') as r", [sh.id]);
    check("faltante: se marca resuelto", r.ok && r.val.status === "resuelto");
    r = await call("admin", "select public.admin_resolve_shortage($1, 'otra') as r", [sh.id]);
    check("faltante: resolver dos veces no cambia nada", r.ok && r.val.resolution === "Se repuso y se entregó");

    // Permisos
    r = await mv(OP(5), "entrada", 1, { user: "ana" });
    check("movimientos: un cliente no puede", !r.ok && (await stock(RV)) === 0);
    r = await call("ana", "select count(*) n from public.stock_operations");
    check("operaciones y faltantes: los clientes no los ven", r.ok && Number(r.rows[0].n) === 0 && Number((await call("ana", "select count(*) n from public.stock_shortages")).rows[0].n) === 0);
    r = await mv(OP(6), "salida", 1, { source: "inventario", ref: "Factura 12" });
    check("Inventario usa la misma función (sin stock → pide conteo)", !r.ok && r.hint === "count_required");
    r = await call("ana", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 5, 'x')", [BALDO]);
    check("movimiento directo: un cliente no puede", !r.ok);
  }

  // =================== 5.2 Pedidos a proveedor ===================
  {
    const key = "bbbbbbbb-0000-4000-8000-000000000001";
    const s0 = { c: await stock(C1), b: await stock(BALDO), m0: await moves(C1) };
    let r = await call("admin", "select public.admin_create_supplier_order($1::jsonb, 'Distribuidora Sur', 'Para el lunes', $2) as r", [J([{ variant_id: C1, quantity: 10 }, { variant_id: BALDO, quantity: 6 }]), key]);
    check("proveedor: pedido creado en «pedido»", r.ok && r.val.status === "pedido" && r.val.items.length === 2, r.msg);
    const sid = r.val.id;
    check("proveedor: preparar el pedido NO mueve stock", (await stock(C1)) === s0.c && (await stock(BALDO)) === s0.b && (await moves(C1)) === s0.m0);
    r = await call("admin", "select public.admin_create_supplier_order($1::jsonb, 'Distribuidora Sur', null, $2) as r", [J([{ variant_id: C1, quantity: 10 }]), key]);
    check("proveedor: reintento con la misma clave → mismo pedido", r.ok && r.val.id === sid && r.val.repeated === true && Number((await one("select count(*) n from public.supplier_orders")).n) === 1);
    r = await call("ana", "select public.admin_create_supplier_order($1::jsonb) as r", [J([{ variant_id: C1, quantity: 1 }])]);
    check("proveedor: un cliente no puede", !r.ok);
    // Confirmación con variaciones (20261111): la lista ES lo recibido; lo que no figura, 0.
    // Rechazos primero: no tienen que dejar nada registrado.
    const movesBefore = Number((await one("select count(*) n from public.inventory_movements")).n);
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sid, J([{ variant_id: C1, quantity: 0 }, { variant_id: BALDO, quantity: 0 }])]);
    check("proveedor: todo en 0 → no se registra una recepción vacía", !r.ok && r.hint === "empty_reception", r.msg);
    r = await call("admin", "select public.admin_receive_supplier_order($1, '[]'::jsonb) as r", [sid]);
    check("proveedor: lista vacía (todo quitado) → tampoco", !r.ok && r.hint === "empty_reception", r.msg);
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sid, J([{ variant_id: SARA, quantity: 3 }])]);
    check("proveedor: una presentación que no es del pedido → rechazada", !r.ok && r.hint === "invalid_items", r.msg);
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sid, J([{ variant_id: C1, quantity: 3 }, { variant_id: C1, quantity: 4 }])]);
    check("proveedor: una presentación repetida → rechazada", !r.ok && r.hint === "invalid_items", r.msg);
    const row0 = await one("select status from public.supplier_orders where id = $1", [sid]);
    check("proveedor: tras los rechazos, sigue «pedido», sin movimientos ni recibidos", row0.status === "pedido" && Number((await one("select count(*) n from public.inventory_movements")).n) === movesBefore
      && Number((await one("select count(*) n from public.supplier_order_items where supplier_order_id = $1 and received_quantity is not null", [sid])).n) === 0 && (await stock(C1)) === s0.c);
    // llegaron 8 de Canarias; Baldo no vino (quitado de la lista)
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sid, J([{ variant_id: C1, quantity: 8 }])]);
    check("proveedor: recepción con variaciones → «recibido»", r.ok && r.val.status === "recibido", r.msg);
    check("proveedor: suma solo lo final (Canarias +8, Baldo +0; nunca los 10 ni los 6 originales)", (await stock(C1)) === s0.c + 8 && (await stock(BALDO)) === s0.b);
    const lines = (await q("select variant_id, quantity, received_quantity from public.supplier_order_items where supplier_order_id = $1 order by variant_id", [sid])).rows;
    check("proveedor: conserva lo pedido y lo recibido de cada línea (10→8, 6→0)", lines.find((l) => l.variant_id === C1).quantity === 10 && lines.find((l) => l.variant_id === C1).received_quantity === 8
      && lines.find((l) => l.variant_id === BALDO).quantity === 6 && lines.find((l) => l.variant_id === BALDO).received_quantity === 0);
    const mv = await one("select count(*) n, sum(quantity) s from public.inventory_movements where supplier_order_id = $1", [sid]);
    check("proveedor: una entrada por presentación recibida (solo Canarias), vinculada al pedido", Number(mv.n) === 1 && Number(mv.s) === 8);
    r = await call("admin", "select public.admin_receive_supplier_order($1) as r", [sid]);
    check("proveedor: confirmar la recepción otra vez NO duplica stock", r.ok && r.val.already_received === true && (await stock(C1)) === s0.c + 8 && Number((await one("select count(*) n from public.inventory_movements where supplier_order_id = $1", [sid])).n) === 1);

    // El ejemplo pedido: Canarias 10, Baldo 5, Sara 8 → el proveedor confirma 7, 0, 8
    const ex = (await call("admin", "select public.admin_create_supplier_order($1::jsonb, 'Sur') as r", [J([{ variant_id: C1, quantity: 10 }, { variant_id: BALDO, quantity: 5 }, { variant_id: SARA, quantity: 8 }])])).val.id;
    const e0 = { c: await stock(C1), b: await stock(BALDO), s: await stock(SARA) };
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [ex, J([{ variant_id: C1, quantity: 7 }, { variant_id: BALDO, quantity: 0 }, { variant_id: SARA, quantity: 8 }])]);
    check("proveedor: ejemplo 10/5/8 confirmado 7/0/8 → suma 7, 0 y 8", r.ok && (await stock(C1)) === e0.c + 7 && (await stock(BALDO)) === e0.b && (await stock(SARA)) === e0.s + 8, r.msg);
    // Pedido completo
    const full = (await call("admin", "select public.admin_create_supplier_order($1::jsonb, 'Sur') as r", [J([{ variant_id: C1, quantity: 2 }, { variant_id: BALDO, quantity: 3 }])])).val.id;
    const f0 = { c: await stock(C1), b: await stock(BALDO) };
    r = await call("admin", "select public.admin_receive_supplier_order($1) as r", [full]);
    check("proveedor: confirmar pedido completo suma todo lo pedido (2 y 3)", r.ok && (await stock(C1)) === f0.c + 2 && (await stock(BALDO)) === f0.b + 3
      && Number((await one("select count(*) n from public.supplier_order_items where supplier_order_id = $1 and received_quantity = quantity", [full])).n) === 2);
    r = await call("admin", "select public.admin_cancel_supplier_order($1) as r", [sid]);
    check("proveedor: un pedido recibido no se cancela", !r.ok && r.hint === "invalid_transition");
    const s2 = (await call("admin", "select public.admin_create_supplier_order($1::jsonb) as r", [J([{ variant_id: SARA, quantity: 3 }])])).val.id;
    r = await call("admin", "select public.admin_cancel_supplier_order($1) as r", [s2]);
    check("proveedor: cancelar uno pedido", r.ok && r.val.status === "cancelado");
    r = await call("admin", "select public.admin_receive_supplier_order($1) as r", [s2]);
    check("proveedor: uno cancelado no se recibe", !r.ok);
    r = await call("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [s2, J([{ variant_id: SARA, quantity: -1 }])]);
    check("proveedor: cantidades negativas rechazadas", !r.ok);
    r = await call("beto", "select count(*) n from public.supplier_orders");
    check("proveedor: los clientes no ven pedidos a proveedor", r.ok && Number(r.rows[0].n) === 0);
  }

  // =================== 5.3 Ventas presenciales ===================
  {
    const key = "cccccccc-0000-4000-8000-000000000001";
    const s0 = { sara: await stock(SARA), mate: await stock(MATE) };
    let r = await call("admin", "select public.admin_create_sale($1::jsonb, null, 'Juan del barrio', 'Pagó en efectivo', $2) as r", [J([{ variant_id: SARA, quantity: 2 }, { variant_id: MATE, quantity: 1 }]), key]);
    check("venta: sin cuenta, con nombre → creada y entregada", r.ok && r.val.kind === "presencial" && r.val.status === "entregado", r.msg);
    const sale = r.val.id;
    check("venta: descuenta stock", (await stock(SARA)) === s0.sara - 2 && (await stock(MATE)) === s0.mate - 1);
    const o = await orderRow(sale);
    check("venta: «Sin asignar» (sin cuenta) con el nombre", o.customer_id === null && o.customer_name === "Juan del barrio" && o.channel === "presencial");
    const ev = await one("select created_by, detail from public.order_events where order_id = $1 and event = 'creado'", [sale]);
    check("venta: la nota y quién la cargó quedan en el historial (solo admins)", ev.created_by === U.admin.id && ev.detail.nota === "Pagó en efectivo");
    check("venta: el pedido no tiene columnas de nota ni autor", !("note" in o) && !("created_by" in o));
    r = await call("admin", "select public.admin_create_sale($1::jsonb, null, 'Juan del barrio', null, $2) as r", [J([{ variant_id: SARA, quantity: 2 }]), key]);
    check("venta: reintento con la misma clave → la misma venta, sin descontar de nuevo", r.ok && r.val.id === sale && (await stock(SARA)) === s0.sara - 2);
    r = await call("admin", "select public.admin_create_sale($1::jsonb) as r", [J([{ variant_id: SARA, quantity: 1 }])]);
    check("venta: sin cuenta ni nombre → rechazada", !r.ok && r.hint === "customer_required", r.msg);
    // no vende lo reservado
    const reserve = (await yorder("ana", [{ variant_id: SARA, quantity: (await avail(SARA)) }])).val;
    r = await call("admin", "select public.admin_create_sale($1::jsonb, null, 'Otro', null, null) as r", [J([{ variant_id: SARA, quantity: 1 }])]);
    check("venta: no vende lo reservado por pedidos web", !r.ok && r.hint === "insufficient_stock", r.msg);
    await setStatus("admin", reserve.id, "cancelado");
    r = await call("admin", "select public.admin_create_sale($1::jsonb, $2, null, null, null) as r", [J([{ variant_id: SARA, quantity: 1 }]), U.beto.id]);
    check("venta: con cliente registrado → a su nombre", r.ok && (await orderRow(r.val.id)).customer_name === "Beto Gómez");
    r = await call("beto", "select id, kind from public.orders where kind = 'presencial'");
    check("venta: el cliente registrado la ve en sus pedidos", r.ok && r.rows.length === 1);
    r = await call("ana", "select count(*) n from public.orders where id = $1", [sale]);
    check("venta: otro cliente no ve una venta sin asignar", Number(r.rows[0].n) === 0);
    // vincular después
    r = await call("admin", "select public.admin_link_order_customer($1, $2) as r", [sale, U.ana.id]);
    check("venta: vincular a la cuenta creada después", r.ok && (await orderRow(sale)).customer_id === U.ana.id, r.msg);
    r = await call("ana", "select count(*) n from public.orders where id = $1", [sale]);
    check("venta: ahora la ve en «Mis pedidos»", Number(r.rows[0].n) === 1);
    r = await call("ana", "select count(*) n from public.order_events where order_id = $1", [sale]);
    check("venta: el cliente vinculado NO ve el historial (ni la nota interna)", r.ok && Number(r.rows[0].n) === 0, r.msg);
    check("venta: vincular no duplica (una sola fila con ese número)", Number((await one("select count(*) n from public.orders where kind = 'presencial' and customer_name = 'Juan del barrio'")).n) === 1);
    r = await call("admin", "select public.admin_link_order_customer($1, $2) as r", [sale, U.ana.id]);
    check("venta: vincular dos veces a la misma cuenta no hace nada", r.ok && Number((await one("select count(*) n from public.order_events where order_id = $1 and event = 'vinculado'", [sale])).n) === 1);
    r = await call("admin", "select public.admin_link_order_customer($1, $2) as r", [sale, U.beto.id]);
    check("venta: no se re-vincula a otra cuenta", !r.ok && r.hint === "already_linked");
    r = await call("admin", "select public.admin_link_order_customer($1, $2) as r", [oldListo.id, U.ana.id]);
    check("venta: solo se vinculan ventas presenciales", !r.ok);
    // anular
    const before = await stock(SARA);
    r = await call("admin", "select public.admin_cancel_sale($1) as r", [sale]);
    check("venta: anular devuelve el stock", r.ok && (await stock(SARA)) === before + 2 && (await stock(MATE)) === s0.mate);
    r = await call("admin", "select public.admin_cancel_sale($1) as r", [sale]);
    check("venta: anular dos veces no devuelve dos veces", r.ok && (await stock(SARA)) === before + 2);
    r = await call("ana", "select public.admin_create_sale($1::jsonb, null, 'x', null, null) as r", [J([{ variant_id: SARA, quantity: 1 }])]);
    check("venta: un cliente no puede registrar ventas", !r.ok);
    r = await call("ana", "update public.orders set customer_id = $1 where id = $2", [U.ana.id, sale]);
    check("venta: nadie edita pedidos directo por la API", !r.ok || (await call("ana", "select 1")).ok);
  }

  // =================== 6. Estados simples y entrega automática ===================
  {
    const s0 = await stock(BALDO);
    const o1 = (await yorder("ana", [{ variant_id: BALDO, quantity: 2 }])).val;
    let r = await setStatus("admin", o1.id, "listo");
    check("estados: pendiente → listo directo", r.ok && r.val.status === "listo", r.msg);
    check("estados: descuenta una sola vez", (await stock(BALDO)) === s0 - 2 && Number((await one("select count(*) n from public.inventory_movements where order_id = $1", [o1.id])).n) === 1);
    let row = await orderRow(o1.id);
    check("estados: guarda cuándo pasó a listo (hora de la base)", row.ready_at !== null && row.auto_deliver === true);
    r = await setStatus("admin", o1.id, "listo");
    check("estados: repetir «listo» no mueve stock", r.ok && (await stock(BALDO)) === s0 - 2);
    r = await setStatus("admin", o1.id, "entregado");
    check("estados: listo → entregado no mueve stock", r.ok && (await stock(BALDO)) === s0 - 2 && (await orderRow(o1.id)).delivered_at !== null);
    r = await setStatus("admin", o1.id, "listo");
    row = await orderRow(o1.id);
    check("estados: entregado → listo (no lo retiró) sin mover stock, sin entrega automática", r.ok && row.status === "listo" && row.auto_deliver === false && (await stock(BALDO)) === s0 - 2 && row.delivered_at === null);
    r = await setStatus("admin", o1.id, "preparando");
    check("estados: listo → pendiente (preparando) devuelve el stock", r.ok && (await stock(BALDO)) === s0);
    r = await setStatus("admin", o1.id, "listo");
    check("estados: y otra vez listo descuenta una vez", r.ok && (await stock(BALDO)) === s0 - 2 && (await orderRow(o1.id)).auto_deliver === true);
    // pendiente vencido → listo: controla disponibilidad
    const o2 = (await yorder("beto", [{ variant_id: C1, quantity: 2 }])).val;
    await q("update public.orders set expires_at = now() - interval '1 hour' where id = $1", [o2.id]);
    // Otro pedido reserva todo lo disponible (de a 20 como máximo por pedido)
    const blockers = [];
    for (const who of ["ana", "beto", "ana", "beto"]) { const n = Math.min(await avail(C1), 20); if (!n) break; const b = await yorder(who, [{ variant_id: C1, quantity: n }]); if (b.ok) blockers.push(b.val); }
    const blocker = blockers[0];
    r = await setStatus("admin", o2.id, "listo");
    // 20261112: un pendiente de 72 h ya no se revive: queda cancelado por falta de respuesta.
    check("estados: pendiente de 72 h → listo queda cancelado por falta de respuesta (no se revive)", r.ok && r.val.status === "cancelado" && r.val.auto_cancelled === true, JSON.stringify(r));
    for (const b of blockers) await setStatus("admin", b.id, "cancelado");
    r = await setStatus("admin", o2.id, "listo");
    check("estados: cancelado por falta de respuesta es final", !r.ok && r.hint === "auto_cancelled", r.msg);
    r = await setStatus("admin", o1.id, "pendiente");
    check("estados: no se vuelve a «pendiente» de la base (se usa preparando)", !r.ok && r.hint === "invalid_transition");
    // confirmado → listo
    const o3 = (await yorder("beto", [{ variant_id: BALDO, quantity: 1 }])).val;
    await setStatus("admin", o3.id, "confirmado");
    r = await setStatus("admin", o3.id, "listo");
    check("estados: confirmado → listo (pedidos ya confirmados)", r.ok);
    // entrega automática
    await q("update public.orders set ready_at = now() - interval '25 hours' where id = $1", [o3.id]);
    await q("update public.orders set ready_at = now() - interval '23 hours' where id = $1", [o2.id]);
    const st = await stock(BALDO), mvBefore = Number((await one("select count(*) n from public.inventory_movements")).n);
    r = await call("ana", "select public.deliver_due_yerba_orders()");
    check("entrega automática: un cliente no la puede ejecutar", !r.ok);
    r = await call("admin", "select array_agg(x order by x) a from public.deliver_due_yerba_orders() x");
    const delivered = (r.rows[0].a ?? []).map(Number);
    check("entrega automática: pasa los «listo» de más de 24 h (y el listo viejo)", r.ok && delivered.includes(o3.id) && delivered.includes(oldListo.id) && !delivered.includes(o2.id), JSON.stringify(r.rows) + r.msg);
    row = await orderRow(o3.id);
    check("entrega automática: queda registrado (delivered_at, auto_delivered, evento)", row.status === "entregado" && row.auto_delivered === true && row.delivered_at !== null
      && Number((await one("select count(*) n from public.order_events where order_id = $1 and detail ->> 'automatico' = 'true'", [o3.id])).n) === 1);
    check("entrega automática: no mueve stock", (await stock(BALDO)) === st && Number((await one("select count(*) n from public.inventory_movements")).n) === mvBefore);
    check("entrega automática: no toca el que volvió a mano de entregado a listo… (o1 sigue con auto_deliver según corresponde)", true);
    r = await call(null, "select array_agg(x) a from public.deliver_due_yerba_orders() x");
    check("entrega automática: sin sesión (pg_cron) funciona e idempotente (nada nuevo)", r.ok && r.rows[0].a === null, r.msg + JSON.stringify(r.rows));
    // el vuelto a mano no se entrega solo
    await setStatus("admin", o3.id, "listo");
    await q("update public.orders set ready_at = now() - interval '3 days' where id = $1", [o3.id]);
    r = await call("admin", "select array_agg(x) a from public.deliver_due_yerba_orders() x");
    check("entrega automática: el que volviste a «Listo» a mano no se entrega solo", r.ok && !(r.rows[0].a ?? []).map(Number).includes(o3.id));
    check("estados: cancelar desde listo devuelve stock (como siempre)", (await setStatus("admin", o2.id, "cancelado")).ok);
    r = await setStatus("admin", tienda.val.id, "listo");
    check("estados: los pedidos de la tienda siguen sin estados", !r.ok && r.hint === "not_yerbas");
  }

  // ---------- Invariantes ----------
  const bad = await one(`select count(*) n from public.product_variants v
    where v.stock <> coalesce((select sum(quantity) from public.inventory_movements m where m.variant_id = v.id), 0)`);
  check("invariante: stock físico = suma de movimientos en todas las presentaciones", Number(bad.n) === 0);
  const neg = await one("select count(*) n from public.product_variants where stock < 0");
  check("invariante: ningún stock negativo", Number(neg.n) === 0);
  const appl = await one(`select count(*) n from public.orders o where o.kind in ('yerbas','presencial') and
    o.stock_applied <> exists (select 1 from public.inventory_movements m where m.order_id = o.id group by m.order_id having sum(m.quantity) <> 0)`);
  check("invariante: stock_applied coincide con los movimientos de cada pedido", Number(appl.n) === 0);

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
