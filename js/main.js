import { loadCatalog } from "./catalogSource.js";
import { getYerbas, agruparYerbas } from "./yerbas.js";
import { initUI } from "./components/ui.js";
import { renderCatalog } from "./components/catalog.js";
import { initModal } from "./components/modal.js";
import { initCart } from "./components/cart.js";
import { initFilters } from "./components/filters.js";
import { initFooter } from './components/ui.js';
import { initContactModal } from './components/ui.js';
import { initFiltersToggle } from './components/ui.js';
import { initAboutModal } from './components/ui.js';
import { initMobileMenu } from './components/ui.js';

const UI = initUI();

const cart = initCart(UI);
const modal = initModal(UI, cart);

// Catálogo: fuente actual por defecto, Supabase solo con ?fuente=supabase.
const catalogPromise = loadCatalog();
const EMPTY_STATE_HTML = UI.emptyState.innerHTML;

function render(list) {
  UI.emptyState.innerHTML = EMPTY_STATE_HTML;
  renderCatalog(list, UI, modal, cart);
}

function showError() {
  UI.productGrid.innerHTML = "";
  UI.emptyState.innerHTML = "<p>No pudimos cargar los productos. Probá recargar la página en unos minutos.</p>";
  UI.emptyState.style.display = "block";
}

const filters = initFilters(UI, catalogPromise, render, showError);

// Render inicial ("Todo")
filters.show("all");

import { initHeaderScroll } from './components/ui.js';
initHeaderScroll();
initContactModal();
initFooter(UI);
initFiltersToggle(UI);
initAboutModal();
initMobileMenu();

document.addEventListener("DOMContentLoaded", () => {
  const preloader = document.getElementById("preloader");

  // duración mínima del preloader
  setTimeout(() => {
    preloader.classList.add("hidden");
  }, 2800); // podés ajustar (2.5–3.2s ideal)
});

async function renderYerbas() {
  const container = document.getElementById("products-container");
  container.innerHTML = "";

  const data = await getYerbas();
  const grupos = agruparYerbas(data);

  Object.keys(grupos).forEach(nombre => {
    const variantes = grupos[nombre];

    const card = document.createElement("div");
    card.classList.add("product-card");

    let variantesHTML = "";

    variantes.forEach(v => {
      variantesHTML += `
        <div class="variante">
          <span>${v.peso}</span>
          <span>$${v.precio}</span>
          <span>${v.stock > 0 ? `Quedan ${v.stock}` : "Sin stock"}</span>
        </div>
      `;
    });

    card.innerHTML = `
      <h3>${nombre}</h3>
      <div class="variantes">
        ${variantesHTML}
      </div>
    `;

    container.appendChild(card);
  });
}