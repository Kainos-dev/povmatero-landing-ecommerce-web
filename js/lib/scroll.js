// Desplazamientos hechos desde el código (enlaces internos, cambio de categoría).
//
// Animación propia con una curva suave (arranca y frena con delicadeza) y una
// duración que crece con la distancia, en lugar del "smooth" del navegador,
// que casi no se distingue de un salto. No toca la rueda, el dedo ni el
// teclado: si la persona mueve la página mientras se anima, la animación se
// cancela al instante y el control vuelve a ella. Con prefers-reduced-motion
// el desplazamiento es inmediato.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const MIN_MS = 450;
const MAX_MS = 950;

export function prefersReducedMotion() {
  return reduceMotion.matches;
}

// Para quien todavía use la API nativa (scrollIntoView, scrollTo).
export function scrollBehavior() {
  return reduceMotion.matches ? "auto" : "smooth";
}

// easeInOutCubic: salida y llegada suaves, sin "rebote".
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

let animation = null;

function cancel() {
  if (!animation) return;
  cancelAnimationFrame(animation.frame);
  animation = null;
  removeListeners();
}

// Cualquier gesto de la persona tiene prioridad sobre la animación.
const USER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];
function addListeners() {
  for (const type of USER_EVENTS) window.addEventListener(type, cancel, { passive: true, capture: true });
}
function removeListeners() {
  for (const type of USER_EVENTS) window.removeEventListener(type, cancel, { capture: true });
}

// "instant" evita que el scroll-behavior: smooth del CSS se sume a cada cuadro.
function jump(top) {
  window.scrollTo({ top, behavior: "instant" });
}

export function smoothScrollTo(targetTop) {
  cancel();
  const maxTop = document.documentElement.scrollHeight - window.innerHeight;
  const to = Math.max(0, Math.min(Math.round(targetTop), maxTop));
  const from = window.scrollY;
  const distance = to - from;
  if (Math.abs(distance) < 2) return;
  if (reduceMotion.matches) {
    jump(to);
    return;
  }

  const duration = Math.min(MAX_MS, Math.max(MIN_MS, 300 + Math.sqrt(Math.abs(distance)) * 12));
  const start = performance.now();
  animation = { frame: 0 };
  addListeners();

  const step = (now) => {
    if (!animation) return;
    const t = Math.min(1, (now - start) / duration);
    jump(from + distance * ease(t));
    if (t < 1) animation.frame = requestAnimationFrame(step);
    else { animation = null; removeListeners(); }
  };
  animation.frame = requestAnimationFrame(step);
}

// Alto del encabezado fijo.
function headerOffset() {
  return document.querySelector(".site-header")?.offsetHeight ?? 0;
}

// Lleva el elemento justo debajo del encabezado fijo (con un pequeño aire).
export function scrollToUnderHeader(el, gap = 12) {
  if (!el) return;
  smoothScrollTo(el.getBoundingClientRect().top + window.scrollY - headerOffset() - gap);
}

// Enlaces internos (#hero, #productos…) con la misma animación.
export function enhanceAnchorLinks() {
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // En una página de producto las secciones de la portada no están a la
    // vista: esos enlaces los resuelve js/router.js (vuelve al inicio primero).
    if (document.documentElement.classList.contains("route-product")) return;
    const link = e.target.closest('a[href^="#"]');
    const id = link?.getAttribute("href").slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    scrollToUnderHeader(target, 0);
    history.replaceState(null, "", `#${id}`);
  });
}
