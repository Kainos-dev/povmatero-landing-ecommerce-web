// Pedidos: pestañas Yerbas (Pendiente → Listo → Entregado), Tienda
// (solicitudes del carrito, sin estados) y Ventas (presenciales, cargadas en
// el panel). #/pedidos?tab=yerbas&f=pendiente
import { h, mount, errorMessage, formatPrice, normalizeText } from "../ui.js";
import { listOrders, STATUS, uiStatus, runOrderMaintenance, cancelReason, orderLabel } from "../api/orders.js";

const TABS = [["yerbas", "Yerbas"], ["tienda", "Tienda"], ["presencial", "Ventas"]];

// Filtros de yerbas: los tres estados principales primero; el resto, aparte.
// No hay «Vencidos»: al vencer la reserva (12 h) en «Pendiente» el pedido queda cancelado.
const FILTERS = [
  ["pendiente", "Pendientes", (o) => uiStatus(o) === "pendiente", true],
  ["listo", "Listos", (o) => uiStatus(o) === "listo", true],
  ["entregado", "Entregados", (o) => uiStatus(o) === "entregado", true],
  ["cancelado", "Cancelados", (o) => uiStatus(o) === "cancelado"],
  ["todos", "Todos", () => true],
];
// Direcciones anteriores (?f=atender, confirmados, vencidos…).
const LEGACY_FILTER = { atender: "pendiente", confirmado: "pendiente", preparando: "pendiente", vencido: "cancelado" };

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function relativeTime(value, now = Date.now()) {
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const text = min < 1 ? "un momento" : min < 60 ? `${min} min` : min < 60 * 48 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} días`;
  return diff >= 0 ? `en ${text}` : `hace ${text}`;
}

export function statusBadge(order) {
  if (order.kind === "tienda") return h("span", { class: "badge" }, "Tienda");
  if (order.kind === "presencial") {
    return order.status === "cancelado"
      ? h("span", { class: "badge order-st order-st-cancelado" }, "Venta anulada")
      : h("span", { class: "badge order-st order-st-entregado" }, "Venta");
  }
  const st = uiStatus(order);
  return h("span", { class: `badge order-st order-st-${st}` }, STATUS[st]?.label ?? st);
}

function orderCard(o) {
  const st = o.kind === "yerbas" ? uiStatus(o) : null;
  let when = null;
  if (st === "pendiente" && o.status === "pendiente" && o.expires_at) {
    const soon = new Date(o.expires_at) - Date.now() < 12 * 3600e3;
    when = h("span", { class: soon ? "order-when text-alert" : "order-when" },
      `Si no se atiende, se cancela ${relativeTime(o.expires_at)}`);
  } else if (st === "cancelado" && cancelReason(o)) {
    when = h("span", { class: "order-when" }, cancelReason(o));
  }
  return h("li", {},
    h("a", { class: "order-card", href: `#/pedidos/${o.id}` },
      h("div", { class: "order-card-top" },
        h("strong", { class: "order-num" }, orderLabel(o)),
        statusBadge(o),
        h("span", { class: "order-date muted" }, DATE.format(new Date(o.created_at)))),
      h("div", { class: "order-card-name" }, o.customer_name || o.customer_email || "Cliente sin nombre",
        o.kind === "presencial" && !o.customer_id ? h("span", { class: "chip chip-sm" }, "Sin asignar") : null),
      h("div", { class: "order-card-meta" },
        h("span", {}, `${o.item_count} ${o.item_count === 1 ? "unidad" : "unidades"}`),
        h("strong", {}, formatPrice(o.total))),
      when));
}

export async function renderOrders(view, query = {}) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : "yerbas";
  const asked = LEGACY_FILTER[query.f] ?? query.f;
  const filterKey = FILTERS.some(([k]) => k === asked) ? asked : "pendiente";

  const tabs = h("nav", { class: "segmented", "aria-label": "Tipo de pedido" },
    TABS.map(([k, label]) => h("a", {
      href: `#/pedidos?tab=${k}`, class: k === tab ? "active" : "", "aria-current": k === tab ? "page" : null,
    }, label)));
  const refresh = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Actualizar");
  const body = h("div", { class: "pane-stack" }, h("p", { class: "muted" }, "Cargando pedidos…"));

  mount(view,
    h("div", { class: "page-header" }, h("h1", {}, "Pedidos"), refresh),
    tabs,
    body);

  async function load() {
    refresh.disabled = true;
    let orders;
    try {
      // Primero, cancelación (reserva vencida en «Pendiente») y entrega automática (24 h en «Listo»). Idempotente.
      if (tab === "yerbas") await runOrderMaintenance().catch((err) => console.warn("Mantenimiento de pedidos:", err));
      orders = await listOrders(tab);
    } catch (err) {
      console.error(err);
      const missing = /kind|status/.test(err?.message ?? "") && err?.code === "42703";
      mount(body, h("p", { class: "notice-warn" }, missing
        ? "Falta aplicar la migración supabase/migrations/20261105000000_yerba_orders.sql."
        : errorMessage(err)));
      refresh.disabled = false;
      return;
    }
    refresh.disabled = false;
    draw(orders);
  }
  refresh.addEventListener("click", load);

  function draw(orders) {
    const search = h("input", { type: "search", class: "input", placeholder: "Buscar por código, nombre o teléfono…", "aria-label": "Buscar pedidos", value: query.q ?? "" });
    const list = h("ul", { class: "order-list" });
    const count = h("p", { class: "muted" });

    let chips = null;
    let active = tab === "yerbas" ? FILTERS.find(([k]) => k === filterKey) : null;
    if (tab === "yerbas") {
      chips = h("div", { class: "order-filters", role: "group", "aria-label": "Estado" },
        FILTERS.map((f) => {
          const n = orders.filter(f[2]).length;
          const b = h("button", { type: "button", class: `chip order-filter${f[3] ? " order-filter-main" : " order-filter-sub"}${f === active ? " active" : ""}`, "aria-pressed": f === active ? "true" : "false" },
            f[1], h("span", { class: "order-filter-n" }, String(n)));
          b.addEventListener("click", () => {
            active = f;
            chips.querySelectorAll(".order-filter").forEach((x) => { x.classList.remove("active"); x.setAttribute("aria-pressed", "false"); });
            b.classList.add("active");
            b.setAttribute("aria-pressed", "true");
            history.replaceState(null, "", `#/pedidos?tab=${tab}&f=${f[0]}`);
            paint();
          });
          return b;
        }));
    }

    function paint() {
      const q = normalizeText(search.value.trim()).replace(/^#/, "");
      const code = q.replace(/[^a-z0-9]/g, "");
      const digits = q.replace(/\D/g, "");
      const visible = orders.filter((o) => (!active || active[2](o)) && (!q
        || String(o.id) === q
        || (code.length >= 3 && normalizeText(o.public_code ?? "").replace(/[^a-z0-9]/g, "").startsWith(code))
        || normalizeText(o.customer_name).includes(q)
        || normalizeText(o.customer_email).includes(q)
        || (digits.length >= 3 && String(o.customer_phone ?? "").replace(/\D/g, "").includes(digits))));
      count.textContent = `${visible.length} ${visible.length === 1 ? "pedido" : "pedidos"}`;
      mount(list, visible.length
        ? visible.map(orderCard)
        : h("li", { class: "empty-box" }, tab === "yerbas"
          ? (active?.[0] === "pendiente" ? "No hay pedidos de yerbas pendientes." : "No hay pedidos con este estado.")
          : tab === "presencial" ? "Todavía no hay ventas presenciales." : "Todavía no hay pedidos de la tienda."));
    }
    search.addEventListener("input", paint);

    mount(body,
      tab === "tienda" ? h("p", { class: "muted" }, "Solicitudes enviadas desde el carrito de la tienda por clientes con cuenta. No tienen estados ni mueven stock: se coordinan por WhatsApp.") : null,
      tab === "presencial" ? h("div", { class: "toolbar" },
        h("p", { class: "muted" }, "Ventas en el local cargadas desde el panel: ya descontaron stock. «Sin asignar» = sin cuenta todavía."),
        h("a", { class: "btn-primary btn-sm", href: "#/stock-rapido?tab=venta" }, "Nueva venta")) : null,
      chips,
      h("div", { class: "toolbar" }, search),
      count,
      list);
    paint();
  }

  load();
}
