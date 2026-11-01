// Inventario · Precios: SKU, precio de venta y costo GENERALES de cada producto,
// y debajo sus variantes (precio y costo general o particular, control de stock
// y entradas de stock). Todo se edita en la tabla y se guarda junto, después de
// revisar.
import * as api from "../api/catalog.js";
import { registerMovement } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

const DEFAULT_REASON = "Ingreso de mercadería";
// Regla actual: solo las yerbas controlan stock.
const STOCK_CATEGORY = "yerbas";

const round2 = (n) => Math.round(n * 100) / 100;

// Valor de un input numérico: "" → null, inválido → NaN.
function readNumber(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : NaN;
}

function margin(price, cost) {
  if (cost == null || price == null || Number.isNaN(cost) || Number.isNaN(price) || price <= 0) return "—";
  return `${Math.round(((price - cost) / price) * 100)} %`;
}

const sameNumber = (a, b) => (a == null && b == null) || (a != null && b != null && round2(a) === round2(b));

export async function renderPriceTable(view, query = {}) {
  mount(view, h("p", { class: "muted" }, "Cargando precios…"));

  let products, categories, variants, internals;
  async function load() {
    [products, categories, variants, internals] = await Promise.all([
      api.listProducts(), api.listCategories(), api.listAllVariantsWithCosts(), api.listProductInternals(),
    ]);
    for (const p of products) p.base_price = p.base_price == null ? null : Number(p.base_price);
  }
  try {
    await load();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  // Ediciones pendientes (texto de los inputs):
  //   pEdits: productId → { sku?, price?, cost? }
  //   vEdits: variantId → { price?, cost?, track?, entry?, inheritPrice?, inheritCost? }
  const pEdits = new Map();
  const vEdits = new Map();
  let saving = false;
  let lastErrors = [];

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar producto, variante o SKU…", "aria-label": "Buscar" });
  const categoryFilter = h("select", { class: "input", "aria-label": "Categoría" });
  const showFilter = h("select", { class: "input", "aria-label": "Mostrar" },
    h("option", { value: "" }, "Todos los productos"),
    h("option", { value: "nosku" }, "Sin SKU"),
    h("option", { value: "nocost" }, "Con variantes sin costo"),
    h("option", { value: "particular" }, "Con precios particulares"),
    h("option", { value: "stock" }, "Que controlan stock"),
    h("option", { value: "changed" }, "Con cambios sin guardar"));
  if (query.f && [...showFilter.options].some((o) => o.value === query.f)) showFilter.value = query.f;
  const ruleButton = h("button", { type: "button", class: "btn-ghost", title: "Marca qué variantes controlan stock: solo las yerbas. No guarda nada." },
    "Solo yerbas controlan stock");
  const info = h("p", { class: "muted" });
  const notice = h("div");
  const tbody = h("tbody");
  const bar = h("div", { class: "save-bar", hidden: true });

  mount(categoryFilter,
    h("option", { value: "" }, "Todas las categorías"),
    categories.map((c) => h("option", { value: String(c.id) }, c.name)));

  // ---------- Índices ----------
  let idx;
  function index() {
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const variantsByProduct = new Map();
    for (const v of variants) {
      if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
      variantsByProduct.get(v.product_id).push(v);
    }
    for (const list of variantsByProduct.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const ordered = [...products].sort((a, b) =>
      (categoryById.get(a.category_id)?.sort_order ?? 0) - (categoryById.get(b.category_id)?.sort_order ?? 0)
      || a.sort_order - b.sort_order || a.name.localeCompare(b.name, "es"));
    const productById = new Map(products.map((p) => [p.id, p]));
    return { categoryById, variantsByProduct, ordered, productById };
  }
  idx = index();
  const variantsOf = (p) => idx.variantsByProduct.get(p.id) ?? [];
  const internal = (p) => internals.get(p.id) ?? { sku: null, base_cost: null };
  const isSimple = (p) => api.isSimpleProduct(variantsOf(p));

  // ---------- Valores actuales (original + edición) ----------
  function pCurrent(p) {
    const e = pEdits.get(p.id) ?? {};
    return {
      sku: "sku" in e ? api.normalizeSku(e.sku) : internal(p).sku,
      price: "price" in e ? readNumber(e.price) : p.base_price,
      cost: "cost" in e ? readNumber(e.cost) : internal(p).base_cost,
    };
  }
  function vCurrent(v) {
    const p = idx.productById.get(v.product_id);
    const pc = pCurrent(p);
    const e = vEdits.get(v.id) ?? {};
    // Precio: edición propia > vuelve al general > hereda (y el general pudo cambiar) > el suyo.
    let priceInherited = v.price_inherited, price = v.price;
    if ("price" in e) { price = readNumber(e.price); priceInherited = pc.price != null && sameNumber(price, pc.price); }
    else if (e.inheritPrice) { priceInherited = true; price = pc.price ?? v.price; }
    else if (v.price_inherited && pc.price != null) price = pc.price;
    let costInherited = v.cost_inherited, cost = v.cost;
    if ("cost" in e) { cost = readNumber(e.cost); costInherited = pc.cost != null && sameNumber(cost, pc.cost); }
    else if (e.inheritCost) { costInherited = true; cost = pc.cost ?? v.cost; }
    else if (v.cost_inherited && pc.cost != null) cost = pc.cost;
    return {
      price, cost, priceInherited, costInherited,
      track: "track" in e ? e.track === "true" : v.track_stock,
      entry: "entry" in e ? readNumber(e.entry) : null,
    };
  }

  function setEdit(map, id, key, value, original) {
    const e = { ...(map.get(id) ?? {}) };
    if (value === undefined || String(value).trim() === String(original ?? "")) delete e[key];
    else e[key] = value;
    if (Object.keys(e).length) map.set(id, e);
    else map.delete(id);
  }
  const dirtyCount = () => new Set([...pEdits.keys(), ...[...vEdits.keys()].map((id) => variants.find((v) => v.id === id)?.product_id)]).size;

  // ---------- Cambios a guardar ----------
  function collectChanges() {
    const changes = [];
    const problems = [];

    // SKU repetidos entre productos (con las ediciones).
    const owners = new Map();
    for (const p of products) {
      const sku = pCurrent(p).sku;
      if (sku == null) continue;
      if (!owners.has(sku)) owners.set(sku, []);
      owners.get(sku).push(p);
    }
    for (const [sku, list] of owners) {
      if (list.length > 1 && list.some((p) => "sku" in (pEdits.get(p.id) ?? {}))) {
        problems.push(`El SKU “${sku}” quedaría repetido en: ${list.map((p) => p.name).join(", ")}.`);
      }
    }

    for (const p of idx.ordered) {
      const pe = pEdits.get(p.id);
      const vs = variantsOf(p).filter((v) => vEdits.has(v.id));
      if (!pe && !vs.length) continue;
      const pc = pCurrent(p);
      const change = { p, product: {}, variants: [] };

      if (pe) {
        if ("sku" in pe) {
          if (pc.sku && pc.sku.length > 64) problems.push(`${p.name}: el SKU puede tener hasta 64 caracteres.`);
          else if (pc.sku !== internal(p).sku) change.product.sku = pc.sku;
        }
        if ("price" in pe) {
          if (Number.isNaN(pc.price) || (pc.price != null && pc.price <= 0)) problems.push(`${p.name}: el precio general debe ser mayor a 0 (o vacío).`);
          else if (isSimple(p) && pc.price == null) problems.push(`${p.name}: un producto simple necesita precio.`);
          else if (!sameNumber(pc.price, p.base_price)) change.product.base_price = pc.price;
        }
        if ("cost" in pe) {
          if (Number.isNaN(pc.cost) || (pc.cost != null && pc.cost < 0)) problems.push(`${p.name}: el costo general debe ser mayor o igual a 0 (o vacío).`);
          else if (!sameNumber(pc.cost, internal(p).base_cost)) change.product.base_cost = pc.cost;
        }
      }

      for (const v of vs) {
        const e = vEdits.get(v.id);
        const c = vCurrent(v);
        const label = `${p.name} · ${v.name}`;
        const vc = { v, label };
        if ("price" in e) {
          if (c.price == null || Number.isNaN(c.price) || c.price <= 0) problems.push(`${label}: el precio debe ser mayor a 0 (si no se vende, desactivala).`);
          else if (!sameNumber(c.price, v.price) || (v.price_inherited && !c.priceInherited)) {
            vc.price = c.price;
            // Heredaba y ahora tiene un precio propio (aunque sea el de antes): se marca
            // particular, así el general nuevo no lo pisa.
            if (v.price_inherited && !c.priceInherited) vc.priceParticular = true;
          }
        } else if (e.inheritPrice) vc.inheritPrice = true;
        if ("cost" in e) {
          if (Number.isNaN(c.cost) || (c.cost != null && c.cost < 0)) problems.push(`${label}: el costo debe ser mayor o igual a 0 (o vacío).`);
          else if (!sameNumber(c.cost, v.cost) || (v.cost_inherited && !c.costInherited && c.cost != null)) vc.cost = c.cost;
        } else if (e.inheritCost) vc.inheritCost = true;
        if ("track" in e && c.track !== v.track_stock) vc.track = c.track;
        if ("entry" in e && c.entry != null) {
          if (!c.track) problems.push(`${label}: no controla stock.`);
          else if (!Number.isInteger(c.entry) || c.entry <= 0) problems.push(`${label}: la entrada debe ser un número entero mayor a 0.`);
          else vc.entry = c.entry;
        }
        if (["price", "cost", "track", "entry", "inheritPrice", "inheritCost"].some((k) => k in vc)) change.variants.push(vc);
      }
      if (Object.keys(change.product).length || change.variants.length) changes.push(change);
    }
    return { changes, problems };
  }

  // ---------- Tabla ----------
  function visibleProducts() {
    const q = normalizeText(search.value.trim());
    const category = categoryFilter.value;
    const show = showFilter.value;
    return idx.ordered.filter((p) => {
      const vs = variantsOf(p);
      if (category && String(p.category_id) !== category) return false;
      if (q && !normalizeText(`${p.name} ${internal(p).sku ?? ""} ${vs.map((v) => v.name).join(" ")}`).includes(q)) return false;
      if (show === "nosku" && pCurrent(p).sku != null) return false;
      if (show === "nocost" && !vs.some((v) => v.cost == null)) return false;
      if (show === "particular" && !vs.some((v) => !v.price_inherited || !v.cost_inherited)) return false;
      if (show === "stock" && !vs.some((v) => vCurrent(v).track)) return false;
      if (show === "changed" && !pEdits.has(p.id) && !vs.some((v) => vEdits.has(v.id))) return false;
      return true;
    });
  }

  function chip(inherited, hasGeneral) {
    if (!hasGeneral) return null;
    return h("span", { class: inherited ? "chip chip-general" : "chip chip-own" }, inherited ? "General" : "Particular");
  }

  function numInput(value, label, placeholder = "") {
    return h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", inputmode: "decimal",
      value: value == null || Number.isNaN(value) ? "" : String(value), placeholder, "aria-label": label });
  }

  function productRows(p) {
    const e = pEdits.get(p.id) ?? {};
    const pc = pCurrent(p);
    const vs = variantsOf(p);
    const simple = isSimple(p);
    const single = simple ? vs[0] : null;
    const category = idx.categoryById.get(p.category_id)?.name ?? "—";

    const sku = h("input", { class: "input input-sku", maxlength: "64", placeholder: "Sin SKU", autocomplete: "off",
      value: "sku" in e ? e.sku : (internal(p).sku ?? ""), "aria-label": `SKU de ${p.name}` });
    const price = numInput("price" in e ? e.price : p.base_price, `Precio general de ${p.name}`, simple ? "" : "Sin general");
    const cost = numInput("cost" in e ? e.cost : internal(p).base_cost, `Costo general de ${p.name}`, "Sin costo");
    const marginCell = h("td", { class: "num muted c-margin", "data-label": "Margen" }, margin(pc.price, pc.cost));

    const dirty = pEdits.has(p.id) || vs.some((v) => vEdits.has(v.id));
    const rows = [];
    const head = h("tr", { class: ["row-product", dirty ? "row-dirty" : "", p.is_active ? "" : "row-inactive"].join(" ").trim() },
      h("td", { class: "c-name" },
        h("a", { href: `#/productos/${p.id}?tab=precios` }, p.name),
        h("span", { class: "row-sub" }, `${category}${p.is_active ? "" : " · borrador"}${simple ? "" : ` · ${vs.length} ${vs.length === 1 ? "variante" : "variantes"}`}`)),
      h("td", { class: "c-sku", "data-label": "SKU" }, sku),
      h("td", { class: "c-price", "data-label": simple ? "Precio" : "Precio general" }, price),
      h("td", { class: "c-cost", "data-label": simple ? "Costo" : "Costo general" }, cost),
      marginCell,
      ...(single ? variantTail(single) : [h("td", { class: "c-track" }), h("td", { class: "c-stock" }), h("td", { class: "c-entry" })]));
    rows.push(head);

    const onProductInput = (key, el, original) => {
      setEdit(pEdits, p.id, key, el.value, original);
      const now = pCurrent(p);
      marginCell.textContent = margin(now.price, now.cost);
      head.classList.toggle("row-dirty", pEdits.has(p.id) || vs.some((v) => vEdits.has(v.id)));
      // Las variantes que heredan muestran el general nuevo.
      if (!simple) refreshVariantRows(p);
      renderBar();
    };
    sku.addEventListener("input", () => onProductInput("sku", sku, internal(p).sku ?? ""));
    price.addEventListener("input", () => onProductInput("price", price, p.base_price ?? ""));
    cost.addEventListener("input", () => onProductInput("cost", cost, internal(p).base_cost ?? ""));

    // Variantes: todas si hay varias; la única solo si tiene precio o costo particular.
    const showVariants = simple
      ? vs.filter((v) => !v.price_inherited || !v.cost_inherited)
      : vs;
    const holders = showVariants.map((v) => {
      const holder = { tr: null };
      holder.tr = variantRow(p, v);
      return [v, holder];
    });
    rowHolders.set(p.id, holders);
    for (const [, holder] of holders) rows.push(holder.tr);
    return rows;
  }

  // Columnas de control de stock, stock y entrada de una variante.
  function variantTail(v) {
    const e = vEdits.get(v.id) ?? {};
    const c = vCurrent(v);
    const track = h("input", { type: "checkbox", checked: c.track, "aria-label": `Controla stock ${v.name}` });
    const entry = c.track
      ? h("input", { class: "input input-num input-sm", type: "number", min: "1", step: "1", placeholder: "+", inputmode: "numeric",
          value: e.entry ?? "", "aria-label": `Entrada de stock de ${v.name}` })
      : null;
    track.addEventListener("change", () => {
      setEdit(vEdits, v.id, "track", String(track.checked), String(v.track_stock));
      if (!track.checked) setEdit(vEdits, v.id, "entry", undefined);
      renderTable();
      renderBar();
    });
    entry?.addEventListener("input", () => {
      setEdit(vEdits, v.id, "entry", entry.value, "");
      entry.closest("tr")?.classList.toggle("row-dirty", vEdits.has(v.id));
      renderBar();
    });
    return [
      h("td", { class: "center c-track", "data-label": "Controla stock" }, track),
      h("td", { class: "num c-stock", "data-label": "Stock" }, c.track ? h("strong", { class: v.stock === 0 ? "text-alert" : "" }, String(v.stock)) : h("span", { class: "muted" }, "No controla")),
      h("td", { class: "c-entry", "data-label": "Entrada" }, entry ?? ""),
    ];
  }

  const rowHolders = new Map();   // productId → [[variant, { tr }]]
  function refreshVariantRows(p) {
    for (const [v, holder] of rowHolders.get(p.id) ?? []) {
      const fresh = variantRow(p, v);
      holder.tr.replaceWith(fresh);
      holder.tr = fresh;
    }
  }

  function variantRow(p, v) {
    const e = vEdits.get(v.id) ?? {};
    const c = vCurrent(v);
    const pc = pCurrent(p);
    const hasPrice = pc.price != null && !Number.isNaN(pc.price);
    const hasCost = pc.cost != null && !Number.isNaN(pc.cost);

    const price = numInput("price" in e ? e.price : c.price, `Precio de ${p.name} ${v.name}`);
    const cost = numInput("cost" in e ? e.cost : c.cost, `Costo de ${p.name} ${v.name}`, "Sin costo");
    const priceChip = h("span", { class: "chip-slot" }, chip(c.priceInherited, hasPrice));
    const costChip = h("span", { class: "chip-slot" }, chip(c.costInherited, hasCost));
    const usePrice = hasPrice && !c.priceInherited ? h("button", { type: "button", class: "link-btn" }, "Usar general") : null;
    const useCost = hasCost && !c.costInherited ? h("button", { type: "button", class: "link-btn" }, "Usar general") : null;
    const marginCell = h("td", { class: "num muted c-margin", "data-label": "Margen" }, margin(c.price, c.cost));

    const tr = h("tr", { class: ["row-variant", vEdits.has(v.id) ? "row-dirty" : "", v.is_active ? "" : "row-inactive"].join(" ").trim() },
      h("td", { class: "c-name" }, h("span", { class: "variant-mark", "aria-hidden": "true" }, "↳ "),
        v.name === api.SINGLE_VARIANT_NAME ? "Modelo único" : v.name, v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
      h("td", { class: "c-sku" }),
      h("td", { class: "c-price", "data-label": "Precio" }, h("div", { class: "cell-stack" }, price, h("span", { class: "cell-meta" }, priceChip, usePrice))),
      h("td", { class: "c-cost", "data-label": "Costo" }, h("div", { class: "cell-stack" }, cost, h("span", { class: "cell-meta" }, costChip, useCost))),
      marginCell,
      ...(isSimple(p) ? [h("td", { class: "c-track" }), h("td", { class: "c-stock" }), h("td", { class: "c-entry" })] : variantTail(v)));

    function after() {
      const now = vCurrent(v);
      marginCell.textContent = margin(now.price, now.cost);
      mount(priceChip, chip(now.priceInherited, hasPrice));
      mount(costChip, chip(now.costInherited, hasCost));
      tr.classList.toggle("row-dirty", vEdits.has(v.id));
      renderBar();
    }
    // Valor que se ve sin editar la variante (el general si lo hereda).
    const shownPrice = () => { const g = pCurrent(p).price; return v.price_inherited && g != null && !Number.isNaN(g) ? g : v.price; };
    const shownCost = () => { const g = pCurrent(p).cost; return v.cost_inherited && g != null && !Number.isNaN(g) ? g : (v.cost ?? ""); };
    price.addEventListener("input", () => {
      setEdit(vEdits, v.id, "inheritPrice", undefined);
      setEdit(vEdits, v.id, "price", price.value, shownPrice());
      after();
    });
    cost.addEventListener("input", () => {
      setEdit(vEdits, v.id, "inheritCost", undefined);
      setEdit(vEdits, v.id, "cost", cost.value, shownCost());
      after();
    });
    usePrice?.addEventListener("click", () => {
      setEdit(vEdits, v.id, "price", undefined);
      setEdit(vEdits, v.id, "inheritPrice", v.price_inherited ? undefined : true);
      refreshVariantRows(p);
      renderBar();
    });
    useCost?.addEventListener("click", () => {
      setEdit(vEdits, v.id, "cost", undefined);
      setEdit(vEdits, v.id, "inheritCost", v.cost_inherited ? undefined : true);
      refreshVariantRows(p);
      renderBar();
    });
    return tr;
  }

  function renderTable() {
    const list = visibleProducts();
    rowHolders.clear();
    mount(tbody, list.length
      ? list.flatMap(productRows)
      : h("tr", {}, h("td", { colspan: "8", class: "empty" }, "No hay productos que coincidan con los filtros.")));
    const noSku = products.filter((p) => !internal(p).sku).length;
    const particular = variants.filter((v) => !v.price_inherited).length;
    info.textContent = `${list.length} de ${products.length} productos · ${noSku} sin SKU · ${variants.length} variantes · ${particular} con precio particular`;
  }

  // ---------- Barra de guardado ----------
  function renderBar(review = false) {
    if (!pEdits.size && !vEdits.size) { bar.hidden = true; mount(bar); return; }
    bar.hidden = false;
    const n = dirtyCount();
    const discard = h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => { pEdits.clear(); vEdits.clear(); renderTable(); renderBar(); } }, "Descartar cambios");

    if (!review) {
      mount(bar, h("div", { class: "actions" },
        h("span", {}, n === 1 ? "1 producto con cambios" : `${n} productos con cambios`),
        h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving, onClick: () => renderBar(true) }, "Revisar y guardar"),
        discard));
      return;
    }

    const { changes, problems } = collectChanges();
    const entries = changes.flatMap((c) => c.variants).filter((vc) => "entry" in vc);
    const reason = h("input", { class: "input", maxlength: "200", value: DEFAULT_REASON, "aria-label": "Motivo de las entradas" });
    const confirm = h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving || problems.length > 0 || !changes.length }, "Confirmar y guardar");
    confirm.addEventListener("click", () => save(changes, reason.value.trim() || DEFAULT_REASON));

    const money = (v) => (v == null ? "sin valor" : formatPrice(v));
    const lines = changes.map(({ p, product, variants: vcs }) => {
      const parts = [];
      if ("sku" in product) parts.push(`SKU ${internal(p).sku ?? "sin SKU"} → ${product.sku ?? "sin SKU"}`);
      if ("base_price" in product) {
        const inheriting = variantsOf(p).filter((v) => v.price_inherited).length;
        parts.push(`precio general ${money(p.base_price)} → ${money(product.base_price)}${product.base_price != null && inheriting ? ` (se aplica a ${inheriting} ${inheriting === 1 ? "variante" : "variantes"})` : ""}`);
      }
      if ("base_cost" in product) {
        const inheriting = variantsOf(p).filter((v) => v.cost_inherited).length;
        parts.push(`costo general ${money(internal(p).base_cost)} → ${money(product.base_cost)}${product.base_cost != null && inheriting ? ` (se aplica a ${inheriting})` : ""}`);
      }
      const sub = vcs.map((vc) => {
        const bits = [];
        if ("price" in vc) bits.push(`precio ${formatPrice(vc.v.price)} → ${formatPrice(vc.price)}`);
        if (vc.inheritPrice) bits.push("vuelve al precio general");
        if ("cost" in vc) bits.push(`costo ${money(vc.v.cost)} → ${money(vc.cost)}`);
        if (vc.inheritCost) bits.push("vuelve al costo general");
        if ("track" in vc) bits.push(vc.track ? "pasa a controlar stock" : "deja de controlar stock");
        if ("entry" in vc) bits.push(`entrada +${vc.entry} (stock ${vc.v.stock} → ${vc.v.stock + vc.entry})`);
        return h("li", {}, `${vc.v.name === api.SINGLE_VARIANT_NAME ? "Modelo único" : vc.v.name}: ${bits.join(" · ")}`);
      });
      return h("li", {}, h("strong", {}, p.name), parts.length ? `: ${parts.join(" · ")}` : "", sub.length ? h("ul", { class: "change-list" }, sub) : null);
    });

    mount(bar,
      h("div", { class: "bulk-confirm" },
        h("p", {}, changes.length
          ? `Vas a guardar cambios en ${changes.length === 1 ? "1 producto" : `${changes.length} productos`}:`
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
          discard)));
    bar.scrollIntoView?.({ block: "nearest" });
  }

  async function save(changes, reason) {
    saving = true;
    renderBar(true);
    const failed = [];
    let ok = 0;

    // Si un SKU pasa de un producto a otro, primero se liberan los SKU que se reasignan.
    const wanted = new Set(changes.filter((c) => c.product.sku != null).map((c) => c.product.sku));
    for (const c of changes) {
      const old = internal(c.p).sku;
      if ("sku" in c.product && old != null && wanted.has(old)) {
        try { await api.saveProductPricing(c.p.id, { sku: null }); } catch (err) { console.error(err); }
      }
    }

    for (const c of changes) {
      const errs = [];
      // 1) Producto: SKU y valores generales (la base los copia a las que heredan).
      if (Object.keys(c.product).length) {
        try { await api.saveProductPricing(c.p.id, c.product); }
        catch (err) { console.error(err); errs.push(`datos generales: ${errorMessage(err)}`); }
      }
      // 2) Variantes.
      for (const vc of c.variants) {
        const name = vc.v.name === api.SINGLE_VARIANT_NAME ? "modelo único" : vc.v.name;
        const fields = {};
        if ("price" in vc) fields.price = vc.price;
        if ("track" in vc) fields.track_stock = vc.track;
        if (vc.inheritPrice) fields.price_inherited = true;
        if (vc.priceParticular) fields.price_inherited = false;
        if (vc.inheritCost) fields.cost_inherited = true;
        let variantFailed = false;
        if (Object.keys(fields).length) {
          try { await api.updateVariant(vc.v.id, fields); }
          catch (err) { console.error(err); variantFailed = true; errs.push(`${name}: ${errorMessage(err)}`); }
        }
        if ("cost" in vc) {
          try { await api.saveVariantCost(vc.v.id, vc.cost); }
          catch (err) { console.error(err); errs.push(`${name}, costo: ${errorMessage(err)}`); }
        }
        if ("entry" in vc && !(variantFailed && "track" in vc)) {
          try { await registerMovement({ variantId: vc.v.id, type: "entrada", quantity: vc.entry, reason }); }
          catch (err) { console.error(err); errs.push(`${name}, entrada: ${errorMessage(err)}`); }
        }
      }
      if (errs.length) failed.push({ c, errs });
      else ok++;
    }

    // Se recarga todo desde la base. Lo que falló queda como edición pendiente.
    const keepP = new Map(), keepV = new Map();
    for (const { c } of failed) {
      if (pEdits.has(c.p.id)) keepP.set(c.p.id, pEdits.get(c.p.id));
      for (const vc of c.variants) if (vEdits.has(vc.v.id)) keepV.set(vc.v.id, vEdits.get(vc.v.id));
    }
    pEdits.clear(); vEdits.clear();
    keepP.forEach((e, id) => pEdits.set(id, e));
    keepV.forEach((e, id) => vEdits.set(id, e));
    lastErrors = failed.map(({ c, errs }) => `${c.p.name}: ${errs.join(" · ")}`);

    try {
      await load();
      idx = index();
    } catch (err) {
      console.error(err);
      lastErrors.push(`No se pudo recargar la tabla: ${errorMessage(err)}. Recargá la página.`);
    }
    saving = false;

    if (!pEdits.size && !vEdits.size && showFilter.value === "changed") showFilter.value = "";
    if (failed.length) toast(`Se guardaron ${ok} de ${changes.length}. Revisá los errores arriba.`, "error");
    else toast(ok === 1 ? "1 producto guardado." : `${ok} productos guardados.`);
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

  // ---------- Regla: solo las yerbas controlan stock ----------
  ruleButton.addEventListener("click", () => {
    let on = 0, off = 0;
    const withStock = [];
    for (const v of variants) {
      const p = idx.productById.get(v.product_id);
      const want = idx.categoryById.get(p?.category_id)?.slug === STOCK_CATEGORY;
      if (vCurrent(v).track === want) continue;
      setEdit(vEdits, v.id, "track", String(want), String(v.track_stock));
      if (!want) { setEdit(vEdits, v.id, "entry", undefined); off++; if (v.stock > 0) withStock.push(`${p?.name} · ${v.name} (${v.stock})`); }
      else on++;
    }
    renderNotice(h("div", { class: "notice-info" },
      h("p", {}, on || off
        ? `Regla aplicada en la tabla: ${off} ${off === 1 ? "variante deja" : "variantes dejan"} de controlar stock${on ? ` y ${on} de yerba ${on === 1 ? "pasa" : "pasan"} a controlarlo` : ""}. Todavía no se guardó nada: revisá y confirmá.`
        : "Ya se cumple la regla: solo las yerbas controlan stock."),
      withStock.length ? h("p", {}, `Tienen stock registrado (queda guardado, pero la tienda deja de mostrarlo): ${withStock.join(", ")}.`) : null));
    if (on || off) showFilter.value = "changed";
    renderTable();
    renderBar();
  });

  // Aviso al cerrar o recargar la pestaña con cambios sin guardar.
  const beforeUnload = (e) => { if ((pEdits.size || vEdits.size) && view.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const cleanup = () => { if (!view.isConnected) { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("hashchange", cleanup); } };
  window.addEventListener("hashchange", cleanup);

  search.addEventListener("input", renderTable);
  categoryFilter.addEventListener("change", renderTable);
  showFilter.addEventListener("change", renderTable);

  mount(view,
    h("p", { class: "muted" },
      "SKU, precio y costo generales de cada producto; debajo, sus variantes. Las variantes usan el valor general salvo que tengan uno particular. ",
      "Nada se guarda hasta que revisás y confirmás."),
    h("div", { class: "toolbar" }, search, categoryFilter, showFilter, ruleButton),
    info,
    notice,
    bar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-edit table-cards table-prices" },
        h("thead", {}, h("tr", {},
          ["Producto", "SKU", "Precio", "Costo", "Margen", "Controla stock", "Stock", "Entrada"].map((t, i) =>
            h("th", { class: i === 4 || i === 6 ? "num" : i === 5 ? "center" : "" }, t)))),
        tbody)));
  renderTable();
}
