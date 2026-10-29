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
import { initAccount } from "./components/account.js";
import { enhanceAnchorLinks } from "./lib/scroll.js";
import { initRouter } from "./router.js";

const UI = initUI();

const cart = initCart(UI);
const modal = initModal(UI, cart);

// Catálogo: Supabase es la única fuente (ver catalogSource.js).
const catalogPromise = loadCatalog();
const EMPTY_STATE_HTML = UI.emptyState.innerHTML;

function render(list) {
  UI.productGrid.removeAttribute("aria-busy");
  UI.emptyState.innerHTML = EMPTY_STATE_HTML;
  renderCatalog(list, UI, modal, cart);
}

function showError() {
  UI.productGrid.removeAttribute("aria-busy");
  UI.productGrid.innerHTML = "";
  UI.emptyState.innerHTML = "<p>No pudimos cargar los productos. Probá recargar la página en unos minutos.</p>";
  UI.emptyState.style.display = "block";
}

const filters = initFilters(UI, catalogPromise, render, showError);

// Carrito guardado en el navegador: se rearma con el catálogo actual.
catalogPromise.then((catalog) => cart.restore(catalog.products)).catch(() => {});

// Render inicial ("Todo")
filters.show("all");

import { initHeaderScroll } from './components/ui.js';
initHeaderScroll();
initContactModal();
initFooter(UI);
initFiltersToggle(UI);
initAboutModal();
initMobileMenu();

initAccount();
enhanceAnchorLinks();

// Portada / páginas de producto (/producto/<slug>)
const router = initRouter({ cart });
router.start(catalogPromise);

// Intro (preloader): se muestra la primera vez de cada visita y se oculta
// apenas pasa la animación (antes esperaba 2,8 s fijos después de cargar todo
// el HTML, en cada página). En las siguientes páginas de la misma visita no se
// muestra (ver el script del <head> de index.html).
// Lo que dura la animación del nombre (2 s, ver .logo-preload) más una breve
// pausa para leerlo. El catálogo carga en paralelo, así que no demora la tienda.
// Si el JavaScript fallara, la intro se va sola a los 5 s (header.css).
const INTRO_MIN_MS = 2200;
(function hidePreloader() {
  const preloader = document.getElementById("preloader");
  if (!preloader) return;
  try { sessionStorage.setItem("povmatero-intro-seen", "1"); } catch { /* sin almacenamiento */ }
  if (document.documentElement.classList.contains("intro-seen")) {
    preloader.classList.add("hidden");
    return;
  }
  const elapsed = performance.now();
  setTimeout(() => preloader.classList.add("hidden"), Math.max(0, INTRO_MIN_MS - elapsed));
})();
