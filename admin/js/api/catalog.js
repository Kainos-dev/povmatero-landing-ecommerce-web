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

// Publica o pasa a borrador varios productos. Devuelve los ids que sí se guardaron
// (la RLS puede bloquear filas sin dar error: quien llama compara con lo pedido).
export async function setProductsActive(ids, isActive) {
  if (!ids.length) return [];
  const rows = check(
    await supabase.from("products").update({ is_active: isActive }).in("id", ids).select("id")
  );
  return rows.map((r) => r.id);
}

// Vínculo de cada producto con su id en js/products.js (solo los importados de ahí).
export async function listProductLegacyIds() {
  return check(await supabase.from("product_internal").select("product_id, legacy_id"));
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
  const skuByVariant = await listSkus(variants.map((v) => v.id));

  return variants.map((v) => ({
    ...v,
    price: Number(v.price),
    cost: costByVariant.has(v.id) ? costByVariant.get(v.id) : null,
    sku: skuByVariant.get(v.id) ?? null,
  }));
}

// Todas las variantes con su costo, SKU e ID de la hoja WEB (si vino de la importación).
// Para la tabla de precios y stock y la importación de costos.
export async function listAllVariantsWithCosts() {
  const [variants, costs, links] = await Promise.all([
    supabase.from("product_variants").select(VARIANT_COLUMNS).order("product_id").order("sort_order").order("id").then(check),
    supabase.from("variant_costs").select("variant_id, cost").then(check),
    supabase.from("variant_internal").select("variant_id, sku, legacy_sheet_id").then(check),
  ]);
  const costByVariant = new Map(costs.map((c) => [c.variant_id, Number(c.cost)]));
  const internal = new Map(links.map((l) => [l.variant_id, l]));

  return variants.map((v) => ({
    ...v,
    price: Number(v.price),
    cost: costByVariant.has(v.id) ? costByVariant.get(v.id) : null,
    sku: internal.get(v.id)?.sku ?? null,
    sheet_id: internal.get(v.id)?.legacy_sheet_id ?? null,
  }));
}

// ---------- SKU (interno, por variante) ----------
// El SKU vive en variant_internal (solo admins), junto con el ID de la hoja WEB.
// Se compara siempre recortando espacios, respetando mayúsculas y minúsculas.
export function normalizeSku(value) {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
}

async function listSkus(variantIds) {
  if (!variantIds.length) return new Map();
  const rows = check(
    await supabase.from("variant_internal").select("variant_id, sku").in("variant_id", variantIds)
  );
  return new Map(rows.map((r) => [r.variant_id, r.sku]));
}

// Guarda (o borra con null) el SKU de una variante. Solo toca la columna sku:
// el resto de variant_internal (por ejemplo legacy_sheet_id) queda igual.
export async function saveVariantSku(variantId, sku) {
  const value = normalizeSku(sku);
  const updated = check(
    await supabase.from("variant_internal").update({ sku: value }).eq("variant_id", variantId).select("variant_id")
  );
  if (updated.length === 0 && value !== null) {
    check(await supabase.from("variant_internal").insert({ variant_id: variantId, sku: value }));
  }
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
