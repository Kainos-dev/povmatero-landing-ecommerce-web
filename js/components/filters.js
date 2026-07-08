import { getYerbas, transformarYerbas} from "../yerbas.js";

export function initFilters(UI, products, renderCatalog, modal, cart) {

  UI.filterChips.forEach(btn => {
    btn.onclick = async () => {

      // estado activo
      UI.filterChips.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const category = btn.dataset.category;

      // 🔥 CASO YERBAS
      if (category === "yerbas") {
        
        const data = await getYerbas();
        const yerbasProducts = transformarYerbas(data);

        renderCatalog(yerbasProducts, UI, modal, cart);
        return;

        // const container = UI.productGrid;
        // container.innerHTML = "";
        
        // const data = await getYerbas();
        // const grupos = agruparYerbas(data);

        // Object.keys(grupos).forEach(nombre => {
        //   const variantes = grupos[nombre];

        //   const card = document.createElement("div");
        //   card.classList.add("product-card");

        //   let variantesHTML = "";

        //   variantes.forEach(v => {
        //     const precio = v.Precio || "-";
        //     const stock = v.Stock || "0";
        //     const peso = v.Peso || "-";

        //     variantesHTML += `
        //       <div class="variante">
        //         <span>${peso}</span>
        //         <span>${precio}</span>
        //         <span>${Number(stock) > 0 ? `Quedan ${stock}` : "Sin stock"}</span>
        //       </div>
        //     `;
        //   });

        //   card.innerHTML = `
        //     <h3>${nombre}</h3>
        //     <div class="variantes">
        //       ${variantesHTML}
        //     </div>
        //   `;

        //   container.appendChild(card);
        // });

        // return; //-> corta la ejecucion
      }

      const filtered =
        category === "all"
          ? products
          : products.filter(p => p.category === category);

      renderCatalog(filtered, UI, modal, cart);
    };
  });
}