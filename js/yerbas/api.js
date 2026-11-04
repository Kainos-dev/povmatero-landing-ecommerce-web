// Pedidos de yerbas contra Supabase (se carga recién al enviar el pedido).
// La base valida todo: cliente de la sesión, presentaciones publicadas,
// precios, stock disponible, teléfono y límites (ver la migración
// 20261105000000_yerba_orders.sql). Acá solo viaja qué y cuánto.
import { supabase } from "../lib/supabaseClient.js";

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

export async function getProfilePhone(userId) {
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("phone, first_name")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

// lines: [{ variant_id, qty }]. phone: opcional (si llega, se guarda en el perfil).
export async function createYerbaOrder(lines, phone = null) {
  const items = lines.map((l) => ({ variant_id: Number(l.variant_id), quantity: Number(l.qty) }));
  const { data, error } = await supabase.rpc("create_yerba_order", { items, contact_phone: phone || null });
  if (error) throw error;
  return data;   // { id, status, expires_at, total, item_count, items: [...] }
}

// ---------- Avisos de reposición (migración 20261108000000) ----------
// Presentaciones con un aviso activo de esta cuenta (la RLS devuelve solo las propias).
export async function listMyRestockAlerts() {
  const { data, error } = await supabase
    .from("restock_requests")
    .select("variant_id")
    .eq("status", "activa");
  if (error) throw error;
  return (data ?? []).map((r) => Number(r.variant_id));
}

export async function requestRestockAlert(variantId) {
  const { data, error } = await supabase.rpc("request_restock_alert", { variant_id: Number(variantId) });
  if (error) throw error;
  return data;
}

export async function cancelRestockAlert(variantId) {
  const { data, error } = await supabase.rpc("cancel_restock_alert", { variant_id: Number(variantId) });
  if (error) throw error;
  return data;
}

// La base todavía no tiene los avisos (migración sin aplicar): se oculta la opción.
export function restockMissing(err) {
  return ["PGRST202", "PGRST205", "42P01", "42883"].includes(err?.code);
}

// «12:2,15:1»: qué presentaciones y cuántas (para reconocer un mismo pedido).
export function itemsSignature(items) {
  return items.map((i) => `${Number(i.variant_id)}:${Number(i.quantity ?? i.qty)}`).sort().join(",");
}

// ¿Ya quedó guardado este pedido? Se usa cuando la respuesta no llegó (corte de
// conexión, demora, recarga de la página a mitad del envío): busca un pedido de
// yerbas de esta cuenta, creado desde «since», con las mismas presentaciones y
// cantidades. Así nunca se envía dos veces. La RLS solo devuelve pedidos propios.
export async function findRecentOrder(userId, since, signature) {
  const { data, error } = await supabase
    .from("orders")
    .select("id, total, created_at, order_items (variant_id, quantity)")
    .eq("customer_id", userId)
    .eq("kind", "yerbas")
    .gte("created_at", new Date(since).toISOString())
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data ?? []).find((o) => itemsSignature(o.order_items ?? []) === signature) ?? null;
}

// Mensaje claro para cada rechazo de la base (hint) o de la red.
export function orderErrorMessage(err) {
  switch (err?.hint) {
    case "insufficient_stock":
    case "unavailable":
    case "too_many_pending":
    case "rate_limit":
    case "phone_required":
    case "phone_invalid":
    case "invalid_items":
      return err.message;
    case "login_required":
      return "Ingresá a tu cuenta para enviar el pedido.";
    default:
      break;
  }
  if (err?.code === "PGRST202") return "Los pedidos de yerbas todavía no están habilitados. Probá más tarde.";
  if (/jwt|token/i.test(err?.message ?? "")) return "Tu sesión expiró. Volvé a ingresar.";
  if (err instanceof TypeError || err?.message === "timeout" || /failed to fetch|load failed|network/i.test(err?.message ?? "")) return "No pudimos conectarnos. Revisá tu internet e intentá de nuevo.";
  return "No pudimos enviar el pedido. Intentá de nuevo en unos minutos.";
}

// Detalle de lo que no alcanzó: [{ variant_id, available, ... }]
export function shortageDetail(err) {
  if (err?.hint !== "insufficient_stock") return [];
  try { return JSON.parse(err.details ?? err.detail ?? "[]"); } catch { return []; }
}
