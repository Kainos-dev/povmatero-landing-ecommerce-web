// Supabase simulado en memoria para las pruebas del panel (PostgREST + RPC +
// Storage). Nada sale a la red: las escrituras quedan en «st».
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const exp = Math.floor(Date.now() / 1000) + 3600;
const ADMIN = "99999999-9999-4999-8999-999999999999";
const SESSION = { access_token: `${b64({ alg: "HS256" })}.${b64({ sub: ADMIN, role: "authenticated", exp })}.x`, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: "r",
  user: { id: ADMIN, email: "admin@test.com", aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} } };
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co";

function catalogState() {
  const iso = (ms) => new Date(Date.now() + ms).toISOString();
  return {
    categories: [
      { id: 1, slug: "mates", name: "Mates", sort_order: 1, is_active: true },
      { id: 5, slug: "yerbas", name: "Yerbas", sort_order: 5, is_active: true },
    ],
    products: [
      { id: 61, category_id: 5, slug: "canarias-suave", name: "Canarias Suave", description: "Suave.", is_active: true, sort_order: 0, base_price: 13900, brand: "Canarias", shelf_image: null },
      { id: 3, category_id: 5, slug: "canarias-tradicional", name: "Canarias Tradicional", description: "", is_active: true, sort_order: 0, base_price: null, brand: "Canarias", shelf_image: null },
      { id: 46, category_id: 5, slug: "sara-tradicional", name: "Sara Tradicional", description: "", is_active: false, sort_order: 0, base_price: null, brand: "Sara", shelf_image: null },
      { id: 2, category_id: 1, slug: "mate-imperial", name: "Mate Imperial", description: "", is_active: true, sort_order: 0, base_price: 30000, brand: null, shelf_image: null },
    ],
    variants: [
      { id: 102, product_id: 61, name: "1kg", price: 13900, stock: 1, track_stock: true, is_active: true, sort_order: 0, price_inherited: true, cost_inherited: true, shelf_image: null },
      { id: 5, product_id: 3, name: "500gr", price: 5600, stock: 1, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
      { id: 6, product_id: 3, name: "1kg", price: 11600, stock: 1, track_stock: true, is_active: true, sort_order: 1, price_inherited: false, cost_inherited: false, shelf_image: null },
      { id: 79, product_id: 46, name: "500gr", price: 7500, stock: 0, track_stock: true, is_active: true, sort_order: 0, price_inherited: false, cost_inherited: false, shelf_image: null },
      { id: 21, product_id: 2, name: "Único", price: 30000, stock: 3, track_stock: true, is_active: true, sort_order: 0, price_inherited: true, cost_inherited: true, shelf_image: null },
    ],
    variant_internal: [{ variant_id: 5, sku: "2001", legacy_sheet_id: null }, { variant_id: 6, sku: "2002", legacy_sheet_id: null }],
    product_internal: [{ product_id: 61, sku: "2100", base_cost: 9000, legacy_id: null }, { product_id: 2, sku: "M-1", base_cost: 20000, legacy_id: null }],
    variant_costs: [{ variant_id: 102, cost: 9000 }, { variant_id: 5, cost: 4000 }, { variant_id: 6, cost: 8000 }, { variant_id: 21, cost: 20000 }],
    product_images: [],
    inventory_movements: [],
    operations: new Set(),
    uploads: [],
    orders: [],
    order_events: {},
    calls: [],      // [método, ruta, cuerpo]
    nextId: 900,
    failNext: null, // { path, method } → responde error de red una vez
    slow: 0,
    iso,
  };
}

function parseFilters(url) {
  const skip = new Set(["select", "order", "limit", "offset", "apikey", "on_conflict", "columns"]);
  const out = [];
  for (const [k, v] of url.searchParams) {
    if (skip.has(k)) continue;
    if (k === "or") { out.push({ or: v }); continue; }
    if (k.includes(".")) continue;   // filtros sobre tablas embebidas: se aplican aparte
    out.push({ k, v });
  }
  return out;
}
function match(row, filters) {
  return filters.every(({ k, v, or }) => {
    if (or) return true;
    const val = row[k];
    if (v.startsWith("eq.")) return String(val) === decodeURIComponent(v.slice(3));
    if (v.startsWith("neq.")) return String(val) !== v.slice(4);
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").map((x) => x.replace(/^"|"$/g, "")).includes(String(val));
    if (v === "is.null") return val == null;
    if (v === "not.is.null") return val != null;
    if (v.startsWith("gt.")) return val > v.slice(3);
    if (v.startsWith("gte.")) return val >= v.slice(4);
    return true;
  });
}

async function installMock(ctx, st, { extra } = {}) {
  await ctx.addInitScript((s) => { localStorage.setItem("sb-gubrehbalkfvzwsndbcv-auth-token", JSON.stringify(s)); localStorage.setItem("povmatero-no-track", "1"); }, SESSION);
  await ctx.route("**/api/track", (r) => r.fulfill({ status: 204 }));
  await ctx.route(SB + "/**", async (route) => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, m = req.method();
    const accept = req.headers()["accept"] ?? "";
    const wantsObject = accept.includes("vnd.pgrst.object");
    const body = () => { try { return JSON.parse(req.postData() || "null"); } catch { return null; } };
    const json = (b, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(b) });
    const err = (status, code, message, hint = null) => json({ code, message, hint, details: null }, status);
    const rows = (list, status = 200) => {
      if (wantsObject) return list.length ? json(list[0], status) : err(406, "PGRST116", "JSON object requested, multiple (or no) rows returned");
      return json(list, status);
    };
    if (m !== "GET" && m !== "HEAD") st.calls.push([m, p + (url.search ? "?" + [...url.searchParams].filter(([k]) => k !== "apikey").map(([k, v]) => `${k}=${v}`).join("&") : ""), body()]);
    if (st.slow && m !== "GET") await new Promise((r) => setTimeout(r, st.slow));
    if (st.failNext && p.endsWith(st.failNext.path) && m === st.failNext.method) { st.failNext = null; return route.abort("failed"); }

    if (extra) { const handled = extra({ route, req, url, p, m, body, json, err, rows, st }); if (handled !== undefined) return handled; }

    if (p === "/auth/v1/user") return json(SESSION.user);
    if (p.startsWith("/auth/")) return json({});
    if (p === "/rest/v1/admin_users") return rows([{ user_id: ADMIN, role: "owner" }]);

    // ---------- Storage ----------
    if (p.startsWith("/storage/v1/object/product-images/") && m === "POST") {
      const path = decodeURIComponent(p.slice("/storage/v1/object/product-images/".length));
      st.uploads.push({ path, type: req.headers()["content-type"], size: (req.postDataBuffer() ?? Buffer.alloc(0)).length });
      return json({ Key: "product-images/" + path, Id: "x" });
    }
    if (p.startsWith("/storage/")) return json([]);

    // ---------- RPC ----------
    if (p.startsWith("/rest/v1/rpc/")) {
      const fn = p.slice(13), a = body() ?? {};
      if (fn === "variant_commitments") return json([]);
      if (fn === "admin_stock_movement") {
        if (st.operations.has(a.operation_id)) return json({ operation_id: a.operation_id, repeated: true, movements: [] });
        st.operations.add(a.operation_id);
        const v = st.variants.find((x) => x.id === a.variant_id);
        const q = a.movement_type === "salida" ? -a.quantity : a.quantity;
        v.stock += q;
        const mv = { id: st.inventory_movements.length + 1, variant_id: v.id, movement_type: a.movement_type, quantity: q, stock_after: v.stock, reason: a.reason, reference: a.reference, created_at: new Date().toISOString() };
        st.inventory_movements.unshift(mv);
        return json({ operation_id: a.operation_id, stock_after: v.stock, movements: [mv] });
      }
      return json(null);
    }

    // ---------- Tablas ----------
    const table = p.replace("/rest/v1/", "");
    const filters = parseFilters(url);
    const sel = url.searchParams.get("select") ?? "";
    const prodOf = (id) => st.products.find((x) => x.id === id);
    const catOf = (id) => st.categories.find((x) => x.id === id);

    if (table === "categories") return rows(st.categories.filter((r) => match(r, filters)));
    if (table === "products") {
      if (m === "GET") {
        let list = st.products.filter((r) => match(r, filters));
        if (sel.includes("product_variants")) list = list.map((pr) => ({ ...pr, product_variants: st.variants.filter((v) => v.product_id === pr.id) }));
        return rows(list.sort((a, b) => a.name.localeCompare(b.name)));
      }
      if (m === "POST") {
        const b = body();
        if (st.products.some((x) => x.slug === b.slug)) return err(409, "23505", 'duplicate key value violates unique constraint "products_slug_key"');
        const row = { id: st.nextId++, description: "", is_active: false, sort_order: 0, base_price: null, brand: null, shelf_image: null, ...b };
        st.products.push(row);
        return rows([{ id: row.id }], 201);
      }
      if (m === "PATCH") {
        const list = st.products.filter((r) => match(r, filters));
        list.forEach((r) => Object.assign(r, body()));
        return rows(list.map((r) => ({ id: r.id, shelf_image: r.shelf_image })));
      }
      if (m === "DELETE") return rows([]);
    }
    if (table === "product_variants") {
      if (m === "GET") {
        let list = st.variants.filter((r) => match(r, filters));
        if (sel.includes("product:products")) {
          list = list.map((v) => { const pr = prodOf(v.product_id); return { ...v, product: { ...pr, category: catOf(pr.category_id) } }; });
          const slugF = url.searchParams.get("product.category.slug");
          if (slugF) list = list.filter((v) => `eq.${v.product.category.slug}` === slugF);
        }
        return rows(list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id));
      }
      if (m === "POST") {
        const b = body();
        if (st.variants.some((x) => x.product_id === b.product_id && x.name === b.name)) return err(409, "23505", 'duplicate key value violates unique constraint "product_variants_product_id_name_key"');
        const pr = prodOf(b.product_id);
        const row = { id: st.nextId++, stock: 0, track_stock: true, is_active: true, sort_order: 0, price_inherited: true, cost_inherited: true, shelf_image: null, ...b };
        if (pr.base_price != null) row.price_inherited = row.price === pr.base_price;   // como el trigger
        st.variants.push(row);
        return rows([{ id: row.id }], 201);
      }
      if (m === "PATCH") {
        const list = st.variants.filter((r) => match(r, filters));
        const b = body();
        if (b.name && st.variants.some((x) => list[0] && x.product_id === list[0].product_id && x.id !== list[0].id && x.name === b.name)) return err(409, "23505", 'duplicate key value violates unique constraint "product_variants_product_id_name_key"');
        list.forEach((r) => Object.assign(r, b));
        return rows(list.map((r) => ({ id: r.id, shelf_image: r.shelf_image })));
      }
    }
    if (table === "variant_internal") {
      if (m === "GET") {
        let list = st.variant_internal.filter((r) => match(r, filters));
        if (sel.includes("variant:product_variants")) list = list.map((r) => { const v = st.variants.find((x) => x.id === r.variant_id); return { ...r, variant: v ? { name: v.name, product_id: v.product_id, product: { name: prodOf(v.product_id).name } } : null }; });
        return rows(list);
      }
      if (m === "POST") {
        const b = body();
        if (b.sku && st.variant_internal.some((x) => x.sku === b.sku && x.variant_id !== b.variant_id)) return err(409, "23505", 'duplicate key value violates unique constraint "variant_internal_sku_key"');
        const prev = st.variant_internal.find((x) => x.variant_id === b.variant_id);
        if (prev) Object.assign(prev, b); else st.variant_internal.push({ legacy_sheet_id: null, ...b });
        return rows([{ variant_id: b.variant_id }], 201);
      }
    }
    if (table === "product_internal") {
      if (m === "GET") {
        let list = st.product_internal.filter((r) => match(r, filters));
        if (sel.includes("product:products")) list = list.map((r) => ({ ...r, product: { name: prodOf(r.product_id)?.name } }));
        return rows(list);
      }
      if (m === "POST") {
        const b = body();
        const prev = st.product_internal.find((x) => x.product_id === b.product_id);
        if (prev) Object.assign(prev, b); else st.product_internal.push({ sku: null, base_cost: null, ...b });
        return rows([{ product_id: b.product_id }], 201);
      }
    }
    if (table === "variant_costs") {
      if (m === "GET") return rows(st.variant_costs.filter((r) => match(r, filters)));
      if (m === "PATCH") { const list = st.variant_costs.filter((r) => match(r, filters)); list.forEach((r) => Object.assign(r, body())); return rows(list.map((r) => ({ variant_id: r.variant_id }))); }
      if (m === "POST") { const b = body(); st.variant_costs.push(b); const v = st.variants.find((x) => x.id === b.variant_id); return rows([b], 201); }
      if (m === "DELETE") { st.variant_costs = st.variant_costs.filter((r) => !match(r, filters)); return rows([]); }
    }
    if (table === "product_images") {
      const list = st.product_images.filter((r) => match(r, filters));
      if (m === "PATCH") { list.forEach((r) => Object.assign(r, body())); return rows(list.map((r) => ({ id: r.id }))); }
      return rows(list);
    }
    if (table === "inventory_movements") {
      if (m === "HEAD") return route.fulfill({ status: 200, headers: { "content-range": "*/0" }, body: "" });
      return rows(st.inventory_movements.filter((r) => match(r, filters)));
    }
    if (table === "storefront_catalog") return rows([]);
    return rows([]);
  });
}

module.exports = { installMock, catalogState, SESSION, SB, ADMIN };
