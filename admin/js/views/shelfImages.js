// Imágenes de góndola: una tarjeta por yerba para cargar, reemplazar o quitar
// el PNG del envase que se ve en /yerbas. Las fotos del catálogo no se tocan.
import { h, mount, errorMessage, normalizeText, toast } from "../ui.js";
import { icon } from "../icons.js";
import { listYerbasWithShelfImage, uploadShelfImage, removeShelfImage, inspectImage, TYPES } from "../api/shelfImages.js";

export async function renderShelfImages(view) {
  mount(view, h("p", { class: "muted" }, "Cargando yerbas…"));

  let products;
  try {
    products = await listYerbasWithShelfImage();
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
    h("option", { value: "missing" }, "Sin imagen de góndola"),
    h("option", { value: "done" }, "Con imagen de góndola"));
  const summary = h("p", { class: "muted" });
  const grid = h("ul", { class: "shelf-grid" });

  function paint() {
    const q = normalizeText(search.value.trim());
    const visible = products.filter((p) =>
      (!q || normalizeText(`${p.name} ${p.brand ?? ""}`).includes(q))
      && (filter.value !== "missing" || !p.shelf_image)
      && (filter.value !== "done" || p.shelf_image));
    const done = products.filter((p) => p.shelf_image).length;
    summary.textContent = `${done} de ${products.length} yerbas tienen imagen de góndola.`;
    mount(grid, visible.length ? visible.map(card) : h("li", { class: "empty-box" }, "No hay yerbas con este filtro."));
  }
  search.addEventListener("input", paint);
  filter.addEventListener("change", paint);

  function card(p) {
    const status = h("p", { class: "shelf-status", role: "status" });
    const input = h("input", { type: "file", accept: Object.keys(TYPES).join(","), class: "shelf-file", "aria-label": `Imagen de góndola de ${p.name}` });
    const pick = h("label", { class: "btn-ghost btn-sm shelf-pick" }, icon("upload"), p.shelf_image ? "Reemplazar" : "Subir PNG", input);
    const remove = p.shelf_image ? h("button", { type: "button", class: "btn-ghost btn-sm btn-danger" }, "Quitar") : null;
    const actions = h("div", { class: "shelf-actions" }, pick, remove);

    const frame = h("div", { class: "shelf-frame" },
      p.shelf_image
        ? h("img", { src: p.shelf_image, alt: `Envase de ${p.name}`, loading: "lazy" })
        : h("span", { class: "shelf-empty" }, "Sin imagen", h("small", {}, "En /yerbas se ve el paquete genérico")));

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
      remove && (remove.disabled = true);
      status.textContent = "Subiendo…";
      try {
        const { url, oldFileKept } = await uploadShelfImage(p, file);
        p.shelf_image = url;
        paint();
        toast(`Imagen de góndola de «${p.name}» guardada.${oldFileKept ? " (La anterior quedó en Storage sin uso.)" : ""}`);
        if (info.warnings.length) {
          const fresh = grid.querySelector(`[data-product="${p.id}"] .shelf-status`);
          if (fresh) { fresh.textContent = info.warnings.join(" "); fresh.classList.add("shelf-warn"); }
        }
      } catch (err) {
        console.error(err);
        status.textContent = err?.message && !err.code ? err.message : errorMessage(err);
        status.classList.add("text-alert");
        pick.classList.remove("is-busy");
        remove && (remove.disabled = false);
      }
    });

    remove?.addEventListener("click", () => {
      const yes = h("button", { type: "button", class: "btn-primary btn-sm btn-danger-solid" }, "Sí, quitar");
      const no = h("button", { type: "button", class: "btn-ghost btn-sm" }, "No");
      no.addEventListener("click", () => mount(actions, pick, remove));
      yes.addEventListener("click", async () => {
        yes.disabled = no.disabled = true;
        try {
          const { fileKept } = await removeShelfImage(p);
          p.shelf_image = null;
          paint();
          toast(`Se quitó la imagen de góndola de «${p.name}».${fileKept ? " (El archivo quedó en Storage sin uso.)" : ""}`);
        } catch (err) {
          console.error(err);
          status.textContent = errorMessage(err);
          status.className = "shelf-status text-alert";
          mount(actions, pick, remove);
        }
      });
      mount(actions, h("div", { class: "confirm-box confirm-danger shelf-confirm" },
        h("span", {}, "¿Quitar la imagen? En /yerbas vuelve el paquete genérico."),
        h("div", { class: "row-actions" }, yes, no)));
    });

    return h("li", { class: "shelf-card", "data-product": String(p.id) },
      frame,
      h("div", { class: "shelf-info" },
        h("strong", {}, p.name),
        h("span", { class: "muted" }, p.brand || "Otras marcas", p.is_active ? null : h("span", { class: "badge" }, "No publicada")),
        h("a", { class: "shelf-edit-link", href: `#/productos/${p.id}` }, "Ver producto")),
      actions,
      status);
  }

  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Imágenes de góndola"),
        h("p", { class: "page-sub" }, "El envase de cada yerba en /yerbas. Las fotos del catálogo no cambian."))),
    h("p", { class: "notice-info" },
      "PNG vertical 2:3 (por ejemplo 600 × 900 px), con fondo transparente y el envase completo, sin recortar. " +
      "Una imagen por yerba: en la góndola se usa para sus presentaciones (500 g y 1 kg)."),
    h("div", { class: "toolbar" }, search, filter),
    summary,
    grid);
  paint();
}
