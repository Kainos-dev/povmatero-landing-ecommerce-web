// Movimientos de inventario. El stock nunca se escribe directo:
// cada movimiento lo actualiza en la base (trigger) y guarda el stock resultante.
import { supabase } from "/js/lib/supabaseClient.js";

const MOVEMENT_COLUMNS =
  "id, variant_id, movement_type, quantity, stock_after, unit_cost, reason, reference, created_by, created_at";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Stock actual leído de la base (para ajustes y mensajes de error).
export async function getVariantStock(variantId) {
  return check(
    await supabase.from("product_variants").select("id, stock, track_stock").eq("id", variantId).single()
  );
}

export async function listMovements(variantId, limit = 20) {
  return check(
    await supabase
      .from("inventory_movements")
      .select(MOVEMENT_COLUMNS)
      .eq("variant_id", variantId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit)
  );
}

// type: "entrada" | "salida" | "ajuste". quantity con signo (+ entra, − sale).
// Devuelve { id, stock_after }.
export async function registerMovement({ variantId, type, quantity, unitCost = null, reason, reference = null }) {
  return check(
    await supabase
      .from("inventory_movements")
      .insert({
        variant_id: variantId,
        movement_type: type,
        quantity,
        unit_cost: unitCost,
        reason,
        reference,
      })
      .select("id, stock_after")
      .single()
  );
}

export async function getCurrentUserId() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user?.id ?? null;
}

// La salida o el ajuste dejarían el stock en negativo (CHECK stock >= 0).
export function isInsufficientStockError(err) {
  return err?.code === "23514" && String(err?.message ?? "").includes("stock_check");
}

// Últimos movimientos de todo el inventario (para Inicio).
export async function listRecentMovements(limit = 8) {
  return check(
    await supabase
      .from("inventory_movements")
      .select(MOVEMENT_COLUMNS)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(limit)
  );
}

// Historial general, paginado. Filtros opcionales:
//   type: "entrada" | "salida" | "ajuste"; since: Date; variantIds: [id] (búsqueda)
// Devuelve { rows, more } (more = hay más páginas).
export async function listMovementsPage({ type = null, since = null, variantIds = null, limit = 50, offset = 0 } = {}) {
  let query = supabase
    .from("inventory_movements")
    .select(MOVEMENT_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit);   // se pide uno de más para saber si hay otra página
  if (type) query = query.eq("movement_type", type);
  if (since) query = query.gte("created_at", since.toISOString());
  if (variantIds) query = query.in("variant_id", variantIds.length ? variantIds : [-1]);
  const rows = check(await query);
  return { rows: rows.slice(0, limit), more: rows.length > limit };
}
