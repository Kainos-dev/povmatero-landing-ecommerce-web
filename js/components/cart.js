import { escapeHtml } from "../lib/html.js";
import { optimizedSrc, withFallback } from "../lib/images.js";
import { hasStoredSession } from "../lib/session.js";
import { track } from "../lib/track.js";

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
    renderGuestHint();

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
    track("add_to_cart", { productId: product.id });
    return true;
  }

  // WHATSAPP
  // Mensaje del pedido. Con "order" (pedido ya registrado en la cuenta) se usan
  // las líneas y el total que devolvió la base y se agrega el número de pedido.
  function buildMessage(order = null) {
    const lines = order
      ? order.items.map(i => `• ${i.product_name}${i.variant_name ? ` (${i.variant_name})` : ""} x${i.quantity} — ${formatPrice(Number(i.line_total))}`)
      : cart.map(item => `• ${item.name}${item.variant ? ` (${item.variant})` : ""} x${item.qty} — ${formatPrice(item.price * item.qty)}`);
    return [
      "Hola! Quiero hacer este pedido:",
      ...(order ? [`Pedido #${order.id}`] : []),
      "",
      ...lines,
      "",
      `Total: ${formatPrice(order ? Number(order.total) : getCartTotal())}`,
      "",
      "¿Podrías confirmarme disponibilidad?"
    ].join("\n");
  }

  const whatsappUrl = (message) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

  // Con sesión iniciada, el pedido se registra en la cuenta (Mi cuenta › Mis
  // pedidos) antes de abrir WhatsApp. Es una solicitud: no queda confirmado ni
  // pagado. El cliente y los precios los pone la base, no este navegador.
  async function registerOrder() {
    const api = await import("../lib/customerAuth.js");
    const session = await api.getSession();
    if (!session) return null;
    return api.createOrder(cart.map(i => ({ product_id: i.id, variant: i.variant ?? null, quantity: i.qty })));
  }

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

  function showOrderNote(html) {
    if (!UI.cartOrderNote) return;
    UI.cartOrderNote.innerHTML = html;
    UI.cartOrderNote.hidden = !html;
  }

  // Sin sesión: una línea discreta para invitar a ingresar (así el pedido queda
  // guardado en la cuenta). No cambia nada del envío por WhatsApp.
  let orderShown = false;
  function renderGuestHint() {
    if (orderShown || !UI.cartOrderNote) return;
    showOrderNote(cart.length && !hasStoredSession()
      ? `<button type="button" class="cart-note-link" data-cart-login>Ingresá a tu cuenta</button> y tus pedidos quedan guardados en «Mi cuenta».`
      : "");
  }

  UI.cartOrderNote?.addEventListener("click", (e) => {
    const closeCart = () => { UI.cartPanel.classList.remove("open"); UI.cartOverlay.classList.remove("open"); };
    if (e.target.closest("[data-cart-login]")) {
      closeCart();
      document.dispatchEvent(new CustomEvent("povmatero:account-login", { detail: { mode: "login" } }));
    } else if (e.target.closest("a")) {
      closeCart();
    }
  });

  let sending = false;

  async function sendWhatsApp() {
    if (!cart.length || sending) return;
    track("begin_checkout");

    // Sin sesión: igual que siempre, se abre WhatsApp con el mensaje.
    if (!hasStoredSession()) {
      window.open(whatsappUrl(buildMessage()), "_blank");
      return;
    }

    // Con sesión: la pestaña se abre ya (si se abriera después de esperar a la
    // base, el navegador la bloquearía) y se completa al tener el pedido.
    const win = window.open("", "_blank");
    try { win?.document.write("<title>WhatsApp</title><p style=\"font-family:sans-serif;padding:24px\">Abriendo WhatsApp…</p>"); } catch { /* nada */ }
    sending = true;
    UI.whatsappBtn.disabled = true;

    let order = null;
    try {
      order = await withTimeout(registerOrder(), 6000);
    } catch (err) {
      // Si no se pudo registrar, el pedido se envía igual (sin número): la venta
      // nunca depende de la base.
      console.warn("No se pudo registrar el pedido en la cuenta.", err);
    }

    const url = whatsappUrl(buildMessage(order));
    if (win && !win.closed) {
      try { win.opener = null; } catch { /* nada */ }
      win.location.href = url;
    } else {
      window.location.href = url;
    }

    orderShown = Boolean(order);
    showOrderNote(order
      ? `Pedido #${escapeHtml(String(order.id))} guardado en <a href="/cuenta?seccion=pedidos">Mi cuenta</a>. Es una solicitud: se confirma por WhatsApp.`
      : "");
    sending = false;
    UI.whatsappBtn.disabled = false;
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