// Stock rápido: tres herramientas separadas (no se mezclan).
//   Movimiento  entrada o salida sin cliente ni pedido (#/stock-rapido)
//   Proveedor   pedido de reposición: preparar (no mueve stock), copiar el
//               mensaje para WhatsApp y confirmar la recepción (suma stock)
//   Venta       venta presencial a un cliente registrado o a un nombre
//               («Sin asignar»): descuenta stock y queda como pedido
// Todo lo valida la base (stock, permisos, duplicados). Ver api/stockTools.js.
import { h, mount, toast, errorMessage, formatPrice, normalizeText } from "../ui.js";
import * as api from "../api/stockTools.js";
import { exitConciliation } from "./stockExit.js";
import { renderSupplier } from "./supplierOrders.js";

const TABS = [
  ["movimiento", "Movimiento rápido"],
  ["proveedor", "Pedidos a proveedor"],
  ["venta", "Venta presencial"],
];

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const fmtDate = (v) => (v ? DATE.format(new Date(v)) : "—");
const message = (err) => api.toolErrorMessage(err, errorMessage);

export async function renderStockTools(view, query = {}) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : "movimiento";
  const tabs = h("nav", { class: "segmented", "aria-label": "Herramientas de stock" },
    TABS.map(([k, label]) => h("a", {
      href: `#/stock-rapido?tab=${k}`, class: k === tab ? "active" : "", "aria-current": k === tab ? "page" : null,
    }, label)));
  const body = h("div", { class: "pane-stack" }, h("p", { class: "muted" }, "Cargando presentaciones…"));
  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Stock rápido"),
        h("p", { class: "page-sub" }, "Entradas y salidas, pedidos a proveedor y ventas en el local."))),
    tabs,
    body);

  let variants;
  try {
    variants = await api.listVariantsForStock();
  } catch (err) {
    console.error(err);
    mount(body, h("p", { class: "notice-warn" }, message(err)));
    return;
  }
  const byId = new Map(variants.map((v) => [v.id, v]));
  const ctx = { variants, byId };
  if (tab === "movimiento") renderMovement(body, ctx);
  else if (tab === "proveedor") renderSupplier(body);
  else renderSale(body, ctx);
}

// ---------------------------------------------------------------------
// Buscador de presentaciones (solo yerbas o todo el catálogo)
// ---------------------------------------------------------------------
function stockText(v) {
  if (!v.trackStock) return "sin control de stock";
  return v.committed ? `stock ${v.stock} · ${v.available} disponibles (${v.committed} reservadas)` : `stock ${v.stock}`;
}

function variantPicker(ctx, { onPick, allowAll = false, placeholder = "Buscar yerba o presentación…" }) {
  let all = false;
  const input = h("input", { type: "search", class: "input", placeholder, "aria-label": placeholder, autocomplete: "off" });
  const list = h("ul", { class: "pick-list", role: "listbox", "aria-label": "Presentaciones" });
  const toggle = allowAll ? h("label", { class: "check-inline" },
    h("input", { type: "checkbox", onchange: (e) => { all = e.target.checked; paint(); } }), " Todo el catálogo") : null;

  function paint() {
    const q = normalizeText(input.value.trim());
    const words = q.split(/\s+/).filter(Boolean);
    const found = ctx.variants
      .filter((v) => (all || v.category === "yerbas"))
      .filter((v) => words.every((w) => normalizeText(`${v.label} ${v.brand ?? ""}`).includes(w)))
      .slice(0, 40);
    mount(list, found.length ? found.map((v) => {
      const b = h("button", { type: "button", class: "pick-item", "data-variant": v.id },
        h("span", { class: "pick-name" }, v.productName, v.variantName ? h("small", {}, v.variantName) : null),
        h("span", { class: "pick-meta muted" }, stockText(v)));
      b.addEventListener("click", () => onPick(v));
      return h("li", {}, b);
    }) : h("li", { class: "muted pick-empty" }, "No hay presentaciones con ese nombre."));
  }
  input.addEventListener("input", paint);
  paint();
  return { el: h("div", { class: "picker" }, h("div", { class: "picker-top" }, input, toggle), list), focus: () => input.focus(), refresh: paint };
}

function intOf(input) {
  const n = Number(input.value);
  return Number.isInteger(n) ? n : NaN;
}

// ---------------------------------------------------------------------
// 1. Movimiento rápido
// ---------------------------------------------------------------------
const MOVE_REASONS = {
  entrada: ["Ingreso de mercadería", "Devolución de cliente", "Corrección"],
  salida: ["Venta en el local", "Rotura / dañado", "Uso interno", "Regalo / muestra"],
};

function renderMovement(body, ctx) {
  let selected = null;
  let type = "entrada";
  let key = api.newKey();
  let busy = false;

  const chosen = h("div", { class: "pick-chosen", hidden: true });
  const picker = variantPicker(ctx, { onPick: (v) => { selected = v; key = api.newKey(); drawChosen(); qty.focus(); } });
  const typeBox = h("div", { class: "segmented seg-buttons", role: "radiogroup", "aria-label": "Tipo de movimiento" });
  const qty = h("input", { type: "number", class: "input input-num", min: "1", max: "9999", step: "1", inputmode: "numeric", value: "1", "aria-label": "Cantidad" });
  const listId = "quick-reasons";
  const reason = h("input", { class: "input", maxlength: "120", list: listId, placeholder: "Opcional: motivo u observación" });
  const datalist = h("datalist", { id: listId });
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { type: "button", class: "btn-primary" }, "Confirmar entrada");
  const actions = h("div", { class: "actions" }, submit);
  const concileSlot = h("div");
  const recent = h("ul", { class: "move-list" });
  const shortages = h("div");

  function drawType() {
    mount(typeBox, ["entrada", "salida"].map((t) => {
      const b = h("button", { type: "button", role: "radio", class: t === type ? "active" : "", "aria-checked": t === type ? "true" : "false" }, t === "entrada" ? "Entrada (+)" : "Salida (−)");
      b.addEventListener("click", () => { type = t; key = api.newKey(); drawType(); });
      return b;
    }));
    mount(datalist, MOVE_REASONS[type].map((r) => h("option", { value: r })));
    submit.textContent = type === "entrada" ? "Confirmar entrada" : "Confirmar salida";
  }
  function drawChosen() {
    chosen.hidden = !selected;
    if (!selected) return;
    mount(chosen,
      h("strong", {}, selected.label),
      h("span", { class: "muted" }, stockText(selected)),
      h("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => { selected = null; drawChosen(); picker.focus(); } }, "Cambiar"));
  }
  [qty, reason].forEach((el) => el.addEventListener("input", () => { key = api.newKey(); errorBox.hidden = true; closeConcile(); }));

  function closeConcile() { mount(concileSlot); actions.hidden = false; }

  // Registra en la base (que vuelve a validar todo). Si mientras tanto cambió
  // el stock o las reservas, la base pide el conteo: se muestra la conciliación.
  async function register(n, extra = {}) {
    try {
      const res = await api.registerQuickMovement({
        variantId: selected.id, type, quantity: n, reason: reason.value.trim(), key, ...extra,
      });
      done(res, n);
    } catch (err) {
      const plan = api.planFromError(err);
      if (plan) { openConcile(plan, n); return; }
      throw err;
    }
  }

  function done(res, n) {
    if (res.stock_after != null) {
      selected.stock = res.stock_after;
      if (res.reserved != null) selected.committed = res.reserved;
      selected.available = selected.trackStock ? Math.max(selected.stock - selected.committed, 0) : null;
    }
    const adj = res.adjustment ? ` y corrección de inventario ${res.adjustment > 0 ? "+" : "−"}${Math.abs(res.adjustment)}` : "";
    toast(res.repeated ? "Ese movimiento ya estaba registrado (no se repitió)."
      : res.shortage ? `Salida registrada${adj}. ${selected.label} quedó como faltante (${res.shortage}).`
      : `${type === "entrada" ? "Entrada" : "Salida"} registrada${adj}: ${selected.label} (stock ${selected.stock}).`);
    key = api.newKey();
    qty.value = "1";
    reason.value = "";
    closeConcile();
    drawChosen();
    picker.refresh();
    loadRecent();
    loadShortages();
  }

  function openConcile(plan, n) {
    actions.hidden = true;
    const box = exitConciliation(plan, {
      onCancel: closeConcile,
      onConfirm: async ({ declared, confirmShortage }) => {
        try {
          await register(n, { declared, confirmShortage });
        } catch (err) {
          console.warn(err);
          throw new Error(message(err));
        }
      },
    });
    mount(concileSlot, box.el);
    box.focus();
  }

  submit.addEventListener("click", async () => {
    if (busy) return;
    errorBox.hidden = true;
    const n = intOf(qty);
    const fail = (m) => { errorBox.textContent = m; errorBox.hidden = false; };
    if (!selected) return fail("Elegí una yerba y presentación.");
    if (!Number.isInteger(n) || n < 1 || n > 9999) return fail("La cantidad tiene que ser un número entero entre 1 y 9999.");
    busy = true;
    submit.disabled = true;
    submit.textContent = "Revisando…";
    try {
      if (type === "salida") {
        // Stock y reservas al momento (no los de cuando se abrió la pantalla).
        const plan = await api.previewStock(selected.id, n);
        if (plan) {
          selected.stock = plan.stock; selected.committed = plan.reserved; selected.available = plan.track_stock ? plan.available : null;
          drawChosen();
          if (plan.exceeds) { openConcile(plan, n); return; }
        } else if (selected.trackStock && n > selected.stock) {
          return fail(`No alcanza: hay ${selected.stock} en stock.`);   // base sin migrar: como antes
        }
      }
      submit.textContent = "Guardando…";
      await register(n);
    } catch (err) {
      console.warn(err);
      fail(message(err));
    } finally {
      busy = false;
      submit.disabled = false;
      drawType();
    }
  });

  async function loadShortages() {
    let rows;
    try { rows = await api.listShortages(); } catch { mount(shortages); return; }   // sin la migración: no hay faltantes
    mount(shortages, rows.length ? h("section", { class: "panel panel-alert" },
      h("div", { class: "panel-head" }, h("h2", {}, `Faltantes para resolver (${rows.length})`)),
      h("p", { class: "hint" }, "Hay menos stock físico que lo reservado por pedidos web. Reponé o hablá con los clientes y marcalo resuelto."),
      h("ul", { class: "alert-list" }, rows.map((f) => {
        const v = ctx.byId.get(f.variant_id);
        const b = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Marcar resuelto");
        b.addEventListener("click", async () => {
          b.disabled = true;
          try { await api.resolveShortage(f.id, null); toast("Faltante marcado como resuelto."); loadShortages(); }
          catch (err) { toast(message(err), "error"); b.disabled = false; }
        });
        return h("li", { class: "alert-row" },
          h("div", { class: "alert-main" },
            h("strong", {}, v?.label ?? `Presentación #${f.variant_id}`),
            h("span", {}, `Faltan ${f.missing}: hay ${f.physical} y hay ${f.reserved} reservadas`),
            h("small", { class: "muted" }, fmtDate(f.created_at))),
          h("div", { class: "actions" }, h("a", { class: "btn-ghost btn-sm", href: "#/pedidos?tab=yerbas&f=pendiente" }, "Ver pedidos"), b));
      }))) : null);
  }

  async function loadRecent() {
    try {
      const rows = await api.listRecentQuickMovements();
      mount(recent, rows.length ? rows.map((m) => {
        const v = ctx.byId.get(m.variant_id);
        return h("li", { class: "move-row" },
          h("span", { class: `move-qty ${m.quantity > 0 ? "qty-pos" : "qty-neg"}` }, m.quantity > 0 ? `+${m.quantity}` : `−${Math.abs(m.quantity)}`),
          h("span", { class: "move-name" }, v?.label ?? `Presentación #${m.variant_id}`, h("small", { class: "muted" }, m.reason || "")),
          h("span", { class: "muted move-date" }, `${fmtDate(m.created_at)} · stock ${m.stock_after ?? "—"}`));
      }) : h("li", { class: "muted" }, "Todavía no hay movimientos rápidos."));
    } catch (err) {
      mount(recent, h("li", { class: "muted" }, message(err)));
    }
  }

  drawType();
  mount(body,
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Entrada o salida de stock")),
      h("p", { class: "hint" }, "Para ingresos, roturas o ventas sin cliente. No crea un pedido ni pide a quién."),
      picker.el, chosen,
      h("div", { class: "form-row" },
        h("div", { class: "field" }, h("span", {}, "Tipo"), typeBox),
        h("label", { class: "field" }, h("span", {}, "Cantidad"), qty)),
      h("label", { class: "field" }, h("span", {}, "Observación"), reason, datalist),
      errorBox,
      actions,
      concileSlot),
    shortages,
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Últimos movimientos rápidos"),
        h("a", { href: "#/inventario?tab=movimientos", class: "btn-ghost btn-sm" }, "Historial completo")),
      recent));
  loadRecent();
  loadShortages();
}

// ---------------------------------------------------------------------
// 2. Pedidos a proveedor: ver supplierOrders.js
// ---------------------------------------------------------------------

// ---------------------------------------------------------------------
// 3. Venta presencial
// ---------------------------------------------------------------------
export function customerPicker({ onPick }) {
  const input = h("input", { type: "search", class: "input", placeholder: "Buscar cliente por nombre, email o teléfono…", "aria-label": "Buscar cliente", autocomplete: "off" });
  const list = h("ul", { class: "pick-list" });
  let timer = 0, token = 0;
  async function search() {
    const mine = ++token;
    try {
      const rows = await api.searchCustomers(input.value);
      if (mine !== token) return;
      mount(list, rows.length ? rows.map((c) => {
        const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email;
        const b = h("button", { type: "button", class: "pick-item" },
          h("span", { class: "pick-name" }, name), h("span", { class: "pick-meta muted" }, [c.email, c.phone].filter(Boolean).join(" · ")));
        b.addEventListener("click", () => onPick({ id: c.user_id, name, email: c.email, phone: c.phone }));
        return h("li", {}, b);
      }) : h("li", { class: "muted pick-empty" }, "No hay clientes con ese dato."));
    } catch (err) {
      mount(list, h("li", { class: "muted" }, message(err)));
    }
  }
  input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
  search();
  return h("div", { class: "picker" }, input, list);
}

function renderSale(body, ctx) {
  const lines = new Map();
  let key = api.newKey();
  let busy = false;
  let mode = "cuenta";        // cuenta | nombre
  let customer = null;

  const modeBox = h("div", { class: "segmented seg-buttons", role: "radiogroup", "aria-label": "Cliente" });
  const custSlot = h("div");
  const nameInput = h("input", { class: "input", maxlength: "170", placeholder: "Nombre y apellido" });
  const note = h("input", { class: "input", maxlength: "500", placeholder: "Opcional: forma de pago, detalle…" });
  const linesBox = h("ul", { class: "line-edit-list" });
  const totalBox = h("div", { class: "order-total" });
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const submit = h("button", { type: "button", class: "btn-primary" }, "Registrar venta y descontar stock");
  const picker = variantPicker(ctx, { allowAll: true, placeholder: "Buscar producto o presentación…", onPick: (v) => { lines.set(v.id, (lines.get(v.id) ?? 0) + 1); key = api.newKey(); draw(); } });

  function drawMode() {
    mount(modeBox, [["cuenta", "Cliente registrado"], ["nombre", "Sin cuenta (Sin asignar)"]].map(([m, label]) => {
      const b = h("button", { type: "button", role: "radio", class: m === mode ? "active" : "", "aria-checked": m === mode ? "true" : "false" }, label);
      b.addEventListener("click", () => { mode = m; key = api.newKey(); drawMode(); });
      return b;
    }));
    if (mode === "nombre") {
      mount(custSlot, h("label", { class: "field" }, h("span", {}, "Nombre del cliente"), nameInput,
        h("small", { class: "hint" }, "Queda «Sin asignar». Cuando cree su cuenta, la vinculás desde el pedido y la ve en «Mis pedidos».")));
    } else if (customer) {
      mount(custSlot, h("div", { class: "pick-chosen" },
        h("strong", {}, customer.name), h("span", { class: "muted" }, [customer.email, customer.phone].filter(Boolean).join(" · ")),
        h("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => { customer = null; key = api.newKey(); drawMode(); } }, "Cambiar")));
    } else {
      mount(custSlot, customerPicker({ onPick: (c) => { customer = c; key = api.newKey(); drawMode(); } }));
    }
  }

  function draw() {
    let total = 0;
    mount(linesBox, lines.size ? [...lines].map(([id, q]) => {
      const v = ctx.byId.get(id);
      total += (v?.price ?? 0) * q;
      const input = h("input", { type: "number", class: "input input-sm", min: "1", max: "999", value: String(q), "aria-label": `Cantidad de ${v?.label}` });
      input.addEventListener("change", () => {
        const n = intOf(input);
        if (Number.isInteger(n) && n >= 1 && n <= 999) lines.set(id, n); else input.value = String(lines.get(id));
        key = api.newKey(); draw();
      });
      const over = v?.trackStock && q > v.available;
      return h("li", { class: "line-edit" },
        h("span", { class: "line-edit-name" }, v?.label ?? `#${id}`,
          h("small", { class: over ? "text-alert" : "muted" }, `${formatPrice(v?.price)} c/u · ${v?.trackStock ? `${v.available} disponibles` : "sin control de stock"}`)),
        input,
        h("strong", {}, formatPrice((v?.price ?? 0) * q)),
        h("button", { type: "button", class: "btn-ghost btn-sm", onclick: () => { lines.delete(id); key = api.newKey(); draw(); } }, "Quitar"));
    }) : h("li", { class: "muted" }, "Buscá y tocá los productos vendidos."));
    mount(totalBox, h("span", {}, "Total"), h("strong", {}, formatPrice(total)));
    submit.disabled = busy || !lines.size;
  }
  [nameInput, note].forEach((el) => el.addEventListener("input", () => { key = api.newKey(); errorBox.hidden = true; }));

  submit.addEventListener("click", async () => {
    if (busy) return;
    errorBox.hidden = true;
    const fail = (m) => { errorBox.textContent = m; errorBox.hidden = false; };
    if (!lines.size) return fail("Agregá al menos un producto.");
    if (mode === "cuenta" && !customer) return fail("Elegí el cliente o pasá a «Sin cuenta».");
    if (mode === "nombre" && !nameInput.value.trim()) return fail("Escribí el nombre del cliente.");
    busy = true; submit.disabled = true; submit.textContent = "Guardando…";
    try {
      const res = await api.createSale({
        items: [...lines].map(([variant_id, quantity]) => ({ variant_id, quantity })),
        customerId: mode === "cuenta" ? customer.id : null,
        customerName: mode === "nombre" ? nameInput.value.trim() : null,
        note: note.value.trim(), key,
      });
      toast(res.repeated ? `La venta #${res.id} ya estaba registrada (no se repitió).` : `Venta #${res.id} registrada: se descontó el stock.`);
      location.hash = `#/pedidos/${res.id}`;
    } catch (err) {
      console.warn(err);
      fail(message(err));
      busy = false; submit.textContent = "Registrar venta y descontar stock"; draw();
    }
  });

  drawMode();
  draw();
  mount(body,
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Venta presencial")),
      h("p", { class: "hint" }, "Descuenta stock y queda como pedido (con historial). Para una salida sin cliente, usá «Movimiento rápido»."),
      h("div", { class: "field" }, h("span", {}, "Cliente"), modeBox), custSlot,
      picker.el,
      linesBox, totalBox,
      h("label", { class: "field" }, h("span", {}, "Nota"), note),
      errorBox,
      h("div", { class: "actions" }, submit)),
    h("p", { class: "muted" }, h("a", { href: "#/pedidos?tab=presencial" }, "Ver ventas presenciales anteriores →")));
}
