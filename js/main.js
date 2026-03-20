import { products } from "./products.js";

import { initUI } from "./components/ui.js";
import { renderCatalog } from "./components/catalog.js";
import { initModal } from "./components/modal.js";
import { initCart } from "./components/cart.js";
import { initFilters } from "./components/filters.js";
import { initFooter } from './components/ui.js';
import { initContactModal } from './components/ui.js';
import { initFiltersToggle } from './components/ui.js';
import { initAboutModal } from './components/ui.js';

const UI = initUI();

const cart = initCart(UI, products);
const modal = initModal(UI, cart);

initFilters(UI, products, renderCatalog, modal, cart);

// Render inicial
renderCatalog(products, UI, modal, cart);


import { initHeaderScroll } from './components/ui.js';
initHeaderScroll();
initContactModal();
initFooter(UI);
initFiltersToggle(UI);
initAboutModal();