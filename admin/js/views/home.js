// Inicio: qué necesita atención hoy, números clave del inventario, accesos
// rápidos y los últimos movimientos de stock. Solo lee datos.
import * as api from "../api/catalog.js";
import { listAllImages } from "../api/images.js";
import { listRecentMovements } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage } from "../ui.js";
import { icon } from "../icons.js";

const DAY = 24 * 60 * 60 * 1000;
const TIME = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const SHORT_DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
const LONG_DATE = new Intl.DateTimeFormat("es-AR", { weekday: "long", day: "numeric", month: "long" });
const INT = new Intl.NumberFormat("es-AR");

const MOVEMENT_LABELS = { entrada: "Entrada", salida: "Salida", ajuste: "Ajuste" };

function plural(n, one, many) {
  return `${INT.format(n)} ${n === 1 ? one : many}`;
}

// "hace 5 min", "hoy 14:20", "ayer 09:10", "28 oct".
export function relativeTime(value, now = new Date()) {
  const date = new Date(value);
  const diff = now - date;
  if (diff < 60 * 1000) return "recién";
  if (diff < 60 * 60 * 1000) return `hace ${Math.floor(diff / 60000)} min`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (date >= startOfToday) return `hoy ${TIME.format(date)}`;
  if (date >= new Date(startOfToday - DAY)) return `ayer ${TIME.format(date)}`;
  return SHORT_DATE.format(date);
}

// Primeros nombres de una lista, para dar contexto sin ocupar mucho.
function examples(names, max = 3) {
  if (!names.length) return "";
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} y ${names.length - max} más` : shown;
}

// Arma el resumen a partir de los datos. Exportada para pruebas.
export function summarizeCatalog({ products, variants, images }) {
  const productById = new Map(products.map((p) => [p.id, p]));
  const withImages = new Set(images.map((i) => i.product_id));
  const label = (v) => `${productById.get(v.product_id)?.name ?? "?"} ${v.name === api.SINGLE_VARIANT_NAME ? "" : v.name}`.trim();

  const live = variants.filter((v) => v.is_active && productById.get(v.product_id)?.is_active);
  const sellable = live.filter((v) => v.price > 0);
  const tracked = sellable.filter((v) => v.track_stock);
  const tracking = variants.filter((v) => v.is_active && v.track_stock);

  const outOfStock = tracked.filter((v) => v.stock === 0);
  const lowStock = tracked.filter((v) => v.stock === 1);
  const drafts = products.filter((p) => !p.is_active);
  const unpriced = variants.filter((v) => v.is_active && !(v.price > 0));
  const noImages = products.filter((p) => p.is_active && !withImages.has(p.id));
  const noCost = variants.filter((v) => v.is_active && v.cost == null);

  const units = tracking.reduce((sum, v) => sum + v.stock, 0);
  const stockValue = tracking.reduce((sum, v) => sum + (v.cost != null ? v.stock * v.cost : 0), 0);
  const stockWithoutCost = tracking.filter((v) => v.stock > 0 && v.cost == null).length;

  return {
    published: products.length - drafts.length,
    total: products.length,
    units,
    stockValue,
    stockWithoutCost,
    outOfStock: outOfStock.map(label),
    lowStock: lowStock.map(label),
    drafts: drafts.map((p) => p.name),
    unpriced: unpriced.map(label),
    noImages: noImages.map((p) => p.name),
    noCost: noCost.map(label),
    label,
  };
}

function stat(value, caption, { alert = false, hint = null, href = null } = {}) {
  const body = [
    h("span", { class: "stat-value" }, alert ? h("span", { class: "dot-alert", "aria-hidden": "true" }) : null, value),
    h("span", { class: "stat-caption" }, caption),
    hint ? h("span", { class: "stat-hint" }, hint) : null,
  ];
  return href ? h("a", { class: "stat stat-link", href }, body) : h("div", { class: "stat" }, body);
}

// Fila de "Necesita atención": marca, título, detalle y botón al lugar donde se resuelve.
function task({ tone, title, detail, href, action }) {
  return h("li", {},
    h("a", { class: "task", href },
      h("span", { class: `task-mark task-${tone}`, "aria-hidden": "true" }),
      h("span", { class: "task-text" },
        h("span", { class: "task-title" }, title),
        detail ? h("span", { class: "task-detail" }, detail) : null),
      h("span", { class: "task-action" }, h("span", { class: "task-action-label" }, action), icon("chevron"))));
}

export async function renderHome(view) {
  mount(view, h("p", { class: "muted" }, "Cargando…"));

  let products, variants, images, movements;
  try {
    [products, variants, images, movements] = await Promise.all([
      api.listProducts(), api.listAllVariantsWithCosts(), listAllImages(), listRecentMovements(8),
    ]);
  } catch (err) {
    console.error(err);
    mount(view,
      h("div", { class: "page-header" }, h("h1", {}, "Inicio")),
      h("p", { class: "form-error" }, `No se pudo cargar el resumen: ${errorMessage(err)}`),
      h("div", { class: "actions" }, h("button", { type: "button", class: "btn-ghost", onClick: () => renderHome(view) }, "Reintentar")));
    return;
  }

  const s = summarizeCatalog({ products, variants, images });
  const variantById = new Map(variants.map((v) => [v.id, v]));

  // ---------- Necesita atención ----------
  const tasks = [];
  if (s.outOfStock.length) tasks.push(task({ tone: "alert", href: "#/inventario?tab=stock&f=zero", action: "Cargar stock",
    title: `${plural(s.outOfStock.length, "presentación agotada", "presentaciones agotadas")}`,
    detail: `Publicadas y sin stock: ${examples(s.outOfStock)}` }));
  if (s.lowStock.length) tasks.push(task({ tone: "strong", href: "#/inventario?tab=stock&f=low", action: "Ver",
    title: `${plural(s.lowStock.length, "presentación con 1 unidad", "presentaciones con 1 unidad")}`,
    detail: examples(s.lowStock) }));
  if (s.drafts.length) tasks.push(task({ tone: "outline", href: "#/productos?estado=draft", action: "Revisar",
    title: `${plural(s.drafts.length, "producto en borrador", "productos en borrador")}`,
    detail: `No se ven en la tienda: ${examples(s.drafts)}` }));
  if (s.unpriced.length) tasks.push(task({ tone: "outline", href: "#/revision", action: "Resolver",
    title: `${plural(s.unpriced.length, "presentación activa sin precio", "presentaciones activas sin precio")}`,
    detail: `No se venden: ${examples(s.unpriced)}` }));
  if (s.noImages.length) tasks.push(task({ tone: "outline", href: "#/revision", action: "Ver",
    title: `${plural(s.noImages.length, "producto publicado sin fotos", "productos publicados sin fotos")}`,
    detail: examples(s.noImages) }));
  if (s.noCost.length) tasks.push(task({ tone: "outline", href: "#/inventario?tab=precios&f=nocost", action: "Cargar costos",
    title: `${plural(s.noCost.length, "variante sin costo", "variantes sin costo")}`,
    detail: "Dato interno: no afecta la tienda, sí el valor del stock" }));

  // ---------- Movimientos ----------
  const movementRows = movements.map((m) => {
    const v = variantById.get(m.variant_id);
    const name = v ? s.label(v) : `Variante ${m.variant_id}`;
    const sign = m.quantity > 0 ? `+${m.quantity}` : String(m.quantity);
    return h("li", {},
      h(v ? "a" : "div", { class: "move", href: v ? `#/productos/${v.product_id}` : null },
        h("span", { class: "move-text" },
          h("span", { class: "move-title" }, name),
          h("span", { class: "move-detail" },
            [MOVEMENT_LABELS[m.movement_type] ?? m.movement_type, m.reason, m.reference].filter(Boolean).join(" · "))),
        h("span", { class: "move-side" },
          h("span", { class: "move-qty" }, sign),
          h("span", { class: "move-when" }, `${relativeTime(m.created_at)} · quedan ${m.stock_after ?? "—"}`))));
  });

  const today = LONG_DATE.format(new Date());

  mount(view,
    h("div", { class: "page-header" },
      h("div", {},
        h("h1", {}, "Inicio"),
        h("p", { class: "page-sub" }, today.charAt(0).toUpperCase() + today.slice(1))),
      h("div", { class: "actions header-actions home-header-actions" },
        h("a", { href: "#/inventario?tab=stock", class: "btn-ghost btn-inline" }, "Cargar stock"),
        h("a", { href: "#/productos/nuevo", class: "btn-primary btn-inline" }, icon("plus"), "Nuevo producto"))),

    h("div", { class: "stats" },
      stat(INT.format(s.published), `productos publicados de ${INT.format(s.total)}`, { href: "#/productos?estado=active" }),
      stat(INT.format(s.units), "unidades en stock", { href: "#/inventario?tab=stock" }),
      stat(formatPrice(s.stockValue), "valor del stock a costo",
        { hint: s.stockWithoutCost ? `${plural(s.stockWithoutCost, "presentación con stock no suma", "presentaciones con stock no suman")}: falta el costo` : null }),
      stat(INT.format(s.outOfStock.length), s.outOfStock.length === 1 ? "presentación agotada" : "presentaciones agotadas",
        { alert: s.outOfStock.length > 0, href: "#/inventario?tab=stock&f=zero" })),

    h("div", { class: "home-grid" },
      h("section", { class: "panel" },
        h("div", { class: "panel-head" }, h("h2", {}, "Necesita atención")),
        tasks.length
          ? h("ul", { class: "task-list" }, tasks)
          : h("div", { class: "empty-box" }, "Todo en orden: no hay agotados, borradores ni datos faltantes.")),

      h("div", { class: "home-side" },
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Accesos rápidos")),
          h("div", { class: "quick" },
            h("a", { href: "#/inventario?tab=stock" }, icon("stock"), "Cargar stock"),
            h("a", { href: "#/productos/nuevo" }, icon("plus"), "Nuevo producto"),
            h("a", { href: "#/productos/nueva-yerba" }, icon("plus"), "Yerba o presentación"),
            h("a", { href: "#/inventario?tab=precios" }, icon("tag"), "Actualizar precios"),
            h("a", { href: "#/importar-precios" }, icon("upload"), "Importar precios"))),

        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Últimos movimientos de stock")),
          movementRows.length
            ? h("ul", { class: "move-list" }, movementRows)
            : h("div", { class: "empty-box" }, "Todavía no hay movimientos. Se registran al cargar stock.")))));
}
