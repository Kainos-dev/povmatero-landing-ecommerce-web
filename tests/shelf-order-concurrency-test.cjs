// 20261113 con conexiones simultáneas (Postgres 17 embebido, local): dos
// administradores ordenando a la vez, marcas nuevas cargadas a la vez, yerbas
// que cambian de góndola a la vez. Nunca toca Supabase.
const PWD = process.env.PW;
const EmbeddedPostgres = require(require.resolve("embedded-postgres", { paths: [PWD] })).default;
const { Client } = require(require.resolve("pg", { paths: [PWD] }));
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const DIR = path.join(__dirname, "pgdata-" + Date.now());
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
const U = { admin: "99999999-9999-4999-8999-999999999999", admin2: "88888888-8888-4888-8888-888888888888" };

(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: 54333, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise(); await pg.start();
  const conn = async () => { const c = new Client({ host: "localhost", port: 54333, user: "postgres", password: "postgres", database: "postgres" }); await c.connect(); return c; };
  const root = await conn();
  try {
    await root.query(STUB);
    for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) await root.query(fs.readFileSync(path.join(MIG, f), "utf8"));
    console.log("Postgres", (await root.query("show server_version")).rows[0].server_version, "— todas las migraciones aplicadas (incluida 20261113)");
    for (const [k, id] of Object.entries(U)) await root.query("insert into auth.users (id, email) values ($1, $2)", [id, k + "@t.com"]);
    await root.query("insert into public.admin_users (user_id) values ($1), ($2)", [U.admin, U.admin2]);
    const Y = (await root.query("select id from public.categories where slug = 'yerbas'")).rows[0].id;
    for (const [i, [name, brand]] of [["Canarias A", "Canarias"], ["Canarias B", "Canarias"], ["Canarias C", "Canarias"], ["Sara A", "Sara"], ["Baldo A", "Baldo"], ["Pindaré", null]].entries())
      await root.query("insert into public.products (category_id, slug, name, brand, is_active) values ($1, $2, $3, $4, true)", [Y, `y${i}`, name, brand]);

    async function run(user, sql, params, { hold = 0 } = {}) {
      const c = await conn();
      try {
        await c.query("begin");
        await c.query("set local role authenticated");
        await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U[user], role: "authenticated" })]);
        const r = await c.query(sql, params);
        if (hold) await new Promise((res) => setTimeout(res, hold));
        await c.query("commit");
        return { ok: true, rows: r.rows };
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return { ok: false, e };
      } finally { await c.end(); }
    }
    const brands = async () => (await root.query("select key from public.shelf_brands order by position")).rows.map((r) => r.key);
    const group = async (key) => (await root.query("select id from public.products where category_id = $1 and (case when shelf_other or brand is null then '' else public.shelf_brand_key(brand) end) = $2 order by shelf_position, id", [Y, key])).rows.map((r) => Number(r.id));

    // 1. Dos administradores guardan el orden de góndolas a la vez, con la misma vista
    const k0 = await brands();
    const [r1, r2] = await Promise.all([
      run("admin", "select public.admin_set_shelf_brand_order($1, $2)", [[...k0].reverse(), k0], { hold: 300 }),
      run("admin2", "select public.admin_set_shelf_brand_order($1, $2)", [[k0[1], k0[0], k0[2]], k0]),
    ]);
    const k1 = await brands();
    check("góndolas a la vez: gana uno solo, el otro recibe stale_order", [r1, r2].filter((r) => r.ok).length === 1 && [r1, r2].some((r) => !r.ok && r.e.hint === "stale_order"), JSON.stringify([r1.ok, r1.e?.message, r2.ok, r2.e?.message]));
    check("góndolas a la vez: queda exactamente el orden del que ganó", JSON.stringify(k1) === JSON.stringify(r1.ok ? [...k0].reverse() : [k0[1], k0[0], k0[2]]), JSON.stringify(k1));

    // 2. 8 altas simultáneas de la misma marca nueva, escrita distinto
    const spellings = ["Rei Verde", "rei verde", "REI VERDE", " Rei  Verde ", "Rei-Verde", "rei verde", "Rei Verde", "REI verde"];
    const ins = await Promise.all(spellings.map((s, i) => run(i % 2 ? "admin2" : "admin", "insert into public.products (category_id, slug, name, brand) values ($1, $2, $3, $4) returning brand, shelf_position", [Y, `rv${i}`, `RV ${i}`, s])));
    check("marca nueva a la vez: las 8 altas se guardan", ins.every((r) => r.ok), ins.filter((r) => !r.ok).map((r) => r.e.message).join(" | "));
    const rv = (await root.query("select key, name, position from public.shelf_brands where key = 'reiverde'")).rows;
    check("marca nueva a la vez: UNA sola fila «reiverde», al final", rv.length === 1 && rv[0].position === k1.length + 1, JSON.stringify(rv));
    check("marca nueva a la vez: todas con la misma escritura", new Set(ins.map((r) => r.rows[0].brand)).size === 1);
    const pos = ins.map((r) => r.rows[0].shelf_position).sort((a, b) => a - b);
    check("marca nueva a la vez: lugares 1..8 sin repetir", JSON.stringify(pos) === JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]), JSON.stringify(pos));

    // 3. Reordenar Canarias mientras otro administrador manda una Canarias a «Otras marcas»
    const can = await group("canarias");
    const [ro, mv] = await Promise.all([
      run("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2)", [[...can].reverse(), can], { hold: 300 }),
      run("admin2", "update public.products set shelf_other = true where id = $1 returning shelf_position", [can[0]]),
    ]);
    const canAfter = await group("canarias"), oth = await group("");
    check("orden + cambio de góndola a la vez: los dos se resuelven sin error de base", ro.ok && mv.ok || (!ro.ok && ro.e.hint === "stale_order" && mv.ok), JSON.stringify([ro.e?.message, mv.e?.message]));
    check("orden + cambio de góndola a la vez: la yerba quedó al final de «Otras marcas»", oth.at(-1) === can[0] && !canAfter.includes(can[0]), JSON.stringify({ canAfter, oth }));

    // 4. Dos administradores reordenan la misma góndola a la vez
    const c2 = await group("canarias");
    const [a, b] = await Promise.all([
      run("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2)", [[...c2].reverse(), c2], { hold: 300 }),
      run("admin2", "select public.admin_set_shelf_product_order('canarias', $1, $2)", [c2, c2]),
    ]);
    check("misma góndola a la vez: uno guarda, el otro stale_order (o no cambia nada)", (a.ok !== b.ok && [a, b].some((r) => !r.ok && r.e.hint === "stale_order")) || (a.ok && b.ok), JSON.stringify([a.e?.message, b.e?.message]));

    // 5. 6 yerbas pasan a «Otras marcas» a la vez → lugares sin repetir
    const ids = (await root.query("select id from public.products where category_id = $1 and not shelf_other and brand is not null order by id limit 6", [Y])).rows.map((r) => Number(r.id));
    const moves = await Promise.all(ids.map((id, i) => run(i % 2 ? "admin2" : "admin", "update public.products set shelf_other = true where id = $1", [id])));
    const d = (await root.query(`select count(*) n from (select shelf_position from public.products where category_id = $1 and (shelf_other or brand is null) group by 1 having count(*) > 1) x`, [Y])).rows[0].n;
    check("6 cambios de góndola a la vez: todos guardados y sin lugares repetidos", moves.every((r) => r.ok) && Number(d) === 0, moves.filter((r) => !r.ok).map((r) => r.e.message).join(" | "));
  } finally {
    await root.end();
    await pg.stop();
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${ok} OK, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
