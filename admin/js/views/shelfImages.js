// Imágenes de góndola: una tarjeta por yerba con
//   * la imagen general (se usa para todas sus presentaciones), y
//   * opcionalmente, una propia para cada presentación (por ejemplo el
//     paquete de 500 g donde se lee «500 g»). Sin la propia, usa la general.
// Las fotos del catálogo no se tocan.
import { h, mount, errorMessage, normalizeText, toast } from "../ui.js";
import { icon } from "../icons.js";
import { presentationLabel } from "/js/yerbas/catalog.js";
import {
  listYerbasWithShelfImage, uploadShelfImage, removeShelfImage, inspectImage, TYPES,
  productTarget, variantTarget,
} from "../api/shelfImages.js";

export async function renderShelfImages(view) {
  mount(view, h("p", { class: "muted" }, "Cargando yerbas…"));

  let products, variantsReady;
  try {
    ({ products, variantsReady } = await listYerbasWithShelfImage());
  } catch (err) {
    console.error(err);
    const missing = err?.code === "42703" || /shelf_image/.test(err?.message ?? "");
    mount(view,
      h("div", { class: "page-header" }, h("h1", {}, "Imágenes de góndola")),
      h("p", { class: "notice-warn" }, missing
        ? "Falta aplicar la migración supabase/migrations/20261106000000_shelf_images.sql en el SQL Editor de Supabase."
        : errorMessage(err)));
    return;
  }

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar yerba o marca…", "aria-label": "Buscar" });
  const filter = h("select", { class: "input", "aria-label": "Filtrar" },
    h("option", { value: "" }, "Todas las yerbas"),
    h("option", { value: "missing" }, "Sin imagen general"),
    h("option", { value: "done" }, "Con imagen general"),
    variantsReady ? h("option", { value: "own" }, "Con imágenes por presentación") : null);
  const summary = h("p", { class: "muted" });
  const grid = h("ul", { class: "shelf-grid" });

  function paint() {
    const q = normalizeText(search.value.trim());
    const visible = products.filter((p) =>
      (!q || normalizeText(`${p.name} ${p.brand ?? ""}`).includes(q))
      && (filter.value !== "missing" || !p.shelf_image)
      && (filter.value !== "done" || p.shelf_image)
      && (filter.value !== "own" || p.variants.some((v) => v.shelf_image)));
    const done = products.filter((p) => p.shelf_image).length;
    const own = products.reduce((n, p) => n + p.variants.filter((v) => v.shelf_image).length, 0);
    summary.textContent = `${done} de ${products.length} yerbas tienen imagen general` +
      (variantsReady ? ` · ${own} ${own === 1 ? "presentación tiene" : "presentaciones tienen"} imagen propia.` : ".");
    mount(grid, visible.length ? visible.map(card) : h("li", { class: "empty-box" }, "No hay yerbas con este filtro."));
  }
  search.addEventListener("input", paint);
  filter.addEventListener("change", paint);

  // Un lugar para una imagen: vista previa + Subir/Reemplazar + Quitar + avisos.
  //   kind: "general" | "variant"; fallback: imagen que se usa si no hay propia.
  function slot({ target, label, kind, fallback, onSaved }) {
    const status = h("p", { class: "shelf-status", role: "status" });
    const input = h("input", { type: "file", accept: Object.keys(TYPES).join(","), class: "shelf-file", "aria-label": `Imagen de góndola: ${label}` });
    const has = !!target.current;
    const pick = h("label", { class: "btn-ghost btn-sm shelf-pick" }, icon("upload"), has ? "Reemplazar" : kind === "general" ? "Subir PNG" : "Subir", input);
    const remove = has ? h("button", { type: "button", class: "btn-ghost btn-sm btn-danger" }, "Quitar") : null;
    const actions = h("div", { class: "shelf-actions" }, pick, remove);

    const shown = target.current ?? fallback ?? null;
    const frame = h("div", { class: `shelf-frame${kind === "variant" ? " shelf-frame--sm" : ""}${!target.current && fallback ? " is-fallback" : ""}` },
      shown
        ? h("img", { src: shown, alt: `Envase: ${label}`, loading: "lazy" })
        : h("span", { class: "shelf-empty" }, "Sin imagen", kind === "general" ? h("small", {}, "En /yerbas se ve el paquete genérico") : null));
    const note = kind === "variant"
      ? h("span", { class: "shelf-source" }, target.current ? "Imagen propia" : fallback ? "Usa la general" : "Paquete genérico")
      : null;

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      input.value = "";
      if (!file) return;
      status.className = "shelf-status";
      if (!TYPES[file.type]) {
        status.textContent = "Tiene que ser un PNG (o WebP), idealmente con fondo transparente.";
        status.classList.add("text-alert");
        return;
      }
      let info;
      try {
        info = await inspectImage(file);
      } catch (err) {
        status.textContent = err.message;
        status.classList.add("text-alert");
        return;
      }
      pick.classList.add("is-busy");
      if (remove) remove.disabled = true;
      status.textContent = "Subiendo…";
      try {
        const { url, oldFileKept } = await uploadShelfImage(target, file);
        onSaved(url, info.warnings);
        toast(`Imagen de góndola guardada: ${label}.${oldFileKept ? " (La anterior quedó en Storage sin uso.)" : ""}`);
      } catch (err) {
        console.error(err);
        status.textContent = err?.message && !err.code ? err.message : errorMessage(err);
        status.classList.add("text-alert");
        pick.classList.remove("is-busy");
        if (remove) remove.disabled = false;
      }
    });

    remove?.addEventListener("click", () => {
      const yes = h("button", { type: "button", class: "btn-primary btn-sm btn-danger-solid" }, "Sí, quitar");
      const no = h("button", { type: "button", class: "btn-ghost btn-sm" }, "No");
      no.addEventListener("click", () => mount(actions, pick, remove));
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true;
        try {
          const { fileKept } = await removeShelfImage(target);
          onSaved(null, []);
          toast(`Se quitó la imagen de góndola: ${label}.${fileKept ? " (El archivo quedó en Storage sin uso.)" : ""}`);
        } catch (err) {
          console.error(err);
          status.textContent = errorMessage(err);
          status.className = "shelf-status text-alert";
          mount(actions, pick, remove);
        }
      });
      mount(actions, h("div", { class: "confirm-box confirm-danger shelf-confirm" },
        h("span", {}, kind === "general"
          ? "¿Quitar la imagen general? Las presentaciones sin imagen propia vuelven al paquete genérico."
          : "¿Quitar la imagen de esta presentación? Va a usar la imagen general."),
        h("div", { class: "row-actions" }, yes, no)));
    });

    return { frame, note, actions, status };
  }

  // Avisos de la última carga (se muestran después de redibujar la tarjeta).
  const lastWarnings = new Map();

  function card(p) {
    const key = (k) => `${p.id}:${k}`;
    const general = slot({
      target: productTarget(p),
      label: p.name,
      kind: "general",
      onSaved: (url, warnings) => { p.shelf_image = url; lastWarnings.set(key("g"), warnings); paint(); },
    });
    showWarnings(general.status, key("g"));

    const variants = variantsReady && p.variants.length
      ? h("div", { class: "shelf-variants" },
          h("p", { class: "shelf-variants-title" }, "Por presentación ", h("span", { class: "hint" }, "(opcional)")),
          h("ul", { class: "shelf-variant-list" }, p.variants.map((v) => {
            const label = `${p.name} · ${presentationLabel(v.name)}`;
            const s = slot({
              target: variantTarget(p, v),
              label,
              kind: "variant",
              fallback: p.shelf_image,
              onSaved: (url, warnings) => { v.shelf_image = url; lastWarnings.set(key(`v${v.id}`), warnings); paint(); },
            });
            showWarnings(s.status, key(`v${v.id}`));
            return h("li", { class: "shelf-variant", "data-variant": String(v.id) },
              s.frame,
              h("div", { class: "shelf-variant-body" },
                h("strong", {}, presentationLabel(v.name), v.is_active ? null : h("span", { class: "badge" }, "No publicada")),
                s.note,
                s.actions,
                s.status));
          })))
      : null;

    return h("li", { class: "shelf-card", "data-product": String(p.id) },
      general.frame,
      h("div", { class: "shelf-info" },
        h("strong", {}, p.name),
        h("span", { class: "muted" }, p.brand || "Otras marcas", p.is_active ? null : h("span", { class: "badge" }, "No publicada")),
        h("a", { class: "shelf-edit-link", href: `#/productos/${p.id}` }, "Ver producto")),
      h("p", { class: "shelf-variants-title" }, "Imagen general"),
      general.actions,
      general.status,
      variants);
  }

  function showWarnings(statusEl, k) {
    const w = lastWarnings.get(k);
    if (w?.length) { statusEl.textContent = w.join(" "); statusEl.classList.add("shelf-warn"); }
    lastWarnings.delete(k);
  }

  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Imágenes de góndola"),
        h("p", { class: "page-sub" }, "El envase de cada yerba en /yerbas. Las fotos del catálogo no cambian."))),
    h("p", { class: "notice-info" },
      "PNG vertical 2:3 (por ejemplo 600 × 900 px), con fondo transparente y el envase completo, sin recortar. " +
      "La imagen general se usa para todas las presentaciones; si querés, cargá una propia para cada una (por ejemplo, el paquete de 500 g)."),
    variantsReady ? null : h("p", { class: "notice-warn" },
      "Para cargar imágenes por presentación falta aplicar la migración supabase/migrations/20261107000000_variant_shelf_images.sql. La imagen general funciona igual."),
    h("div", { class: "toolbar" }, search, filter),
    summary,
    grid);
  paint();
}
