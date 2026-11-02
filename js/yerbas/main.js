// /yerbas: góndolas por marca, presentaciones de cada paquete, carrito visual
// y envío del pedido (se registra en Supabase y se abre WhatsApp).
//
// Datos: js/yerbas/catalog.js (stock = disponible). Carrito: js/yerbas/basket.js
// (uno por invitado y uno por cuenta). Pedido: js/yerbas/api.js (se carga al enviar).
import { loadYerbas, productAvailable, isAvailable, availabilityText, OTHER_BRANDS } from "./catalog.js";
import { createBasket } from "./basket.js";
import { optimizedSrc, withFallback } from "../lib/images.js";
import { escapeHtml } from "../lib/html.js";
import { hasStoredSession } from "../lib/session.js";
import { track } from "../lib/track.js";
import { initAccount } from "../components/account.js";
import { showToast } from "../components/ui.js";

const WHATSAPP_NUMBER = "5491160554815";
const MAX_PER_PRESENTATION = 20;            // mismo límite que la base
const PACK_WIDTH = 256;                      // ancho de imagen pedido al optimizador
const LABEL_COLORS = ["#2f5d3a", "#7a2e2e", "#1f3b63", "#8a6a2b", "#4a4a4a", "#5b3a6b", "#2c5a5a", "#6b4a2b"];

const $ = (id) => document.getElementById(id);
const money = (n) => "$" + Math.round(Number(n)).toLocaleString("es-AR");

const ui = {
  tabs: $("brandTabs"), track: $("track"), prev: $("prevBrand"), next: $("nextBrand"), hint: $("swipeHint"),
  dock: $("cartDock"), load: $("cartLoad"), count: $("cartCount"), total: $("cartTotal"),
  scrim: $("scrim"), productSheet: $("productSheet"), cartSheet: $("cartSheet"),
};

let catalog = null;
let current = 0;              // góndola visible
let openSheet = null;         // hoja abierta
let lastFocus = null;
let pendingCheckout = false;  // se pidió ingresar para enviar: al volver se abre el carrito
let profile = null;           // { phone } del cliente con sesión (para pedir teléfono si falta)
let profileFor = null;
let sending = false;

const basket = createBasket({ onChange: (_lines, { ownerChanged } = {}) => {
  if (ownerChanged) { profile = null; profileFor = null; }
  renderDock();
  renderBadges();
  if (openSheet === ui.cartSheet) renderCartSheet();
  if (ownerChanged && pendingCheckout && hasStoredSession()) {
    pendingCheckout = false;
    openCart();
  }
} });

// ---------------------------------------------------------------------
// Paquetes
// ---------------------------------------------------------------------
function shortName(product) {
  const b = product.brand?.trim();
  if (b && product.name.toLowerCase().startsWith(b.toLowerCase() + " ")) return product.name.slice(b.length + 1);
  return product.name;
}

function labelColor(product) {
  let h = 0;
  for (const ch of product.name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LABEL_COLORS[h % LABEL_COLORS.length];
}

// Un paquete:
//   * con imagen de góndola (products.shelf_image: PNG vertical 2:3, cargado
//     desde el panel): el envase entero, sin recortar ni deformar;
//   * sin ella: paquete genérico (2:3) con la foto del catálogo como frente o,
//     si tampoco hay, con la marca y el nombre sobre una banda de color.
// La foto del catálogo nunca se modifica: solo se reutiliza en el genérico.
function packHtml(product, { size = "" } = {}) {
  if (product.shelfImage) {
    return `
      <span class="y-pack y-pack--shelf ${size}" data-pack-of="${product.id}" data-size="${escapeHtml(size)}">
        <img class="y-pack-img" src="${escapeHtml(optimizedSrc(product.shelfImage, PACK_WIDTH))}" alt="" loading="lazy" decoding="async" data-src="${escapeHtml(product.shelfImage)}">
      </span>`;
  }
  return genericPackHtml(product, size);
}

function genericPackHtml(product, size = "") {
  const img = product.image
    ? `<img class="y-pack-img" src="${escapeHtml(optimizedSrc(product.image, PACK_WIDTH))}" alt="" loading="lazy" decoding="async" data-src="${escapeHtml(product.image)}">`
    : "";
  const brand = product.brand?.trim() || "";
  return `
    <span class="y-pack ${size} ${product.image ? "" : "y-pack--blank"}" style="--label:${labelColor(product)}">
      <span class="y-pack-seal"></span>
      <span class="y-pack-face">
        ${img}
        <span class="y-pack-text">${brand ? `<small>${escapeHtml(brand)}</small>` : ""}<b>${escapeHtml(shortName(product))}</b></span>
      </span>
    </span>`;
}

function wirePackImages(root) {
  root.querySelectorAll("img.y-pack-img:not([data-wired])").forEach((img) => {
    img.dataset.wired = "1";
    const pack = img.closest(".y-pack");
    // Si la imagen de góndola no carga (tampoco la original), va el paquete genérico.
    // (Se escucha antes que withFallback: el primer error es el de la versión
    // optimizada, que withFallback reintenta con la original.)
    if (pack?.classList.contains("y-pack--shelf")) {
      img.addEventListener("error", () => {
        const original = img.dataset.originalSrc;
        if (original && img.getAttribute("src") !== original) return;   // withFallback reintenta
        const product = catalog?.products.find((p) => p.id === Number(pack.dataset.packOf));
        if (!product) return;
        const holder = pack.parentElement;
        pack.outerHTML = genericPackHtml(product, pack.dataset.size);
        if (holder) wirePackImages(holder);
      });
    }
    withFallback(img, img.dataset.src);
    const loaded = () => pack?.classList.add("is-loaded");
    if (img.complete && img.naturalWidth) loaded(); else img.addEventListener("load", loaded, { once: true });
  });
}

// ---------------------------------------------------------------------
// Góndolas
// ---------------------------------------------------------------------
// Ancho del estante en «lugares»: cada presentación ocupa un lugar, así una
// yerba con 500 g y 1 kg muestra sus dos paquetes juntos.
function perRow() {
  const w = ui.track.clientWidth || window.innerWidth;
  if (w >= 1100) return 12;
  if (w >= 820) return 9;
  if (w >= 560) return 6;
  return 4;
}

// Reparte las yerbas en estantes sin separar las presentaciones de una misma
// yerba, con estantes parejos (no uno lleno y otro casi vacío).
function shelfRows(products, max) {
  const total = products.reduce((n, p) => n + Math.min(p.variants.length, max), 0);
  const target = Math.ceil(total / Math.ceil(total / max));
  const rows = [[]];
  let used = 0;
  for (const p of products) {
    const span = Math.min(p.variants.length, max);
    if (used && (used + span > max || used >= target)) { rows.push([]); used = 0; }
    rows.at(-1).push(p);
    used += span;
  }
  return rows;
}

// Altura relativa de cada paquete: el de menos gramos se dibuja más bajo.
function packScale(product, variant) {
  const max = Math.max(...product.variants.map((v) => v.grams ?? 0));
  if (!variant.grams || !max || variant.grams >= max) return 1;
  return Math.max(0.7, 0.62 + 0.38 * (variant.grams / max));
}

function itemHtml(brand, p) {
  const out = !productAvailable(p);
  const name = brand.name === OTHER_BRANDS ? p.name : shortName(p);
  const states = p.variants.map((v) => `${v.label} ${isAvailable(v) ? money(v.price) : "agotado"}`).join(", ");
  return `
    <button type="button" class="y-item${out ? " is-out" : ""}" data-product="${p.id}"
      style="--n:${p.variants.length}" aria-label="${escapeHtml(`${p.name}: ${states}`)}">
      <span class="y-variants">
        ${p.variants.map((v) => {
          const vOut = !isAvailable(v);
          return `
            <span class="y-variant${vOut ? " is-out" : ""}" data-variant="${v.id}" style="--scale:${packScale(p, v)}">
              <span class="y-variant-pack">${packHtml(p)}${vOut ? `<span class="y-out-tag">Agotado</span>` : ""}<span class="y-item-badge" hidden></span></span>
            </span>`;
        }).join("")}
      </span>
      <span class="y-item-meta">
        <span class="y-item-name">${escapeHtml(name)}</span>
        <span class="y-variant-labels">
          ${p.variants.map((v) => `
            <span class="y-variant-label${isAvailable(v) ? "" : " is-out"}">${escapeHtml(v.label)}<b>${isAvailable(v) ? money(v.price) : "Agotado"}</b></span>`).join("")}
        </span>
      </span>
    </button>`;
}

function renderAisle() {
  const max = perRow();
  ui.track.removeAttribute("aria-busy");
  if (!catalog.brands.length) {
    ui.track.innerHTML = `<section class="y-gondola y-empty"><p>Por ahora no hay yerbas publicadas. Volvé pronto.</p><a class="y-btn-ghost" href="/">Ir a la tienda</a></section>`;
    ui.tabs.innerHTML = "";
    return;
  }
  ui.track.innerHTML = catalog.brands.map((b, i) => {
    const rows = shelfRows(b.products, max);
    // Mismo ancho de lugar en todos los estantes de la marca.
    const slots = Math.max(...rows.map((r) => r.reduce((n, p) => n + Math.min(p.variants.length, max), 0)));
    const available = b.products.filter(productAvailable).length;
    return `
      <section class="y-gondola" id="g-${b.key}" data-index="${i}" aria-label="${escapeHtml(b.name)}" aria-roledescription="góndola">
        <header class="y-gondola-head">
          <h2>${escapeHtml(b.name)}</h2>
          <p>${b.products.length} ${b.products.length === 1 ? "yerba" : "yerbas"}${available < b.products.length ? ` · ${b.products.length - available} agotada${b.products.length - available === 1 ? "" : "s"}` : ""}</p>
        </header>
        <div class="y-shelves" style="--slots:${Math.max(slots, max >= 9 ? 1 : max)}">
          ${rows.map((row) => `<div class="y-shelf">${row.map((p) => itemHtml(b, p)).join("")}</div>`).join("")}
        </div>
      </section>`;
  }).join("");

  ui.tabs.innerHTML = catalog.brands.map((b, i) =>
    `<button type="button" class="y-tab" data-index="${i}" aria-controls="g-${b.key}">${escapeHtml(b.name)}</button>`).join("");

  wirePackImages(ui.track);
  renderBadges();
  setCurrent(Math.min(current, catalog.brands.length - 1), { scroll: true, instant: true });
}

function gondolas() { return [...ui.track.querySelectorAll(".y-gondola[data-index]")]; }

function setCurrent(i, { scroll = false, instant = false } = {}) {
  const list = gondolas();
  if (!list.length) return;
  current = Math.max(0, Math.min(i, list.length - 1));
  ui.tabs.querySelectorAll(".y-tab").forEach((t, k) => {
    const on = k === current;
    t.classList.toggle("active", on);
    if (on) t.setAttribute("aria-current", "true"); else t.removeAttribute("aria-current");
    if (on) t.scrollIntoView({ block: "nearest", inline: "center", behavior: instant ? "instant" : "smooth" });
  });
  ui.prev.hidden = current === 0;
  ui.next.hidden = current === list.length - 1;
  if (scroll) ui.track.scrollTo({ left: list[current].offsetLeft, behavior: instant ? "instant" : "smooth" });
}

ui.tabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".y-tab");
  if (tab) setCurrent(Number(tab.dataset.index), { scroll: true });
});
ui.prev.addEventListener("click", () => setCurrent(current - 1, { scroll: true }));
ui.next.addEventListener("click", () => setCurrent(current + 1, { scroll: true }));

// Al deslizar, la marca activa sigue a la góndola visible.
let scrollTimer = null;
ui.track.addEventListener("scroll", () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    const w = ui.track.clientWidth || 1;
    const i = Math.round(ui.track.scrollLeft / w);
    if (i !== current) { setCurrent(i); ui.hint.classList.add("is-gone"); }
  }, 80);
}, { passive: true });

ui.track.addEventListener("click", (e) => {
  const item = e.target.closest(".y-item");
  if (!item) return;
  const product = catalog.products.find((p) => p.id === Number(item.dataset.product));
  if (product) openProduct(product, item);
});

// Cambio de ancho: se rearman las filas (3 por estante en celular, más en pantallas grandes).
let lastPerRow = null;
window.addEventListener("resize", () => {
  if (!catalog) return;
  const n = perRow();
  if (n !== lastPerRow) { lastPerRow = n; renderAisle(); }
  else setCurrent(current, { scroll: true, instant: true });
});

// Cuántas unidades de cada producto hay en el carrito (insignia sobre el paquete).
// Cuántas unidades de cada presentación hay en el carrito (sobre su paquete).
function renderBadges() {
  if (!catalog) return;
  ui.track.querySelectorAll(".y-variant[data-variant]").forEach((v) => {
    const n = basket.qty(Number(v.dataset.variant));
    const badge = v.querySelector(".y-item-badge");
    badge.hidden = n === 0;
    badge.textContent = n;
    v.classList.toggle("in-cart", n > 0);
  });
}

// ---------------------------------------------------------------------
// Hojas (presentaciones y carrito)
// ---------------------------------------------------------------------
function showSheet(sheet) {
  if (openSheet && openSheet !== sheet) hideSheet(openSheet, { restoreFocus: false });
  lastFocus = lastFocus ?? document.activeElement;
  openSheet = sheet;
  sheet.hidden = false;
  ui.scrim.hidden = false;
  document.documentElement.classList.add("y-locked");
  requestAnimationFrame(() => {
    sheet.classList.add("open");
    ui.scrim.classList.add("open");
    (sheet.querySelector("[data-autofocus]") ?? sheet).focus({ preventScroll: true });
  });
}

function hideSheet(sheet = openSheet, { restoreFocus = true } = {}) {
  if (!sheet || sheet.hidden) return;
  sheet.classList.remove("open");
  ui.scrim.classList.remove("open");
  const done = () => { if (!sheet.classList.contains("open")) sheet.hidden = true; };
  setTimeout(done, 260);
  if (openSheet === sheet) {
    openSheet = null;
    ui.scrim.hidden = true;
    document.documentElement.classList.remove("y-locked");
    if (restoreFocus && lastFocus?.focus) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
}

ui.scrim.addEventListener("click", () => hideSheet());
document.addEventListener("keydown", (e) => {
  if (!openSheet || document.getElementById("accountModal")?.classList.contains("open")) return;
  if (e.key === "Escape") { e.preventDefault(); hideSheet(); }
  if (e.key === "Tab") {
    const f = [...openSheet.querySelectorAll("button:not([disabled]), a[href], input")].filter((el) => el.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
    else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
  }
});

const closeBtn = `<button type="button" class="y-sheet-close" data-close aria-label="Cerrar">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" width="18" height="18" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;

function stepperHtml(value, max, label) {
  return `
    <div class="y-stepper" role="group" aria-label="${escapeHtml(label)}">
      <button type="button" data-step="-1" aria-label="Quitar uno" ${value <= 0 ? "disabled" : ""}>−</button>
      <output aria-live="polite">${value}</output>
      <button type="button" data-step="1" aria-label="Agregar uno" ${value >= max ? "disabled" : ""}>+</button>
    </div>`;
}

// ---------- Presentaciones de un paquete ----------
function openProduct(product) {
  const chosen = new Map();   // variantId → cantidad elegida en esta hoja
  track("product_view", { path: "/yerbas", productId: product.id });

  function room(v) {
    const inCart = basket.qty(v.id);
    const cap = MAX_PER_PRESENTATION - inCart;
    return Math.max(0, v.stock === null ? cap : Math.min(v.stock - inCart, cap));
  }

  function render() {
    const total = [...chosen].reduce((s, [id, n]) => s + n * catalog.byVariant.get(id).variant.price, 0);
    const units = [...chosen.values()].reduce((a, b) => a + b, 0);
    const out = !productAvailable(product);
    ui.productSheet.innerHTML = `
      <div class="y-sheet-grip" aria-hidden="true"></div>
      ${closeBtn}
      <div class="y-sheet-head">
        <span class="y-sheet-pack">${packHtml(product, { size: "y-pack--lg" })}</span>
        <div>
          ${product.brand ? `<p class="y-sheet-kicker">${escapeHtml(product.brand)}</p>` : ""}
          <h2 id="productSheetTitle">${escapeHtml(product.name)}</h2>
          <p class="y-sheet-sub">${out ? "Por ahora no hay stock de esta yerba." : "Elegí presentación y cantidad."}</p>
        </div>
      </div>
      <ul class="y-presentations">
        ${product.variants.map((v) => {
          const inCart = basket.qty(v.id);
          const n = chosen.get(v.id) ?? 0;
          const max = room(v);
          const vOut = !isAvailable(v);
          return `
            <li class="y-pres${vOut ? " is-out" : ""}" data-variant="${v.id}">
              <div class="y-pres-info">
                <strong>${escapeHtml(v.label)}</strong>
                <span class="y-pres-price">${money(v.price)}</span>
                <span class="y-pres-stock${vOut ? " is-out" : v.stock !== null && v.stock <= 3 ? " is-low" : ""}">${escapeHtml(availabilityText(v))}${inCart ? ` · ${inCart} en tu carrito` : ""}</span>
              </div>
              ${vOut ? "" : stepperHtml(n, max, `Cantidad de ${v.label}`)}
            </li>`;
        }).join("")}
      </ul>
      <button type="button" class="y-btn-primary y-sheet-cta" data-add ${units ? "" : "disabled"} data-autofocus>
        ${units ? `Agregar ${units} al carrito · ${money(total)}` : out ? "Sin stock" : "Elegí una cantidad"}
      </button>`;
    wirePackImages(ui.productSheet);
  }

  ui.productSheet.onclick = (e) => {
    if (e.target.closest("[data-close]")) return hideSheet();
    const step = e.target.closest("[data-step]");
    if (step) {
      const id = Number(step.closest("[data-variant]").dataset.variant);
      const v = catalog.byVariant.get(id).variant;
      const next = Math.max(0, Math.min((chosen.get(id) ?? 0) + Number(step.dataset.step), room(v)));
      if (next) chosen.set(id, next); else chosen.delete(id);
      render();
      ui.productSheet.querySelector(`[data-variant="${id}"] [data-step="${step.dataset.step}"]`)?.focus();
      return;
    }
    if (e.target.closest("[data-add]")) {
      let units = 0;
      for (const [id, n] of chosen) {
        basket.add(id, n);
        units += n;
        track("add_to_cart", { path: "/yerbas", productId: product.id });
      }
      if (!units) return;
      hideSheet();
      bumpCart();
      showToast(units === 1 ? "Agregaste 1 paquete al carrito" : `Agregaste ${units} paquetes al carrito`);
    }
  };

  render();
  showSheet(ui.productSheet);
}

// ---------- Carrito visual ----------
function cartLines() {
  return basket.lines()
    .map((l) => ({ ...l, ...catalog?.byVariant.get(l.variant_id) }))
    .filter((l) => l.product);
}

function renderDock() {
  const lines = catalog ? cartLines() : [];
  const units = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.variant.price, 0);
  ui.count.textContent = units;
  ui.dock.classList.toggle("has-items", units > 0);
  ui.total.textContent = units ? money(total) : "Tu carrito";
  ui.dock.setAttribute("aria-label", units ? `Carrito: ${units} ${units === 1 ? "paquete" : "paquetes"}, ${money(total)}` : "Carrito vacío");
  // Paquetitos dentro del carrito (hasta 12): se llena a medida que se agrega.
  const minis = [];
  for (const l of lines) for (let i = 0; i < l.qty && minis.length < 12; i++) minis.push(l.product);
  ui.dock.style.setProperty("--fill", String(Math.min(units, 12) / 12));
  ui.load.innerHTML = minis.map((p, i) =>
    p.shelfImage
      ? `<span class="y-mini y-mini--shelf" style="--i:${i}"><img src="${escapeHtml(optimizedSrc(p.shelfImage, 128))}" alt="" decoding="async"></span>`
      : `<span class="y-mini" style="--label:${labelColor(p)};--i:${i}">${p.image ? `<img src="${escapeHtml(optimizedSrc(p.image, 128))}" alt="" decoding="async">` : ""}</span>`).join("");
}

function bumpCart() {
  ui.dock.classList.remove("bump");
  void ui.dock.offsetWidth;
  ui.dock.classList.add("bump");
  ui.load.lastElementChild?.classList.add("drop");
}

ui.dock.addEventListener("click", () => openCart());

async function ensureProfile() {
  if (!hasStoredSession()) return null;
  const owner = basket.owner;
  if (profile && profileFor === owner) return profile;
  try {
    const api = await import("./api.js");
    const p = await api.getProfilePhone(owner);
    profile = { phone: p?.phone ?? null, firstName: p?.first_name ?? "" };
    profileFor = owner;
  } catch (err) {
    console.warn(err);
    profile = { phone: null };
    profileFor = owner;
  }
  return profile;
}

let cartMessage = null;   // { text, ok }
let lastOrder = null;     // pedido recién enviado (pantalla de confirmación)

function openCart() {
  basket.syncOwner();
  lastOrder = null;
  cartMessage = null;
  renderCartSheet();
  showSheet(ui.cartSheet);
  if (hasStoredSession()) ensureProfile().then(() => { if (openSheet === ui.cartSheet) renderCartSheet(); });
}

function renderCartSheet() {
  if (lastOrder) return renderOrderSent();
  const lines = cartLines();
  const units = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.variant.price, 0);
  const signedIn = hasStoredSession();
  const needsPhone = signedIn && profile && !profile.phone;
  const phoneValue = ui.cartSheet.querySelector("[name=phone]")?.value ?? "";

  ui.cartSheet.innerHTML = `
    <div class="y-sheet-grip" aria-hidden="true"></div>
    ${closeBtn}
    <h2 id="cartSheetTitle" class="y-cart-title">Tu pedido de yerbas</h2>
    ${units ? `
      <p class="y-sheet-sub">${units} ${units === 1 ? "paquete" : "paquetes"}</p>
      <ul class="y-lines">
        ${lines.map((l) => {
          const max = l.variant.stock === null ? MAX_PER_PRESENTATION : Math.min(l.variant.stock, MAX_PER_PRESENTATION);
          return `
            <li class="y-line" data-variant="${l.variant_id}">
              <span class="y-line-pack">${packHtml(l.product, { size: "y-pack--xs" })}</span>
              <div class="y-line-info">
                <strong>${escapeHtml(l.product.name)}</strong>
                <span>${escapeHtml(l.variant.label)} · ${money(l.variant.price)}</span>
                ${l.qty >= max && l.variant.stock !== null ? `<small class="y-line-max">No hay más disponibles</small>` : ""}
              </div>
              <div class="y-line-side">
                ${stepperHtml(l.qty, max, `Cantidad de ${l.product.name} ${l.variant.label}`)}
                <span class="y-line-total">${money(l.qty * l.variant.price)}</span>
                <button type="button" class="y-line-remove" data-remove aria-label="Quitar ${escapeHtml(l.product.name)} ${escapeHtml(l.variant.label)}">Quitar</button>
              </div>
            </li>`;
        }).join("")}
      </ul>
      <div class="y-total"><span>Total</span><strong>${money(total)}</strong></div>
      ${needsPhone ? `
        <label class="y-phone">
          <span>Teléfono para coordinar el pedido</span>
          <input type="tel" name="phone" inputmode="tel" autocomplete="tel" maxlength="25" placeholder="Ej.: 11 5555-1234" value="${escapeHtml(phoneValue)}">
          <small>Lo guardamos en tu cuenta para próximos pedidos.</small>
        </label>` : ""}
      <p class="y-msg${cartMessage?.ok ? " ok" : ""}" role="alert" ${cartMessage ? "" : "hidden"}>${escapeHtml(cartMessage?.text ?? "")}</p>
      <button type="button" class="y-btn-primary y-send" data-send ${sending ? "disabled" : ""} data-autofocus>
        ${sending ? "Enviando…" : signedIn ? `${WA_ICON} Enviar pedido por WhatsApp` : "Ingresá para enviar el pedido"}
      </button>
      <p class="y-fineprint">${signedIn
        ? "Es una solicitud: te confirmamos disponibilidad, entrega y pago por WhatsApp. Reservamos tus paquetes por 24 horas."
        : "Para pedir yerbas necesitás una cuenta (así reservamos tus paquetes y te avisamos). Tu carrito se guarda."}</p>`
    : `
      <div class="y-cart-empty">
        <p>Tu carrito está vacío.</p>
        <p class="y-sheet-sub">Tocá un paquete de la góndola para elegir presentación y cantidad.</p>
        <button type="button" class="y-btn-ghost" data-close data-autofocus>Ver la góndola</button>
      </div>`}`;
  wirePackImages(ui.cartSheet);
}

const WA_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3a.5.5 0 0 0 0-.4l-.8-1.9c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.1.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.2c0-.2-.2-.3-.5-.4z"/></svg>`;

function renderOrderSent() {
  const o = lastOrder;
  ui.cartSheet.innerHTML = `
    <div class="y-sheet-grip" aria-hidden="true"></div>
    ${closeBtn}
    <div class="y-sent">
      <span class="y-sent-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5L20 7"/></svg></span>
      <h2 id="cartSheetTitle">¡Pedido #${escapeHtml(String(o.id))} enviado!</h2>
      <p>Lo reservamos por 24 horas. Te confirmamos disponibilidad, entrega y pago por WhatsApp.</p>
      <a class="y-btn-primary" href="${escapeHtml(o.url)}" target="_blank" rel="noopener">${WA_ICON} Abrir WhatsApp</a>
      <a class="y-btn-ghost" href="/cuenta?seccion=pedidos">Ver mis pedidos</a>
      <button type="button" class="y-link" data-close data-autofocus>Seguir mirando</button>
    </div>`;
}

ui.cartSheet.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) return hideSheet();
  const line = e.target.closest("[data-variant]");
  const step = e.target.closest("[data-step]");
  if (line && step) {
    const id = Number(line.dataset.variant);
    const v = catalog.byVariant.get(id)?.variant;
    const max = v?.stock === null ? MAX_PER_PRESENTATION : Math.min(v?.stock ?? 0, MAX_PER_PRESENTATION);
    const next = Math.max(0, Math.min(basket.qty(id) + Number(step.dataset.step), max));
    cartMessage = null;
    basket.set(id, next);
    ui.cartSheet.querySelector(`[data-variant="${id}"] [data-step="${step.dataset.step}"]`)?.focus();
    return;
  }
  if (line && e.target.closest("[data-remove]")) {
    cartMessage = null;
    basket.remove(Number(line.dataset.variant));
    return;
  }
  if (e.target.closest("[data-send]")) sendOrder();
});

// ---------------------------------------------------------------------
// Envío: registra el pedido en Supabase y abre WhatsApp
// ---------------------------------------------------------------------
function setMessage(text, ok = false) {
  cartMessage = text ? { text, ok } : null;
  renderCartSheet();
}

function whatsappText(order) {
  const lines = (order.items ?? []).map((i) =>
    `• ${i.product_name}${i.variant_name ? ` ${i.variant_name}` : ""} x${i.quantity} — ${money(i.line_total)}`);
  return [
    `Hola! Te envío mi pedido de yerbas #${order.id}:`,
    "",
    ...lines,
    "",
    `Total: ${money(order.total)}`,
    "",
    "Es una solicitud: quedo a la espera de la confirmación. ¡Gracias!",
  ].join("\n");
}

async function sendOrder() {
  if (sending) return;
  // La sesión cambió (otra pestaña, el panel): primero se muestra el carrito correcto.
  if (basket.syncOwner()) return setMessage("La sesión cambió en este navegador. Revisá el carrito antes de enviar.");
  const lines = basket.lines();
  if (!lines.length) return;

  if (!hasStoredSession()) {
    pendingCheckout = true;
    hideSheet();
    document.dispatchEvent(new CustomEvent("povmatero:account-login", { detail: { mode: "login" } }));
    return;
  }

  // Teléfono: el del perfil o el que se escribe acá.
  if (!profile) await ensureProfile();
  const input = ui.cartSheet.querySelector("[name=phone]");
  const phone = input?.value.trim() ?? "";
  if (profile && !profile.phone) {
    if (!input) return renderCartSheet();
    const digits = phone.replace(/\D/g, "");
    if (!/^\+?[\d\s().\/-]{8,30}$/.test(phone) || digits.length < 8 || digits.length > 15) {
      setMessage("Escribí un teléfono válido (entre 8 y 15 números) para coordinar el pedido.");
      ui.cartSheet.querySelector("[name=phone]")?.focus();
      return;
    }
  }

  track("begin_checkout", { path: "/yerbas" });
  // La pestaña de WhatsApp se abre ya (si se abre después de esperar, el
  // navegador la bloquea) y se completa al tener el número de pedido.
  const win = window.open("", "_blank");
  try { win?.document.write("<title>WhatsApp</title><p style=\"font-family:sans-serif;padding:24px\">Registrando tu pedido…</p>"); } catch { /* nada */ }

  sending = true;
  cartMessage = null;
  renderCartSheet();
  const owner = basket.owner;
  let api;
  try {
    api = await import("./api.js");
    const session = await api.getSession();
    if (!session || session.user.id !== owner) throw Object.assign(new Error("La sesión cambió."), { hint: "owner_changed" });
    const order = await withTimeout(api.createYerbaOrder(lines, profile?.phone ? null : phone), 12000);
    if (profile && !profile.phone) profile.phone = phone;
    const url = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(whatsappText(order))}`;
    if (win && !win.closed) {
      try { win.opener = null; } catch { /* nada */ }
      win.location.href = url;
    }
    basket.clear();
    lastOrder = { id: order.id, url };
    sending = false;
    renderCartSheet();
    if (!win || win.closed) window.open(url, "_blank");
    refreshCatalog();
  } catch (err) {
    console.warn("Pedido de yerbas:", err);
    try { win?.close(); } catch { /* nada */ }
    sending = false;
    if (err?.hint === "owner_changed") {
      basket.syncOwner();
      return setMessage("La sesión cambió en este navegador. Revisá el carrito antes de enviar.");
    }
    const message = api ? api.orderErrorMessage(err) : "No pudimos conectarnos. Revisá tu internet e intentá de nuevo.";
    if (err?.hint === "phone_required" && profile) profile.phone = null;
    setMessage(message);
    // Sin stock o producto despublicado: se actualiza la góndola y el carrito.
    if (err?.hint === "insufficient_stock" || err?.hint === "unavailable") {
      await refreshCatalog();
      setMessage(message + " Ajustamos tu carrito a lo disponible.");
    }
  }
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => { t = setTimeout(() => reject(new Error("timeout")), ms); })])
    .finally(() => clearTimeout(t));
}

// ---------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------
async function refreshCatalog() {
  try {
    catalog = await loadYerbas();
  } catch (err) {
    console.warn("Yerbas: no se pudo actualizar.", err);
    return;
  }
  lastPerRow = perRow();
  renderAisle();
  const changes = basket.reconcile(catalog);
  renderDock();
  if (changes.length && openSheet !== ui.cartSheet) {
    showToast("Actualizamos tu carrito según el stock disponible.");
  }
}

async function start() {
  initAccount();
  // Desde el modal de cuenta («Mi cuenta», «Mis pedidos») se va a la tienda.
  document.addEventListener("povmatero:navigate", (e) => {
    const path = e.detail?.path;
    if (typeof path === "string" && path.startsWith("/")) location.href = path;
  });
  renderDock();
  track("page_view", { path: "/yerbas" });

  try {
    catalog = await loadYerbas();
  } catch (err) {
    console.error(err);
    ui.track.removeAttribute("aria-busy");
    ui.track.innerHTML = `<section class="y-gondola y-empty"><p>No pudimos cargar las yerbas. Probá recargar la página en unos minutos.</p><button type="button" class="y-btn-ghost" onclick="location.reload()">Reintentar</button></section>`;
    return;
  }
  lastPerRow = perRow();
  renderAisle();
  const changes = basket.reconcile(catalog);
  renderDock();
  if (changes.length) showToast("Actualizamos tu carrito según el stock disponible.");

  // Al volver a la pestaña después de un rato, el stock se actualiza.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60000 && !sending) refreshCatalog();
  });
}

start();
