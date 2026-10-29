import { showToast } from "./ui.js";
import { escapeHtml } from "../lib/html.js";
import { optimizedSrc, withFallback, warmImage } from "../lib/images.js";
import { attachSwipe } from "../lib/swipe.js";
import { openLightbox, closeLightbox, isLightboxOpen } from "./lightbox.js";

const ARROW = (points) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polyline points="${points}"/></svg>`;

// Ancho de la foto principal de la ficha: al menos el ancho máximo que puede
// ocupar (90vw en celular, 65vw en escritorio) para que el modal mida lo mismo
// que con la foto original, y más nítida en pantallas de alta densidad.
export function modalImageWidth() {
  const cssWidth = window.innerWidth * (window.innerWidth < 768 ? 0.9 : 0.65);
  return Math.max(cssWidth, Math.min(cssWidth * (window.devicePixelRatio || 1), 1600));
}
const THUMB_WIDTH = 128;

export function initModal(UI, cart) {

  // Navegación de la galería de la ficha abierta (null si tiene una sola foto).
  let galleryNav = null;

  function formatPrice(price) {
    if (!price) return "";
    return "$" + price.toLocaleString("es-AR");
  }

  // Stock de lo que se está por comprar: la variante elegida o, en un producto
  // simple, el producto. null = no se controla stock (o todavía no hay variante).
  function stockFor(product, selectedVariant) {
    if (!product.variants) return product.stock ?? null;
    const variant = product.variants.find(v => v.name === selectedVariant);
    return variant ? (variant.stock ?? null) : null;
  }

  function getStockText(stock) {
    if (stock == null) return "";
    if (stock <= 0) return "Sin stock";
    if (stock === 1) return "Última unidad disponible";
    return `Stock disponible: ${stock}`;
  }

  // Muestra el aviso de stock si el producto o alguna variante lo informa
  // (yerbas de la hoja o productos de Supabase que controlan stock).
  function hasStockInfo(product) {
    if (!product.variants) return product.stock != null;
    return product.variants.some(v => v.stock != null);
  }

  function open(product) {

    let selectedImage = product.image;
    let selectedVariant = null;
    // Galería: todas las fotos del producto (ver catalogSource.js). Es siempre
    // la misma lista; elegir una variante solo cambia cuál se está viendo.
    const gallery = product.gallery?.length ? product.gallery : [product.image];
    const multi = gallery.length > 1;
    const simpleOutOfStock = !product.variants && product.stock != null && product.stock <= 0;

    function render() {
      UI.modalBody.innerHTML = `
        <div class="modal-content vertical">

          <div class="modal-image${multi ? " has-gallery" : ""}">
            <div class="modal-stage" role="button" tabindex="0" aria-label="Ampliar imagen de ${escapeHtml(product.name)}">
              <img src="${escapeHtml(optimizedSrc(selectedImage, modalImageWidth()))}" alt="${escapeHtml(product.name)}" decoding="async" draggable="false" />
              ${
                multi
                  ? `
                    <button type="button" class="gallery-arrow prev" aria-label="Imagen anterior">${ARROW("15 5 8 12 15 19")}</button>
                    <button type="button" class="gallery-arrow next" aria-label="Imagen siguiente">${ARROW("9 5 16 12 9 19")}</button>
                  `
                  : ""
              }
            </div>
            ${
              multi
                ? `
                  <div class="modal-thumbs" role="group" aria-label="Fotos del producto">
                    ${gallery.map((src, i) => `
                      <button type="button" class="modal-thumb${src === selectedImage ? " active" : ""}" data-src="${escapeHtml(src)}" aria-label="Ver foto ${i + 1} de ${gallery.length}" aria-pressed="${src === selectedImage}">
                        <img src="${escapeHtml(optimizedSrc(src, THUMB_WIDTH))}" alt="" decoding="async" />
                      </button>
                    `).join("")}
                  </div>
                `
                : ""
            }
          </div>

          <div class="modal-info">
            <p class="modal-category">${escapeHtml(product.categoryName ?? product.category)}</p>

            <h2 class="modal-title">${escapeHtml(product.name)}</h2>

            <p class="modal-description">${escapeHtml(product.description)}</p>

            <p class="modal-price" id="modalPrice">
              ${
                product.category === "yerbas"
                  ? (selectedVariant
                      ? formatPrice(
                          product.variants.find(v => v.name === selectedVariant)?.price
                        )
                      : "")
                  : formatPrice(product.price)
              }
            </p>

            ${
              hasStockInfo(product)
                ? `
                  <p class="modal-stock" id="modalStock">
                    ${product.variants ? "" : getStockText(product.stock)}
                  </p>
                `
                : ""
            }

            ${
              product.variants
                ? `
                  <div class="modal-variants">
                    ${product.variants.map((v) => `
                      <button
                        class="variant-btn${v.stock != null && v.stock <= 0 ? " out" : ""}"
                        data-name="${escapeHtml(v.name)}"
                        data-img="${escapeHtml((product.category === "yerbas" ? product.image : v.image) ?? "")}"
                      >
                        ${escapeHtml(v.name)}
                      </button>
                    `).join("")}
                  </div>
                `
                : ""
            }

            <button class="btn-add" id="modalAdd"${simpleOutOfStock ? " disabled" : ""}>
              ${simpleOutOfStock ? "Sin stock" : "Agregar al carrito"}
            </button>
          </div>

        </div>
      `;

      const stage = UI.modalBody.querySelector(".modal-stage");
      const mainImg = stage.querySelector("img");
      const thumbsStrip = UI.modalBody.querySelector(".modal-thumbs");
      withFallback(mainImg, selectedImage);
      UI.modalBody.querySelectorAll(".modal-thumb").forEach(t => withFallback(t.querySelector("img"), t.dataset.src));

      // Miniatura activa: borde marrón y, si la tira tiene scroll, a la vista.
      function syncThumbs(src) {
        UI.modalBody.querySelectorAll(".modal-thumb").forEach(t => {
          const active = t.dataset.src === src;
          t.classList.toggle("active", active);
          t.setAttribute("aria-pressed", String(active));
          if (active && thumbsStrip) {
            const left = t.offsetLeft - (thumbsStrip.clientWidth - t.offsetWidth) / 2;
            thumbsStrip.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
          }
        });
      }

      function showImage(src) {
        if (!src || src === selectedImage) return;
        mainImg.style.opacity = 0;
        setTimeout(() => {
          withFallback(mainImg, src);
          mainImg.src = optimizedSrc(src, modalImageWidth());
          mainImg.style.opacity = 1;
        }, 120);
        selectedImage = src;
        syncThumbs(src);
      }

      // =========================
      // GALERÍA
      // =========================
      function step(delta) {
        if (!multi) return;
        const n = gallery.length;
        const current = Math.max(0, gallery.indexOf(selectedImage));
        const next = gallery[(current + delta + n) % n];
        showImage(next);
        // Solo se adelanta la siguiente foto en la misma dirección.
        warmImage(gallery[(gallery.indexOf(next) + delta + n) % n], modalImageWidth());
      }
      galleryNav = multi ? step : null;

      UI.modalBody.querySelectorAll(".modal-thumb").forEach(thumb => {
        thumb.onclick = () => showImage(thumb.dataset.src);
      });

      UI.modalBody.querySelector(".gallery-arrow.prev")?.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
      UI.modalBody.querySelector(".gallery-arrow.next")?.addEventListener("click", (e) => { e.stopPropagation(); step(1); });

      // Celular: deslizar a izquierda/derecha (el scroll vertical sigue libre).
      attachSwipe(stage, {
        canSwipe: () => multi,
        onMove: (dx) => { mainImg.style.transform = dx ? `translateX(${dx}px)` : ""; },
        onSwipe: (dir) => step(dir),
      });

      // Tocar o hacer clic en la foto abre el visor ampliado.
      function openViewer() {
        openLightbox({
          images: gallery,
          index: Math.max(0, gallery.indexOf(selectedImage)),
          alt: product.name,
          onChange: (src) => showImage(src),
          returnFocus: stage,
        });
      }
      stage.addEventListener("click", (e) => {
        if (e.target.closest(".gallery-arrow")) return;
        openViewer();
      });
      stage.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openViewer(); }
      });

      // =========================
      // VARIANTES
      // =========================
      UI.modalBody.querySelectorAll(".variant-btn").forEach(btn => {
        btn.onclick = () => {

          const variantName = btn.dataset.name;
          const newSrc = btn.dataset.img;

          selectedVariant = variantName;

          // Cambio de imagen (solo si no es yerba y la variante tiene foto propia)
          if (product.category !== "yerbas" && newSrc) showImage(newSrc);

          const variantData = product.variants.find(v => v.name === variantName);

          // PRECIO
          const priceEl = UI.modalBody.querySelector("#modalPrice");
          if (variantData && priceEl) {
            const finalPrice = variantData.price ?? product.price;

            if (priceEl && finalPrice) {
              priceEl.textContent = formatPrice(finalPrice);
            }
          }

          // STOCK (solo si la variante lo informa)
          const stockEl = UI.modalBody.querySelector("#modalStock");
          if (variantData && stockEl) {
            stockEl.textContent = getStockText(stockFor(product, variantName));
          }

          // ACTIVE
          UI.modalBody.querySelectorAll(".variant-btn").forEach(b => {
            b.classList.remove("active");
          });

          btn.classList.add("active");

          // Botón según el stock de la presentación elegida
          const addBtn = UI.modalBody.querySelector("#modalAdd");

          if (addBtn) {
            const stock = stockFor(product, variantName);
            const out = stock != null && stock <= 0;
            addBtn.disabled = out;
            addBtn.textContent = out ? "Sin stock" : "Agregar al carrito";
          }
        };
      });

      // Yerbas: todas las presentaciones comparten foto, así que se abre con la
      // primera disponible elegida (se ve el precio y el stock de entrada).
      if (product.category === "yerbas" && product.variants && !selectedVariant) {
        const first = product.variants.find(v => v.stock == null || v.stock > 0) ?? product.variants[0];
        [...UI.modalBody.querySelectorAll(".variant-btn")].find(b => b.dataset.name === first?.name)?.onclick();
      }

      // =========================
      // CARRITO
      // =========================
      UI.modalBody.querySelector("#modalAdd").onclick = () => {
        if (product.variants && !selectedVariant) {
          showToast("Elegí una presentación.");
          return;
        }

        let finalPrice = product.price;

        if (product.variants) {
          const variantData = product.variants.find(v => v.name === selectedVariant);
          if (!variantData) return;
          finalPrice = variantData.price ?? product.price;
        }

        // Sin stock: variantes o productos simples que informan stock
        // (yerbas de la hoja o productos de Supabase con control de stock).
        const stock = stockFor(product, selectedVariant);
        if (stock != null && stock <= 0) {
          showToast("Sin stock disponible");
          return;
        }

        const added = cart.add({
          ...product,
          image: selectedImage,
          variant: selectedVariant,
          price: finalPrice,
          maxQty: stock,
        });

        if (!added) {
          showToast(`No hay más stock: ya tenés ${stock} en el carrito.`);
          return;
        }

        showToast(`${[product.name, selectedVariant].filter(Boolean).join(" ")}: agregado al carrito.`);
      };
    }

    render();
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

  return { open };
}
