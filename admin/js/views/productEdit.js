// Ficha de producto, en pestañas: Datos · Precios y variantes · Imágenes · Stock.
//
// Precios: el producto tiene SKU, precio de venta y costo GENERALES. Cada variante
// usa el general (lo hereda) o tiene un valor particular. La base copia el general
// a las variantes que lo heredan (ver supabase/migrations/20261101000000_product_pricing.sql).
import * as api from "../api/catalog.js";
import { h, mount, field, showError, toast, errorMessage, slugify, SLUG_RE, formatPrice } from "../ui.js";
import { renderStockPanel } from "./stockPanel.js";
import { renderImagesPanel } from "./imagesPanel.js";
import { imageSource, removeProductFiles } from "../api/images.js";
import { icon } from "../icons.js";

const TABS = [
  ["datos", "Datos"],
  ["precios", "Precios"],
  ["imagenes", "Imágenes"],
  ["stock", "Stock"],
];

function backLink() {
  return h("a", { href: "#/productos", class: "back-link" }, "← Volver a productos");
}

function statusBadge(active) {
  return h("span", { class: active ? "badge badge-ok" : "badge" }, active ? "Publicado" : "Borrador");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Valor de un input numérico: "" → null, inválido → NaN.
function readNumber(text) {
  const t = String(text ?? "").trim().replace(",", ".");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : NaN;
}

function margin(price, cost) {
  if (price == null || cost == null || !(price > 0) || Number.isNaN(cost)) return null;
  return `${Math.round(((price - cost) / price) * 100)} %`;
}

// Etiqueta de origen de un valor: "General" (hereda) o "Particular".
function modeChip(inherited, hasGeneral) {
  if (!hasGeneral) return null;
  return h("span", { class: inherited ? "chip chip-general" : "chip chip-own" }, inherited ? "General" : "Particular");
}

function numberInput(value, label, placeholder = "") {
  return h("input", {
    class: "input", type: "number", min: "0", step: "0.01", inputmode: "decimal",
    value: value == null ? "" : String(value), placeholder, "aria-label": label,
  });
}

// query: { tab: "datos" | "precios" | "imagenes" | "stock" }
export async function renderProductEdit(view, productId, query = {}) {
  mount(view, h("p", { class: "muted" }, "Cargando…"));

  let categories;
  let product = null;
  let internal = { sku: null, base_cost: null };
  try {
    categories = await api.listCategories();
    if (productId) {
      [product, internal] = await Promise.all([api.getProduct(productId), api.getProductInternal(productId)]);
      if (!product) {
        mount(view, backLink(), h("p", { class: "form-error" }, "No se encontró el producto."));
        return;
      }
      product.base_price = product.base_price == null ? null : Number(product.base_price);
    }
  } catch (err) {
    console.error(err);
    mount(view, backLink(), h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const isNew = !product;
  let currentVariants = null; // se completa al cargar las variantes
  const reload = (tab = activeTab) => renderProductEdit(view, product.id, { tab });
  // Por ahora solo las yerbas controlan stock: es el valor inicial de la casilla.
  const tracksStockByDefault = () => categories.find((c) => c.id === product?.category_id)?.slug === "yerbas";

  // ------------------------------------------------------------------
  // Datos del producto
  // ------------------------------------------------------------------
  function productForm() {
    const name = h("input", { class: "input", maxlength: "120", value: product?.name ?? "" });
    const category = h("select", { class: "input" },
      h("option", { value: "" }, "Elegí una categoría"),
      categories.map((c) => h("option", { value: String(c.id) },
        c.is_active ? c.name : `${c.name} (inactiva)`))
    );
    category.value = product ? String(product.category_id) : "";
    const slug = h("input", { class: "input", maxlength: "140", value: product?.slug ?? "" });
    const description = h("textarea", { class: "input", rows: "4" });
    description.value = product?.description ?? "";
    const sortOrder = h("input", { class: "input input-num", type: "number", step: "1", value: String(product?.sort_order ?? 0) });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, isNew ? "Crear producto" : "Guardar cambios");

    // En productos nuevos el slug sigue al nombre hasta que se edita a mano.
    let slugTouched = !isNew;
    slug.addEventListener("input", () => { slugTouched = true; });
    name.addEventListener("input", () => { if (!slugTouched) slug.value = slugify(name.value); });

    const form = h("form", { class: "card", novalidate: true },
      h("h3", {}, "Datos del producto"),
      h("div", { class: "form-grid" },
        field("Nombre", name),
        field("Categoría", category),
        field("Slug", slug, "Identificador para la URL: minúsculas, números y guiones. Se genera a partir del nombre."),
        field("Orden", sortOrder, "Menor número = aparece antes.")
      ),
      field("Descripción", description),
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = {
        name: name.value.trim(),
        category_id: Number(category.value),
        slug: slug.value.trim(),
        description: description.value.trim(),
        sort_order: Number(sortOrder.value || 0),
      };

      const problem =
        !data.name ? "El nombre es obligatorio." :
        !data.category_id ? "Elegí una categoría." :
        !SLUG_RE.test(data.slug) ? "El slug solo puede tener minúsculas, números y guiones (ej. mate-imperial)." :
        !Number.isInteger(data.sort_order) ? "El orden debe ser un número entero." :
        null;
      if (problem) { showError(error, problem); return; }

      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Guardando…";
      try {
        if (isNew) {
          const created = await api.createProduct(data);
          toast("Producto creado como borrador. Ahora cargá su SKU y su precio.");
          location.hash = `#/productos/${created.id}?tab=precios`;
        } else {
          await api.updateProduct(product.id, data);
          toast("Cambios guardados.");
          await reload("datos");
        }
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
        submit.disabled = false;
        submit.textContent = isNew ? "Crear producto" : "Guardar cambios";
      }
    });

    return form;
  }

  // ------------------------------------------------------------------
  // Publicación
  // ------------------------------------------------------------------
  function publishSection() {
    const active = product.is_active;
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const button = h("button", { type: "button", class: active ? "btn-ghost" : "btn-primary btn-inline" },
      active ? "Pasar a borrador" : "Publicar producto");

    button.addEventListener("click", async () => {
      if (!active) {
        if (currentVariants === null) { showError(error, "Esperá a que terminen de cargar las variantes."); return; }
        const publishable = currentVariants.some((v) => v.is_active && v.price > 0);
        if (!publishable) {
          showError(error, "Para publicar, cargá un precio de venta en “Precios y variantes”.");
          return;
        }
      }
      button.disabled = true;
      try {
        await api.updateProduct(product.id, { is_active: !active });
        toast(active ? "El producto pasó a borrador." : "Producto publicado.");
        await reload("datos");
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
        button.disabled = false;
      }
    });

    return h("section", { class: "card" },
      h("h3", {}, "Publicación"),
      h("p", {}, active
        ? "Publicado: se muestra en la tienda."
        : "Borrador: no se muestra en la tienda."),
      error,
      h("div", { class: "actions" }, button)
    );
  }

  // ------------------------------------------------------------------
  // Precios y variantes
  // ------------------------------------------------------------------
  const pricesPane = h("div", { class: "pane-stack" });
  // "simple": un solo modelo (variante interna "Único"). "variants": varias.
  let mode = null;

  const hasGeneralPrice = () => product.base_price != null;
  const hasGeneralCost = () => internal.base_cost != null;

  // SKU, precio de venta y costo del producto.
  function generalCard() {
    const simple = mode === "simple";
    const single = simple ? currentVariants[0] ?? null : null;
    const sku = h("input", { class: "input", maxlength: "64", value: internal.sku ?? "", placeholder: "Ej. 2559", "aria-label": "SKU del producto", autocomplete: "off" });
    const price = numberInput(product.base_price, "Precio de venta general", simple ? "Precio" : "Sin precio general");
    const cost = numberInput(internal.base_cost, "Costo general", "Opcional");
    const track = simple ? h("input", { type: "checkbox", checked: single ? single.track_stock : tracksStockByDefault() }) : null;
    const marginText = h("span", { class: "margin-hint" });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline", disabled: true }, "Guardar");

    const inheritingPrice = currentVariants.filter((v) => v.price_inherited).length;
    const inheritingCost = currentVariants.filter((v) => v.cost_inherited).length;
    const applies = h("p", { class: "muted" });

    function refresh() {
      const p = readNumber(price.value), c = readNumber(cost.value);
      const m = margin(p, c);
      marginText.textContent = m ? `Margen ${m}` : "";
      if (simple) { applies.textContent = ""; return; }
      const parts = [];
      if (p != null && !Number.isNaN(p)) parts.push(`el precio se aplica a ${inheritingPrice} de ${currentVariants.length} variantes`);
      if (c != null && !Number.isNaN(c)) parts.push(`el costo a ${inheritingCost} de ${currentVariants.length}`);
      applies.textContent = parts.length
        ? `Al guardar, ${parts.join(" y ")}. Las que tienen valor particular no cambian.`
        : "Sin valores generales: cada variante tiene su propio precio.";
    }
    const markDirty = () => { submit.disabled = false; refresh(); };
    [sku, price, cost].forEach((el) => el.addEventListener("input", markDirty));
    track?.addEventListener("change", markDirty);
    refresh();

    const form = h("form", { class: "card", novalidate: true },
      h("div", { class: "card-head" },
        h("h3", {}, simple ? "Precio" : "Precio general"),
        h("p", { class: "muted" }, simple
          ? "Producto simple: un solo modelo, sin talles, colores ni pesos para elegir."
          : "SKU, precio y costo del producto. Las variantes los usan salvo que tengan uno particular.")),
      h("div", { class: "form-grid form-grid-3" },
        field("SKU", sku, "Código del proveedor (ej. ARTICULO de la lista). Único por producto."),
        field("Precio de venta", price),
        field("Costo", cost, "Interno: no se muestra en la tienda.")),
      h("div", { class: "general-foot" },
        marginText,
        simple ? h("label", { class: "check check-inline" }, track, h("span", {}, "Controla stock")) : null),
      applies,
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const p = readNumber(price.value), c = readNumber(cost.value);
      const newSku = api.normalizeSku(sku.value);
      const problem =
        Number.isNaN(p) || (p != null && p <= 0) ? "El precio de venta debe ser un número mayor a 0." :
        simple && p == null ? "Ingresá el precio de venta." :
        Number.isNaN(c) || (c != null && c < 0) ? "El costo debe ser un número mayor o igual a 0." :
        newSku && newSku.length > 64 ? "El SKU puede tener hasta 64 caracteres." :
        null;
      if (problem) { showError(error, problem); return; }

      const changes = {};
      if (newSku !== internal.sku) changes.sku = newSku;
      if (p !== product.base_price) changes.base_price = p;
      if (c !== internal.base_cost) changes.base_cost = c;

      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Guardando…";
      try {
        await api.saveProductPricing(product.id, changes);
        if (simple) {
          // El modelo único hereda precio y costo del producto.
          if (!single) {
            await api.createVariant(product.id, { name: api.SINGLE_VARIANT_NAME, price: p, track_stock: track.checked, is_active: true, sort_order: 0 });
          } else {
            const fields = {};
            if (track.checked !== single.track_stock) fields.track_stock = track.checked;
            if (!single.is_active) fields.is_active = true;
            if (!single.price_inherited) fields.price_inherited = true;
            if (!single.cost_inherited && c != null) fields.cost_inherited = true;
            if (Object.keys(fields).length) await api.updateVariant(single.id, fields);
            // Sin costo general, el modelo único queda sin costo.
            if (c == null && single.cost != null) await api.saveVariantCost(single.id, null);
          }
        }
        toast(simple ? "Precio guardado." : "Precio general guardado.");
        await reload("precios");
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
        submit.disabled = false;
        submit.textContent = "Guardar";
      }
    });
    return form;
  }

  // Tarjeta de una variante.
  function variantCard(v) {
    const name = h("input", { class: "input variant-name", maxlength: "80", value: v.name, "aria-label": "Nombre de la variante" });
    const price = numberInput(v.price, `Precio de ${v.name}`);
    const cost = numberInput(v.cost, `Costo de ${v.name}`, "Sin costo");
    const track = h("input", { type: "checkbox", checked: v.track_stock });
    const active = h("input", { type: "checkbox", checked: v.is_active });
    const sort = h("input", { class: "input input-sm", type: "number", step: "1", value: String(v.sort_order), "aria-label": "Orden" });
    const save = h("button", { type: "button", class: "btn-primary btn-sm", hidden: true }, "Guardar");
    const discard = h("button", { type: "button", class: "btn-ghost btn-sm", hidden: true }, "Descartar");

    const priceChip = h("span", {}, modeChip(v.price_inherited, hasGeneralPrice()));
    const costChip = h("span", {}, modeChip(v.cost_inherited, hasGeneralCost()));
    const usePrice = hasGeneralPrice() && !v.price_inherited
      ? h("button", { type: "button", class: "link-btn", title: `Usar ${formatPrice(product.base_price)}` }, "Usar general")
      : null;
    const useCost = hasGeneralCost() && !v.cost_inherited
      ? h("button", { type: "button", class: "link-btn", title: `Usar ${formatPrice(internal.base_cost)}` }, "Usar general")
      : null;

    const card = h("article", { class: v.is_active ? "variant-card" : "variant-card is-inactive" },
      h("div", { class: "variant-head" },
        name,
        h("label", { class: "check check-inline" }, active, h("span", {}, "Activa"))),
      h("div", { class: "variant-fields" },
        h("div", { class: "vfield" },
          h("div", { class: "vfield-label" }, h("span", {}, "Precio"), priceChip),
          price,
          usePrice),
        h("div", { class: "vfield" },
          h("div", { class: "vfield-label" }, h("span", {}, "Costo"), costChip),
          cost,
          useCost),
        h("div", { class: "vfield vfield-sm" },
          h("div", { class: "vfield-label" }, h("span", {}, "Orden")),
          sort)),
      h("div", { class: "variant-foot" },
        h("label", { class: "check check-inline" }, track, h("span", {}, "Controla stock")),
        h("span", { class: "variant-stock" }, v.track_stock ? ["Stock: ", h("strong", {}, String(v.stock))] : "Sin control de stock"),
        h("span", { class: "variant-actions" }, discard, save))
    );

    // Vista previa del modo mientras se edita.
    function preview() {
      const p = readNumber(price.value), c = readNumber(cost.value);
      if (hasGeneralPrice()) mount(priceChip, modeChip(p === product.base_price, true));
      if (hasGeneralCost()) mount(costChip, modeChip(c === internal.base_cost, true));
    }
    const markDirty = () => { save.hidden = false; discard.hidden = false; card.classList.add("is-dirty"); preview(); };
    [name, price, cost, sort].forEach((el) => el.addEventListener("input", markDirty));
    [track, active].forEach((el) => el.addEventListener("change", markDirty));
    discard.addEventListener("click", () => loadVariants());

    async function useGeneral(which) {
      try {
        await api.useGeneral(v.id, { [which]: true });
        toast(`“${v.name}” usa el ${which === "price" ? "precio" : "costo"} general.`);
        await loadVariants();
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
      }
    }
    usePrice?.addEventListener("click", () => useGeneral("price"));
    useCost?.addEventListener("click", () => useGeneral("cost"));

    save.addEventListener("click", async () => {
      const variantName = name.value.trim();
      const p = readNumber(price.value), c = readNumber(cost.value);
      const s = Number(sort.value || 0);
      const problem =
        !variantName ? "La variante necesita un nombre." :
        p == null || Number.isNaN(p) || p <= 0 ? `El precio de “${variantName}” debe ser mayor a 0 (si no se vende, desactivala).` :
        Number.isNaN(c) || (c != null && c < 0) ? "El costo debe ser un número mayor o igual a 0 (o vacío)." :
        !Number.isInteger(s) ? "El orden debe ser un número entero." :
        null;
      if (problem) { toast(problem, "error"); return; }

      const fields = {};
      if (variantName !== v.name) fields.name = variantName;
      if (p !== v.price) fields.price = p;           // la base decide si queda general o particular
      if (track.checked !== v.track_stock) fields.track_stock = track.checked;
      if (active.checked !== v.is_active) fields.is_active = active.checked;
      if (s !== v.sort_order) fields.sort_order = s;

      save.disabled = true;
      save.textContent = "Guardando…";
      try {
        if (Object.keys(fields).length) await api.updateVariant(v.id, fields);
        if (c !== v.cost) await api.saveVariantCost(v.id, c);
        toast(`Variante “${variantName}” guardada.`);
        await loadVariants();
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
        save.disabled = false;
        save.textContent = "Guardar";
      }
    });
    return card;
  }

  function newVariantForm() {
    const name = h("input", { class: "input", maxlength: "80", placeholder: "Ej. 500gr, Chica, Negro", "aria-label": "Nombre de la nueva variante" });
    const useBase = hasGeneralPrice() ? h("input", { type: "checkbox", checked: true }) : null;
    const price = numberInput(null, "Precio de la nueva variante", hasGeneralPrice() ? formatPrice(product.base_price) : "Precio");
    const cost = numberInput(null, "Costo de la nueva variante", hasGeneralCost() ? `General: ${formatPrice(internal.base_cost)}` : "Opcional");
    const track = h("input", { type: "checkbox", checked: tracksStockByDefault() });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, icon("plus"), "Agregar variante");

    function syncPrice() {
      if (!useBase) return;
      price.disabled = useBase.checked;
      if (useBase.checked) price.value = "";
    }
    useBase?.addEventListener("change", syncPrice);
    syncPrice();

    const useSingle = api.isSimpleProduct(currentVariants)
      ? h("button", { type: "button", class: "btn-ghost", onClick: () => { mode = "simple"; loadVariants(); } },
          "Es un solo modelo: volver a producto simple")
      : null;

    const form = h("form", { class: "card new-variant-card", novalidate: true },
      h("h3", {}, "Nueva variante"),
      h("div", { class: "form-grid form-grid-3" },
        field("Nombre", name),
        h("div", { class: "field" },
          h("span", {}, "Precio"),
          price,
          useBase ? h("label", { class: "check check-inline" }, useBase, h("span", {}, "Usar el precio general")) : null),
        field("Costo", cost, hasGeneralCost() ? "Vacío = usa el costo general." : null)),
      h("label", { class: "check check-inline" }, track, h("span", {}, "Controla stock")),
      h("div", { class: "actions" }, submit, useSingle)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const variantName = name.value.trim();
      const p = useBase?.checked ? product.base_price : readNumber(price.value);
      const c = readNumber(cost.value);
      const problem =
        !variantName ? "La variante necesita un nombre." :
        p == null || Number.isNaN(p) || p <= 0 ? "Ingresá un precio mayor a 0." :
        Number.isNaN(c) || (c != null && c < 0) ? "El costo debe ser un número mayor o igual a 0." :
        null;
      if (problem) { toast(problem, "error"); return; }

      submit.disabled = true;
      try {
        const created = await api.createVariant(product.id, {
          name: variantName, price: p, track_stock: track.checked, is_active: true, sort_order: currentVariants.length,
        });
        if (c != null) await api.saveVariantCost(created.id, c);
        toast(`Variante “${variantName}” agregada.`);
        await loadVariants();
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
        submit.disabled = false;
      }
    });
    return form;
  }

  async function loadVariants() {
    mount(pricesPane, h("p", { class: "muted" }, "Cargando variantes…"));
    try {
      currentVariants = await api.listVariants(product.id);
    } catch (err) {
      console.error(err);
      mount(pricesPane, h("p", { class: "form-error" }, errorMessage(err)));
      return;
    }

    const sellable = currentVariants.some((v) => v.is_active && v.price > 0);
    const simple = api.isSimpleProduct(currentVariants);
    if (mode === null || (mode === "simple" && !simple)) mode = simple ? "simple" : "variants";

    const warning = product.is_active && !sellable
      ? h("p", { class: "notice-warn" }, "El producto está publicado pero no tiene ninguna variante activa con precio: no se puede comprar.")
      : null;

    if (mode === "simple") {
      mount(pricesPane,
        warning,
        generalCard(),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn-ghost", onClick: () => { mode = "variants"; loadVariants(); } },
            "Tiene variantes (talles, colores, pesos…)")));
    } else {
      const particular = currentVariants.filter((v) => !v.price_inherited).length;
      mount(pricesPane,
        warning,
        generalCard(),
        h("section", { class: "pane-stack" },
          h("div", { class: "section-head" },
            h("h3", {}, `Variantes (${currentVariants.length})`),
            hasGeneralPrice() && currentVariants.length
              ? h("span", { class: "muted" }, particular
                  ? `${currentVariants.length - particular} con precio general · ${particular} particular${particular === 1 ? "" : "es"}`
                  : "Todas usan el precio general")
              : null),
          currentVariants.length
            ? h("div", { class: "variant-grid" }, currentVariants.map(variantCard))
            : h("p", { class: "empty-box" }, "Este producto todavía no tiene variantes.")),
        newVariantForm());
    }
    refreshImages();
    renderStockPane();
    renderHeaderMeta();
  }

  // ------------------------------------------------------------------
  // Imágenes
  // ------------------------------------------------------------------
  const imagesPane = h("section", { class: "card" });
  let imagesVariantsKey = null;
  function refreshImages() {
    const simple = mode === "simple";
    const key = JSON.stringify([simple, currentVariants.map((v) => [v.id, v.name, v.is_active])]);
    if (key === imagesVariantsKey) return;
    imagesVariantsKey = key;
    renderImagesPanel(imagesPane, { product, variants: simple ? [] : currentVariants });
  }

  // ------------------------------------------------------------------
  // Stock: lista de variantes y panel de movimientos de la elegida
  // ------------------------------------------------------------------
  const stockPane = h("div", { class: "pane-stack" });
  const stockList = h("div");
  const stockSection = h("section", { class: "card stock-panel", hidden: true });
  let stockVariantId = null;
  let stockTab = "entrada";
  mount(stockPane, stockList, stockSection);

  function closeStock() {
    stockVariantId = null;
    stockSection.hidden = true;
    mount(stockSection);
    renderStockPane();
  }

  function openStock(variantId, tab = "entrada", { scroll = true } = {}) {
    const variant = currentVariants?.find((v) => v.id === variantId);
    if (!variant || !variant.track_stock) { closeStock(); return; }
    stockVariantId = variantId;
    stockTab = tab;
    stockSection.hidden = false;
    renderStockPanel(stockSection, {
      variant,
      initialTab: tab,
      onChanged: async (currentTab) => { stockTab = currentTab; await loadVariants(); },
      onClose: closeStock,
    });
    renderStockPane(false);
    if (scroll) stockSection.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function renderStockPane(reopen = true) {
    if (!currentVariants) return;
    const tracked = currentVariants.filter((v) => v.track_stock);
    const untracked = currentVariants.length - tracked.length;
    mount(stockList, h("section", { class: "card" },
      h("h3", {}, "Stock"),
      tracked.length
        ? h("ul", { class: "stock-list" }, tracked.map((v) => h("li", { class: v.id === stockVariantId ? "is-open" : "" },
            h("span", { class: "stock-name" }, v.name === api.SINGLE_VARIANT_NAME ? product.name : v.name,
              v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
            h("span", { class: v.stock === 0 ? "stock-qty text-alert" : "stock-qty" }, String(v.stock)),
            h("button", { type: "button", class: "btn-ghost btn-sm", onClick: () => openStock(v.id) }, "Movimientos"))))
        : h("p", { class: "empty-box" }, "Ninguna variante controla stock. Activá «Controla stock» en Precios y variantes."),
      untracked && tracked.length ? h("p", { class: "muted" }, `${untracked} ${untracked === 1 ? "variante no controla" : "variantes no controlan"} stock.`) : null));
    if (reopen && stockVariantId !== null) openStock(stockVariantId, stockTab, { scroll: false });
  }

  // ------------------------------------------------------------------
  // Eliminar (solo borradores). Único lugar con rojo en esta pantalla.
  // ------------------------------------------------------------------
  const deleteBox = h("div", { hidden: true });

  function deleteButton() {
    if (isNew || product.is_active) return null;
    const button = h("button", { type: "button", class: "btn-ghost btn-danger" }, icon("trash"), "Eliminar borrador");
    button.addEventListener("click", () => openDelete());
    return button;
  }

  async function openDelete() {
    deleteBox.hidden = false;
    mount(deleteBox, h("div", { class: "confirm-box confirm-danger" }, h("p", {}, "Revisando qué se va a eliminar…")));
    deleteBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
    let info;
    try {
      info = await api.getDeletionInfo(product.id);
    } catch (err) {
      console.error(err);
      mount(deleteBox, h("div", { class: "confirm-box confirm-danger" },
        h("p", { class: "form-error" }, `No se pudo revisar el producto: ${errorMessage(err)}`),
        h("div", { class: "actions" }, h("button", { type: "button", class: "btn-ghost", onClick: closeDelete }, "Cerrar"))));
      return;
    }
    const cancel = h("button", { type: "button", class: "btn-ghost", onClick: closeDelete }, "Cancelar");

    if (!info.product || info.product.is_active) {
      mount(deleteBox, h("div", { class: "confirm-box confirm-danger" },
        h("p", {}, "Este producto ya no está en borrador: los productos publicados no se pueden eliminar. Recargá la página."),
        h("div", { class: "actions" }, cancel)));
      return;
    }
    if (info.movements > 0) {
      mount(deleteBox, h("div", { class: "confirm-box confirm-danger" },
        h("p", {}, h("strong", {}, `No se puede eliminar «${product.name}».`)),
        h("p", {}, `Sus variantes tienen ${info.movements} ${info.movements === 1 ? "movimiento" : "movimientos"} de stock. `,
          "El historial de stock se conserva siempre, así que este producto no se borra. Dejalo en borrador: no se muestra en la tienda."),
        h("div", { class: "actions" }, cancel)));
      return;
    }

    const storageFiles = info.images.filter((i) => imageSource(i.src) === "storage").length;
    const confirm = h("button", { type: "button", class: "btn-primary btn-danger-solid" }, `Sí, eliminar «${product.name}»`);
    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = "Eliminando…";
      try {
        await api.deleteDraftProduct(product.id);
      } catch (err) {
        console.error(err);
        mount(deleteBox, h("div", { class: "confirm-box confirm-danger" },
          h("p", { class: "form-error" }, err.code === "NOT_DRAFT" ? err.message : `No se eliminó: ${errorMessage(err)}`),
          h("div", { class: "actions" }, h("button", { type: "button", class: "btn-ghost", onClick: closeDelete }, "Cerrar"))));
        return;
      }
      // El producto ya no existe; los archivos de Storage se borran después.
      // Si eso falla, quedan archivos sin uso, pero ningún registro roto.
      let filesNote = "";
      try { await removeProductFiles(product.id, info.images.map((i) => i.src)); }
      catch (err) { console.error(err); filesNote = " Algunas fotos no se pudieron borrar de Storage (no afecta la tienda)."; }
      toast(`«${product.name}» se eliminó.${filesNote}`, filesNote ? "error" : "ok");
      location.hash = "#/productos?estado=draft";
    });

    mount(deleteBox, h("div", { class: "confirm-box confirm-danger", role: "alertdialog", "aria-label": `Eliminar ${product.name}` },
      h("p", {}, h("strong", {}, `¿Eliminar «${product.name}»?`)),
      h("p", {}, "Se borra el producto con todo lo suyo. No se puede deshacer."),
      h("ul", { class: "change-list" },
        h("li", {}, info.variants
          ? `${info.variants} ${info.variants === 1 ? "variante" : "variantes"}, con sus precios y costos, y el SKU del producto`
          : "Sin variantes"),
        h("li", {}, info.images.length
          ? `${info.images.length} ${info.images.length === 1 ? "imagen" : "imágenes"}${storageFiles ? ` (${storageFiles} ${storageFiles === 1 ? "archivo" : "archivos"} en Storage)` : ""}`
          : "Sin imágenes")),
      h("div", { class: "actions" }, confirm, cancel)));
    confirm.focus();
  }

  function closeDelete() {
    deleteBox.hidden = true;
    mount(deleteBox);
  }

  // ------------------------------------------------------------------
  // Encabezado y pestañas
  // ------------------------------------------------------------------
  const headerMeta = h("p", { class: "page-sub" });
  function renderHeaderMeta() {
    if (isNew) return;
    const parts = [];
    parts.push(internal.sku ? `SKU ${internal.sku}` : "Sin SKU");
    if (product.base_price != null) parts.push(formatPrice(product.base_price));
    if (currentVariants && mode === "variants") parts.push(`${currentVariants.length} ${currentVariants.length === 1 ? "variante" : "variantes"}`);
    mount(headerMeta, parts.join(" · "));
  }

  if (isNew) {
    mount(view,
      backLink(),
      h("div", { class: "page-header" }, h("h2", {}, "Nuevo producto")),
      productForm(),
      h("p", { class: "muted" }, "Después de crear el producto vas a poder cargar su SKU, su precio y sus variantes."));
    return;
  }

  const panes = {
    datos: h("div", { class: "pane-stack" }, productForm(), publishSection()),
    precios: pricesPane,
    imagenes: imagesPane,
    stock: stockPane,
  };
  let activeTab = TABS.some(([k]) => k === query.tab) ? query.tab : "datos";
  const tabButtons = {};
  const tabBar = h("div", { class: "tabs tabs-product", role: "tablist" },
    TABS.map(([key, label]) => {
      const b = h("button", { type: "button", class: "tab", role: "tab", onClick: () => selectTab(key) }, label);
      tabButtons[key] = b;
      return b;
    }));

  function selectTab(key) {
    activeTab = key;
    for (const [k] of TABS) {
      const on = k === key;
      tabButtons[k].classList.toggle("active", on);
      tabButtons[k].setAttribute("aria-selected", String(on));
      panes[k].hidden = !on;
    }
    // La pestaña queda en la dirección (para volver o compartir) sin redibujar.
    history.replaceState(null, "", `#/productos/${product.id}${key === "datos" ? "" : `?tab=${key}`}`);
  }

  mount(view,
    backLink(),
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("div", { class: "title-row" }, h("h2", {}, product.name), statusBadge(product.is_active)),
        headerMeta),
      deleteButton()),
    deleteBox,
    tabBar,
    Object.values(panes));
  selectTab(activeTab);
  renderHeaderMeta();
  await loadVariants();
}
