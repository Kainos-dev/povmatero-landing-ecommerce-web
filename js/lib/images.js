// Imágenes livianas para la tienda.
//
// Muchas fotos originales miden 4000–6000 px y pesan 1–2,5 MB. En Vercel se
// piden a través de su optimizador (/_vercel/image), que entrega una versión
// WebP del ancho justo y la guarda en caché. La configuración (anchos y
// dominios permitidos) está en vercel.json: WIDTHS tiene que coincidir.
//
// Si el optimizador no responde (en local, o si se desactiva en Vercel), la
// imagen vuelve sola a la original: nunca se ve una imagen rota por esto.

const WIDTHS = [128, 256, 384, 640, 828, 1080, 1200, 1600];
const QUALITY = 75;

const OPTIMIZER_ENABLED =
  location.protocol === "https:" && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

function sourceFor(src) {
  if (/^https?:\/\//.test(src)) return src;
  // Archivos del sitio: el optimizador los pide con ruta absoluta (/images/...).
  return "/" + String(src).replace(/^\.?\//, "");
}

function closestWidth(width) {
  return WIDTHS.find((w) => w >= width) ?? WIDTHS[WIDTHS.length - 1];
}

// URL optimizada para un ancho (se redondea al ancho permitido más cercano).
export function optimizedSrc(src, width) {
  if (!src || !OPTIMIZER_ENABLED) return src;
  return `/_vercel/image?url=${encodeURIComponent(sourceFor(src))}&w=${closestWidth(width)}&q=${QUALITY}`;
}

// srcset para que el navegador elija el tamaño según la pantalla.
export function optimizedSrcset(src, widths) {
  if (!src || !OPTIMIZER_ENABLED) return "";
  return widths.map((w) => `${optimizedSrc(src, w)} ${w}w`).join(", ");
}

// Si la versión optimizada falla, se usa la original. Se puede volver a llamar
// cuando la imagen cambia de foto: siempre vale la última original indicada.
export function withFallback(img, originalSrc) {
  if (!OPTIMIZER_ENABLED || !originalSrc) return;
  img.dataset.originalSrc = originalSrc;
  if (img.dataset.fallbackReady) return;
  img.dataset.fallbackReady = "1";
  img.addEventListener("error", () => {
    const original = img.dataset.originalSrc;
    if (!original || img.getAttribute("src") === original) return;
    img.removeAttribute("srcset");
    img.src = original;
  });
}

// Descarga anticipada (por ejemplo, al pasar el mouse por una tarjeta).
const warmed = new Set();
export function warmImage(src, width) {
  const url = optimizedSrc(src, width);
  if (!url || warmed.has(url)) return;
  warmed.add(url);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
}
