// Pedidos (panel). La RLS solo devuelve todos los pedidos a administradores.
// Los cambios (estado, productos) los hacen funciones de la base que validan
// permisos, transiciones y stock de forma atómica; el panel nunca escribe
// directo en las tablas. Ver supabase/migrations/20261105000000_yerba_orders.sql.
import { supabase } from "/js/lib/supabaseClient.js";

const BASE_COLUMNS =
  "id, created_at, updated_at, kind, status, expires_at, status_changed_at, stock_applied, " +
  "customer_id, customer_name, customer_email, customer_phone, item_count, total";
// Columnas de las migraciones 20261109 (ventas presenciales) y 20261110 (estados).
const NEW_COLUMNS = ", ready_at, delivered_at, auto_delivered, auto_deliver";
let hasNewColumns = true;   // si la base todavía no las tiene, se piden las de siempre

// Lectura con las columnas nuevas; si la base aún no las tiene (42703), sin ellas.
async function selectOrders(build, extra = "") {
  if (hasNewColumns) {
    const res = await build(BASE_COLUMNS + NEW_COLUMNS + extra);
    if (res.error?.code !== "42703") return res;
    hasNewColumns = false;
  }
  return build(BASE_COLUMNS + extra);
}

// Tres estados para el panel. En la base, «Pendiente» agrupa pendiente,
// confirmado y preparando (los tres reservan stock igual).
export const STATUS = {
  pendiente:  { label: "Pendiente" },
  confirmado: { label: "Pendiente" },
  preparando: { label: "Pendiente" },
  listo:      { label: "Listo" },
  entregado:  { label: "Entregado" },
  cancelado:  { label: "Cancelado" },
};
export const FLOW = ["pendiente", "listo", "entregado"];
export const FLOW_LABEL = { pendiente: "Pendiente", listo: "Listo", entregado: "Entregado" };
export const PENDING_STATES = ["pendiente", "confirmado", "preparando"];

// Estado que ve el panel: pendiente | vencido | listo | entregado | cancelado
export function uiStatus(o) {
  if (o.kind === "presencial") return o.status === "cancelado" ? "cancelado" : "entregado";
  if (isExpired(o)) return "vencido";
  return PENDING_STATES.includes(o.status) ? "pendiente" : o.status;
}

// Hora de la entrega automática (24 h desde que pasó a «Listo»), o null.
export function autoDeliveryAt(o) {
  if (o.kind !== "yerbas" || o.status !== "listo" || !o.ready_at || o.auto_deliver === false) return null;
  return new Date(new Date(o.ready_at).getTime() + 24 * 3600 * 1000);
}

export const isExpired = (o) => o.kind === "yerbas" && o.status === "pendiente" && !!o.expires_at && new Date(o.expires_at) <= new Date();
// ¿Compromete stock ahora? (mismo criterio que la base)
export const commitsStock = (o) => o.kind === "yerbas" &&
  (o.status === "confirmado" || o.status === "preparando" || (o.status === "pendiente" && !isExpired(o)));
export const isEditable = (o) => o.kind === "yerbas" && PENDING_STATES.includes(o.status);
export const canCancel = (o) => o.kind === "yerbas" && ["pendiente", "confirmado", "preparando", "listo"].includes(o.status);

export async function listOrders(kind, limit = 300) {
  const { data, error } = await selectOrders((cols) => supabase
    .from("orders")
    .select(cols)
    .eq("kind", kind)
    .order("created_at", { ascending: false })
    .limit(limit));
  if (error) throw error;
  return data ?? [];
}

export async function getOrder(id) {
  const [order, events] = await Promise.all([
    selectOrders((cols) => supabase
      .from("orders")
      .select(cols)
      .eq("id", id)
      .order("id", { referencedTable: "order_items", ascending: true })
      .maybeSingle(), ", order_items (id, product_id, variant_id, product_name, variant_name, unit_price, quantity, line_total)"),
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

// Pendientes (para la marca en el menú): pendientes vigentes + confirmados y en preparación.
export async function countPending() {
  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("kind", "yerbas")
    .or(`status.in.(confirmado,preparando),and(status.eq.pendiente,expires_at.gt.${new Date().toISOString()})`);
  if (error) throw error;
  return count ?? 0;
}

// Entrega automática: «Listo» hace 24 h o más → «Entregado» (función de la
// base, idempotente). El panel la llama al abrir «Pedidos»; además puede
// programarse con pg_cron. Sin la migración 20261110 no hace nada.
export async function deliverDueOrders() {
  const { data, error } = await supabase.rpc("deliver_due_yerba_orders");
  if (error) {
    if (error.code === "PGRST202") return [];
    throw error;
  }
  return data ?? [];
}

// «Marcar listo» desde Pendiente (cualquiera de sus tres estados de la base).
// La base nueva lo hace en un paso; la anterior a 20261110 no tiene ese paso
// directo: entonces se recorre confirmado → preparando → listo (cada paso es
// atómico; si uno falla, el pedido queda en un estado que el panel sigue
// mostrando como «Pendiente», con el stock igual de reservado).
export async function markReady(order) {
  try {
    return await setOrderStatus(order.id, "listo");
  } catch (err) {
    if (err?.hint !== "invalid_transition" || !PENDING_STATES.includes(order.status)) throw err;
  }
  const path = ["confirmado", "preparando", "listo"].slice(Math.max(0, ["pendiente", "confirmado", "preparando"].indexOf(order.status)));
  let last = null;
  for (const step of path) last = await setOrderStatus(order.id, step);
  return last;
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
