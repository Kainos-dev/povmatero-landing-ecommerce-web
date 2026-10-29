// Stock: todas las presentaciones que controlan stock (hoy, las yerbas).
// Supabase es la única fuente del stock: para cambiarlo se escribe la cantidad
// contada y se registra un movimiento por la diferencia (entrada o ajuste).
// La hoja WEB solo sirve para la importación inicial.
import * as api from "../api/catalog.js";
import { registerMovement, getVariantStock } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

const SHEET_URL = "https://opensheet.elk.sh/1TFmZ1hbO5bXh5MGktpUzM7MJTZwyoknVLyVHRNBbwso/WEB";
const IMPORT_REASON = "Carga inicial de stock (hoja WEB)";
const ENTRY_REASON = "Ingreso de mercadería";
const ADJUST_REASON = "Conteo físico";

// "12" → 12; vacío o inválido → null.
function readCount(text) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

const sheetKey = (name, size) => `${normalizeText(name).trim()}|${normalizeText(size).replace(/\s+/g, "")}`;

// Busca la fila de la hoja de una variante: primero por su vínculo (columna ID),
// después por nombre del producto + presentación. Exportada para pruebas.
export function matchSheetRow(variant, productName, sheetById, sheetByName) {
  if (variant.sheet_id != null && sheetById.has(variant.sheet_id)) {
    return { row: sheetById.get(variant.sheet_id), by: "id" };
  }
  const candidates = sheetByName.get(sheetKey(productName, variant.name)) ?? [];
  if (candidates.length === 1) return { row: candidates[0], by: "name" };
  return { row: null, by: candidates.length > 1 ? "ambiguous" : "none" };
}

export async function renderStockTable(view) {
  mount(view, h("p", { class: "muted" }, "Cargando stock…"));

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

  // Ediciones: variantId → { target: "texto", imported?: { sheetId, by } }
  const edits = new Map();
  const sheetInfo = new Map();   // variantId → texto de la columna "Hoja WEB"
  let saving = false;
  let lastErrors = [];

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar producto o presentación…", "aria-label": "Buscar" });
  const showFilter = h("select", { class: "input", "aria-label": "Mostrar" },
    h("option", { value: "" }, "Todas"),
    h("option", { value: "zero" }, "Sin stock"),
    h("option", { value: "changed" }, "Con cambios sin guardar"));
  const importButton = h("button", { type: "button", class: "btn-ghost",
    title: "Completa las presentaciones de yerba que tienen stock 0 con la cantidad de la hoja. No guarda nada." },
    "Importación inicial desde la hoja WEB");
  const info = h("p", { class: "muted" });
  const notice = h("div");
  const tbody = h("tbody");
  const bar = h("div", { class: "save-bar", hidden: true });

  let idx;
  function index() {
    const productById = new Map(products.map((p) => [p.id, p]));
    const categoryById = new Map(categories.map((c) => [c.id, c]));
    const rows = variants
      .filter((v) => v.track_stock)
      .map((v) => {
        const p = productById.get(v.product_id);
        return { v, p, category: categoryById.get(p?.category_id) };
      })
      .filter((r) => r.p)
      .sort((a, b) =>
        (a.category?.sort_order ?? 0) - (b.category?.sort_order ?? 0)
        || a.p.name.localeCompare(b.p.name, "es")
        || a.v.sort_order - b.v.sort_order || a.v.id - b.v.id);
    return { rows, isYerba: (r) => r.category?.slug === "yerbas" };
  }
  idx = index();

  const target = (r) => {
    const e = edits.get(r.v.id);
    return e ? readCount(e.target) : null;
  };

  function setTarget(r, value, imported = null) {
    const n = readCount(value);
    if (String(value).trim() === "" || n === r.v.stock) edits.delete(r.v.id);
    else edits.set(r.v.id, { target: String(value), imported });
  }

  // ---------- Tabla ----------
  function visible() {
    const q = normalizeText(search.value.trim());
    return idx.rows.filter((r) => {
      if (q && !normalizeText(`${r.p.name} ${r.v.name}`).includes(q)) return false;
      if (showFilter.value === "zero" && r.v.stock !== 0) return false;
      if (showFilter.value === "changed" && !edits.has(r.v.id)) return false;
      return true;
    });
  }

  function diffText(r) {
    const t = target(r);
    if (t == null) return "";
    if (Number.isNaN(t)) return "inválido";
    const d = t - r.v.stock;
    return d > 0 ? `+${d}` : String(d);
  }

  function row(r, first) {
    const e = edits.get(r.v.id);
    const input = h("input", { class: "input input-num input-sm", type: "number", min: "0", step: "1", placeholder: String(r.v.stock),
      value: e?.target ?? "", "aria-label": `Nuevo stock de ${r.p.name} ${r.v.name}` });
    const diff = h("td", { class: "num" }, diffText(r));
    const tr = h("tr", { class: [e ? "row-dirty" : "", r.p.is_active ? "" : "row-inactive"].join(" ").trim() },
      h("td", {}, first ? h("a", { href: `#/productos/${r.p.id}` }, r.p.name) : h("span", { class: "muted", "aria-hidden": "true" }, "↳"),
        first && !r.p.is_active ? h("span", { class: "muted" }, " (borrador)") : null),
      h("td", {}, r.v.name, r.v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
      h("td", { class: "num" }, formatPrice(r.v.price)),
      h("td", { class: "num" }, h("strong", {}, String(r.v.stock))),
      h("td", {}, input),
      diff,
      h("td", { class: "muted" }, sheetInfo.get(r.v.id) ?? "")
    );
    input.addEventListener("input", () => {
      setTarget(r, input.value);
      diff.textContent = diffText(r);
      tr.classList.toggle("row-dirty", edits.has(r.v.id));
      renderBar();
    });
    return tr;
  }

  function renderTable() {
    const list = visible();
    let last = null;
    mount(tbody, list.length
      ? list.map((r) => { const first = r.p.id !== last; last = r.p.id; return row(r, first); })
      : h("tr", {}, h("td", { colspan: "7", class: "empty" }, "No hay presentaciones que coincidan.")));
    const units = idx.rows.reduce((s, r) => s + r.v.stock, 0);
    const zero = idx.rows.filter((r) => r.v.stock === 0).length;
    info.textContent = `${idx.rows.length} presentaciones controlan stock · ${units} unidades · ${zero} en 0`;
  }

  // ---------- Guardado ----------
  function collect() {
    const changes = [], problems = [];
    for (const r of idx.rows) {
      const e = edits.get(r.v.id);
      if (!e) continue;
      const t = readCount(e.target);
      const label = `${r.p.name} · ${r.v.name}`;
      if (Number.isNaN(t)) { problems.push(`${label}: la cantidad debe ser un número entero mayor o igual a 0.`); continue; }
      if (t === r.v.stock) continue;
      changes.push({ r, label, target: t, delta: t - r.v.stock, imported: e.imported });
    }
    return { changes, problems };
  }

  function renderBar(review = false) {
    if (!edits.size) { bar.hidden = true; mount(bar); return; }
    bar.hidden = false;
    const { changes, problems } = collect();
    const discard = h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => { edits.clear(); renderTable(); renderBar(); } }, "Descartar cambios");
    if (!review) {
      mount(bar, h("div", { class: "actions" },
        h("span", {}, edits.size === 1 ? "1 presentación con cambios" : `${edits.size} presentaciones con cambios`),
        h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving, onClick: () => renderBar(true) }, "Revisar y guardar"),
        discard));
      return;
    }
    const anyImported = changes.some((c) => c.imported);
    const entryReason = h("input", { class: "input", maxlength: "200", value: ENTRY_REASON, "aria-label": "Motivo de las entradas" });
    const adjustReason = h("input", { class: "input", maxlength: "200", value: ADJUST_REASON, "aria-label": "Motivo de los ajustes" });
    const manualEntries = changes.filter((c) => !c.imported && c.delta > 0).length;
    const adjustments = changes.filter((c) => c.delta < 0).length;
    const confirm = h("button", { type: "button", class: "btn-primary btn-inline", disabled: saving || problems.length > 0 || !changes.length },
      saving ? "Guardando…" : "Confirmar y guardar");
    confirm.addEventListener("click", () => save(changes, {
      entry: entryReason.value.trim() || ENTRY_REASON,
      adjust: adjustReason.value.trim() || ADJUST_REASON,
    }));
    mount(bar, h("div", { class: "bulk-confirm" },
      h("p", {}, changes.length
        ? `Se van a registrar ${changes.length} ${changes.length === 1 ? "movimiento" : "movimientos"} de inventario (uno por presentación, por la diferencia):`
        : "No hay cambios para guardar."),
      problems.length ? h("div", { class: "form-error" }, h("ul", {}, problems.map((t) => h("li", {}, t)))) : null,
      h("ul", { class: "change-list" }, changes.map((c) => h("li", {}, h("strong", {}, c.label),
        `: ${c.r.v.stock} → ${c.target} (${c.delta > 0 ? `entrada +${c.delta}` : `ajuste ${c.delta}`})`,
        c.imported ? ` · hoja WEB fila ${c.imported.sheetId}` : ""))),
      anyImported ? h("p", { class: "muted" }, `Las cantidades traídas de la hoja se registran como “${IMPORT_REASON}”.`) : null,
      manualEntries ? h("label", { class: "field" }, h("span", {}, "Motivo de las entradas"), entryReason) : null,
      adjustments ? h("label", { class: "field" }, h("span", {}, "Motivo de los ajustes"), adjustReason) : null,
      h("div", { class: "actions" }, confirm,
        h("button", { type: "button", class: "btn-ghost", disabled: saving, onClick: () => renderBar(false) }, "Volver a editar"),
        discard)));
  }

  async function save(changes, reasons) {
    saving = true;
    renderBar(true);
    const failed = [];
    let ok = 0, linked = 0;
    for (const c of changes) {
      try {
        // El stock pudo cambiar desde que se abrió la pantalla (otra pestaña, una venta):
        // en ese caso no se registra nada, para no duplicar ni pisar cantidades.
        const fresh = await getVariantStock(c.r.v.id);
        if (fresh.stock !== c.r.v.stock) {
          failed.push(`${c.label}: el stock cambió a ${fresh.stock} mientras tanto. No se registró nada; revisalo y volvé a intentar.`);
          continue;
        }
        await registerMovement({
          variantId: c.r.v.id,
          type: c.delta > 0 ? "entrada" : "ajuste",
          quantity: c.delta,
          reason: c.imported ? IMPORT_REASON : c.delta > 0 ? reasons.entry : reasons.adjust,
          reference: c.imported ? `Hoja WEB fila ${c.imported.sheetId}` : null,
        });
        ok++;
        // Si se encontró por nombre, se guarda el vínculo con la fila de la hoja.
        if (c.imported?.by === "name") {
          try { await api.saveVariantSheetLink(c.r.v.id, c.imported.sheetId); linked++; }
          catch (err) { console.error(err); failed.push(`${c.label}: el stock se guardó, pero no el vínculo con la fila ${c.imported.sheetId} de la hoja (${errorMessage(err)}).`); }
        }
      } catch (err) {
        console.error(err);
        failed.push(`${c.label}: ${errorMessage(err)}`);
      }
    }
    edits.clear();
    lastErrors = failed;
    try { await load(); idx = index(); } catch (err) { console.error(err); lastErrors.push(`No se pudo recargar: ${errorMessage(err)}. Recargá la página.`); }
    saving = false;
    toast(failed.length ? `Se registraron ${ok} de ${changes.length}. Revisá los avisos.` : `${ok} ${ok === 1 ? "movimiento registrado" : "movimientos registrados"}.`, failed.length ? "error" : "ok");
    renderNotice(linked ? h("p", { class: "notice-info" }, linked === 1 ? "Se vinculó 1 presentación con su fila de la hoja." : `Se vincularon ${linked} presentaciones con su fila de la hoja.`) : null);
    if (showFilter.value === "changed") showFilter.value = "";
    renderTable();
    renderBar();
  }

  function renderNotice(extra = null) {
    mount(notice,
      lastErrors.length ? h("div", { class: "form-error" }, h("ul", {}, lastErrors.map((t) => h("li", {}, t)))) : null,
      extra);
  }

  // ---------- Importación inicial desde la hoja ----------
  // Solo completa presentaciones de yerba con stock 0: nunca pisa cantidades ya cargadas.
  importButton.addEventListener("click", async () => {
    importButton.disabled = true;
    importButton.textContent = "Leyendo la hoja…";
    try {
      const res = await fetch(SHEET_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`La hoja respondió ${res.status}.`);
      const sheet = await res.json();
      const sheetById = new Map(sheet.map((s) => [Number(s.ID), s]));
      const sheetByName = new Map();
      for (const s of sheet) {
        const k = sheetKey(s.Nombre, s.Peso);
        if (!sheetByName.has(k)) sheetByName.set(k, []);
        sheetByName.get(k).push(s);
      }

      let filled = 0, same = 0, kept = 0, byName = 0;
      const missing = [], invalid = [];
      sheetInfo.clear();
      for (const r of idx.rows) {
        if (!idx.isYerba(r)) continue;
        const label = `${r.p.name} ${r.v.name}`;
        const m = matchSheetRow(r.v, r.p.name, sheetById, sheetByName);
        if (!m.row) {
          missing.push(label + (m.by === "ambiguous" ? " (más de una fila con ese nombre)" : ""));
          sheetInfo.set(r.v.id, "no está en la hoja");
          continue;
        }
        const qty = readCount(m.row.Stock ?? "0");
        const sheetId = Number(m.row.ID);
        sheetInfo.set(r.v.id, `fila ${sheetId}${m.by === "name" ? " (por nombre)" : ""}: ${Number.isNaN(qty) ? "inválido" : qty ?? 0}`);
        if (Number.isNaN(qty)) { invalid.push(label); continue; }
        const sheetQty = qty ?? 0;
        if (sheetQty === r.v.stock) { same++; continue; }
        if (r.v.stock !== 0) { kept++; continue; }
        setTarget(r, String(sheetQty), { sheetId, by: m.by });
        filled++;
        if (m.by === "name") byName++;
      }

      renderNotice(h("div", { class: "notice-info" },
        h("p", {}, filled
          ? `Hoja WEB: se completó el nuevo stock de ${filled} ${filled === 1 ? "presentación" : "presentaciones"} que estaban en 0. Todavía no se guardó nada: revisá y confirmá.`
          : "Hoja WEB leída: no hay presentaciones en 0 para completar."),
        byName ? h("p", {}, byName === 1 ? "1 se encontró por nombre y presentación (no estaba vinculada a su fila): al guardar se vincula." : `${byName} se encontraron por nombre y presentación (no estaban vinculadas a su fila): al guardar se vinculan.`) : null,
        same ? h("p", {}, same === 1 ? "1 ya coincide con la hoja." : `${same} ya coinciden con la hoja.`) : null,
        kept ? h("p", {}, `${kept === 1 ? "1 ya tiene stock cargado distinto al de la hoja: no se toca" : `${kept} ya tienen stock cargado distinto al de la hoja: no se tocan`}. Si la hoja es la correcta, escribí la cantidad a mano.`) : null,
        missing.length ? h("p", {}, `No están en la hoja: ${missing.join(", ")}.`) : null,
        invalid.length ? h("p", {}, `Stock no válido en la hoja: ${invalid.join(", ")}.`) : null));
      if (filled) showFilter.value = "changed";
      renderTable();
      renderBar();
    } catch (err) {
      console.error(err);
      renderNotice(h("p", { class: "form-error" }, `No se pudo leer la hoja WEB: ${err?.message || err}`));
    } finally {
      importButton.disabled = false;
      importButton.textContent = "Importación inicial desde la hoja WEB";
    }
  });

  // Aviso al salir con cambios sin guardar.
  const beforeUnload = (e) => { if (edits.size && view.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const cleanup = () => { if (!view.isConnected) { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("hashchange", cleanup); } };
  window.addEventListener("hashchange", cleanup);

  search.addEventListener("input", renderTable);
  showFilter.addEventListener("change", renderTable);

  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Stock")),
    h("p", { class: "muted" },
      "El stock se maneja acá y vive en Supabase. Escribí la cantidad que tenés y confirmá: se registra un movimiento por la diferencia ",
      "(entrada si sube, ajuste si baja), con su historial en la ficha del producto. La hoja WEB solo sirve para la importación inicial."),
    h("div", { class: "toolbar" }, search, showFilter, importButton),
    info,
    notice,
    bar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-edit" },
        h("thead", {}, h("tr", {}, ["Producto", "Presentación", "Precio", "Stock actual", "Nuevo stock", "Diferencia", "Hoja WEB"].map((t) => h("th", {}, t)))),
        tbody)));
  renderTable();
}
