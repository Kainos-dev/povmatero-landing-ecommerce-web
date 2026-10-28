// Imágenes de productos: registros en product_images + archivos en Storage.
//
// Dos orígenes, distinguidos por cómo empieza "src":
//   * Repo:    "images/2300/a.webp"  → archivo del sitio. El panel NUNCA lo borra.
//   * Storage: URL pública del bucket product-images, en products/<id>/…
import { supabase } from "/js/lib/supabaseClient.js";
import { SUPABASE_URL } from "/js/lib/supabaseConfig.js";

const BUCKET = "product-images";
export const STORAGE_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
const IMAGE_COLUMNS = "id, product_id, variant_id, src, alt, is_cover, sort_order";
const IMAGE_EXT = /\.(webp|jpe?g|png|avif)$/i;

function check({ data, error }) {
  if (error) throw error;
  return data;
}

function notSaved(action) {
  const err = new Error(`No se pudo ${action}. Puede que no tengas permisos o que la imagen ya no exista.`);
  err.code = "NOT_SAVED";
  return err;
}

// ---------- Origen y rutas ----------
export function imageSource(src) {
  if (src.startsWith(STORAGE_PREFIX)) return "storage";
  if (src.startsWith("images/")) return "repo";
  return "other";
}

export function storagePathFromSrc(src) {
  if (!src.startsWith(STORAGE_PREFIX)) return null;
  try {
    return decodeURIComponent(src.slice(STORAGE_PREFIX.length));
  } catch {
    return null;
  }
}

// URL para mostrar en el panel (/admin está en otra carpeta: las rutas del repo van desde la raíz).
export function previewUrl(src) {
  return imageSource(src) === "repo" ? `/${encodeURI(src)}` : src;
}

// Devuelve un mensaje de error o null si la ruta es aceptable.
export function validateRepoPath(path) {
  if (!path) return "Ingresá la ruta de la imagen.";
  if (!path.startsWith("images/")) return "La ruta tiene que empezar con images/ (ej. images/2300/a.webp).";
  if (path.includes("..") || path.includes("\\") || path.includes("//") || path.includes("://")) {
    return "La ruta no es válida.";
  }
  if (!IMAGE_EXT.test(path)) return "Tiene que ser una imagen .webp, .jpg, .png o .avif.";
  return null;
}

// Comprueba que el archivo exista en el sitio publicado (o en Live Server).
export async function repoFileExists(path) {
  try {
    const res = await fetch(`/${encodeURI(path)}`, { method: "HEAD", cache: "no-store" });
    const type = res.headers.get("content-type") ?? "";
    return res.ok && (type === "" || type.startsWith("image/"));
  } catch {
    return false;
  }
}

// ---------- Registros ----------
export async function listImages(productId) {
  return check(
    await supabase
      .from("product_images")
      .select(IMAGE_COLUMNS)
      .eq("product_id", productId)
      .order("sort_order")
      .order("id")
  );
}

export async function addImage({ productId, variantId = null, src, alt = "", isCover = false, sortOrder = 0 }) {
  return check(
    await supabase
      .from("product_images")
      .insert({ product_id: productId, variant_id: variantId, src, alt, is_cover: isCover, sort_order: sortOrder })
      .select(IMAGE_COLUMNS)
      .single()
  );
}

// fields: alt, variant_id, is_cover, sort_order
export async function updateImage(id, fields) {
  const rows = check(await supabase.from("product_images").update(fields).eq("id", id).select("id"));
  if (!rows.length) throw notSaved("guardar la imagen");
  return rows[0];
}

// ---------- Storage ----------
function safeBaseName(name) {
  const base = String(name ?? "")
    .replace(/\.[^.]+$/, "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "imagen";
}

// Devuelve true si el archivo se borró. false si Storage no encontró nada para borrar
// (por ejemplo, si falta el permiso de lectura de Storage para admins).
async function removeStorageFile(path) {
  const { data, error } = await supabase.storage.from(BUCKET).remove([path]);
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

// Sube un WebP ya convertido y registra la imagen. Nunca reemplaza archivos existentes.
// Si el registro falla, intenta borrar el archivo recién subido.
export async function uploadImage(productId, blob, originalName, { variantId = null, alt = "", isCover = false, sortOrder = 0 } = {}) {
  const random = Math.random().toString(36).slice(2, 8);
  const path = `products/${productId}/${safeBaseName(originalName)}-${Date.now().toString(36)}${random}.webp`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, {
    contentType: "image/webp",
    cacheControl: "31536000",
    upsert: false,
  });
  if (error) throw error;

  const src = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  try {
    return await addImage({ productId, variantId, src, alt, isCover, sortOrder });
  } catch (err) {
    try { await removeStorageFile(path); } catch { /* queda un archivo sin uso */ }
    throw err;
  }
}

// Elimina una imagen. Orden: primero el registro (así nunca queda una referencia
// rota), después el archivo, y solo si es seguro borrarlo.
// Devuelve { source, fileRemoved, reason }.
export async function deleteImage(image, productId) {
  const rows = check(await supabase.from("product_images").delete().eq("id", image.id).select("id"));
  if (!rows.length) throw notSaved("eliminar la imagen");

  const source = imageSource(image.src);
  if (source !== "storage") return { source, fileRemoved: false, reason: null };

  const path = storagePathFromSrc(image.src);
  if (!path || path.includes("..") || !path.startsWith(`products/${productId}/`)) {
    return { source, fileRemoved: false, reason: "el archivo no está en la carpeta de este producto" };
  }

  const { count, error } = await supabase
    .from("product_images")
    .select("id", { count: "exact", head: true })
    .eq("src", image.src);
  if (error) return { source, fileRemoved: false, reason: "no se pudo verificar si otra imagen usa el archivo" };
  if (count > 0) return { source, fileRemoved: false, reason: "otra imagen usa el mismo archivo" };

  try {
    const removed = await removeStorageFile(path);
    return {
      source,
      fileRemoved: removed,
      reason: removed ? null : "falta el permiso de lectura de Storage (migración pendiente)",
    };
  } catch (err) {
    return { source, fileRemoved: false, reason: err?.message || "error al borrar el archivo" };
  }
}
