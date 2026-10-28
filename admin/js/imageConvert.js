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
