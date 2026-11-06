import { escapeHtml } from "../lib/html.js";
import { optimizedSrc, withFallback } from "../lib/images.js";
import { hasStoredSession, storedUserId, SESSION_KEY } from "../lib/session.js";
import { track } from "../lib/track.js";

// La foto del carrito se ve a 72 px: alcanza con una versión chica.
const CART_IMAGE_WIDTH = 256;

// El carrito se guarda en este navegador (producto, presentación y cantidad) y,
// al volver, se reconstruye con el catálogo actual: precios, fotos y stock al día.
//
// Hay un carrito por dueño: uno de invitado y uno por cada cuenta que ingresó en
// este navegador. Así nunca se ve el carrito de otra persona:
//   * al ingresar o registrarse desde la tienda, lo que había como invitado se
//     suma al carrito de la cuenta (y el de invitado queda vacío);
//   * al cerrar sesión se ve el carrito de invitado; el de la cuenta queda
//     guardado para la próxima vez;
//   * si la sesión cambia por otro lado (el panel, otra pestaña), solo se cambia
//     de carrito, sin sumar nada (un admin no hereda el carrito de nadie).
const CART_PREFIX = "povmatero-cart-v2:";
const LEGACY_KEY = "povmatero-cart-v1";   // carrito único de antes (sin dueño)

const cartKey = (owner) => `${CART_PREFIX}${owner ? `u:${owner}` : "guest"}`;

function readSaved(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeSaved(key, items) {
  try {
    if (items.length) localStorage.setItem(key, JSON.stringify(items));
    else localStorage.removeItem(key);
  } catch {
    // Sin almacenamiento disponible (modo privado): el carrito dura lo que la pestaña.
  }
}

// Une listas guardadas: el mismo producto y presentación queda en una sola
// línea con las cantidades sumadas (el stock se controla al rearmar).
function mergeSaved(...lists) {
  const lines = new Map();
  for (const list of lists) {
    for (const s of list) {
      const id = Number(s?.id);
      const qty = Math.floor(Number(s?.qty) || 0);
      if (!Number.isInteger(id) || qty < 1) continue;
      const variant = s.variant ?? null;
      const k = JSON.stringify([id, variant]);
      const line = lines.get(k);
      if (line) line.qty += qty;
      else lines.set(k, { id, variant, qty });
    }
  }
  return [...lines.values()];
}

export function initCart(UI) {

  let cart = [];
  let products = null;            // catálogo actual (llega con restore)
  let owner = storedUserId();     // null = invitado

  // El carrito único de antes pasa a quien está usando el navegador ahora.
  try {
    const legacy = readSaved(LEGACY_KEY);
    if (legacy.length) writeSaved(cartKey(owner), mergeSaved(readSaved(cartKey(owner)), legacy));
    localStorage.removeItem(LEGACY_KEY);
  } catch { /* sin almacenamiento */ }

  const WHATSAPP_NUMBER = "5491160554815";

  function formatPrice(price) {
    return "$" + price.toLocaleString("es-AR");
  }

  function getCartTotal() {
    return cart.reduce((acc, item) => acc + item.price * item.qty, 0);
  }

  function update() {
    render();
    save();
  }

  function render() {
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
  }

  function save() {
    // Sin catálogo todavía no hay nada armado: no se pisa lo guardado.
    if (!products) return;
    writeSaved(cartKey(owner), cart.map(i => ({ id: i.id, variant: i.variant ?? null, qty: i.qty })));
  }

  // Rearma el carrito guardado del dueño actual con los productos publicados de
  // ahora. Lo que ya no está publicado o no tiene stock se quita; la cantidad se
  // ajusta al stock.
  function load() {
    cart = [];
    if (!products) { render(); return; }
    const byId = new Map(products.map(p => [p.id, p]));
    for (const s of mergeSaved(readSaved(cartKey(owner)))) {
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

  function restore(list) {
    products = list;
    load();
  }

  // ¿Cambió quién tiene la sesión en este navegador? Si cambió, se pasa al
  // carrito del nuevo dueño. "merge" (solo al ingresar o registrarse desde la
  // tienda): lo que había como invitado se suma al carrito de la cuenta.
  // Devuelve true si cambió el carrito.
  function syncOwner({ merge = false } = {}) {
    const next = storedUserId();
    if (next === owner) return false;
    const previous = owner;
    owner = next;
    if (merge && previous === null && next !== null) {
      const guest = readSaved(cartKey(null));
      if (guest.length) {
        writeSaved(cartKey(next), mergeSaved(readSaved(cartKey(next)), guest));
        writeSaved(cartKey(null), []);
      }
    }
    // El aviso de pedido era del dueño anterior.
    orderShown = false;
    showOrderNote("");
    load();
    return true;
  }

  function add(product) {
    syncOwner();

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
  // "items": copia del carrito tomada al tocar «Enviar» (si la sesión cambia
  // mientras se registra el pedido, no se mezcla con otro carrito).
  function buildMessage(order = null, items = cart) {
    const lines = order
      ? order.items.map(i => `• ${i.product_name}${i.variant_name ? ` (${i.variant_name})` : ""} x${i.quantity} — ${formatPrice(Number(i.line_total))}`)
      : items.map(item => `• ${item.name}${item.variant ? ` (${item.variant})` : ""} x${item.qty} — ${formatPrice(item.price * item.qty)}`);
    return [
      "Hola! Quiero hacer este pedido:",
      ...(order ? [`Pedido ${order.public_code || "Código pendiente"}`] : []),
      "",
      ...lines,
      "",
      `Total: ${formatPrice(order ? Number(order.total) : items.reduce((acc, item) => acc + item.price * item.qty, 0))}`,
      "",
      "¿Podrías confirmarme disponibilidad?"
    ].join("\n");
  }

  const whatsappUrl = (message) => `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

  // Con sesión iniciada, el pedido se registra en la cuenta (Mi cuenta › Mis
  // pedidos) antes de abrir WhatsApp. Es una solicitud: no queda confirmado ni
  // pagado. El cliente y los precios los pone la base, no este navegador.
  // "items" y "itemsOwner": el carrito tomado al tocar «Enviar» y de quién era.
  // Si la sesión ya es de otra cuenta, no se registra nada a su nombre.
  async function registerOrder(items, itemsOwner) {
    const api = await import("../lib/customerAuth.js");
    const session = await api.getSession();
    if (!session) return null;
    if (session.user?.id !== itemsOwner) throw Object.assign(new Error("La sesión cambió."), { code: "owner_changed" });
    return api.createOrder(items.map(i => ({ product_id: i.id, variant: i.variant ?? null, quantity: i.qty })));
  }

  function sessionChangedNotice() {
    orderShown = true;
    showOrderNote("La sesión cambió en este navegador. Revisá el carrito antes de enviar el pedido.");
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
    if (sending) return;
    // Si la sesión cambió (por ejemplo, en otra pestaña), primero se muestra el
    // carrito que corresponde; no se envía nada.
    if (syncOwner()) { sessionChangedNotice(); return; }
    if (!cart.length) return;
    track("begin_checkout");
    const items = cart.map(i => ({ ...i }));
    const itemsOwner = owner;

    // Sin sesión: igual que siempre, se abre WhatsApp con el mensaje.
    if (!hasStoredSession()) {
      window.open(whatsappUrl(buildMessage(null, items)), "_blank");
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
      order = await withTimeout(registerOrder(items, itemsOwner), 6000);
    } catch (err) {
      if (err?.code === "owner_changed") {
        try { win?.close(); } catch { /* nada */ }
        syncOwner();
        sessionChangedNotice();
        sending = false;
        UI.whatsappBtn.disabled = false;
        return;
      }
      // Si no se pudo registrar, el pedido se envía igual (sin número): la venta
      // nunca depende de la base.
      console.warn("No se pudo registrar el pedido en la cuenta.", err);
    }

    const url = whatsappUrl(buildMessage(order, items));
    if (win && !win.closed) {
      try { win.opener = null; } catch { /* nada */ }
      win.location.href = url;
    } else {
      window.location.href = url;
    }

    orderShown = Boolean(order);
    showOrderNote(order
      ? `Pedido ${escapeHtml(order.public_code || "Código pendiente")} guardado en <a href="/cuenta?seccion=pedidos">Mi cuenta</a>. Es una solicitud: se confirma por WhatsApp.`
      : "");
    sending = false;
    UI.whatsappBtn.disabled = false;
  }

  // eventos
  UI.cartBtn.onclick = () => {
    syncOwner();
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

  // Sesión iniciada o cerrada en esta pestaña (js/components/account.js y
  // «Mi cuenta»). Solo al ingresar o registrarse se suma el carrito de invitado.
  document.addEventListener("povmatero:signed-in", () => syncOwner({ merge: true }));
  document.addEventListener("povmatero:signed-out", () => syncOwner());

  // Otras pestañas (tienda o panel): cambio de sesión o del carrito del dueño actual.
  window.addEventListener("storage", (e) => {
    if (e.key === null) { if (!syncOwner()) load(); return; }   // se borró todo
    if (e.key === SESSION_KEY) syncOwner();
    else if (e.key === cartKey(owner)) load();
  });

  return { add, restore };
}
