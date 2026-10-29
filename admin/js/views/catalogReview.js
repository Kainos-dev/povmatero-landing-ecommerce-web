// Revisión del catálogo: qué falta o no coincide antes de publicar.
// Cruza la base con las fuentes actuales de la tienda (js/products.js y la hoja
// WEB). Solo lee: no cambia nada.
import * as api from "../api/catalog.js";
import { isSimpleProduct } from "../api/catalog.js";
import { listAllImages, imageSource } from "../api/images.js";
import { h, mount, errorMessage, formatPrice, toast } from "../ui.js";

const SHEET_URL = "https://opensheet.elk.sh/1TFmZ1hbO5bXh5MGktpUzM7MJTZwyoknVLyVHRNBbwso/WEB";

// Precio de la hoja: "$5,600" → 5600 (mismo criterio que la tienda actual).
function sheetPrice(text) {
  const n = Number(String(text ?? "").replace("$", "").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

// level: "block" = no se puede publicar o no se vería; "warn" = revisar.
function issue(level, text) {
  return { level, text };
}

// Arma la revisión a partir de los datos ya cargados. Exportada para pruebas.
export function reviewCatalog({ categories, products, variants, images, legacyIds, legacyProducts, sheetRows }) {
  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const variantsByProduct = new Map();
  for (const v of variants) {
    if (!variantsByProduct.has(v.product_id)) variantsByProduct.set(v.product_id, []);
    variantsByProduct.get(v.product_id).push(v);
  }
  const imagesByProduct = new Map();
  for (const i of images) {
    if (!imagesByProduct.has(i.product_id)) imagesByProduct.set(i.product_id, []);
    imagesByProduct.get(i.product_id).push(i);
  }
  const legacyByProduct = new Map(legacyIds.map((l) => [l.product_id, l.legacy_id]));
  const legacyById = new Map((legacyProducts ?? []).map((p) => [p.id, p]));
  const sheetById = new Map((sheetRows ?? []).map((r) => [Number(r.ID), r]));

  const rows = products.map((p) => {
    const vs = variantsByProduct.get(p.id) ?? [];
    const active = vs.filter((v) => v.is_active);
    const sellable = active.filter((v) => v.price > 0);
    const imgs = imagesByProduct.get(p.id) ?? [];
    const category = categoryById.get(p.category_id);
    const isYerba = category?.slug === "yerbas";
    const issues = [];

    if (!vs.length) issues.push(issue("block", "Sin precio cargado"));
    else if (!sellable.length) issues.push(issue("block", "Ninguna variante activa con precio mayor a 0"));
    if (!category) issues.push(issue("block", "Sin categoría"));
    else if (!category.is_active) issues.push(issue("block", `Categoría "${category.name}" desactivada`));

    if (!imgs.length) {
      issues.push(issue("warn", isYerba ? "Sin foto propia (usa la foto de respaldo)" : "Sin imágenes (usa el logo)"));
    } else {
      if (!imgs.some((i) => i.is_cover)) issues.push(issue("warn", "Sin portada (usa la primera foto de una variante)"));
      const repo = imgs.filter((i) => imageSource(i.src) === "repo").length;
      if (repo) issues.push(issue("warn", `${repo} ${repo === 1 ? "imagen" : "imágenes"} en la carpeta del sitio, sin migrar a Storage`));
      const ext = imgs.filter((i) => imageSource(i.src) === "external").length;
      if (ext) issues.push(issue("warn", `${ext} ${ext === 1 ? "imagen externa" : "imágenes externas"}`));
    }
    if (!isYerba && !String(p.description ?? "").trim()) issues.push(issue("warn", "Sin descripción"));

    const tracked = active.filter((v) => v.track_stock);
    if (tracked.length && tracked.every((v) => v.stock === 0)) {
      issues.push(issue("warn", "Controla stock y está todo en 0: se verá sin stock"));
    }

    // Comparación con las fuentes actuales de la tienda.
    const legacyId = legacyByProduct.get(p.id);
    const legacy = legacyId != null ? legacyById.get(legacyId) : null;
    if (legacy && !legacy.variants && vs.length === 1 && vs[0].price !== Number(legacy.price)) {
      issues.push(issue("warn", `Precio distinto de products.js (${formatPrice(legacy.price)})`));
    }
    for (const v of vs) {
      if (v.sheet_id == null || !sheetById.size) continue;
      const r = sheetById.get(v.sheet_id);
      if (!r) { issues.push(issue("warn", `${v.name}: ya no está en la hoja WEB`)); continue; }
      const sp = sheetPrice(r.Precio);
      if (sp > 0 && sp !== v.price) issues.push(issue("warn", `${v.name}: precio ${formatPrice(v.price)}, en la hoja ${formatPrice(sp)}`));
      const ss = Number(String(r.Stock ?? "").trim() || 0);
      if (v.track_stock && Number.isInteger(ss) && ss !== v.stock) issues.push(issue("warn", `${v.name}: stock ${v.stock}, en la hoja ${ss}`));
    }

    // Listo para publicar: sin bloqueos, con foto propia ya en Storage y con algo
    // que se pueda comprar hoy (variante sin control de stock o con stock > 0).
    const repoCount = imgs.filter((i) => imageSource(i.src) === "repo").length;
    const buyableNow = sellable.some((v) => !v.track_stock || v.stock > 0);
    const blockedNow = issues.some((i) => i.level === "block");
    const notReady = blockedNow ? "Tiene problemas que impiden publicar"
      : !imgs.length ? "Sin imágenes"
      : repoCount ? "Imágenes sin migrar a Storage"
      : !buyableNow ? "Sin stock cargado"
      : null;

    return {
      product: p,
      category,
      ready: !notReady,
      notReady,
      variants: vs,
      activeCount: active.length,
      imageCount: imgs.length,
      withoutSku: vs.filter((v) => !v.sku).length,
      withoutCost: vs.filter((v) => v.cost == null).length,
      issues,
      blocked: issues.some((i) => i.level === "block"),
    };
  });

  // Lo que está en las fuentes y no en la base.
  const importedLegacy = new Set(legacyIds.map((l) => l.legacy_id));
  const missingLegacy = (legacyProducts ?? []).filter((p) => !importedLegacy.has(p.id));
  const importedSheet = new Set(variants.map((v) => v.sheet_id).filter((id) => id != null));
  const sheetWithoutPrice = (sheetRows ?? []).filter((r) => !(sheetPrice(r.Precio) > 0));
  const missingSheet = (sheetRows ?? []).filter((r) => sheetPrice(r.Precio) > 0 && !importedSheet.has(Number(r.ID)));

  return { rows, missingLegacy, missingSheet, sheetWithoutPrice, hasLegacy: !!legacyProducts, hasSheet: !!sheetRows };
}

async function loadSources() {
  const out = { legacyProducts: null, sheetRows: null, errors: [] };
  try {
    out.legacyProducts = (await import("/js/products.js")).products;
  } catch (err) {
    out.errors.push(`No se pudo leer js/products.js: ${err?.message || err}`);
  }
  try {
    const res = await fetch(SHEET_URL, { cache: "no-store" });
    if (!res.ok) throw new Error(`respondió ${res.status}`);
    out.sheetRows = await res.json();
  } catch (err) {
    out.errors.push(`No se pudo leer la hoja WEB: ${err?.message || err}`);
  }
  return out;
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, header, rows) {
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// compare: también compara con el catálogo anterior (js/products.js y hoja WEB).
// Por defecto el panel trabaja solo con Supabase.
export async function renderCatalogReview(view, { compare = false, filterValue = null } = {}) {
  mount(view, h("p", { class: "muted" }, "Revisando el catálogo…"));

  let result, sourceErrors;
  try {
    const noSources = { legacyProducts: null, sheetRows: null, errors: [] };
    const [categories, products, variants, images, legacyIds, sources] = await Promise.all([
      api.listCategories(), api.listProducts(), api.listAllVariantsWithCosts(), listAllImages(),
      compare ? api.listProductLegacyIds() : [], compare ? loadSources() : noSources,
    ]);
    sourceErrors = sources.errors;
    result = reviewCatalog({ categories, products, variants, images, legacyIds, ...sources });
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const { rows, missingLegacy, missingSheet, sheetWithoutPrice, hasLegacy, hasSheet } = result;
  const blocked = rows.filter((r) => r.blocked);
  const withWarnings = rows.filter((r) => !r.blocked && r.issues.length);
  const published = rows.filter((r) => r.product.is_active).length;
  const variantCount = rows.reduce((n, r) => n + r.variants.length, 0);
  const noSku = rows.reduce((n, r) => n + r.withoutSku, 0);
  const noCost = rows.reduce((n, r) => n + r.withoutCost, 0);

  const readyDrafts = rows.filter((r) => r.ready && !r.product.is_active);
  const filter = h("select", { class: "input", "aria-label": "Mostrar" },
    h("option", { value: "ready" }, `Listos para publicar (${readyDrafts.length} en borrador)`),
    h("option", { value: "issues" }, "Con observaciones"),
    h("option", { value: "block" }, "Solo lo que impide publicar"),
    h("option", { value: "all" }, "Todos los productos"));
  // Por defecto: los listos para publicar, si hay; si no, lo que tiene observaciones.
  filter.value = filterValue ?? (readyDrafts.length ? "ready" : "issues");
  const tableBox = h("div", { class: "table-wrap" });
  const publishBox = h("div");

  // Publicar los borradores listos (con confirmación). Solo cambia "publicado".
  function renderPublish(confirming = false, busy = false) {
    if (filter.value !== "ready" || !readyDrafts.length) { mount(publishBox); return; }
    if (!confirming) {
      mount(publishBox, h("div", { class: "actions" },
        h("button", { type: "button", class: "btn-primary btn-inline", onClick: () => renderPublish(true) },
          `Publicar ${readyDrafts.length} ${readyDrafts.length === 1 ? "producto listo" : "productos listos"}`)));
      return;
    }
    const yes = h("button", { type: "button", class: "btn-primary btn-inline", disabled: busy }, busy ? "Publicando…" : "Confirmar publicación");
    yes.addEventListener("click", async () => {
      renderPublish(true, true);
      try {
        const ids = readyDrafts.map((r) => r.product.id);
        const saved = await api.setProductsActive(ids, true);
        toast(saved.length === ids.length
          ? `${saved.length} productos publicados.`
          : `Se publicaron ${saved.length} de ${ids.length}. Revisá permisos o recargá.`, saved.length === ids.length ? "ok" : "error");
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
      }
      await renderCatalogReview(view, { compare, filterValue: "all" });
    });
    mount(publishBox, h("div", { class: "confirm-box" },
      h("p", {}, `Se van a publicar ${readyDrafts.length} productos: van a aparecer en la tienda que lee Supabase. `,
        "No se cambian precios, stock ni imágenes. Se pueden volver a borrador desde Productos."),
      h("p", { class: "muted" }, readyDrafts.map((r) => r.product.name).join(", ")),
      h("div", { class: "actions" }, yes,
        h("button", { type: "button", class: "btn-ghost", disabled: busy, onClick: () => renderPublish(false) }, "Cancelar"))));
  }

  function renderTable() {
    renderPublish();
    const list = rows.filter((r) =>
      filter.value === "all" ? true
      : filter.value === "ready" ? r.ready && !r.product.is_active
      : filter.value === "block" ? r.blocked : r.issues.length > 0);
    if (!list.length) {
      mount(tableBox, h("p", { class: "muted" }, filter.value === "ready"
        ? "No hay borradores listos para publicar. Usá “Todos los productos” para ver qué le falta a cada uno."
        : "No hay productos para mostrar con este filtro."));
      return;
    }
    mount(tableBox, h("table", { class: "table" },
      h("thead", {}, h("tr", {},
        h("th", {}, "Producto"), h("th", {}, "Categoría"), h("th", {}, "Estado"),
        h("th", {}, "Variantes"), h("th", {}, "Imágenes"), h("th", {}, "Observaciones"))),
      h("tbody", {}, list.map((r) => h("tr", {},
        h("td", {}, h("a", { href: `#/productos/${r.product.id}` }, r.product.name)),
        h("td", {}, r.category?.name ?? "—"),
        h("td", {},
          h("span", { class: `badge ${r.product.is_active ? "badge-ok" : ""}` }, r.product.is_active ? "Publicado" : "Borrador"),
          r.product.is_active ? null : h("div", { class: "hint" }, r.ready ? "Listo para publicar" : r.notReady)),
        h("td", {}, !r.variants.length ? "—" : isSimpleProduct(r.variants) ? "Producto simple" : `${r.activeCount} de ${r.variants.length} activas`),
        h("td", {}, String(r.imageCount)),
        h("td", {}, r.issues.length
          ? h("div", { class: "image-badges" }, r.issues.map((i) =>
              h("span", { class: `badge ${i.level === "block" ? "badge-error" : "badge-warn"}` }, i.text)))
          : h("span", { class: "muted" }, "Todo bien")))))));
  }
  filter.addEventListener("change", renderTable);

  const csvButton = h("button", { type: "button", class: "btn-ghost" }, "Descargar revisión (CSV)");
  csvButton.addEventListener("click", () => {
    downloadCsv("revision-catalogo.csv",
      ["id", "producto", "categoria", "estado", "variantes", "activas", "imagenes", "sin_sku", "sin_costo", "nivel", "observacion"],
      rows.flatMap((r) => (r.issues.length ? r.issues : [{ level: "", text: "" }]).map((i) => [
        r.product.id, r.product.name, r.category?.name ?? "", r.product.is_active ? "publicado" : "borrador",
        r.variants.length, r.activeCount, r.imageCount, r.withoutSku, r.withoutCost,
        i.level === "block" ? "impide publicar" : i.level ? "revisar" : "", i.text])));
  });

  const sources = [];
  if (!compare) {
    sources.push(
      h("p", { class: "muted" }, "Opcional, solo durante la transición: busca diferencias con js/products.js y la hoja WEB."),
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn-ghost", onClick: () => renderCatalogReview(view, { compare: true, filterValue: filter.value }) },
          "Comparar con el catálogo anterior")));
  }
  if (sourceErrors.length) sources.push(h("div", { class: "notice-warn" }, sourceErrors.map((e) => h("p", {}, e))));
  if (compare) sources.push(h("ul", { class: "change-list" },
    !hasLegacy ? null : h("li", {}, missingLegacy.length
      ? `Faltan en la base ${missingLegacy.length} productos de js/products.js: ${missingLegacy.map((p) => p.name).join(", ")}.`
      : "Todos los productos de js/products.js están en la base."),
    !hasSheet ? null : h("li", {}, missingSheet.length
      ? `Faltan en la base ${missingSheet.length} presentaciones de la hoja WEB con precio: ${missingSheet.map((r) => `${r.Nombre} ${r.Peso}`).join(", ")}.`
      : "Todas las presentaciones de la hoja WEB con precio están en la base."),
    sheetWithoutPrice.length
      ? h("li", {}, `${sheetWithoutPrice.length} presentaciones de la hoja no tienen precio y no se importaron (hoy la tienda tampoco las muestra): ${sheetWithoutPrice.map((r) => `${r.Nombre} ${r.Peso}`).join(", ")}. Si se venden, cargales precio y agregalas como variante.`)
      : null));

  mount(view,
    h("div", { class: "page-header" },
      h("h1", {}, "Revisión del catálogo"),
      h("div", { class: "actions" }, csvButton)),
    h("section", { class: "card" },
      h("p", {}, `${rows.length} productos (${published} publicados, ${rows.length - published} en borrador) y ${variantCount} variantes.`),
      h("ul", { class: "change-list" },
        h("li", {}, blocked.length
          ? `${blocked.length} ${blocked.length === 1 ? "producto no se puede publicar" : "productos no se pueden publicar"} todavía.`
          : "Ningún producto tiene problemas que impidan publicarlo."),
        h("li", {}, `${withWarnings.length} con observaciones para revisar.`),
        h("li", {}, `${readyDrafts.length} ${readyDrafts.length === 1 ? "borrador está listo" : "borradores están listos"} para publicar (sin problemas, con fotos en Storage y con algo para vender hoy).`),
        h("li", {}, `${noSku} variantes sin SKU y ${noCost} sin costo (son datos internos: no impiden publicar).`)),
      h("p", { class: "muted" }, "Solo cambia datos si usás “Publicar”, y siempre con confirmación.")),
    h("section", { class: "card" },
      h("div", { class: "toolbar" }, filter),
      publishBox,
      tableBox),
    h("section", { class: "card" }, h("h2", {}, "Comparación con el catálogo anterior"), sources));
  renderTable();
}
