function formatPrice(price) {
  return "$" + price.toLocaleString("es-AR");
}

function shuffle(array) {
  return [...array].sort(() => Math.random() - 0.5);
}

export function renderCatalog(products, UI, modal, cart) {
  UI.productGrid.innerHTML = "";

  if (!products.length) {
    UI.emptyState.style.display = "block";
    return;
  }

  UI.emptyState.style.display = "none";

  const randomized = shuffle(products);

randomized.forEach(product => {
    const card = document.createElement("div");
    card.className = "product-card";

    card.innerHTML = `
      <div class="card-image-wrap">
        <img src="${product.image}" class="card-img"/>
      </div>

      <div class="card-body">
        <p class="card-category">${product.category}</p>
        <p class="card-name">${product.name}</p>
        <p class="card-price">${formatPrice(product.price)}</p>
        <button class="btn-add">Ver más</button>
      </div>
    `;

    // MODAL
    card.querySelector(".card-img").onclick = () => {
      modal.open(product);
    };

    card.querySelector(".card-name").onclick = () => {
      modal.open(product);
    };

    // CARRITO
    card.querySelector(".btn-add").onclick = () => {
      modal.open(product);
    };

    UI.productGrid.appendChild(card);
  });
}