// Salida que supera el stock disponible (Stock rápido e Inventario).
// No se bloquea: el stock del sistema puede estar desactualizado. Se explica
// la inconsistencia, se pide el stock físico REAL que quedó y se muestra el
// resultado antes de confirmar. Si lo declarado no cubre las reservas de
// pedidos web, hace falta una confirmación explícita (queda un faltante para
// resolver a mano; los pedidos no se tocan). La base vuelve a validar todo
// (public.admin_stock_movement) en una sola transacción.
import { h, mount } from "../ui.js";

const STATUS = { pendiente: "Pendiente", confirmado: "Pendiente", preparando: "Pendiente" };
const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * plan: la vista previa de la base (admin_stock_preview o el detalle de un rechazo).
 * onConfirm({ declared, confirmShortage }): registra (devuelve una promesa).
 * onCancel(): vuelve al formulario.
 */
export function exitConciliation(plan, { onConfirm, onCancel }) {
  const name = `${plan.product_name}${plan.variant_name ? ` ${plan.variant_name}` : ""}`;
  const box = h("div", { class: "concile-box", role: "group", "aria-label": "Salida que supera el stock disponible" });
  const input = h("input", { type: "number", class: "input input-num", min: "0", step: "1", inputmode: "numeric", required: true,
    "aria-label": "Stock físico real que quedó después de la salida", id: `concile-${plan.variant_id}` });
  const preview = h("div", { class: "concile-preview", "aria-live": "polite" });
  const shortageSlot = h("div");
  const errorBox = h("p", { class: "form-error", role: "alert", hidden: true });
  const confirm = h("button", { type: "button", class: "btn-primary" }, "Confirmar salida y corrección");
  const cancel = h("button", { type: "button", class: "btn-ghost", onclick: onCancel }, "Cancelar");
  let ack = null;

  const declared = () => {
    const raw = input.value.trim();
    if (raw === "") return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  };

  function paint() {
    const d = declared();
    errorBox.hidden = true;
    if (d === null || Number.isNaN(d)) {
      mount(preview, h("p", { class: "muted" }, "Ingresá cuántas unidades quedaron físicamente para ver el resultado."));
      mount(shortageSlot);
      ack = null;
      confirm.disabled = true;
      return;
    }
    const before = d + plan.requested;               // lo que había de verdad antes de la salida
    const adjustment = before - plan.stock;
    const availableAfter = Math.max(d - plan.reserved, 0);
    const missing = Math.max(plan.reserved - d, 0);
    mount(preview,
      h("ul", { class: "concile-list" },
        h("li", {}, "Antes de la salida había: ", h("strong", {}, String(before)), ` (el sistema tenía ${plan.stock})`),
        adjustment !== 0 ? h("li", {}, "Ajuste de inventario: ", h("strong", { class: adjustment > 0 ? "qty-pos" : "qty-neg" }, adjustment > 0 ? `+${adjustment}` : `−${Math.abs(adjustment)}`))
          : h("li", {}, "Sin ajuste de inventario (el stock registrado era correcto)."),
        h("li", {}, "Salida: ", h("strong", { class: "qty-neg" }, `−${plan.requested}`)),
        h("li", {}, "Stock físico después: ", h("strong", {}, String(d))),
        h("li", {}, "Disponible para la tienda después (descontando reservas): ", h("strong", {}, String(availableAfter)))));

    if (missing > 0) {
      ack = h("input", { type: "checkbox", onchange: () => { confirm.disabled = !ack.checked; } });
      mount(shortageSlot, h("div", { class: "concile-danger", role: "alert" },
        h("strong", {}, `Faltan ${missing} ${missing === 1 ? "unidad" : "unidades"} para los pedidos web que ya reservaron esta yerba.`),
        h("p", {}, "Los pedidos no se cancelan ni se modifican. La presentación queda marcada como faltante para que lo resuelvas a mano (reponer o hablar con los clientes)."),
        plan.orders?.length ? h("ul", { class: "concile-orders" }, plan.orders.map((o) => h("li", {},
          h("a", { href: `#/pedidos/${o.order_id}`, target: "_blank", rel: "noopener" }, `Pedido #${o.order_id}`),
          ` · ${o.customer_name || "Cliente"} · ${o.quantity} ${o.quantity === 1 ? "unidad" : "unidades"} · ${STATUS[o.status] ?? o.status}`,
          o.status === "pendiente" && o.expires_at ? ` · reserva hasta ${DATE.format(new Date(o.expires_at))}` : ""))) : null,
        h("label", { class: "check-inline concile-ack" }, ack,
          ` Confirmo registrar la salida y dejar ${name} como faltante.`)));
      confirm.disabled = true;
    } else {
      mount(shortageSlot, h("p", { class: "notice-info" }, plan.reserved
        ? `Alcanza para las ${plan.reserved} ${plan.reserved === 1 ? "unidad reservada" : "unidades reservadas"} por pedidos web.`
        : "No hay reservas de pedidos web para esta presentación."));
      ack = null;
      confirm.disabled = false;
    }
  }
  input.addEventListener("input", paint);

  confirm.addEventListener("click", async () => {
    const d = declared();
    if (d === null || Number.isNaN(d)) {
      errorBox.textContent = "Ingresá el stock físico real: un número entero mayor o igual a 0.";
      errorBox.hidden = false;
      input.focus();
      return;
    }
    if (ack && !ack.checked) return;
    confirm.disabled = true; cancel.disabled = true;
    confirm.textContent = "Guardando…";
    try {
      await onConfirm({ declared: d, confirmShortage: Boolean(ack?.checked) });
    } catch (err) {
      errorBox.textContent = err?.message || "No se pudo registrar.";
      errorBox.hidden = false;
      confirm.textContent = "Confirmar salida y corrección";
      cancel.disabled = false;
      paint();
    }
  });

  const inconsistency = plan.reserved > 0
    ? `Si se registrara sin más, el stock quedaría en ${plan.stock - plan.requested} y no alcanzaría para las ${plan.reserved} unidades reservadas por pedidos web${plan.stock - plan.requested < 0 ? " (y el stock sería negativo)" : ""}.`
    : `Si se registrara sin más, el stock quedaría en ${plan.stock - plan.requested} (negativo): el stock del sistema no coincide con lo que hay.`;

  mount(box,
    h("div", { class: "concile-warn" },
      h("strong", {}, `La salida supera el stock disponible de ${name}.`),
      h("dl", { class: "concile-facts" },
        h("dt", {}, "Stock físico registrado"), h("dd", {}, String(plan.stock)),
        h("dt", {}, "Reservado por pedidos web"), h("dd", {}, String(plan.reserved)),
        h("dt", {}, "Disponible según el sistema"), h("dd", {}, String(plan.available)),
        h("dt", {}, "Querés retirar"), h("dd", {}, String(plan.requested))),
      h("p", {}, inconsistency),
      h("p", {}, "Si efectivamente tenías y retiraste esas unidades, indicá el stock físico real que quedó: se registra la salida y una corrección del inventario, juntas.")),
    h("label", { class: "field", for: input.id }, h("span", {}, "Stock físico real que quedó después de la salida (obligatorio)"), input),
    preview,
    shortageSlot,
    errorBox,
    h("div", { class: "actions" }, confirm, cancel));
  paint();
  return { el: box, focus: () => input.focus() };
}
