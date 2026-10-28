// Precios y stock: todas las variantes en una tabla para editar precio, costo y
// registrar entradas de stock, y guardar todo junto después de revisar.
import * as api from "../api/catalog.js";
import { normalizeSku } from "../api/catalog.js";
import { registerMovement } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

// Hoja WEB de yerbas (la misma que usa hoy la tienda). Solo se lee.
const SHEET_URL = "https://opensheet.elk.sh/1TFmZ1hbO5bXh5MGktpUzM7MJTZwyoknVLyVHRNBbwso/WEB";
const DEFAULT_REASON = "Carga inicial de stock";

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Valor de un input numérico: "" → null, inválido → NaN.
function readNumber(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

function margin(price, cost) {
  if (cost == null || !Number.isFinite(cost) || !Number.isFinite(price) || price <= 0) return "—";
  return `${Math.round(((price - cost) / price) * 100)} %`;
}

export async function renderPriceTable(view) {
  mount(view, h("p", { class: "muted" }, "Cargando variantes…"));

  let products, categories, variants;
  async function load() {
    [products, categories, variants] = await Promise.all([
      api.listProducts(), api.listCategories(), api.listAllVariantsWithCosts(),
    ]);
  }
  try {
    await load();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  // Ediciones pendientes por variante: { price?, cost?, entry? } como texto del input.
  const edits = new Map();
  let saving = false;
  let lastErrors = [];

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar producto o variante…", "aria-label": "Buscar" });
  const categoryFilter = h("select", { class: "input", "aria-label": "Categoría" });
  const showFilter = h("select", { class: "input", "aria-label": "Mostrar" },
    h("option", { value: "" }, "Todas las variantes"),
    h("option", { value: "stock" }, "Solo las que controlan stock"),
    h("option", { value: "nocost" }, "Sin costo cargado"),
    h("option", { value: "nosku" }, "Sin SKU"),
    h("option", { value: "changed" }, "Solo con cambios sin guardar")
  );
  const sheetButton = h("button", { type: "button", class: "btn-ghost", title: "Completa la columna Entrada con el stock de la hoja WEB. No guarda nada." },
    "Traer stock de la hoja WEB");
  const info = h("p", { class: "muted" });
  const notice = h("div");
  const tbody = h("tbody");
  const bar = h("div", { class: "save-bar", hidden: true });

  function fillCategories() {
    mount(categoryFilter,
      h("option", { value: "" }, "Todas las categorías"),
      categories.map((c) => h("option", { value: String(c.id) }, c.name)));
  }

  function index() {
    const productById = new Map(products.map((p) => [p.id, p]));
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));
    const categorySort = new Map(categories.map((c) => [c.id, c.sort_order]));

    // Orden de la tabla: categoría, orden del producto, nombre, orden de la variante.
    const key = (v) => {
      const p = productById.get(v.product_id);
      return [categorySort.get(p?.category_id) ?? 0, p?.sort_order ?? 0, p?.name ?? "", v.product_id, v.sort_order, v.id];
    };
    variants.sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
    return { productById, categoryName };
  }
  let idx = index();

  // ---------- Estado de una variante (original + edición) ----------
  function current(v) {
    const e = edits.get(v.id) ?? {};
    const price = "price" in e ? readNumber(e.price) : v.price;
    const cost = "cost" in e ? readNumber(e.cost) : v.cost;
    const entry = "entry" in e ? readNumber(e.entry) : null;
    const sku = "sku" in e ? normalizeSku(e.sku) : v.sku;
    return { price, cost, entry, sku };
  }

  function setEdit(v, key, value) {
    const e = { ...(edits.get(v.id) ?? {}) };
    const original = key === "price" ? String(v.price)
      : key === "cost" ? (v.cost == null ? "" : String(v.cost))
      : key === "sku" ? (v.sku ?? "")
      : "";
    if (String(value).trim() === original) delete e[key];
    else e[key] = value;
    if (Object.keys(e).length) edits.set(v.id, e);
    else edits.delete(v.id);
  }

  // Devuelve la lista de cambios válidos y los errores de validación.
  function collectChanges() {
    const changes = [];
    const problems = [];

    // SKU final de cada variante (con las ediciones), para detectar repetidos.
    const owners = new Map();
    for (const v of variants) {
      const sku = current(v).sku;
      if (sku == null) continue;
      if (!owners.has(sku)) owners.set(sku, []);
      owners.get(sku).push(v);
    }
    for (const [sku, list] of owners) {
      if (list.length > 1 && list.some((v) => "sku" in (edits.get(v.id) ?? {}))) {
        const names = list.map((v) => `${idx.productById.get(v.product_id)?.name ?? "Producto"} · ${v.name}`);
        problems.push(`El SKU “${sku}” quedaría repetido en: ${names.join(", ")}.`);
      }
    }

    for (const v of variants) {
      const e = edits.get(v.id);
      if (!e) continue;
      const p = idx.productById.get(v.product_id);
      const label = `${p?.name ?? "Producto"} · ${v.name}`;
      const c = current(v);
      const change = { v, label };

      if ("price" in e) {
        if (c.price == null || Number.isNaN(c.price) || c.price < 0) problems.push(`${label}: el precio debe ser un número mayor o igual a 0.`);
        else if (round2(c.price) !== v.price) change.price = round2(c.price);
      }
      if ("cost" in e) {
        if (Number.isNaN(c.cost) || (c.cost != null && c.cost < 0)) problems.push(`${label}: el costo debe ser un número mayor o igual a 0 (o vacío).`);
        else if ((c.cost == null ? null : round2(c.cost)) !== v.cost) change.cost = c.cost == null ? null : round2(c.cost);
      }
      if ("entry" in e && c.entry != null) {
        if (!v.track_stock) problems.push(`${label}: no controla stock.`);
        else if (!Number.isInteger(c.entry) || c.entry <= 0) problems.push(`${label}: la entrada debe ser un número entero mayor a 0.`);
        else change.entry = c.entry;
      }
      if ("sku" in e) {
        if (c.sku != null && c.sku.length > 64) problems.push(`${label}: el SKU puede tener hasta 64 caracteres.`);
        else if (c.sku !== (v.sku ?? null)) change.sku = c.sku;
      }
      if ("price" in change || "cost" in change || "entry" in change || "sku" in change) changes.push(change);
    }
    return { changes, problems };
  }

  // ---------- Tabla ----------
  function visibleVariants() {
    const query = normalizeText(search.value.trim());
    const category = categoryFilter.value;
    const show = showFilter.value;
    return variants.filter((v) => {
      const p = idx.productById.get(v.product_id);
      if (!p) return false;
      if (category && String(p.category_id) !== category) return false;
      if (query && !normalizeText(`${p.name} ${v.name} ${v.sku ?? ""}`).includes(query)) return false;
      if (show === "stock" && !v.track_stock) return false;
      if (show === "nocost" && v.cost != null) return false;
      if (show === "nosku" && v.sku != null) return false;
      if (show === "changed" && !edits.has(v.id)) return false;
      return true;
    });
  }

  function row(v, firstOfProduct) {
    const p = idx.productById.get(v.product_id);
    const e = edits.get(v.id) ?? {};
    const c = current(v);

    const sku = h("input", { class: "input input-sku", maxlength: "64", placeholder: "—",
      value: "sku" in e ? e.sku : (v.sku ?? ""), "aria-label": `SKU de ${p.name} ${v.name}` });
    const price = h("input", { class: "input input-num input-sm", type: "number", min: "0", step: "0.01",
      value: "price" in e ? e.price : String(v.price), "aria-label": `Precio de ${p.name} ${v.name}` });
    const cost = h("input", { class: "input input-num input-sm", type: "number", min: "0", step: "0.01", placeholder: "—",
      value: "cost" in e ? e.cost : (v.cost == null ? "" : String(v.cost)), "aria-label": `Costo de ${p.name} ${v.name}` });
    const marginCell = h("td", { class: "num muted" }, margin(c.price, c.cost));

    const entry = v.track_stock
      ? h("input", { class: "input input-num input-sm", type: "number", min: "1", step: "1", placeholder: "+",
          value: e.entry ?? "", "aria-label": `Entrada de stock de ${p.name} ${v.name}` })
      : null;

    const tr = h("tr", { class: [edits.has(v.id) ? "row-dirty" : "", v.is_active ? "" : "row-inactive"].join(" ").trim() },
      h("td", {}, firstOfProduct
        ? h("a", { href: `#/productos/${p.id}` }, p.name)
        : h("span", { class: "muted", "aria-hidden": "true" }, "↳")),
      h("td", {}, firstOfProduct ? (idx.categoryName.get(p.category_id) ?? "—") : ""),
      h("td", {}, v.name, v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
      h("td", {}, sku),
      h("td", {}, price),
      h("td", {}, cost),
      marginCell,
      h("td", { class: "num" }, v.track_stock ? String(v.stock) : h("span", { class: "muted" }, "No controla")),
      h("td", {}, entry ?? "")
    );

    function onInput(key, el) {
      setEdit(v, key, el.value);
      const now = current(v);
      marginCell.textContent = margin(now.price, now.cost);
      tr.classList.toggle("row-dirty", edits.has(v.id));
      renderBar();
    }
    price.addEventListener("input", () => onInput("price", price));
    cost.addEventListener("input", () => onInput("cost", cost));
    entry?.addEventListener("input", () => onInput("entry", entry));
    sku.addEventListener("input", () => onInput("sku", sku));
    return tr;
  }

  function renderTable() {
    const list = visibleVariants();
    if (!list.length) {
      mount(tbody, h("tr", {}, h("td", { colspan: "9", class: "empty" }, "No hay variantes que coincidan con los filtros.")));
    } else {
      let lastProduct = null;
      mount(tbody, list.map((v) => {
        const first = v.product_id !== lastProduct;
        lastProduct = v.product_id;
        return row(v, first);
      }));
    }
    const noCost = variants.filter((v) => v.cost == null).length;
    const noSku = variants.filter((v) => v.sku == null).length;
    info.textContent = `${list.length} de ${variants.length} variantes · ${noCost} sin costo · ${noSku} sin SKU · ${variants.filter((v) => v.track_stock).length} controlan stock`;
  }

  // ---------- Barra de guardado ----------
  function renderBar(review = false) {
    const { changes, problems } = collectChanges();
    if (!edits.size) { bar.hidden = true; mount(bar); return; }
    bar.hidden = false;

    const count = h("span", {}, edits.size === 1 ? "1 variante con cambios" : `${edits.size} variantes con cambios`);
    const discard = h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => { edits.clear(); renderTable(); renderBar(); } }, "Descartar cambios");

    if (!review) {
      const go = h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving, onClick: () => renderBar(true) }, "Revisar y guardar");
      mount(bar, h("div", { class: "actions" }, count, go, discard));
      return;
    }

    const entries = changes.filter((c) => "entry" in c);
    const reason = h("input", { class: "input", maxlength: "200", value: DEFAULT_REASON, "aria-label": "Motivo de las entradas" });
    const confirm = h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving || problems.length > 0 || !changes.length }, "Confirmar y guardar");
    confirm.addEventListener("click", () => save(changes, reason.value.trim() || DEFAULT_REASON));

    const lines = changes.map((c) => {
      const parts = [];
      if ("price" in c) parts.push(`precio ${formatPrice(c.v.price)} → ${formatPrice(c.price)}`);
      if ("cost" in c) parts.push(`costo ${c.v.cost == null ? "sin costo" : formatPrice(c.v.cost)} → ${c.cost == null ? "sin costo" : formatPrice(c.cost)}`);
      if ("sku" in c) parts.push(`SKU ${c.v.sku ?? "sin SKU"} → ${c.sku ?? "sin SKU"}`);
      if ("entry" in c) parts.push(`entrada +${c.entry} (stock ${c.v.stock} → ${c.v.stock + c.entry})`);
      const warn = "price" in c && c.price === 0 && c.v.is_active ? " ⚠ precio 0" : "";
      return h("li", {}, h("strong", {}, c.label), `: ${parts.join(" · ")}${warn}`);
    });

    mount(bar,
      h("div", { class: "bulk-confirm" },
        h("p", {}, changes.length
          ? `Vas a guardar cambios en ${changes.length === 1 ? "1 variante" : `${changes.length} variantes`}:`
          : "No hay cambios para guardar (los valores son iguales a los actuales)."),
        problems.length ? h("div", { class: "form-error" }, h("p", {}, "Corregí estos valores antes de guardar:"), h("ul", {}, problems.map((t) => h("li", {}, t)))) : null,
        h("ul", { class: "change-list" }, lines),
        entries.length
          ? h("label", { class: "field" },
              h("span", {}, `Motivo de las ${entries.length === 1 ? "entrada" : `${entries.length} entradas`} de stock`),
              reason,
              h("small", { class: "hint" }, "Queda registrado en cada movimiento de inventario."))
          : null,
        h("div", { class: "actions" },
          confirm,
          h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => renderBar(false) }, "Volver a editar"),
          discard)
      )
    );
    bar.scrollIntoView?.({ block: "nearest" });
  }

  async function save(changes, reason) {
    saving = true;
    renderBar(true);
    const failed = [];
    let ok = 0;

    // Si un SKU pasa de una variante a otra (por ejemplo, un intercambio), primero
    // se libera el SKU viejo para no chocar con la regla de SKU único.
    const wanted = new Set(changes.filter((c) => "sku" in c && c.sku != null).map((c) => c.sku));
    const released = new Set();
    for (const c of changes) {
      if ("sku" in c && c.v.sku != null && wanted.has(c.v.sku)) {
        try { await api.saveVariantSku(c.v.id, null); released.add(c.v.id); }
        catch (err) { console.error(err); }
      }
    }

    for (const c of changes) {
      const errs = [];
      if ("sku" in c) {
        try { await api.saveVariantSku(c.v.id, c.sku); }
        catch (err) {
          console.error(err);
          errs.push(`SKU: ${errorMessage(err)}${released.has(c.v.id) ? ` (quedó sin SKU; antes era “${c.v.sku}”)` : ""}`);
        }
      }
      if ("price" in c) {
        try { await api.updateVariant(c.v.id, { price: c.price }); }
        catch (err) { console.error(err); errs.push(`precio: ${errorMessage(err)}`); }
      }
      if ("cost" in c) {
        try { await api.saveVariantCost(c.v.id, c.cost); }
        catch (err) { console.error(err); errs.push(`costo: ${errorMessage(err)}`); }
      }
      if ("entry" in c) {
        try { await registerMovement({ variantId: c.v.id, type: "entrada", quantity: c.entry, reason }); }
        catch (err) { console.error(err); errs.push(`entrada: ${errorMessage(err)}`); }
      }
      if (errs.length) failed.push({ c, errs });
      else ok++;
    }

    // Se recarga todo desde la base. Lo que falló queda como edición pendiente.
    const keep = new Map(failed.map(({ c }) => [c.v.id, edits.get(c.v.id)]));
    edits.clear();
    keep.forEach((e, id) => { if (e) edits.set(id, e); });
    lastErrors = failed.map(({ c, errs }) => `${c.label}: ${errs.join(" · ")}`);

    try {
      await load();
      idx = index();
    } catch (err) {
      console.error(err);
      lastErrors.push(`No se pudo recargar la tabla: ${errorMessage(err)}. Recargá la página.`);
    }
    saving = false;

    if (!edits.size && showFilter.value === "changed") showFilter.value = "";
    if (failed.length) toast(`Se guardaron ${ok} de ${changes.length}. Revisá los errores arriba.`, "error");
    else toast(ok === 1 ? "1 variante guardada." : `${ok} variantes guardadas.`);
    renderNotice();
    renderTable();
    renderBar();
  }

  function renderNotice(extra = null) {
    mount(notice,
      lastErrors.length
        ? h("div", { class: "form-error" }, h("p", {}, "No se pudieron guardar:"), h("ul", {}, lastErrors.map((t) => h("li", {}, t))))
        : null,
      extra);
  }

  // ---------- Stock desde la hoja WEB ----------
  sheetButton.addEventListener("click", async () => {
    sheetButton.disabled = true;
    sheetButton.textContent = "Leyendo la hoja…";
    try {
      const res = await fetch(SHEET_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`La hoja respondió ${res.status}.`);
      const rows = await res.json();
      const stockById = new Map(rows.map((r) => [Number(r.ID), Number(String(r.Stock ?? "").trim() || 0)]));

      let filled = 0, same = 0, lower = 0, notFound = 0;
      for (const v of variants) {
        if (v.sheet_id == null || !v.track_stock) continue;
        if (!stockById.has(v.sheet_id)) { notFound++; continue; }
        const target = stockById.get(v.sheet_id);
        if (!Number.isInteger(target) || target < 0) { notFound++; continue; }
        const diff = target - v.stock;
        if (diff > 0) { setEdit(v, "entry", String(diff)); filled++; }
        else if (diff === 0) same++;
        else lower++;
      }

      renderNotice(h("div", { class: "notice-info" },
        h("p", {}, filled
          ? `Hoja WEB: se completó la entrada de ${filled} ${filled === 1 ? "presentación" : "presentaciones"} (stock de la hoja menos el stock actual). Todavía no se guardó nada: revisá y confirmá.`
          : "Hoja WEB leída: no hay entradas para cargar."),
        same ? h("p", {}, `${same} ya coinciden con la hoja.`) : null,
        lower ? h("p", {}, `${lower} tienen más stock que la hoja: no se tocan (si hace falta, usá un ajuste desde el producto).`) : null,
        notFound ? h("p", {}, `${notFound} no se encontraron en la hoja o tienen un stock no válido.`) : null
      ));
      if (filled) showFilter.value = "changed";
      renderTable();
      renderBar();
    } catch (err) {
      console.error(err);
      renderNotice(h("p", { class: "form-error" }, `No se pudo leer la hoja WEB: ${err?.message || err}`));
    } finally {
      sheetButton.disabled = false;
      sheetButton.textContent = "Traer stock de la hoja WEB";
    }
  });

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  const beforeUnload = (e) => { if (edits.size && view.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const cleanup = () => { if (!view.isConnected) { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("hashchange", cleanup); } };
  window.addEventListener("hashchange", cleanup);

  search.addEventListener("input", renderTable);
  categoryFilter.addEventListener("change", renderTable);
  showFilter.addEventListener("change", renderTable);

  fillCategories();
  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Precios y stock")),
    h("p", { class: "muted" }, "Editá SKU, precios, costos y entradas de stock de todas las variantes. Nada se guarda hasta que revisás y confirmás."),
    h("div", { class: "toolbar" }, search, categoryFilter, showFilter, sheetButton),
    info,
    notice,
    bar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-edit price-table" },
        h("thead", {}, h("tr", {},
          ["Producto", "Categoría", "Variante", "SKU", "Precio", "Costo", "Margen", "Stock", "Entrada"].map((t) => h("th", {}, t))
        )),
        tbody
      )
    )
  );
  renderTable();
}
