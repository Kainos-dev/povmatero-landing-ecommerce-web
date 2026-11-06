import { h, mount, errorMessage } from "../ui.js";
import { listRestockAlerts, toolErrorMessage } from "../api/stockTools.js";

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
export async function renderRestockAlerts(view) {
  const body = h("div", { class: "pane-stack" }, h("p", { class: "muted" }, "Cargando avisos…"));
  const refresh = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Actualizar");
  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Avisos de reposición"),
        h("p", { class: "page-sub" }, "Clientes que pidieron que les avisemos cuando vuelva una yerba.")),
      refresh),
    body);

  async function load() {
    refresh.disabled = true;
    let rows;
    try {
      rows = await listRestockAlerts();
    } catch (err) {
      console.error(err);
      mount(body, h("p", { class: "notice-warn" }, toolErrorMessage(err, errorMessage)));
      refresh.disabled = false;
      return;
    }
    refresh.disabled = false;
    const due = rows.filter((r) => r.due);
    const waiting = rows.filter((r) => !r.due);

    // Esperando: agrupadas por presentación (cuántas personas esperan cada una).
    const groups = new Map();
    for (const r of waiting) {
      const k = r.variant_id;
      groups.set(k, { name: `${r.product_name}${r.variant_name ? ` ${r.variant_name}` : ""}`, n: (groups.get(k)?.n ?? 0) + 1 });
    }

    mount(body,
      h("section", { class: "panel" },
        h("div", { class: "panel-head" }, h("h2", {}, `Con disponibilidad (${due.length})`)),
        h("p", { class: "hint" }, "Los avisos por correo se procesan automáticamente cuando el servicio está configurado. Las solicitudes antiguas requieren confirmación del cliente; no se envían por WhatsApp."),
        due.length ? h("ul", { class: "alert-list" }, due.map((a) => alertRow(a)))
          : h("p", { class: "muted" }, "No hay avisos pendientes de enviar.")),
      h("section", { class: "panel" },
        h("div", { class: "panel-head" }, h("h2", {}, `Esperando reposición (${waiting.length})`)),
        groups.size ? h("ul", { class: "order-lines" }, [...groups.values()].map((g) => h("li", {},
          h("span", { class: "order-line-qty" }, String(g.n)),
          h("span", { class: "order-line-name" }, g.name, h("small", { class: "muted" }, g.n === 1 ? "persona esperando" : "personas esperando")))))
          : h("p", { class: "muted" }, "Nadie está esperando una yerba agotada.")));
  }
  refresh.addEventListener("click", load);
  load();
}

function alertRow(a) {
  return h("li", { class: "alert-row" },
    h("div", { class: "alert-main" },
      h("strong", {}, `${a.product_name}${a.variant_name ? ` ${a.variant_name}` : ""}`),
      h("span", {}, a.customer_name || a.email || "Cliente"),
      h("small", { class: "muted" }, `Solicitud del ${DATE.format(new Date(a.created_at))}. El envío requiere consentimiento por email.`)));
}