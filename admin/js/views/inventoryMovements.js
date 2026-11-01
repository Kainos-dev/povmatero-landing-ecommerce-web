// Inventario · Movimientos: historial de todas las entradas, salidas y ajustes,
// con filtros por producto, tipo y período, totales y descarga en CSV.
// Solo lee: los movimientos son un registro que no se edita ni se borra.
import * as api from "../api/catalog.js";
import { listMovementsPage, getCurrentUserId } from "../api/inventory.js";
import { h, mount, formatPrice, errorMessage, normalizeText } from "../ui.js";

const PAGE = 50;
const TYPE_LABELS = { entrada: "Entrada", salida: "Salida", ajuste: "Ajuste" };
const PERIODS = [["7", "Últimos 7 días"], ["30", "Últimos 30 días"], ["90", "Últimos 90 días"], ["", "Todo el historial"]];
const DATE = new Intl.DateTimeFormat("es-AR", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const signed = (n) => (n > 0 ? `+${n}` : String(n));

function csvCell(value) {
  const s = String(value ?? "");
  const safe = /^[=+\-@]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s) ? `'${s}` : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// query: { q: texto, tipo: "entrada" | "salida" | "ajuste", dias: "7" | "30" | "90" | "" }
export async function renderMovements(view, query = {}) {
  mount(view, h("p", { class: "muted" }, "Cargando movimientos…"));

  let products, variants, me;
  try {
    [products, variants, me] = await Promise.all([api.listProducts(), api.listAllVariantsWithCosts(), getCurrentUserId()]);
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }
  const productById = new Map(products.map((p) => [p.id, p]));
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const label = (variantId) => {
    const v = variantById.get(variantId);
    if (!v) return { product: "Variante eliminada", variant: "", productId: null };
    const p = productById.get(v.product_id);
    return { product: p?.name ?? "Producto", variant: v.name === api.SINGLE_VARIANT_NAME ? "" : v.name, productId: v.product_id };
  };
  const author = (row) => (row.created_by == null ? "Sistema" : row.created_by === me ? "Vos" : "Otro admin");

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar producto o presentación…", "aria-label": "Buscar", value: query.q ?? "" });
  const typeFilter = h("select", { class: "input", "aria-label": "Tipo" },
    h("option", { value: "" }, "Todos los tipos"),
    Object.entries(TYPE_LABELS).map(([k, t]) => h("option", { value: k }, `${t}s`)));
  typeFilter.value = TYPE_LABELS[query.tipo] ? query.tipo : "";
  const periodFilter = h("select", { class: "input", "aria-label": "Período" },
    PERIODS.map(([v, t]) => h("option", { value: v }, t)));
  periodFilter.value = PERIODS.some(([v]) => v === query.dias) ? query.dias : "30";
  const csvButton = h("button", { type: "button", class: "btn-ghost", disabled: true }, "Descargar CSV");

  const summary = h("div", { class: "stats stats-3" });
  const list = h("div");
  const more = h("div", { class: "actions" });

  let rows = [], offset = 0, hasMore = false, loading = false, token = 0;

  function filters() {
    const days = Number(periodFilter.value);
    const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : null;
    const q = normalizeText(search.value.trim());
    const variantIds = q
      ? variants.filter((v) => normalizeText(`${productById.get(v.product_id)?.name ?? ""} ${v.name}`).includes(q)).map((v) => v.id)
      : null;
    return { type: typeFilter.value || null, since, variantIds };
  }

  async function load(reset) {
    const my = ++token;
    loading = true;
    if (reset) { rows = []; offset = 0; mount(list, h("p", { class: "muted" }, "Cargando…")); }
    mount(more);
    try {
      const page = await listMovementsPage({ ...filters(), limit: PAGE, offset });
      if (my !== token) return;   // llegó tarde: hubo otra búsqueda
      rows = rows.concat(page.rows);
      offset += page.rows.length;
      hasMore = page.more;
    } catch (err) {
      console.error(err);
      if (my !== token) return;
      mount(list, h("p", { class: "form-error" }, `No se pudo cargar el historial: ${errorMessage(err)}`));
      loading = false;
      return;
    }
    loading = false;
    render();
  }

  function render() {
    const units = (type) => rows.filter((r) => r.movement_type === type).reduce((s, r) => s + r.quantity, 0);
    const adjustments = rows.filter((r) => r.movement_type === "ajuste");
    mount(summary,
      h("div", { class: "stat" }, h("span", { class: "stat-value" }, signed(units("entrada"))), h("span", { class: "stat-caption" }, "unidades que entraron")),
      h("div", { class: "stat" }, h("span", { class: "stat-value" }, String(units("salida"))), h("span", { class: "stat-caption" }, "unidades que salieron")),
      h("div", { class: "stat" }, h("span", { class: "stat-value" }, String(adjustments.length)),
        h("span", { class: "stat-caption" }, `ajustes (${signed(adjustments.reduce((s, r) => s + r.quantity, 0))} u.)`)));
    const partial = hasMore ? h("p", { class: "hint" }, `Totales de los ${rows.length} movimientos cargados. Cargá más para incluir el resto.`) : null;

    csvButton.disabled = !rows.length;
    if (!rows.length) {
      mount(list, partial, h("div", { class: "empty-box" }, "No hay movimientos con estos filtros."));
      return;
    }
    mount(list, partial,
      h("div", { class: "table-wrap" },
        h("table", { class: "table table-cards table-moves" },
          h("thead", {}, h("tr", {},
            ["Fecha", "Producto", "Tipo", "Cantidad", "Quedó", "Motivo", "Referencia", "Costo u.", "Quién"].map((t, i) =>
              h("th", { class: i === 3 || i === 4 || i === 7 ? "num" : "" }, t)))),
          h("tbody", {}, rows.map((r) => {
            const l = label(r.variant_id);
            return h("tr", {},
              h("td", { class: "c-date" }, DATE.format(new Date(r.created_at))),
              h("td", { class: "c-prod" }, l.productId
                ? h("a", { href: `#/productos/${l.productId}?tab=stock` }, l.product)
                : l.product, l.variant ? h("span", { class: "muted" }, ` · ${l.variant}`) : null),
              h("td", { class: "c-type" }, h("span", { class: r.movement_type === "ajuste" ? "badge badge-warn" : "badge" }, TYPE_LABELS[r.movement_type] ?? r.movement_type)),
              h("td", { class: "num c-qty" }, h("strong", {}, signed(r.quantity))),
              h("td", { class: "num c-after", "data-label": "Quedó" }, r.stock_after ?? "—"),
              h("td", { class: "c-reason" }, r.reason || "—"),
              h("td", { class: "c-ref" }, r.reference || ""),
              h("td", { class: "num c-cost" }, r.unit_cost == null ? "" : formatPrice(r.unit_cost)),
              h("td", { class: "c-who" }, author(r)));
          })))));
    if (hasMore) {
      mount(more, h("button", { type: "button", class: "btn-ghost", disabled: loading, onClick: () => load(false) }, `Cargar ${PAGE} más`));
    }
  }

  csvButton.addEventListener("click", () => {
    const header = ["fecha", "producto", "variante", "tipo", "cantidad", "stock_resultante", "motivo", "referencia", "costo_unitario", "quien"];
    const lines = rows.map((r) => {
      const l = label(r.variant_id);
      return [r.created_at, l.product, l.variant, r.movement_type, r.quantity, r.stock_after ?? "", r.reason ?? "", r.reference ?? "", r.unit_cost ?? "", author(r)];
    });
    const text = "﻿" + [header, ...lines].map((r) => r.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: `movimientos-${new Date().toISOString().slice(0, 10)}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  let searchTimer = null;
  search.addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => load(true), 250); });
  typeFilter.addEventListener("change", () => load(true));
  periodFilter.addEventListener("change", () => load(true));

  mount(view,
    h("p", { class: "muted" }, "Todas las entradas, salidas y ajustes de stock. Es un registro: no se edita ni se borra."),
    h("div", { class: "toolbar" }, search, typeFilter, periodFilter, csvButton),
    summary,
    list,
    more);
  await load(true);
}
