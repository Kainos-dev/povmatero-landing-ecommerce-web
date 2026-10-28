// Panel de stock de una variante: entrada, salida, ajuste por stock contado e historial.
import * as inv from "../api/inventory.js";
import { saveVariantCost } from "../api/catalog.js";
import { h, mount, field, showError, toast, errorMessage, formatPrice } from "../ui.js";

const TYPE_LABELS = { entrada: "Entrada", salida: "Salida", ajuste: "Ajuste" };
const DONE_LABELS = { entrada: "Entrada registrada", salida: "Salida registrada", ajuste: "Ajuste registrado" };

const REASONS = {
  entrada: ["Compra a proveedor", "Reposición", "Devolución de cliente"],
  salida: ["Venta", "Rotura", "Uso interno", "Regalo / muestra"],
  ajuste: ["Conteo físico", "Corrección de carga"],
};

const DATE_FORMAT = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });

// Entero desde un input: null si está vacío, NaN si no es entero.
function intValue(input) {
  const raw = input.value.trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : NaN;
}

function signed(n) {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function reasonInput(type) {
  const listId = `stock-reasons-${type}`;
  const input = h("input", {
    class: "input",
    maxlength: "120",
    list: listId,
    placeholder: "Elegí o escribí un motivo",
    value: type === "ajuste" ? "Conteo físico" : "",
  });
  const datalist = h("datalist", { id: listId }, REASONS[type].map((r) => h("option", { value: r })));
  return { input, datalist };
}

/**
 * Dibuja el panel en "section".
 * variant: { id, name, stock, cost }
 * onChanged(tab): se llama después de registrar un movimiento (recarga datos).
 * onClose(): cierra el panel.
 */
export function renderStockPanel(section, { variant, initialTab = "entrada", onChanged, onClose }) {
  let tab = initialTab;
  const formSlot = h("div", { class: "stock-form" });
  const historySlot = h("div");
  const tabButtons = {};

  // ---------------- Envío común ----------------
  async function submitMovement(button, error, payload, afterSuccess) {
    error.hidden = true;
    button.disabled = true;

    let result;
    try {
      result = await inv.registerMovement({ variantId: variant.id, ...payload });
    } catch (err) {
      console.error(err);
      if (inv.isInsufficientStockError(err)) {
        let available = null;
        try { available = (await inv.getVariantStock(variant.id)).stock; } catch { /* sin dato */ }
        showError(error, `No hay stock suficiente${available != null ? ` (disponible: ${available})` : ""}. No se registró nada.`);
      } else {
        showError(error, errorMessage(err));
      }
      button.disabled = false;
      return;
    }

    if (afterSuccess) {
      try {
        await afterSuccess();
      } catch (err) {
        console.error(err);
        toast(`El movimiento se registró, pero el costo de la variante no se actualizó: ${errorMessage(err)}`, "error");
        await onChanged(tab);
        return;
      }
    }

    toast(`${DONE_LABELS[payload.type]}. Stock actual: ${result.stock_after}.`);
    await onChanged(tab);
  }

  function readReason(reason, reference) {
    return { reason: reason.value.trim(), reference: reference.value.trim() || null };
  }

  // ---------------- Formularios ----------------
  function entradaForm() {
    const qty = h("input", { class: "input input-num", type: "number", min: "1", step: "1" });
    const cost = h("input", { class: "input input-num", type: "number", min: "0", step: "0.01", placeholder: "Opcional" });
    const updateCost = h("input", { type: "checkbox" });
    const { input: reason, datalist } = reasonInput("entrada");
    const reference = h("input", { class: "input", maxlength: "120", placeholder: "Ej. factura 0001-1234" });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Registrar entrada");

    const currentCost = variant.cost == null ? "sin costo cargado" : `costo actual ${formatPrice(variant.cost)}`;

    const form = h("form", { novalidate: true },
      h("div", { class: "form-grid" },
        field("Cantidad que entra", qty),
        field("Costo unitario", cost, "Queda registrado en el movimiento."),
        field("Motivo", reason),
        field("Referencia", reference, "Opcional.")
      ),
      datalist,
      h("label", { class: "check check-inline" }, updateCost,
        h("span", {}, `Actualizar costo de la variante con este valor (${currentCost})`)),
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const quantity = intValue(qty);
      if (!(quantity > 0)) { showError(error, "La cantidad debe ser un número entero mayor a 0."); return; }

      let unitCost = null;
      if (cost.value.trim() !== "") {
        unitCost = Number(cost.value);
        if (!Number.isFinite(unitCost) || unitCost < 0) { showError(error, "El costo unitario debe ser un número mayor o igual a 0."); return; }
        unitCost = Math.round(unitCost * 100) / 100;
      }
      if (updateCost.checked && unitCost === null) {
        showError(error, "Para actualizar el costo de la variante, ingresá el costo unitario.");
        return;
      }

      const { reason: reasonText, reference: ref } = readReason(reason, reference);
      if (!reasonText) { showError(error, "Indicá el motivo."); return; }

      const afterSuccess = updateCost.checked ? () => saveVariantCost(variant.id, unitCost) : null;
      await submitMovement(submit, error,
        { type: "entrada", quantity, unitCost, reason: reasonText, reference: ref }, afterSuccess);
    });

    return form;
  }

  function salidaForm() {
    const qty = h("input", { class: "input input-num", type: "number", min: "1", step: "1" });
    const { input: reason, datalist } = reasonInput("salida");
    const reference = h("input", { class: "input", maxlength: "120", placeholder: "Ej. pedido WhatsApp 12/11" });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Registrar salida");

    const form = h("form", { novalidate: true },
      h("div", { class: "form-grid" },
        field("Cantidad que sale", qty),
        field("Motivo", reason),
        field("Referencia", reference, "Opcional.")
      ),
      datalist,
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const quantity = intValue(qty);
      if (!(quantity > 0)) { showError(error, "La cantidad debe ser un número entero mayor a 0."); return; }
      const { reason: reasonText, reference: ref } = readReason(reason, reference);
      if (!reasonText) { showError(error, "Indicá el motivo."); return; }

      await submitMovement(submit, error,
        { type: "salida", quantity: -quantity, reason: reasonText, reference: ref });
    });

    return form;
  }

  function ajusteForm() {
    const counted = h("input", { class: "input input-num", type: "number", min: "0", step: "1" });
    const { input: reason, datalist } = reasonInput("ajuste");
    const reference = h("input", { class: "input", maxlength: "120", placeholder: "Opcional" });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const confirmSlot = h("div");
    const review = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Revisar ajuste");

    const form = h("form", { novalidate: true },
      h("p", { class: "muted" }, "Ingresá cuántas unidades contaste. El panel calcula la diferencia con el stock registrado."),
      h("div", { class: "form-grid" },
        field("Stock contado", counted),
        field("Motivo", reason),
        field("Referencia", reference)
      ),
      datalist,
      error,
      h("div", { class: "actions" }, review),
      confirmSlot
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      mount(confirmSlot);
      error.hidden = true;

      const target = intValue(counted);
      if (target === null || !(target >= 0)) { showError(error, "El stock contado debe ser un número entero mayor o igual a 0."); return; }
      const { reason: reasonText, reference: ref } = readReason(reason, reference);
      if (!reasonText) { showError(error, "Indicá el motivo."); return; }

      // Se relee el stock justo antes de calcular, para no usar un dato viejo.
      review.disabled = true;
      let current;
      try {
        current = (await inv.getVariantStock(variant.id)).stock;
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
        review.disabled = false;
        return;
      }
      review.disabled = false;

      const delta = target - current;
      if (delta === 0) {
        mount(confirmSlot, h("p", { class: "notice-info" },
          `El stock registrado ya es ${current}. No hace falta ajustar.`));
        return;
      }

      const confirm = h("button", { type: "button", class: "btn-primary btn-inline" }, "Confirmar ajuste");
      const cancel = h("button", { type: "button", class: "btn-ghost", onClick: () => mount(confirmSlot) }, "Cancelar");

      confirm.addEventListener("click", async () => {
        cancel.disabled = true;
        await submitMovement(confirm, error,
          { type: "ajuste", quantity: delta, reason: reasonText, reference: ref });
        cancel.disabled = false;
      });

      mount(confirmSlot,
        h("div", { class: "confirm-box" },
          h("p", {}, `Registrado: ${current} → contado: ${target} → ajuste: `,
            h("strong", { class: delta > 0 ? "qty-pos" : "qty-neg" }, signed(delta))),
          h("div", { class: "actions" }, confirm, cancel)
        )
      );
    });

    return form;
  }

  const FORMS = { entrada: entradaForm, salida: salidaForm, ajuste: ajusteForm };

  function selectTab(name) {
    tab = name;
    Object.entries(tabButtons).forEach(([key, btn]) => {
      btn.classList.toggle("active", key === name);
      btn.setAttribute("aria-selected", key === name ? "true" : "false");
    });
    mount(formSlot, FORMS[name]());
  }

  // ---------------- Historial ----------------
  async function loadHistory() {
    mount(historySlot, h("p", { class: "muted" }, "Cargando historial…"));

    let rows, me;
    try {
      [rows, me] = await Promise.all([inv.listMovements(variant.id, 20), inv.getCurrentUserId()]);
    } catch (err) {
      console.error(err);
      mount(historySlot, h("p", { class: "form-error" }, errorMessage(err)));
      return;
    }

    if (!rows.length) {
      mount(historySlot, h("p", { class: "empty-box" }, "Todavía no hay movimientos para esta variante."));
      return;
    }

    const author = (row) => (row.created_by == null ? "Carga inicial" : row.created_by === me ? "Vos" : "Otro admin");

    mount(historySlot,
      h("div", { class: "table-wrap" },
        h("table", { class: "table" },
          h("thead", {}, h("tr", {},
            ["Fecha", "Tipo", "Cantidad", "Stock resultante", "Motivo", "Referencia", "Costo unit.", "Autor"]
              .map((t) => h("th", {}, t))
          )),
          h("tbody", {}, rows.map((row) =>
            h("tr", {},
              h("td", {}, DATE_FORMAT.format(new Date(row.created_at))),
              h("td", {}, TYPE_LABELS[row.movement_type] ?? row.movement_type),
              h("td", { class: `num ${row.quantity > 0 ? "qty-pos" : "qty-neg"}` }, signed(row.quantity)),
              h("td", { class: "num" }, row.stock_after ?? "—"),
              h("td", {}, row.reason || "—"),
              h("td", {}, row.reference || "—"),
              h("td", { class: "num" }, row.unit_cost == null ? "—" : formatPrice(row.unit_cost)),
              h("td", {}, author(row))
            )
          ))
        )
      )
    );
  }

  // ---------------- Armado ----------------
  const tabsEl = h("div", { class: "tabs", role: "tablist" },
    Object.keys(FORMS).map((name) => {
      const btn = h("button", { type: "button", class: "tab", role: "tab", onClick: () => selectTab(name) }, TYPE_LABELS[name]);
      tabButtons[name] = btn;
      return btn;
    })
  );

  mount(section,
    h("div", { class: "page-header stock-head" },
      h("div", {},
        h("h3", {}, `Stock de “${variant.name}”`),
        h("p", { class: "muted" }, "Stock registrado: ", h("strong", {}, String(variant.stock)))
      ),
      h("button", { type: "button", class: "btn-ghost", onClick: onClose }, "Cerrar")
    ),
    tabsEl,
    formSlot,
    h("h4", {}, "Historial (últimos 20 movimientos)"),
    historySlot
  );

  selectTab(tab);
  return loadHistory();
}
