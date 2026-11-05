// Edición rápida desde la tabla de Productos: precio, costo y stock de UNA
// variante (o los valores generales de un producto simple que los hereda).
//
// Cada guardado es condicional: solo se escribe si el valor en la base sigue
// siendo el que se vio al editar. Así nunca se pisa un cambio hecho en otra
// pestaña, y un reintento después de un corte de conexión no duplica nada
// (si el valor ya quedó guardado, se toma como hecho).
import { supabase } from "/js/lib/supabaseClient.js";
import { registerQuickMovement } from "./stockTools.js";

export const QUICK_REASON = "Corrección desde Productos";
export const QUICK_REFERENCE = "Edición rápida";
export const YERBA_MARKUP = 1.2;   // precio sugerido = costo × 1,20

const cents = (n) => Math.round(Number(n) * 100);
export const sameMoney = (a, b) => (a == null && b == null) || (a != null && b != null && cents(a) === cents(b));
export const round2 = (n) => Math.round(n * 100) / 100;
export const suggestedPrice = (cost) => round2(cost * YERBA_MARKUP);

function check({ data, error }) {
  if (error) throw error;
  return data;
}

function changedError(now, format = String) {
  const err = new Error(`Cambió mientras tanto (ahora es ${now == null ? "sin valor" : format(now)}). No se guardó: revisalo y volvé a intentar.`);
  err.code = "CHANGED";
  err.current = now;
  return err;
}

// ¿Error de red (sin conexión, corte)? Se puede reintentar sin riesgo.
export function isNetworkError(err) {
  const m = String(err?.message ?? err ?? "");
  return err?.name === "TypeError" || /Failed to fetch|NetworkError|Load failed|fetch failed|network/i.test(m);
}

// Texto del usuario → número. Acepta "5000", "5.000", "5.000,50", "5000,5", "$ 5.000".
// "" → null; inválido → NaN.
export function parseMoney(text) {
  let t = String(text ?? "").trim().replace(/^\$\s*/, "").replace(/\s/g, "");
  if (t === "") return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(",", ".");
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return round2(Number(t));
}

export function parseCount(text) {
  const t = String(text ?? "").trim().replace(/\./g, "");
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : NaN;
}

// ---------- Precio ----------
async function readOne(table, column, key, id) {
  const row = check(await supabase.from(table).select(column).eq(key, id).maybeSingle());
  return row?.[column] == null ? null : Number(row[column]);
}

// Precio propio de la variante (la base la marca «particular» si difiere del general).
export async function setVariantPrice(variantId, from, to) {
  const rows = check(await supabase.from("product_variants").update({ price: to }).eq("id", variantId).eq("price", from).select("id"));
  if (rows.length) return;
  const now = await readOne("product_variants", "price", "id", variantId);
  if (!sameMoney(now, to)) throw changedError(now);
}

// Precio general de un producto simple (la base lo copia a su variante).
export async function setBasePrice(productId, from, to) {
  const rows = check(await supabase.from("products").update({ base_price: to }).eq("id", productId).eq("base_price", from).select("id"));
  if (rows.length) return;
  const now = await readOne("products", "base_price", "id", productId);
  if (!sameMoney(now, to)) throw changedError(now);
}

// ---------- Costo ----------
export async function setVariantCost(variantId, from, to) {
  if (from == null) {
    const { error } = await supabase.from("variant_costs").insert({ variant_id: variantId, cost: to });
    if (!error) return;
    if (error.code !== "23505") throw error;   // ya había un costo (otra pestaña o reintento)
  } else {
    const rows = check(await supabase.from("variant_costs").update({ cost: to }).eq("variant_id", variantId).eq("cost", from).select("variant_id"));
    if (rows.length) return;
  }
  const now = await readOne("variant_costs", "cost", "variant_id", variantId);
  if (!sameMoney(now, to)) throw changedError(now);
}

export async function setBaseCost(productId, from, to) {
  const rows = check(await supabase.from("product_internal").update({ base_cost: to }).eq("product_id", productId).eq("base_cost", from).select("product_id"));
  if (rows.length) return;
  const now = await readOne("product_internal", "base_cost", "product_id", productId);
  if (!sameMoney(now, to)) throw changedError(now);
}

// ---------- Stock ----------
// Reservas de pedidos web por variante (para avisar antes de bajar el stock).
export async function listCommitments() {
  const rows = check(await supabase.rpc("variant_commitments")) ?? [];
  return new Map(rows.map((c) => [Number(c.variant_id), Number(c.quantity)]));
}

async function operationExists(key) {
  const { data, error } = await supabase.from("stock_operations").select("id").eq("id", key).maybeSingle();
  if (error) return false;
  return Boolean(data);
}

// Lleva el stock de «from» a «to» con UN movimiento (entrada o salida) por la
// diferencia. «key» identifica la operación: si se reintenta con la misma, la
// base no registra nada nuevo. «retry» = ya se intentó antes con esta key.
export async function setStock({ variantId, from, to, key, retry = false, confirmShortage = false }) {
  if (retry && await operationExists(key)) return { repeated: true };
  const fresh = check(await supabase.from("product_variants").select("stock").eq("id", variantId).single());
  if (fresh.stock !== from) throw changedError(fresh.stock);
  const delta = to - from;
  if (delta === 0) return { unchanged: true };
  return registerQuickMovement({
    variantId, key, source: "inventario",
    type: delta > 0 ? "entrada" : "salida",
    quantity: Math.abs(delta),
    reason: QUICK_REASON, reference: QUICK_REFERENCE,
    // Si la baja supera lo disponible, el stock físico real es el que se escribió.
    declared: delta < 0 ? to : null,
    confirmShortage,
  });
}
