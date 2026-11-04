// #/optimizar-imagenes — convierte a WebP las imágenes pesadas que ya están en
// Storage (envases de la góndola y fotos), conservando los originales.
// Ver api/imageOptimize.js. Nada se descarga ni se cambia hasta confirmar.
import { h, mount, toast, errorMessage } from "../ui.js";
import { thumbnail } from "../thumbs.js";
import * as api from "../api/imageOptimize.js";

const MB = (n) => `${(n / 1048576).toFixed(2).replace(".", ",")} MB`;
const KIND_LABEL = { shelf: "Góndola", "shelf-variant": "Góndola (presentación)", photo: "Fotos del catálogo" };
// Estimación con las pruebas locales (envases reales: −93 %).
const ESTIMATED_RATIO = 0.08;

export async function renderImageOptimize(view) {
  mount(view, h("p", { class: "muted" }, "Cargando imágenes…"));
  let all;
  try {
    all = await api.listCandidates();
  } catch (err) {
    console.error(err);
    mount(view, h("div", { class: "page-header" }, h("h1", {}, "Optimizar imágenes")), h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const status = h("p", { class: "muted", role: "status" });
  const list = h("div", { class: "pane-stack" });
  const summary = h("div", { class: "card" });
  const logBox = h("section", { class: "card" });
  const selected = new Set();
  const state = new Map();     // key → { status, entry?, error? }
  let measured = false, running = false, stop = false;

  const measureBtn = h("button", { type: "button", class: "btn-primary btn-inline" }, "1. Medir tamaños");
  const runBtn = h("button", { type: "button", class: "btn-primary btn-inline", disabled: true }, "2. Optimizar seleccionadas");
  const stopBtn = h("button", { type: "button", class: "btn-ghost", hidden: true }, "Detener después de la actual");
  const confirmSlot = h("div");

  measureBtn.addEventListener("click", async () => {
    measureBtn.disabled = true;
    status.textContent = "Midiendo (solo se piden los encabezados, sin descargar las imágenes)…";
    await api.measure(all, { onProgress: (d, t) => { status.textContent = `Midiendo ${d} de ${t}…`; } });
    measured = true;
    for (const c of all) if (api.isWorth(c) && c.reachable) selected.add(c.key);
    status.textContent = "";
    measureBtn.textContent = "Medir otra vez";
    measureBtn.disabled = false;
    paint();
  });

  runBtn.addEventListener("click", () => {
    const chosen = all.filter((c) => selected.has(c.key) && state.get(c.key)?.status !== "done").slice(0, api.MAX_PER_RUN);
    if (!chosen.length) return;
    const bytes = chosen.reduce((s, c) => s + (c.bytes ?? 0), 0);
    const yes = h("button", { type: "button", class: "btn-primary btn-inline" }, `Sí, optimizar ${chosen.length}`);
    const no = h("button", { type: "button", class: "btn-ghost", onClick: () => mount(confirmSlot) }, "Cancelar");
    yes.addEventListener("click", () => { mount(confirmSlot); run(chosen); });
    mount(confirmSlot, h("div", { class: "confirm-box" },
      h("p", {}, h("strong", {}, `¿Optimizar ${chosen.length} ${chosen.length === 1 ? "imagen" : "imágenes"}?`)),
      h("ul", { class: "change-list" },
        h("li", {}, `Se descarga cada original una sola vez: ${MB(bytes)} en total (una vez).`),
        h("li", {}, `Se sube una copia WebP nueva de cada una (estimado: ~${MB(bytes * ESTIMATED_RATIO)}).`),
        h("li", {}, "Los originales NO se borran: quedan en Storage como respaldo y se puede revertir."),
        h("li", {}, "Si una imagen cambió mientras tanto, no se toca."),
        chosen.length === api.MAX_PER_RUN ? h("li", {}, `Máximo ${api.MAX_PER_RUN} por tanda: el resto queda para la próxima.`) : null),
      h("div", { class: "actions" }, yes, no)));
  });
  stopBtn.addEventListener("click", () => { stop = true; stopBtn.disabled = true; });

  async function run(chosen) {
    running = true; stop = false;
    runBtn.disabled = true; measureBtn.disabled = true; stopBtn.hidden = false; stopBtn.disabled = false;
    let done = 0, saved = 0;
    for (const [i, c] of chosen.entries()) {
      if (stop) break;
      status.textContent = `Optimizando ${i + 1} de ${chosen.length}: ${c.label} (${c.detail})…`;
      state.set(c.key, { status: "working" });
      paint();
      try {
        const r = await api.optimizeOne(c);
        state.set(c.key, r);
        if (r.status === "done") { done++; saved += r.entry.before - r.entry.after; c.src = r.entry.new; c.bytes = r.entry.after; c.ext = "webp"; selected.delete(c.key); }
      } catch (err) {
        console.error(err);
        state.set(c.key, { status: "error", error: err?.message ?? errorMessage(err) });
      }
    }
    running = false;
    stopBtn.hidden = true; measureBtn.disabled = false;
    status.textContent = `Listo: ${done} ${done === 1 ? "imagen optimizada" : "imágenes optimizadas"}, ${MB(saved)} menos.`;
    toast(status.textContent);
    paint();
  }

  function row(c) {
    const st = state.get(c.key);
    const box = h("input", { type: "checkbox", checked: selected.has(c.key), disabled: running || !measured || st?.status === "done" || c.reachable === false, "aria-label": `Elegir ${c.label}` });
    box.addEventListener("change", () => { box.checked ? selected.add(c.key) : selected.delete(c.key); paintSummary(); });
    const stText = !st ? (measured ? (api.isWorth(c) ? "" : "Ya liviana") : "")
      : st.status === "working" ? "Optimizando…"
      : st.status === "done" ? `Optimizada: ${MB(st.entry.before)} → ${MB(st.entry.after)}`
      : st.status === "skipped" ? "No ahorra: se dejó igual"
      : st.status === "changed" ? "Cambió mientras tanto: no se tocó"
      : `Error: ${st.error}`;
    return h("li", { class: "opt-row", "data-key": c.key },
      box,
      h("div", { class: "opt-thumb" }, thumbnail(c.src, { alt: "", width: 128 })),
      h("div", { class: "opt-text" }, h("strong", {}, c.label), h("small", { class: "muted" }, `${c.detail} · ${c.ext.toUpperCase()}`)),
      h("span", { class: "opt-size" }, c.bytes == null ? "—" : MB(c.bytes)),
      h("span", { class: st?.status === "error" ? "opt-state text-alert" : "opt-state muted" }, stText));
  }

  function paintSummary() {
    const chosen = all.filter((c) => selected.has(c.key));
    const total = all.reduce((s, c) => s + (c.bytes ?? 0), 0);
    const chosenBytes = chosen.reduce((s, c) => s + (c.bytes ?? 0), 0);
    runBtn.disabled = running || !chosen.length;
    runBtn.textContent = chosen.length ? `2. Optimizar ${Math.min(chosen.length, api.MAX_PER_RUN)} seleccionadas` : "2. Optimizar seleccionadas";
    mount(summary,
      h("h3", {}, "Resumen"),
      measured
        ? h("ul", { class: "change-list" },
            h("li", {}, `${all.length} imágenes en Storage · ${MB(total)} en total.`),
            h("li", {}, h("strong", {}, `${chosen.length} seleccionadas · ${MB(chosenBytes)}`), ` → estimado ~${MB(chosenBytes * ESTIMATED_RATIO)} (−${Math.round((1 - ESTIMATED_RATIO) * 100)} %).`))
        : h("p", { class: "muted" }, "Primero medí los tamaños: solo se leen los encabezados, no se descarga ninguna imagen."),
      h("div", { class: "actions" }, measureBtn, runBtn, stopBtn),
      status, confirmSlot);
  }

  function paintLog() {
    const log = api.readLog();
    if (!log.length) { mount(logBox, h("h3", {}, "Cambios hechos"), h("p", { class: "muted" }, "Todavía no se optimizó ninguna imagen desde este navegador.")); return; }
    const saved = log.filter((e) => !e.reverted).reduce((s, e) => s + e.before - e.after, 0);
    const download = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Descargar respaldo (JSON)");
    download.addEventListener("click", () => {
      const a = h("a", { href: URL.createObjectURL(api.logAsFile(log)), download: `optimizacion-imagenes-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
    });
    mount(logBox,
      h("div", { class: "section-head" }, h("h3", {}, `Cambios hechos (${log.length})`), download),
      h("p", { class: "muted" }, `Ahorro vigente: ${MB(saved)}. Los originales siguen en Storage.`),
      h("ul", { class: "change-list" }, log.slice().reverse().slice(0, 60).map((e) => {
        const undo = e.reverted ? null : h("button", { type: "button", class: "link-btn" }, "Revertir");
        undo?.addEventListener("click", async () => {
          undo.disabled = true;
          try { await api.revert(e); toast(`Se volvió a la original: ${e.label}.`); paintLog(); }
          catch (err) { toast(err.message ?? errorMessage(err), "error"); undo.disabled = false; }
        });
        return h("li", { "data-log": e.key }, `${e.label}: ${MB(e.before)} → ${MB(e.after)}${e.reverted ? " · revertida" : ""} `, undo);
      })));
  }

  function paint() {
    const groups = ["shelf", "shelf-variant", "photo"].map((k) => [k, all.filter((c) => c.kind === k)]).filter(([, l]) => l.length);
    mount(list, groups.map(([k, l]) => h("section", { class: "card" },
      h("div", { class: "section-head" }, h("h3", {}, `${KIND_LABEL[k]} (${l.length})`),
        measured ? h("span", { class: "muted" }, MB(l.reduce((s, c) => s + (c.bytes ?? 0), 0))) : null),
      h("ul", { class: "opt-list" }, l.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).map(row)))));
    paintSummary();
    paintLog();
  }

  mount(view,
    h("div", { class: "page-header" }, h("div", { class: "title-block" },
      h("h1", {}, "Optimizar imágenes"),
      h("p", { class: "page-sub" }, "Convierte a WebP las imágenes pesadas (sobre todo los PNG de la góndola) sin perder calidad ni transparencia. Los originales se conservan."))),
    summary, list, logBox);
  paint();
}
