import { listProducts, listCategories } from "../api/catalog.js";
import { h, mount, formatPrice, errorMessage, normalizeText } from "../ui.js";

function summarize(product) {
  const variants = product.product_variants ?? [];
  const active = variants.filter((v) => v.is_active);
  const prices = active.map((v) => Number(v.price));
  const tracked = active.filter((v) => v.track_stock);

  let price = "—";
  if (prices.length) {
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    price = min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`;
  }

  return {
    variants: variants.length ? `${active.length} de ${variants.length} activas` : null,
    price,
    stock: tracked.length ? String(tracked.reduce((sum, v) => sum + v.stock, 0)) : "—",
  };
}

export async function renderProductList(view) {
  mount(view, h("p", { class: "muted" }, "Cargando productos…"));

  let products, categories;
  try {
    [products, categories] = await Promise.all([listProducts(), listCategories()]);
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar por nombre…", "aria-label": "Buscar" });
  const categoryFilter = h("select", { class: "input", "aria-label": "Categoría" },
    h("option", { value: "" }, "Todas las categorías"),
    categories.map((c) => h("option", { value: String(c.id) }, c.name))
  );
  const statusFilter = h("select", { class: "input", "aria-label": "Estado" },
    h("option", { value: "" }, "Todos los estados"),
    h("option", { value: "active" }, "Publicados"),
    h("option", { value: "draft" }, "Borradores")
  );

  const count = h("p", { class: "muted" });
  const tbody = h("tbody");

  function row(product) {
    const s = summarize(product);
    const href = `#/productos/${product.id}`;
    const tr = h("tr", { class: "row-link", onClick: () => { location.hash = href; } },
      h("td", {}, h("a", { href }, product.name)),
      h("td", {}, categoryName.get(product.category_id) ?? "—"),
      h("td", {}, s.variants ?? h("span", { class: "badge badge-warn" }, "Sin variantes")),
      h("td", {}, s.price),
      h("td", { class: "num" }, s.stock),
      h("td", {}, h("span", { class: product.is_active ? "badge badge-ok" : "badge" },
        product.is_active ? "Publicado" : "Borrador"))
    );
    return tr;
  }

  function render() {
    const query = normalizeText(search.value.trim());
    const category = categoryFilter.value;
    const status = statusFilter.value;

    const visible = products.filter((p) =>
      (!query || normalizeText(p.name).includes(query)) &&
      (!category || String(p.category_id) === category) &&
      (!status || (status === "active") === p.is_active)
    );

    if (visible.length) {
      mount(tbody, ...visible.map(row));
    } else {
      const message = products.length
        ? "No hay productos que coincidan con los filtros."
        : "Todavía no hay productos. Creá el primero con “Nuevo producto”.";
      mount(tbody, h("tr", {}, h("td", { colspan: "6", class: "empty" }, message)));
    }
    count.textContent = `${visible.length} de ${products.length} productos`;
  }

  search.addEventListener("input", render);
  categoryFilter.addEventListener("change", render);
  statusFilter.addEventListener("change", render);

  mount(view, 
    h("div", { class: "page-header" },
      h("h2", {}, "Productos"),
      h("a", { href: "#/productos/nuevo", class: "btn-primary btn-inline" }, "Nuevo producto")
    ),
    h("div", { class: "toolbar" }, search, categoryFilter, statusFilter),
    count,
    h("div", { class: "table-wrap" },
      h("table", { class: "table" },
        h("thead", {}, h("tr", {},
          ["Producto", "Categoría", "Variantes", "Precio", "Stock", "Estado"].map((t) => h("th", {}, t))
        )),
        tbody
      )
    )
  );

  render();
}
