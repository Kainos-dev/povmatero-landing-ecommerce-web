// Pedido a proveedor (Stock rápido › Pedidos a proveedor).
//   Armar:  yerbas con las fotos de la góndola, agrupadas por marca en el
//           orden de compra (Canarias, Baldo, Esmeralda, Rei Verde, Sara,
//           Barao, Pindaré, Verdecita y el resto). Por presentación: stock
//           actual, cantidad a pedir (+ / −) y stock proyectado. Sin precios.
//   Resumen: lo pedido por presentación, mensaje para WhatsApp, guardar.
//           Guardar NO suma stock.
//   Recibir: «Confirmar pedido completo» (suma lo pedido) o «Confirmar con
//           variaciones» (cantidades finales, quitar productos, resumen de
//           diferencias). Lo valida la base: suma una sola vez y nunca una
//           recepción vacía (public.admin_receive_supplier_order).
import { h, mount, toast, errorMessage, normalizeText } from "../ui.js";
import { optimizedSrc } from "/js/lib/images.js";
import * as api from "../api/stockTools.js";

const message = (err) => (err?.hint === "empty_reception" ? err.message : api.toolErrorMessage(err, errorMessage));
const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDate = (v) => (v ? DATE.format(new Date(v)) : "—");
const STATUS = { pedido: "Pedido", recibido: "Recibido", cancelado: "Cancelado" };
const DRAFT_KEY = "povmatero-pedido-proveedor";

// ---------------------------------------------------------------------
// Orden de compra por marca (solo esta pantalla; la tienda no cambia)
// ---------------------------------------------------------------------
const GROUPS = ["Canarias", "Baldo", "Esmeralda", "Rei Verde", "Sara", "Barao", "Pindaré", "Verdecita"];
const OTHERS = "Otras marcas";
const norm = (s) => normalizeText(s).replace(/\s+/g, " ").trim();

export function groupOf(productName) {
  const n = norm(productName);
  const i = GROUPS.findIndex((g) => n === norm(g) || n.startsWith(norm(g) + " "));
  return i < 0 ? { index: GROUPS.length, name: OTHERS } : { index: i, name: GROUPS[i] };
}
// «Canarias Tradicional» bajo «Canarias» → «Tradicional»
function shortName(productName, group) {
  if (group === OTHERS) return productName;
  const rest = productName.trim().slice(group.length).trim();
  return norm(productName).startsWith(norm(group) + " ") && rest ? rest : productName;
}
// «500gr» → { grams: 500, label: "500 g" }; «1kg» → 1000, «1 kg»
export function presentation(name) {
  const m = String(name ?? "").match(/(\d+(?:[.,]\d+)?)\s*(kg|kilo|g|gr|grs)\b/i);
  if (!m) return { grams: 0, label: name === "Único" ? "Única" : String(name ?? "") };
  const n = Number(m[1].replace(",", "."));
  const grams = /^k/i.test(m[2]) ? n * 1000 : n;
  return { grams, label: grams >= 1000 ? `${grams / 1000} kg` : `${grams} g` };
}

// Yerbas agrupadas y ordenadas: [{ group, products: [{ product, variants }] }]
function arrange(variants) {
  const byProduct = new Map();
  for (const v of variants) {
    if (!byProduct.has(v.product.id)) byProduct.set(v.product.id, { product: v.product, variants: [] });
    byProduct.get(v.product.id).variants.push(v);
  }
  const groups = new Map();
  for (const p of byProduct.values()) {
    const g = groupOf(p.product.name);
    p.group = g.name;
    p.short = shortName(p.product.name, g.name);
    // presentaciones: la más grande primero (1 kg, 500 g), igual en todas
    p.variants.sort((a, b) => presentation(b.name).grams - presentation(a.name).grams || a.sort - b.sort || a.id - b.id);
    if (!groups.has(g.index)) groups.set(g.index, { index: g.index, group: g.name, products: [] });
    groups.get(g.index).products.push(p);
  }
  const out = [...groups.values()].sort((a, b) => a.index - b.index);
  for (const g of out) {
    g.products.sort(g.group === OTHERS
      ? (a, b) => a.product.name.localeCompare(b.product.name, "es")
      : (a, b) => a.product.sort - b.product.sort || a.product.id - b.product.id);
  }
  return out;
}

// ---------------------------------------------------------------------
// Mensaje para WhatsApp: agrupado por marca, en el mismo orden
// items: [{ product_name, variant_name, quantity }]
// ---------------------------------------------------------------------
export function supplierMessage({ supplier, items, note }) {
  const lines = items.filter((i) => Number(i.quantity) > 0).map((i) => {
    const g = groupOf(i.product_name);
    return { ...i, g, short: shortName(i.product_name, g.name), pres: presentation(i.variant_name) };
  }).sort((a, b) => a.g.index - b.g.index || (a.g.name === OTHERS ? a.product_name.localeCompare(b.product_name, "es") : 0) || b.pres.grams - a.pres.grams);
  const out = [`Hola${supplier ? ` ${supplier}` : ""}! Te paso el pedido de yerbas de Povmatero:`];
  let current = null;
  for (const l of lines) {
    if (l.g.name !== current) { current = l.g.name; out.push("", `*${current.toUpperCase()}*`); }
    out.push(`• ${l.short}${l.pres.label ? ` ${l.pres.label}` : ""} × ${l.quantity}`);
  }
  const units = lines.reduce((n, l) => n + Number(l.quantity), 0);
  out.push("", `Total: ${units} ${units === 1 ? "unidad" : "unidades"} en ${lines.length} ${lines.length === 1 ? "presentación" : "presentaciones"}.`);
  if (note) out.push("", note);
  out.push("", "¡Gracias!");
  return out.join("\n");
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

// Paquete (misma imagen que la góndola) o uno genérico con el nombre.
function pack(product, variant = null, size = 72) {
  const src = variant?.image ?? product.image ?? product.cover;
  const box = h("span", { class: "sp-pack", style: `--w:${size}px` });
  if (src) {
    const img = h("img", { src: optimizedSrc(src, 256), alt: "", loading: "lazy", decoding: "async" });
    img.addEventListener("error", () => { if (img.dataset.failed) return; img.dataset.failed = "1"; img.replaceWith(h("span", { class: "sp-pack-text" }, product.name)); });
    box.append(img);
  } else {
    box.append(h("span", { class: "sp-pack-text" }, product.name));
  }
  return box;
}

function stepper(value, { onChange, label, max = 9999 }) {
  const input = h("input", { type: "number", class: "input sp-qty", min: "0", max: String(max), step: "1", inputmode: "numeric", value: String(value), "aria-label": label });
  const set = (n) => { const v = Math.max(0, Math.min(max, Number.isInteger(n) ? n : 0)); input.value = String(v); onChange(v); };
  const minus = h("button", { type: "button", class: "sp-step", "aria-label": `Uno menos: ${label}`, disabled: value <= 0 }, "−");
  const plus = h("button", { type: "button", class: "sp-step", "aria-label": `Uno más: ${label}` }, "+");
  minus.addEventListener("click", () => set(Number(input.value) - 1));
  plus.addEventListener("click", () => set(Number(input.value) + 1));
  input.addEventListener("change", () => set(Math.floor(Number(input.value))));
  return h("div", { class: "sp-stepper" }, minus, input, plus);
}

// ---------------------------------------------------------------------
// Vista principal
// ---------------------------------------------------------------------
export async function renderSupplier(body) {
  mount(body, h("p", { class: "muted" }, "Cargando yerbas…"));
  let variants;
  try {
    variants = await api.listYerbasForSupplier();
  } catch (err) {
    console.error(err);
    mount(body, h("p", { class: "notice-warn" }, message(err)));
    return;
  }
  const state = {
    byId: new Map(variants.map((v) => [v.id, v])),
    groups: arrange(variants),
    qty: new Map(),          // variante → cantidad a pedir
    supplier: "",
    note: "",
    filter: null,            // marca visible (null = todas)
    search: "",
    key: api.newKey(),
  };
  state.filter = state.groups[0]?.group ?? null;
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
    if (d?.qty) for (const [id, n] of d.qty) if (state.byId.has(id) && n > 0) state.qty.set(id, n);
    if (d?.supplier) state.supplier = d.supplier;
    if (d?.note) state.note = d.note;
  } catch { /* sin borrador */ }
  const saveDraft = () => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ qty: [...state.qty], supplier: state.supplier, note: state.note })); } catch { /* sin almacenamiento */ }
  };
  const view = { body, state, saveDraft, reload: () => renderSupplier(body) };
  drawBuilder(view);
}

function draftItems(state) {
  return [...state.qty].filter(([, n]) => n > 0).map(([id, n]) => {
    const v = state.byId.get(id);
    return { variant_id: id, quantity: n, product_name: v.product.name, variant_name: v.name };
  });
}

function drawBuilder(view) {
  const { body, state } = view;
  const chips = h("div", { class: "sp-chips", role: "group", "aria-label": "Marcas" });
  const search = h("input", { type: "search", class: "input", placeholder: "Buscar yerba…", "aria-label": "Buscar yerba", value: state.search });
  const grid = h("div", { class: "sp-grid" });
  const summary = h("aside", { class: "sp-summary", id: "sp-summary", "aria-label": "Resumen del pedido" });
  const bar = h("div", { class: "sp-bar" });
  const history = h("section", { class: "panel" }, h("p", { class: "muted" }, "Cargando pedidos anteriores…"));

  const units = () => [...state.qty.values()].reduce((a, b) => a + b, 0);
  const lines = () => [...state.qty.values()].filter((n) => n > 0).length;

  function drawChips() {
    const ordered = units();
    mount(chips,
      [...state.groups.map((g) => [g.group, g.group]), [null, "Todas"], ["__pedido", `En el pedido (${lines()})`]].map(([key, label]) => {
        const on = state.filter === key && !state.search;
        const b = h("button", { type: "button", class: `chip sp-chip${on ? " active" : ""}`, "aria-pressed": on ? "true" : "false" }, label);
        b.addEventListener("click", () => { state.filter = key; state.search = ""; search.value = ""; drawChips(); drawGrid(); });
        return b;
      }));
    return ordered;
  }

  function visibleGroups() {
    const q = norm(state.search);
    return state.groups.map((g) => ({
      ...g,
      products: g.products.filter((p) => {
        if (q) return norm(`${p.product.name} ${p.product.brand ?? ""}`).includes(q);
        if (state.filter === "__pedido") return p.variants.some((v) => (state.qty.get(v.id) ?? 0) > 0);
        return state.filter == null || g.group === state.filter;
      }),
    })).filter((g) => g.products.length);
  }

  function drawGrid() {
    const groups = visibleGroups();
    mount(grid, groups.length ? groups.map((g) => h("section", { class: "sp-group" },
      h("h3", { class: "sp-group-title" }, g.group),
      h("div", { class: "sp-cards" }, g.products.map((p) => card(p)))))
      : h("p", { class: "empty-box" }, state.filter === "__pedido" ? "Todavía no agregaste yerbas al pedido." : "No hay yerbas con ese nombre."));
  }

  function card(p) {
    const el = h("article", { class: "sp-card", "data-product": p.product.id });
    const rows = p.variants.map((v) => {
      const pres = presentation(v.name);
      const n = state.qty.get(v.id) ?? 0;
      const projected = h("strong", { class: "sp-proj" }, String(v.stock + n));
      const row = h("div", { class: `sp-row${n ? " has-qty" : ""}`, "data-variant": v.id },
        h("div", { class: "sp-row-head" },
          h("span", { class: "sp-pres" }, pres.label),
          h("span", { class: "sp-stock" }, "Stock actual ", h("strong", {}, String(v.stock)))),
        h("div", { class: "sp-row-ctrl" },
          stepper(n, { label: `${p.product.name} ${pres.label}`, onChange: (q) => {
            if (q > 0) state.qty.set(v.id, q); else state.qty.delete(v.id);
            projected.textContent = String(v.stock + q);
            row.classList.toggle("has-qty", q > 0);
            row.querySelector(".sp-step").disabled = q <= 0;
            view.saveDraft(); state.key = api.newKey();
            drawSummary(); drawChips();
          } }),
          h("span", { class: "sp-proj-wrap" }, "Proyectado ", projected)));
      return row;
    });
    mount(el,
      h("div", { class: "sp-card-head" }, pack(p.product, p.variants.find((v) => v.image) ?? null),
        h("div", {},
          h("strong", { class: "sp-name" }, p.short),
          p.group !== OTHERS && p.short !== p.product.name ? h("small", { class: "muted" }, p.product.name) : null,
          p.product.active ? null : h("small", { class: "sp-tag" }, "No publicada"))),
      rows);
    return el;
  }

  function drawSummary() {
    const items = draftItems(state);
    const u = units();
    const msgText = items.length ? supplierMessage({ supplier: state.supplier, items, note: state.note }) : "";
    const supplier = h("input", { class: "input", maxlength: "120", placeholder: "Ej.: Distribuidora Sur", value: state.supplier, "aria-label": "Proveedor" });
    const note = h("input", { class: "input", maxlength: "500", placeholder: "Opcional: entrega, forma de pago…", value: state.note, "aria-label": "Nota" });
    const preview = h("textarea", { class: "input msg-preview", rows: "8", readOnly: true, "aria-label": "Mensaje para el proveedor" }, msgText);
    preview.value = msgText;
    const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    const save = h("button", { type: "button", class: "btn-primary btn-block", disabled: !items.length }, "Guardar pedido y copiar mensaje");
    const copy = h("button", { type: "button", class: "btn-ghost btn-block", disabled: !items.length }, "Copiar mensaje");
    const clear = h("button", { type: "button", class: "btn-ghost btn-sm", disabled: !items.length }, "Vaciar");
    supplier.addEventListener("input", () => { state.supplier = supplier.value; preview.value = items.length ? supplierMessage({ supplier: state.supplier, items, note: state.note }) : ""; view.saveDraft(); state.key = api.newKey(); });
    note.addEventListener("input", () => { state.note = note.value; preview.value = items.length ? supplierMessage({ supplier: state.supplier, items, note: state.note }) : ""; view.saveDraft(); state.key = api.newKey(); });
    copy.addEventListener("click", async () => toast(await copyText(preview.value) ? "Mensaje copiado." : "No se pudo copiar: seleccioná el texto y copialo."));
    clear.addEventListener("click", () => { state.qty.clear(); view.saveDraft(); state.key = api.newKey(); drawGrid(); drawSummary(); drawChips(); });
    save.addEventListener("click", async () => {
      save.disabled = true; save.textContent = "Guardando…"; errorBox.hidden = true;
      try {
        const res = await api.createSupplierOrder({ items, supplier: state.supplier.trim(), note: state.note.trim(), key: state.key });
        const copied = await copyText(supplierMessage({ supplier: res.supplier, items: res.items, note: res.note }));
        toast(`Pedido a proveedor #${res.id} guardado${copied ? " y mensaje copiado" : ""}. El stock se suma recién al confirmar la recepción.`);
        state.qty.clear(); state.note = ""; state.key = api.newKey(); view.saveDraft();
        document.getElementById("sp-summary")?.classList.remove("open");
        drawGrid(); drawSummary(); drawChips(); loadHistory();
      } catch (err) {
        console.warn(err);
        errorBox.textContent = message(err); errorBox.hidden = false;
        save.disabled = false; save.textContent = "Guardar pedido y copiar mensaje";
      }
    });
    const byGroup = new Map();
    for (const i of items) {
      const g = groupOf(i.product_name).name;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(i);
    }
    mount(summary,
      h("div", { class: "sp-summary-head" },
        h("h3", {}, "Resumen del pedido"),
        h("button", { type: "button", class: "btn-ghost btn-sm sp-close", onclick: () => summary.classList.remove("open"), "aria-label": "Cerrar resumen" }, "Cerrar")),
      items.length ? h("div", { class: "sp-summary-list" },
        [...byGroup].sort((a, b) => groupOf(a[1][0].product_name).index - groupOf(b[1][0].product_name).index).map(([g, list]) => h("div", {},
          h("p", { class: "sp-summary-group" }, g),
          h("ul", {}, list.map((i) => {
            const v = state.byId.get(i.variant_id);
            return h("li", {}, h("span", {}, `${shortName(i.product_name, g)} ${presentation(i.variant_name).label}`),
              h("span", { class: "muted" }, `${v.stock} → ${v.stock + i.quantity}`),
              h("strong", {}, `× ${i.quantity}`));
          })))))
        : h("p", { class: "muted" }, "Sumá unidades con + en las yerbas que querés pedir."),
      h("p", { class: "sp-total" }, h("span", {}, `${lines()} ${lines() === 1 ? "presentación" : "presentaciones"}`), h("strong", {}, `${u} ${u === 1 ? "unidad" : "unidades"}`)),
      h("label", { class: "field" }, h("span", {}, "Proveedor"), supplier),
      h("label", { class: "field" }, h("span", {}, "Nota"), note),
      h("label", { class: "field" }, h("span", {}, "Mensaje para WhatsApp"), preview),
      h("p", { class: "hint" }, "Guardar el pedido no suma stock: se suma al confirmar la recepción."),
      errorBox,
      h("div", { class: "sp-summary-actions" }, save, copy, clear));
    mount(bar,
      h("span", {}, h("strong", {}, `${u} ${u === 1 ? "unidad" : "unidades"}`), ` · ${lines()} ${lines() === 1 ? "presentación" : "presentaciones"}`),
      h("button", { type: "button", class: "btn-primary btn-sm", onclick: () => { summary.classList.add("open"); summary.scrollTop = 0; } }, "Ver resumen"));
    bar.hidden = !items.length;
  }

  async function loadHistory() {
    let orders;
    try {
      orders = await api.listSupplierOrders();
    } catch (err) {
      mount(history, h("p", { class: "notice-warn" }, message(err)));
      return;
    }
    mount(history,
      h("div", { class: "panel-head" }, h("h2", {}, "Pedidos anteriores")),
      orders.length ? h("div", { class: "pane-stack" }, orders.map((o) => supplierCard(o, view, loadHistory)))
        : h("p", { class: "muted" }, "Todavía no hay pedidos a proveedor."));
  }

  search.addEventListener("input", () => { state.search = search.value; drawChips(); drawGrid(); });
  drawChips(); drawGrid(); drawSummary();
  mount(body,
    h("div", { class: "sp-layout" },
      h("div", { class: "sp-main" },
        h("p", { class: "hint" }, "Tocá + en cada presentación. Ves el stock actual y cómo quedaría al recibir el pedido. Sin precios."),
        h("div", { class: "sp-tools" }, search),
        chips,
        grid),
      summary),
    bar,
    history);
  loadHistory();
}

// ---------------------------------------------------------------------
// Pedidos anteriores y recepción
// ---------------------------------------------------------------------
function supplierCard(o, view, reload) {
  const items = o.supplier_order_items ?? [];
  const card = h("article", { class: "supplier-card", "data-order": o.id });
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const actions = h("div", { class: "actions" });
  const units = (list, key) => list.reduce((n, i) => n + Number(i[key] ?? 0), 0);

  function head() {
    return h("div", { class: "supplier-head" },
      h("strong", {}, `#${o.id}${o.supplier ? ` · ${o.supplier}` : ""}`),
      h("span", { class: `badge supplier-st supplier-st-${o.status}` }, STATUS[o.status] ?? o.status),
      h("span", { class: "muted" }, `Pedido ${fmtDate(o.created_at)}${o.received_at ? ` · recibido ${fmtDate(o.received_at)}` : ""}${o.cancelled_at ? ` · cancelado ${fmtDate(o.cancelled_at)}` : ""}`));
  }
  function list() {
    return h("ul", { class: "order-lines" }, items.map((i) => {
      const got = i.received_quantity;
      const diff = o.status === "recibido" && got !== i.quantity;
      return h("li", { class: diff ? "sp-diff" : "" },
        h("span", { class: "order-line-qty" }, `${o.status === "recibido" ? got : i.quantity}×`),
        h("span", { class: "order-line-name" }, i.product_name, i.variant_name ? h("small", {}, presentation(i.variant_name).label) : null,
          diff ? h("small", { class: "sp-diff-note" }, got === 0 ? `No vino (se pidieron ${i.quantity})` : `Se pidieron ${i.quantity}, llegaron ${got}`) : null));
    }));
  }
  function view0() {
    const buttons = [];
    if (o.status === "pedido") {
      buttons.push(h("button", { type: "button", class: "btn-primary btn-sm", onclick: confirmFull }, "Confirmar pedido completo"));
      buttons.push(h("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => openVariations(o, view, reload) }, "Confirmar con variaciones"));
      buttons.push(h("button", { type: "button", class: "btn-ghost btn-sm", onclick: async () => toast(await copyText(supplierMessage({ supplier: o.supplier, items, note: o.note })) ? "Mensaje copiado." : "No se pudo copiar.") }, "Copiar mensaje"));
      buttons.push(h("button", { type: "button", class: "btn-ghost btn-sm btn-danger", onclick: confirmCancel }, "Cancelar"));
    }
    mount(actions, buttons);
    const totals = o.status === "recibido"
      ? h("p", { class: "muted" }, `Pedido: ${units(items, "quantity")} · Recibido: ${units(items, "received_quantity")}`)
      : h("p", { class: "muted" }, `${units(items, "quantity")} unidades`);
    mount(card, head(), list(), totals, o.note ? h("p", { class: "muted" }, o.note) : null, errorBox, actions);
  }
  async function run(button, fn, done) {
    errorBox.hidden = true;
    card.querySelectorAll("button, input").forEach((b) => { b.disabled = true; });
    button.textContent = "Guardando…";
    try {
      const res = await fn();
      toast(res?.already_received ? `El pedido #${o.id} ya estaba recibido: no se sumó de nuevo.` : done);
      view.reload();
    } catch (err) {
      console.warn(err);
      errorBox.textContent = message(err); errorBox.hidden = false;
      view0();
    }
  }
  function confirmFull() {
    const total = units(items, "quantity");
    const yes = h("button", { type: "button", class: "btn-primary btn-sm" }, "Sí, sumar al stock");
    yes.addEventListener("click", () => run(yes, () => api.receiveSupplierOrder(o.id, null), `Recepción confirmada: +${total} ${total === 1 ? "unidad" : "unidades"} al stock.`));
    mount(actions, h("div", { class: "confirm-box" },
      h("strong", {}, `¿Llegó todo el pedido #${o.id}?`),
      h("ul", { class: "sp-confirm-list" }, items.map((i) => {
        const v = view.state.byId.get(i.variant_id);
        return h("li", {}, `${i.product_name} ${presentation(i.variant_name).label}: +${i.quantity}`, v ? h("span", { class: "muted" }, ` (stock ${v.stock} → ${v.stock + i.quantity})`) : null);
      })),
      h("span", {}, `Se suman ${total} ${total === 1 ? "unidad" : "unidades"}, una sola vez.`),
      h("div", { class: "actions" }, yes, h("button", { type: "button", class: "btn-ghost btn-sm", onclick: view0 }, "Volver"))));
  }
  function confirmCancel() {
    const yes = h("button", { type: "button", class: "btn-primary btn-sm btn-danger-solid" }, "Sí, cancelar");
    yes.addEventListener("click", () => run(yes, () => api.cancelSupplierOrder(o.id), `Pedido a proveedor #${o.id} cancelado.`));
    mount(actions, h("div", { class: "confirm-box confirm-danger" },
      h("strong", {}, `¿Cancelar el pedido a proveedor #${o.id}?`),
      h("span", {}, "No cambia el stock."),
      h("div", { class: "actions" }, yes, h("button", { type: "button", class: "btn-ghost btn-sm", onclick: view0 }, "No"))));
  }
  view0();
  return card;
}

// Confirmar con variaciones: cantidades finales, quitar productos, diferencias.
function openVariations(o, view, reload) {
  const { body, state } = view;
  const items = (o.supplier_order_items ?? []).filter((i) => i.variant_id);
  const final = new Map(items.map((i) => [i.variant_id, i.quantity]));
  const listEl = h("div", { class: "sp-recv-list" });
  const diffEl = h("div");
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const review = h("button", { type: "button", class: "btn-primary" }, "Revisar diferencias");
  const back = h("button", { type: "button", class: "btn-ghost", onclick: () => view.reload() }, "Volver sin confirmar");

  function row(i) {
    const v = state.byId.get(i.variant_id);
    const pres = presentation(i.variant_name).label;
    const n = final.get(i.variant_id);
    const removed = n === 0;
    const projected = h("strong", {}, v ? String(v.stock + n) : "—");
    const el = h("div", { class: `sp-recv${removed ? " is-removed" : ""}${n !== i.quantity ? " is-changed" : ""}`, "data-variant": i.variant_id },
      v ? pack(v.product, v, 52) : null,
      h("div", { class: "sp-recv-info" },
        h("strong", {}, `${i.product_name} ${pres}`),
        h("span", { class: "muted" }, "Solicitado ", h("strong", {}, String(i.quantity)),
          v ? ` · Stock actual ${v.stock} · Proyectado ` : "", v ? projected : null)),
      h("div", { class: "sp-recv-ctrl" },
        stepper(n, { label: `Recibir ${i.product_name} ${pres}`, max: 9999, onChange: (q) => { final.set(i.variant_id, q); paint(); } }),
        h("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => { final.set(i.variant_id, removed ? i.quantity : 0); paint(); } }, removed ? "Volver a agregar" : "Quitar (no vino)")));
    return el;
  }
  function paint() {
    mount(listEl, items.map(row));
    mount(diffEl);
    errorBox.hidden = true;
    review.hidden = false;
  }
  review.addEventListener("click", () => {
    const changed = items.filter((i) => final.get(i.variant_id) !== i.quantity && final.get(i.variant_id) > 0);
    const removed = items.filter((i) => final.get(i.variant_id) === 0);
    const same = items.length - changed.length - removed.length;
    const total = items.reduce((n, i) => n + final.get(i.variant_id), 0);
    const asked = items.reduce((n, i) => n + i.quantity, 0);
    const yes = h("button", { type: "button", class: "btn-primary", disabled: total === 0 }, "Confirmar recepción");
    yes.addEventListener("click", async () => {
      yes.disabled = true; yes.textContent = "Guardando…"; errorBox.hidden = true;
      try {
        const res = await api.receiveSupplierOrder(o.id, items.map((i) => ({ variant_id: i.variant_id, quantity: final.get(i.variant_id) })));
        toast(res?.already_received ? `El pedido #${o.id} ya estaba recibido: no se sumó de nuevo.` : `Recepción confirmada: +${total} ${total === 1 ? "unidad" : "unidades"} al stock.`);
        view.reload();
      } catch (err) {
        console.warn(err);
        errorBox.textContent = message(err); errorBox.hidden = false;
        yes.disabled = false; yes.textContent = "Confirmar recepción";
      }
    });
    review.hidden = true;
    mount(diffEl, h("div", { class: "confirm-box sp-diffs" },
      h("strong", {}, "Diferencias con lo pedido"),
      changed.length || removed.length ? h("ul", {},
        changed.map((i) => h("li", {}, `${i.product_name} ${presentation(i.variant_name).label}: ${i.quantity} → `, h("strong", {}, String(final.get(i.variant_id))))),
        removed.map((i) => h("li", { class: "sp-diff-removed" }, `${i.product_name} ${presentation(i.variant_name).label}: no vino (se pidieron ${i.quantity})`)))
        : h("p", {}, "Sin diferencias: llega todo lo pedido."),
      same && (changed.length || removed.length) ? h("p", { class: "muted" }, `${same} ${same === 1 ? "presentación llega" : "presentaciones llegan"} como se pidió.`) : null,
      h("p", {}, `Pedido: ${asked} · Se suman al stock: `, h("strong", {}, String(total)), total === 1 ? " unidad" : " unidades"),
      total === 0 ? h("p", { class: "notice-warn" }, "No hay unidades para recibir. Si el proveedor no tiene nada, volvé y cancelá el pedido.") : null,
      h("div", { class: "actions" }, yes, h("button", { type: "button", class: "btn-ghost", onclick: paint }, "Seguir editando"))));
  });

  paint();
  mount(body,
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, `Recepción con variaciones · pedido #${o.id}${o.supplier ? ` · ${o.supplier}` : ""}`)),
      h("p", { class: "hint" }, "Indicá lo que realmente llegó. Quitá lo que el proveedor no tenía. Se suma solo la cantidad final, una sola vez."),
      listEl,
      errorBox,
      h("div", { class: "actions" }, review, back),
      diffEl));
  body.scrollIntoView?.({ block: "start" });
}
