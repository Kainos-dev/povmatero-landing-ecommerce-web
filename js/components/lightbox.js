// Visor ampliado de fotos de producto.
// Se abre desde la imagen principal del modal y permite recorrer la misma
// galería con flechas (escritorio), teclado (← → Esc) y deslizando (táctil).
// Solo descarga la foto que se está viendo (y adelanta la siguiente al navegar).
import { optimizedSrc, withFallback, warmImage } from "../lib/images.js";
import { attachSwipe } from "../lib/swipe.js";

const ARROW = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="${d}"/></svg>`;

let el = null;
let img, counter, prevBtn, nextBtn, closeBtn, stage;
let state = null; // { images, index, alt, onChange, returnFocus }

// Ancho de la foto en el visor: lo que ocupa en pantalla (hasta 1600 px).
function viewerWidth() {
  return Math.min(1600, Math.ceil(window.innerWidth * (window.devicePixelRatio || 1)));
}

function build() {
  el = document.createElement("div");
  el.className = "lightbox";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-label", "Imagen ampliada");
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <button type="button" class="lightbox-close" aria-label="Cerrar imagen ampliada">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
    </button>
    <div class="lightbox-stage">
      <img class="lightbox-img" alt="" decoding="async" draggable="false" />
    </div>
    <button type="button" class="lightbox-arrow prev" aria-label="Imagen anterior">${ARROW("15 5 8 12 15 19")}</button>
    <button type="button" class="lightbox-arrow next" aria-label="Imagen siguiente">${ARROW("9 5 16 12 9 19")}</button>
    <p class="lightbox-counter" aria-live="polite"></p>
  `;
  document.body.append(el);

  img = el.querySelector(".lightbox-img");
  stage = el.querySelector(".lightbox-stage");
  counter = el.querySelector(".lightbox-counter");
  prevBtn = el.querySelector(".lightbox-arrow.prev");
  nextBtn = el.querySelector(".lightbox-arrow.next");
  closeBtn = el.querySelector(".lightbox-close");

  closeBtn.addEventListener("click", closeLightbox);
  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  // Clic en cualquier parte del fondo (fuera de la foto y los botones) cierra.
  el.addEventListener("click", (e) => { if (e.target === el || e.target === stage) closeLightbox(); });
  img.addEventListener("load", () => img.classList.remove("is-loading"));
  img.addEventListener("error", () => img.classList.remove("is-loading"));

  attachSwipe(stage, {
    canSwipe: () => (state?.images.length ?? 0) > 1,
    onMove: (dx) => { img.style.transform = dx ? `translateX(${dx}px)` : ""; },
    onSwipe: (dir) => go(dir),
  });

  // Captura: el visor atiende Esc y flechas antes que el modal de producto.
  document.addEventListener("keydown", (e) => {
    if (!isLightboxOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeLightbox(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); go(1); }
    else if (e.key === "Tab") trapFocus(e);
  }, true);
}

function trapFocus(e) {
  // Solo los botones visibles (en táctil las flechas están ocultas por CSS).
  const items = [closeBtn, prevBtn, nextBtn].filter((b) => !b.hidden && b.offsetParent !== null);
  const first = items[0], last = items[items.length - 1];
  if (!items.includes(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function show() {
  const { images, index, alt } = state;
  const src = images[index];
  withFallback(img, src);
  img.classList.add("is-loading");
  img.style.transform = "";
  img.src = optimizedSrc(src, viewerWidth());
  img.alt = images.length > 1 ? `${alt} (imagen ${index + 1} de ${images.length})` : alt;
  const multi = images.length > 1;
  prevBtn.hidden = !multi;
  nextBtn.hidden = !multi;
  counter.hidden = !multi;
  counter.textContent = multi ? `${index + 1} / ${images.length}` : "";
}

function go(delta) {
  if (!state || state.images.length < 2) return;
  const n = state.images.length;
  state.index = (state.index + delta + n) % n;
  show();
  state.onChange?.(state.images[state.index]);
  // Se adelanta solo la siguiente en la misma dirección.
  warmImage(state.images[(state.index + delta + n) % n], viewerWidth());
}

export function isLightboxOpen() {
  return Boolean(el?.classList.contains("open"));
}

export function openLightbox({ images, index = 0, alt = "", onChange, returnFocus }) {
  if (!images?.length) return;
  if (!el) build();
  state = { images, index: Math.max(0, Math.min(index, images.length - 1)), alt, onChange, returnFocus };
  show();
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
  closeBtn.focus({ preventScroll: true });
}

export function closeLightbox() {
  if (!isLightboxOpen()) return;
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
  const focusTarget = state?.returnFocus;
  state = null;
  focusTarget?.focus?.({ preventScroll: true });
}
