import { listProducts, listCategories, setProductsActive } from "../api/catalog.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

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

// Misma regla que la publicación individual: al menos una variante activa con precio > 0.
function isPublishable(product) {
  return (product.product_variants ?? []).some((v) => v.is_active && Number(v.price) > 0);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
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
  const selected = new Set();   // ids seleccionados (solo entre los visibles)
  let visible = [];
  let busy = false;

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
  const bulkBar = h("div", { class: "bulk-bar", hidden: true });
  const tbody = h("tbody");
  const selectAll = h("input", { type: "checkbox", "aria-label": "Seleccionar todos los visibles" });

  selectAll.addEventListener("change", () => {
    visible.forEach((p) => (selectAll.checked ? selected.add(p.id) : selected.delete(p.id)));
    render();
  });

  // ---------- Acciones en lote ----------
  function renderBulkBar(confirmFor = null) {
    if (!selected.size) {
      bulkBar.hidden = true;
      mount(bulkBar);
      return;
    }
    bulkBar.hidden = false;

    const chosen = products.filter((p) => selected.has(p.id));

    if (!confirmFor) {
      mount(bulkBar,
        h("span", {}, `${plural(chosen.length, "producto seleccionado", "productos seleccionados")}`),
        h("button", { type: "button", class: "btn-primary btn-inline", disabled: busy, onClick: () => renderBulkBar("publish") }, "Publicar"),
        h("button", { type: "button", class: "btn-ghost", disabled: busy, onClick: () => renderBulkBar("draft") }, "Pasar a borrador"),
        h("button", { type: "button", class: "btn-ghost", disabled: busy, onClick: () => { selected.clear(); render(); } }, "Quitar selección")
      );
      return;
    }

    const publishing = confirmFor === "publish";
    const toChange = chosen.filter((p) => p.is_active !== publishing && (!publishing || isPublishable(p)));
    const blocked = publishing ? chosen.filter((p) => !p.is_active && !isPublishable(p)) : [];
    const unchanged = chosen.length - toChange.length - blocked.length;

    const lines = [
      toChange.length
        ? (publishing
            ? `Se van a publicar ${plural(toChange.length, "producto", "productos")}: se mostrarán en la tienda.`
            : `Se van a pasar a borrador ${plural(toChange.length, "producto", "productos")}: dejarán de mostrarse en la tienda.`)
        : "No hay cambios para hacer con la selección actual.",
      unchanged ? `Sin cambios en ${plural(unchanged, "producto", "productos")}: ya ${publishing ? "publicados" : "en borrador"}.` : null,
      blocked.length
        ? `${blocked.length === 1 ? "Se omite" : "Se omiten"} ${plural(blocked.length, "producto", "productos")} sin variante activa con precio mayor a 0: ${blocked.map((p) => p.name).join(", ")}.`
        : null,
    ];

    const confirm = h("button", { type: "button", class: "btn-primary btn-inline", disabled: busy || !toChange.length },
      publishing ? "Confirmar publicación" : "Confirmar");
    confirm.addEventListener("click", () => applyBulk(toChange, publishing));

    mount(bulkBar,
      h("div", { class: "bulk-confirm" },
        lines.filter(Boolean).map((t) => h("p", {}, t)),
        h("div", { class: "actions" },
          confirm,
          h("button", { type: "button", class: "btn-ghost", disabled: busy, onClick: () => renderBulkBar() }, "Cancelar")
        )
      )
    );
  }

  async function applyBulk(list, publishing) {
    busy = true;
    renderBulkBar(publishing ? "publish" : "draft");
    const ids = list.map((p) => p.id);

    try {
      const saved = new Set(await setProductsActive(ids, publishing));
      products.forEach((p) => { if (saved.has(p.id)) p.is_active = publishing; });
      const failed = list.filter((p) => !saved.has(p.id));

      if (failed.length) {
        toast(`Se guardaron ${saved.size} de ${ids.length}. No se pudieron cambiar: ${failed.map((p) => p.name).join(", ")}.`, "error");
      } else {
        toast(publishing
          ? `${plural(saved.size, "producto publicado", "productos publicados")}.`
          : `${plural(saved.size, "producto pasado", "productos pasados")} a borrador.`);
      }
      selected.clear();
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), "error");
    } finally {
      busy = false;
      render();
    }
  }

  // ---------- Tabla ----------
  function row(product) {
    const s = summarize(product);
    const href = `#/productos/${product.id}`;
    const check = h("input", { type: "checkbox", checked: selected.has(product.id), "aria-label": `Seleccionar ${product.name}` });
    check.addEventListener("click", (e) => e.stopPropagation());
    check.addEventListener("change", () => {
      check.checked ? selected.add(product.id) : selected.delete(product.id);
      syncSelection();
    });

    return h("tr", { class: "row-link", onClick: () => { location.hash = href; } },
      h("td", { class: "center", onClick: (e) => { if (e.target === e.currentTarget) { e.stopPropagation(); check.click(); } } }, check),
      h("td", {}, h("a", { href }, product.name)),
      h("td", {}, categoryName.get(product.category_id) ?? "—"),
      h("td", {}, s.variants ?? h("span", { class: "badge badge-warn" }, "Sin variantes")),
      h("td", {}, s.price),
      h("td", { class: "num" }, s.stock),
      h("td", {}, h("span", { class: product.is_active ? "badge badge-ok" : "badge" },
        product.is_active ? "Publicado" : "Borrador"))
    );
  }

  function syncSelection() {
    const visibleSelected = visible.filter((p) => selected.has(p.id)).length;
    selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    renderBulkBar();
  }

  function render() {
    const query = normalizeText(search.value.trim());
    const category = categoryFilter.value;
    const status = statusFilter.value;

    visible = products.filter((p) =>
      (!query || normalizeText(p.name).includes(query)) &&
      (!category || String(p.category_id) === category) &&
      (!status || (status === "active") === p.is_active)
    );

    // Lo que queda fuera de los filtros deja de estar seleccionado:
    // así nunca se actúa sobre productos que no se ven.
    const visibleIds = new Set(visible.map((p) => p.id));
    [...selected].forEach((id) => { if (!visibleIds.has(id)) selected.delete(id); });

    if (visible.length) {
      mount(tbody, ...visible.map(row));
    } else {
      const message = products.length
        ? "No hay productos que coincidan con los filtros."
        : "Todavía no hay productos. Creá el primero con “Nuevo producto”.";
      mount(tbody, h("tr", {}, h("td", { colspan: "7", class: "empty" }, message)));
    }

    const published = products.filter((p) => p.is_active).length;
    count.textContent = `${visible.length} de ${products.length} productos · ${published} publicados · ${products.length - published} borradores`;
    syncSelection();
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
    bulkBar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", { class: "center" }, selectAll),
          ["Producto", "Categoría", "Variantes", "Precio", "Stock", "Estado"].map((t) => h("th", {}, t))
        )),
        tbody
      )
    )
  );

  render();
}
