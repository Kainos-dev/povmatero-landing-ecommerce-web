// Carrusel «TAMBIÉN TE PUEDE INTERESAR» (página de producto).
//
// Infinito: la lista se pone tres veces seguidas [copia][real][copia]. Cuando
// el desplazamiento se detiene, si quedó cerca de una punta se salta en
// silencio exactamente una vuelta (misma imagen en pantalla), así se puede
// seguir hacia cualquier lado sin llegar nunca a un final.
// Solo se repite si la lista es más ancha que la pantalla: con pocos productos
// se muestran los que hay, sin duplicados y sin bucle.
import { createProductCard } from "./catalog.js";
import { prefersReducedMotion } from "../lib/scroll.js";

export function createRelatedCarousel({ track, prevBtn, nextBtn, sizes }) {
  let looping = false;
  let segment = 0;        // ancho de una vuelta completa (una copia de la lista)
  let pendingTarget = null;
  let idleTimer = 0;
  let count = 0;

  const behavior = () => (prefersReducedMotion() ? "auto" : "smooth");
  const cards = () => track.querySelectorAll(".product-card");

  function addCopy(items, { clone, prepend = false }) {
    const fragment = document.createDocumentFragment();
    items.forEach((p) => {
      const card = createProductCard(p, { sizes });
      if (clone) {
        // Las copias se ven y se pueden tocar, pero no se repiten para lectores
        // de pantalla ni en el recorrido con Tab.
        card.setAttribute("aria-hidden", "true");
        card.dataset.clone = "true";
        card.querySelectorAll("a").forEach((a) => a.setAttribute("tabindex", "-1"));
      }
      fragment.append(card);
    });
    if (prepend) track.prepend(fragment); else track.append(fragment);
  }

  // Ancho de una vuelta: distancia entre la primera card de la copia real y la
  // primera de la copia siguiente (incluye los espacios entre cards).
  function measure() {
    const all = cards();
    if (!looping || all.length < count * 2) return;
    segment = all[count * 2].offsetLeft - all[count].offsetLeft;
  }

  // Mantiene la posición dentro de la vuelta del medio (sin cambiar lo que se ve).
  function wrap(x) {
    if (x < segment * 0.5) return x + segment;
    if (x > segment * 1.5) return x - segment;
    return x;
  }

  function normalize() {
    if (!looping || !segment) return;
    const x = track.scrollLeft;
    const nx = wrap(x);
    if (nx !== x) track.scrollLeft = nx;
  }

  function unit() {
    const card = cards()[0];
    if (!card) return 0;
    const gap = parseFloat(getComputedStyle(track).columnGap) || 0;
    return card.offsetWidth + gap;
  }

  function onIdle() {
    // Mientras las flechas animan hacia un destino, el salto de vuelta que hace
    // go() también dispara este evento: no se corrige hasta llegar.
    if (pendingTarget != null && Math.abs(track.scrollLeft - pendingTarget) > unit() / 2) return;
    pendingTarget = null;
    normalize();
  }

  // Si la persona toma el control (rueda, dedo, clic), manda ella.
  for (const type of ["wheel", "touchstart", "pointerdown"]) {
    track.addEventListener(type, () => { pendingTarget = null; }, { passive: true });
  }

  function step() {
    const u = unit();
    // Avanza de a varias cards (las que entran en pantalla menos una).
    return Math.max(1, Math.floor(track.clientWidth / u) - 1) * u;
  }

  function go(dir) {
    if (!looping) {
      track.scrollBy({ left: dir * step(), behavior: behavior() });
      return;
    }
    // Varios clics seguidos acumulan el destino; si se acerca a una punta, se
    // salta una vuelta antes de animar (el salto no se nota).
    let target = (pendingTarget ?? track.scrollLeft) + dir * step();
    const wrapped = wrap(target);
    if (wrapped !== target) {
      track.scrollLeft += wrapped - target;
      target = wrapped;
    }
    pendingTarget = target;
    track.scrollTo({ left: target, behavior: behavior() });
  }

  function updateArrows() {
    if (!prevBtn || !nextBtn) return;
    const max = track.scrollWidth - track.clientWidth;
    const overflow = max > 2;
    prevBtn.hidden = nextBtn.hidden = !overflow;
    // En bucle las flechas nunca se agotan.
    prevBtn.disabled = !looping && track.scrollLeft <= 2;
    nextBtn.disabled = !looping && track.scrollLeft >= max - 2;
  }

  // Detección de "terminó de desplazarse" (con el dedo, la rueda o las flechas).
  const supportsScrollEnd = "onscrollend" in window;
  track.addEventListener("scroll", () => {
    updateArrows();
    if (!supportsScrollEnd) {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, 150);
    }
  }, { passive: true });
  if (supportsScrollEnd) track.addEventListener("scrollend", onIdle);

  prevBtn?.addEventListener("click", () => go(-1));
  nextBtn?.addEventListener("click", () => go(1));
  window.addEventListener("resize", () => {
    const before = segment;
    measure();
    if (looping && before && segment) track.scrollLeft = segment + ((track.scrollLeft % before) / before) * segment;
    normalize();
    updateArrows();
  });

  // Centra la card "index" de la vuelta del medio.
  function centerOn(index) {
    const card = cards()[count + index];
    if (!card) return;
    track.scrollLeft = card.offsetLeft - (track.clientWidth - card.offsetWidth) / 2;
  }

  return {
    render(items) {
      track.innerHTML = "";
      track.classList.remove("is-looping", "is-static");
      looping = false;
      segment = 0;
      pendingTarget = null;
      count = items.length;
      if (!count) return;

      addCopy(items, { clone: false });
      const overflow = track.scrollWidth > track.clientWidth + 2;
      if (overflow && count > 1) {
        looping = true;
        track.classList.add("is-looping");
        addCopy(items, { clone: true, prepend: true });
        addCopy(items, { clone: true });
        measure();
        centerOn(0);
      } else {
        track.classList.add("is-static");
        track.scrollLeft = 0;
      }
      updateArrows();
    },
    // Para pruebas y depuración
    get looping() { return looping; },
    get segment() { return segment; },
  };
}
