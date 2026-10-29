import { escapeHtml } from "../lib/html.js";
import { optimizedSrc, withFallback } from "../lib/images.js";

// La foto del carrito se ve a 72 px: alcanza con una versión chica.
const CART_IMAGE_WIDTH = 256;

// El carrito se guarda en este navegador (producto, presentación y cantidad) y,
// al volver, se reconstruye con el catálogo actual: precios, fotos y stock al día.
const STORAGE_KEY = "povmatero-cart-v1";

function readSaved() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

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
        <img src="${escapeHtml(optimizedSrc(item.image, CART_IMAGE_WIDTH))}" alt="" class="cart-item-img" decoding="async"/>

        <div class="cart-item-info">
          <p class="cart-item-name">${escapeHtml(item.name)}</p>
          ${item.variant ? `<p class="cart-item-variant">Variante: ${escapeHtml(item.variant)}.</p>` : ""}

          <p class="cart-item-price">${formatPrice(item.price)}</p>

          <div class="cart-item-controls">
            <button class="qty-btn minus">−</button>
            <span class="qty-value">${item.qty}</span>
            <button class="qty-btn plus">+</button>
          </div>

          <button class="cart-item-remove">Eliminar</button>
        </div>
      `;

      withFallback(div.querySelector(".cart-item-img"), item.image);

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

    save();
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cart.map(i => ({ id: i.id, variant: i.variant ?? null, qty: i.qty }))));
    } catch {
      // Sin almacenamiento disponible (modo privado): el carrito dura lo que la pestaña.
    }
  }

  // Rearma el carrito guardado con los productos publicados de ahora. Lo que ya no
  // está publicado o no tiene stock se quita; la cantidad se ajusta al stock.
  function restore(products) {
    const saved = readSaved();
    if (!saved.length || cart.length) return;
    const byId = new Map(products.map(p => [p.id, p]));
    for (const s of saved) {
      const product = byId.get(s.id);
      if (!product) continue;
      let price = product.price, stock = product.stock ?? null, image = product.image;
      if (product.variants) {
        const v = product.variants.find(x => x.name === s.variant);
        if (!v) continue;
        price = v.price;
        stock = v.stock ?? null;
        if (product.category !== "yerbas" && v.image) image = v.image;
      } else if (s.variant) {
        continue;
      }
      const qty = Math.min(Math.max(1, Math.floor(Number(s.qty) || 1)), stock ?? Infinity);
      if (!(price > 0) || qty < 1) continue;
      cart.push({ ...product, image, variant: s.variant ?? null, price, maxQty: stock, qty });
    }
    update();
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

  // Esc cierra el carrito
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && UI.cartPanel.classList.contains("open")) {
      UI.cartPanel.classList.remove("open");
      UI.cartOverlay.classList.remove("open");
    }
  });

  return { add, restore };
}