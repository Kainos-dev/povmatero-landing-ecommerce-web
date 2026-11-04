// Miniaturas del panel: nunca cargan el archivo original completo.
// En el sitio publicado se piden al optimizador de Vercel (WebP del ancho
// justo, en caché 31 días: Supabase entrega el original una sola vez, a
// Vercel). Si el optimizador falla, se usa el original (nunca queda rota).
// En local (sin optimizador) o con vistas previas blob:/data: se usa tal cual.
import { optimizedSrc, optimizedSrcset, withFallback } from "/js/lib/images.js";
import { h } from "./ui.js";

export function thumbnail(src, { alt = "", width = 384, className = "" } = {}) {
  const local = /^(blob|data):/.test(src);
  const img = h("img", {
    src: local ? src : optimizedSrc(src, width),
    alt, loading: "lazy", decoding: "async", class: className || null,
  });
  if (!local) {
    const set = optimizedSrcset(src, [width, width * 2].filter((w) => w <= 1200));
    if (set) { img.srcset = set; img.sizes = `${width / 2}px`; }
    withFallback(img, src);
  }
  return img;
}
