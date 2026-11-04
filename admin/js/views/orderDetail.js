// Un pedido: contacto (WhatsApp), estado y sus pasos, productos (con edición
// para yerbas hasta «Preparando») e historial.
// Todo cambio lo hace la base (admin_set_order_status / admin_update_order_items):
// valida transiciones y stock, y registra los movimientos de inventario.
import { h, mount, errorMessage, formatPrice, toast } from "../ui.js";
import { icon } from "../icons.js";
import {
  getOrder, setOrderStatus, updateOrderItems, listYerbaVariants, orderErrorMessage, whatsappNumber,
  FLOW, FLOW_LABEL, isExpired, runOrderMaintenance, commitsStock, isEditable, canCancel, uiStatus, autoDeliveryAt, markReady, cancelReason, PENDING_HOURS,
} from "../api/orders.js";
import { statusBadge, relativeTime } from "./orders.js";
import { linkOrderCustomer, cancelSale, toolErrorMessage } from "../api/stockTools.js";
import { customerPicker } from "./stockTools.js";
import { refreshOrdersBadge } from "../router.js";

const DATE = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" });
const formatDate = (v) => (v ? DATE.format(new Date(v)) : "—");

const EVENT_LABEL = { creado: "Pedido creado", estado: "Cambio de estado", editado: "Productos editados", vinculado: "Vinculado a una cuenta" };
// En el historial se ven los estados de la base tal cual quedaron registrados.
const HISTORY_LABEL = { pendiente: "Pendiente", confirmado: "Confirmado", preparando: "En preparación", listo: "Listo", entregado: "Entregado", cancelado: "Cancelado" };

export async function renderOrderDetail(view, orderId) {
  mount(view, h("p", { class: "muted" }, "Cargando pedido…"));
  let order;
  try {
    order = await getOrder(orderId);
    // Pendiente de 72 h todavía sin marcar: se registra la cancelación ahora
    // (idempotente) para que el detalle y el historial queden completos.
    if (order && isExpired(order)) {
      await runOrderMaintenance().catch((err) => console.warn("Mantenimiento de pedidos:", err));
      order = (await getOrder(orderId)) ?? order;
    }
  } catch (err) {
    console.error(err);
    mount(view, backLink("yerbas"), h("p", { class: "notice-warn" }, errorMessage(err)));
    return;
  }
  if (!order) {
    mount(view, backLink("yerbas"), h("p", { class: "notice-warn" }, `No existe el pedido #${orderId}.`));
    return;
  }
  draw(view, order);
}

function backLink(tab) {
  return h("a", { href: `#/pedidos?tab=${tab}`, class: "back-link" }, "← Pedidos");
}

function draw(view, order) {
  const yerbas = order.kind === "yerbas";
  const sale = order.kind === "presencial";
  const reload = async (message) => {
    try {
      const fresh = await getOrder(order.id);
      if (fresh) draw(view, fresh);
      if (message) toast(message);
      refreshOrdersBadge();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  mount(view,
    backLink(order.kind),
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, `Pedido #${order.id}`),
        h("p", { class: "page-sub" }, `${yerbas ? "Yerbas" : sale ? "Venta presencial" : "Tienda"} · ${formatDate(order.created_at)}`)),
      statusBadge(order)),
    yerbas ? statusPanel(order, reload) : sale ? salePanel(order, reload) : h("p", { class: "notice-info" },
      "Pedido de la tienda: es la solicitud que el cliente envió por WhatsApp. No tiene estados ni mueve stock."),
    h("div", { class: "order-grid" },
      itemsPanel(order, reload),
      h("div", { class: "pane-stack" },
        contactPanel(order),
        yerbas || sale ? historyPanel(order) : null)));
}

// ---------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------
function statusPanel(order, reload) {
  const st = uiStatus(order);          // pendiente | listo | entregado | cancelado
  const panel = h("section", { class: "panel" });
  const slot = h("div", { class: "order-actions" });
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const stepOf = st;

  const steps = h("ol", { class: `order-steps order-steps-3${st === "cancelado" ? " is-cancelled" : ""}` },
    FLOW.map((s, i) => {
      const reached = st !== "cancelado" && FLOW.indexOf(stepOf) >= i;
      return h("li", { class: `${reached ? "done" : ""}${s === stepOf ? " current" : ""}` },
        h("span", { class: "order-step-dot" }, reached ? icon("check") : String(i + 1)),
        h("span", { class: "order-step-label" }, FLOW_LABEL[s]));
    }));

  const units = order.order_items.reduce((n, i) => n + i.quantity, 0);
  const auto = autoDeliveryAt(order);
  let note = null;
  const reason = cancelReason(order);
  if (st === "cancelado") {
    const returned = order.events.some((e) => e.from_status === "listo" && e.to_status === "cancelado");
    note = h("div", { class: "notice-info" },
      h("strong", {}, reason ? `${reason}.` : "Pedido cancelado."),
      " ", reason && order.status === "pendiente"
        ? `Pasaron ${PENDING_HOURS} h en «Pendiente» (desde ${formatDate(order.created_at)}): la reserva de stock ya se liberó.`
        : reason ? `Estuvo ${PENDING_HOURS} h en «Pendiente» sin confirmarse. No se descontó stock.`
        : returned ? "El stock que se había descontado se devolvió." : "");
  } else if (st === "pendiente") note = h("p", { class: "muted" }, (order.status === "pendiente"
      ? `Reserva el stock hasta ${formatDate(order.expires_at)} (${relativeTime(order.expires_at)}). Si para entonces no está listo, se cancela por falta de respuesta. `
      : "Reserva el stock. ")
    + `Al marcarlo listo se descuentan ${units} ${units === 1 ? "unidad" : "unidades"} del stock.`);
  else if (st === "listo") note = h("p", { class: "muted" }, "El stock ya está descontado. " + (auto
    ? `Si nadie lo cambia, pasa a «Entregado» solo el ${formatDate(auto)} (${relativeTime(auto)}).`
    : order.auto_deliver === false ? "No se entrega solo (lo volviste a «Listo» a mano): marcalo cuando lo retiren." : "Si volvés a «Pendiente» o lo cancelás, se devuelve."));
  else if (st === "entregado") note = h("p", { class: "muted" }, order.auto_delivered
    ? `Entregado automáticamente ${order.delivered_at ? formatDate(order.delivered_at) : ""} (24 h después de «Listo»). Si todavía no lo retiró, volvelo a «Listo».`
    : "Pedido entregado.");

  async function run(task, button, done) {
    errorBox.hidden = true;
    slot.querySelectorAll("button").forEach((b) => { b.disabled = true; });
    button.textContent = "Guardando…";
    try {
      await task();
      await reload(done);
    } catch (err) {
      console.warn(err);   // rechazo esperado de la base: se muestra el motivo
      // Pasaron las 72 h mientras se miraba el pedido: se muestra ya cancelado.
      if (err?.hint === "auto_cancelled") { await reload(); toast(err.message, "error"); return; }
      errorBox.textContent = err?.hint === "invalid_transition" && order.status === "entregado"
        ? "Para volver un pedido entregado a «Listo» falta aplicar la migración 20261110000000_simple_order_states.sql."
        : orderErrorMessage(err, errorMessage);
      errorBox.hidden = false;
      drawActions();
    }
  }

  function button(label, cls, task, done) {
    const b = h("button", { type: "button", class: cls }, label);
    b.addEventListener("click", () => run(task, b, done));
    return b;
  }

  function drawActions() {
    const buttons = [];
    if (st === "pendiente") {
      buttons.push(button("Marcar listo", "btn-primary", () => markReady(order), `Pedido #${order.id} listo: se descontó el stock.`));
    } else if (st === "listo") {
      buttons.push(button("Marcar entregado", "btn-primary", () => setOrderStatus(order.id, "entregado"), `Pedido #${order.id} entregado.`));
      buttons.push(button("Volver a pendiente", "btn-ghost", () => setOrderStatus(order.id, "preparando"), "Volvió a pendiente: el stock se devolvió."));
    } else if (st === "entregado") {
      buttons.push(button("Volver a «Listo» (no lo retiró)", "btn-ghost", () => setOrderStatus(order.id, "listo"), `Pedido #${order.id} otra vez listo.`));
    }
    if (canCancel(order)) {
      const b = h("button", { type: "button", class: "btn-ghost btn-danger" }, "Cancelar pedido");
      b.addEventListener("click", () => confirmCancel());
      buttons.push(b);
    }
    mount(slot, buttons);
  }

  function confirmCancel() {
    const yes = h("button", { type: "button", class: "btn-primary btn-danger-solid" }, "Sí, cancelar");
    const no = h("button", { type: "button", class: "btn-ghost" }, "No");
    no.addEventListener("click", drawActions);
    yes.addEventListener("click", () => run(() => setOrderStatus(order.id, "cancelado"), yes, `Pedido #${order.id} cancelado.`));
    mount(slot, h("div", { class: "confirm-box confirm-danger" },
      h("strong", {}, `¿Cancelar el pedido #${order.id}?`),
      h("span", {}, order.status === "listo"
        ? `Se devuelven ${units} ${units === 1 ? "unidad" : "unidades"} al stock. No se puede deshacer.`
        : "Deja de reservar stock. No se puede deshacer."),
      h("div", { class: "actions" }, yes, no)));
  }

  drawActions();
  mount(panel, steps, note, errorBox, slot);
  return panel;
}

// ---------------------------------------------------------------------
// Venta presencial: a quién (o «Sin asignar» + vincular) y anular
// ---------------------------------------------------------------------
function salePanel(order, reload) {
  const panel = h("section", { class: "panel" });
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const slot = h("div", { class: "pane-stack" });
  const cancelled = order.status === "cancelado";
  const fail = (err) => { console.warn(err); errorBox.textContent = toolErrorMessage(err, errorMessage); errorBox.hidden = false; };

  function draw() {
    const items = [];
    if (cancelled) items.push(h("p", { class: "notice-info" }, "Venta anulada: el stock se devolvió."));
    else items.push(h("p", { class: "muted" }, "Venta en el local: el stock se descontó al registrarla."));
    // La nota vive en el historial (solo administradores), no en el pedido que ve el cliente.
    const saleNote = order.events.find((e) => e.event === "creado")?.detail?.nota;
    if (saleNote) items.push(h("p", {}, h("strong", {}, "Nota: "), saleNote));
    if (!order.customer_id) {
      items.push(h("div", { class: "notice-warn" },
        h("strong", {}, "Sin asignar"),
        h("span", {}, ` · ${order.customer_name}. Cuando esta persona tenga cuenta, vinculala para que vea la compra en «Mis pedidos».`)));
      const linkBtn = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Vincular a una cuenta");
      linkBtn.addEventListener("click", () => {
        mount(slot, h("p", { class: "hint" }, "Elegí la cuenta del cliente. Se completa en esta misma venta (no se duplica)."),
          customerPicker({ onPick: (c) => confirmLink(c) }),
          h("button", { type: "button", class: "btn-ghost btn-sm", onclick: draw }, "Volver"));
      });
      items.push(linkBtn);
    }
    if (!cancelled) {
      const b = h("button", { type: "button", class: "btn-ghost btn-danger btn-sm" }, "Anular venta");
      b.addEventListener("click", confirmCancel);
      items.push(b);
    }
    mount(slot, items);
  }
  function confirmLink(c) {
    const yes = h("button", { type: "button", class: "btn-primary btn-sm" }, "Sí, vincular");
    yes.addEventListener("click", async () => {
      yes.disabled = true; yes.textContent = "Guardando…";
      try { await linkOrderCustomer(order.id, c.id); await reload(`Venta #${order.id} vinculada a ${c.name}.`); }
      catch (err) { fail(err); draw(); }
    });
    mount(slot, h("div", { class: "confirm-box" },
      h("strong", {}, `¿Vincular la venta #${order.id} a ${c.name}?`),
      h("span", {}, [c.email, c.phone].filter(Boolean).join(" · ")),
      h("div", { class: "actions" }, yes, h("button", { type: "button", class: "btn-ghost btn-sm", onclick: draw }, "No"))));
  }
  function confirmCancel() {
    const units = order.order_items.reduce((n, i) => n + i.quantity, 0);
    const yes = h("button", { type: "button", class: "btn-primary btn-danger-solid btn-sm" }, "Sí, anular");
    yes.addEventListener("click", async () => {
      yes.disabled = true; yes.textContent = "Guardando…";
      try { await cancelSale(order.id); await reload(`Venta #${order.id} anulada: el stock se devolvió.`); }
      catch (err) { fail(err); draw(); }
    });
    mount(slot, h("div", { class: "confirm-box confirm-danger" },
      h("strong", {}, `¿Anular la venta #${order.id}?`),
      h("span", {}, `Se devuelven ${units} ${units === 1 ? "unidad" : "unidades"} al stock.`),
      h("div", { class: "actions" }, yes, h("button", { type: "button", class: "btn-ghost btn-sm", onclick: draw }, "No"))));
  }
  draw();
  mount(panel, h("div", { class: "panel-head" }, h("h2", {}, "Venta presencial")), errorBox, slot);
  return panel;
}

// ---------------------------------------------------------------------
// Productos (y edición)
// ---------------------------------------------------------------------
function itemsPanel(order, reload) {
  const panel = h("section", { class: "panel" });
  const editable = isEditable(order);

  function view() {
    const edit = editable ? h("button", { type: "button", class: "btn-ghost btn-sm" }, "Editar") : null;
    edit?.addEventListener("click", startEdit);
    mount(panel,
      h("div", { class: "panel-head" }, h("h2", {}, "Productos"), edit),
      h("ul", { class: "order-lines" },
        order.order_items.map((i) => h("li", {},
          h("span", { class: "order-line-qty" }, `${i.quantity}×`),
          h("span", { class: "order-line-name" }, i.product_name, i.variant_name ? h("small", {}, i.variant_name) : null,
            h("small", { class: "muted" }, formatPrice(i.unit_price) + " c/u")),
          h("strong", { class: "order-line-total" }, formatPrice(i.line_total))))),
      h("div", { class: "order-total" }, h("span", {}, "Total"), h("strong", {}, formatPrice(order.total))),
      order.kind === "yerbas" && !editable && ["listo", "entregado"].includes(order.status)
        ? h("p", { class: "hint" }, order.status === "listo" ? "Para editar, primero volvelo a «Pendiente»." : "") : null);
  }

  async function startEdit() {
    mount(panel, h("div", { class: "panel-head" }, h("h2", {}, "Editar productos")), h("p", { class: "muted" }, "Cargando yerbas…"));
    let variants;
    try {
      variants = await listYerbaVariants();
    } catch (err) {
      toast(errorMessage(err), "error");
      view();
      return;
    }
    const byVariant = new Map(variants.map((v) => [v.variant_id, v]));
    const committing = commitsStock(order);
    // Líneas en edición: { variant_id, name, qty, original, price }
    const lines = new Map();
    for (const i of order.order_items) {
      if (!i.variant_id) continue;
      const prev = lines.get(i.variant_id);
      lines.set(i.variant_id, { variant_id: i.variant_id, name: `${i.product_name}${i.variant_name ? " " + i.variant_name : ""}`,
        qty: (prev?.qty ?? 0) + i.quantity, original: (prev?.original ?? 0) + i.quantity, price: Number(i.unit_price) });
    }
    // Máximo por presentación: lo disponible para otros + lo que este pedido ya reserva.
    const maxFor = (id) => {
      const v = byVariant.get(id);
      if (!v || !v.track_stock) return 99;
      return Math.min(99, Number(v.stock ?? 0) + (committing ? (lines.get(id)?.original ?? 0) : 0));
    };

    const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
    const list = h("ul", { class: "order-edit-lines" });
    const totalEl = h("strong", {});
    const select = h("select", { class: "input", "aria-label": "Yerba para agregar" });
    const addBtn = h("button", { type: "button", class: "btn-ghost" }, icon("plus"), "Agregar");
    const save = h("button", { type: "button", class: "btn-primary" }, "Guardar cambios");
    const cancel = h("button", { type: "button", class: "btn-ghost" }, "Cancelar");

    function fillSelect() {
      mount(select, h("option", { value: "" }, "Elegí una yerba para agregar…"),
        variants.filter((v) => !lines.has(v.variant_id)).map((v) => {
          const avail = v.track_stock ? Number(v.stock ?? 0) : null;
          return h("option", { value: String(v.variant_id), disabled: avail === 0 },
            `${v.product_name} ${v.variant_name} · ${formatPrice(v.price)}${avail === null ? "" : avail === 0 ? " · sin stock" : ` · disp. ${avail}`}`);
        }));
    }

    function paint() {
      let total = 0;
      mount(list, [...lines.values()].map((l) => {
        total += l.qty * l.price;
        const max = maxFor(l.variant_id);
        const input = h("input", { type: "number", class: "input input-sm", min: "1", max: String(max), value: String(l.qty), "aria-label": `Cantidad de ${l.name}` });
        input.addEventListener("change", () => {
          const n = Math.max(1, Math.min(max, Math.floor(Number(input.value) || 1)));
          l.qty = n;
          paint();
        });
        const remove = h("button", { type: "button", class: "btn-ghost btn-sm btn-danger", "aria-label": `Quitar ${l.name}` }, icon("trash"));
        remove.addEventListener("click", () => { lines.delete(l.variant_id); fillSelect(); paint(); });
        return h("li", {},
          h("span", { class: "order-line-name" }, l.name,
            h("small", { class: "muted" }, `${formatPrice(l.price)} c/u${l.original ? "" : " · precio vigente"} · máx. ${max}`)),
          input,
          remove);
      }));
      totalEl.textContent = formatPrice(total);
      save.disabled = lines.size === 0;
    }

    addBtn.addEventListener("click", () => {
      const v = byVariant.get(Number(select.value));
      if (!v) return;
      lines.set(v.variant_id, { variant_id: v.variant_id, name: `${v.product_name} ${v.variant_name}`, qty: 1, original: 0, price: Number(v.price) });
      fillSelect();
      paint();
    });
    cancel.addEventListener("click", view);
    save.addEventListener("click", async () => {
      errorBox.hidden = true;
      save.disabled = true;
      save.textContent = "Guardando…";
      try {
        await updateOrderItems(order.id, [...lines.values()].map((l) => ({ variant_id: l.variant_id, quantity: l.qty })));
        await reload(`Pedido #${order.id} actualizado.`);
      } catch (err) {
        console.warn(err);   // rechazo esperado de la base: se muestra el motivo
        errorBox.textContent = orderErrorMessage(err, errorMessage);
        errorBox.hidden = false;
        save.disabled = false;
        save.textContent = "Guardar cambios";
      }
    });

    fillSelect();
    paint();
    mount(panel,
      h("div", { class: "panel-head" }, h("h2", {}, "Editar productos")),
      h("p", { class: "hint" }, "Las líneas que ya estaban conservan su precio; lo que agregues toma el precio vigente." +
        (committing ? " Lo que aumentes se controla contra el stock disponible." : "")),
      list,
      h("div", { class: "order-add" }, select, addBtn),
      h("div", { class: "order-total" }, h("span", {}, "Total"), totalEl),
      errorBox,
      h("div", { class: "actions" }, save, cancel));
  }

  view();
  return panel;
}

// ---------------------------------------------------------------------
// Contacto
// ---------------------------------------------------------------------
function contactPanel(order) {
  const number = whatsappNumber(order.customer_phone);
  const first = (order.customer_name || "").split(" ")[0];
  const text = `Hola${first ? ` ${first}` : ""}! Te escribimos de Povmatero por tu ${order.kind === "presencial" ? "compra" : "pedido"} ${order.kind === "yerbas" ? "de yerbas " : ""}#${order.id}.`;
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Cliente")),
    h("div", { class: "order-contact" },
      h("strong", {}, order.customer_name || "Sin nombre"),
      order.customer_phone ? h("a", { href: `tel:${order.customer_phone.replace(/[^\d+]/g, "")}` }, order.customer_phone) : h("span", { class: "muted" }, "Sin teléfono"),
      order.customer_email ? h("a", { href: `mailto:${order.customer_email}` }, order.customer_email) : null),
    number
      ? h("a", { class: "btn-primary btn-block order-wa", href: `https://wa.me/${number}?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener" },
          icon("chat"), "Escribir por WhatsApp")
      : h("p", { class: "hint" }, "No hay un teléfono válido para abrir WhatsApp."));
}

// ---------------------------------------------------------------------
// Historial
// ---------------------------------------------------------------------
function historyPanel(order) {
  return h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", {}, "Historial")),
    h("ol", { class: "order-history" },
      order.events.map((e) => {
        let detail = "";
        if (e.event === "estado") {
          const auto = e.detail?.automatico
            ? (e.to_status === "cancelado" ? ` · automático: ${e.detail?.motivo ?? "Cancelado por falta de respuesta"} (${e.detail?.horas ?? PENDING_HOURS} h)` : " (automático, 24 h)")
            : "";
          detail = `${HISTORY_LABEL[e.from_status] ?? e.from_status} → ${HISTORY_LABEL[e.to_status] ?? e.to_status}${e.detail?.vencido ? " (la reserva había vencido)" : ""}${auto}`;
        } else if (e.event === "editado") {
          const before = (e.detail?.antes ?? []).reduce((n, l) => n + Number(l.quantity), 0);
          const after = (e.detail?.despues ?? []).reduce((n, l) => n + Number(l.quantity), 0);
          detail = `${before} → ${after} unidades`;
        }
        return h("li", {},
          h("strong", {}, EVENT_LABEL[e.event] ?? e.event),
          detail ? h("span", {}, detail) : null,
          h("time", { class: "muted", datetime: e.created_at }, formatDate(e.created_at)));
      })));
}
