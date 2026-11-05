// Orden de las góndolas de /yerbas y casilla «Otras marcas»
// (migración 20261113000000_shelf_order.sql).
//
//   * shelf_brands: una fila por marca de yerba, con su posición. La base la
//     llena sola (marca nueva → al final).
//   * products.shelf_other: la yerba va a «Otras marcas» aunque tenga marca.
//   * products.shelf_position: su lugar dentro de la góndola.
// El orden se guarda solo con las funciones admin_set_shelf_*: reciben el orden
// nuevo y el que se tenía a la vista, y rechazan (hint stale_order) si otro
// administrador lo cambió mientras tanto.
//
// Mientras la migración no esté aplicada, shelfOrderReady() da false y el panel
// funciona como antes (sin casilla ni orden).
import { supabase } from "/js/lib/supabaseClient.js";

function check({ data, error }) {
  if (error) throw error;
  return data;
}

export const OTHER_KEY = "";             // clave de la góndola «Otras marcas»
export const OTHER_NAME = "Otras marcas";

// Misma regla que public.shelf_brand_key: minúsculas, sin tildes, solo letras y números.
export function brandKey(text) {
  const key = String(text ?? "").trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return key || null;
}

// ¿Se ve en /yerbas? (publicada y con al menos una presentación publicada con precio)
export const isOnShelf = (p) => !!p.is_active && (p.variants ?? []).some((v) => v.is_active && Number(v.price) > 0);

// Columna o tabla que todavía no existe (migración sin aplicar).
export function missingSchema(err) {
  return ["42703", "42P01", "PGRST205", "PGRST204", "PGRST202", "42883"].includes(err?.code)
    || /shelf_other|shelf_position|shelf_brands|admin_set_shelf/.test(err?.message ?? "");
}

let readyPromise = null;
export function shelfOrderReady() {
  readyPromise ??= supabase.from("products").select("id, shelf_other").limit(1)
    .then(({ error }) => {
      if (!error) return true;
      if (!missingSchema(error)) console.warn("No se pudo verificar la casilla «Otras marcas»:", error);
      readyPromise = null;            // se vuelve a probar la próxima vez
      return false;
    });
  return readyPromise;
}

// Todo lo que necesita la pantalla de orden.
//   { brands: [{ key, name, position }], products: [{ id, name, brand, is_active, shelf_other, shelf_position, shelf_image, variants }] }
export async function loadShelfOrder() {
  const cat = check(await supabase.from("categories").select("id").eq("slug", "yerbas").maybeSingle());
  const [brands, products] = await Promise.all([
    supabase.from("shelf_brands").select("key, name, position").order("position").then(check),
    cat
      ? supabase.from("products")
          .select("id, name, brand, is_active, shelf_other, shelf_position, shelf_image, product_variants (id, name, price, is_active, sort_order, shelf_image)")
          .eq("category_id", cat.id)
          .then(check)
      : Promise.resolve([]),
  ]);
  for (const p of products) {
    p.variants = (p.product_variants ?? []).slice().sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    delete p.product_variants;
  }
  products.sort((a, b) => a.shelf_position - b.shelf_position || a.id - b.id);
  brands.sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
  // Góndola de cada yerba con la clave que guardó la base (la marca ya está
  // escrita igual que en shelf_brands; brandKey es solo el respaldo).
  const keyByName = new Map(brands.map((b) => [b.name, b.key]));
  for (const p of products) {
    p.group = p.shelf_other || !p.brand ? OTHER_KEY : keyByName.get(p.brand) ?? brandKey(p.brand) ?? OTHER_KEY;
  }
  return { brands, products };
}

export async function saveBrandOrder(keys, expected) {
  return check(await supabase.rpc("admin_set_shelf_brand_order", { brand_keys: keys, expected_keys: expected }));
}

export async function saveProductOrder(groupKey, ids, expected) {
  return check(await supabase.rpc("admin_set_shelf_product_order", {
    group_key: groupKey, product_ids: ids.map(Number), expected_ids: expected.map(Number),
  }));
}

// Casilla «Otras marcas» de una yerba. null = la base todavía no la tiene.
export async function getShelfOther(productId) {
  const { data, error } = await supabase.from("products").select("shelf_other").eq("id", productId).maybeSingle();
  if (error) {
    if (missingSchema(error)) return null;
    throw error;
  }
  return data?.shelf_other === true;
}

// Mensaje claro para los rechazos de las funciones de orden.
export function orderErrorMessage(err, fallback) {
  if (err?.hint === "stale_order") return "Otro administrador cambió este orden mientras lo editabas. Recargá para ver el orden actual y volvé a ordenarlo.";
  if (err?.hint === "invalid_order") return "La lista cambió (se agregó o quitó una yerba o una marca). Recargá y volvé a intentarlo.";
  if (err?.hint === "admin_only" || err?.code === "42501") return "No tenés permisos para ordenar las góndolas.";
  return fallback;
}
