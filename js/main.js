import { loadCatalog } from "./catalogSource.js";
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

// Catálogo: Supabase por defecto, con respaldo en la fuente anterior (ver catalogSource.js).
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
