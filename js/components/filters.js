export function initFilters(UI, products, renderCatalog, modal, cart) {

  UI.filterChips.forEach(btn => {
    btn.onclick = () => {

      // estado activo
      UI.filterChips.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const category = btn.dataset.category;

      const filtered =
        category === "all"
          ? products
          : products.filter(p => p.category === category);
      renderCatalog(filtered, UI, modal, cart);
    };
  });
}