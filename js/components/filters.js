// Filtros por categoría. Los datos vienen de catalogSource.js (Supabase o la
// fuente anterior); acá solo se elige qué mostrar.
//
// Con Supabase, los botones se ajustan a las categorías que tienen productos
// publicados: se ocultan los que quedarían vacíos y se agregan las categorías
// nuevas creadas desde el panel. Con la fuente anterior quedan como en el HTML.
export function initFilters(UI, catalogPromise, render, showError) {
  const container = UI.filterChips[0]?.parentElement;

  // Si se toca otro filtro antes de que llegue la respuesta anterior,
  // la respuesta vieja se descarta.
  let lastRequest = 0;

  async function show(category) {
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
  }

  function chips() {
    return container ? [...container.querySelectorAll(".filter-chip")] : [];
  }

  function select(btn) {
    chips().forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    show(btn.dataset.category);
  }

  // Un solo listener para todos los botones, incluidos los que se agregan después.
  container?.addEventListener("click", (event) => {
    const btn = event.target.closest(".filter-chip");
    if (btn && container.contains(btn)) select(btn);
  });

  function syncChips(categories) {
    if (!container || !categories) return;
    const available = new Set(categories.map((c) => c.slug));

    for (const btn of chips()) {
      const slug = btn.dataset.category;
      if (slug !== "all") btn.hidden = !available.has(slug);
    }

    const existing = new Set(chips().map((b) => b.dataset.category));
    const added = categories
      .filter((c) => !existing.has(c.slug))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    for (const c of added) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "filter-chip";
      btn.dataset.category = c.slug;
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
