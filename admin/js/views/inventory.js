// Inventario: Stock (conteo), Precios (SKU, precios y costos) y Movimientos
// (historial). Cada pestaña tiene su dirección: #/inventario?tab=precios.
import { h, mount } from "../ui.js";
import { renderStockTable } from "./stockTable.js";
import { renderPriceTable } from "./inventoryPrices.js";
import { renderMovements } from "./inventoryMovements.js";

const TABS = [
  ["stock", "Stock", renderStockTable],
  ["precios", "Precios", renderPriceTable],
  ["movimientos", "Movimientos", renderMovements],
];

export function renderInventory(view, query = {}) {
  const current = TABS.find(([key]) => key === query.tab) ?? TABS[0];
  const [key, , render] = current;

  const tabs = h("nav", { class: "segmented", "aria-label": "Secciones de inventario" },
    TABS.map(([k, label]) => h("a", {
      href: `#/inventario?tab=${k}`,
      class: k === key ? "active" : "",
      "aria-current": k === key ? "page" : null,
    }, label)));

  const body = h("div", { class: "page" });
  mount(view,
    h("div", { class: "page-header" }, h("h1", {}, "Inventario")),
    tabs,
    body);
  render(body, query);
}
