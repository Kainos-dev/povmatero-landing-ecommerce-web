// Yerbas y sus presentaciones (500 g, 1 kg…), sobre el modelo de siempre:
//   yerba        = un producto de la categoría «yerbas» (marca, nombre, fotos,
//                  imagen general de góndola)
//   presentación = una variante de ese producto, con su propio precio, costo,
//                  stock, SKU (variant_internal.sku) e imagen de góndola opcional
// No hace falta ninguna tabla nueva: todo lo que lista variantes (tienda,
// /yerbas, góndola, pedidos, pedidos a proveedor, stock) ve la presentación
// nueva sola.
import { supabase } from "/js/lib/supabaseClient.js";
import { createProduct, createVariant, updateProduct, saveVariantCost, normalizeSku } from "./catalog.js";
import { registerQuickMovement, newKey } from "./stockTools.js";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// ---------- Presentaciones: nombre y peso ----------
// Las presentaciones se guardan como siempre («500gr», «1kg»): así coinciden
// con las existentes, con los pedidos ya hechos y con lo que entiende /yerbas.
export const PRESETS = [
  { grams: 250, label: "250 g" },
  { grams: 500, label: "500 g" },
  { grams: 1000, label: "1 kg" },
  { grams: 2000, label: "2 kg" },
];

// Gramos de un nombre («500gr», «500 g», «1kg», «1,5 kg»), o null.
export function gramsOf(name) {
  const text = String(name ?? "").trim().replace(",", ".");
  let m = text.match(/^(\d+(?:\.\d+)?)\s*(?:g|gr|grs|gramos)\.?$/i);
  if (m) return Number(m[1]);
  m = text.match(/^(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo|kilos)\.?$/i);
  if (m) return Math.round(Number(m[1]) * 1000);
  return null;
}

// Nombre que se guarda: los pesos con el formato de siempre; lo demás, tal cual.
export function presentationName(text) {
  const g = gramsOf(text);
  if (g == null) return String(text ?? "").trim().replace(/\s+/g, " ");
  return g >= 1000 && g % 1000 === 0 ? `${g / 1000}kg` : `${String(g).replace(".", ",")}gr`;
}

// Cómo se muestra («500gr» → «500 g»).
export function presentationLabel(name) {
  const g = gramsOf(name);
  if (g == null) return name === "Único" ? "Unidad" : String(name ?? "");
  return g >= 1000 ? `${String(g / 1000).replace(".", ",")} kg` : `${String(g).replace(".", ",")} g`;
}

// ¿Ya tiene esa presentación? (mismo peso o mismo nombre).
export function findSamePresentation(variants, name) {
  const g = gramsOf(name);
  const key = String(name ?? "").trim().toLowerCase();
  return variants.find((v) => (g != null && gramsOf(v.name) === g) || v.name.trim().toLowerCase() === key) ?? null;
}

// Orden: de menor a mayor peso (las que no son peso, al final).
export function presentationSort(name, fallback) {
  const g = gramsOf(name);
  return g == null ? 100000 + fallback : g;
}

// ---------- Lecturas ----------
export async function yerbasCategory() {
  return check(await supabase.from("categories").select("id, slug, name").eq("slug", "yerbas").maybeSingle());
}

// Todas las yerbas (publicadas o no) con sus presentaciones, para el buscador.
export async function listYerbas() {
  const cat = await yerbasCategory();
  if (!cat) return [];
  const products = check(await supabase
    .from("products")
    .select("id, name, slug, brand, is_active, sort_order, product_variants (id, name, price, stock, track_stock, is_active, sort_order)")
    .eq("category_id", cat.id)
    .order("name"));
  for (const p of products) {
    p.variants = (p.product_variants ?? []).map((v) => ({ ...v, price: Number(v.price) }))
      .sort((a, b) => presentationSort(a.name, a.sort_order) - presentationSort(b.name, b.sort_order) || a.id - b.id);
    delete p.product_variants;
  }
  return products;
}

// Marcas cargadas (para sugerir y no escribir «Canarias» de dos formas).
export async function listBrands() {
  const rows = check(await supabase.from("products").select("brand").not("brand", "is", null));
  const seen = new Map();
  for (const r of rows) {
    const b = String(r.brand ?? "").trim();
    if (b && !seen.has(b.toLowerCase())) seen.set(b.toLowerCase(), b);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, "es"));
}

// Misma marca escrita distinto («canarias» → «Canarias»).
export function matchBrand(brands, text) {
  const t = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!t) return null;
  return brands.find((b) => b.toLowerCase() === t.toLowerCase()) ?? t;
}

// SKU propio de cada presentación: Map variantId → sku.
export async function listVariantSkus(variantIds) {
  if (!variantIds.length) return new Map();
  const rows = check(await supabase.from("variant_internal").select("variant_id, sku").in("variant_id", variantIds));
  return new Map(rows.filter((r) => r.sku != null).map((r) => [r.variant_id, r.sku]));
}

// Todos los SKU de presentaciones (para el importador de precios).
export async function listAllVariantSkus() {
  const rows = check(await supabase.from("variant_internal").select("variant_id, sku").not("sku", "is", null));
  return new Map(rows.map((r) => [r.variant_id, r.sku]));
}

// ¿Quién usa este SKU? Busca en productos y en presentaciones.
// Devuelve { kind: "product" | "variant", productId, variantId, name } o null.
// «except»: { productId, variantId } que no cuentan (el mismo que se edita).
export async function findSkuOwner(sku, except = {}) {
  const value = normalizeSku(sku);
  if (!value) return null;
  const [products, variants] = await Promise.all([
    supabase.from("product_internal").select("product_id, product:products (name)").eq("sku", value).then(check),
    supabase.from("variant_internal").select("variant_id, variant:product_variants (name, product_id, product:products (name))").eq("sku", value).then(check),
  ]);
  const v = variants.find((r) => r.variant_id !== except.variantId);
  if (v) return { kind: "variant", variantId: v.variant_id, productId: v.variant?.product_id ?? null, name: `${v.variant?.product?.name ?? "Otro producto"} · ${presentationLabel(v.variant?.name)}` };
  // El SKU general de la misma yerba no es un choque (suele ser el de su primera presentación).
  const p = products.find((r) => r.product_id !== except.productId);
  if (p) return { kind: "product", productId: p.product_id, variantId: null, name: p.product?.name ?? "Otro producto" };
  return null;
}

export function skuTakenMessage(sku, owner) {
  return `El SKU ${sku} ya lo usa «${owner.name}». Cada SKU identifica a un solo artículo.`;
}

// ---------- Escrituras ----------
// Guarda (o borra, con null) el SKU propio de una presentación.
export async function saveVariantSku(variantId, sku) {
  const value = normalizeSku(sku);
  if (value && value.length > 64) throw new Error("El SKU puede tener hasta 64 caracteres.");
  check(await supabase.from("variant_internal")
    .upsert({ variant_id: variantId, sku: value }, { onConflict: "variant_id" })
    .select("variant_id"));
}

// Valida los datos de una presentación. Devuelve un mensaje o null.
//   data: { name, price, cost, stock, sku }
export function presentationProblem(data, existing = []) {
  if (!data.name) return "Elegí la presentación (500 g, 1 kg u otra).";
  if (data.name.length > 80) return "El nombre de la presentación es muy largo.";
  const same = findSamePresentation(existing, data.name);
  if (same) return `Esta yerba ya tiene la presentación ${presentationLabel(same.name)}${same.is_active ? "" : " (oculta)"}. Editala desde su ficha.`;
  if (data.price == null || Number.isNaN(data.price) || data.price <= 0) return "Ingresá el precio de venta (mayor a 0).";
  if (Number.isNaN(data.cost) || (data.cost != null && data.cost < 0)) return "El costo debe ser un número mayor o igual a 0 (o vacío).";
  if (!Number.isInteger(data.stock) || data.stock < 0 || data.stock > 99999) return "El stock inicial debe ser un número entero entre 0 y 99999.";
  if (data.sku && data.sku.length > 64) return "El SKU puede tener hasta 64 caracteres.";
  return null;
}

// Crea una presentación en una yerba (producto) existente.
//   product:  { id, name, variants }   (variants = las que ya tiene)
//   data:     { name, price, cost, stock, sku, isActive }
// Pasos: presentación → SKU → costo → stock inicial (entrada «Stock inicial»,
// con clave propia: un reintento no la duplica). Si un paso posterior a crear
// la presentación falla, la presentación queda creada y se informa qué faltó
// (se completa desde su ficha). Devuelve { variantId, problems: [texto] }.
export async function createPresentation(product, data, { stockKey = newKey() } = {}) {
  const name = presentationName(data.name);
  const problem = presentationProblem({ ...data, name }, product.variants ?? []);
  if (problem) throw Object.assign(new Error(problem), { code: "INVALID" });
  const sku = normalizeSku(data.sku);
  if (sku) {
    const owner = await findSkuOwner(sku, { productId: product.id });
    if (owner) throw Object.assign(new Error(skuTakenMessage(sku, owner)), { code: "SKU_TAKEN" });
  }

  const created = await createVariant(product.id, {
    name,
    price: data.price,
    track_stock: true,
    is_active: data.isActive !== false,
    // Al final de las que ya tiene (la góndola las ordena por peso sola).
    sort_order: Math.max(-1, ...(product.variants ?? []).map((v) => Number(v.sort_order) || 0)) + 1,
    // Cada presentación tiene su precio y su costo: no hereda los de otra.
    price_inherited: false,
    cost_inherited: false,
  });

  const problems = [];
  if (sku) {
    try { await saveVariantSku(created.id, sku); }
    catch (err) { console.error(err); problems.push(`el SKU (${err?.code === "23505" ? "ya está en uso" : err.message})`); }
  }
  if (data.cost != null) {
    try { await saveVariantCost(created.id, data.cost); }
    catch (err) { console.error(err); problems.push("el costo"); }
  }
  if (data.stock > 0) {
    try {
      await registerQuickMovement({ variantId: created.id, type: "entrada", quantity: data.stock,
        reason: "Stock inicial", reference: "Alta de presentación", key: stockKey, source: "inventario" });
    } catch (err) { console.error(err); problems.push("el stock inicial"); }
  }
  return { variantId: created.id, problems };
}

// Crea una yerba nueva (borrador o publicada) con su primera presentación.
//   yerba: { name, brand, description, slug, sortOrder, publish }
// Si falla la presentación, la yerba queda en borrador (no se ve en la tienda).
// Devuelve { productId, variantId, problems }.
export async function createYerba(categoryId, yerba, presentation, options) {
  const product = await createProduct({
    category_id: categoryId,
    name: yerba.name,
    slug: yerba.slug,
    description: yerba.description ?? "",
    brand: yerba.brand || null,
    sort_order: yerba.sortOrder ?? 0,
  });
  const result = await createPresentation({ id: product.id, name: yerba.name, variants: [] }, presentation, options)
    .catch((err) => { err.productId = product.id; throw err; });
  if (yerba.publish) {
    try { await updateProduct(product.id, { is_active: true }); }
    catch (err) { console.error(err); result.problems.push("publicarla (quedó en borrador)"); }
  }
  return { productId: product.id, ...result };
}

// ¿Ya existe una yerba con ese nombre? (para no duplicarla sin querer)
export function findYerbaByName(yerbas, name) {
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const key = norm(name);
  return key ? yerbas.find((y) => norm(y.name) === key) ?? null : null;
}
