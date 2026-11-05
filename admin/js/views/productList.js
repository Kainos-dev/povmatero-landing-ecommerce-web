// Productos: lista con Publicados / Borradores, acciones en lote y edición
// rápida de precio, costo y stock de cada variante (sin entrar a la ficha).
// Nada se guarda hasta revisar y confirmar.
import { listProducts, listCategories, setProductsActive, isSimpleProduct, listProductInternals,
         listAllVariantsWithCosts, SINGLE_VARIANT_NAME } from "../api/catalog.js";
import * as qe from "../api/quickEdit.js";
import { newKey, planFromError } from "../api/stockTools.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

const YERBAS = "yerbas";
const MAX_STOCK_STEP = 9999;   // la base acepta movimientos de 1 a 9999 unidades

// Misma regla que la publicación individual: al menos una variante activa con precio > 0.
function isPublishable(product) {
  return (product.product_variants ?? []).some((v) => v.is_active && Number(v.price) > 0);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

const variantLabel = (v) => (v.name === SINGLE_VARIANT_NAME ? "Modelo único" : v.name);

// query (desde Inicio u otro enlace): { estado: "active" | "draft", categoria: slug, q: texto }
export async function renderProductList(view, query = {}) {
  mount(view, h("p", { class: "muted" }, "Cargando productos…"));

  let products, categories, internals, variants, commitments = new Map();
  async function load() {
    [products, categories, internals, variants] = await Promise.all([
      listProducts(), listCategories(), listProductInternals(), listAllVariantsWithCosts(),
    ]);
    for (const p of products) p.base_price = p.base_price == null ? null : Number(p.base_price);
    try { commitments = await qe.listCommitments(); } catch { commitments = new Map(); }
  }
  try {
    await load();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  let categoryName, categorySlug, variantsOf, productById, variantById;
  function index() {
    categoryName = new Map(categories.map((c) => [c.id, c.name]));
    categorySlug = new Map(categories.map((c) => [c.id, c.slug]));
    productById = new Map(products.map((p) => [p.id, p]));
    variantById = new Map(variants.map((v) => [v.id, v]));
    const byProduct = new Map();
    for (const v of variants) {
      if (!byProduct.has(v.product_id)) byProduct.set(v.product_id, []);
      byProduct.get(v.product_id).push(v);
    }
    for (const list of byProduct.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    variantsOf = (p) => byProduct.get(p.id) ?? [];
  }
  index();

  const selected = new Set();   // ids seleccionados (solo entre los visibles)
  const expanded = new Set();   // productos con varias variantes abiertos para editar
  // Ediciones pendientes por variante: { price?, cost?, stock? (texto), priceManual? }.
  // En las yerbas, «price» sin «priceManual» es el precio calculado desde el costo.
  const edits = new Map();
  const stockKeys = new Map();  // "variante:de:a" → { key, tried } (reintentos sin duplicar)
  const shortageAck = new Set(); // variantes cuya baja de stock no cubre reservas y se confirmó
  let visible = [];
  let busy = false;
  let saving = false;
  let lastErrors = [];
  let group = query.estado === "draft" ? "draft" : "active";

  const skuOf = (p) => internals.get(p.id)?.sku ?? null;
  const isYerba = (p) => categorySlug.get(p.category_id) === YERBAS;

  // ---------- Controles ----------
  const search = h("input", { type: "search", class: "input", placeholder: "Buscar por nombre o SKU…", "aria-label": "Buscar" });
  const categoryFilter = h("select", { class: "input", "aria-label": "Categoría" },
    h("option", { value: "" }, "Todas las categorías"),
    categories.map((c) => h("option", { value: String(c.id) }, c.name))
  );
  const groupBox = h("div", { class: "segmented seg-buttons product-groups", role: "group", "aria-label": "Mostrar" });
  const count = h("p", { class: "muted product-count" });
  const notice = h("div");
  const bulkBar = h("div", { class: "bulk-bar", hidden: true });
  const saveBar = h("div", { class: "save-bar", hidden: true });
  const tbody = h("tbody");
  const selectAll = h("input", { type: "checkbox", "aria-label": "Seleccionar todos los visibles" });

  selectAll.addEventListener("change", () => {
    visible.forEach((p) => (selectAll.checked ? selected.add(p.id) : selected.delete(p.id)));
    render();
  });

  // ---------- Valores (original y editado) ----------
  // Un producto simple que hereda el valor general se edita en el general
  // (como en su ficha); cualquier otra variante, en la variante misma.
  const priceTarget = (p, v) => (isSimpleProduct(variantsOf(p)) && v.price_inherited && p.base_price != null ? "base" : "variant");
  const costTarget = (p, v) => (isSimpleProduct(variantsOf(p)) && v.cost_inherited && internals.get(p.id)?.base_cost != null ? "base" : "variant");
  const origPrice = (p, v) => (priceTarget(p, v) === "base" ? p.base_price : v.price);
  const origCost = (p, v) => (costTarget(p, v) === "base" ? internals.get(p.id).base_cost : v.cost);

  function current(v) {
    const p = productById.get(v.product_id);
    const e = edits.get(v.id) ?? {};
    return {
      price: "price" in e ? qe.parseMoney(e.price) : origPrice(p, v),
      cost: "cost" in e ? qe.parseMoney(e.cost) : origCost(p, v),
      stock: "stock" in e ? qe.parseCount(e.stock) : v.stock,
    };
  }

  // Yerbas: el precio de venta sigue al costo editado (costo × 1,20 redondeado
  // hacia arriba a $50). Sin costo nuevo válido, vuelve al precio guardado.
  function autoPrice(p, v, e) {
    delete e.price;
    if (!("cost" in e)) return;
    const cost = qe.parseMoney(e.cost);
    if (cost == null || Number.isNaN(cost) || cost <= 0) return;
    const price = qe.yerbaPrice(cost);
    if (!qe.sameMoney(price, origPrice(p, v))) e.price = String(price);
  }
  const isAutoPrice = (p, e) => isYerba(p) && "price" in e && !e.priceManual;

  function setField(v, key, text) {
    const p = productById.get(v.product_id);
    const e = { ...(edits.get(v.id) ?? {}) };
    const orig = key === "price" ? origPrice(p, v) : key === "cost" ? origCost(p, v) : v.stock;
    const parsed = key === "stock" ? qe.parseCount(text) : qe.parseMoney(text);
    const same = String(text).trim() === "" ? orig == null
      : key === "stock" ? parsed === orig : !Number.isNaN(parsed) && qe.sameMoney(parsed, orig);
    if (same) delete e[key];
    else e[key] = String(text);
    // Lo que se escribe a mano en el precio se respeta aunque después cambie el costo.
    if (key === "price") e.priceManual = true;
    if (key === "cost" && isYerba(p) && !e.priceManual) autoPrice(p, v, e);
    if (key === "stock") shortageAck.delete(v.id);
    const keys = Object.keys(e).filter((k) => ["price", "cost", "stock"].includes(k));
    if (keys.length) edits.set(v.id, e);
    else edits.delete(v.id);
  }

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
        group === "draft"
          ? h("button", { type: "button", class: "btn-primary btn-inline", disabled: busy, onClick: () => renderBulkBar("publish") }, "Publicar")
          : h("button", { type: "button", class: "btn-primary btn-inline", disabled: busy, onClick: () => renderBulkBar("draft") }, "Pasar a borrador"),
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
        ? `${blocked.length === 1 ? "Se omite" : "Se omiten"} ${plural(blocked.length, "producto", "productos")} sin precio (o sin variantes activas con precio): ${blocked.map((p) => p.name).join(", ")}.`
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
          ? `${plural(saved.size, "producto publicado", "productos publicados")}: están en «Publicados».`
          : `${plural(saved.size, "producto pasado", "productos pasados")} a borrador: están en «Borradores».`);
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

  // ---------- Celdas editables ----------
  const stop = (e) => e.stopPropagation();

  function moneyInput(v, key, label) {
    const p = productById.get(v.product_id);
    const e = edits.get(v.id) ?? {};
    const orig = key === "price" ? origPrice(p, v) : origCost(p, v);
    const input = h("input", {
      class: "input qe-input", type: "text", inputmode: "decimal", autocomplete: "off", enterkeyhint: "done",
      value: key in e ? e[key] : (orig == null ? "" : String(orig)),
      placeholder: key === "cost" ? "Sin costo" : "",
      "aria-label": label,
    });
    return input;
  }

  function stockInput(v, label) {
    const e = edits.get(v.id) ?? {};
    return h("input", {
      class: "input qe-input qe-stock", type: "text", inputmode: "numeric", autocomplete: "off", enterkeyhint: "done",
      value: "stock" in e ? e.stock : String(v.stock), "aria-label": label,
    });
  }

  // Línea chica debajo del input: el valor anterior (y cómo se leyó lo escrito).
  function hintFor(v, key) {
    const p = productById.get(v.product_id);
    const e = edits.get(v.id) ?? {};
    if (!(key in e)) return null;
    if (key === "stock") {
      const n = qe.parseCount(e.stock);
      if (n == null || Number.isNaN(n)) return h("span", { class: "qe-hint qe-bad" }, "Entero ≥ 0");
      const d = n - v.stock;
      return h("span", { class: "qe-hint" }, `era ${v.stock} (${d > 0 ? "+" : ""}${d})`);
    }
    const orig = key === "price" ? origPrice(p, v) : origCost(p, v);
    const n = qe.parseMoney(e[key]);
    if (n == null) return h("span", { class: key === "price" ? "qe-hint qe-bad" : "qe-hint" }, key === "price" ? "Obligatorio" : `era ${formatPrice(orig)}`);
    if (Number.isNaN(n)) return h("span", { class: "qe-hint qe-bad" }, "Número inválido");
    const auto = key === "price" && isAutoPrice(p, e) ? " · costo + 20 %" : "";
    return h("span", { class: "qe-hint" }, `era ${orig == null ? "—" : formatPrice(orig)} → ${formatPrice(n)}${auto}`);
  }

  // Devuelve las tres celdas (precio, costo, stock) de una variante.
  function editCells(v, tr, refreshRow) {
    const p = productById.get(v.product_id);
    const name = variantsOf(p).length > 1 ? `${p.name} ${variantLabel(v)}` : p.name;
    const price = moneyInput(v, "price", `Precio de ${name}`);
    const cost = moneyInput(v, "cost", `Costo de ${name}`);
    const stock = v.track_stock ? stockInput(v, `Stock de ${name}`) : null;
    const priceHint = h("span", { class: "qe-hint-slot" });
    const costHint = h("span", { class: "qe-hint-slot" });
    const stockHint = h("span", { class: "qe-hint-slot" });

    function sync() {
      const e = edits.get(v.id) ?? {};
      price.classList.toggle("is-dirty", "price" in e);
      cost.classList.toggle("is-dirty", "cost" in e);
      stock?.classList.toggle("is-dirty", "stock" in e);
      mount(priceHint, hintFor(v, "price"));
      mount(costHint, hintFor(v, "cost"));
      mount(stockHint, hintFor(v, "stock"));
      tr.classList.toggle("row-dirty", edits.has(v.id));
      refreshRow?.();
    }
    function refreshPrice() {
      const e = edits.get(v.id) ?? {};
      const orig = origPrice(p, v);
      price.value = "price" in e ? e.price : (orig == null ? "" : String(orig));
    }
    price.addEventListener("input", () => { setField(v, "price", price.value); sync(); renderSaveBar(); });
    cost.addEventListener("input", () => { setField(v, "cost", cost.value); refreshPrice(); sync(); renderSaveBar(); });
    stock?.addEventListener("input", () => { setField(v, "stock", stock.value); sync(); renderSaveBar(); });
    for (const el of [price, cost, stock]) el?.addEventListener("click", stop);
    sync();

    return [
      h("td", { class: "c-qe c-price", "data-label": "Precio", onClick: stop }, h("div", { class: "qe-cell" }, price, priceHint)),
      h("td", { class: "c-qe c-cost", "data-label": "Costo", onClick: stop }, h("div", { class: "qe-cell" }, cost, costHint)),
      h("td", { class: "c-qe c-stock", "data-label": "Stock", onClick: stop },
        stock ? h("div", { class: "qe-cell" }, stock, stockHint) : h("span", { class: "muted", title: "No controla stock" }, "—")),
    ];
  }

  // ---------- Tabla ----------
  function priceRange(p) {
    const prices = variantsOf(p).filter((v) => v.is_active).map((v) => current(v).price).filter((n) => n != null && !Number.isNaN(n));
    if (!prices.length) return "—";
    const min = Math.min(...prices), max = Math.max(...prices);
    return min === max ? formatPrice(min) : `${formatPrice(min)} – ${formatPrice(max)}`;
  }

  function productRows(product) {
    const vs = variantsOf(product);
    const href = `#/productos/${product.id}`;
    const multi = vs.length > 1;
    const open = multi && expanded.has(product.id);
    const dirtyVariants = vs.filter((v) => edits.has(v.id)).length;

    const check = h("input", { type: "checkbox", checked: selected.has(product.id), "aria-label": `Seleccionar ${product.name}` });
    check.addEventListener("click", stop);
    check.addEventListener("change", () => {
      check.checked ? selected.add(product.id) : selected.delete(product.id);
      syncSelection();
    });

    const variantsText = !vs.length ? null
      : isSimpleProduct(vs) ? "Producto simple"
      : `${vs.filter((v) => v.is_active).length} de ${vs.length} activas`;
    const tracked = vs.filter((v) => v.is_active && v.track_stock);
    const stockSum = tracked.length ? tracked.reduce((s, v) => s + v.stock, 0) : null;

    const tr = h("tr", {
      class: ["row-link", multi ? "row-multi" : "", open ? "is-open" : "", !multi && vs.length && edits.has(vs[0].id) ? "row-dirty" : ""].filter(Boolean).join(" "),
      onClick: (e) => { if (e.target.closest(".qe-cell, button, input, a")) return; location.hash = href; },
    });

    const toggle = multi
      ? h("button", { type: "button", class: "btn-ghost btn-xs qe-toggle", "aria-expanded": String(open),
          onClick: (e) => { e.stopPropagation(); open ? expanded.delete(product.id) : expanded.add(product.id); render(); } },
          open ? "Cerrar" : `Editar ${vs.length}`, dirtyVariants ? h("span", { class: "qe-dot", title: "Con cambios sin guardar" }, ` · ${dirtyVariants}`) : null)
      : null;

    const metaLine = h("td", { class: "c-meta-line", "aria-hidden": "true" },
      [skuOf(product) ? `SKU ${skuOf(product)}` : null, categoryName.get(product.category_id), variantsText ?? "Sin precio"]
        .filter(Boolean).join(" · "));

    let cells;
    if (multi) {
      cells = [
        h("td", { class: "c-qe c-price c-summary", "data-label": "Precio" }, priceRange(product)),
        h("td", { class: "c-qe c-cost c-summary", "data-label": "Costo" }, toggle),
        h("td", { class: "c-qe c-stock c-summary num", "data-label": "Stock" }, stockSum == null ? "—" : String(stockSum)),
      ];
    } else if (vs.length === 1) {
      cells = editCells(vs[0], tr);
    } else {
      cells = [h("td", { class: "c-qe c-price" }, "—"), h("td", { class: "c-qe c-cost" }, "—"), h("td", { class: "c-qe c-stock" }, "—")];
    }

    tr.append(
      h("td", { class: "center c-check", onClick: (e) => { if (e.target === e.currentTarget) { e.stopPropagation(); check.click(); } } }, check),
      h("td", { class: "c-name" }, h("a", { href }, product.name)),
      h("td", { class: "c-meta", "data-label": "SKU" }, skuOf(product) ?? h("span", { class: "muted" }, "—")),
      h("td", { class: "c-meta", "data-label": "Categoría" }, categoryName.get(product.category_id) ?? "—"),
      h("td", { class: "c-meta", "data-label": "Variantes" }, variantsText ?? h("span", { class: "badge badge-warn" }, "Sin precio")),
      ...cells,
      metaLine,
    );

    const rows = [tr];
    if (open) {
      for (const v of vs) {
        const sub = h("tr", { class: ["row-variant", v.is_active ? "" : "row-inactive"].filter(Boolean).join(" ") });
        sub.append(
          h("td", { class: "c-check" }),
          h("td", { class: "c-name c-vname", colspan: "4" },
            h("span", { class: "variant-mark", "aria-hidden": "true" }, "↳ "), variantLabel(v),
            v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
          ...editCells(v, sub, () => {
            const n = vs.filter((x) => edits.has(x.id)).length;
            const dot = toggle?.querySelector(".qe-dot");
            if (dot) dot.textContent = n ? ` · ${n}` : "";
            else if (n && toggle) toggle.append(h("span", { class: "qe-dot", title: "Con cambios sin guardar" }, ` · ${n}`));
          }),
        );
        rows.push(sub);
      }
    }
    return rows;
  }

  function syncSelection() {
    const visibleSelected = visible.filter((p) => selected.has(p.id)).length;
    selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
    selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
    renderBulkBar();
  }

  function matches(p, q, category) {
    return (!q || normalizeText(`${p.name} ${skuOf(p) ?? ""} ${p.brand ?? ""}`).includes(q))
      && (!category || String(p.category_id) === category);
  }

  function renderGroups() {
    const published = products.filter((p) => p.is_active).length;
    const drafts = products.length - published;
    const button = (value, label, n) => h("button", {
      type: "button", class: group === value ? "active" : "", "aria-pressed": String(group === value),
      onClick: () => { if (group === value) return; group = value; selected.clear(); render(); },
    }, label, h("span", { class: "seg-count" }, String(n)));
    mount(groupBox, button("active", "Publicados", published), button("draft", "Borradores", drafts));
  }

  function render() {
    const q = normalizeText(search.value.trim());
    const category = categoryFilter.value;
    const wantActive = group === "active";

    visible = products.filter((p) => p.is_active === wantActive && matches(p, q, category));
    const otherGroup = products.filter((p) => p.is_active !== wantActive && matches(p, q, category)).length;

    // Lo que queda fuera de los filtros deja de estar seleccionado:
    // así nunca se actúa sobre productos que no se ven.
    const visibleIds = new Set(visible.map((p) => p.id));
    [...selected].forEach((id) => { if (!visibleIds.has(id)) selected.delete(id); });

    renderGroups();
    if (visible.length) {
      mount(tbody, ...visible.flatMap(productRows));
    } else {
      const message = !products.length
        ? "Todavía no hay productos. Creá el primero con “Nuevo producto”."
        : (q || category) ? `No hay ${wantActive ? "publicados" : "borradores"} que coincidan con la búsqueda.`
        : wantActive ? "No hay productos publicados." : "No hay borradores.";
      mount(tbody, h("tr", {}, h("td", { colspan: "8", class: "empty" }, message)));
    }

    const total = products.filter((p) => p.is_active === wantActive).length;
    const otherName = wantActive ? "Borradores" : "Publicados";
    mount(count,
      `${visible.length} de ${plural(total, wantActive ? "publicado" : "borrador", wantActive ? "publicados" : "borradores")}`,
      (q || category) && otherGroup
        ? [" · ", h("button", { type: "button", class: "link-btn", onClick: () => { group = wantActive ? "draft" : "active"; selected.clear(); render(); } },
            `${plural(otherGroup, "coincidencia", "coincidencias")} en ${otherName}`)]
        : null);
    syncSelection();
  }

  // ---------- Revisión y guardado ----------
  function collect() {
    const changes = [], problems = [];
    for (const [vid, e] of edits) {
      const v = variantById.get(vid);
      const p = v && productById.get(v.product_id);
      if (!p) continue;
      const label = variantsOf(p).length > 1 ? `${p.name} · ${variantLabel(v)}` : p.name;
      const c = { v, p, label };
      if ("cost" in e) {
        const n = qe.parseMoney(e.cost);
        if (n == null) problems.push(`${label}: el costo quedó vacío. Para quitarlo, hacelo desde la ficha.`);
        else if (Number.isNaN(n) || n < 0) problems.push(`${label}: el costo debe ser un número mayor o igual a 0.`);
        else if (!qe.sameMoney(n, origCost(p, v))) c.cost = { from: origCost(p, v), to: n, target: costTarget(p, v) };
      }
      if ("price" in e) {
        const n = qe.parseMoney(e.price);
        if (n == null || Number.isNaN(n) || n <= 0) problems.push(`${label}: el precio debe ser un número mayor a 0.`);
        else if (!qe.sameMoney(n, origPrice(p, v))) c.price = { from: origPrice(p, v), to: n, target: priceTarget(p, v), auto: isAutoPrice(p, e) };
      }
      if ("stock" in e) {
        const n = qe.parseCount(e.stock);
        if (n == null || Number.isNaN(n)) problems.push(`${label}: el stock debe ser un número entero mayor o igual a 0.`);
        else if (Math.abs(n - v.stock) > MAX_STOCK_STEP) problems.push(`${label}: el cambio de stock no puede superar ${MAX_STOCK_STEP} unidades de una vez.`);
        else if (n !== v.stock) c.stock = { from: v.stock, to: n, reserved: commitments.get(v.id) ?? 0 };
      }
      if (c.cost || c.price || c.stock) changes.push(c);
    }
    changes.sort((a, b) => a.p.name.localeCompare(b.p.name, "es") || a.v.sort_order - b.v.sort_order);
    return { changes, problems };
  }

  function renderSaveBar(review = false) {
    if (!edits.size) { saveBar.hidden = true; mount(saveBar); return; }
    saveBar.hidden = false;
    const discard = h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => { edits.clear(); shortageAck.clear(); render(); renderSaveBar(); } }, "Descartar cambios");

    if (!review) {
      mount(saveBar, h("div", { class: "actions" },
        h("span", {}, edits.size === 1 ? "1 variante con cambios sin guardar" : `${edits.size} variantes con cambios sin guardar`),
        h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving, onClick: () => renderSaveBar(true) }, "Revisar y guardar"),
        discard));
      return;
    }

    const { changes, problems } = collect();
    const money = (n) => (n == null ? "sin costo" : formatPrice(n));
    const ackBoxes = new Map();      // variante → checkbox de reservas

    const items = changes.map((c) => {
      const bits = [];
      if (c.cost) bits.push(`costo ${money(c.cost.from)} → ${money(c.cost.to)}`);
      if (c.price) bits.push(`precio ${formatPrice(c.price.from)} → ${formatPrice(c.price.to)}${c.price.auto ? " (costo + 20 %, redondeado a $50)" : ""}`);
      if (c.stock) bits.push(`stock ${c.stock.from} → ${c.stock.to} (${c.stock.to > c.stock.from ? `entrada +${c.stock.to - c.stock.from}` : `salida ${c.stock.to - c.stock.from}`})`);
      const extra = [];
      if (c.price && c.price.from > 0 && (c.price.to > c.price.from * 3 || c.price.to < c.price.from / 3)) {
        extra.push(h("p", { class: "qe-review-warn" }, "Revisá el precio: cambia mucho respecto del actual."));
      }
      if (c.stock && c.stock.to < c.stock.from && c.stock.to < c.stock.reserved) {
        const box = h("input", { type: "checkbox", checked: shortageAck.has(c.v.id) });
        ackBoxes.set(c.v.id, box);
        extra.push(h("label", { class: "qe-review-opt" }, box,
          ` Hay ${c.stock.reserved} reservadas en pedidos web y quedarían ${c.stock.to}: confirmo el stock físico real (se registra un faltante para resolver en Stock).`));
      }
      return h("li", {}, h("strong", {}, c.label), `: ${bits.join(" · ")}`, extra.length ? h("div", { class: "qe-review-extra" }, extra) : null);
    });

    const confirm = h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving || problems.length > 0 || !changes.length },
      saving ? "Guardando…" : "Confirmar y guardar");
    confirm.addEventListener("click", () => {
      for (const [vid, box] of ackBoxes) box.checked ? shortageAck.add(vid) : shortageAck.delete(vid);
      const missingAck = changes.filter((c) => ackBoxes.has(c.v.id) && !shortageAck.has(c.v.id));
      if (missingAck.length) {
        toast(`Confirmá el stock de ${missingAck.map((c) => c.label).join(", ")} o corregilo.`, "error");
        return;
      }
      save(changes);
    });

    mount(saveBar, h("div", { class: "bulk-confirm" },
      h("p", {}, changes.length ? `Vas a guardar ${plural(changes.length, "variante", "variantes")}:` : "No hay cambios para guardar."),
      problems.length ? h("div", { class: "form-error" }, h("p", {}, "Corregí estos valores antes de guardar:"), h("ul", {}, problems.map((t) => h("li", {}, t)))) : null,
      h("ul", { class: "change-list" }, items),
      changes.some((c) => c.stock)
        ? h("p", { class: "hint" }, `Cada cambio de stock se registra como un movimiento de inventario («${qe.QUICK_REASON}»).`)
        : null,
      h("div", { class: "actions" }, confirm,
        h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => renderSaveBar(false) }, "Volver a editar"),
        discard)));
    saveBar.scrollIntoView?.({ block: "nearest" });
  }

  function stockKey(c) {
    const k = `${c.v.id}:${c.stock.from}:${c.stock.to}`;
    if (!stockKeys.has(k)) stockKeys.set(k, { key: newKey(), tried: false });
    return stockKeys.get(k);
  }

  async function save(changes) {
    if (saving) return;
    saving = true;
    renderSaveBar(true);
    const failed = [];   // { vid, text, network }

    for (const c of changes) {
      const e = { ...(edits.get(c.v.id) ?? {}) };
      const errs = [];
      let network = false;
      const fail = (what, err, key) => {
        if (qe.isNetworkError(err)) network = true;
        else if (err?.code !== "CHANGED") console.error(err);
        // Cambio ajeno: se descarta lo escrito y se muestra el valor nuevo.
        if (err?.code === "CHANGED" && key) delete e[key];
        errs.push(`${what}: ${qe.isNetworkError(err) ? "sin conexión, no se guardó" : err?.code === "CHANGED" ? err.message : errorMessage(err)}`);
      };
      // 1) Costo (si falla, el precio calculado desde él tampoco se guarda).
      let costOk = true;
      if (c.cost) {
        try {
          await (c.cost.target === "base" ? qe.setBaseCost(c.p.id, c.cost.from, c.cost.to) : qe.setVariantCost(c.v.id, c.cost.from, c.cost.to));
          delete e.cost;
        } catch (err) {
          costOk = false;
          fail("costo", err, "cost");
          // Si otro cambió el costo, el precio calculado ya no corresponde.
          if (c.price?.auto && !("cost" in e)) delete e.price;
        }
      }
      // 2) Precio.
      if (c.price && (costOk || !c.price.auto)) {
        try {
          await (c.price.target === "base" ? qe.setBasePrice(c.p.id, c.price.from, c.price.to) : qe.setVariantPrice(c.v.id, c.price.from, c.price.to));
          delete e.price; delete e.priceManual;
        } catch (err) { fail("precio", err, "price"); }
      }
      // 3) Stock: un movimiento por la diferencia, con clave para no duplicar.
      if (c.stock) {
        const k = stockKey(c);
        try {
          await qe.setStock({ variantId: c.v.id, from: c.stock.from, to: c.stock.to, key: k.key, retry: k.tried, confirmShortage: shortageAck.has(c.v.id) });
          stockKeys.delete(`${c.v.id}:${c.stock.from}:${c.stock.to}`);
          shortageAck.delete(c.v.id);
          delete e.stock;
        } catch (err) {
          k.tried = true;
          if (planFromError(err)) errs.push(`stock: ${err.hint === "shortage_confirmation" ? "no cubre lo reservado en pedidos web; revisalo y confirmalo en la revisión" : "la baja supera lo disponible"}`);
          else fail("stock", err, "stock");
        }
      }
      if (["price", "cost", "stock"].some((key) => key in e)) edits.set(c.v.id, e);
      else edits.delete(c.v.id);
      if (errs.length) failed.push({ vid: c.v.id, text: `${c.label}: ${errs.join(" · ")}`, network });
    }

    let reloaded = false;
    try {
      await load();
      index();
      // Lo pendiente que ya coincide con la base (otra pestaña) deja de estar marcado.
      for (const [vid, e] of [...edits]) {
        const v = variantById.get(vid);
        const p = v && productById.get(v.product_id);
        if (!p) { edits.delete(vid); continue; }
        if ("price" in e && qe.sameMoney(qe.parseMoney(e.price), origPrice(p, v))) { delete e.price; delete e.priceManual; }
        if ("cost" in e && qe.sameMoney(qe.parseMoney(e.cost), origCost(p, v))) delete e.cost;
        if ("stock" in e && qe.parseCount(e.stock) === v.stock) delete e.stock;
        if (!["price", "cost", "stock"].some((key) => key in e)) edits.delete(vid);
      }
      reloaded = true;
    } catch (err) {
      if (!qe.isNetworkError(err)) console.error(err);
      failed.push({ vid: null, text: `No se pudo recargar la tabla: ${errorMessage(err)}. Recargá la página cuando vuelva la conexión.`, network: true });
    }
    // Un corte después de que la base guardó: al recargar, el valor ya está. No es un error.
    const still = failed.filter((f) => !reloaded || !f.network || f.vid == null || edits.has(f.vid));
    const ok = changes.length - still.filter((f) => f.vid != null).length;
    lastErrors = still.map((f) => f.text);
    if (still.some((f) => f.network && f.vid != null)) lastErrors.unshift("Se cortó la conexión: lo que no se guardó quedó como cambio pendiente. Cuando vuelva, tocá «Revisar y guardar» otra vez (no se duplica nada).");
    const failedCount = changes.length - ok;
    saving = false;
    toast(failedCount ? `Se guardaron ${ok} de ${changes.length}. Revisá los avisos.` : ok === 1 ? "1 variante guardada." : `${ok} variantes guardadas.`, failedCount ? "error" : "ok");
    renderNotice();
    render();
    renderSaveBar(false);
  }

  function renderNotice() {
    mount(notice, lastErrors.length
      ? h("div", { class: "form-error" }, h("p", {}, "No se guardó todo:"), h("ul", {}, lastErrors.map((t) => h("li", {}, t))))
      : null);
  }

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  const beforeUnload = (e) => { if (edits.size && view.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const cleanup = () => { if (!view.isConnected) { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("hashchange", cleanup); } };
  window.addEventListener("hashchange", cleanup);

  // Filtros iniciales que llegan en el enlace.
  const fromSlug = categories.find((c) => c.slug === query.categoria);
  if (fromSlug) categoryFilter.value = String(fromSlug.id);
  if (query.q) search.value = query.q;

  search.addEventListener("input", render);
  categoryFilter.addEventListener("change", render);

  mount(view,
    h("div", { class: "page-header" },
      h("h2", {}, "Productos"),
      h("div", { class: "actions header-actions" },
        h("a", { href: "#/productos/nueva-yerba", class: "btn-ghost btn-inline" }, "Yerba o presentación"),
        h("a", { href: "#/productos/nuevo", class: "btn-primary btn-inline" }, "Nuevo producto"))
    ),
    groupBox,
    h("div", { class: "toolbar" }, search, categoryFilter),
    count,
    notice,
    bulkBar,
    saveBar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-cards table-products table-qe" },
        h("thead", {}, h("tr", {},
          h("th", { class: "center" }, selectAll),
          ["Producto", "SKU", "Categoría", "Variantes", "Precio", "Costo", "Stock"].map((t) => h("th", {}, t))
        )),
        tbody
      )
    )
  );

  render();
}
