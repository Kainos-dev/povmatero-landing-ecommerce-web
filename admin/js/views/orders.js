// Pedidos: pestañas Yerbas (con estados y stock) y Tienda (solicitudes del
// carrito, sin estados). #/pedidos?tab=yerbas&f=atender
import { h, mount, errorMessage, formatPrice, normalizeText } from "../ui.js";
import { listOrders, STATUS, isExpired } from "../api/orders.js";

const TABS = [["yerbas", "Yerbas"], ["tienda", "Tienda"]];

// Filtros de yerbas. «Para atender» = todo lo que todavía requiere algo.
const FILTERS = [
  ["atender", "Para atender", (o) => ["confirmado", "preparando", "listo"].includes(o.status) || (o.status === "pendiente" && !isExpired(o))],
  ["pendiente", "Pendientes", (o) => o.status === "pendiente" && !isExpired(o)],
  ["vencido", "Vencidos", (o) => isExpired(o)],
  ["confirmado", "Confirmados", (o) => o.status === "confirmado"],
  ["preparando", "Preparando", (o) => o.status === "preparando"],
  ["listo", "Listos", (o) => o.status === "listo"],
  ["entregado", "Entregados", (o) => o.status === "entregado"],
  ["cancelado", "Cancelados", (o) => o.status === "cancelado"],
  ["todos", "Todos", () => true],
];

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function relativeTime(value, now = Date.now()) {
  const diff = new Date(value).getTime() - now;
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const text = min < 1 ? "un momento" : min < 60 ? `${min} min` : min < 60 * 48 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} días`;
  return diff >= 0 ? `en ${text}` : `hace ${text}`;
}

export function statusBadge(order) {
  if (order.kind !== "yerbas") return h("span", { class: "badge" }, "Tienda");
  if (isExpired(order)) return h("span", { class: "badge order-st order-st-vencido" }, "Vencido");
  return h("span", { class: `badge order-st order-st-${order.status}` }, STATUS[order.status]?.label ?? order.status);
}

function orderCard(o) {
  const expired = isExpired(o);
  let when = null;
  if (o.kind === "yerbas" && o.status === "pendiente") {
    when = h("span", { class: expired ? "order-when text-alert" : "order-when" },
      expired ? `Venció ${relativeTime(o.expires_at)} · ya no reserva stock` : `Reserva vence ${relativeTime(o.expires_at)}`);
  }
  return h("li", {},
    h("a", { class: "order-card", href: `#/pedidos/${o.id}` },
      h("div", { class: "order-card-top" },
        h("strong", { class: "order-num" }, `#${o.id}`),
        statusBadge(o),
        h("span", { class: "order-date muted" }, DATE.format(new Date(o.created_at)))),
      h("div", { class: "order-card-name" }, o.customer_name || o.customer_email || "Cliente sin nombre"),
      h("div", { class: "order-card-meta" },
        h("span", {}, `${o.item_count} ${o.item_count === 1 ? "unidad" : "unidades"}`),
        h("strong", {}, formatPrice(o.total))),
      when));
}

export async function renderOrders(view, query = {}) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : "yerbas";
  const filterKey = FILTERS.some(([k]) => k === query.f) ? query.f : "atender";

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
    const search = h("input", { type: "search", class: "input", placeholder: "Buscar por número, nombre o teléfono…", "aria-label": "Buscar pedidos", value: query.q ?? "" });
    const list = h("ul", { class: "order-list" });
    const count = h("p", { class: "muted" });

    let chips = null;
    let active = tab === "yerbas" ? FILTERS.find(([k]) => k === filterKey) : null;
    if (tab === "yerbas") {
      chips = h("div", { class: "order-filters", role: "group", "aria-label": "Estado" },
        FILTERS.map((f) => {
          const n = orders.filter(f[2]).length;
          const b = h("button", { type: "button", class: `chip order-filter${f === active ? " active" : ""}`, "aria-pressed": f === active ? "true" : "false" },
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
      const digits = q.replace(/\D/g, "");
      const visible = orders.filter((o) => (!active || active[2](o)) && (!q
        || String(o.id) === q
        || normalizeText(o.customer_name).includes(q)
        || normalizeText(o.customer_email).includes(q)
        || (digits.length >= 3 && String(o.customer_phone ?? "").replace(/\D/g, "").includes(digits))));
      count.textContent = `${visible.length} ${visible.length === 1 ? "pedido" : "pedidos"}`;
      mount(list, visible.length
        ? visible.map(orderCard)
        : h("li", { class: "empty-box" }, tab === "yerbas"
          ? (active?.[0] === "atender" ? "No hay pedidos de yerbas para atender." : "No hay pedidos con este estado.")
          : "Todavía no hay pedidos de la tienda."));
    }
    search.addEventListener("input", paint);

    mount(body,
      tab === "tienda" ? h("p", { class: "muted" }, "Solicitudes enviadas desde el carrito de la tienda por clientes con cuenta. No tienen estados ni mueven stock: se coordinan por WhatsApp.") : null,
      chips,
      h("div", { class: "toolbar" }, search),
      count,
      list);
    paint();
  }

  load();
}
