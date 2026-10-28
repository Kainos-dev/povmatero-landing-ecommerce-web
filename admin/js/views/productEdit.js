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
          toast("Producto creado como borrador. Ahora agregá sus variantes.");
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
          showError(error, "Para publicar, el producto necesita al menos una variante activa con precio mayor a 0.");
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
      h("p", { class: "muted" }, "Por ahora la tienda pública sigue usando sus datos actuales: publicar acá todavía no cambia la web."),
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
    const key = JSON.stringify(currentVariants.map((v) => [v.id, v.name, v.is_active]));
    if (key === imagesVariantsKey) return;
    imagesVariantsKey = key;
    renderImagesPanel(imagesSection, { product, variants: currentVariants });
  }
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
      h("td", {}, price),
      h("td", {}, cost),
      h("td", { class: "center" }, track),
      h("td", { class: "center" }, active),
      h("td", {}, sort),
      h("td", { class: "num" }, stock),
      h("td", {}, h("div", { class: "row-actions" }, save, stockButton))
    );

    const markDirty = () => { save.disabled = false; tr.classList.add("row-dirty"); };
    [name, price, cost, sort].forEach((el) => el.addEventListener("input", markDirty));
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

      try {
        if (parsed.cost !== v.cost) await api.saveVariantCost(v.id, parsed.cost);
        toast(`Variante “${parsed.fields.name}” guardada.`);
      } catch (err) {
        console.error(err);
        toast(`La variante se guardó, pero el costo no: ${errorMessage(err)}`, "error");
      }
      await loadVariants();
    });

    return tr;
  }

  function newVariantForm() {
    const name = h("input", { class: "input", maxlength: "80", placeholder: "Ej. 500gr, Chica, Negro", "aria-label": "Nombre de la nueva variante" });
    const price = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Precio", "aria-label": "Precio" });
    const cost = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Costo (opcional)", "aria-label": "Costo" });
    const track = h("input", { type: "checkbox", checked: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Agregar variante");

    const useSingle = currentVariants.length === 0
      ? h("button", { type: "button", class: "btn-ghost", onClick: () => { name.value = "Único"; price.focus(); } },
          "Es un solo modelo: usar “Único”")
      : null;

    const form = h("form", { class: "new-variant", novalidate: true },
      h("h4", {}, "Nueva variante"),
      h("div", { class: "new-variant-fields" },
        field("Nombre", name),
        field("Precio", price),
        field("Costo", cost),
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

      try {
        if (parsed.cost !== null) await api.saveVariantCost(created.id, parsed.cost);
        toast(`Variante “${parsed.fields.name}” agregada.`);
      } catch (err) {
        console.error(err);
        toast(`La variante se agregó, pero el costo no: ${errorMessage(err)}`, "error");
      }
      await loadVariants();
    });

    return form;
  }

  async function loadVariants() {
    const title = h("h3", {}, "Variantes y precios");
    mount(variantsSection, title, h("p", { class: "muted" }, "Cargando variantes…"));

    try {
      currentVariants = await api.listVariants(product.id);
    } catch (err) {
      console.error(err);
      mount(variantsSection, title, h("p", { class: "form-error" }, errorMessage(err)));
      return;
    }

    const sellable = currentVariants.some((v) => v.is_active && v.price > 0);
    const warning = product.is_active && !sellable
      ? h("p", { class: "notice-warn" }, "Atención: el producto está publicado pero no tiene variantes activas con precio.")
      : null;

    const table = currentVariants.length
      ? h("div", { class: "table-wrap" },
          h("table", { class: "table table-edit" },
            h("thead", {}, h("tr", {},
              ["Variante", "Precio", "Costo", "Controla stock", "Activa", "Orden", "Stock", ""].map((t) => h("th", {}, t))
            )),
            h("tbody", {}, currentVariants.map(variantRow))
          )
        )
      : h("p", { class: "empty-box" }, "Este producto todavía no tiene variantes.");

    mount(variantsSection, 
      title,
      h("p", { class: "muted" },
        "Cada variante tiene su propio precio y stock. Si el producto tiene un solo modelo, creá una variante llamada “Único”. ",
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
      ? h("p", { class: "muted" }, "Después de crear el producto vas a poder agregar sus variantes y precios.")
      : [publishSection(), variantsSection, stockSection, imagesSection]
  );

  if (!isNew) await loadVariants();
}
