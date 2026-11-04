// Compatibilidad del código de dev con el esquema REAL de Supabase, sin datos:
// todo se pide con la clave pública y sin sesión (rol anon). Supabase rechaza
// por permisos ANTES de ejecutar nada, así que no se lee ni escribe ningún dato
// privado. Si un nombre (tabla, columna, función o parámetro) estuviera mal,
// la respuesta sería «no existe» (42703 / PGRST202 / PGRST205), no «sin permiso».
const SB = "https://gubrehbalkfvzwsndbcv.supabase.co/rest/v1";
const KEY = "sb_publishable_cMxTBYTgJm1wQ2FkJ37uZg_XNyogu7M";
const H = { apikey: KEY, "Content-Type": "application/json" };
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
const denied = (j) => j?.code === "42501";

async function sel(table, cols) {
  const r = await fetch(`${SB}/${table}?select=${encodeURIComponent(cols)}&limit=0`, { headers: H });
  return { status: r.status, j: await r.json().catch(() => null) };
}
// Llamada sin permiso: con anon, la base la rechaza antes de ejecutarla.
async function rpc(fn, args) {
  const r = await fetch(`${SB}/rpc/${fn}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  return { status: r.status, j: await r.json().catch(() => null) };
}

(async () => {
  // Lo que lee la tienda y /yerbas sin sesión (permitido para anon, 0 filas)
  for (const [t, cols] of [
    ["storefront_catalog", "product_id,product_slug,product_name,brand,cover_image,variant_id,variant_name,price,track_stock,stock,variant_image,product_sort,variant_sort,shelf_image,variant_shelf_image,description,category_slug,category_name"],
    ["product_images", "product_id,src,is_cover,sort_order"],
    ["categories", "slug,sort_order"],
  ]) { const r = await sel(t, cols); check(`anon lee ${t} (columnas de dev)`, r.status === 200, JSON.stringify(r.j)); }

  // Tablas y columnas que usa dev con sesión: tienen que EXISTIR (anon: sin permiso)
  for (const [t, cols] of [
    ["restock_requests", "variant_id,status,product_id,user_id,email,created_at,notified_at,cancelled_at"],
    ["supplier_orders", "id,supplier,note,status,created_at,received_at,cancelled_at,client_key"],
    ["supplier_order_items", "id,supplier_order_id,variant_id,product_name,variant_name,quantity,received_quantity"],
    ["stock_operations", "id,variant_id,movement_type,quantity,reason,reference,source,stock_before,reserved,declared_physical,adjustment,stock_after,shortage,created_by,created_at"],
    ["stock_shortages", "id,variant_id,operation_id,physical,reserved,missing,status,created_at,resolved_at,resolution"],
    ["inventory_movements", "id,variant_id,movement_type,quantity,stock_after,unit_cost,reason,reference,created_by,created_at,order_id,supplier_order_id,operation_id"],
    ["orders", "id,created_at,updated_at,kind,status,expires_at,status_changed_at,stock_applied,customer_id,customer_name,customer_email,customer_phone,item_count,total,channel,client_key,ready_at,delivered_at,auto_delivered,auto_deliver"],
    ["order_events", "id,event,from_status,to_status,detail,created_at,created_by"],
    ["customer_profiles", "user_id,first_name,last_name,email,phone,created_at"],
  ]) {
    const r = await sel(t, cols);
    check(`existe ${t} con todas las columnas que usa dev`, denied(r.j) || r.status === 200, JSON.stringify(r.j));
  }
  // Control: una columna inventada tiene que dar «no existe» (prueba que el método distingue)
  const bad = await sel("orders", "id,columna_que_no_existe");
  check("control: una columna inexistente se detecta (42703)", bad.j?.code === "42703", JSON.stringify(bad.j));

  // Funciones con los nombres de parámetros exactos que usa dev
  const fns = [
    ["request_restock_alert", { variant_id: 1 }], ["cancel_restock_alert", { variant_id: 1 }],
    ["admin_restock_alerts", {}], ["admin_mark_restock_notified", { ids: [] }],
    ["admin_stock_movement", { operation_id: "00000000-0000-4000-8000-000000000000", variant_id: 1, movement_type: "entrada", quantity: 1, reason: null, reference: null, declared_physical: null, confirm_shortage: false, source: "stock_rapido" }],
    ["admin_stock_preview", { variant_id: 1, quantity: 1, declared_physical: null }],
    ["admin_resolve_shortage", { shortage_id: 1, resolution: null }],
    ["admin_create_supplier_order", { items: [], supplier: null, note: null, client_key: null }],
    ["admin_receive_supplier_order", { order_id: 1, items: null }],
    ["admin_cancel_supplier_order", { order_id: 1 }],
    ["admin_create_sale", { items: [], customer_id: null, customer_name: null, note: null, client_key: null }],
    ["admin_link_order_customer", { order_id: 1, customer_id: "00000000-0000-4000-8000-000000000000" }],
    ["admin_cancel_sale", { order_id: 1 }],
    ["admin_set_order_status", { order_id: 1, status: "listo" }],
    ["admin_update_order_items", { order_id: 1, items: [] }],
    ["deliver_due_yerba_orders", {}],
    ["create_yerba_order", { items: [], contact_phone: null }],
    ["create_order", { items: [] }],
  ];
  for (const [fn, args] of fns) {
    const r = await rpc(fn, args);
    check(`existe ${fn}(${Object.keys(args).join(", ")}) y anon no la puede ejecutar`, denied(r.j), JSON.stringify(r.j));
  }
  const ctl = await rpc("admin_stock_movement", { operation_id: "00000000-0000-4000-8000-000000000000", parametro_inventado: 1 });
  check("control: parámetros equivocados se detectan (PGRST202)", ctl.j?.code === "PGRST202", JSON.stringify(ctl.j));
  // variant_commitments sí es pública (la usa la vista de la tienda)
  const vc = await rpc("variant_commitments", {});
  check("variant_commitments responde para anon (la usan tienda y panel)", vc.status === 200 && Array.isArray(vc.j), JSON.stringify(vc.j).slice(0, 120));

  console.log(`\n${ok} OK, ${fail} FALLAS`);
  process.exit(fail ? 1 : 0);
})();
