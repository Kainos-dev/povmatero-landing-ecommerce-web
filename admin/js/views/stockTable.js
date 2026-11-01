// Stock: todas las presentaciones que controlan stock (hoy, las yerbas).
// Supabase es la única fuente del stock: para cambiarlo se escribe la cantidad
// contada y se registra un movimiento por la diferencia (entrada o ajuste).
import * as api from "../api/catalog.js";
import { registerMovement, getVariantStock } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage, normalizeText, toast } from "../ui.js";

const ENTRY_REASON = "Ingreso de mercadería";
const ADJUST_REASON = "Conteo físico";

// "12" → 12; vacío o inválido → null.
function readCount(text) {
  const t = String(text ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 ? n : NaN;
}

// query (desde Inicio): { f: "zero" | "low" }
export async function renderStockTable(view, query = {}) {
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

  // Ediciones: variantId → { target: "texto" }
  const edits = new Map();
  let saving = false;
  let lastErrors = [];

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar producto o presentación…", "aria-label": "Buscar" });
  const showFilter = h("select", { class: "input", "aria-label": "Mostrar" },
    h("option", { value: "" }, "Todas"),
    h("option", { value: "zero" }, "Sin stock"),
    h("option", { value: "low" }, "Stock bajo (1 unidad)"),
    h("option", { value: "changed" }, "Con cambios sin guardar"));
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
    return { rows };
  }
  idx = index();

  const target = (r) => {
    const e = edits.get(r.v.id);
    return e ? readCount(e.target) : null;
  };

  function setTarget(r, value) {
    const n = readCount(value);
    if (String(value).trim() === "" || n === r.v.stock) edits.delete(r.v.id);
    else edits.set(r.v.id, { target: String(value) });
  }

  // ---------- Tabla ----------
  function visible() {
    const q = normalizeText(search.value.trim());
    return idx.rows.filter((r) => {
      if (q && !normalizeText(`${r.p.name} ${r.v.name}`).includes(q)) return false;
      if (showFilter.value === "zero" && r.v.stock !== 0) return false;
      if (showFilter.value === "low" && r.v.stock !== 1) return false;
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
    const diff = h("td", { class: "num c-diff" }, diffText(r));
    const tr = h("tr", { class: [e ? "row-dirty" : "", r.p.is_active ? "" : "row-inactive"].join(" ").trim() },
      h("td", { class: first ? "c-prod" : "c-prod c-cont" }, first ? h("a", { href: `#/productos/${r.p.id}` }, r.p.name) : h("span", { class: "muted", "aria-hidden": "true" }, "↳"),
        first && !r.p.is_active ? h("span", { class: "muted" }, " (borrador)") : null),
      h("td", { class: "c-var" }, r.v.name, r.v.is_active ? null : h("span", { class: "muted" }, " (inactiva)")),
      h("td", { class: "num c-price" }, formatPrice(r.v.price)),
      h("td", { class: "num c-stock", "data-label": "Hay" }, h("strong", { class: r.v.stock === 0 ? "text-alert" : "" }, String(r.v.stock))),
      h("td", { class: "c-input" }, input),
      diff
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
      : h("tr", {}, h("td", { colspan: "6", class: "empty" }, "No hay presentaciones que coincidan.")));
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
      changes.push({ r, label, target: t, delta: t - r.v.stock });
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
    const entryReason = h("input", { class: "input", maxlength: "200", value: ENTRY_REASON, "aria-label": "Motivo de las entradas" });
    const adjustReason = h("input", { class: "input", maxlength: "200", value: ADJUST_REASON, "aria-label": "Motivo de los ajustes" });
    const manualEntries = changes.filter((c) => c.delta > 0).length;
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
        `: ${c.r.v.stock} → ${c.target} (${c.delta > 0 ? `entrada +${c.delta}` : `ajuste ${c.delta}`})`))),
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
    let ok = 0;
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
          reason: c.delta > 0 ? reasons.entry : reasons.adjust,
        });
        ok++;
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
    renderNotice();
    if (showFilter.value === "changed") showFilter.value = "";
    renderTable();
    renderBar();
  }

  function renderNotice() {
    mount(notice,
      lastErrors.length ? h("div", { class: "form-error" }, h("ul", {}, lastErrors.map((t) => h("li", {}, t)))) : null);
  }

  // Aviso al salir con cambios sin guardar.
  const beforeUnload = (e) => { if (edits.size && view.isConnected) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  const cleanup = () => { if (!view.isConnected) { window.removeEventListener("beforeunload", beforeUnload); window.removeEventListener("hashchange", cleanup); } };
  window.addEventListener("hashchange", cleanup);

  if (query.f === "zero" || query.f === "low") showFilter.value = query.f;
  search.addEventListener("input", renderTable);
  showFilter.addEventListener("change", renderTable);

  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Stock")),
    h("p", { class: "muted" },
      "El stock se maneja acá y vive en Supabase. Escribí la cantidad que tenés y confirmá: se registra un movimiento por la diferencia ",
      "(entrada si sube, ajuste si baja), con su historial en la ficha del producto."),
    h("div", { class: "toolbar" }, search, showFilter),
    info,
    notice,
    bar,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-edit table-cards table-stock" },
        h("thead", {}, h("tr", {}, ["Producto", "Presentación", "Precio", "Stock actual", "Nuevo stock", "Diferencia"].map((t) => h("th", {}, t)))),
        tbody)));
  renderTable();
}
