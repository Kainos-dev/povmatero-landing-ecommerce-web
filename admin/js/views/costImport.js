// Importar costos desde una lista de precios del proveedor (.xlsx, .xls o .csv).
// Busca cada SKU del archivo entre las variantes y actualiza SOLO su costo interno.
// No cambia precios de venta, stock, imágenes ni ningún otro dato.
// El archivo se lee en el navegador: no se sube a ningún lado.
import { listProducts, listAllVariantsWithCosts, saveVariantCost, normalizeSku } from "../api/catalog.js";
import { h, mount, formatPrice, errorMessage, toast } from "../ui.js";

const SHEETJS_URL = "https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs";
const SKU_HEADER = /\bsku\b|c[oó]d(igo)?|art[ií]culo|\bref(erencia)?\b/i;
const PRICE_HEADER = /precio|costo|lista|importe|valor/i;
const BIG_CHANGE = 0.5;   // avisar si el costo cambia más del 50 %

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
function detectHeaderRow(rows) {
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

export async function renderCostImport(view) {
  mount(view, h("p", { class: "muted" }, "Cargando variantes…"));

  let variants, productName;
  async function loadCatalog() {
    const [all, products] = await Promise.all([listAllVariantsWithCosts(), listProducts()]);
    variants = all;
    productName = new Map(products.map((p) => [p.id, p.name]));
  }
  try {
    await loadCatalog();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }
  const label = (v) => `${productName.get(v.product_id) ?? "Producto"} · ${v.name}`;

  let workbook = null, rows = [], fileName = "", applying = false;

  const fileInput = h("input", { type: "file", class: "input", accept: ".xlsx,.xls,.csv,text/csv", "aria-label": "Archivo de la lista de precios" });
  const fileInfo = h("p", { class: "muted" });
  const sheetSelect = h("select", { class: "input", "aria-label": "Hoja" });
  const headerInput = h("input", { class: "input input-num input-sm", type: "number", min: "1", step: "1", "aria-label": "Fila de encabezados" });
  const skuSelect = h("select", { class: "input", "aria-label": "Columna SKU" });
  const priceSelect = h("select", { class: "input", "aria-label": "Columna precio" });
  const columnsCard = h("section", { class: "card", hidden: true });
  const previewCard = h("section", { class: "card", hidden: true });

  const skuCount = variants.filter((v) => v.sku != null).length;

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
    const skuCol = Number(skuSelect.value), priceCol = Number(priceSelect.value);
    const bySku = new Map(variants.filter((v) => v.sku != null).map((v) => [v.sku, v]));
    const entries = new Map();   // sku → [{ row, raw, price }]
    let emptyRows = 0;

    rows.slice(headerIndex() + 1).forEach((r, i) => {
      const rowNumber = headerIndex() + 2 + i;
      const sku = normalizeSku(cellText(r[skuCol]));
      const raw = r[priceCol];
      if (sku == null) { if (cellText(raw) !== "" || r.some((c) => cellText(c) !== "")) emptyRows++; return; }
      if (!entries.has(sku)) entries.set(sku, []);
      entries.get(sku).push({ row: rowNumber, raw: cellText(raw), price: parsePrice(raw) });
    });

    const update = [], same = [], ignored = [], errors = [];
    for (const [sku, list] of entries) {
      const variant = bySku.get(sku);
      const rowsText = list.map((e) => e.row).join(", ");
      if (!variant) { ignored.push({ sku, rows: rowsText }); continue; }

      const invalid = list.find((e) => e.price == null || e.price <= 0);
      if (invalid) {
        errors.push({ sku, rows: rowsText, variant, reason: `precio no válido (“${invalid.raw || "vacío"}”)` });
        continue;
      }
      const prices = [...new Set(list.map((e) => round2(e.price)))];
      if (prices.length > 1) {
        errors.push({ sku, rows: rowsText, variant, reason: `SKU repetido con precios distintos (${prices.map(formatPrice).join(", ")})` });
        continue;
      }
      const cost = prices[0];
      const item = { sku, rows: rowsText, variant, cost, repeated: list.length > 1 };
      if (variant.cost === cost) same.push(item);
      else update.push(item);
    }

    const inFile = new Set(entries.keys());
    const notInFile = variants.filter((v) => v.sku != null && !inFile.has(v.sku));
    return { update, same, ignored, errors, notInFile, emptyRows, totalSkus: entries.size };
  }

  function renderPreview(confirming = false) {
    if (!rows.length) return;
    if (skuSelect.value === "" || priceSelect.value === "") {
      mount(previewCard, h("h3", {}, "3. Vista previa"), h("p", { class: "muted" }, "Elegí las columnas de SKU y de precio."));
      previewCard.hidden = false;
      renderColumnsCard();
      return;
    }
    renderColumnsCard();
    const a = analyze();

    const updateRows = a.update.map((u) => {
      const change = u.variant.cost ? (u.cost - u.variant.cost) / u.variant.cost : null;
      const big = change != null && Math.abs(change) > BIG_CHANGE;
      return h("tr", { class: big ? "row-dirty" : "" },
        h("td", {}, u.sku),
        h("td", {}, h("a", { href: `#/productos/${u.variant.product_id}` }, label(u.variant))),
        h("td", { class: "num" }, u.variant.cost == null ? h("span", { class: "muted" }, "sin costo") : formatPrice(u.variant.cost)),
        h("td", { class: "num" }, formatPrice(u.cost)),
        h("td", { class: "num" }, change == null ? "—" : `${change > 0 ? "+" : ""}${Math.round(change * 100)} %${big ? " ⚠" : ""}`),
        h("td", { class: "muted" }, `fila ${u.rows}${u.repeated ? " (repetido, mismo precio)" : ""}`)
      );
    });

    const applyButton = h("button", { type: "button", class: "btn-primary btn-inline", disabled: applying || !a.update.length },
      a.update.length ? `Actualizar ${a.update.length} ${a.update.length === 1 ? "costo" : "costos"}` : "No hay costos para actualizar");
    applyButton.addEventListener("click", () => renderPreview(true));

    const confirmBox = confirming
      ? h("div", { class: "confirm-box" },
          h("p", {}, `Se va a actualizar el costo de ${a.update.length} ${a.update.length === 1 ? "variante" : "variantes"} con los valores de “${fileName}”.`),
          h("p", {}, "Solo cambia el costo interno: no se tocan precios de venta, stock, imágenes ni otros datos."),
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn-primary btn-inline", disabled: applying, onClick: () => apply(a) }, "Confirmar importación"),
            h("button", { type: "button", class: "btn-ghost", disabled: applying, onClick: () => renderPreview(false) }, "Cancelar")))
      : null;

    const big = a.update.filter((u) => u.variant.cost && Math.abs((u.cost - u.variant.cost) / u.variant.cost) > BIG_CHANGE).length;

    mount(previewCard,
      h("h3", {}, "3. Vista previa"),
      h("ul", { class: "change-list" },
        h("li", {}, h("strong", {}, `${a.update.length} para actualizar`), " · costo nuevo o distinto al actual"),
        h("li", {}, `${a.same.length} sin cambios · el costo ya es igual`),
        h("li", {}, `${a.ignored.length} ignorados · SKU que no está en tu catálogo (productos que no vendés)`),
        h("li", { class: a.errors.length ? "form-error" : "" }, `${a.errors.length} con error · no se aplican`),
        a.emptyRows ? h("li", { class: "muted" }, `${a.emptyRows} filas sin SKU (se saltean)`) : null
      ),
      skuCount === 0
        ? h("p", { class: "notice-warn" }, "Ninguna variante tiene SKU todavía: todo el archivo va a quedar como ignorado. Asigná los SKU en “Precios y stock” o en cada producto.")
        : null,
      big ? h("p", { class: "notice-warn" }, `${big} ${big === 1 ? "costo cambia" : "costos cambian"} más de un 50 % (marcados con ⚠). Revisá que la columna de precio sea la correcta.`) : null,
      a.errors.length
        ? h("div", { class: "form-error" }, h("p", {}, "Errores (no se aplican):"),
            h("ul", { class: "change-list" }, a.errors.map((e) => h("li", {}, `SKU ${e.sku} (fila ${e.rows}) · ${label(e.variant)}: ${e.reason}`))))
        : null,
      a.update.length
        ? h("div", { class: "table-wrap" },
            h("table", { class: "table price-table" },
              h("thead", {}, h("tr", {}, ["SKU", "Variante", "Costo actual", "Costo nuevo", "Cambio", "Archivo"].map((t) => h("th", {}, t)))),
              h("tbody", {}, updateRows)))
        : null,
      a.ignored.length
        ? h("details", {}, h("summary", {}, `Ver ${a.ignored.length} SKU ignorados`),
            h("p", { class: "muted" }, a.ignored.map((i) => i.sku).join(" · ")))
        : null,
      a.notInFile.length
        ? h("details", {}, h("summary", {}, `${a.notInFile.length} variantes con SKU que no aparecen en el archivo`),
            h("ul", { class: "change-list" }, a.notInFile.map((v) => h("li", {}, `${v.sku} · ${label(v)}`))))
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
      h("label", { class: "field" }, h("span", {}, "Columna precio (costo de compra)"), priceSelect, h("small", { class: "hint" }, samples(priceSelect.value)))
    );
  }

  // ---------- 4. Aplicar ----------
  async function apply(a) {
    applying = true;
    const progress = h("p", {}, `Actualizando 0 de ${a.update.length}…`);
    mount(previewCard, h("h3", {}, "Importando…"), progress);
    const failed = [];
    let ok = 0;
    for (const [i, u] of a.update.entries()) {
      try {
        await saveVariantCost(u.variant.id, u.cost);
        ok++;
      } catch (err) {
        console.error(err);
        failed.push(`SKU ${u.sku} · ${label(u.variant)}: ${errorMessage(err)}`);
      }
      progress.textContent = `Actualizando ${i + 1} de ${a.update.length}…`;
    }
    applying = false;
    try { await loadCatalog(); } catch (err) { console.error(err); }

    mount(previewCard,
      h("h3", {}, "Resultado"),
      h("ul", { class: "change-list" },
        h("li", {}, h("strong", {}, `${ok} actualizados`)),
        h("li", {}, `${a.same.length} sin cambios`),
        h("li", {}, `${a.ignored.length} ignorados (SKU que no vendés)`),
        h("li", { class: a.errors.length + failed.length ? "form-error" : "" }, `${a.errors.length + failed.length} errores`)
      ),
      failed.length || a.errors.length
        ? h("div", { class: "form-error" }, h("ul", { class: "change-list" },
            [...a.errors.map((e) => `SKU ${e.sku} (fila ${e.rows}): ${e.reason}`), ...failed].map((t) => h("li", {}, t))))
        : null,
      h("p", { class: "muted" }, "Podés revisar los costos en “Precios y stock”."),
      h("div", { class: "actions" },
        h("a", { href: "#/precios", class: "btn-ghost" }, "Ir a Precios y stock"),
        h("button", { type: "button", class: "btn-ghost", onClick: () => renderPreview(false) }, "Ver vista previa otra vez"))
    );
    toast(failed.length ? `Importación con ${failed.length} errores.` : `${ok} costos actualizados.`, failed.length ? "error" : "ok");
  }

  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Importar costos")),
    h("p", { class: "muted" },
      "Cargá la lista de precios del proveedor. Cada fila se busca por SKU exacto entre tus variantes y actualiza solo su costo interno. ",
      "Nada se guarda hasta que confirmás."),
    h("section", { class: "card" },
      h("h3", {}, "1. Archivo"),
      h("label", { class: "field" }, h("span", {}, "Lista de precios (.xlsx, .xls o .csv)"), fileInput),
      fileInfo,
      h("p", { class: "muted" }, `${skuCount} de ${variants.length} variantes tienen SKU asignado.`)
    ),
    columnsCard,
    previewCard
  );
}
