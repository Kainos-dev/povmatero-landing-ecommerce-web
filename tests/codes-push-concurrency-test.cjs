// Concurrencia real (Postgres 17 embebido) para 20261114 y 20261115:
// pedidos simultáneos del mismo cliente (códigos), la última unidad, la misma
// clave de intento dos veces a la vez, dos servidores de envío a la vez y
// tareas de mantenimiento simultáneas. Nada se duplica.
const PWD = process.env.PW;
const EmbeddedPostgres = require(require.resolve("embedded-postgres", { paths: [PWD] })).default;
const { Client } = require(require.resolve("pg", { paths: [PWD] }));
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const DIR = path.join(__dirname, "pgdata-" + Date.now());
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
const users = { admin: "99999999-9999-4999-8999-999999999999" };
for (let i = 0; i < 12; i++) users["c" + i] = `1111111${i.toString(16)}-1111-4111-8111-111111111111`;
const P256 = "B" + "x".repeat(86), AUTH = "a".repeat(22);

(async () => {
  const pg = new EmbeddedPostgres({ databaseDir: DIR, user: "postgres", password: "postgres", port: 54334, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"] });
  await pg.initialise(); await pg.start();
  const conn = async () => { const c = new Client({ host: "localhost", port: 54334, user: "postgres", password: "postgres", database: "postgres" }); await c.connect(); return c; };
  const root = await conn();
  try {
    await root.query(STUB);
    for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) await root.query(fs.readFileSync(path.join(MIG, f), "utf8"));
    console.log("Postgres", (await root.query("show server_version")).rows[0].server_version, "— todas las migraciones aplicadas (incluidas 20261114 y 20261115)");
    for (const [k, id] of Object.entries(users)) await root.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, k + "@t.com", JSON.stringify({ first_name: "Cli" + k, last_name: "Test", phone: "11 5555-0000" })]);
    await root.query("insert into public.admin_users (user_id) values ($1)", [users.admin]);
    const cat = (await root.query("select id from public.categories where slug = 'yerbas'")).rows[0].id;
    const mk = async (slug, st) => {
      const p = (await root.query("insert into public.products (category_id, slug, name, is_active) values ($1, $2, $2, true) returning id", [cat, slug])).rows[0].id;
      const v = Number((await root.query("insert into public.product_variants (product_id, name, price) values ($1, '1kg', 10000) returning id", [p])).rows[0].id);
      if (st) await root.query("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga')", [v, st]);
      return v;
    };
    const MANY = await mk("baldo", 500), LAST = await mk("ultima", 1), FEW = await mk("pocas", 3);

    async function run(user, sql, params) {
      const c = await conn();
      try {
        await c.query("begin");
        if (user === "service") {
          await c.query("set local role service_role");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
        } else if (user !== "postgres") {
          await c.query("set local role authenticated");
          await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: users[user], role: "authenticated" })]);
        }
        const r = await c.query(sql, params);
        await c.query("commit");
        return { ok: true, rows: r.rows, val: r.rows[0] && Object.values(r.rows[0])[0] };
      } catch (e) {
        await c.query("rollback").catch(() => {});
        return { ok: false, e, hint: e.hint };
      } finally { await c.end(); }
    }
    const all = (n, fn) => Promise.all(Array.from({ length: n }, (_, i) => fn(i)));
    const yorder = (who, variant, qty = 1, key = null) => run(who, "select public.create_yerba_order($1::jsonb, null, $2::uuid) as r", [JSON.stringify([{ variant_id: variant, quantity: qty }]), key]);

    // 1. Un cliente, muchos pedidos a la vez (3 de yerbas pendientes + entregados): códigos distintos y correlativos
    const codes = [];
    for (let round = 0; round < 3; round++) {
      const res = await all(3, () => yorder("c0", MANY));
      const okRes = res.filter((r) => r.ok);
      codes.push(...okRes.map((r) => r.val.public_code));
      // los paso a «listo» para liberar el límite de 3 pendientes
      for (const r of okRes) await run("admin", "select public.admin_set_order_status($1, 'listo') as r", [r.val.id]);
    }
    const sorted = [...codes].sort();
    check("9 pedidos simultáneos del mismo cliente → 9 códigos PV aleatorios distintos",
      codes.length === 9 && new Set(codes).size === 9 && codes.every(c => /^PV-[A-F0-9]{10}$/.test(c)), JSON.stringify(codes));
    const dupSeq = (await root.query("select public_code, count(*) from public.orders group by 1 having count(*) > 1")).rows;
    check("…sin números repetidos en la base", dupSeq.length === 0);

    // 2. La última unidad: 10 clientes a la vez → uno solo la consigue
    const race = await all(10, (i) => yorder("c" + (i + 1), LAST));
    const winners = race.filter((r) => r.ok), losers = race.filter((r) => !r.ok);
    check("última unidad: 10 a la vez → 1 pedido, 9 «insufficient_stock»", winners.length === 1 && losers.length === 9 && losers.every((r) => r.hint === "insufficient_stock"), JSON.stringify(losers.map((r) => r.e?.message).slice(0, 2)));
    const lastAvail = (await root.query("select stock from public.storefront_catalog where variant_id = $1", [LAST])).rows[0].stock;
    check("…disponible 0, stock físico intacto (1)", lastAvail === 0 && (await root.query("select stock from public.product_variants where id = $1", [LAST])).rows[0].stock === 1);
    const losersSeq = (await root.query("select count(*)::int n from public.orders where customer_id = any($1)", [Object.keys(users).slice(2, 11).map((k) => users[k])])).rows[0].n;
    check("…los rechazados no quedaron con pedidos ni números", losersSeq <= 1);

    // 3. 3 unidades, pedidos de 2 a la vez → nunca se vende de más
    const race2 = await all(4, (i) => yorder("c" + (i + 4), FEW, 2));
    const reserved = (await root.query("select coalesce(sum(i.quantity),0)::int s from public.order_items i join public.orders o on o.id = i.order_id where i.variant_id = $1 and o.status = 'pendiente'", [FEW])).rows[0].s;
    check("3 unidades, cuatro pedidos de 2 a la vez → solo 1 pasa (reservado 2 ≤ 3)", race2.filter((r) => r.ok).length === 1 && reserved === 2, JSON.stringify(race2.map((r) => r.ok)));

    // 4. La misma clave de intento dos veces a la vez (doble toque, reintento)
    const KEY = "cccccccc-1111-4111-8111-cccccccccccc";
    const dbl = await all(4, () => yorder("c11", MANY, 1, KEY));
    const ids = new Set(dbl.filter((r) => r.ok).map((r) => r.val.id));
    const nKey = (await root.query("select count(*)::int n from public.orders where client_key = $1", [KEY])).rows[0].n;
    check("misma clave 4 veces a la vez → un solo pedido; las otras respuestas lo devuelven", dbl.every((r) => r.ok) && ids.size === 1 && nKey === 1 && dbl.filter((r) => r.val.repeated).length === 3, JSON.stringify(dbl.map((r) => r.ok ? [r.val.id, !!r.val.repeated] : r.e.message)));

    // 5. Dos (o más) servidores de envío a la vez: cada envío lo toma uno solo
    for (let i = 0; i < 4; i++) await run("admin", "select public.admin_push_subscribe($1, $2, $3, $4) as r", [`https://web.push.apple.com/dev${i}abcdefghijklmnopqrstuv`, P256, AUTH, "Dispositivo " + i]);
    await new Promise((r) => setTimeout(r, 6000));   // los dispositivos existen antes que los pedidos (margen de 5 s del reparto)
    const newOrders = [];
    for (let i = 0; i < 6; i++) { const r = await yorder("c" + (i % 3 + 4), MANY); if (r.ok) newOrders.push(r.val.id); else console.log(r.e.message); }
    const claims = await all(5, () => run("service", "select public.push_claim(7) as r", []));
    const claimed = claims.flatMap((c) => c.ok ? c.val : []);
    const forNew = claimed.filter((r) => newOrders.map((id) => "order:" + id).includes(r.event_key));
    check("5 servidores a la vez → cada envío (pedido × dispositivo) se toma una sola vez", claims.every((c) => c.ok) && new Set(claimed.map((r) => r.id)).size === claimed.length, claims.filter((c) => !c.ok).map((c) => c.e.message).join(" | "));
    const rest = await run("service", "select public.push_claim(200) as r", []);
    const total = forNew.length + rest.val.filter((r) => newOrders.map((id) => "order:" + id).includes(r.event_key)).length;
    check("…entre todos cubren los 24 envíos (6 pedidos × 4 dispositivos), sin repetir", total === newOrders.length * 4 && newOrders.length === 6, `${total} de ${newOrders.length * 4}`);
    const allClaimed = [...claimed, ...rest.val];
    const reports = await all(3, () => run("service", "select public.push_report($1::jsonb) as r", [JSON.stringify(allClaimed.map((r) => ({ id: r.id, outcome: "enviado" })))]));
    check("…el mismo resultado informado 3 veces a la vez se aplica una vez", reports.reduce((s, r) => s + (r.val ?? 0), 0) === allClaimed.length, JSON.stringify(reports.map((r) => r.val)));
    const dupDeliveries = (await root.query("select event_id, subscription_id, count(*) from private.push_deliveries group by 1, 2 having count(*) > 1")).rows;
    check("…sin envíos duplicados en la base", dupDeliveries.length === 0);

    // 6. Vencimiento a las 12 h + varias tareas a la vez + avisos de reposición
    const p1 = await yorder("c11", FEW, 1);
    await run("c5", "select public.request_restock_alert($1) as r", [FEW]).catch(() => {});
    await root.query("update public.orders set created_at = now() - interval '13 hours', expires_at = now() - interval '1 hour' where kind = 'yerbas' and status = 'pendiente'");
    const runs = await all(5, (i) => run(i % 2 ? "service" : "admin", "select public.run_order_maintenance() as r", []));
    const cancelled = runs.flatMap((r) => r.ok ? r.val.cancelados : []);
    check("5 tareas a la vez → cada pendiente vencido se cancela una sola vez", runs.every((r) => r.ok) && cancelled.length === new Set(cancelled).size && cancelled.length > 0, runs.filter((r) => !r.ok).map((r) => r.e.message).join(" | "));
    const evDup = (await root.query("select order_id, count(*) from public.order_events where to_status = 'cancelado' group by 1 having count(*) > 1")).rows;
    check("…un solo evento de cancelación por pedido", evDup.length === 0);
    const restockEv = (await root.query("select count(*)::int n from private.push_events where kind = 'reposicion' and event_key like $1", [`restock:${FEW}:%`])).rows[0].n;
    check("…un solo aviso de reposición aunque corran 5 tareas", restockEv <= 1 && p1.ok);
    // Random-code reservation collides across independent concurrent transactions.
    const generator = (await root.query("select pg_get_functiondef('private.random_public_order_code()'::regprocedure) def")).rows[0].def;
    await root.query(`create or replace function private.random_public_order_code() returns text
      language plpgsql volatile set search_path='' as $$ begin
      if coalesce(current_setting('pov.test_collision',true),'') <> 'on' then
        perform set_config('pov.test_collision','on',true); return 'PV-CCCCCCCCCC';
      end if;
      return 'PV-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)); end $$`);
    const collisionRace = await all(16, () => run('postgres', 'insert into public.orders(item_count,total) values(1,100) returning public_code', []));
    await root.query(generator);
    check('16 concurrent forced collisions resolve to 16 unique codes',collisionRace.every(r=>r.ok)
      && new Set(collisionRace.map(r=>r.val)).size===16 && collisionRace.filter(r=>r.val==='PV-CCCCCCCCCC').length===1,
      JSON.stringify(collisionRace.filter(r=>!r.ok).map(r=>r.e.message)));

    const EMAIL = await mk('email-race',0);
    const subs = await all(12,i=>run('c'+i,'select public.request_restock_alert($1,true) r',[EMAIL]));
    check('12 concurrent email opt-ins created',subs.every(r=>r.ok));
    await root.query("insert into public.inventory_movements(variant_id,movement_type,quantity,reason) values($1,'entrada',1,'email test')",[EMAIL]);
    const emailClaims = await all(5,()=>run('service',"select public.restock_email_claim('avisos@povmatero.com',10) r",[]));
    const emailJobs = emailClaims.flatMap(r=>r.ok?r.val:[]);
    const expectedIds = subs.filter(r=>r.ok).map(r=>Number(r.val.id));
    check('5 email workers claim each request once',emailClaims.every(r=>r.ok) && new Set(emailJobs.map(j=>j.id)).size===emailJobs.length
      && emailJobs.filter(j=>expectedIds.includes(Number(j.id))).length===12,
      JSON.stringify(emailClaims.filter(r=>!r.ok).map(r=>r.e.message)));
    const acknowledgements = await all(3,async()=> {
      let n=0;
      for(const j of emailJobs) {const r=await run('service',"select public.restock_email_report($1,$2,'sent','fake-local') r",[j.id,j.token]); if(r.val)n++;}
      return n;
    });
    check('concurrent email acknowledgements apply once',acknowledgements.reduce((a,b)=>a+b,0)===emailJobs.length);
    const consistency = (await root.query(`select bool_and(v.stock = coalesce(m.s, 0)) ok from public.product_variants v
                                             left join (select variant_id, sum(quantity) s from public.inventory_movements group by 1) m on m.variant_id = v.id`)).rows[0].ok;
    check("consistencia final: stock físico = suma de movimientos", consistency === true);
  } catch (e) {
    console.error(e); fail++;
  } finally {
    await root.end().catch(() => {});
    await pg.stop().catch(() => {});
    if (path.dirname(path.resolve(DIR)) !== path.resolve(__dirname) || !path.basename(DIR).startsWith('pgdata-')) throw new Error('Unsafe test directory');
    fs.rmSync(DIR, { recursive: true, force: true });
  }
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})();
