// Consultas del panel al catálogo en Supabase.
// Siempre con columnas explícitas: la base rechaza "select=*" por diseño.
import { supabase } from "/js/lib/supabaseClient.js";

const CATEGORY_COLUMNS = "id, slug, name, sort_order, is_active";
const PRODUCT_COLUMNS  = "id, category_id, slug, name, description, is_active, sort_order";
const VARIANT_COLUMNS  = "id, product_id, name, price, stock, track_stock, is_active, sort_order";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Un UPDATE bloqueado por RLS no da error: devuelve 0 filas. Lo tratamos como error.
function ensureSaved(rows) {
  if (!rows || rows.length === 0) {
    const err = new Error("No se guardó ningún cambio. Puede que no tengas permisos o que el registro ya no exista.");
    err.code = "NOT_SAVED";
    throw err;
  }
  return rows[0];
}

// ---------- Categorías ----------
export async function listCategories() {
  return check(await supabase.from("categories").select(CATEGORY_COLUMNS).order("sort_order"));
}

// ---------- Productos ----------
export async function listProducts() {
  return check(
    await supabase
      .from("products")
      .select(`${PRODUCT_COLUMNS}, product_variants (id, price, stock, track_stock, is_active)`)
      .order("name")
  );
}

export async function getProduct(id) {
  return check(await supabase.from("products").select(PRODUCT_COLUMNS).eq("id", id).maybeSingle());
}

// Se crea siempre como borrador (is_active = false por defecto en la base).
export async function createProduct(fields) {
  return check(await supabase.from("products").insert(fields).select("id").single());
}

export async function updateProduct(id, fields) {
  return ensureSaved(check(await supabase.from("products").update(fields).eq("id", id).select("id")));
}

// ---------- Variantes ----------
// Devuelve las variantes del producto con su costo interno (null si no tiene).
export async function listVariants(productId) {
  const variants = check(
    await supabase
      .from("product_variants")
      .select(VARIANT_COLUMNS)
      .eq("product_id", productId)
      .order("sort_order")
      .order("id")
  );
  if (variants.length === 0) return variants;

  const costs = check(
    await supabase
      .from("variant_costs")
      .select("variant_id, cost")
      .in("variant_id", variants.map((v) => v.id))
  );
  const costByVariant = new Map(costs.map((c) => [c.variant_id, Number(c.cost)]));

  return variants.map((v) => ({
    ...v,
    price: Number(v.price),
    cost: costByVariant.has(v.id) ? costByVariant.get(v.id) : null,
  }));
}

// El stock nunca se envía: empieza en 0 y solo cambia con movimientos.
export async function createVariant(productId, fields) {
  return check(
    await supabase
      .from("product_variants")
      .insert({ ...fields, product_id: productId })
      .select("id")
      .single()
  );
}

export async function updateVariant(id, fields) {
  return ensureSaved(check(await supabase.from("product_variants").update(fields).eq("id", id).select("id")));
}

// Guarda el costo interno. null = sin costo (borra el registro).
export async function saveVariantCost(variantId, cost) {
  if (cost === null) {
    check(await supabase.from("variant_costs").delete().eq("variant_id", variantId));
    return;
  }

  const updated = check(
    await supabase.from("variant_costs").update({ cost }).eq("variant_id", variantId).select("variant_id")
  );
  if (updated.length === 0) {
    check(await supabase.from("variant_costs").insert({ variant_id: variantId, cost }));
  }
}
