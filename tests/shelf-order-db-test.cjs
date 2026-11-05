// 20261113: orden de góndolas, «Otras marcas» y orden de yerbas (PGlite, en
// memoria; nunca toca Supabase). Aplica todas las migraciones anteriores, carga
// un catálogo parecido al real y recién ahí aplica la nueva.
const { PGlite } = require(process.env.PW + "/node_modules/@electric-sql/pglite");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const NEW = "20261113000000_shelf_order.sql";
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
const U = { ana: "11111111-1111-4111-8111-111111111111", admin: "99999999-9999-4999-8999-999999999999" };

let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };

(async () => {
  const db = new PGlite();
  const q = (sql, p) => db.query(sql, p);
  const one = async (sql, p) => (await q(sql, p)).rows[0];
  async function as(user) {
    if (!user) { await db.exec("reset role"); await q("select set_config('request.jwt.claims', '', false)"); return; }
    if (user === "anon") { await db.exec("set role anon"); await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ role: "anon" })]); return; }
    await db.exec("set role authenticated");
    await q("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: U[user], role: "authenticated" })]);
  }
  async function call(user, sql, p) {
    await as(user);
    try { const r = await q(sql, p); return { ok: true, rows: r.rows, val: r.rows[0] && Object.values(r.rows[0])[0] }; }
    catch (e) { return { ok: false, msg: e.message, hint: e.hint, code: e.code }; }
    finally { await as(null); }
  }

  await db.exec(STUB);
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < NEW)) await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
  for (const [k, id] of Object.entries(U)) await q("insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)", [id, k + "@t.com", JSON.stringify({ first_name: k, phone: "11 5555-0000" })]);
  await q("insert into public.admin_users (user_id) values ($1)", [U.admin]);
  const Y = (await one("select id from public.categories where slug = 'yerbas'")).id;
  const MATES = (await one("select id from public.categories where slug = 'mates'")).id;

  // Catálogo de prueba (marcas como las cargadas hoy, con escrituras distintas)
  const P = {}, V = {};
  let n = 0;
  const seed = [
    // nombre, marca, publicada, sort_order, presentaciones
    ["Canarias Serena", "canarias ", true, 5, [["1kg", 12000, 4]]],
    ["Canarias Tradicional", "Canarias", true, 0, [["500gr", 5600, 3], ["1kg", 11600, 6]]],
    ["Canarias Suave", "Canarias", false, 0, [["1kg", 13900, 0]]],
    ["Sara Coco", "Sara", true, 0, [["500gr", 8000, 5]]],
    ["Baldo Tradicional", "Baldo", true, 0, [["1kg", 11300, 2]]],
    ["Rei Verde Tradicional", "Rei  Verde", true, 0, [["1kg", 9000, 2]]],
    ["Armiño Clásica", "Armiño", true, 0, [["500gr", 4000, 2]]],
    ["Pindaré", null, true, 0, [["500gr", 4500, 1]]],
    ["Verdecita", null, true, 1, [["1kg", 7000, 1]]],
  ];
  for (const [name, brand, active, sort, variants] of seed) {
    const p = await one("insert into public.products (category_id, slug, name, brand, is_active, sort_order) values ($1, $2, $3, $4, $5, $6) returning id", [Y, `y-${++n}`, name, brand, active, sort]);
    P[name] = Number(p.id);
    for (const [vn, price, st] of variants) {
      const v = await one("insert into public.product_variants (product_id, name, price) values ($1, $2, $3) returning id", [p.id, vn, price]);
      V[`${name}|${vn}`] = Number(v.id);
      if (st) await q("insert into public.inventory_movements (variant_id, movement_type, quantity, reason) values ($1, 'entrada', $2, 'carga')", [v.id, st]);
    }
  }
  P.mate = Number((await one("insert into public.products (category_id, slug, name, brand, is_active) values ($1, 'mate', 'Mate Imperial', 'Imperial', true) returning id", [MATES])).id);
  await q("insert into public.product_variants (product_id, name, price) values ($1, 'Único', 30000)", [P.mate]);

  // Un pedido de yerbas antes (comprometido) para ver que nada cambia
  const before = await call("ana", "select public.create_yerba_order($1::jsonb, null) as r", [JSON.stringify([{ variant_id: V["Sara Coco|500gr"], quantity: 2 }])]);
  check("antes: se crea un pedido de yerbas", before.ok, before.msg);
  const snapshot = async () => JSON.stringify((await q(`select
      (select json_agg(t order by id) from (select id, product_id, name, price, stock, track_stock, is_active, sort_order, shelf_image from public.product_variants) t) v,
      (select json_agg(t order by id) from (select id, variant_id, quantity, movement_type from public.inventory_movements) t) m,
      (select json_agg(t order by id) from (select id, status, total from public.orders) t) o,
      (select json_agg(t order by variant_id) from public.variant_costs t) c,
      (select json_agg(t order by id) from (select id, name, slug, base_price, is_active, sort_order, shelf_image, description from public.products) t) p`)).rows[0]);
  const snap0 = await snapshot();
  const viewCols = async () => (await q("select column_name, data_type from information_schema.columns where table_schema='public' and table_name='storefront_catalog' order by ordinal_position")).rows;
  const cols0 = await viewCols();

  // SQL de controles «antes»: corre sin errores y da todo true
  const runChecks = async (file) => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase/checks", file), "utf8");
    const parts = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
    const out = [];
    for (const p of parts) out.push((await q(p)).rows);
    return out;
  };
  const pre = await runChecks("20261113_antes_orden_gondolas.sql");
  check("controles antes: requisitos todos true", Object.values(pre[0][0]).every((x) => x === true), JSON.stringify(pre[0][0]));
  const preBrands = pre[1].map((r) => `${r.posicion}.${r.nombre}`).join(" ");
  check("controles antes: vista previa del orden (Canarias, Rei Verde, Sara, Armiño, Baldo)", preBrands === "1.Canarias 2.Rei Verde 3.Sara 4.Armiño 5.Baldo", preBrands);
  check("controles antes: muestra las escrituras que se unifican", /canarias \(1\)/.test(pre[1][0].escrituras) || /canarias/.test(pre[1][0].escrituras), pre[1][0].escrituras);

  // ---------- Migración ----------
  try { await db.exec(fs.readFileSync(path.join(MIG, NEW), "utf8")); check("se aplica " + NEW, true); }
  catch (e) { check("se aplica " + NEW, false, e.message); throw e; }

  const post = await runChecks("20261113_despues_orden_gondolas.sql");
  check("controles después: estructura y permisos todos true", Object.values(post[0][0]).every((x) => x === true), JSON.stringify(post[0][0]));
  check("controles después: datos todos true", Object.values(post[1][0]).every((x) => x === true), JSON.stringify(post[1][0]));
  check("controles después: el resumen coincide con el de antes", JSON.stringify(pre[3]) === JSON.stringify(post[4]), JSON.stringify([pre[3], post[4]]));

  const brands = async () => (await q("select key, name, position from public.shelf_brands order by position")).rows;
  let b = await brands();
  check("marcas: orden inicial = el de hoy", b.map((x) => x.name).join(",") === "Canarias,Rei Verde,Sara,Armiño,Baldo", JSON.stringify(b));
  check("marcas: la marca del mate (otra categoría) no crea góndola", !b.some((x) => x.name === "Imperial"));
  const brandOf = async (id) => (await one("select brand, shelf_other, shelf_position from public.products where id = $1", [id]));
  check("marcas: «canarias » quedó como «Canarias»", (await brandOf(P["Canarias Serena"])).brand === "Canarias");
  check("marcas: «Rei  Verde» quedó como «Rei Verde»", (await brandOf(P["Rei Verde Tradicional"])).brand === "Rei Verde");
  check("marcas: las yerbas sin marca siguen sin marca", (await brandOf(P["Pindaré"])).brand === null);
  check("datos: precios, stock, presentaciones, pedidos, costos e imágenes sin cambios", (await snapshot()) === snap0);
  const cols1 = await viewCols();
  check("vista: las 18 columnas de antes iguales y 3 nuevas al final",
    JSON.stringify(cols1.slice(0, 18)) === JSON.stringify(cols0) && cols1.slice(18).map((c) => c.column_name).join(",") === "shelf_other,shelf_position,brand_position", JSON.stringify(cols1.slice(18)));

  const group = async (key) => (await q(
    "select id from public.products where category_id = $1 and (case when shelf_other or brand is null then '' else public.shelf_brand_key(brand) end) = $2 order by shelf_position, id", [Y, key])).rows.map((r) => Number(r.id));
  check("lugares: Canarias por sort_order e id (Tradicional, Suave, Serena)",
    JSON.stringify(await group("canarias")) === JSON.stringify([P["Canarias Tradicional"], P["Canarias Suave"], P["Canarias Serena"]]), JSON.stringify(await group("canarias")));
  check("lugares: Otras marcas (Pindaré, Verdecita)", JSON.stringify(await group("")) === JSON.stringify([P["Pindaré"], P["Verdecita"]]));

  // Tienda (anon): vista con los datos nuevos
  let r = await call("anon", "select product_name, brand, shelf_other, shelf_position, brand_position from public.storefront_catalog where category_slug = 'yerbas' order by brand_position nulls last, shelf_position, variant_sort");
  check("tienda: anon lee la vista con orden de marca y de yerba", r.ok && r.rows.length > 0 && r.rows[0].brand === "Canarias" && r.rows[0].brand_position === 1, r.msg ?? JSON.stringify(r.rows[0]));
  check("tienda: borradores no aparecen (Canarias Suave)", r.ok && !r.rows.some((x) => x.product_name === "Canarias Suave"));
  r = await call("anon", "select key, name, position from public.shelf_brands");
  check("tienda: anon lee las marcas", r.ok && r.rows.length === 5);

  // ---------- Permisos ----------
  r = await call("anon", "update public.products set shelf_other = true where id = $1", [P["Sara Coco"]]);
  check("permisos: anon no cambia «Otras marcas»", !r.ok, r.msg);
  r = await call("anon", "insert into public.shelf_brands (key, name, position) values ('x', 'X', 99)");
  check("permisos: anon no crea marcas", !r.ok);
  r = await call("anon", "select public.admin_set_shelf_brand_order($1, $2)", [["a"], ["a"]]);
  check("permisos: anon no puede llamar a la función de orden de marcas", !r.ok && /permission denied/.test(r.msg), r.msg);
  r = await call("anon", "select public.admin_set_shelf_product_order('canarias', $1, $2)", [[1], [1]]);
  check("permisos: anon no puede llamar a la función de orden de yerbas", !r.ok && /permission denied/.test(r.msg), r.msg);
  const keys = (await brands()).map((x) => x.key);
  r = await call("ana", "select public.admin_set_shelf_brand_order($1, $2)", [keys.slice().reverse(), keys]);
  check("permisos: un cliente con cuenta no ordena (admin_only)", !r.ok && r.hint === "admin_only", r.msg);
  r = await call("ana", "update public.products set shelf_other = true where id = $1 returning id", [P["Sara Coco"]]);
  check("permisos: un cliente no cambia la casilla (RLS: 0 filas)", !r.ok || r.rows.length === 0);
  r = await call("admin", "update public.shelf_brands set position = 9 where key = 'sara'");
  check("permisos: ni un admin escribe directo en shelf_brands", !r.ok, r.msg);
  r = await call("admin", "update public.products set shelf_position = 1 where id = $1", [P["Canarias Serena"]]);
  check("permisos: ni un admin escribe directo el lugar (solo por la función)", !r.ok, r.msg);

  // ---------- Orden de góndolas ----------
  const order1 = ["canarias", "sara", "reiverde", "baldo", "armino"];
  r = await call("admin", "select public.admin_set_shelf_brand_order($1, $2) as r", [order1, keys]);
  check("góndolas: el admin guarda Canarias, Sara, Rei Verde, Baldo, Armiño", r.ok && (await brands()).map((x) => x.key).join() === order1.join(), r.msg);
  check("góndolas: devuelve cuántas cambiaron (4)", r.ok && r.val.changed === 4, JSON.stringify(r.val));
  r = await call("admin", "select public.admin_set_shelf_brand_order($1, $2) as r", [keys, keys]);
  check("góndolas: con el orden viejo a la vista → stale_order, sin cambios", !r.ok && r.hint === "stale_order" && (await brands()).map((x) => x.key).join() === order1.join(), r.msg);
  for (const [label, bad] of [["falta una", order1.slice(1)], ["repetida", [...order1.slice(0, 4), "sara"]], ["desconocida", [...order1.slice(0, 4), "zzz"]], ["nula", [...order1.slice(0, 4), null]]]) {
    r = await call("admin", "select public.admin_set_shelf_brand_order($1, $2) as r", [bad, order1]);
    check(`góndolas: lista inválida (${label}) → invalid_order`, !r.ok && r.hint === "invalid_order", r.msg);
  }
  r = await call("anon", "select distinct brand, brand_position from public.storefront_catalog where brand is not null and category_slug = 'yerbas' order by brand_position");
  check("góndolas: la tienda ve el orden nuevo", r.ok && r.rows.map((x) => x.brand).join(",") === "Canarias,Sara,Rei Verde,Baldo,Armiño", JSON.stringify(r.rows));

  // ---------- Marcas nuevas y escrituras equivalentes ----------
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'kurupi', 'Kurupí Menta', 'Kurupí') returning id, brand, shelf_position", [Y]);
  check("marca nueva: se registra al final, sin mover las otras", r.ok && (await brands()).map((x) => x.key).join() === [...order1, "kurupi"].join() && (await brands()).at(-1).name === "Kurupí", r.msg);
  P.kurupi = Number(r.rows[0].id);
  check("marca nueva: la yerba queda primera de su góndola", r.rows[0].shelf_position === 1);
  for (const spelling of ["KURUPI", "  kurupí ", "Kuru-pí"]) {
    r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, $2, $3, $4) returning brand", [Y, `k-${spelling.length}-${Math.random().toString(36).slice(2, 6)}`, `Kurupí ${spelling}`, spelling]);
    check(`marca equivalente «${spelling}» → «Kurupí», sin marca nueva`, r.ok && r.rows[0].brand === "Kurupí" && (await brands()).length === 6, r.msg ?? r.rows[0].brand);
  }
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'canarias-x', 'Canarias X', 'CANARIAS') returning id, brand, shelf_position", [Y]);
  check("marca existente en mayúsculas → «Canarias», al final de su góndola (4)", r.ok && r.rows[0].brand === "Canarias" && r.rows[0].shelf_position === 4, JSON.stringify(r.rows?.[0] ?? r.msg));
  P.canariasX = Number(r.rows[0].id);
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'raro', 'Raro', '¡!') returning id", [Y]);
  check("marca sin letras ni números → rechazada (invalid_brand)", !r.ok && r.hint === "invalid_brand", r.msg);
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'vacia', 'Vacía', '   ') returning brand, shelf_position", [Y]);
  check("marca en blanco → sin marca («Otras marcas», al final: 3)", r.ok && r.rows[0].brand === null && r.rows[0].shelf_position === 3, JSON.stringify(r.rows?.[0] ?? r.msg));
  P.vacia = Number(r.rows[0].id);
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'mate-2', 'Mate 2', 'OtraMarca') returning brand", [MATES]);
  check("producto de otra categoría con marca: no crea góndola", r.ok && (await brands()).length === 6);

  // ---------- Casilla «Otras marcas» ----------
  const serena = P["Canarias Serena"];
  const posBefore = (await brandOf(serena)).shelf_position;
  r = await call("admin", "update public.products set shelf_other = true where id = $1 returning brand, shelf_other, shelf_position", [serena]);
  check("Otras marcas: marcada → al final de «Otras marcas», conserva la marca", r.ok && r.rows[0].brand === "Canarias" && r.rows[0].shelf_other && JSON.stringify(await group("")).endsWith(`${serena}]`), JSON.stringify(r.rows?.[0] ?? r.msg));
  check("Otras marcas: ya no está en la góndola Canarias", !(await group("canarias")).includes(serena));
  r = await call("anon", "select distinct product_id, brand, shelf_other from public.storefront_catalog where product_id = $1", [serena]);
  check("Otras marcas: la tienda ve la marca real y la casilla", r.ok && r.rows[0].brand === "Canarias" && r.rows[0].shelf_other === true);
  // Otra Canarias sigue en su góndola (configuración individual)
  check("Otras marcas: las demás Canarias siguen en su góndola", (await group("canarias")).includes(P["Canarias Tradicional"]));
  r = await call("admin", "update public.products set shelf_other = false where id = $1 returning shelf_position", [serena]);
  check("Otras marcas: desmarcada → vuelve a Canarias, al final", r.ok && (await group("canarias")).at(-1) === serena && r.rows[0].shelf_position !== posBefore || (await group("canarias")).at(-1) === serena, JSON.stringify(await group("canarias")));
  // Sin marca + casilla: sigue en Otras marcas, sin moverse
  const pinPos = (await brandOf(P["Pindaré"])).shelf_position;
  r = await call("admin", "update public.products set shelf_other = true where id = $1 returning shelf_position", [P["Pindaré"]]);
  check("Otras marcas: en una yerba sin marca no la mueve de lugar", r.ok && r.rows[0].shelf_position === pinPos);
  await call("admin", "update public.products set shelf_other = false where id = $1", [P["Pindaré"]]);

  // Cambiar de marca → al final de la de destino
  r = await call("admin", "update public.products set brand = 'sara' where id = $1 returning brand", [P.canariasX]);
  check("cambio de marca: «sara» → «Sara», al final de Sara", r.ok && r.rows[0].brand === "Sara" && (await group("sara")).at(-1) === P.canariasX, JSON.stringify(await group("sara")));
  // Editar otros datos no mueve
  const g0 = JSON.stringify(await group("canarias"));
  await call("admin", "update public.products set name = 'Canarias Tradicional (edit)', base_price = 6000, sort_order = 99 where id = $1", [P["Canarias Tradicional"]]);
  await call("admin", "update public.products set brand = 'Canarias' where id = $1", [P["Canarias Tradicional"]]);
  await call("admin", "update public.products set brand = 'canarias' where id = $1", [P["Canarias Tradicional"]]);
  check("editar nombre, precio, orden o reescribir la misma marca no cambia el lugar", JSON.stringify(await group("canarias")) === g0);
  await call("admin", "update public.products set name = 'Canarias Tradicional', base_price = null, sort_order = 0 where id = $1", [P["Canarias Tradicional"]]);

  // ---------- Orden de yerbas ----------
  const can = await group("canarias");
  const wanted = [can[2], can[0], can[1]];
  r = await call("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2) as r", [wanted, can]);
  check("yerbas: el admin reordena Canarias", r.ok && JSON.stringify(await group("canarias")) === JSON.stringify(wanted), r.msg);
  r = await call("anon", "select product_id, variant_name, shelf_position from public.storefront_catalog where brand = 'Canarias' and not shelf_other order by shelf_position, variant_sort");
  const ids = [...new Set(r.rows.map((x) => Number(x.product_id)))];
  check("yerbas: la tienda las ve en ese orden (sin el borrador)", JSON.stringify(ids) === JSON.stringify(wanted.filter((id) => id !== P["Canarias Suave"])), JSON.stringify(ids));
  const tr = r.rows.filter((x) => Number(x.product_id) === P["Canarias Tradicional"]);
  check("yerbas: 500 g y 1 kg de la misma yerba comparten lugar (juntas)", tr.length === 2 && tr[0].shelf_position === tr[1].shelf_position);
  r = await call("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2) as r", [can, can]);
  check("yerbas: con el orden viejo a la vista → stale_order", !r.ok && r.hint === "stale_order", r.msg);
  r = await call("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2) as r", [[...wanted, P["Sara Coco"]], wanted]);
  check("yerbas: una yerba de otra góndola → invalid_order", !r.ok && r.hint === "invalid_order", r.msg);
  r = await call("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2) as r", [[wanted[0], wanted[0], wanted[1]], wanted]);
  check("yerbas: repetida → invalid_order", !r.ok && r.hint === "invalid_order", r.msg);
  r = await call("admin", "select public.admin_set_shelf_product_order('canarias', $1, $2) as r", [[P.mate, wanted[0], wanted[1]], wanted]);
  check("yerbas: un producto que no es yerba → invalid_order", !r.ok && r.hint === "invalid_order", r.msg);

  // Otras marcas: marcas reales distintas, se ordenan juntas
  await call("admin", "update public.products set shelf_other = true where id = $1", [P["Baldo Tradicional"]]);
  const oth = await group("");
  check("Otras marcas: reúne yerbas sin marca y con marca (Baldo)", oth.includes(P["Baldo Tradicional"]) && oth.includes(P["Pindaré"]) && oth.at(-1) === P["Baldo Tradicional"]);
  const othWanted = [P["Baldo Tradicional"], ...oth.filter((x) => x !== P["Baldo Tradicional"])];
  r = await call("admin", "select public.admin_set_shelf_product_order('', $1, $2) as r", [othWanted, oth]);
  check("Otras marcas: se ordena (Baldo primero)", r.ok && JSON.stringify(await group("")) === JSON.stringify(othWanted), r.msg);
  r = await call("admin", "select public.admin_set_shelf_product_order(null, $1, $2) as r", [othWanted, othWanted]);
  check("Otras marcas: group_key null = «Otras marcas»", r.ok && r.val.changed === 0, r.msg);
  // Baldo sin yerbas propias: su fila sigue y conserva lugar
  check("marca sin yerbas propias: conserva su lugar en el orden", (await brands()).some((x) => x.key === "baldo"));
  r = await call("anon", "select count(*) n from public.storefront_catalog where brand = 'Baldo' and not shelf_other");
  check("marca sin yerbas propias: no tiene filas de góndola propia (la tienda no la muestra)", Number(r.rows[0].n) === 0);

  // Yerba nueva → al final de su grupo, sin cambiar el orden existente
  const sara0 = await group("sara");
  r = await call("admin", "insert into public.products (category_id, slug, name, brand, shelf_other) values ($1, 'sara-nueva', 'Sara Nueva', 'Sara', false) returning id", [Y]);
  const sara1 = await group("sara");
  check("yerba nueva: al final de su góndola, el resto igual", r.ok && JSON.stringify(sara1.slice(0, -1)) === JSON.stringify(sara0) && sara1.at(-1) === Number(r.rows[0].id));
  r = await call("admin", "insert into public.products (category_id, slug, name, brand, shelf_other) values ($1, 'canarias-otras', 'Canarias Otras', 'Canarias', true) returning id", [Y]);
  check("yerba nueva con «Otras marcas»: al final de «Otras marcas»", r.ok && (await group("")).at(-1) === Number(r.rows[0].id));

  // Compatibilidad con el panel publicado y con los pedidos
  r = await call("admin", "select id, category_id, slug, name, description, is_active, sort_order, base_price, brand from public.products order by id");
  check("compatibilidad: el panel publicado lee productos como siempre", r.ok);
  r = await call("ana", "select public.create_yerba_order($1::jsonb, null) as r", [JSON.stringify([{ variant_id: V["Canarias Tradicional|1kg"], quantity: 1 }])]);
  check("compatibilidad: los pedidos de yerbas siguen funcionando", r.ok, r.msg);
  const dupes = await one(`select count(*) n from (select category_id, case when shelf_other or brand is null then '' else public.shelf_brand_key(brand) end g, shelf_position
    from public.products where category_id = $1 group by 1, 2, 3 having count(*) > 1) x`, [Y]);
  check("integridad: ningún lugar repetido dentro de una góndola", Number(dupes.n) === 0);
  const post2 = await runChecks("20261113_despues_orden_gondolas.sql");
  check("controles después (tras las pruebas): siguen todos true", Object.values(post2[0][0]).every((x) => x === true) && Object.entries(post2[1][0]).every(([k, x]) => x === true || k === "casilla_desmarcada"), JSON.stringify([post2[0][0], post2[1][0]]));

  // Se aplica una sola vez
  let again = true;
  try { await db.exec(fs.readFileSync(path.join(MIG, NEW), "utf8")); } catch { again = false; await db.exec("rollback").catch(() => {}); }
  check("la migración no se puede aplicar dos veces", !again);

  // ---------- Reversión de emergencia ----------
  const ROLLBACK = fs.readFileSync(path.join(ROOT, "supabase/rollbacks/20261113_revertir_orden_gondolas.sql"), "utf8");
  const pricesBefore = JSON.stringify((await q("select id, price, stock from public.product_variants order by id")).rows);
  try { await db.exec(ROLLBACK); check("reversión: se aplica", true); } catch (e) { check("reversión: se aplica", false, e.message); }
  check("reversión: la vista vuelve a sus 18 columnas de antes", JSON.stringify(await viewCols()) === JSON.stringify(cols0));
  r = await call("anon", "select product_id, brand, shelf_image, variant_shelf_image from public.storefront_catalog where category_slug = 'yerbas'");
  check("reversión: la tienda lee la vista (consulta de antes)", r.ok && r.rows.length > 0, r.msg);
  r = await call("anon", "select shelf_position from public.storefront_catalog");
  check("reversión: la consulta nueva falla (el sitio usa la de antes solo)", !r.ok);
  check("reversión: precios y stock sin cambios", JSON.stringify((await q("select id, price, stock from public.product_variants order by id")).rows) === pricesBefore);
  r = await call("admin", "insert into public.products (category_id, slug, name, brand) values ($1, 'post-rev', 'Post Rev', 'Nueva') returning id", [Y]);
  check("reversión: el panel de antes sigue creando yerbas", r.ok, r.msg);
  try { await db.exec(fs.readFileSync(path.join(MIG, NEW), "utf8")); check("reversión: la migración se puede volver a aplicar", true); }
  catch (e) { check("reversión: la migración se puede volver a aplicar", false, e.message); }

  console.log(`\n${ok} OK, ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
