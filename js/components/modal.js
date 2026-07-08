import { showToast } from "./ui.js";

export function initModal(UI, cart) {

  function formatPrice(price) {
    if (!price) return "";
    return "$" + price.toLocaleString("es-AR");
  }

  function getStockText(product, selectedVariant) {
    if (!product.variants || product.category !== "yerbas") return "";

    const variant = product.variants.find(v => v.name === selectedVariant);
    if (!variant) return "";

    if (variant.stock <= 0) return "Sin stock";
    if (variant.stock === 1) return "Última unidad disponible";

    return `Stock disponible: ${variant.stock}`;
  }

  function open(product) {

    let selectedImage = product.image;
    let selectedVariant = null;

    function render() {
      UI.modalBody.innerHTML = `
        <div class="modal-content vertical">

          <div class="modal-image">
            <img src="${selectedImage}" />
          </div>

          <div class="modal-info">
            <p class="modal-category">${product.category}</p>

            <h2 class="modal-title">${product.name}</h2>

            <p class="modal-description">
              ${product.description || ""}
            </p>

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
              product.variants
                ? `
                  ${
                    product.category === "yerbas"
                      ? `
                        <p class="modal-stock" id="modalStock">
                          ${selectedVariant ? getStockText(product, selectedVariant) : ""}
                        </p>
                      `
                      : ""
                  }

                  <div class="modal-variants">
                    ${product.variants.map((v) => `
                      <button 
                        class="variant-btn"
                        data-name="${v.name}"
                        data-img="${product.category === "yerbas" ? product.image : v.image}"
                      >
                        ${v.name}
                      </button>
                    `).join("")}
                  </div>
                `
                : ""
            }

            <button class="btn-add" id="modalAdd">
              Agregar al carrito
            </button>
          </div>

        </div>
      `;

      // =========================
      // VARIANTES
      // =========================
      UI.modalBody.querySelectorAll(".variant-btn").forEach(btn => {
        btn.onclick = () => {

          const variantName = btn.dataset.name;
          const newSrc = btn.dataset.img;

          selectedVariant = variantName;

          // 🔥 CAMBIO DE IMAGEN (solo si no es yerba)
          if (product.category !== "yerbas" && newSrc) {
            const img = UI.modalBody.querySelector(".modal-image img");

            if (newSrc !== img.src) {
              img.style.opacity = 0;

              setTimeout(() => {
                img.src = newSrc;
                img.style.opacity = 1;
              }, 120);
            }

            selectedImage = newSrc;
          }

          const variantData = product.variants.find(v => v.name === variantName);

          // 🔥 PRECIO
          const priceEl = UI.modalBody.querySelector("#modalPrice");
          if (variantData && priceEl) {
            const finalPrice = variantData.price ?? product.price;

            if (priceEl && finalPrice) {
              priceEl.textContent = formatPrice(finalPrice);
            }
          }

          // 🔥 STOCK (solo yerbas)
          const stockEl = UI.modalBody.querySelector("#modalStock");
          if (product.category === "yerbas" && variantData && stockEl) {
            stockEl.textContent = getStockText(product, variantName);
          }

          // 🔥 ACTIVE (fix real)
          const allBtns = UI.modalBody.querySelectorAll(".variant-btn");

          allBtns.forEach(b => {
            b.classList.remove("active");
          });

          btn.classList.add("active");

          // 🔥 habilitar botón
          const addBtn = UI.modalBody.querySelector("#modalAdd");

          if (addBtn) {
            addBtn.disabled = false;
            addBtn.textContent = "Agregar al carrito";
          }
        };
      });

      // =========================
      // CARRITO
      // =========================
      UI.modalBody.querySelector("#modalAdd").onclick = () => {
        console.log("VARIANTE SELECCIONADA:", selectedVariant);
        if (product.variants && !selectedVariant) {
          showToast("Seleccione una variante.");
          return;
        }

        let finalPrice = product.price;

        if (product.variants) {
          const variantData = product.variants.find(v => v.name === selectedVariant);

          if (!variantData) return;

          finalPrice = variantData.price ?? product.price;

          // 🔥 stock solo yerbas
          if (product.category === "yerbas" && variantData.stock <= 0) {
            showToast("Sin stock disponible");
            return;
          }
        }

        cart.add({
          ...product,
          image: selectedImage,
          variant: selectedVariant,
          price: finalPrice
        });

        showToast(`${product.name} ${selectedVariant || ""} agregado/a.`);
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

  return { open };
}