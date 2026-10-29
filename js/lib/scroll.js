// Desplazamientos hechos desde el código (no afecta la rueda ni el dedo).
// Suave con el scroll nativo del navegador; instantáneo si la persona pidió
// reducir animaciones (prefers-reduced-motion).

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export function scrollBehavior() {
  return reduceMotion.matches ? "auto" : "smooth";
}

// Alto de lo que queda fijo arriba: encabezado + barra de categorías (sticky).
function stickyOffset() {
  const header = document.querySelector(".site-header");
  const filters = document.querySelector(".filters-section");
  return (header?.offsetHeight ?? 0) + (filters?.offsetHeight ?? 0);
}

// Lleva el elemento justo debajo del encabezado y la barra de categorías.
export function scrollToUnderHeader(el, gap = 16) {
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - stickyOffset() - gap;
  window.scrollTo({ top: Math.max(0, top), behavior: scrollBehavior() });
}
