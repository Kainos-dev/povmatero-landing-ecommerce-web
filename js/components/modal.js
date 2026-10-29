// Modal de producto. La ficha (galería, variantes, stock y carrito) la dibuja
// productDetail.js, que comparte con la página de producto.
import { renderProductDetail, modalImageWidth } from "./productDetail.js";
import { closeLightbox, isLightboxOpen } from "./lightbox.js";

// Se reexporta para quien ya lo importaba desde acá (catalog.js).
export { modalImageWidth };

export function initModal(UI, cart) {

  // Navegación de la galería de la ficha abierta (null si tiene una sola foto).
  let galleryNav = null;

  function open(product) {
    galleryNav = renderProductDetail(UI.modalBody, product, { cart, layout: "modal" }).step;
    UI.modalOverlay.classList.add("open");
  }

  function close() {
    closeLightbox();
    galleryNav = null;
    UI.modalOverlay.classList.remove("open");
  }

  UI.modalClose.onclick = close;

  UI.modalOverlay.onclick = (e) => {
    if (e.target === UI.modalOverlay) close();
  };

  // Esc cierra la ficha; ← → recorren sus fotos. Con el visor abierto, las
  // teclas las atiende el visor (ver lightbox.js).
  document.addEventListener("keydown", (e) => {
    if (!UI.modalOverlay.classList.contains("open") || isLightboxOpen()) return;
    if (e.key === "Escape") close();
    else if (galleryNav && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      galleryNav(e.key === "ArrowLeft" ? -1 : 1);
    }
  });

  return { open, close };
}
