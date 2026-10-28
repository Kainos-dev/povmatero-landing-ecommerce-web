// Filtros por categoría. Los datos vienen de catalogSource.js (fuente actual
// o Supabase); acá solo se elige qué mostrar.
export function initFilters(UI, catalogPromise, render, showError) {

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

  UI.filterChips.forEach(btn => {
    btn.onclick = () => {

      // estado activo
      UI.filterChips.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      show(btn.dataset.category);
    };
  });

  return { show };
}
