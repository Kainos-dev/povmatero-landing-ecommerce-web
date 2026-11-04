// Ficha de una yerba › Presentaciones: cada presentación (500 g, 1 kg…) con
// su SKU, precio de venta, costo, stock e imagen de góndola, y el alta de
// una presentación nueva en la misma yerba (no se duplica la yerba).
import { h, mount, toast, errorMessage } from "../ui.js";
import { icon } from "../icons.js";
import * as api from "../api/catalog.js";
import * as yerbasApi from "../api/yerbas.js";
import { presentationFields, readNumber } from "./yerbaCreate.js";
import { uploadShelfImage, variantTarget } from "../api/shelfImages.js";
import { newKey } from "../api/stockTools.js";

//   product:   { id, name, slug, is_active }
//   internal:  { sku, base_cost }  (SKU general de la yerba, si tiene)
//   variants:  presentaciones (api.listVariants)
//   onChanged: recarga la ficha · openStock(variantId): movimientos de stock
export async function renderYerbaPresentations(container, { product, internal, variants, onChanged, openStock }) {
  mount(container, h("p", { class: "muted" }, "Cargando presentaciones…"));
  let skus;
  try {
    skus = await yerbasApi.listVariantSkus(variants.map((v) => v.id));
  } catch (err) {
    console.error(err);
    mount(container, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }
  const generalSku = internal.sku ?? null;
  const sorted = [...variants].sort((a, b) =>
    yerbasApi.presentationSort(a.name, a.sort_order) - yerbasApi.presentationSort(b.name, b.sort_order) || a.id - b.id);

  function card(v) {
    const ownSku = skus.get(v.id) ?? null;
    const name = h("input", { class: "input variant-name", maxlength: "80", value: v.name, "aria-label": "Presentación" });
    const sku = h("input", { class: "input", maxlength: "64", autocomplete: "off", value: ownSku ?? "",
      placeholder: generalSku ? `General: ${generalSku}` : "Sin SKU", "aria-label": `SKU de ${v.name}` });
    const price = h("input", { class: "input", type: "text", inputmode: "decimal", value: String(v.price), "aria-label": `Precio de ${v.name}` });
    const cost = h("input", { class: "input", type: "text", inputmode: "decimal", value: v.cost == null ? "" : String(v.cost), placeholder: "Sin costo", "aria-label": `Costo de ${v.name}` });
    const active = h("input", { type: "checkbox", checked: v.is_active });
    const marginText = h("span", { class: "margin-hint" });
    const save = h("button", { type: "button", class: "btn-primary btn-sm", hidden: true }, "Guardar");
    const discard = h("button", { type: "button", class: "btn-ghost btn-sm", hidden: true }, "Descartar");

    const refreshMargin = () => {
      const p = readNumber(price.value), c = readNumber(cost.value);
      marginText.textContent = p > 0 && c != null && !Number.isNaN(c) ? `Margen ${Math.round(((p - c) / p) * 100)} %` : "";
    };
    refreshMargin();

    const el = h("article", { class: v.is_active ? "variant-card" : "variant-card is-inactive", "data-variant": String(v.id) },
      h("div", { class: "variant-head" },
        h("strong", { class: "pres-label" }, yerbasApi.presentationLabel(v.name)),
        h("label", { class: "check check-inline" }, active, h("span", {}, "Se muestra"))),
      h("div", { class: "pres-fields" },
        h("label", { class: "vfield" }, h("span", { class: "vfield-label" }, "Presentación"), name),
        h("label", { class: "vfield" }, h("span", { class: "vfield-label" }, "SKU"), sku),
        h("label", { class: "vfield" }, h("span", { class: "vfield-label" }, "Precio de venta"), price),
        h("label", { class: "vfield" }, h("span", { class: "vfield-label" }, "Costo"), cost)),
      h("div", { class: "variant-foot" },
        marginText,
        h("span", { class: "variant-stock" }, v.track_stock ? ["Stock: ", h("strong", { class: v.stock === 0 ? "text-alert" : "" }, String(v.stock))] : "Sin control de stock"),
        v.track_stock ? h("button", { type: "button", class: "link-btn", onClick: () => openStock(v.id) }, "Movimientos") : null,
        h("a", { class: "link-btn", href: `#/gondola?q=${encodeURIComponent(product.name)}` }, "Imagen de góndola"),
        h("span", { class: "variant-actions" }, discard, save)));

    const markDirty = () => { save.hidden = false; discard.hidden = false; el.classList.add("is-dirty"); refreshMargin(); };
    [name, sku, price, cost].forEach((x) => x.addEventListener("input", markDirty));
    active.addEventListener("change", markDirty);
    discard.addEventListener("click", () => onChanged());

    save.addEventListener("click", async () => {
      const newName = yerbasApi.presentationName(name.value);
      const p = readNumber(price.value), c = readNumber(cost.value);
      const newSku = api.normalizeSku(sku.value);
      const others = variants.filter((x) => x.id !== v.id);
      const same = newName !== v.name ? yerbasApi.findSamePresentation(others, newName) : null;
      const problem =
        !newName ? "La presentación necesita un nombre (ej. 500 g)." :
        same ? `Ya existe la presentación ${yerbasApi.presentationLabel(same.name)} en esta yerba.` :
        p == null || Number.isNaN(p) || p <= 0 ? "El precio de venta debe ser mayor a 0 (si no se vende, desmarcá «Se muestra»)." :
        Number.isNaN(c) || (c != null && c < 0) ? "El costo debe ser un número mayor o igual a 0 (o vacío)." :
        newSku && newSku.length > 64 ? "El SKU puede tener hasta 64 caracteres." :
        null;
      if (problem) { toast(problem, "error"); return; }
      // Ocultar la última presentación visible de una yerba publicada la deja sin nada para comprar.
      if (!active.checked && v.is_active && product.is_active && !others.some((x) => x.is_active && x.price > 0)) {
        if (!confirm(`«${product.name}» quedaría publicada sin ninguna presentación a la venta. ¿Ocultar igual?`)) return;
      }

      save.disabled = true;
      save.textContent = "Guardando…";
      try {
        if (newSku && newSku !== ownSku) {
          const owner = await yerbasApi.findSkuOwner(newSku, { productId: product.id, variantId: v.id });
          if (owner) throw Object.assign(new Error(yerbasApi.skuTakenMessage(newSku, owner)), { code: "SKU_TAKEN" });
        }
        const fields = {};
        if (newName !== v.name) fields.name = newName;
        if (p !== v.price) fields.price = p;
        if (active.checked !== v.is_active) fields.is_active = active.checked;
        if (Object.keys(fields).length) await api.updateVariant(v.id, fields);
        if (c !== v.cost) await api.saveVariantCost(v.id, c);
        if (newSku !== ownSku) await yerbasApi.saveVariantSku(v.id, newSku);
        toast(`${product.name} ${yerbasApi.presentationLabel(newName)}: guardado.`);
        await onChanged();
      } catch (err) {
        if (err.code !== "INVALID" && err.code !== "SKU_TAKEN") console.error(err);
        toast(err.code === "SKU_TAKEN" ? err.message : errorMessage(err), "error");
        save.disabled = false;
        save.textContent = "Guardar";
      }
    });
    return el;
  }

  // ---------- Agregar presentación ----------
  const addSlot = h("div");
  function drawAddButton() {
    mount(addSlot, h("button", { type: "button", class: "btn-primary btn-inline", onClick: drawAddForm }, icon("plus"), "Agregar presentación"));
  }
  function drawAddForm() {
    const fields = presentationFields({ existing: variants });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, icon("plus"), "Agregar presentación");
    const cancel = h("button", { type: "button", class: "btn-ghost", onClick: drawAddButton }, "Cancelar");
    const stockKey = newKey();
    const form = h("form", { class: "card new-variant-card", novalidate: true },
      h("h3", {}, `Nueva presentación de ${product.name}`),
      h("p", { class: "muted" }, "Usa la marca, las fotos y la imagen general de esta yerba."),
      fields.el, error, h("div", { class: "actions" }, submit, cancel));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = fields.read();
      const problem = yerbasApi.presentationProblem(data, variants);
      if (problem) { error.textContent = problem; error.hidden = false; return; }
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Guardando…";
      try {
        const result = await yerbasApi.createPresentation({ ...product, variants }, data, { stockKey });
        if (data.shelfFile) {
          try { await uploadShelfImage(variantTarget(product, { id: result.variantId, shelf_image: null }), data.shelfFile); }
          catch (err) { console.error(err); result.problems.push("la imagen de góndola"); }
        }
        const label = `${product.name} ${yerbasApi.presentationLabel(data.name)}`;
        toast(result.problems.length ? `${label} se agregó, pero faltó guardar ${result.problems.join(", ")}.` : `Presentación agregada: ${label}.`,
          result.problems.length ? "error" : "ok");
        await onChanged();
      } catch (err) {
        if (err.code !== "INVALID" && err.code !== "SKU_TAKEN") console.error(err);
        error.textContent = err.code === "INVALID" || err.code === "SKU_TAKEN" ? err.message : errorMessage(err);
        error.hidden = false;
        submit.disabled = false;
        submit.textContent = "Agregar presentación";
      }
    });
    mount(addSlot, form);
    fields.focus();
    form.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }
  drawAddButton();

  const visible = variants.filter((v) => v.is_active).length;
  mount(container,
    h("section", { class: "pane-stack" },
      h("div", { class: "section-head" },
        h("h3", {}, `Presentaciones (${variants.length})`),
        h("span", { class: "muted" }, variants.length
          ? `${visible} ${visible === 1 ? "se muestra" : "se muestran"} en la tienda${product.is_active ? "" : " cuando publiques la yerba"}`
          : "")),
      variants.length
        ? h("div", { class: "variant-grid" }, sorted.map(card))
        : h("p", { class: "empty-box" }, "Esta yerba todavía no tiene presentaciones."),
      generalSku ? h("p", { class: "hint" }, `SKU general de la yerba: ${generalSku}. Lo usan las presentaciones sin SKU propio (por ejemplo, en «Importar precios»).`) : null),
    addSlot);
}

// Resumen para el encabezado: «500 g · 1 kg».
export function presentationsSummary(variants) {
  return [...variants]
    .sort((a, b) => yerbasApi.presentationSort(a.name, a.sort_order) - yerbasApi.presentationSort(b.name, b.sort_order))
    .map((v) => yerbasApi.presentationLabel(v.name)).join(" · ");
}

