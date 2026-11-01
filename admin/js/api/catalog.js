// Consultas del panel al catálogo en Supabase.
// Siempre con columnas explícitas: la base rechaza "select=*" por diseño.
import { supabase } from "/js/lib/supabaseClient.js";

const CATEGORY_COLUMNS = "id, slug, name, sort_order, is_active";
const PRODUCT_COLUMNS  = "id, category_id, slug, name, description, is_active, sort_order, base_price";
const VARIANT_COLUMNS  = "id, product_id, name, price, stock, track_stock, is_active, sort_order, price_inherited, cost_inherited";

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
      .select(`${PRODUCT_COLUMNS}, product_variants (id, name, price, stock, track_stock, is_active, price_inherited, cost_inherited)`)
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

// ---------- Eliminar borradores ----------
// Qué se borraría con el producto. "movements" > 0 impide borrarlo: el historial
// de stock no se borra (la base lo protege) para no perder trazabilidad.
export async function getDeletionInfo(productId) {
  const [product, variants, images] = await Promise.all([
    getProduct(productId),
    supabase.from("product_variants").select("id").eq("product_id", productId).then(check),
    supabase.from("product_images").select("id, src").eq("product_id", productId).then(check),
  ]);
  let movements = 0;
  if (variants.length) {
    const { count, error } = await supabase
      .from("inventory_movements")
      .select("id", { count: "exact", head: true })
      .in("variant_id", variants.map((v) => v.id));
    if (error) throw error;
    // Sin conteo no se sabe si hay historial: mejor no ofrecer el borrado.
    if (count == null) throw new Error("No se pudo verificar el historial de stock del producto.");
    movements = count;
  }
  return { product, variants: variants.length, images, movements };
}

// Borra un producto SOLO si sigue en borrador (la condición la evalúa la base en
// el mismo DELETE: un producto publicado nunca se borra). Variantes, SKU, costos,
// imágenes y datos internos se borran en cascada.
export async function deleteDraftProduct(productId) {
  const rows = check(
    await supabase.from("products").delete().eq("id", productId).eq("is_active", false).select("id")
  );
  if (!rows.length) {
    const err = new Error("No se eliminó: el producto ya no está en borrador o no existe. Recargá la página.");
    err.code = "NOT_DRAFT";
    throw err;
  }
}

// ---------- Productos simples ----------
// Un producto de un solo modelo se guarda con una única variante interna "Único":
// ahí viven su precio, stock, costo, SKU y movimientos. El panel la muestra como
// "Producto simple" y la tienda como un producto sin variantes.
export const SINGLE_VARIANT_NAME = "Único";

export function isSimpleProduct(variants) {
  return variants.length === 0 || (variants.length === 1 && variants[0].name === SINGLE_VARIANT_NAME);
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

// Todas las variantes con su costo. Para Inventario, Inicio y la importación.
export async function listAllVariantsWithCosts() {
  const [variants, costs] = await Promise.all([
    supabase.from("product_variants").select(VARIANT_COLUMNS).order("product_id").order("sort_order").order("id").then(check),
    supabase.from("variant_costs").select("variant_id, cost").then(check),
  ]);
  const costByVariant = new Map(costs.map((c) => [c.variant_id, Number(c.cost)]));

  return variants.map((v) => ({
    ...v,
    price: Number(v.price),
    cost: costByVariant.has(v.id) ? costByVariant.get(v.id) : null,
  }));
}

// ---------- SKU, precio y costo generales del producto ----------
// SKU y costo general viven en product_internal (solo admins); el precio de venta
// general en products.base_price. La base copia los valores generales a las
// variantes que los heredan (price_inherited / cost_inherited).

// Map productId → { sku, base_cost } de todos los productos que tienen datos internos.
export async function listProductInternals() {
  const rows = check(await supabase.from("product_internal").select("product_id, sku, base_cost"));
  return new Map(rows.map((r) => [r.product_id, { sku: r.sku ?? null, base_cost: r.base_cost == null ? null : Number(r.base_cost) }]));
}

export async function getProductInternal(productId) {
  const row = check(await supabase.from("product_internal").select("sku, base_cost").eq("product_id", productId).maybeSingle());
  return { sku: row?.sku ?? null, base_cost: row?.base_cost == null ? null : Number(row.base_cost) };
}

// Guarda solo las claves presentes en "changes": { sku, base_price, base_cost }.
// null borra el valor general (las variantes conservan el que tienen).
export async function saveProductPricing(productId, changes) {
  if ("base_price" in changes) {
    ensureSaved(check(await supabase.from("products").update({ base_price: changes.base_price }).eq("id", productId).select("id")));
  }
  const internal = {};
  if ("sku" in changes) internal.sku = normalizeSku(changes.sku);
  if ("base_cost" in changes) internal.base_cost = changes.base_cost;
  if (Object.keys(internal).length) {
    check(await supabase.from("product_internal").upsert({ product_id: productId, ...internal }, { onConflict: "product_id" }).select("product_id"));
  }
}

// Vuelve una variante al precio y/o costo general (la base copia el valor).
export async function useGeneral(variantId, { price = false, cost = false }) {
  const fields = {};
  if (price) fields.price_inherited = true;
  if (cost) fields.cost_inherited = true;
  return updateVariant(variantId, fields);
}

// ---------- SKU ----------
// Un SKU por producto (product_internal.sku), compartido por sus variantes.
// Se compara siempre recortando espacios, respetando mayúsculas y minúsculas.
export function normalizeSku(value) {
  const s = String(value ?? "").trim();
  return s === "" ? null : s;
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
