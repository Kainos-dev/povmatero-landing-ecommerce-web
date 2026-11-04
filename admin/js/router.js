// Navegación del panel por hash (#/inicio, #/productos, #/productos/12?tab=precios,
// #/inventario?tab=stock&f=zero).
// Lo que va después de "?" se pasa a la pantalla como filtros iniciales.
import { renderHome } from "./views/home.js";
import { renderMore } from "./views/more.js";
import { renderProductList } from "./views/productList.js";
import { renderProductEdit } from "./views/productEdit.js";
import { renderInventory } from "./views/inventory.js";
import { renderImageMigration } from "./views/imageMigration.js";
import { renderCostImport } from "./views/costImport.js";
import { renderCatalogReview } from "./views/catalogReview.js";
import { renderCustomers } from "./views/customers.js";
import { renderStats } from "./views/stats.js";
import { renderOrders } from "./views/orders.js";
import { renderOrderDetail } from "./views/orderDetail.js";
import { countPending } from "./api/orders.js";
import { renderShelfImages } from "./views/shelfImages.js";
import { renderStockTools } from "./views/stockTools.js";
import { renderRestockAlerts } from "./views/restockAlerts.js";

const DEFAULT_ROUTE = "#/inicio";

// [patrón, pantalla, sección del menú que se marca]
const routes = [
  [/^#\/inicio\/?$/,           (view, m, q) => renderHome(view, q),                 "#/inicio"],
  [/^#\/productos\/?$/,        (view, m, q) => renderProductList(view, q),          "#/productos"],
  [/^#\/productos\/nuevo\/?$/, (view) => renderProductEdit(view, null),             "#/productos"],
  [/^#\/productos\/(\d+)\/?$/, (view, m, q) => renderProductEdit(view, Number(m[1]), q), "#/productos"],
  [/^#\/pedidos\/?$/,          (view, m, q) => renderOrders(view, q),               "#/pedidos"],
  [/^#\/pedidos\/(\d+)\/?$/,   (view, m) => renderOrderDetail(view, Number(m[1])),  "#/pedidos"],
  [/^#\/inventario\/?$/,       (view, m, q) => renderInventory(view, q),            "#/inventario"],
  [/^#\/clientes\/?$/,         (view) => renderCustomers(view),                     "#/clientes"],
  [/^#\/imagenes\/?$/,         (view) => renderImageMigration(view),                "#/imagenes"],
  [/^#\/importar-(costos|precios)\/?$/, (view) => renderCostImport(view),             "#/importar-precios"],
  [/^#\/revision\/?$/,         (view) => renderCatalogReview(view),                 "#/revision"],
  [/^#\/estadisticas\/?$/,     (view) => renderStats(view),                         "#/estadisticas"],
  [/^#\/gondola\/?$/,          (view) => renderShelfImages(view),                   "#/gondola"],
  [/^#\/stock-rapido\/?$/,     (view, m, q) => renderStockTools(view, q),           "#/stock-rapido"],
  [/^#\/avisos\/?$/,           (view) => renderRestockAlerts(view),                 "#/avisos"],
  [/^#\/mas\/?$/,              (view) => renderMore(view),                          "#/mas"],
];

// Secciones que en el celular viven dentro de «Más».
const IN_MORE = new Set(["#/stock-rapido", "#/avisos", "#/clientes", "#/gondola", "#/estadisticas", "#/imagenes", "#/importar-precios", "#/revision", "#/mas"]);

// Marca en «Pedidos» con los pedidos de yerbas pendientes (sin vencer).
let badgeTimer = 0;
export function refreshOrdersBadge() {
  clearTimeout(badgeTimer);
  badgeTimer = setTimeout(async () => {
    let n = 0;
    try { n = await countPending(); } catch { return; }
    document.querySelectorAll('[data-nav][href="#/pedidos"]').forEach((a) => {
      if (n > 0) {
        a.dataset.count = n > 99 ? "99+" : String(n);
        a.setAttribute("aria-label", `Pedidos (${n} ${n === 1 ? "pendiente" : "pendientes"})`);
      } else {
        delete a.dataset.count;
        a.removeAttribute("aria-label");
      }
    });
  }, 150);
}

let container = null;
let listening = false;

function highlightNav(section) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const target = a.getAttribute("href");
    const on = target === section || (target === "#/mas" && IN_MORE.has(section));
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

function route() {
  if (!container) return;
  const full = location.hash || DEFAULT_ROUTE;
  const [hash, queryString = ""] = full.split("?");
  // Direcciones anteriores (#/precios, #/stock) → Inventario, conservando filtros.
  const legacy = { "#/precios": "precios", "#/stock": "stock" }[hash.replace(/\/$/, "")];
  if (legacy) {
    const params = new URLSearchParams(queryString);
    params.set("tab", legacy);
    location.replace(`#/inventario?${params}`);
    return;
  }
  const query = Object.fromEntries(new URLSearchParams(queryString));

  for (const [pattern, render, section] of routes) {
    const match = hash.match(pattern);
    if (match) {
      // Cada pantalla se dibuja en un contenedor nuevo: si se navega mientras
      // carga, lo que llegue tarde queda en un elemento ya descartado.
      const view = document.createElement("div");
      view.className = "page";
      container.replaceChildren(view);
      highlightNav(section);
      refreshOrdersBadge();
      window.scrollTo(0, 0);
      render(view, match, query);
      return;
    }
  }
  location.hash = DEFAULT_ROUTE;
}

export function startRouter(el) {
  container = el;
  if (!listening) {
    window.addEventListener("hashchange", route);
    listening = true;
  }
  if (!location.hash) history.replaceState(null, "", DEFAULT_ROUTE);
  route();
}

export function stopRouter() {
  if (container) container.replaceChildren();
  container = null;
}
