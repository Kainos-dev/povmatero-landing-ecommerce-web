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
  if (err instanceof TypeError || err?.message === "timeout") return "No pudimos conectarnos. Revisá tu internet e intentá de nuevo.";
  return "No pudimos enviar el pedido. Intentá de nuevo en unos minutos.";
}

// Detalle de lo que no alcanzó: [{ variant_id, available, ... }]
export function shortageDetail(err) {
  if (err?.hint !== "insufficient_stock") return [];
  try { return JSON.parse(err.details ?? err.detail ?? "[]"); } catch { return []; }
}
