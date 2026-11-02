// Estadísticas de la tienda: visitas, origen, dispositivos, productos y embudo
// de compra, comparados con el período anterior. Solo lee.
// Los datos los registra /api/track y los resume la base (analytics_report).
import { getReport } from "../api/analytics.js";
import { h, mount, errorMessage, formatPrice } from "../ui.js";

const PRESETS = [["7", "7 días"], ["30", "30 días"], ["90", "90 días"], ["365", "12 meses"]];
const DAY = 24 * 60 * 60 * 1000;
const INT = new Intl.NumberFormat("es-AR");
const SHORT = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
const LONG = new Intl.DateTimeFormat("es-AR", { weekday: "short", day: "numeric", month: "long" });
const REGION = (() => { try { return new Intl.DisplayNames(["es"], { type: "region" }); } catch { return null; } })();
const DEVICE = { mobile: "Celular", tablet: "Tablet", desktop: "Computadora", desconocido: "Sin dato" };
const SVG = "http://www.w3.org/2000/svg";

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const inputValue = (d) => dayKey(d);

function countryName(code) {
  if (!code || code === "—") return "Sin dato";
  try { return REGION?.of(code) ?? code; } catch { return code; }
}

// Provincias argentinas: Vercel informa el código ISO (B = Buenos Aires).
const AR_REGIONS = { A: "Salta", B: "Buenos Aires", C: "Ciudad de Buenos Aires", D: "San Luis", E: "Entre Ríos", F: "La Rioja",
  G: "Santiago del Estero", H: "Chaco", J: "San Juan", K: "Catamarca", L: "La Pampa", M: "Mendoza", N: "Misiones", P: "Formosa",
  Q: "Neuquén", R: "Río Negro", S: "Santa Fe", T: "Tucumán", U: "Chubut", V: "Tierra del Fuego", W: "Corrientes", X: "Córdoba",
  Y: "Jujuy", Z: "Santa Cruz" };
const regionName = (country, region) => (country === "AR" ? AR_REGIONS[region] ?? region : region);

function pageName(path) {
  if (path === "/") return "Inicio";
  if (path === "/cuenta") return "Mi cuenta";
  return path;
}

// Variación contra el período anterior, en texto.
function delta(now, before) {
  if (!before) return now ? "nuevo en este período" : "sin cambios";
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return "igual que el período anterior";
  return `${pct > 0 ? "+" : ""}${pct} % vs. período anterior`;
}

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// ---------------------------------------------------------------------
// Gráfico de líneas: visitantes por día (actual) vs. período anterior.
// Un solo eje (misma unidad). Cruz que sigue al puntero + tooltip.
// ---------------------------------------------------------------------
function lineChart(days, current, previous) {
  // En pantallas angostas se dibuja más chico (el texto de los ejes no se achica).
  const narrow = window.matchMedia("(max-width: 600px)").matches;
  const W = narrow ? 340 : 1000, H = narrow ? 200 : 260, L = 36, R = 10, T = 12, B = 28;
  const max = Math.max(1, ...current, ...previous);
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i) => L + (days.length <= 1 ? 0 : (i * (W - L - R)) / (days.length - 1));
  const y = (v) => T + (H - T - B) * (1 - v / top);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart-svg", role: "img", "aria-label": "Visitantes por día" });
  for (let i = 0; i <= 4; i++) {
    const v = (top / 4) * i;
    root.append(svg("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: i === 0 ? "chart-base" : "chart-grid" }));
    const label = svg("text", { x: L - 8, y: y(v) + 4, class: "chart-tick", "text-anchor": "end" });
    label.textContent = INT.format(Math.round(v));
    root.append(label);
  }
  const ticks = days.length > 2 ? [0, Math.floor((days.length - 1) / 2), days.length - 1] : days.map((_, i) => i);
  for (const i of ticks) {
    const label = svg("text", { x: x(i), y: H - 8, class: "chart-tick", "text-anchor": i === 0 ? "start" : i === days.length - 1 ? "end" : "middle" });
    label.textContent = SHORT.format(days[i]);
    root.append(label);
  }
  const path = (values) => values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  if (previous.some((v) => v > 0)) root.append(svg("path", { d: path(previous), class: "chart-line chart-line-prev" }));
  root.append(svg("path", { d: path(current), class: "chart-line" }));
  const last = days.length - 1;
  root.append(svg("circle", { cx: x(last), cy: y(current[last]), r: 4, class: "chart-dot" }));

  // Capa de interacción
  const cross = svg("line", { y1: T, y2: H - B, class: "chart-cross", visibility: "hidden" });
  const dot = svg("circle", { r: 4, class: "chart-dot", visibility: "hidden" });
  const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent", tabindex: 0, "aria-label": "Recorré los días con las flechas" });
  root.append(cross, dot, hit);

  const wrap = h("div", { class: "chart-wrap" });
  const tip = h("div", { class: "chart-tip", hidden: true });
  wrap.append(root, tip);

  let index = last;
  function show(i) {
    index = Math.max(0, Math.min(last, i));
    const px = x(index);
    cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", y(current[index])); dot.setAttribute("visibility", "visible");
    mount(tip,
      h("p", { class: "chart-tip-date" }, LONG.format(days[index])),
      h("p", { class: "chart-tip-row" }, h("span", { class: "key key-now" }), h("strong", {}, INT.format(current[index])), " visitantes"),
      h("p", { class: "chart-tip-row" }, h("span", { class: "key key-prev" }), h("strong", {}, INT.format(previous[index] ?? 0)), " período anterior"));
    tip.hidden = false;
    const ratio = px / W;
    tip.style.left = `${ratio * 100}%`;
    tip.style.transform = `translateX(${ratio > 0.6 ? "-105%" : "5%"})`;
  }
  function hide() {
    cross.setAttribute("visibility", "hidden");
    dot.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }
  hit.addEventListener("pointermove", (e) => {
    const box = root.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    show(Math.round(((sx - L) / (W - L - R)) * last));
  });
  // En pantallas táctiles: tocar o deslizar sobre el gráfico muestra el día.
  hit.addEventListener("pointerdown", (e) => {
    const box = root.getBoundingClientRect();
    const sx = ((e.clientX - box.left) / box.width) * W;
    show(Math.round(((sx - L) / (W - L - R)) * last));
  });
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  hit.addEventListener("focus", () => show(index));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); show(index - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); show(index + 1); }
  });
  return wrap;
}

// Lista con barras finas: el valor manda; la barra solo da la proporción.
function rankList(rows, { label, value, valueText = (r) => INT.format(value(r)), sub = null, empty = "Sin datos en este período." }) {
  if (!rows.length) return h("p", { class: "muted" }, empty);
  const max = Math.max(1, ...rows.map(value));
  return h("ol", { class: "rank" }, rows.map((r) => h("li", {},
    h("div", { class: "rank-row" },
      h("span", { class: "rank-label" }, label(r), sub ? h("span", { class: "rank-sub" }, sub(r)) : null),
      h("span", { class: "rank-value" }, valueText(r))),
    h("div", { class: "rank-bar", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(2, (value(r) / max) * 100)}%` })))));
}

function stat(value, caption, compare) {
  return h("div", { class: "stat" },
    h("span", { class: "stat-value" }, value),
    h("span", { class: "stat-caption" }, caption),
    compare ? h("span", { class: "stat-hint" }, compare) : null);
}

export async function renderStats(view) {
  let preset = "30";
  let custom = null;   // { from: Date, to: Date } (to inclusive)
  let previousData = null;

  const presetNav = h("div", { class: "segmented", role: "group", "aria-label": "Período" });
  const fromInput = h("input", { type: "date", class: "input input-date", "aria-label": "Desde" });
  const toInput = h("input", { type: "date", class: "input input-date", "aria-label": "Hasta" });
  const applyBtn = h("button", { type: "button", class: "btn-ghost" }, "Aplicar");
  const rangeText = h("p", { class: "muted" });
  const body = h("div", { class: "page" });

  function range() {
    const today = startOfDay(new Date());
    if (custom) return { from: custom.from, to: new Date(custom.to.getTime() + DAY) };
    return { from: new Date(today.getTime() - (Number(preset) - 1) * DAY), to: new Date(today.getTime() + DAY) };
  }

  function renderPresets() {
    mount(presetNav, PRESETS.map(([k, label]) => h("button", {
      type: "button", class: !custom && k === preset ? "active" : "", "aria-pressed": String(!custom && k === preset),
      onClick: () => { preset = k; custom = null; load(); },
    }, label)));
  }

  applyBtn.addEventListener("click", () => {
    const from = fromInput.value ? new Date(`${fromInput.value}T00:00:00`) : null;
    const to = toInput.value ? new Date(`${toInput.value}T00:00:00`) : null;
    if (!from || !to || to < from) { rangeText.textContent = "Elegí una fecha «desde» anterior o igual a «hasta»."; return; }
    if ((to - from) / DAY > 399) { rangeText.textContent = "El período puede tener hasta 400 días."; return; }
    custom = { from, to };
    load();
  });

  async function load() {
    renderPresets();
    const { from, to } = range();
    const length = to - from;
    const prevFrom = new Date(from.getTime() - length);
    fromInput.value = inputValue(from);
    toInput.value = inputValue(new Date(to.getTime() - DAY));
    rangeText.textContent = `Del ${SHORT.format(from)} al ${SHORT.format(new Date(to.getTime() - DAY))}, comparado con los ${Math.round(length / DAY)} días anteriores.`;
    body.classList.add("is-loading");
    let data;
    try {
      [data, previousData] = await Promise.all([getReport(from, to), getReport(prevFrom, from)]);
    } catch (err) {
      console.error(err);
      body.classList.remove("is-loading");
      const missing = err?.code === "PGRST202" || /analytics_report/.test(err?.message ?? "");
      mount(body, h("div", { class: "notice-warn" }, missing
        ? "Todavía no están creadas las estadísticas en la base. Falta aplicar la migración supabase/migrations/20261104000000_analytics.sql."
        : `No se pudieron cargar las estadísticas: ${errorMessage(err)}`));
      return;
    }
    body.classList.remove("is-loading");
    renderReport(data, previousData, from, to);
  }

  function renderReport(d, p, from, to) {
    const t = d.totals, pt = p?.totals ?? {};
    // Días del período (también los que no tuvieron visitas).
    const days = [];
    for (let day = new Date(from); day < to; day = new Date(day.getTime() + DAY)) days.push(startOfDay(day));
    const byDay = new Map((d.daily ?? []).map((x) => [x.day, x.visitors]));
    const prevByDay = (p?.daily ?? []).map((x) => x);
    const prevMap = new Map(prevByDay.map((x) => [x.day, x.visitors]));
    const current = days.map((day) => byDay.get(dayKey(day)) ?? 0);
    const previous = days.map((day) => prevMap.get(dayKey(new Date(day.getTime() - (to - from)))) ?? 0);

    if (!t.page_views && !t.orders) {
      mount(body,
        h("div", { class: "empty-box" },
          h("p", {}, h("strong", {}, "Todavía no hay visitas registradas en este período.")),
          h("p", {}, "Las estadísticas empiezan a juntarse cuando están aplicadas la migración y la clave del servidor (SUPABASE_SECRET_KEY en Vercel), y el sitio está publicado. No hay datos de antes.")));
      return;
    }

    const f = d.funnel ?? {};
    const steps = [
      ["Visitas", f.sessions ?? 0],
      ["Vieron un producto", f.product_view ?? 0],
      ["Agregaron al carrito", f.add_to_cart ?? 0],
      ["Iniciaron la compra por WhatsApp", f.begin_checkout ?? 0],
    ];
    const funnelTop = Math.max(1, steps[0][1]);

    const table = h("details", { class: "chart-table" },
      h("summary", {}, "Ver los datos en una tabla"),
      h("div", { class: "table-wrap" }, h("table", { class: "table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Día"), h("th", { class: "num" }, "Visitantes"), h("th", { class: "num" }, "Período anterior"))),
        h("tbody", {}, days.map((day, i) => h("tr", {}, h("td", {}, LONG.format(day)), h("td", { class: "num" }, INT.format(current[i])), h("td", { class: "num" }, INT.format(previous[i]))))))));

    mount(body,
      h("div", { class: "stats stats-6" },
        stat(INT.format(t.visitors), "visitantes", delta(t.visitors, pt.visitors)),
        stat(INT.format(t.sessions), "visitas", delta(t.sessions, pt.sessions)),
        stat(INT.format(t.page_views), "páginas vistas", delta(t.page_views, pt.page_views)),
        stat(INT.format(t.add_to_cart), "agregados al carrito", delta(t.add_to_cart, pt.add_to_cart)),
        stat(INT.format(t.begin_checkout), "compras iniciadas por WhatsApp", delta(t.begin_checkout, pt.begin_checkout)),
        stat(INT.format(t.orders), `pedidos registrados · ${formatPrice(Number(t.orders_total))}`, delta(t.orders, pt.orders))),

      h("section", { class: "panel" },
        h("div", { class: "panel-head" },
          h("h2", {}, "Visitantes por día"),
          h("div", { class: "chart-legend" },
            h("span", {}, h("span", { class: "key key-now" }), "Este período"),
            h("span", {}, h("span", { class: "key key-prev" }), "Período anterior"))),
        lineChart(days, current, previous),
        table),

      h("section", { class: "panel" },
        h("div", { class: "panel-head" }, h("h2", {}, "Embudo de compra")),
        h("ol", { class: "funnel" }, steps.map(([label, n], i) => h("li", {},
          h("div", { class: "rank-row" },
            h("span", { class: "rank-label" }, label),
            h("span", { class: "rank-value" }, INT.format(n),
              h("span", { class: "rank-sub" }, i === 0 ? " · 100 %" : ` · ${Math.round((n / funnelTop) * 100)} % de las visitas`))),
          h("div", { class: "rank-bar rank-bar-strong", "aria-hidden": "true" }, h("span", { style: `width:${Math.max(2, (n / funnelTop) * 100)}%` }))))),
        h("p", { class: "muted" }, `Pedidos registrados en el período: ${INT.format(t.orders)} (los de clientes con sesión iniciada; los pedidos sin cuenta llegan solo por WhatsApp).`)),

      h("div", { class: "home-grid" },
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Productos más vistos")),
          rankList(d.products ?? [], { label: (r) => r.key, value: (r) => r.views, sub: (r) => (r.added ? ` · ${INT.format(r.added)} al carrito` : null) })),
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Páginas más vistas")),
          rankList(d.pages ?? [], { label: (r) => pageName(r.key), value: (r) => r.views }))),

      h("div", { class: "home-grid" },
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "De dónde vienen")),
          rankList(d.sources ?? [], { label: (r) => r.key, value: (r) => r.sessions, valueText: (r) => `${INT.format(r.sessions)} visitas` })),
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Campañas (UTM)")),
          rankList(d.campaigns ?? [], { label: (r) => r.key, value: (r) => r.sessions, valueText: (r) => `${INT.format(r.sessions)} visitas`,
            empty: "Sin campañas. Agregá ?utm_source=…&utm_campaign=… a los enlaces que compartas." }))),

      h("div", { class: "grid-3" },
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Dispositivos")),
          rankList(d.devices ?? [], { label: (r) => DEVICE[r.key] ?? r.key, value: (r) => r.visitors })),
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Navegadores")),
          rankList(d.browsers ?? [], { label: (r) => r.key, value: (r) => r.visitors })),
        h("section", { class: "panel" },
          h("div", { class: "panel-head" }, h("h2", {}, "Países y regiones")),
          rankList(d.countries ?? [], { label: (r) => countryName(r.key), value: (r) => r.visitors, sub: (r) => (r.region ? ` · ${regionName(r.key, r.region)}` : null) }))));
  }

  mount(view,
    h("div", { class: "page-header" },
      h("div", {},
        h("h1", {}, "Estadísticas"),
        h("p", { class: "page-sub" }, "Visitas anónimas de la tienda. Este navegador no se cuenta (ingresaste como administrador)."))),
    h("div", { class: "toolbar toolbar-stats" }, presetNav, h("span", { class: "date-range" }, fromInput, "–", toInput, applyBtn)),
    rangeText,
    body);
  await load();
}
