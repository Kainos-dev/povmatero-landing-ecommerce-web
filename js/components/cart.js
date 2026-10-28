export function initCart(UI) {

  let cart = [];

  const WHATSAPP_NUMBER = "5491160554815";

  function formatPrice(price) {
    return "$" + price.toLocaleString("es-AR");
  }

  function getCartTotal() {
    return cart.reduce((acc, item) => acc + item.price * item.qty, 0);
  }

  function update() {
    UI.cartItems.innerHTML = "";

    cart.forEach(item => {
      const div = document.createElement("div");
      div.className = "cart-item";

      div.innerHTML = `
        <img src="${item.image}" class="cart-item-img"/>

        <div class="cart-item-info">
          <p class="cart-item-name">${item.name}</p>
          ${item.variant ? `<p class="cart-item-variant">Variante: ${item.variant}.</p>` : ""}

          <p class="cart-item-price">${formatPrice(item.price)}</p>

          <div class="cart-item-controls">
            <button class="qty-btn minus">−</button>
            <span class="qty-value">${item.qty}</span>
            <button class="qty-btn plus">+</button>
          </div>

          <button class="cart-item-remove">Eliminar</button>
        </div>
      `;

      // ➕ ➖
      // maxQty = stock disponible (null = no se controla stock)
      const plus = div.querySelector(".plus");
      const atLimit = item.maxQty != null && item.qty >= item.maxQty;
      plus.disabled = atLimit;
      if (atLimit) plus.title = "No hay más stock disponible";
      plus.onclick = () => {
        if (item.maxQty != null && item.qty >= item.maxQty) return;
        item.qty++;
        update();
      };

      div.querySelector(".minus").onclick = () => {
        if (item.qty > 1) {
          item.qty--;
        } else {
          cart = cart.filter(i => i !== item);
        }
        update();
      };

      // eliminar
      div.querySelector(".cart-item-remove").onclick = () => {
        cart = cart.filter(i => i !== item);
        update();
      };

      UI.cartItems.appendChild(div);
    });

    // total
    UI.cartTotal.textContent = formatPrice(getCartTotal());

    // contador
    const totalQty = cart.reduce((acc, item) => acc + item.qty, 0);
    UI.cartCount.textContent = totalQty;
    UI.cartCount.classList.toggle("visible", totalQty > 0);

    // estado vacío
    UI.cartEmptyMsg.classList.toggle("hidden", cart.length > 0);
  }

  function add(product) {

    const existing = cart.find(item =>
      item.id === product.id &&
      item.variant === product.variant
    );

    // No se supera el stock disponible (maxQty null = no se controla).
    const limit = product.maxQty ?? null;
    if (limit != null && (existing?.qty ?? 0) >= limit) return false;

    if (existing) {
      existing.maxQty = limit;
      existing.qty++;
    } else {
      cart.push({
        ...product,
        qty: 1
      });
    }

    update();
    return true;
  }

  // WHATSAPP
  function sendWhatsApp() {

    if (!cart.length) return;

    const lines = cart.map(item => {
      return `• ${item.name}${
        item.variant ? ` (${item.variant})` : ""
      } x${item.qty} — ${formatPrice(item.price * item.qty)}`;
    });

    const message = [
      "Hola! Quiero hacer este pedido:",
      "",
      ...lines,
      "",
      `Total: ${formatPrice(getCartTotal())}`,
      "",
      "¿Podrías confirmarme disponibilidad?"
    ].join("\n");

    const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

    window.open(url, "_blank");
  }

  // eventos
  UI.cartBtn.onclick = () => {
    UI.cartPanel.classList.add("open");
    UI.cartOverlay.classList.add("open");
  };

  UI.cartClose.onclick = () => {
    UI.cartPanel.classList.remove("open");
    UI.cartOverlay.classList.remove("open");
  };

  UI.cartOverlay.onclick = () => {
    UI.cartPanel.classList.remove("open");
    UI.cartOverlay.classList.remove("open");
  };

  UI.whatsappBtn.onclick = sendWhatsApp;

  return { add };
}