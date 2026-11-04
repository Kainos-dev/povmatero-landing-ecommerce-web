// Concurrencia real (Postgres 17 embebido) para la cancelación por falta de
// respuesta: tareas simultáneas, panel y tarea a la vez. Nada se duplica.
const PWD = process.env.PW;
const EmbeddedPostgres = require(require.resolve("embedded-postgres", { paths: [PWD] })).default;
const { Client } = require(require.resolve("pg", { paths: [PWD] }));
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const DIR = path.join(__dirname, "pgdata-" + Date.now());
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
const U = { ana: "11111111-1111-4111-8111-111111111111", beto: "22222222-2222-4222-8222-222222222222", admin: "99999999-9999-4999-8999-999999999999", admin2: "88888888-8888-4888-8888-888888888888" };

(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: 54332, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise(); await pg.start();
  const conn = async () => { const c = new Client({ host: "localhost", port: 54332, user: "postgres", password: "postgres", database: "postgres" }); await c.connect(); return c; };
  const root = await conn();
  try {
    await root.query(STUB);
    for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) await root.query(fs.readFileSync(path.join(MIG, f), "utf8"));
    console.log("Postgres", (await root.query("show server_version")).rows[0].server_version, "— todas las migraciones aplicadas (incluida 20261112)");
    for (const [k, id] of Object.entries(U)) await root.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, k + "@t.com", JSON.stringify({ first_name: k, phone: "11 5555-0000" })]);
    await root.query("insert into public.admin_users (user_id) values ($1), ($2)", [U.admin, U.admin2]);
    const cat = (await root.query("select id from public.categories where slug = 'yerbas'")).rows[0].id;
    const p = (await root.query("insert into public.products (category_id, slug, name, is_active) values ($1, 'canarias-suave', 'Canarias Suave', true) returning id", [cat])).rows[0].id;
    const A = Number((await root.query("insert into public.product_variants (product_id, name, price) values ($1, '1kg', 13900) returning id", [p])).rows[0].id);
    await root.query("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', 200, 'carga')", [A]);
    const stock = async () => (await root.query("select stock from public.product_variants where id = $1", [A])).rows[0].stock;
    const moves = async () => Number((await root.query("select count(*) n from public.inventory_movements")).rows[0].n);
    const cancelEvents = async (id) => Number((await root.query("select count(*) n from public.order_events where order_id = $1 and to_status = 'cancelado'", [id])).rows[0].n);

    async function run(user, sql, params) {
      const c = await conn();
      try {
        await c.query("begin");
        if (user === "service") {
          await c.query("set local role service_role");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
        } else if (user !== "postgres") {
          await c.query("set local role authenticated");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U[user], role: "authenticated" })]);
        }
        const r = await c.query(sql, params);
        await c.query("commit");
        return { ok: true, rows: r.rows };
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return { ok: false, e };
      } finally { await c.end(); }
    }
    const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
    const order = async (who, qty = 1) => Number((await run(who, "select public.create_yerba_order($1::jsonb, null) as r", [JSON.stringify([{ variant_id: A, quantity: qty }])])).rows[0].r.id);
    const expire = (ids) => root.query("update public.orders set created_at = now() - interval '73 hours', expires_at = now() - interval '1 hour' where id = any($1)", [ids]);

    // 1. 12 pedidos vencidos; 6 tareas a la vez (service_role y admins)
    const ids = [];
    // límite de 3 pendientes por cliente: se crean de a uno y se vencen
    for (let i = 0; i < 12; i++) { ids.push(await order(i % 2 ? "ana" : "beto")); await expire([ids.at(-1)]); }
    const s0 = await stock(), m0 = await moves();
    const runs = await all(6, (i) => run(i % 3 === 0 ? "admin" : "service", "select public.run_order_maintenance() as r", []));
    check("6 tareas a la vez → todas terminan sin error", runs.every((x) => x.ok), runs.filter((x) => !x.ok).map((x) => x.e.message).join(" | "));
    const cancelledBy = runs.flatMap((x) => x.ok ? x.rows[0].r.cancelados : []);
    check("…cada pedido lo cancela una sola tarea", cancelledBy.length === 12 && new Set(cancelledBy).size === 12, JSON.stringify(cancelledBy));
    const evs = await Promise.all(ids.map(cancelEvents));
    check("…un solo evento de cancelación por pedido", evs.every((n) => n === 1), JSON.stringify(evs));
    check("…sin movimientos de stock, físico igual", (await stock()) === s0 && (await moves()) === m0);

    // 2. Panel «Marcar listo» y tarea A LA VEZ sobre un pendiente de 72 h
    for (let k = 0; k < 5; k++) {
      const o = await order("ana", 2);
      await expire([o]);
      const st = await stock(), mv = await moves();
      const res = await Promise.all([
        run("admin", "select public.admin_set_order_status($1, 'listo') as r", [o]),
        run("service", "select public.run_order_maintenance() as r", []),
        run("admin2", "select public.admin_set_order_status($1, 'cancelado') as r", [o]),
      ]);
      const row = (await root.query("select status, cancel_reason, stock_applied from public.orders where id = $1", [o])).rows[0];
      check(`carrera ${k + 1} (vencido): queda cancelado por falta de respuesta, 1 evento, sin descontar stock`,
        res.every((x) => x.ok || x.e.hint === "auto_cancelled") && row.status === "cancelado" && row.cancel_reason === "Cancelado por falta de respuesta" && !row.stock_applied
        && (await cancelEvents(o)) === 1 && (await stock()) === st && (await moves()) === mv,
        JSON.stringify({ row, res: res.map((x) => x.ok ? "ok" : x.e.message) }));
    }

    // 3. Pendiente vigente: «Marcar listo» y tarea a la vez → listo, descuenta una vez
    for (let k = 0; k < 5; k++) {
      const o = await order("beto", 3);
      const st = await stock();
      const res = await Promise.all([
        run("service", "select public.run_order_maintenance() as r", []),
        run("admin", "select public.admin_set_order_status($1, 'listo') as r", [o]),
        run("admin2", "select public.admin_set_order_status($1, 'listo') as r", [o]),
      ]);
      const row = (await root.query("select status from public.orders where id = $1", [o])).rows[0];
      check(`carrera ${k + 1} (vigente): queda listo, descuenta 3 una sola vez, no se cancela`,
        res.every((x) => x.ok) && row.status === "listo" && (await stock()) === st - 3 && (await cancelEvents(o)) === 0,
        JSON.stringify({ row, stock: await stock(), st, res: res.map((x) => x.ok ? "ok" : x.e.message) }));
      await run("admin", "select public.admin_set_order_status($1, 'entregado') as r", [o]);
    }

    // 4. El cliente crea un pedido mientras corre la tarea: el nuevo no se toca
    const old = await order("ana");
    await expire([old]);
    const [created, task] = await Promise.all([
      run("ana", "select public.create_yerba_order($1::jsonb, null) as r", [JSON.stringify([{ variant_id: A, quantity: 1 }])]),
      run("service", "select public.run_order_maintenance() as r", []),
    ]);
    const newId = created.ok ? Number(created.rows[0].r.id) : null;
    check("pedido nuevo durante la tarea: se crea y queda pendiente", created.ok && task.ok
      && (await root.query("select status from public.orders where id = $1", [newId])).rows[0].status === "pendiente", created.ok ? "" : created.e.message);

    const bad = (await root.query(`select count(*) n from public.product_variants v where v.stock <> coalesce((select sum(quantity) from public.inventory_movements m where m.variant_id = v.id), 0) or v.stock < 0`)).rows[0].n;
    check("invariante: stock = suma de movimientos y nunca negativo", Number(bad) === 0);
    const dup = (await root.query(`select count(*) n from (select order_id from public.order_events where to_status = 'cancelado' group by order_id having count(*) > 1) x`)).rows[0].n;
    check("invariante: ningún pedido tiene dos cancelaciones", Number(dup) === 0);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await root.end(); await pg.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${ok} OK, ${fail} FALLAS`);
  process.exit(fail ? 1 : 0);
})();
