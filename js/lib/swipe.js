// Deslizar con el dedo a izquierda/derecha para cambiar de foto.
// Solo reacciona a gestos horizontales táctiles: el CSS del elemento debe tener
// touch-action: pan-y, así el desplazamiento vertical sigue siendo del navegador.
// Después de un deslizamiento se anula el "clic" que el navegador dispara al
// soltar, para que no abra ni cierre nada sin querer.

const START_PX = 10;   // a partir de cuánto se considera que empezó a deslizar
const SWIPE_PX = 45;   // distancia mínima para pasar de foto
const FLICK_PX_MS = 0.4; // o un gesto rápido aunque sea corto

export function attachSwipe(el, { onSwipe, onMove, canSwipe = () => true }) {
  let start = null;
  let dragging = false;
  let suppressClick = false;

  el.addEventListener("pointerdown", (e) => {
    suppressClick = false; // gesto nuevo: no arrastra el estado del anterior
    if (e.pointerType === "mouse" || !e.isPrimary || !canSwipe()) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now() };
    dragging = false;
  });

  el.addEventListener("pointermove", (e) => {
    if (!start || e.pointerType === "mouse") return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dx) < START_PX || Math.abs(dx) < Math.abs(dy)) return;
      dragging = true;
    }
    onMove?.(dx * 0.6);
  });

  const end = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - start.t);
    if (dragging) {
      suppressClick = true;
      onMove?.(0);
      if (e.type !== "pointercancel" && (Math.abs(dx) >= SWIPE_PX || (Math.abs(dx) >= START_PX * 2 && speed > FLICK_PX_MS))) {
        onSwipe(dx < 0 ? 1 : -1);
      }
    }
    start = null;
    dragging = false;
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);

  el.addEventListener("click", (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}
