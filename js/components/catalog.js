import { escapeHtml } from "../lib/html.js";
import { optimizedSrc, optimizedSrcset, withFallback, warmImage } from "../lib/images.js";
import { modalImageWidth } from "./modal.js";

function formatPrice(price) {
  return "$" + price.toLocaleString("es-AR");
}

function shuffle(array) {
  return [...array].sort(() => Math.random() - 0.5);
}

// Las primeras tarjetas cargan su foto enseguida (son las que se ven al llegar
// al catálogo); el resto, recién cuando se acercan a la pantalla.
const EAGER_CARDS = 4;
const CARD_WIDTHS = [256, 384, 640, 828];
// Ancho de la tarjeta según la grilla (1, 3 o 4 columnas: ver responsive.css).
const CARD_SIZES = "(min-width: 1024px) 22vw, (min-width: 640px) 29vw, 86vw";

// Aparición suave de cada foto cuando termina de cargar (sin saltos).
function revealWhenLoaded(img) {
  const show = () => img.classList.add("is-loaded");
  if (img.complete && img.naturalWidth > 0) return show();
  img.addEventListener("load", show);
  img.addEventListener("error", () => {
    // La primera falla puede ser del optimizador (se reintenta con la original).
    img.addEventListener("error", show, { once: true });
    setTimeout(show, 3000);
  }, { once: true });
}

export function renderCatalog(products, UI, modal, cart) {
  UI.productGrid.innerHTML = "";

  if (!products.length) {
    UI.emptyState.style.display = "block";
    return;
  }

  UI.emptyState.style.display = "none";

  const randomized = shuffle(products);
  const fragment = document.createDocumentFragment();

randomized.forEach((product, index) => {
    const card = document.createElement("div");
    card.className = "product-card";

    const eager = index < EAGER_CARDS;
    const srcset = optimizedSrcset(product.image, CARD_WIDTHS);

    card.innerHTML = `
      <div class="card-image-wrap">
        <img src="${escapeHtml(optimizedSrc(product.image, 640))}"${srcset ? ` srcset="${escapeHtml(srcset)}" sizes="${CARD_SIZES}"` : ""} alt="${escapeHtml(product.name)}" class="card-img" loading="${eager ? "eager" : "lazy"}" decoding="async"${eager ? ' fetchpriority="high"' : ""}/>
      </div>

      <div class="card-body">
        <p class="card-category">${escapeHtml(product.categoryName ?? product.category)}</p>
        <p class="card-name">${escapeHtml(product.name)}</p>
          ${product.category !== "yerbas" ? `
        <p class="card-price">${formatPrice(product.price)}</p>
          ` : ""} 
        <button class="btn-add">Ver más</button>
      </div>
    `;

    const img = card.querySelector(".card-img");
    withFallback(img, product.image);
    revealWhenLoaded(img);

    // Al acercar el mouse o tocar la tarjeta se adelanta la foto grande de la ficha.
    const warm = () => warmImage(product.image, modalImageWidth());
    card.addEventListener("pointerenter", warm, { once: true });
    card.addEventListener("touchstart", warm, { once: true, passive: true });

    // MODAL
    img.onclick = () => {
      modal.open(product);
    };

    card.querySelector(".card-name").onclick = () => {
      modal.open(product);
    };

    // CARRITO
    card.querySelector(".btn-add").onclick = () => {
      modal.open(product);
    };

    fragment.appendChild(card);
  });

  UI.productGrid.appendChild(fragment);
}
