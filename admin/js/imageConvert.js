// Conversión de imágenes en el navegador: WebP, lado mayor 1600 px, calidad 85 %.

export const MAX_SIDE = 1600;
export const QUALITY = 0.85;
export const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;   // límite del bucket
export const MAX_INPUT_BYTES = 30 * 1024 * 1024;   // original máximo aceptado

// Tamaño final manteniendo proporción; nunca agranda.
export function fitSize(width, height, maxSide = MAX_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function convertToWebp(file) {
  if (!file.type.startsWith("image/")) throw new Error(`“${file.name}” no es una imagen.`);
  if (file.size > MAX_INPUT_BYTES) throw new Error(`“${file.name}” pesa más de 30 MB.`);

  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`No se pudo leer “${file.name}”. Probá con JPG, PNG o WebP.`);
  }

  const { width, height } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", QUALITY));

  if (!blob || blob.type !== "image/webp") {
    throw new Error("Este navegador no puede generar WebP. Usá Chrome, Edge o Firefox actualizados.");
  }
  if (blob.size > MAX_OUTPUT_BYTES) {
    throw new Error(`“${file.name}” convertida sigue pesando más de 5 MB.`);
  }

  return { blob, width, height };
}

// ---------------------------------------------------------------------
// Imágenes con transparencia (envases de la góndola, PNG): WebP conservando
// el canal alfa. El lienzo empieza transparente y no se pinta fondo, así que
// los bordes y el margen de abajo (que usa /yerbas para apoyar el paquete en
// la tabla) quedan igual. Lado mayor 1200 px: en la góndola se dibujan a
// ~100–260 px; sobra para pantallas de alta densidad y para ampliar.
// ---------------------------------------------------------------------
export const SHELF_MAX_SIDE = 1200;
export const SHELF_QUALITY = 0.9;

// Devuelve { blob, width, height, changed }. changed = false si convertir no
// ahorra (por ejemplo, un WebP que ya es liviano): entonces blob es el original.
export async function convertKeepingAlpha(file, { maxSide = SHELF_MAX_SIDE, quality = SHELF_QUALITY } = {}) {
  if (!file?.type?.startsWith("image/")) throw new Error("No es una imagen.");
  if (file.size > MAX_INPUT_BYTES) throw new Error("La imagen pesa más de 30 MB.");
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { premultiplyAlpha: "none", colorSpaceConversion: "none" });
  } catch {
    throw new Error("No se pudo leer la imagen. Probá exportarla de nuevo como PNG.");
  }
  const { width, height } = fitSize(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.clearRect(0, 0, width, height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  const resized = bitmap.width !== width || bitmap.height !== height;
  bitmap.close?.();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (!blob || blob.type !== "image/webp") {
    throw new Error("Este navegador no puede generar WebP. Usá Chrome, Edge o Firefox actualizados.");
  }
  // Si no achica ni ahorra al menos un 10 %, se deja el original.
  if (!resized && file.type === "image/webp" && blob.size > file.size * 0.9) {
    return { blob: file, width, height, changed: false };
  }
  if (blob.size >= file.size && !resized) return { blob: file, width, height, changed: false };
  if (blob.size > MAX_OUTPUT_BYTES) throw new Error("La imagen convertida sigue pesando más de 5 MB.");
  return { blob, width, height, changed: true };
}
