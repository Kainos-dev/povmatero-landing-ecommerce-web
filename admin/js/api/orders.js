// Pedidos (panel). La RLS solo devuelve todos los pedidos a administradores.
// Los cambios (estado, productos) los hacen funciones de la base que validan
// permisos, transiciones y stock de forma atómica; el panel nunca escribe
// directo en las tablas. Ver supabase/migrations/20261105000000_yerba_orders.sql.
import { supabase } from "/js/lib/supabaseClient.js";

const ORDER_COLUMNS =
  "id, created_at, updated_at, kind, status, expires_at, status_changed_at, stock_applied, " +
  "customer_id, customer_name, customer_email, customer_phone, item_count, total";

export const STATUS = {
  pendiente:  { label: "Pendiente",  next: "confirmado", action: "Confirmar pedido" },
  confirmado: { label: "Confirmado", next: "preparando", action: "Empezar a preparar" },
  preparando: { label: "Preparando", next: "listo",      action: "Marcar listo" },
  listo:      { label: "Listo",      next: "entregado",  action: "Marcar entregado" },
  entregado:  { label: "Entregado" },
  cancelado:  { label: "Cancelado" },
};
export const FLOW = ["pendiente", "confirmado", "preparando", "listo", "entregado"];

export const isExpired = (o) => o.kind === "yerbas" && o.status === "pendiente" && !!o.expires_at && new Date(o.expires_at) <= new Date();
// ¿Compromete stock ahora? (mismo criterio que la base)
export const commitsStock = (o) => o.kind === "yerbas" &&
  (o.status === "confirmado" || o.status === "preparando" || (o.status === "pendiente" && !isExpired(o)));
export const isEditable = (o) => o.kind === "yerbas" && ["pendiente", "confirmado", "preparando"].includes(o.status);
export const canCancel = (o) => o.kind === "yerbas" && ["pendiente", "confirmado", "preparando", "listo"].includes(o.status);

export async function listOrders(kind, limit = 300) {
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function getOrder(id) {
  const [order, events] = await Promise.all([
    supabase
      .from("orders")
      .select(`${ORDER_COLUMNS}, order_items (id, product_id, variant_id, product_name, variant_name, unit_price, quantity, line_total)`)
      .eq("id", id)
      .order("id", { referencedTable: "order_items", ascending: true })
      .maybeSingle(),
    supabase
      .from("order_events")
      .select("id, event, from_status, to_status, detail, created_at")
      .eq("order_id", id)
      .order("created_at", { ascending: true }),
  ]);
  if (order.error) throw order.error;
  if (events.error) throw events.error;
  return order.data ? { ...order.data, events: events.data ?? [] } : null;
}

// Pendientes vigentes (para la marca en el menú).
export async function countPending() {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("kind", "yerbas")
    .eq("status", "pendiente")
    .gt("expires_at", new Date().toISOString());
  if (error) throw error;
  return count ?? 0;
}

export async function setOrderStatus(orderId, status) {
  const { data, error } = await supabase.rpc("admin_set_order_status", { order_id: orderId, status });
  if (error) throw error;
  return data;
}

// items: [{ variant_id, quantity }] = la lista completa nueva.
export async function updateOrderItems(orderId, items) {
  const payload = items.map((i) => ({ variant_id: Number(i.variant_id), quantity: Number(i.quantity) }));
  const { data, error } = await supabase.rpc("admin_update_order_items", { order_id: orderId, items: payload });
  if (error) throw error;
  return data;
}

// Yerbas publicadas con lo disponible de cada presentación (para agregar a un pedido).
export async function listYerbaVariants() {
  const { data, error } = await supabase
    .from("storefront_catalog")
    .select("product_id, product_name, brand, variant_id, variant_name, price, track_stock, stock, product_sort, variant_sort")
    .eq("category_slug", "yerbas")
    .order("product_sort", { ascending: true })
    .order("product_id", { ascending: true })
    .order("variant_sort", { ascending: true });
  if (error) throw error;
  return (data ?? []).filter((r) => Number(r.price) > 0);
}

// Rechazos de la base que ya vienen con un mensaje pensado para el panel.
const KNOWN = new Set(["insufficient_stock", "unavailable", "invalid_transition", "not_editable", "not_yerbas", "not_found", "invalid_items"]);
export function orderErrorMessage(err, fallback) {
  if (KNOWN.has(err?.hint)) return err.message;
  if (err?.code === "PGRST202") return "Falta aplicar la migración 20261105000000_yerba_orders.sql.";
  return fallback(err);
}

// Teléfono → número para wa.me (Argentina por defecto: 54 9 + área + número).
export function whatsappNumber(raw) {
  let d = String(raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  if (d.startsWith("54")) d = d.slice(2);
  else if (d.length > 11) return d;           // ya trae otro código de país
  if (d.startsWith("9")) d = d.slice(1);
  if (d.startsWith("0")) d = d.slice(1);
  if (d.length === 12 && d.slice(2, 4) === "15") d = d.slice(0, 2) + d.slice(4);   // 11 15 xxxx xxxx
  return d.length === 10 ? `549${d}` : (d.length >= 8 ? `54${d}` : null);
}
