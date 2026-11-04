// Herramientas de stock del panel: movimiento rápido, pedidos a proveedor,
// ventas presenciales y avisos de reposición.
// Todo cambio de stock pasa por inventory_movements o por funciones de la base
// que validan permisos y stock de forma atómica (migraciones 20261108 y
// 20261109). El panel nunca escribe stock directo.
import { supabase } from "/js/lib/supabaseClient.js";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// ¿La base todavía no tiene esta parte (migración sin aplicar)?
export function isMissingMigration(err) {
  return ["PGRST202", "PGRST204", "PGRST205", "42P01", "42703", "42883"].includes(err?.code);
}

export const newKey = () =>
  (crypto.randomUUID?.() ?? "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
    (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// ---------------------------------------------------------------------
// Presentaciones (para elegir): activas, con stock físico y disponible.
// disponible = físico − comprometido por pedidos de yerbas (como la tienda).
// ---------------------------------------------------------------------
export async function listVariantsForStock() {
  const [variants, commitments] = await Promise.all([
    supabase
      .from("product_variants")
      .select("id, name, price, stock, track_stock, is_active, sort_order, product:products!inner(id, name, brand, is_active, sort_order, category:categories(slug, name))")
      .eq("is_active", true)
      .then(check),
    supabase.rpc("variant_commitments").then(check),
  ]);
  const committed = new Map((commitments ?? []).map((c) => [Number(c.variant_id), Number(c.quantity)]));
  return variants
    .map((v) => {
      const c = committed.get(v.id) ?? 0;
      return {
        id: v.id,
        productId: v.product.id,
        productName: v.product.name,
        brand: v.product.brand ?? null,
        category: v.product.category?.slug ?? "",
        categoryName: v.product.category?.name ?? "",
        variantName: v.name === "Único" ? "" : v.name,
        label: v.name === "Único" ? v.product.name : `${v.product.name} · ${v.name}`,
        price: Number(v.price),
        stock: v.stock,
        trackStock: v.track_stock,
        committed: c,
        available: v.track_stock ? Math.max(v.stock - c, 0) : null,
        sort: [v.product.category?.slug === "yerbas" ? 0 : 1, v.product.sort_order ?? 0, v.product.id, v.sort_order ?? 0, v.id],
      };
    })
    .sort((a, b) => {
      for (let i = 0; i < a.sort.length; i++) if (a.sort[i] !== b.sort[i]) return a.sort[i] - b.sort[i];
      return 0;
    });
}

// ---------------------------------------------------------------------
// Movimiento rápido: entrada o salida, con una clave por confirmación.
// Si la base ya registró esa clave (doble clic, reintento), no se repite:
// devuelve { repeated: true }. Sin la migración 20261109, se registra igual
// sin la clave (el botón ya evita el doble clic).
// ---------------------------------------------------------------------
export async function registerQuickMovement({ variantId, type, quantity, reason, key }) {
  const row = {
    variant_id: variantId,
    movement_type: type,
    quantity: type === "salida" ? -Math.abs(quantity) : Math.abs(quantity),
    reason,
    reference: "Movimiento rápido",
  };
  let res = await supabase.from("inventory_movements").insert({ ...row, client_key: key }).select("id, stock_after").single();
  if (res.error && isMissingMigration(res.error)) {
    res = await supabase.from("inventory_movements").insert(row).select("id, stock_after").single();
  }
  if (res.error?.code === "23505" && /client_key/.test(res.error.message ?? "")) {
    const prev = await supabase.from("inventory_movements").select("id, stock_after").eq("client_key", key).maybeSingle();
    return { ...(prev.data ?? {}), repeated: true };
  }
  return check(res);
}

export async function listRecentQuickMovements(limit = 15) {
  return check(await supabase
    .from("inventory_movements")
    .select("id, variant_id, movement_type, quantity, stock_after, reason, created_at")
    .eq("reference", "Movimiento rápido")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit));
}

// ---------------------------------------------------------------------
// Pedidos a proveedor
// ---------------------------------------------------------------------
export async function listSupplierOrders(limit = 100) {
  return check(await supabase
    .from("supplier_orders")
    .select("id, supplier, note, status, created_at, received_at, cancelled_at, supplier_order_items (id, variant_id, product_name, variant_name, quantity, received_quantity)")
    .order("created_at", { ascending: false })
    .order("id", { referencedTable: "supplier_order_items", ascending: true })
    .limit(limit));
}

export async function createSupplierOrder({ items, supplier, note, key }) {
  return check(await supabase.rpc("admin_create_supplier_order", {
    items: items.map((i) => ({ variant_id: Number(i.variant_id), quantity: Number(i.quantity) })),
    supplier: supplier || null, note: note || null, client_key: key,
  }));
}

// received: [{ variant_id, quantity }] o null (llegó todo lo pedido)
export async function receiveSupplierOrder(orderId, received = null) {
  return check(await supabase.rpc("admin_receive_supplier_order", {
    order_id: orderId,
    items: received ? received.map((i) => ({ variant_id: Number(i.variant_id), quantity: Number(i.quantity) })) : null,
  }));
}

export async function cancelSupplierOrder(orderId) {
  return check(await supabase.rpc("admin_cancel_supplier_order", { order_id: orderId }));
}

// ---------------------------------------------------------------------
// Ventas presenciales (orders.kind = 'presencial')
// ---------------------------------------------------------------------
export async function createSale({ items, customerId, customerName, note, key }) {
  return check(await supabase.rpc("admin_create_sale", {
    items: items.map((i) => ({ variant_id: Number(i.variant_id), quantity: Number(i.quantity) })),
    customer_id: customerId || null,
    customer_name: customerName || null,
    note: note || null,
    client_key: key,
  }));
}

export async function linkOrderCustomer(orderId, customerId) {
  return check(await supabase.rpc("admin_link_order_customer", { order_id: orderId, customer_id: customerId }));
}

export async function cancelSale(orderId) {
  return check(await supabase.rpc("admin_cancel_sale", { order_id: orderId }));
}

// Clientes registrados (para asignar o vincular una venta).
export async function searchCustomers(text) {
  const t = String(text ?? "").trim().replace(/[%,()*]/g, " ").trim();
  let query = supabase
    .from("customer_profiles")
    .select("user_id, first_name, last_name, email, phone")
    .order("created_at", { ascending: false })
    .limit(8);
  if (t) {
    const like = `%${t}%`;
    query = query.or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
  }
  return check(await query);
}

// ---------------------------------------------------------------------
// Avisos de reposición
// ---------------------------------------------------------------------
export async function listRestockAlerts() {
  return check(await supabase.rpc("admin_restock_alerts"));
}

export async function markRestockNotified(ids) {
  return check(await supabase.rpc("admin_mark_restock_notified", { ids }));
}

// Rechazos de la base con un mensaje ya pensado para el panel.
const KNOWN = new Set(["insufficient_stock", "unavailable", "invalid_transition", "not_found", "invalid_items",
  "customer_required", "customer_not_found", "already_linked", "not_presencial"]);
export function toolErrorMessage(err, fallback) {
  if (KNOWN.has(err?.hint)) return err.message;
  if (isMissingMigration(err)) return "Falta aplicar la migración de esta función en Supabase (ver supabase/migrations).";
  if (err?.code === "23514" && /stock/.test(err?.message ?? "")) return "No alcanza el stock para esa salida.";
  return fallback(err);
}
