import * as api from "../api/catalog.js";
import { h, mount, field, showError, toast, errorMessage, slugify, SLUG_RE } from "../ui.js";
import { renderStockPanel } from "./stockPanel.js";
import { renderImagesPanel } from "./imagesPanel.js";

function backLink() {
  return h("a", { href: "#/productos", class: "back-link" }, "← Volver a productos");
}

function statusBadge(active) {
  return h("span", { class: active ? "badge badge-ok" : "badge" }, active ? "Publicado" : "Borrador");
}

// Lee y valida los campos de una variante. Devuelve { fields, cost } o { error }.
function parseVariant({ name, price, cost, track, active, sort }) {
  const variantName = name.value.trim();
  if (!variantName) return { error: "La variante necesita un nombre." };

  if (price.value === "") return { error: `Ingresá un precio para “${variantName}”.` };
  const priceValue = Number(price.value);
  if (!Number.isFinite(priceValue) || priceValue < 0) return { error: "El precio debe ser un número mayor o igual a 0." };

  let costValue = null;
  if (cost.value !== "") {
    costValue = Number(cost.value);
    if (!Number.isFinite(costValue) || costValue < 0) return { error: "El costo debe ser un número mayor o igual a 0." };
    costValue = Math.round(costValue * 100) / 100;
  }

  const sortValue = sort ? Number(sort.value || 0) : 0;
  if (!Number.isInteger(sortValue)) return { error: "El orden debe ser un número entero." };

  return {
    fields: {
      name: variantName,
      price: Math.round(priceValue * 100) / 100,
      track_stock: track.checked,
      is_active: active ? active.checked : true,
      sort_order: sortValue,
    },
    cost: costValue,
  };
}

export async function renderProductEdit(view, productId) {
  mount(view, h("p", { class: "muted" }, "Cargando…"));

  let categories;
  let product = null;
  try {
    categories = await api.listCategories();
    if (productId) {
      product = await api.getProduct(productId);
      if (!product) {
        mount(view, backLink(), h("p", { class: "form-error" }, "No se encontró el producto."));
        return;
      }
    }
  } catch (err) {
    console.error(err);
    mount(view, backLink(), h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const isNew = !product;
  let currentVariants = null; // se completa al cargar las variantes
  const reload = () => renderProductEdit(view, product.id);
  // Por ahora solo las yerbas controlan stock: es el valor inicial de la casilla
  // (se puede activar a mano en cualquier producto).
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
          toast("Producto creado como borrador. Ahora cargá su precio o sus variantes.");
          location.hash = `#/productos/${created.id}`;
        } else {
          await api.updateProduct(product.id, data);
          toast("Cambios guardados.");
          await reload();
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
      active ? "Desactivar producto" : "Publicar producto");

    button.addEventListener("click", async () => {
      if (!active) {
        if (currentVariants === null) { showError(error, "Esperá a que terminen de cargar las variantes."); return; }
        const publishable = currentVariants.some((v) => v.is_active && v.price > 0);
        if (!publishable) {
          showError(error, api.isSimpleProduct(currentVariants)
            ? "Para publicar, cargá un precio mayor a 0 en “Precio y stock”."
            : "Para publicar, el producto necesita al menos una variante activa con precio mayor a 0.");
          return;
        }
      }
      button.disabled = true;
      try {
        await api.updateProduct(product.id, { is_active: !active });
        toast(active ? "Producto desactivado." : "Producto publicado.");
        await reload();
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
        button.disabled = false;
      }
    });

    return h("section", { class: "card" },
      h("h3", {}, "Publicación"),
      h("p", {}, active
        ? "Publicado: listo para mostrarse en la tienda."
        : "Borrador: no se muestra en la tienda."),
      h("p", { class: "muted" }, "La tienda muestra solo los productos publicados desde acá."),
      error,
      h("div", { class: "actions" }, button)
    );
  }

  // ------------------------------------------------------------------
  // Variantes y precios
  // ------------------------------------------------------------------
  const variantsSection = h("section", { class: "card" });

  // ------------------------------------------------------------------
  // Panel de stock (una variante a la vez)
  // ------------------------------------------------------------------
  const stockSection = h("section", { class: "card stock-panel", hidden: true });

  // Sección de imágenes: se redibuja solo si cambian las variantes (nombres o estado),
  // para no interrumpir una subida en curso cuando se guarda stock o precios.
  const imagesSection = h("section", { class: "card" });
  let imagesVariantsKey = null;

  function refreshImages() {
    const simple = mode === "simple";
    const key = JSON.stringify([simple, currentVariants.map((v) => [v.id, v.name, v.is_active])]);
    if (key === imagesVariantsKey) return;
    imagesVariantsKey = key;
    // En un producto simple no hay variantes para elegir: todo va a la galería.
    renderImagesPanel(imagesSection, { product, variants: simple ? [] : currentVariants });
  }

  // "simple": precio y stock directo en el producto (variante interna "Único").
  // "variants": tabla de variantes. Se decide al cargar; se puede pasar a variantes.
  let mode = null;
  let stockVariantId = null;
  let stockTab = "entrada";

  function closeStock() {
    stockVariantId = null;
    stockSection.hidden = true;
    mount(stockSection);
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
    if (scroll) stockSection.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }

  function variantRow(v) {
    const name = h("input", { class: "input", maxlength: "80", value: v.name, "aria-label": "Nombre de la variante" });
    const sku = h("input", { class: "input input-sku", maxlength: "64", placeholder: "—", value: v.sku ?? "", "aria-label": "SKU" });
    const price = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", value: String(v.price), "aria-label": "Precio" });
    const cost = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "—", value: v.cost == null ? "" : String(v.cost), "aria-label": "Costo" });
    const track = h("input", { type: "checkbox", checked: v.track_stock, "aria-label": "Controla stock" });
    const active = h("input", { type: "checkbox", checked: v.is_active, "aria-label": "Activa" });
    const sort = h("input", { class: "input input-num input-sm", type: "number", step: "1", value: String(v.sort_order), "aria-label": "Orden" });
    const save = h("button", { type: "button", class: "btn-primary btn-sm", disabled: true }, "Guardar");
    const stockButton = h("button", {
      type: "button",
      class: "btn-ghost btn-sm",
      disabled: !v.track_stock,
      title: v.track_stock
        ? "Registrar entradas, salidas y ajustes"
        : "Esta variante no controla stock. Marcá “Controla stock” y guardá para usarlo.",
      onClick: () => openStock(v.id),
    }, "Stock");

    const stock = v.track_stock
      ? h("span", { title: "El stock se modifica con el botón Stock." }, String(v.stock))
      : h("span", { class: "muted", title: "Esta variante se vende sin controlar stock." }, "No controla");

    const tr = h("tr", { class: v.is_active ? "" : "row-inactive" },
      h("td", {}, name),
      h("td", {}, sku),
      h("td", {}, price),
      h("td", {}, cost),
      h("td", { class: "center" }, track),
      h("td", { class: "center" }, active),
      h("td", {}, sort),
      h("td", { class: "num" }, stock),
      h("td", {}, h("div", { class: "row-actions" }, save, stockButton))
    );

    const markDirty = () => { save.disabled = false; tr.classList.add("row-dirty"); };
    [name, sku, price, cost, sort].forEach((el) => el.addEventListener("input", markDirty));
    [track, active].forEach((el) => el.addEventListener("change", markDirty));

    save.addEventListener("click", async () => {
      const parsed = parseVariant({ name, price, cost, track, active, sort });
      if (parsed.error) { toast(parsed.error, "error"); return; }

      save.disabled = true;
      save.textContent = "Guardando…";
      try {
        await api.updateVariant(v.id, parsed.fields);
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
        save.disabled = false;
        save.textContent = "Guardar";
        return;
      }

      const pending = [];
      try {
        if (parsed.cost !== v.cost) await api.saveVariantCost(v.id, parsed.cost);
      } catch (err) {
        console.error(err);
        pending.push(`el costo no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      try {
        if (api.normalizeSku(sku.value) !== (v.sku ?? null)) await api.saveVariantSku(v.id, sku.value);
      } catch (err) {
        console.error(err);
        pending.push(`el SKU no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      if (pending.length) toast(`La variante se guardó, pero ${pending.join(" y ")}.`, "error");
      else toast(`Variante “${parsed.fields.name}” guardada.`);
      await loadVariants();
    });

    return tr;
  }

  function newVariantForm() {
    const name = h("input", { class: "input", maxlength: "80", placeholder: "Ej. 500gr, Chica, Negro", "aria-label": "Nombre de la nueva variante" });
    const price = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Precio", "aria-label": "Precio" });
    const cost = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Costo (opcional)", "aria-label": "Costo" });
    const sku = h("input", { class: "input", maxlength: "64", placeholder: "Opcional", "aria-label": "SKU de la nueva variante" });
    const track = h("input", { type: "checkbox", checked: tracksStockByDefault() });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Agregar variante");

    // Mientras no tenga más de un modelo, se puede volver a "Producto simple".
    const useSingle = api.isSimpleProduct(currentVariants)
      ? h("button", { type: "button", class: "btn-ghost", onClick: () => { mode = "simple"; loadVariants(); } },
          "Es un solo modelo: volver a producto simple")
      : null;

    const form = h("form", { class: "new-variant", novalidate: true },
      h("h4", {}, "Nueva variante"),
      h("div", { class: "new-variant-fields" },
        field("Nombre", name),
        field("Precio", price),
        field("Costo", cost),
        field("SKU", sku),
        h("label", { class: "check" }, track, h("span", {}, "Controla stock"))
      ),
      h("div", { class: "actions" }, submit, useSingle)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const parsed = parseVariant({ name, price, cost, track });
      if (parsed.error) { toast(parsed.error, "error"); return; }
      parsed.fields.sort_order = currentVariants.length;

      submit.disabled = true;
      submit.textContent = "Agregando…";
      let created;
      try {
        created = await api.createVariant(product.id, parsed.fields);
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
        submit.disabled = false;
        submit.textContent = "Agregar variante";
        return;
      }

      const pending = [];
      try {
        if (parsed.cost !== null) await api.saveVariantCost(created.id, parsed.cost);
      } catch (err) {
        console.error(err);
        pending.push(`el costo no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      try {
        if (api.normalizeSku(sku.value) !== null) await api.saveVariantSku(created.id, sku.value);
      } catch (err) {
        console.error(err);
        pending.push(`el SKU no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      if (pending.length) toast(`La variante se agregó, pero ${pending.join(" y ")}.`, "error");
      else toast(`Variante “${parsed.fields.name}” agregada.`);
      await loadVariants();
    });

    return form;
  }

  // ------------------------------------------------------------------
  // Producto simple: precio, costo, SKU y stock sin variantes visibles
  // ------------------------------------------------------------------
  function simpleForm(v) {
    const price = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Precio", value: v ? String(v.price) : "", "aria-label": "Precio" });
    const cost = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Opcional", value: v?.cost == null ? "" : String(v.cost), "aria-label": "Costo" });
    const sku = h("input", { class: "input input-sku", maxlength: "64", placeholder: "Opcional", value: v?.sku ?? "", "aria-label": "SKU" });
    const track = h("input", { type: "checkbox", checked: v ? v.track_stock : tracksStockByDefault(), "aria-label": "Controla stock" });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline", disabled: !!v }, v ? "Guardar" : "Guardar precio");

    const stockInfo = !v
      ? h("p", { class: "muted" }, "Después de guardar el precio vas a poder cargar el stock.")
      : v.track_stock
        ? h("div", { class: "actions" },
            h("span", {}, "Stock actual: ", h("strong", {}, String(v.stock))),
            h("button", { type: "button", class: "btn-ghost btn-sm", onClick: () => openStock(v.id) }, "Registrar stock"))
        : h("p", { class: "muted" }, "Se vende sin controlar stock.");

    const form = h("form", { class: "new-variant", novalidate: true },
      h("div", { class: "new-variant-fields" },
        field("Precio", price),
        field("Costo", cost, "Interno: no se muestra en la tienda."),
        field("SKU", sku),
        h("label", { class: "check" }, track, h("span", {}, "Controla stock"))
      ),
      stockInfo,
      h("div", { class: "actions" }, submit)
    );
    const markDirty = () => { submit.disabled = false; };
    [price, cost, sku].forEach((el) => el.addEventListener("input", markDirty));
    track.addEventListener("change", markDirty);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const parsed = parseVariant({ name: { value: api.SINGLE_VARIANT_NAME }, price, cost, track });
      if (parsed.error) { toast(parsed.error, "error"); return; }

      submit.disabled = true;
      submit.textContent = "Guardando…";
      let variantId = v?.id;
      try {
        if (v) await api.updateVariant(v.id, { price: parsed.fields.price, track_stock: parsed.fields.track_stock, is_active: true });
        else variantId = (await api.createVariant(product.id, { ...parsed.fields, sort_order: 0 })).id;
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
        submit.disabled = false;
        submit.textContent = v ? "Guardar" : "Guardar precio";
        return;
      }

      const pending = [];
      try {
        if (parsed.cost !== (v?.cost ?? null)) await api.saveVariantCost(variantId, parsed.cost);
      } catch (err) {
        console.error(err);
        pending.push(`el costo no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      try {
        if (api.normalizeSku(sku.value) !== (v?.sku ?? null)) await api.saveVariantSku(variantId, sku.value);
      } catch (err) {
        console.error(err);
        pending.push(`el SKU no (${errorMessage(err).replace(/\.$/, "")})`);
      }
      if (pending.length) toast(`El precio se guardó, pero ${pending.join(" y ")}.`, "error");
      else toast("Precio guardado.");
      await loadVariants();
    });

    return form;
  }

  async function loadVariants() {
    const title = h("h3", {}, mode === "simple" ? "Precio y stock" : "Variantes y precios");
    mount(variantsSection, title, h("p", { class: "muted" }, "Cargando variantes…"));

    try {
      currentVariants = await api.listVariants(product.id);
    } catch (err) {
      console.error(err);
      mount(variantsSection, title, h("p", { class: "form-error" }, errorMessage(err)));
      return;
    }

    const sellable = currentVariants.some((v) => v.is_active && v.price > 0);
    const simple = api.isSimpleProduct(currentVariants);
    if (mode === null || (mode === "simple" && !simple)) mode = simple ? "simple" : "variants";

    if (mode === "simple") {
      const v = currentVariants[0] ?? null;
      mount(variantsSection,
        h("h3", {}, "Precio y stock"),
        h("p", { class: "muted" }, "Producto simple: un solo modelo, sin talles, colores ni pesos para elegir."),
        product.is_active && !sellable
          ? h("p", { class: "notice-warn" }, "Atención: el producto está publicado pero no tiene precio.")
          : null,
        simpleForm(v),
        h("div", { class: "actions" },
          h("button", { type: "button", class: "btn-ghost", onClick: () => { mode = "variants"; loadVariants(); } },
            "Tiene variantes (talles, colores, pesos…)"))
      );
      if (stockVariantId !== null) openStock(stockVariantId, stockTab, { scroll: false });
      refreshImages();
      return;
    }

    const warning = product.is_active && !sellable
      ? h("p", { class: "notice-warn" }, "Atención: el producto está publicado pero no tiene variantes activas con precio.")
      : null;

    const table = currentVariants.length
      ? h("div", { class: "table-wrap" },
          h("table", { class: "table table-edit" },
            h("thead", {}, h("tr", {},
              ["Variante", "SKU", "Precio", "Costo", "Controla stock", "Activa", "Orden", "Stock", ""].map((t) => h("th", {}, t))
            )),
            h("tbody", {}, currentVariants.map(variantRow))
          )
        )
      : h("p", { class: "empty-box" }, "Este producto todavía no tiene variantes.");

    mount(variantsSection, 
      title,
      h("p", { class: "muted" },
        "Cada variante tiene su propio precio y stock. ",
        "El costo es interno y nunca se muestra en la tienda. El stock se carga con el botón “Stock” de cada variante."),
      warning,
      table,
      newVariantForm()
    );

    // Si el panel de stock estaba abierto, se redibuja con los datos recién leídos.
    if (stockVariantId !== null) openStock(stockVariantId, stockTab, { scroll: false });
    refreshImages();
  }

  // ------------------------------------------------------------------
  // Armado de la pantalla
  // ------------------------------------------------------------------
  mount(view, 
    backLink(),
    h("div", { class: "page-header" },
      h("h2", {}, isNew ? "Nuevo producto" : product.name),
      isNew ? null : statusBadge(product.is_active)
    ),
    productForm(),
    isNew
      ? h("p", { class: "muted" }, "Después de crear el producto vas a poder cargar su precio y stock, o sus variantes.")
      : [publishSection(), variantsSection, stockSection, imagesSection]
  );

  if (!isNew) await loadVariants();
}
