// Filtros por categoría. Los datos vienen de catalogSource.js (Supabase o la
// fuente anterior); acá solo se elige qué mostrar.
//
// Con Supabase, los botones se ajustan a las categorías que tienen productos
// publicados: se ocultan los que quedarían vacíos y se agregan las categorías
// nuevas creadas desde el panel. Con la fuente anterior quedan como en el HTML.
import { scrollToUnderHeader } from "../lib/scroll.js";

export function initFilters(UI, catalogPromise, render, showError) {
  const container = UI.filterChips[0]?.parentElement;

  // Si se toca otro filtro antes de que llegue la respuesta anterior,
  // la respuesta vieja se descarta.
  let lastRequest = 0;

  // scroll: true solo cuando la persona eligió la categoría (no al cargar).
  async function show(category, { scroll = false } = {}) {
    const request = ++lastRequest;

    try {
      const catalog = await catalogPromise;
      const list = await catalog.getCategory(category);
      if (request !== lastRequest) return;
      render(list);
    } catch (error) {
      if (request !== lastRequest) return;
      console.error("No se pudo cargar el catálogo:", error);
      showError();
    }
    if (scroll && request === lastRequest) scrollToResults();
  }

  // Primero se aplica el filtro; en el cuadro siguiente (ya con la grilla
  // nueva y la barra de categorías cerrada en celular) se va al comienzo del
  // catálogo: el título «CATÁLOGO DE PRODUCTOS», justo debajo del encabezado.
  // Desde ahí se ven la barra de categorías y los productos (o el aviso de
  // categoría vacía, que queda inmediatamente debajo).
  // En celular el desplegable de categorías se cierra al elegir una: el
  // desplazamiento espera a que termine (≈0,24 s) para no competir con esa
  // animación.
  function scrollToResults() {
    requestAnimationFrame(async () => {
      const closing = UI.filtersContent?.getAnimations?.() ?? [];
      await Promise.all(closing.map((a) => a.finished.catch(() => {})));
      scrollToUnderHeader(document.getElementById("productos"));
    });
  }

  function chips() {
    return container ? [...container.querySelectorAll(".filter-chip")] : [];
  }

  function select(btn, { fromUser = false } = {}) {
    chips().forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    show(btn.dataset.category, { scroll: fromUser });
  }

  // Un solo listener para todos los botones, incluidos los que se agregan después.
  container?.addEventListener("click", (event) => {
    const btn = event.target.closest(".filter-chip");
    if (btn && container.contains(btn)) select(btn, { fromUser: true });
  });

  function syncChips(categories) {
    if (!container || !categories) return;
    const available = new Set(categories.map((c) => c.slug));

    for (const btn of chips()) {
      const slug = btn.dataset.category;
      if (slug !== "all") btn.hidden = !available.has(slug);
    }

    // Mismo orden y nombres que en el panel; "Todo" queda primero.
    for (const c of categories) {
      let btn = chips().find((b) => b.dataset.category === c.slug);
      if (!btn) {
        btn = document.createElement("button");
        btn.type = "button";
        btn.className = "filter-chip";
        btn.dataset.category = c.slug;
      }
      btn.textContent = c.name;
      container.append(btn);
    }

    // Si el filtro activo quedó oculto, se vuelve a "Todo".
    const active = chips().find((b) => b.classList.contains("active"));
    if (active?.hidden) {
      const all = chips().find((b) => b.dataset.category === "all");
      if (all) select(all);
    }
  }

  catalogPromise.then((catalog) => syncChips(catalog.categories)).catch(() => {});

  return { show };
}
