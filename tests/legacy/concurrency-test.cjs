// Concurrencia real (Postgres 17 embebido, varias conexiones a la vez) para
// las funciones nuevas: nada se duplica aunque dos pedidos lleguen juntos.
const PWD = process.env.PW;
const EmbeddedPostgres = require(require.resolve("embedded-postgres", { paths: [PWD] })).default;
const { Client } = require(require.resolve("pg", { paths: [PWD] }));
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const DIR = path.join(__dirname, "pgdata-" + Date.now());

let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const STUB = fs.readFileSync(path.join(__dirname, "..", "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
const U = { ana: "11111111-1111-4111-8111-111111111111", admin: "99999999-9999-4999-8999-999999999999", admin2: "88888888-8888-4888-8888-888888888888" };

(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: 54331, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise(); await pg.start();
  const conn = async () => { const c = new Client({ host: "localhost", port: 54331, user: "postgres", password: "postgres", database: "postgres" }); await c.connect(); return c; };
  const root = await conn();
  try {
    await root.query(STUB);
    for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) await root.query(fs.readFileSync(path.join(MIG, f), "utf8"));
    console.log("Postgres", (await root.query("show server_version")).rows[0].server_version, "— todas las migraciones aplicadas (incluidas 20261108/09/10)");
    for (const [k, id] of Object.entries(U)) await root.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, k + "@t.com", JSON.stringify({ first_name: k, phone: "11 5555-0000" })]);
    await root.query("insert into public.admin_users (user_id) values ($1), ($2)", [U.admin, U.admin2]);
    const cat = (await root.query("select id from public.categories where slug = 'yerbas'")).rows[0].id;
    const mk = async (name, stock) => {
      const p = (await root.query("insert into public.products (category_id, slug, name, is_active) values ($1, $2, $3, true) returning id", [cat, name.toLowerCase().replace(/\s+/g, "-"), name])).rows[0].id;
      const v = (await root.query("insert into public.product_variants (product_id, name, price) values ($1, '1kg', 10000) returning id", [p])).rows[0].id;
      if (stock) await root.query("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga')", [v, stock]);
      return Number(v);
    };
    const A = await mk("Canarias Prueba", 5), B = await mk("Sara Agotada", 0);
    const stock = async (v) => (await root.query("select stock from public.product_variants where id = $1", [v])).rows[0].stock;

    // Cada llamada en su propia conexión y transacción, todas a la vez.
    async function run(user, sql, params) {
      const c = await conn();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U[user], role: "authenticated" })]);
        const r = await c.query(sql, params);
        await c.query("commit");
        return { ok: true, rows: r.rows };
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return { ok: false, e };
      } finally { await c.end(); }
    }
    const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));

    // 1. Recepción a proveedor confirmada 5 veces a la vez → una sola entrada
    const so = (await run("admin", "select public.admin_create_supplier_order($1::jsonb, 'Sur') as r", [JSON.stringify([{ variant_id: A, quantity: 10 }])])).rows[0].r.id;
    const s0 = await stock(A);
    const rec = await all(5, (i) => run(i % 2 ? "admin" : "admin2", "select public.admin_receive_supplier_order($1) as r", [so]));
    check("proveedor: 5 confirmaciones simultáneas → todas responden sin error", rec.every((x) => x.ok), rec.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    check("proveedor: …y el stock sube una sola vez (+10)", (await stock(A)) === s0 + 10, `${await stock(A)}`);
    check("proveedor: una sola entrada vinculada", Number((await root.query("select count(*) n from public.inventory_movements where supplier_order_id = $1", [so])).rows[0].n) === 1);

    // 1b. Dos admins confirman el mismo pedido A LA VEZ con variaciones distintas → se aplica una sola
    const sv = (await run("admin", "select public.admin_create_supplier_order($1::jsonb, 'Sur') as r", [JSON.stringify([{ variant_id: A, quantity: 10 }])])).rows[0].r.id;
    const sv0 = await stock(A);
    const both = await Promise.all([
      run("admin", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sv, JSON.stringify([{ variant_id: A, quantity: 7 }])]),
      run("admin2", "select public.admin_receive_supplier_order($1, $2::jsonb) as r", [sv, JSON.stringify([{ variant_id: A, quantity: 4 }])]),
    ]);
    const gained = (await stock(A)) - sv0;
    const recv = (await root.query("select received_quantity from public.supplier_order_items where supplier_order_id = $1", [sv])).rows[0].received_quantity;
    check(`proveedor: 2 confirmaciones con variaciones a la vez → se aplica una sola (+${gained}, registrado ${recv})`,
      both.every((x) => x.ok) && (gained === 7 || gained === 4) && recv === gained && both.filter((x) => x.rows[0].r.already_received).length === 1
        && Number((await root.query("select count(*) n from public.inventory_movements where supplier_order_id = $1", [sv])).rows[0].n) === 1,
      both.map((x) => x.ok ? JSON.stringify({ ar: x.rows[0].r.already_received }) : x.e.message).join(" | "));

    // 2. Mismo pedido a proveedor creado 4 veces a la vez con la misma clave → uno
    const key = "dddddddd-0000-4000-8000-000000000001";
    await all(4, () => run("admin", "select public.admin_create_supplier_order($1::jsonb, 'Sur', null, $2) as r", [JSON.stringify([{ variant_id: A, quantity: 1 }]), key]));
    check("proveedor: misma clave a la vez → un solo pedido", Number((await root.query("select count(*) n from public.supplier_orders where client_key = $1", [key])).rows[0].n) === 1);

    // 3. Misma venta (misma clave) enviada 4 veces a la vez → una venta, un descuento
    const sk = "eeeeeeee-0000-4000-8000-000000000001";
    const before = await stock(A);
    const sales = await all(4, () => run("admin", "select public.admin_create_sale($1::jsonb, null, 'Juan', null, $2) as r", [JSON.stringify([{ variant_id: A, quantity: 2 }]), sk]));
    check("venta: misma clave a la vez → todas responden con la misma venta", sales.every((x) => x.ok) && new Set(sales.map((x) => x.rows[0].r.id)).size === 1, sales.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    check("venta: …y descuenta una sola vez (−2)", (await stock(A)) === before - 2);

    // 4. Ventas distintas que juntas superan el stock → ninguna sobreventa
    const left = await stock(A);
    const N = Math.floor(left / 2) + 2;
    const rush = await all(N, () => run("admin", "select public.admin_create_sale($1::jsonb, null, 'Cliente', null, null) as r", [JSON.stringify([{ variant_id: A, quantity: 2 }])]));
    const sold = rush.filter((x) => x.ok).length;
    check(`venta: ${N} ventas de 2 sobre ${left} unidades → ${sold} aceptadas, sin stock negativo`, sold === Math.floor(left / 2) && rush.some((x) => !x.ok) && (await stock(A)) === left - sold * 2 && rush.filter((x) => !x.ok).every((x) => x.e.hint === "insufficient_stock"));

    // 5. Movimientos manuales con conciliación, a la vez
    const X = await mk("Rei Verde Concurrencia", 3);
    const mv = (op, qty, x = {}) => run("admin", "select public.admin_stock_movement($1, $2, $3, $4, 'prueba', null, $5, $6) as r",
      [op, X, x.type ?? "salida", qty, x.declared ?? null, x.confirm ?? false]);
    const opMoves = async (op) => Number((await root.query("select count(*) n from public.inventory_movements where operation_id = $1", [op])).rows[0].n);
    const id = (n) => `aaaaaaa${n}-0000-4000-8000-00000000000${n}`;
    // 5a. misma operación 4 veces a la vez → una sola
    const same = await all(4, () => mv(id(1), 1));
    check("conciliación: misma operación 4 veces a la vez → todas ok, un solo movimiento (stock 2)", same.every((x) => x.ok) && (await opMoves(id(1))) === 1 && (await stock(X)) === 2,
      same.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    // 5b. dos salidas distintas que juntas superan lo disponible → una pasa, la otra pide conteo
    const two = await all(2, (i) => mv(id(2 + i), 2));
    check("conciliación: 2 salidas de 2 sobre 2 disponibles a la vez → una registrada, la otra pide el stock físico real",
      two.filter((x) => x.ok).length === 1 && two.filter((x) => !x.ok).every((x) => x.e.hint === "count_required") && (await stock(X)) === 0,
      two.map((x) => x.ok ? "ok" : x.e.hint).join(","));
    // 5c. pedido web y salida rápida compitiendo por la misma unidad
    await mv(id(4), 2, { type: "entrada" });
    const race = await Promise.all([
      run("ana", "select public.create_yerba_order($1::jsonb) as r", [JSON.stringify([{ variant_id: X, quantity: 2 }])]),
      mv(id(5), 2),
    ]);
    const committed = Number((await root.query("select coalesce(sum(quantity), 0) q from public.variant_commitments() where variant_id = $1", [X])).rows[0].q);
    const physical = await stock(X);
    check("conciliación: pedido web vs salida a la vez → uno gana y nunca queda reservado más que el físico",
      race.filter((x) => x.ok).length === 1 && physical >= committed && physical >= 0,
      `físico ${physical}, reservado ${committed}, ${race.map((x) => x.ok ? "ok" : x.e.hint).join(",")}`);
    // 5d. conciliación con faltante confirmada 3 veces a la vez → una operación, un faltante
    await mv(id(8), 2, { type: "entrada" });
    await run("ana", "select public.create_yerba_order($1::jsonb) as r", [JSON.stringify([{ variant_id: X, quantity: 2 }])]);
    const resD = Number((await root.query("select coalesce(sum(quantity), 0) q from public.variant_commitments() where variant_id = $1", [X])).rows[0].q);
    const physD = await stock(X);
    const conc = await all(3, () => mv(id(6), physD - resD + 1, { declared: 0, confirm: true }));
    check(`conciliación: faltante confirmado 3 veces a la vez (físico ${physD}, reservado ${resD}) → un ajuste + una salida, un faltante, stock 0`,
      resD >= 2 && conc.every((x) => x.ok) && (await opMoves(id(6))) === 2 && (await stock(X)) === 0
        && Number((await root.query("select count(*) n from public.stock_shortages where operation_id = $1", [id(6)])).rows[0].n) === 1
        && Number((await root.query("select count(*) n from public.stock_operations where id = $1", [id(6)])).rows[0].n) === 1,
      conc.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    // 5e. salida directa (como el panel publicado) que se comería lo reservado, a la vez que otra
    const res2 = Number((await root.query("select coalesce(sum(quantity), 0) q from public.variant_commitments() where variant_id = $1", [X])).rows[0].q);
    await mv(id(7), res2 + 4 - (await stock(X)), { type: "entrada" });   // quedan 4 libres por encima de lo reservado
    const phys2 = await stock(X);
    const direct = await all(2, () => run("admin", "insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'salida', $2, 'directa')", [X, -(phys2 - res2)]));
    check(`salida directa x2 a la vez (cada una de ${phys2 - res2}) → solo una, nunca debajo de lo reservado`,
      direct.filter((x) => x.ok).length === 1 && direct.filter((x) => !x.ok).every((x) => x.e.hint === "reserved_stock" || /product_variants_stock_check/.test(x.e.message)) && (await stock(X)) >= res2 && (await stock(X)) === res2 + 4 - (phys2 - res2),
      direct.map((x) => x.ok ? "ok" : `${x.e.code} ${x.e.hint} ${x.e.message}`).join(" | "));

    // 6. Aviso de reposición pedido 4 veces a la vez → una solicitud activa
    const al = await all(4, () => run("ana", "select public.request_restock_alert($1) as r", [B]));
    check("aviso: 4 pedidos simultáneos → todos ok", al.every((x) => x.ok), al.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    check("aviso: …una sola solicitud activa", Number((await root.query("select count(*) n from public.restock_requests where variant_id = $1 and status = 'activa'", [B])).rows[0].n) === 1);

    // 7. Entrega automática ejecutada 3 veces a la vez → un evento por pedido
    await root.query("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 5, 'prueba')", [A]);
    const o = (await run("ana", "select public.create_yerba_order($1::jsonb) as r", [JSON.stringify([{ variant_id: A, quantity: 1 }])])).rows[0].r.id;
    await run("admin", "select public.admin_set_order_status($1, 'listo')", [o]);
    await root.query("update public.orders set ready_at = now() - interval '2 days' where id = $1", [o]);
    const st = await stock(A);
    await all(3, () => run("admin", "select public.deliver_due_yerba_orders()", []));
    check("entrega automática a la vez → un solo cambio y un solo evento", (await root.query("select status from public.orders where id = $1", [o])).rows[0].status === "entregado"
      && Number((await root.query("select count(*) n from public.order_events where order_id = $1 and to_status = 'entregado'", [o])).rows[0].n) === 1 && (await stock(A)) === st);

    const bad = (await root.query(`select count(*) n from public.product_variants v where v.stock <> coalesce((select sum(quantity) from public.inventory_movements m where m.variant_id = v.id), 0) or v.stock < 0`)).rows[0].n;
    check("invariante: stock = suma de movimientos y nunca negativo", Number(bad) === 0);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await root.end(); await pg.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${ok} OK, ${fail} FALLAS`);
  process.exit(fail ? 1 : 0);
})();
