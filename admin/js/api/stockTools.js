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
// Entradas y salidas manuales (Stock rápido e Inventario). Las registra la
// base (admin_stock_movement) en una transacción con la presentación
// bloqueada. Una salida que supera lo disponible necesita «declared» (stock
// físico real que quedó); si además no cubre las reservas, «confirmShortage».
// El mismo «key» = la misma operación: un reintento no registra nada nuevo.
// Sin la migración 20261109 se registra como antes (un movimiento directo).
// ---------------------------------------------------------------------
export async function registerQuickMovement({ variantId, type, quantity, reason, reference = null, key,
                                             declared = null, confirmShortage = false, source = "stock_rapido" }) {
  const { data, error } = await supabase.rpc("admin_stock_movement", {
    operation_id: key, variant_id: variantId, movement_type: type, quantity: Math.abs(quantity),
    reason: reason || null, reference: reference || null,
    declared_physical: declared, confirm_shortage: confirmShortage, source,
  });
  if (!error) {
    const last = data.movements?.at(-1);
    return { ...data, stock_after: data.stock_after ?? last?.stock_after };
  }
  if (error.code !== "PGRST202") throw error;
  // Base sin migrar: movimiento directo, como antes.
  return check(await supabase.from("inventory_movements").insert({
    variant_id: variantId, movement_type: type,
    quantity: type === "salida" ? -Math.abs(quantity) : Math.abs(quantity),
    reason, reference: reference ?? (source === "inventario" ? null : "Movimiento rápido"),
  }).select("id, stock_after").single());
}

// Vista previa de una salida (stock, reservas, disponible, pedidos afectados).
// null si la base todavía no tiene la función.
export async function previewStock(variantId, quantity, declared = null) {
  const { data, error } = await supabase.rpc("admin_stock_preview", { variant_id: variantId, quantity, declared_physical: declared });
  if (error) {
    if (error.code === "PGRST202") return null;
    throw error;
  }
  return data;
}

// La base rechazó porque hace falta el conteo o la confirmación: trae la vista previa.
export function planFromError(err) {
  if (!["count_required", "shortage_confirmation"].includes(err?.hint)) return null;
  try { return JSON.parse(err.details ?? err.detail ?? "null"); } catch { return null; }
}

// Faltantes abiertos (presentaciones con menos stock físico que lo reservado).
export async function listShortages() {
  return check(await supabase
    .from("stock_shortages")
    .select("id, variant_id, physical, reserved, missing, created_at, operation_id")
    .eq("status", "abierto")
    .order("created_at", { ascending: false }));
}

export async function resolveShortage(id, resolution) {
  return check(await supabase.rpc("admin_resolve_shortage", { shortage_id: id, resolution: resolution || null }));
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
// Yerbas para armar el pedido: presentaciones activas con su stock físico y
// las mismas fotos que la góndola de /yerbas (presentación → general → portada).
export async function listYerbasForSupplier() {
  const withShelf = "id, name, stock, track_stock, is_active, sort_order, shelf_image, product:products!inner(id, name, brand, is_active, sort_order, shelf_image, category:categories!inner(slug))";
  const plain = "id, name, stock, track_stock, is_active, sort_order, product:products!inner(id, name, brand, is_active, sort_order, category:categories!inner(slug))";
  const query = (cols) => supabase.from("product_variants").select(cols).eq("is_active", true).eq("product.category.slug", "yerbas");
  let res = await query(withShelf);
  if (res.error?.code === "42703") res = await query(plain);   // base sin imágenes de góndola
  const variants = check(res);
  const covers = check(await supabase
    .from("product_images")
    .select("product_id, src, is_cover, sort_order")
    .is("variant_id", null)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true }));
  const coverOf = new Map();
  for (const c of covers) if (!coverOf.has(c.product_id) || c.is_cover) { if (!coverOf.has(c.product_id) || !coverOf.get(c.product_id).is_cover) coverOf.set(c.product_id, c); }
  return variants.map((v) => ({
    id: v.id,
    name: v.name,
    stock: v.stock,
    trackStock: v.track_stock,
    sort: v.sort_order ?? 0,
    image: v.shelf_image ?? null,
    product: {
      id: v.product.id, name: v.product.name, brand: v.product.brand ?? null, active: v.product.is_active,
      sort: v.product.sort_order ?? 0, image: v.product.shelf_image ?? null, cover: coverOf.get(v.product.id)?.src ?? null,
    },
  }));
}

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

// Rechazos de la base con un mensaje ya pensado para el panel.
const KNOWN = new Set(["insufficient_stock", "unavailable", "invalid_transition", "not_found", "invalid_items", "operation_conflict", "reserved_stock",
  "customer_required", "customer_not_found", "already_linked", "not_presencial"]);
export function toolErrorMessage(err, fallback) {
  if (KNOWN.has(err?.hint)) return err.message;
  if (isMissingMigration(err)) return "Falta aplicar la migración de esta función en Supabase (ver supabase/migrations).";
  if (err?.code === "23514" && /stock/.test(err?.message ?? "")) return "No alcanza el stock para esa salida.";
  return fallback(err);
}
