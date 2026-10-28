// Navegación del panel por hash (#/productos, #/productos/nuevo, #/productos/12).
import { renderProductList } from "./views/productList.js";
import { renderProductEdit } from "./views/productEdit.js";

const DEFAULT_ROUTE = "#/productos";

const routes = [
  [/^#\/productos\/?$/,        (view) => renderProductList(view)],
  [/^#\/productos\/nuevo\/?$/, (view) => renderProductEdit(view, null)],
  [/^#\/productos\/(\d+)\/?$/, (view, m) => renderProductEdit(view, Number(m[1]))],
];

let container = null;
let listening = false;

function highlightNav() {
  document.querySelectorAll(".admin-nav a").forEach((a) => {
    a.classList.toggle("active", location.hash.startsWith(a.getAttribute("href")));
  });
}

function route() {
  if (!container) return;
  const hash = location.hash || DEFAULT_ROUTE;

  for (const [pattern, render] of routes) {
    const match = hash.match(pattern);
    if (match) {
      // Cada pantalla se dibuja en un contenedor nuevo: si se navega mientras
      // carga, lo que llegue tarde queda en un elemento ya descartado.
      const view = document.createElement("div");
      container.replaceChildren(view);
      highlightNav();
      render(view, match);
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
