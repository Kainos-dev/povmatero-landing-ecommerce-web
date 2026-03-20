import { showToast } from "./ui.js";

export function initModal(UI, cart) {

  function formatPrice(price) {
    return "$" + price.toLocaleString("es-AR");
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

            <p class="modal-price">
              ${formatPrice(product.price)}
            </p>

            ${
              product.variants
                ? `
                <div class="modal-variants">
                  ${product.variants.map((v) => `
                    <button 
                      class="variant-btn ${v.name === selectedVariant ? "active" : ""}" 
                      data-name="${v.name}"
                      data-img="${v.image}"
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

      const img = UI.modalBody.querySelector(".modal-image img");

      // =========================
      // VARIANTES
      // =========================
      UI.modalBody.querySelectorAll(".variant-btn").forEach(btn => {
        btn.onclick = () => {

          const newSrc = btn.dataset.img;
          const variantName = btn.dataset.name;

          // guardar variante seleccionada
          selectedVariant = variantName;
          selectedImage = newSrc;

          // animación imagen
          if (newSrc !== img.src) {
            img.style.opacity = 0;

            setTimeout(() => {
              img.src = newSrc;
              img.style.opacity = 1;
            }, 120);
          }

          // UI active
          UI.modalBody.querySelectorAll(".variant-btn")
            .forEach(b => b.classList.remove("active"));

          btn.classList.add("active");
        };
      });

      // =========================
      // CARRITO
      // =========================
      UI.modalBody.querySelector("#modalAdd").onclick = () => {

  if (product.variants && !selectedVariant) {
    selectedVariant = product.variants[0].name;
    selectedImage = product.variants[0].image;
  }

  cart.add(
    {
      ...product,
      image: selectedImage,
      variant: selectedVariant
    },
  );

  // UI.modalOverlay.classList.remove("open");

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