// Avisos de reposición (#/avisos): clientes que pidieron «Avisarme cuando
// vuelva» una presentación agotada.
//   Para avisar: la presentación ya está disponible → WhatsApp o email con el
//                mensaje listo, y «Marcar avisado» (una sola vez por solicitud).
//   Esperando: siguen agotadas.
// No hay envío automático de emails (falta un proveedor de email): el aviso lo
// manda el administrador y lo marca acá. Avisar no reserva stock.
import { h, mount, toast, errorMessage } from "../ui.js";
import { listRestockAlerts, markRestockNotified, toolErrorMessage } from "../api/stockTools.js";
import { whatsappNumber } from "../api/orders.js";

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
const SHOP = "https://povmatero-landing-ecommerce-web.vercel.app/yerbas";

function noticeText(a) {
  const first = String(a.customer_name ?? "").trim().split(/\s+/)[0];
  return `Hola${first ? ` ${first}` : ""}! Te escribimos de Povmatero: volvió ${a.product_name}${a.variant_name ? ` ${a.variant_name}` : ""}. Podés pedirla en ${SHOP}`;
}

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
        h("div", { class: "panel-head" }, h("h2", {}, `Para avisar (${due.length})`)),
        h("p", { class: "hint" }, "La presentación volvió a estar disponible. Avisale y marcalo: no se puede marcar dos veces."),
        due.length ? h("ul", { class: "alert-list" }, due.map((a) => alertRow(a, load)))
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

function alertRow(a, reload) {
  const wa = whatsappNumber(a.phone);
  const text = noticeText(a);
  const mark = h("button", { type: "button", class: "btn-primary btn-sm" }, "Marcar avisado");
  mark.addEventListener("click", async () => {
    mark.disabled = true;
    mark.textContent = "Guardando…";
    try {
      const changed = await markRestockNotified([a.id]);
      toast((changed ?? []).length ? "Aviso marcado como enviado." : "Ese aviso ya estaba marcado.");
      reload();
    } catch (err) {
      console.warn(err);
      toast(toolErrorMessage(err, errorMessage), "error");
      mark.disabled = false;
      mark.textContent = "Marcar avisado";
    }
  });
  return h("li", { class: "alert-row" },
    h("div", { class: "alert-main" },
      h("strong", {}, `${a.product_name}${a.variant_name ? ` ${a.variant_name}` : ""}`),
      h("span", {}, a.customer_name || a.email || "Cliente"),
      h("small", { class: "muted" }, `Pedido el ${DATE.format(new Date(a.created_at))} · ${a.available == null ? "disponible" : `${a.available} disponibles`}`)),
    h("div", { class: "actions" },
      wa ? h("a", { class: "btn-ghost btn-sm", href: `https://wa.me/${wa}?text=${encodeURIComponent(text)}`, target: "_blank", rel: "noopener" }, "WhatsApp") : null,
      a.email ? h("a", { class: "btn-ghost btn-sm", href: `mailto:${a.email}?subject=${encodeURIComponent("Volvió tu yerba — Povmatero")}&body=${encodeURIComponent(text)}` }, "Email") : null,
      mark));
}
