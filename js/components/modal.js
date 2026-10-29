import { showToast } from "./ui.js";
import { escapeHtml } from "../lib/html.js";

export function initModal(UI, cart) {

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
    const gallery = product.gallery ?? [];
    const simpleOutOfStock = !product.variants && product.stock != null && product.stock <= 0;

    function render() {
      UI.modalBody.innerHTML = `
        <div class="modal-content vertical">

          <div class="modal-image">
            <img src="${escapeHtml(selectedImage)}" alt="${escapeHtml(product.name)}" />
            ${
              gallery.length > 1
                ? `
                  <div class="modal-thumbs">
                    ${gallery.map((src) => `
                      <button type="button" class="modal-thumb${src === selectedImage ? " active" : ""}" data-src="${escapeHtml(src)}" aria-label="Ver imagen">
                        <img src="${escapeHtml(src)}" alt="" loading="lazy" />
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

      const mainImg = UI.modalBody.querySelector(".modal-image > img");

      function showImage(src) {
        if (!src || src === selectedImage) return;
        mainImg.style.opacity = 0;
        setTimeout(() => {
          mainImg.src = src;
          mainImg.style.opacity = 1;
        }, 120);
        selectedImage = src;
        UI.modalBody.querySelectorAll(".modal-thumb").forEach(t => {
          t.classList.toggle("active", t.dataset.src === src);
        });
      }

      // =========================
      // GALERÍA
      // =========================
      UI.modalBody.querySelectorAll(".modal-thumb").forEach(thumb => {
        thumb.onclick = () => showImage(thumb.dataset.src);
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
    UI.modalOverlay.classList.remove("open");
  }

  UI.modalClose.onclick = close;

  UI.modalOverlay.onclick = (e) => {
    if (e.target === UI.modalOverlay) close();
  };

  // Esc cierra la ficha
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && UI.modalOverlay.classList.contains("open")) close();
  });

  return { open };
}
