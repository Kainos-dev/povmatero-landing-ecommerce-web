// Alta de yerbas: #/productos/nueva-yerba
//   ?modo=nueva                       yerba nueva (marca, nombre…) con su primera presentación
//   ?modo=presentacion[&producto=61]  presentación nueva (500 g, 1 kg…) de una yerba que ya existe
// La presentación es una variante del mismo producto: comparte nombre, marca,
// descripción, fotos e imagen general de góndola, y tiene su propio SKU,
// precio, costo, stock e imagen de góndola opcional. Ver api/yerbas.js.
import { h, mount, field, showError, toast, errorMessage, slugify, SLUG_RE, formatPrice, normalizeText } from "../ui.js";
import { icon } from "../icons.js";
import * as yerbasApi from "../api/yerbas.js";
import { updateProduct } from "../api/catalog.js";
import { newKey } from "../api/stockTools.js";
import { uploadShelfImage, inspectImage, productTarget, variantTarget, TYPES as SHELF_TYPES } from "../api/shelfImages.js";
import { shelfOrderReady } from "../api/shelfOrder.js";

// ---------------------------------------------------------------------
// Casilla «Otras marcas» (alta y ficha de yerbas). Es de la yerba: todas sus
// presentaciones van a la misma góndola. La marca real no se borra.
//   brandInput: el campo Marca (para explicar a qué góndola va)
// Devuelve { el, input }.
// ---------------------------------------------------------------------
export function otherBrandsField({ checked = false, brandInput }) {
  const input = h("input", { type: "checkbox", checked, "data-field": "shelf-other" });
  const note = h("small", { class: "hint", "aria-live": "polite" });
  const refresh = () => {
    const brand = String(brandInput?.value ?? "").trim().replace(/\s+/g, " ");
    note.textContent = !brand
      ? "Sin marca: va a «Otras marcas»."
      : input.checked
        ? `Se muestra en «Otras marcas». La marca ${brand} se conserva.`
        : `Se muestra en la góndola ${brand}.`;
  };
  input.addEventListener("change", refresh);
  brandInput?.addEventListener("input", refresh);
  brandInput?.addEventListener("change", refresh);
  refresh();
  const el = h("div", { class: "field" }, h("span", {}, "Góndola"),
    h("label", { class: "check check-inline" }, input, h("span", {}, "Otras marcas")),
    note);
  return { el, input };
}

const round2 = (n) => Math.round(n * 100) / 100;
// "6800", "6.800", "6800,50", "$ 6.800" → número; "" → null; inválido → NaN.
export function readNumber(text) {
  let t = String(text ?? "").trim().replace(/^\$\s*/, "").replace(/\s+/g, "");
  if (t === "") return null;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, "");
  const n = Number(t);
  return Number.isFinite(n) ? round2(n) : NaN;
}
export function readInt(text) {
  const t = String(text ?? "").trim();
  if (t === "") return 0;
  return /^\d+$/.test(t) ? Number(t) : NaN;
}
const money = (value, label, placeholder = "") => h("input", {
  class: "input", type: "text", inputmode: "decimal", autocomplete: "off", value: value == null ? "" : String(value), placeholder, "aria-label": label,
});

// ---------------------------------------------------------------------
// Campos de una presentación (se usan en las dos altas y en la ficha).
//   existing: presentaciones que ya tiene la yerba (se marcan «ya existe»)
// Devuelve { el, read(), focus() }.
// ---------------------------------------------------------------------
export function presentationFields({ existing = [], imageLabel = "Imagen de góndola de esta presentación (opcional)", imageHint } = {}) {
  let chosen = null;          // gramos del preset elegido, "otra" o null
  const presetButtons = [];
  const custom = h("input", { class: "input", maxlength: "40", placeholder: "Ej. 250 g, 3 kg, Pack x3", "aria-label": "Otra presentación", hidden: true });
  const presets = h("div", { class: "pres-presets", role: "radiogroup", "aria-label": "Presentación" });

  for (const p of yerbasApi.PRESETS) {
    const taken = yerbasApi.findSamePresentation(existing, `${p.grams}gr`);
    const b = h("button", { type: "button", class: "pres-chip", role: "radio", "aria-checked": "false", disabled: !!taken, "data-grams": String(p.grams) },
      h("strong", {}, p.label), taken ? h("small", {}, "ya la tiene") : null);
    b.addEventListener("click", () => choose(p.grams));
    presetButtons.push(b);
    presets.append(b);
  }
  const other = h("button", { type: "button", class: "pres-chip", role: "radio", "aria-checked": "false" }, h("strong", {}, "Otra"));
  other.addEventListener("click", () => choose("otra"));
  presetButtons.push(other);
  presets.append(other);

  function choose(value) {
    chosen = value;
    for (const b of presetButtons) {
      const on = b === other ? value === "otra" : Number(b.dataset.grams) === value;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", String(on));
    }
    custom.hidden = value !== "otra";
    if (value === "otra") custom.focus();
  }
  // Por defecto, la primera que todavía no tiene (500 g o 1 kg).
  const firstFree = [500, 1000].find((g) => !yerbasApi.findSamePresentation(existing, `${g}gr`));
  if (firstFree) choose(firstFree);

  const sku = h("input", { class: "input", maxlength: "64", autocomplete: "off", placeholder: "Ej. 2559", "aria-label": "SKU de la presentación" });
  const price = money(null, "Precio de venta", "Ej. 6800");
  const cost = money(null, "Costo", "Opcional");
  const stock = h("input", { class: "input", type: "text", inputmode: "numeric", value: "0", "aria-label": "Stock inicial" });
  const active = h("input", { type: "checkbox", checked: true });
  const marginText = h("span", { class: "margin-hint" });
  const refreshMargin = () => {
    const p = readNumber(price.value), c = readNumber(cost.value);
    marginText.textContent = p > 0 && c != null && !Number.isNaN(c) ? `Margen ${Math.round(((p - c) / p) * 100)} %` : "";
  };
  price.addEventListener("input", refreshMargin);
  cost.addEventListener("input", refreshMargin);

  const file = h("input", { type: "file", accept: Object.keys(SHELF_TYPES).join(","), class: "input pres-file", "aria-label": imageLabel });
  const fileNote = h("p", { class: "hint", role: "status" });
  let fileOk = null;
  file.addEventListener("change", async () => {
    fileOk = null;
    const f = file.files?.[0];
    if (!f) { fileNote.textContent = ""; return; }
    if (!SHELF_TYPES[f.type]) { fileNote.textContent = "Tiene que ser un PNG (o WebP), idealmente con fondo transparente."; file.value = ""; return; }
    fileNote.textContent = "Revisando la imagen…";
    try {
      const info = await inspectImage(f);
      fileOk = f;
      fileNote.textContent = `${f.name} · ${info.width} × ${info.height} px · ${Math.round(f.size / 1024)} KB` + (info.warnings.length ? ` · ${info.warnings.join(" ")}` : "");
    } catch (err) {
      fileNote.textContent = err.message;
      file.value = "";
    }
  });

  const el = h("div", { class: "pane-stack" },
    h("div", { class: "field" }, h("span", {}, "Presentación"), presets, custom),
    h("div", { class: "form-grid form-grid-3" },
      field("SKU", sku, "Código del proveedor de esta presentación."),
      field("Precio de venta", price),
      field("Costo", cost, "Interno: no se muestra en la tienda.")),
    h("div", { class: "form-grid form-grid-3" },
      field("Stock inicial", stock, "Unidades que tenés hoy. Se registra como entrada «Stock inicial»."),
      h("div", { class: "field" }, h("span", {}, "Tienda"),
        h("label", { class: "check check-inline" }, active, h("span", {}, "Mostrar esta presentación")),
        h("small", { class: "hint" }, "Se ve cuando la yerba está publicada.")),
      h("div", { class: "field" }, h("span", {}, "Margen"), marginText)),
    h("div", { class: "field" }, h("span", {}, imageLabel), file,
      h("small", { class: "hint" }, imageHint ?? "Solo si el paquete es distinto (por ejemplo, donde se lee «500 g»). Si no, usa la imagen general de la yerba."),
      fileNote));

  return {
    el,
    read() {
      const name = chosen === "otra" ? custom.value.trim() : chosen ? `${chosen}gr` : "";
      return {
        name: yerbasApi.presentationName(name),
        sku: sku.value,
        price: readNumber(price.value),
        cost: readNumber(cost.value),
        stock: readInt(stock.value),
        isActive: active.checked,
        shelfFile: fileOk,
      };
    },
    focus: () => price.focus(),
  };
}

// ---------------------------------------------------------------------
// Buscador de yerbas existentes
// ---------------------------------------------------------------------
function yerbaPicker(yerbas, { onPick }) {
  const input = h("input", { type: "search", class: "input", placeholder: "Buscar yerba o marca… (ej. Canarias Suave)", "aria-label": "Buscar yerba" });
  const list = h("ul", { class: "pick-list", role: "listbox", "aria-label": "Yerbas" });
  function paint() {
    const words = normalizeText(input.value.trim()).split(/\s+/).filter(Boolean);
    const visible = yerbas.filter((y) => words.every((w) => normalizeText(`${y.name} ${y.brand ?? ""}`).includes(w)));
    mount(list, visible.length ? visible.map((y) => {
      const b = h("button", { type: "button", class: "pick-item", role: "option", "data-product": String(y.id) },
        h("span", { class: "pick-name" }, y.name,
          h("small", {}, [y.brand || "Otras marcas", y.is_active ? null : "Borrador"].filter(Boolean).join(" · "))),
        h("span", { class: "pick-meta muted" }, y.variants.length
          ? y.variants.map((v) => yerbasApi.presentationLabel(v.name) + (v.is_active ? "" : " (oculta)")).join(" · ")
          : "Sin presentaciones"));
      b.addEventListener("click", () => onPick(y));
      return h("li", {}, b);
    }) : h("li", { class: "muted pick-empty" }, "No hay yerbas con ese nombre. Si es nueva, elegí «Yerba nueva»."));
  }
  input.addEventListener("input", paint);
  paint();
  return { el: h("div", { class: "picker" }, input, list), focus: () => input.focus() };
}

// ---------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------
export async function renderYerbaCreate(view, query = {}) {
  mount(view, h("p", { class: "muted" }, "Cargando yerbas…"));
  let category, yerbas, brands, shelfReady;
  try {
    [category, yerbas, brands, shelfReady] = await Promise.all([yerbasApi.yerbasCategory(), yerbasApi.listYerbas(), yerbasApi.listBrands(), shelfOrderReady()]);
  } catch (err) {
    console.error(err);
    mount(view, backLink(), h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }
  if (!category) {
    mount(view, backLink(), h("p", { class: "form-error" }, "No existe la categoría «Yerbas»."));
    return;
  }

  let mode = query.modo === "nueva" ? "nueva" : "presentacion";
  const preselected = query.producto ? yerbas.find((y) => y.id === Number(query.producto)) ?? null : null;
  const body = h("div", { class: "pane-stack" });

  const modeBox = h("div", { class: "choice-grid", role: "radiogroup", "aria-label": "Qué querés cargar" });
  function drawModes() {
    mount(modeBox, [
      ["presentacion", "Presentación de una yerba existente", "Ej. ya tenés Canarias Suave 1 kg y sumás la de 500 g. Usa la marca, las fotos y la imagen de la yerba."],
      ["nueva", "Yerba nueva", "Una yerba que todavía no está en el catálogo, con su primera presentación."],
    ].map(([key, title, detail]) => {
      const input = h("input", { type: "radio", name: "yerba-mode", value: key, checked: key === mode });
      input.addEventListener("change", () => {
        mode = key;
        history.replaceState(null, "", `#/productos/nueva-yerba?modo=${key}`);
        drawModes();
        draw();
      });
      return h("label", { class: key === mode ? "choice active" : "choice" }, input,
        h("span", { class: "choice-text" }, h("strong", {}, title), h("span", {}, detail)));
    }));
  }

  // ---------- Presentación de una yerba existente ----------
  function drawPresentation(selected) {
    if (!selected) {
      const picker = yerbaPicker(yerbas, { onPick: (y) => {
        history.replaceState(null, "", `#/productos/nueva-yerba?modo=presentacion&producto=${y.id}`);
        drawPresentation(y);
      } });
      mount(body, h("section", { class: "card" }, h("h3", {}, "1. Elegí la yerba"), picker.el));
      picker.focus();
      return;
    }
    const fields = presentationFields({ existing: selected.variants });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, icon("plus"), "Agregar presentación");
    let stockKey = null;    // misma clave en los reintentos: el stock inicial no se duplica
    const form = h("form", { class: "card", novalidate: true },
      h("h3", {}, "2. Datos de la presentación"),
      fields.el, error, h("div", { class: "actions" }, submit));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = fields.read();
      const problem = yerbasApi.presentationProblem(data, selected.variants);
      if (problem) { showError(error, problem); return; }
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Guardando…";
      stockKey ??= newKey();
      try {
        const result = await yerbasApi.createPresentation(selected, data, { stockKey });
        if (data.shelfFile) {
          try { await uploadShelfImage(variantTarget(selected, { id: result.variantId, shelf_image: null }), data.shelfFile); }
          catch (err) { console.error(err); result.problems.push("la imagen de góndola"); }
        }
        finish(selected.id, `${selected.name} ${yerbasApi.presentationLabel(data.name)}`, result.problems, false);
      } catch (err) {
        if (err.code !== "INVALID" && err.code !== "SKU_TAKEN") console.error(err);
        showError(error, err.code === "INVALID" || err.code === "SKU_TAKEN" ? err.message : errorMessage(err));
        submit.disabled = false;
        submit.textContent = "Agregar presentación";
      }
    });

    mount(body,
      h("section", { class: "card" },
        h("h3", {}, "1. Yerba"),
        h("div", { class: "pick-chosen" },
          h("strong", {}, selected.name),
          h("span", { class: "muted" }, [selected.brand || "Otras marcas", selected.is_active ? "Publicada" : "Borrador"].join(" · ")),
          h("button", { type: "button", class: "btn-ghost btn-sm", onClick: () => { history.replaceState(null, "", "#/productos/nueva-yerba?modo=presentacion"); drawPresentation(null); } }, "Cambiar")),
        selected.variants.length
          ? h("ul", { class: "pres-existing" }, selected.variants.map((v) => h("li", {},
              h("strong", {}, yerbasApi.presentationLabel(v.name)),
              h("span", { class: "muted" }, `${formatPrice(v.price)} · stock ${v.track_stock ? v.stock : "sin control"}${v.is_active ? "" : " · oculta"}`))))
          : h("p", { class: "muted" }, "Todavía no tiene presentaciones."),
        h("p", { class: "hint" }, "Marca, nombre, descripción y fotos son los de esta yerba: no se duplican.")),
      form);
    fields.focus();
  }

  // ---------- Yerba nueva ----------
  function drawNew() {
    const brandList = h("datalist", { id: "yerba-brands" }, brands.map((b) => h("option", { value: b })));
    const brand = h("input", { class: "input", maxlength: "60", list: "yerba-brands", autocomplete: "off", placeholder: "Ej. Canarias", "aria-label": "Marca" });
    const name = h("input", { class: "input", maxlength: "120", autocomplete: "off", placeholder: "Ej. Canarias Suave", "aria-label": "Nombre" });
    const slug = h("input", { class: "input", maxlength: "140", "aria-label": "Slug" });
    const description = h("textarea", { class: "input", rows: "3", "aria-label": "Descripción" });
    const publish = h("input", { type: "checkbox" });
    const other = shelfReady ? otherBrandsField({ brandInput: brand }) : null;
    const dupe = h("p", { class: "notice-warn", hidden: true });
    const fields = presentationFields({
      imageLabel: "Imagen de góndola (PNG, opcional)",
      imageHint: "Se usa para todas sus presentaciones. También la podés cargar después en «Góndola».",
    });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, icon("plus"), "Crear yerba");
    let slugTouched = false;
    let stockKey = null;
    let createdId = null;    // si la yerba ya se creó y falló la presentación, no se crea otra

    slug.addEventListener("input", () => { slugTouched = true; });
    const syncName = () => {
      if (!slugTouched) slug.value = slugify(name.value);
      const same = yerbasApi.findYerbaByName(yerbas, name.value);
      dupe.hidden = !same;
      if (same) {
        mount(dupe, `Ya existe «${same.name}». Si es otra presentación de esa yerba, `,
          h("a", { href: `#/productos/nueva-yerba?modo=presentacion&producto=${same.id}` }, "agregala a la existente"), ".");
      }
    };
    name.addEventListener("input", syncName);
    // Al escribir la marca, se sugiere el comienzo del nombre.
    brand.addEventListener("change", () => {
      const b = yerbasApi.matchBrand(brands, brand.value);
      if (b) brand.value = b;
      if (!name.value.trim() && b) { name.value = `${b} `; syncName(); }
    });

    const form = h("form", { class: "card", novalidate: true },
      h("h3", {}, "Datos de la yerba"),
      h("div", { class: "form-grid" },
        field("Marca", brand, "Arma las góndolas de /yerbas. Vacío = «Otras marcas»."),
        field("Nombre", name, "Como se ve en la tienda, sin el peso (ej. Canarias Suave)."),
        field("Slug", slug, "Para la URL. Se genera a partir del nombre."),
        h("div", { class: "field" }, h("span", {}, "Publicación"),
          h("label", { class: "check check-inline" }, publish, h("span", {}, "Publicar al crear")),
          h("small", { class: "hint" }, "Sin marcar queda en borrador: no se ve en la tienda hasta que la publiques.")),
        other?.el),
      dupe,
      field("Descripción", description),
      brandList,
      h("h3", {}, "Primera presentación"),
      fields.el,
      error,
      h("div", { class: "actions" }, submit));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const data = fields.read();
      const yerba = {
        brand: yerbasApi.matchBrand(brands, brand.value),
        name: name.value.trim().replace(/\s+/g, " "),
        slug: slug.value.trim(),
        description: description.value.trim(),
        publish: publish.checked,
        shelfOther: other ? other.input.checked : undefined,
      };
      const problem =
        createdId ? null :
        !yerba.name ? "El nombre es obligatorio." :
        !SLUG_RE.test(yerba.slug) ? "El slug solo puede tener minúsculas, números y guiones (ej. canarias-suave)." :
        yerba.brand && yerba.brand.length > 60 ? "La marca puede tener hasta 60 caracteres." :
        yerbasApi.presentationProblem(data, []);
      if (problem) { showError(error, problem); return; }
      error.hidden = true;
      submit.disabled = true;
      submit.textContent = "Guardando…";
      stockKey ??= newKey();
      try {
        let result;
        if (createdId) {
          // Reintento: la yerba ya existe (en borrador); solo falta la presentación.
          result = { productId: createdId, ...(await yerbasApi.createPresentation({ id: createdId, name: yerba.name, variants: [] }, data, { stockKey })) };
          if (yerba.publish) await updateProduct(createdId, { is_active: true }).catch(() => result.problems.push("publicarla (quedó en borrador)"));
        } else {
          result = await yerbasApi.createYerba(category.id, yerba, data, { stockKey });
        }
        if (data.shelfFile) {
          try { await uploadShelfImage(productTarget({ id: result.productId, shelf_image: null }), data.shelfFile); }
          catch (err) { console.error(err); result.problems.push("la imagen de góndola"); }
        }
        finish(result.productId, `${yerba.name} ${yerbasApi.presentationLabel(data.name)}`, result.problems, true);
      } catch (err) {
        if (err.code !== "INVALID" && err.code !== "SKU_TAKEN") console.error(err);
        if (err.productId) {
          createdId = err.productId;
          showError(error, `La yerba se creó en borrador, pero no la presentación: ${err.code === "INVALID" || err.code === "SKU_TAKEN" ? err.message : errorMessage(err)} Corregí y volvé a guardar.`);
        } else {
          showError(error, err.code === "INVALID" || err.code === "SKU_TAKEN" ? err.message : errorMessage(err));
        }
        submit.disabled = false;
        submit.textContent = createdId ? "Guardar presentación" : "Crear yerba";
      }
    });

    mount(body, form);
    brand.focus();
  }

  function finish(productId, label, problems, isNew) {
    if (problems.length) {
      toast(`${label} se guardó, pero faltó guardar ${problems.join(", ")}. Completalo en su ficha.`, "error");
    } else {
      toast(isNew ? `Yerba creada: ${label}.` : `Presentación agregada: ${label}.`);
    }
    location.hash = `#/productos/${productId}?tab=precios`;
  }

  function draw() {
    if (mode === "nueva") drawNew();
    else drawPresentation(mode === "presentacion" ? preselectedOnce() : null);
  }
  let usedPreselected = false;
  const preselectedOnce = () => { if (usedPreselected) return null; usedPreselected = true; return preselected; };

  drawModes();
  mount(view,
    backLink(),
    h("div", { class: "page-header" }, h("div", { class: "title-block" },
      h("h2", {}, "Nueva yerba o presentación"),
      h("p", { class: "page-sub" }, "Cada presentación (500 g, 1 kg…) tiene su SKU, precio, costo y stock, dentro de la misma yerba."))),
    modeBox,
    body);
  draw();
}

function backLink() {
  return h("a", { href: "#/productos", class: "back-link" }, "← Volver a productos");
}
