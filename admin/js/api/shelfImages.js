// Imágenes de góndola (/yerbas): una por yerba, independiente de las fotos
// del catálogo.
//   * Referencia: products.shelf_image (URL pública). Ver la migración
//     20261106000000_shelf_images.sql.
//   * Archivo: mismo bucket que las fotos (product-images), en
//     products/<id>/shelf-<fecha>.<ext>. Cada carga usa un nombre nuevo, así la
//     tienda nunca muestra una versión vieja guardada en caché.
//   * No es un registro de product_images: el catálogo tradicional no la ve.
import { supabase } from "/js/lib/supabaseClient.js";
import { storagePathFromSrc } from "./images.js";

const BUCKET = "product-images";
export const MAX_BYTES = 5 * 1024 * 1024;        // límite del bucket
export const TYPES = { "image/png": "png", "image/webp": "webp" };

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Yerbas (publicadas o no) con su imagen de góndola.
export async function listYerbasWithShelfImage() {
  const cat = check(await supabase.from("categories").select("id").eq("slug", "yerbas").maybeSingle());
  if (!cat) return [];
  return check(await supabase
    .from("products")
    .select("id, name, brand, is_active, sort_order, shelf_image")
    .eq("category_id", cat.id)
    .order("sort_order")
    .order("id"));
}

const shelfPrefix = (productId) => `products/${productId}/shelf-`;

async function removeFile(productId, src) {
  const path = src ? storagePathFromSrc(src) : null;
  // Solo archivos de góndola de este producto (nunca fotos del catálogo).
  if (!path || !path.startsWith(shelfPrefix(productId)) || path.includes("..")) return;
  const { error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
}

// Sube (o reemplaza) la imagen de góndola. Devuelve { url, oldFileKept }.
export async function uploadShelfImage(product, file) {
  const ext = TYPES[file.type];
  if (!ext) throw new Error("Tiene que ser un PNG (o WebP), idealmente con fondo transparente.");
  if (file.size > MAX_BYTES) throw new Error("La imagen pesa más de 5 MB. Exportala más liviana (600 × 900 px alcanza).");

  const path = `${shelfPrefix(product.id)}${Date.now()}.${ext}`;
  check(await supabase.storage.from(BUCKET).upload(path, file, {
    contentType: file.type,
    cacheControl: "31536000",
    upsert: false,
  }));
  const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const { data, error } = await supabase
    .from("products")
    .update({ shelf_image: url })
    .eq("id", product.id)
    .select("id, shelf_image");
  if (error || !data?.length) {
    // No se guardó la referencia: el archivo nuevo no se usa, se borra.
    await supabase.storage.from(BUCKET).remove([path]).catch(() => {});
    if (error) throw error;
    throw new Error("No se pudo guardar. Puede que no tengas permisos o que el producto ya no exista.");
  }

  // La anterior ya no se usa: se borra (si falla, queda un archivo sin uso, sin romper nada).
  let oldFileKept = false;
  if (product.shelf_image && product.shelf_image !== url) {
    try { await removeFile(product.id, product.shelf_image); } catch (err) { console.warn(err); oldFileKept = true; }
  }
  return { url, oldFileKept };
}

// Quita la imagen de góndola (la yerba vuelve al paquete genérico).
export async function removeShelfImage(product) {
  const { data, error } = await supabase
    .from("products")
    .update({ shelf_image: null })
    .eq("id", product.id)
    .select("id");
  if (error) throw error;
  if (!data?.length) throw new Error("No se pudo quitar. Puede que no tengas permisos.");
  let fileKept = false;
  try { await removeFile(product.id, product.shelf_image); } catch (err) { console.warn(err); fileKept = true; }
  return { fileKept };
}

// Al eliminar un producto: borra sus archivos de góndola (products/<id>/shelf-*).
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
