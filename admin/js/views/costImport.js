// Importar precios desde una lista en Excel (.xlsx, .xls o .csv).
//
// Busca cada SKU del archivo entre los SKU de PRODUCTO y actualiza un solo valor
// general del producto, según el tipo de lista:
//   * Lista mayorista (ej. Darc Cuir & Yatay) → costo general.
//   * Lista minorista                         → precio de venta general.
// La base copia ese valor a las variantes que usan el general; las que tienen un
// valor particular no cambian. No se tocan nombres, imágenes, descripciones,
// categorías, stock ni ningún otro dato. No se calculan márgenes.
// El archivo se lee en el navegador: no se sube a ningún lado.
import { listProducts, listAllVariantsWithCosts, listProductInternals, saveProductPricing, normalizeSku } from "../api/catalog.js";
import { h, mount, formatPrice, errorMessage, toast } from "../ui.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const SKU_HEADER = /\bsku\b|c[oó]d(igo)?|art[ií]culo|\bref(erencia)?\b/i;
// "$" solo (como en la lista de Darc Cuir & Yatay) también es una columna de precio.
const PRICE_HEADER = /precio|costo|lista|importe|valor|mayorista|minorista|venta|^\s*\$\s*$/i;
const BIG_CHANGE = 0.5;   // avisar si el valor cambia más del 50 %

const MODES = {
  cost: {
    label: "Lista mayorista",
    detail: "Actualiza el costo general de cada producto (precio de compra).",
    field: "base_cost",
    what: "costo",
    column: "Columna precio mayorista (costo)",
  },
  price: {
    label: "Lista minorista",
    detail: "Actualiza el precio de venta general de cada producto.",
    field: "base_price",
    what: "precio de venta",
    column: "Columna precio de venta",
  },
};

let sheetjs = null;
async function loadSheetJs() {
  sheetjs ??= import(SHEETJS_URL);
  return sheetjs;
}

// "$ 12.345,67" → 12345.67 · "12,345.67" → 12345.67 · "1.234" → 1234. null si no es válido.
export function parsePrice(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  let s = String(value ?? "").replace(/ars|\$|\s/gi, "");
  if (s === "" || !/^-?[\d.,]+$/.test(s)) return null;
  const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, "");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// SKU de una celda: los números de Excel (2559 o 2559.0) se leen como "2559".
export function cellSku(value) {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : String(value);
  return normalizeSku(value);
}

function decodeText(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer).replace(/^﻿/, "");
  } catch {
    return new TextDecoder("windows-1252").decode(buffer);
  }
}

function cellText(value) {
  return value == null ? "" : String(value).trim();
}

function columnLetter(i) {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

// Fila de encabezados: la primera (de las 30 primeras) que tenga un título de SKU
// y uno de precio; si no hay, la primera con al menos 2 celdas.
export function detectHeaderRow(rows) {
  const limit = Math.min(rows.length, 30);
  for (let i = 0; i < limit; i++) {
    const cells = rows[i].map(cellText);
    if (cells.some((c) => SKU_HEADER.test(c)) && cells.some((c) => PRICE_HEADER.test(c))) return i;
  }
  for (let i = 0; i < limit; i++) {
    if (rows[i].filter((c) => cellText(c) !== "").length >= 2) return i;
  }
  return 0;
}

const round2 = (n) => Math.round(n * 100) / 100;

// Cruza las filas del archivo con los productos. Exportada para pruebas.
//   products: [{ id, name, base_price }]; internals: Map id → { sku, base_cost }
//   variants: [{ product_id, price_inherited, cost_inherited }]
export function analyzeRows({ rows, skuCol, priceCol, mode, products, internals, variants }) {
  const m = MODES[mode];
  const productBySku = new Map();
  for (const p of products) {
    const sku = internals.get(p.id)?.sku;
    if (sku != null) productBySku.set(sku, p);
  }
  const current = (p) => (m.field === "base_cost" ? internals.get(p.id)?.base_cost ?? null : p.base_price ?? null);
  const inheriting = (p) => variants.filter((v) => v.product_id === p.id && (mode === "cost" ? v.cost_inherited : v.price_inherited)).length;
  const total = (p) => variants.filter((v) => v.product_id === p.id).length;

  const entries = new Map();   // sku → [{ row, raw, value }]
  let emptyRows = 0;
  rows.forEach(({ cells, row }) => {
    const sku = cellSku(cells[skuCol]);
    const raw = cells[priceCol];
    if (sku == null) { if (cells.some((c) => cellText(c) !== "")) emptyRows++; return; }
    if (!entries.has(sku)) entries.set(sku, []);
    entries.get(sku).push({ row, raw: cellText(raw), value: parsePrice(raw) });
  });

  const update = [], same = [], ignored = [], errors = [];
  for (const [sku, list] of entries) {
    const product = productBySku.get(sku);
    const rowsText = list.map((e) => e.row).join(", ");
    if (!product) {
      // Títulos de sección ("1 CAMPERAS") y artículos que no vendés.
      ignored.push({ sku, rows: rowsText, section: list.every((e) => e.raw === "") });
      continue;
    }
    const minValue = mode === "price" ? 0 : -1;   // venta > 0; costo >= 0
    const invalid = list.find((e) => e.value == null || e.value <= minValue);
    if (invalid) { errors.push({ sku, rows: rowsText, product, reason: `${m.what} no válido (“${invalid.raw || "vacío"}”)` }); continue; }
    const values = [...new Set(list.map((e) => round2(e.value)))];
    if (values.length > 1) { errors.push({ sku, rows: rowsText, product, reason: `SKU repetido con valores distintos (${values.map(formatPrice).join(", ")})` }); continue; }
    const item = { sku, rows: rowsText, product, value: values[0], before: current(product), inheriting: inheriting(product), total: total(product), repeated: list.length > 1 };
    if (item.before != null && round2(item.before) === item.value) same.push(item);
    else update.push(item);
  }
  const inFile = new Set(entries.keys());
  const notInFile = products.filter((p) => internals.get(p.id)?.sku != null && !inFile.has(internals.get(p.id).sku));
  return { update, same, ignored, errors, notInFile, emptyRows, totalSkus: entries.size };
}

export async function renderCostImport(view) {
  mount(view, h("p", { class: "muted" }, "Cargando productos…"));

  let products, internals, variants;
  async function loadCatalog() {
    [products, internals, variants] = await Promise.all([listProducts(), listProductInternals(), listAllVariantsWithCosts()]);
    for (const p of products) p.base_price = p.base_price == null ? null : Number(p.base_price);
  }
  try {
    await loadCatalog();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  let mode = "cost";
  let workbook = null, rows = [], fileName = "", applying = false;

  const modeBox = h("div", { class: "choice-grid", role: "radiogroup", "aria-label": "Tipo de lista" });
  const fileInput = h("input", { type: "file", class: "input", accept: ".xlsx,.xls,.csv,text/csv", "aria-label": "Archivo de la lista de precios" });
  const fileInfo = h("p", { class: "muted" });
  const sheetSelect = h("select", { class: "input", "aria-label": "Hoja" });
  const headerInput = h("input", { class: "input input-num input-sm", type: "number", min: "1", step: "1", "aria-label": "Fila de encabezados" });
  const skuSelect = h("select", { class: "input", "aria-label": "Columna SKU" });
  const priceSelect = h("select", { class: "input", "aria-label": "Columna precio" });
  const columnsCard = h("section", { class: "card", hidden: true });
  const previewCard = h("section", { class: "card", hidden: true });

  const withSku = () => products.filter((p) => internals.get(p.id)?.sku != null).length;

  function renderModes() {
    mount(modeBox, Object.entries(MODES).map(([key, m]) => {
      const input = h("input", { type: "radio", name: "import-mode", value: key, checked: key === mode });
      input.addEventListener("change", () => { mode = key; renderModes(); if (rows.length) { renderColumnsCard(); renderPreview(); } });
      return h("label", { class: key === mode ? "choice active" : "choice" }, input,
        h("span", { class: "choice-text" }, h("strong", {}, m.label), h("span", {}, m.detail)));
    }));
  }

  // ---------- 1. Archivo ----------
  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    columnsCard.hidden = true;
    previewCard.hidden = true;
    if (!file) return;
    fileName = file.name;
    fileInfo.textContent = "Leyendo el archivo…";
    try {
      const XLSX = await loadSheetJs();
      const data = await file.arrayBuffer();
      if (/\.csv$/i.test(file.name) || file.type === "text/csv") {
        // CSV: se decodifica a mano (UTF-8 o, si no lo es, Windows-1252 como exporta Excel)
        // y se lee como texto, para que "$ 25.500,50" no se convierta con formato de EE. UU.
        workbook = XLSX.read(decodeText(data), { type: "string", raw: true });
      } else {
        workbook = XLSX.read(data, { type: "array", cellDates: false });
      }
      mount(sheetSelect, workbook.SheetNames.map((n) => h("option", { value: n }, n)));
      fileInfo.textContent = `${file.name} · ${workbook.SheetNames.length === 1 ? "1 hoja" : `${workbook.SheetNames.length} hojas`}`;
      loadSheet(true);
    } catch (err) {
      console.error(err);
      workbook = null;
      fileInfo.textContent = "";
      mount(previewCard, h("p", { class: "form-error" }, `No se pudo leer el archivo: ${err?.message || err}`));
      previewCard.hidden = false;
    }
  });

  async function loadSheet(autodetect) {
    const XLSX = await loadSheetJs();
    const sheet = workbook.Sheets[sheetSelect.value];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "", blankrows: true });
    if (autodetect) headerInput.value = String(detectHeaderRow(rows) + 1);
    fillColumns(autodetect);
    columnsCard.hidden = false;
    renderPreview();
  }

  // ---------- 2. Columnas ----------
  function headerIndex() {
    const n = Number(headerInput.value);
    return Number.isInteger(n) && n >= 1 && n <= rows.length ? n - 1 : 0;
  }

  function fillColumns(autodetect) {
    const header = rows[headerIndex()] ?? [];
    const width = Math.max(header.length, ...rows.slice(0, 50).map((r) => r.length), 0);
    const options = Array.from({ length: width }, (_, i) => {
      const title = cellText(header[i]);
      return h("option", { value: String(i) }, `${columnLetter(i)}${title ? ` · ${title}` : ""}`);
    });
    const prevSku = skuSelect.value, prevPrice = priceSelect.value;
    mount(skuSelect, h("option", { value: "" }, "Elegí la columna…"), options.map((o) => o.cloneNode(true)));
    mount(priceSelect, h("option", { value: "" }, "Elegí la columna…"), options);

    if (autodetect) {
      const titles = Array.from({ length: width }, (_, i) => cellText(header[i]));
      const skuCol = titles.findIndex((t) => SKU_HEADER.test(t));
      const priceCol = titles.findIndex((t) => PRICE_HEADER.test(t));
      skuSelect.value = skuCol >= 0 ? String(skuCol) : "";
      priceSelect.value = priceCol >= 0 ? String(priceCol) : "";
    } else {
      skuSelect.value = prevSku;
      priceSelect.value = prevPrice;
    }
  }

  function samples(col) {
    if (col === "") return "";
    const values = rows.slice(headerIndex() + 1).map((r) => cellText(r[Number(col)])).filter(Boolean).slice(0, 3);
    return values.length ? `Ejemplos: ${values.join(" · ")}` : "Columna vacía";
  }

  sheetSelect.addEventListener("change", () => loadSheet(true));
  headerInput.addEventListener("input", () => { fillColumns(true); renderPreview(); });
  skuSelect.addEventListener("change", () => renderPreview());
  priceSelect.addEventListener("change", () => renderPreview());

  // ---------- 3. Vista previa ----------
  function analyze() {
    const start = headerIndex() + 1;
    return analyzeRows({
      rows: rows.slice(start).map((cells, i) => ({ cells, row: start + 1 + i })),
      skuCol: Number(skuSelect.value), priceCol: Number(priceSelect.value),
      mode, products, internals, variants,
    });
  }

  function renderPreview(confirming = false) {
    if (!rows.length) return;
    const m = MODES[mode];
    if (skuSelect.value === "" || priceSelect.value === "") {
      mount(previewCard, h("h3", {}, "3. Vista previa"), h("p", { class: "muted" }, "Elegí las columnas de SKU y de precio."));
      previewCard.hidden = false;
      renderColumnsCard();
      return;
    }
    renderColumnsCard();
    const a = analyze();
    const sections = a.ignored.filter((i) => i.section).length;

    const updateRows = a.update.map((u) => {
      const change = u.before ? (u.value - u.before) / u.before : null;
      const big = change != null && Math.abs(change) > BIG_CHANGE;
      return h("tr", { class: big ? "row-dirty" : "" },
        h("td", {}, u.sku),
        h("td", {}, h("a", { href: `#/productos/${u.product.id}?tab=precios` }, u.product.name)),
        h("td", { class: "num" }, u.before == null ? h("span", { class: "muted" }, "sin valor") : formatPrice(u.before)),
        h("td", { class: "num" }, h("strong", {}, formatPrice(u.value))),
        h("td", { class: "num" }, change == null ? "—" : `${change > 0 ? "+" : ""}${Math.round(change * 100)} %${big ? " ⚠" : ""}`),
        h("td", {}, u.total === 0 ? h("span", { class: "muted" }, "sin variantes")
          : u.inheriting === u.total ? `${u.total} de ${u.total}`
          : h("span", {}, `${u.inheriting} de ${u.total}`, h("span", { class: "muted" }, ` · ${u.total - u.inheriting} particular${u.total - u.inheriting === 1 ? "" : "es"} no cambian`))),
        h("td", { class: "muted" }, `fila ${u.rows}${u.repeated ? " (repetido, mismo valor)" : ""}`)
      );
    });
    const noneInherit = a.update.filter((u) => u.total > 0 && u.inheriting === 0);

    const applyButton = h("button", { type: "button", class: "btn-primary btn-inline", disabled: applying || !a.update.length },
      a.update.length ? `Actualizar ${a.update.length} ${a.update.length === 1 ? "producto" : "productos"}` : "No hay nada para actualizar");
    applyButton.addEventListener("click", () => renderPreview(true));

    const confirmBox = confirming
      ? h("div", { class: "confirm-box" },
          h("p", {}, `Se va a actualizar el ${m.what} general de ${a.update.length} ${a.update.length === 1 ? "producto" : "productos"} con los valores de “${fileName}”.`),
          h("p", {}, "El valor se copia a las variantes que usan el general. No se tocan nombres, imágenes, descripciones, categorías ni stock."),
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn-primary btn-inline", disabled: applying, onClick: () => apply(a) }, "Confirmar importación"),
            h("button", { type: "button", class: "btn-ghost", disabled: applying, onClick: () => renderPreview(false) }, "Cancelar")))
      : null;

    const big = a.update.filter((u) => u.before && Math.abs((u.value - u.before) / u.before) > BIG_CHANGE).length;

    mount(previewCard,
      h("h3", {}, "3. Vista previa"),
      h("ul", { class: "change-list" },
        h("li", {}, h("strong", {}, `${a.update.length} para actualizar`), ` · ${m.what} nuevo o distinto al actual`),
        h("li", {}, `${a.same.length} sin cambios · el valor ya es igual`),
        h("li", {}, `${a.ignored.length - sections} ignorados · SKU que no está en tu catálogo (artículos que no vendés)`),
        sections ? h("li", { class: "muted" }, `${sections} títulos de sección sin precio (ej. «CAMPERAS»): se saltean`) : null,
        h("li", { class: a.errors.length ? "form-error" : "" }, `${a.errors.length} con error · no se aplican`),
        a.emptyRows ? h("li", { class: "muted" }, `${a.emptyRows} filas sin SKU (se saltean)`) : null
      ),
      withSku() === 0
        ? h("p", { class: "notice-warn" }, "Ningún producto tiene SKU todavía: todo el archivo va a quedar como ignorado. Cargá los SKU en Inventario › Precios o en cada producto.")
        : null,
      big ? h("p", { class: "notice-warn" }, `${big} ${big === 1 ? "valor cambia" : "valores cambian"} más de un 50 % (marcados con ⚠). Revisá que la columna y el tipo de lista sean los correctos.`) : null,
      noneInherit.length
        ? h("p", { class: "notice-warn" }, `En ${noneInherit.length} ${noneInherit.length === 1 ? "producto" : "productos"} ninguna variante usa el ${m.what} general, así que no cambia ningún precio visible: ${noneInherit.map((u) => u.product.name).join(", ")}. Si querés que lo usen, marcalas con «Usar general».`)
        : null,
      a.errors.length
        ? h("div", { class: "form-error" }, h("p", {}, "Errores (no se aplican):"),
            h("ul", { class: "change-list" }, a.errors.map((e) => h("li", {}, `SKU ${e.sku} (fila ${e.rows}) · ${e.product.name}: ${e.reason}`))))
        : null,
      a.update.length
        ? h("div", { class: "table-wrap" },
            h("table", { class: "table price-table" },
              h("thead", {}, h("tr", {}, ["SKU", "Producto", "Actual", "Nuevo", "Cambio", "Variantes que lo usan", "Archivo"].map((t) => h("th", {}, t)))),
              h("tbody", {}, updateRows)))
        : null,
      a.ignored.length - sections
        ? h("details", {}, h("summary", {}, `Ver ${a.ignored.length - sections} SKU ignorados`),
            h("p", { class: "muted" }, a.ignored.filter((i) => !i.section).map((i) => i.sku).join(" · ")))
        : null,
      a.notInFile.length
        ? h("details", {}, h("summary", {}, `${a.notInFile.length} productos con SKU que no aparecen en el archivo`),
            h("ul", { class: "change-list" }, a.notInFile.map((p) => h("li", {}, `${internals.get(p.id).sku} · ${p.name}`))))
        : null,
      h("div", { class: "actions" }, confirming ? null : applyButton),
      confirmBox
    );
    previewCard.hidden = false;
  }

  function renderColumnsCard() {
    mount(columnsCard,
      h("h3", {}, "2. Columnas"),
      workbook && workbook.SheetNames.length > 1 ? h("label", { class: "field" }, h("span", {}, "Hoja"), sheetSelect) : null,
      h("label", { class: "field" }, h("span", {}, "Fila de encabezados"), headerInput,
        h("small", { class: "hint" }, "Fila donde están los títulos de las columnas. Se detecta sola; cambiala si no es la correcta.")),
      h("label", { class: "field" }, h("span", {}, "Columna SKU"), skuSelect, h("small", { class: "hint" }, samples(skuSelect.value))),
      h("label", { class: "field" }, h("span", {}, MODES[mode].column), priceSelect, h("small", { class: "hint" }, samples(priceSelect.value)))
    );
  }

  // ---------- 4. Aplicar ----------
  async function apply(a) {
    applying = true;
    const field = MODES[mode].field;
    const progress = h("p", {}, `Actualizando 0 de ${a.update.length}…`);
    mount(previewCard, h("h3", {}, "Importando…"), progress);
    const failed = [];
    let ok = 0;
    for (const [i, u] of a.update.entries()) {
      try {
        await saveProductPricing(u.product.id, { [field]: u.value });
        ok++;
      } catch (err) {
        console.error(err);
        failed.push(`SKU ${u.sku} · ${u.product.name}: ${errorMessage(err)}`);
      }
      progress.textContent = `Actualizando ${i + 1} de ${a.update.length}…`;
    }
    applying = false;
    try { await loadCatalog(); } catch (err) { console.error(err); }

    mount(previewCard,
      h("h3", {}, "Resultado"),
      h("ul", { class: "change-list" },
        h("li", {}, h("strong", {}, `${ok} productos actualizados`)),
        h("li", {}, `${a.same.length} sin cambios`),
        h("li", {}, `${a.ignored.filter((i) => !i.section).length} ignorados (SKU que no vendés)`),
        h("li", { class: a.errors.length + failed.length ? "form-error" : "" }, `${a.errors.length + failed.length} errores`)
      ),
      failed.length || a.errors.length
        ? h("div", { class: "form-error" }, h("ul", { class: "change-list" },
            [...a.errors.map((e) => `SKU ${e.sku} (fila ${e.rows}): ${e.reason}`), ...failed].map((t) => h("li", {}, t))))
        : null,
      h("div", { class: "actions" },
        h("a", { href: "#/inventario?tab=precios", class: "btn-ghost" }, "Ver en Inventario › Precios"),
        h("button", { type: "button", class: "btn-ghost", onClick: () => renderPreview(false) }, "Ver vista previa otra vez"))
    );
    toast(failed.length ? `Importación con ${failed.length} errores.` : `${ok} productos actualizados.`, failed.length ? "error" : "ok");
  }

  renderModes();
  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Importar precios")),
    h("p", { class: "muted" },
      "Cargá una lista en Excel o CSV. Cada fila se busca por el SKU del producto y actualiza solo su costo o su precio de venta general. ",
      "Nada se guarda hasta que confirmás."),
    h("section", { class: "card" },
      h("h3", {}, "1. Tipo de lista y archivo"),
      modeBox,
      h("label", { class: "field" }, h("span", {}, "Archivo (.xlsx, .xls o .csv)"), fileInput),
      fileInfo,
      h("p", { class: "muted" }, `${withSku()} de ${products.length} productos tienen SKU.`)
    ),
    columnsCard,
    previewCard
  );
}
