// Optimización de imágenes que ya están en Storage (góndola y fotos).
//
// Por cada imagen elegida:
//   1. descarga el original UNA vez (lo pide la persona, nunca solo);
//   2. lo convierte en el navegador a WebP (con la misma transparencia);
//   3. sube la versión nueva con un nombre NUEVO (upsert: false: nunca pisa
//      un archivo) y comprueba que su URL pública responda;
//   4. cambia la referencia en la base SOLO si sigue apuntando al original
//      (si alguien la cambió mientras tanto, no toca nada y borra la copia nueva).
// El original NUNCA se borra: queda en Storage como respaldo y su URL sigue
// funcionando (por ejemplo, en cachés o enlaces ya compartidos). Cada cambio
// queda en un registro local (y se puede descargar) para revertirlo.
import { supabase } from "/js/lib/supabaseClient.js";
import { STORAGE_PREFIX, storagePathFromSrc, checkImageUrl, listAllImages } from "./images.js";
import { listYerbasWithShelfImage } from "./shelfImages.js";
import { convertKeepingAlpha, SHELF_MAX_SIDE, SHELF_QUALITY, MAX_SIDE, QUALITY } from "../imageConvert.js";

const BUCKET = "product-images";
const LOG_KEY = "povmatero-optimizacion-imagenes";
export const MAX_PER_RUN = 40;              // tope de imágenes por tanda
export const WEBP_WORTH_BYTES = 700 * 1024; // un WebP más pesado que esto también se ofrece

function check({ data, error }) {
  if (error) throw error;
  return data;
}

const extOf = (path) => (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
const baseOf = (path) => (path.split("/").pop() ?? "imagen").replace(/\.[^.]+$/, "").replace(/-opt-[a-z0-9]+$/, "").slice(0, 50) || "imagen";

// Imágenes en Storage que se pueden optimizar.
// kind: "shelf" (góndola de la yerba) | "shelf-variant" (góndola de una presentación) | "photo" (catálogo)
export async function listCandidates() {
  const [{ products }, images] = await Promise.all([listYerbasWithShelfImage(), listAllImages()]);
  const out = [];
  const add = (c) => {
    const path = storagePathFromSrc(c.src);
    if (!path || !path.startsWith(`products/${c.productId}/`)) return;
    out.push({ ...c, path, ext: extOf(path) });
  };
  for (const p of products) {
    if (p.shelf_image) add({ key: `shelf:${p.id}`, kind: "shelf", table: "products", column: "shelf_image", id: p.id, productId: p.id, label: p.name, detail: "Góndola · general", src: p.shelf_image });
    for (const v of p.variants ?? []) {
      if (v.shelf_image) add({ key: `shelfv:${v.id}`, kind: "shelf-variant", table: "product_variants", column: "shelf_image", id: v.id, productId: p.id, variantId: v.id, label: p.name, detail: `Góndola · ${v.name}`, src: v.shelf_image });
    }
  }
  const names = check(await supabase.from("products").select("id, name"));
  const productName = new Map(names.map((p) => [p.id, p.name]));
  for (const i of images) {
    if (!i.src.startsWith(STORAGE_PREFIX)) continue;
    add({ key: `img:${i.id}`, kind: "photo", table: "product_images", column: "src", id: i.id, productId: i.product_id, label: productName.get(i.product_id) ?? `Producto ${i.product_id}`, detail: i.is_cover ? "Foto · portada" : "Foto", src: i.src });
  }
  return out;
}

// ¿Vale la pena? PNG y JPEG siempre; WebP solo si es pesado.
export function isWorth(c) {
  if (["png", "jpg", "jpeg"].includes(c.ext)) return true;
  return c.ext === "webp" && (c.bytes ?? 0) > WEBP_WORTH_BYTES;
}

// Tamaños con HEAD (no descarga el contenido). Completa c.bytes.
export async function measure(candidates, { concurrency = 6, onProgress } = {}) {
  let done = 0;
  const queue = [...candidates];
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const probe = await checkImageUrl(c.src);
      c.bytes = probe.bytes;
      c.reachable = probe.ok;
      onProgress?.(++done, candidates.length);
    }
  }));
  return candidates;
}

function newPath(c) {
  const ts = Date.now();
  if (c.kind === "shelf") return `products/${c.productId}/shelf-${ts}.webp`;
  if (c.kind === "shelf-variant") return `products/${c.productId}/shelf-v${c.variantId}-${ts}.webp`;
  return `products/${c.productId}/${baseOf(c.path)}-opt-${ts.toString(36)}.webp`;
}

// Optimiza una imagen. Devuelve { status, entry? }:
//   "done" (con entry para el registro), "skipped" (no ahorra), "changed" (la
//   referencia cambió mientras tanto: no se tocó nada).
export async function optimizeOne(c) {
  const res = await fetch(c.src);
  if (!res.ok) throw new Error(`No se pudo leer el original (estado ${res.status}).`);
  const original = await res.blob();
  const file = new File([original], c.path.split("/").pop(), { type: original.type || `image/${c.ext === "jpg" ? "jpeg" : c.ext}` });
  const isShelf = c.kind !== "photo";
  const { blob, width, height, changed } = await convertKeepingAlpha(file, isShelf
    ? { maxSide: SHELF_MAX_SIDE, quality: SHELF_QUALITY }
    : { maxSide: MAX_SIDE, quality: QUALITY });
  if (!changed || blob.size >= original.size * 0.9) return { status: "skipped", before: original.size };

  const path = newPath(c);
  check(await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/webp", cacheControl: "31536000", upsert: false }));
  const url = supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const removeNew = () => supabase.storage.from(BUCKET).remove([path]).catch(() => {});

  const probe = await checkImageUrl(url);
  if (!probe.ok || !/webp/.test(probe.type)) {
    await removeNew();
    throw new Error("La versión optimizada se subió pero su URL no responde: no se cambió nada.");
  }

  // Solo si la referencia sigue siendo la original.
  const { data, error } = await supabase.from(c.table).update({ [c.column]: url }).eq("id", c.id).eq(c.column, c.src).select("id");
  if (error || !data?.length) {
    await removeNew();
    if (error) throw error;
    return { status: "changed" };
  }
  const entry = { key: c.key, table: c.table, column: c.column, id: c.id, label: `${c.label} · ${c.detail}`,
    old: c.src, new: url, before: original.size, after: blob.size, width, height, at: new Date().toISOString() };
  saveLog([...readLog().filter((e) => !(e.table === c.table && e.id === c.id && e.new === url)), entry]);
  return { status: "done", entry };
}

// Vuelve a la imagen original (solo si sigue la optimizada). No borra nada.
export async function revert(entry) {
  const data = check(await supabase.from(entry.table).update({ [entry.column]: entry.old }).eq("id", entry.id).eq(entry.column, entry.new).select("id"));
  if (!data.length) throw new Error("La imagen ya no es la optimizada (se cambió después): no se revirtió.");
  saveLog(readLog().map((e) => (e === entry || (e.table === entry.table && e.id === entry.id && e.new === entry.new) ? { ...e, reverted: new Date().toISOString() } : e)));
}

// ---------- Registro local (respaldo de qué se cambió) ----------
export function readLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]"); } catch { return []; }
}
function saveLog(list) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(-500))); } catch { /* sin almacenamiento: queda el archivo descargable */ }
}
export function logAsFile(list = readLog()) {
  return new Blob([JSON.stringify({ generado: new Date().toISOString(), nota: "Originales conservados en Storage. Para revertir: volver cada referencia a «old».", cambios: list }, null, 2)], { type: "application/json" });
}
