// Imágenes de góndola (/yerbas), independientes de las fotos del catálogo:
//   * General de la yerba: products.shelf_image (migración 20261106000000).
//     Archivo: products/<producto>/shelf-<fecha>.<ext>
//   * Propia de una presentación (opcional): product_variants.shelf_image
//     (migración 20261107000000). Archivo: products/<producto>/shelf-v<presentación>-<fecha>.<ext>
//     Si una presentación no tiene la suya, /yerbas usa la general.
// Cada carga usa un nombre nuevo (la tienda nunca ve una versión vieja en
// caché) y al reemplazar o quitar se borra SOLO el archivo de esa imagen:
// nunca el de otra presentación, ni la general, ni fotos del catálogo.
// No son registros de product_images: el catálogo tradicional no las ve.
import { supabase } from "/js/lib/supabaseClient.js";
import { storagePathFromSrc } from "./images.js";

const BUCKET = "product-images";
export const MAX_BYTES = 5 * 1024 * 1024;        // límite del bucket
export const TYPES = { "image/png": "png", "image/webp": "webp" };

function check({ data, error }) {
  if (error) throw error;
  return data;
}

const isMissingColumn = (err) => err?.code === "42703" || /shelf_image/.test(err?.message ?? "");

// Yerbas (publicadas o no) con su imagen general y sus presentaciones.
// Devuelve { products, variantsReady }: variantsReady = false si todavía no
// está aplicada la migración de imágenes por presentación.
export async function listYerbasWithShelfImage() {
  const cat = check(await supabase.from("categories").select("id").eq("slug", "yerbas").maybeSingle());
  if (!cat) return { products: [], variantsReady: true };
  const products = check(await supabase
    .from("products")
    .select("id, name, brand, is_active, sort_order, shelf_image")
    .eq("category_id", cat.id)
    .order("sort_order")
    .order("id"));
  let variantsReady = true;
  let variants = [];
  if (products.length) {
    const { data, error } = await supabase
      .from("product_variants")
      .select("id, product_id, name, is_active, sort_order, shelf_image")
      .in("product_id", products.map((p) => p.id))
      .order("sort_order")
      .order("id");
    if (error) {
      if (!isMissingColumn(error)) throw error;
      variantsReady = false;
    } else {
      variants = data ?? [];
    }
  }
  for (const p of products) p.variants = variants.filter((v) => v.product_id === p.id);
  return { products, variantsReady };
}

// A qué se le carga la imagen: la general de un producto o la de una presentación.
//   productTarget(product)          → products.shelf_image
//   variantTarget(product, variant) → product_variants.shelf_image
export const productTarget = (product) => ({
  table: "products",
  id: product.id,
  current: product.shelf_image,
  pathFor: (ext) => `products/${product.id}/shelf-${Date.now()}.${ext}`,
  owns: (path) => new RegExp(`^products/${product.id}/shelf-\\d+\\.(png|webp)$`).test(path),
});
export const variantTarget = (product, variant) => ({
  table: "product_variants",
  id: variant.id,
  current: variant.shelf_image,
  pathFor: (ext) => `products/${product.id}/shelf-v${variant.id}-${Date.now()}.${ext}`,
  owns: (path) => new RegExp(`^products/${product.id}/shelf-v${variant.id}-\\d+\\.(png|webp)$`).test(path),
});

// Borra el archivo de esa imagen, solo si es suyo (ver «owns»).
async function removeFile(target, src) {
  const path = src ? storagePathFromSrc(src) : null;
  if (!path || !target.owns(path)) return;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}

// Sube (o reemplaza) la imagen. Devuelve { url, oldFileKept }.
export async function uploadShelfImage(target, file) {
  const ext = TYPES[file.type];
  if (!ext) throw new Error("Tiene que ser un PNG (o WebP), idealmente con fondo transparente.");
  if (file.size > MAX_BYTES) throw new Error("La imagen pesa más de 5 MB. Exportala más liviana (600 × 900 px alcanza).");

  const path = target.pathFor(ext);
  check(await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: "31536000",
    upsert: false,
  }));
  const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const { data, error } = await supabase
    .from(target.table)
    .update({ shelf_image: url })
    .eq("id", target.id)
    .select("id, shelf_image");
  if (error || !data?.length) {
    // No se guardó la referencia: el archivo nuevo no se usa, se borra.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    if (error) throw error;
    throw new Error("No se pudo guardar. Puede que no tengas permisos o que ya no exista.");
  }

  // La anterior ya no se usa: se borra (si falla, queda un archivo sin uso, sin romper nada).
  let oldFileKept = false;
  if (target.current && target.current !== url) {
    try { await removeFile(target, target.current); } catch (err) { console.warn(err); oldFileKept = true; }
  }
  return { url, oldFileKept };
}

// Quita la imagen (la presentación vuelve a usar la general; la general, el paquete genérico).
export async function removeShelfImage(target) {
  const { data, error } = await supabase
    .from(target.table)
    .update({ shelf_image: null })
    .eq("id", target.id)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("No se pudo quitar. Puede que no tengas permisos.");
  let fileKept = false;
  try { await removeFile(target, target.current); } catch (err) { console.warn(err); fileKept = true; }
  return { fileKept };
}

// Al eliminar un producto: borra todos sus archivos de góndola
// (products/<id>/shelf-*: la general y las de sus presentaciones).
export async function removeShelfFiles(productId) {
  const folder = `products/${productId}`;
  const { data, error } = await supabase.storage.from(BUCKET).list(folder, { limit: 100, search: "shelf-" });
  if (error) throw error;
  const paths = (data ?? []).filter((f) => f.name.startsWith("shelf-")).map((f) => `${folder}/${f.name}`);
  if (paths.length) check(await supabase.storage.from(BUCKET).remove(paths));
  return paths.length;
}

// Revisa la imagen antes de subirla: medidas, proporción y transparencia.
// Devuelve { width, height, warnings: [] }. Nunca la modifica.
export async function inspectImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("No se pudo leer la imagen. Probá exportarla de nuevo como PNG.");
  }
  const { width, height } = bitmap;
  const warnings = [];
  const ratio = width / height;
  if (Math.abs(ratio - 2 / 3) > 0.03) {
    warnings.push(`Mide ${width} × ${height} px: no es 2:3. Se va a ver entera y sin deformar, pero con espacio a los costados o arriba.`);
  }
  if (height < 600) warnings.push(`Es chica (${height} px de alto): puede verse borrosa. Ideal: 600 × 900 px.`);

  // ¿Tiene fondo transparente? Se miran las esquinas.
  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(width, 120);
    canvas.height = Math.round(canvas.width * height / width) || 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const corners = [[0, 0], [canvas.width - 1, 0], [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1]];
    const transparent = corners.some(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] < 250);
    if (!transparent) warnings.push("No parece tener fondo transparente: en la góndola se va a ver el fondo de la imagen.");
  } catch { /* si no se puede revisar, se sube igual */ }
  bitmap.close?.();
  return { width, height, warnings };
}
