// /yerbas: góndolas por marca, presentaciones de cada paquete, carrito visual
// y envío del pedido (se registra en Supabase y se abre WhatsApp).
//
// Datos: js/yerbas/catalog.js (stock = disponible). Carrito: js/yerbas/basket.js
// (uno por invitado y uno por cuenta). Pedido: js/yerbas/api.js (se carga al enviar).
import { loadYerbas, productAvailable, isAvailable, availabilityText, shelfImageFor, OTHER_BRANDS } from "./catalog.js";
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
  if (ownerChanged) { profile = null; profileFor = null; loadRestockAlerts(); }
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

// Un paquete (góndola, ficha, carrito). Imagen, en este orden:
//   1. la de la presentación (product_variants.shelf_image), si se pasa «variant»;
//   2. la general del producto (products.shelf_image);
//   3. paquete genérico (2:3) con la foto del catálogo como frente o, si
//      tampoco hay, con la marca y el nombre sobre una banda de color.
// Las imágenes de góndola son PNG verticales 2:3: se muestran enteras
// (object-fit: contain), sin recortar ni deformar. La foto del catálogo nunca
// se modifica: solo se reutiliza en el genérico.
function packHtml(product, { variant = null, size = "", src = undefined } = {}) {
  const image = src === undefined ? shelfImageFor(product, variant) : src;
  if (image) {
    return `
      <span class="y-pack y-pack--shelf ${size}" data-pack-of="${product.id}" data-size="${escapeHtml(size)}">
        <img class="y-pack-img" src="${escapeHtml(optimizedSrc(image, PACK_WIDTH))}" alt="" loading="lazy" decoding="async" crossorigin="anonymous" data-src="${escapeHtml(image)}">
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
    // Si una imagen de góndola no carga (tampoco la original): la de la
    // presentación cae a la general del producto y la general, al genérico.
    // (Se escucha antes que withFallback: el primer error es el de la versión
    // optimizada, que withFallback reintenta con la original.)
    if (pack?.classList.contains("y-pack--shelf")) {
      img.addEventListener("error", () => {
        const original = img.dataset.originalSrc;
        if (original && img.getAttribute("src") !== original) return;   // withFallback reintenta
        const product = catalog?.products.find((p) => p.id === Number(pack.dataset.packOf));
        if (!product) return;
        const failed = img.dataset.src;
        const next = product.shelfImage && product.shelfImage !== failed ? product.shelfImage : null;
        const holder = pack.parentElement;
        pack.outerHTML = packHtml(product, { size: pack.dataset.size, src: next });
        if (holder) wirePackImages(holder);
      });
    }
    withFallback(img, img.dataset.src);
    if (pack?.classList.contains("y-pack--shelf")) {
      const apply = () => { const t = bottomTrim(img); if (t) pack.style.setProperty("--trim", `${t}%`); };
      if (img.complete && img.naturalWidth) apply(); else img.addEventListener("load", apply, { once: true });
    }
    const loaded = () => pack?.classList.add("is-loaded");
    if (img.complete && img.naturalWidth) loaded(); else img.addEventListener("load", loaded, { once: true });
  });
}

// Cuánto hay que bajar la imagen para que la base VISIBLE del envase apoye en
// el estante: se mide el margen transparente de abajo del PNG (en % del alto
// del lugar 2:3). No modifica la imagen ni depende de que venga recortada.
// Si no se puede leer (sin CORS), no se corrige: se ve como antes.
const trimCache = new Map();
function bottomTrim(img) {
  const key = img.dataset.src;
  if (trimCache.has(key)) return trimCache.get(key);
  let value = 0;
  try {
    const w = 24, h = Math.max(1, Math.round(w * img.naturalHeight / img.naturalWidth));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let empty = 0;
    for (let y = h - 1; y >= 0; y--) {
      let solid = false;
      for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] > 24) { solid = true; break; }
      if (solid) break;
      empty++;
    }
    // Alto de la imagen dentro del lugar 2:3 (contain): si es más ancha que 2:3, ocupa menos alto.
    const shown = Math.min(1, (2 / 3) / (img.naturalWidth / img.naturalHeight));
    value = Math.min(20, Math.round((empty / h) * shown * 1000) / 10);
  } catch { value = 0; }
  trimCache.set(key, value);
  return value;
}

// ---------------------------------------------------------------------
// Góndolas
// ---------------------------------------------------------------------
// Medidas de la góndola según el ancho: W = ancho de un paquete de 1 kg;
// gap = separación entre yerbas distintas (las presentaciones de una misma
// yerba van juntas, superpuestas, sin esa separación).
function shelfLayout() {
  const w = ui.track.clientWidth || window.innerWidth;
  if (w >= 1500) return { key: "xxl", W: 120, gap: 40 };
  if (w >= 1100) return { key: "xl", W: 108, gap: 32 };
  if (w >= 820) return { key: "lg", W: 108, gap: 34 };
  if (w >= 560) return { key: "md", W: 100, gap: 28 };
  return { key: "sm", W: 92, gap: 22 };
}

// Composición de un grupo de dos: el de menos gramos adelante (más chico) y el
// otro detrás, apenas elevado y corrido en diagonal. La superposición es leve
// (≈ un cuarto del paquete de atrás), así se ven los dos enteros.
const FRONT_SCALE = 0.82;      // 500 g frente a 1 kg
const FRONT_LEFT = 0.74;       // dónde empieza el de adelante, en anchos de W
const groupUnits = (n) => (n === 1 ? 1 : n === 2 ? FRONT_LEFT + FRONT_SCALE : 1 + (n - 1) * 0.66);
const shown = (p) => Math.min(p.variants.length, 4);
// Una presentación de menos de 1 kg (500 g) va siempre a su escala, aunque
// esté sola en el estante: nunca se ve del tamaño de un paquete de 1 kg.
const soloScale = (v) => (v?.grams && v.grams < 1000 ? FRONT_SCALE : 1);
const itemUnits = (p) => (shown(p) === 1 ? soloScale(p.variants[0]) : groupUnits(shown(p)));

// Margen interno del contenedor de la góndola (--wrap-pad en yerbas.css).
function wrapPad() {
  if (window.matchMedia("(min-width: 1024px)").matches) return 40;
  if (window.matchMedia("(min-width: 640px)").matches) return 24;
  return 0;
}

// Reparte las yerbas en estantes por ancho real, sin separar las
// presentaciones de una yerba, con estantes parejos.
function shelfRows(products, layout) {
  // Ancho útil: el del contenedor (.y-shelves: 90 % menos su margen interno)
  // menos el margen de cada estante (6 px por lado).
  const avail = Math.max(layout.W * 2, (ui.track.clientWidth || window.innerWidth) * 0.9 - wrapPad() * 2 - 12);
  const width = (p) => itemUnits(p) * layout.W;
  const total = products.reduce((s, p) => s + width(p), 0) + layout.gap * (products.length - 1);
  const target = total / Math.max(1, Math.ceil(total / avail));
  const rows = [[]];
  let used = 0;
  for (const p of products) {
    const add = width(p) + (used ? layout.gap : 0);
    if (used && (used + add > avail || used >= target - layout.W * 0.3)) { rows.push([]); used = 0; }
    rows.at(-1).push(p);
    used += width(p) + (rows.at(-1).length > 1 ? layout.gap : 0);
  }
  return rows;
}

// Orden visual del grupo: atrás el más grande, adelante el más chico.
function groupOrder(p) {
  const list = p.variants.slice(0, 4);
  if (list.length < 2) return list;
  return [...list].sort((a, b) => (b.grams ?? 0) - (a.grams ?? 0));
}

function variantLabel(p, v) {
  return `${p.name} ${v.label}, ${isAvailable(v) ? money(v.price) : "agotado"}`;
}

function itemHtml(brand, p) {
  const out = !productAvailable(p);
  const name = brand.name === OTHER_BRANDS ? p.name : shortName(p);
  const order = groupOrder(p);
  const n = order.length;
  const big = order[0];
  return `
    <div class="y-item y-item--n${Math.min(n, 3)}${out ? " is-out" : ""}" data-product="${p.id}" style="--units:${itemUnits(p)}">
      <div class="y-group">
        ${order.map((v, i) => {
          const vOut = !isAvailable(v);
          // En un grupo de dos, el más chico (adelante) se dibuja a escala.
          // Sola, una de 500 g también va a escala (más chica que una de 1 kg sola).
          const scale = n === 1 ? soloScale(v) : n === 2 && i === 1 && (v.grams ?? 0) < (big.grams ?? 0) ? FRONT_SCALE : n === 2 && i === 1 ? 0.92 : 1;
          const role = n === 1 ? "solo" : i === 0 ? "back" : i === n - 1 ? "front" : "mid";
          return `
            <button type="button" class="y-variant y-variant--${role}${vOut ? " is-out" : ""}" data-variant="${v.id}"
              style="--scale:${scale};--i:${i}" aria-label="${escapeHtml(variantLabel(p, v))}">
              <span class="y-variant-pack">${packHtml(p, { variant: v })}${vOut ? `<span class="y-out-tag">Agotado</span>` : ""}<span class="y-item-badge" hidden></span></span>
            </button>`;
        }).join("")}
      </div>
      <div class="y-tags" aria-hidden="true">
        ${order.map((v, i) => {
          const role = n === 1 ? "solo" : i === 0 ? "back" : i === n - 1 ? "front" : "mid";
          return `<span class="y-tag y-tag--${role}${isAvailable(v) ? "" : " is-out"}" data-variant="${v.id}"><span class="y-tag-size">${escapeHtml(v.label)}</span><span class="y-tag-price">${isAvailable(v) ? money(v.price) : "Agotado"}</span></span>`;
        }).join("")}
      </div>
      <button type="button" class="y-item-meta" data-open tabindex="-1" aria-hidden="true">
        <span class="y-item-name">${escapeHtml(name)}</span>
      </button>
    </div>`;
}

// Variedades de una marca: productos distintos (por id), no presentaciones.
// Serena 500 g y Serena 1 kg son una sola variedad. Incluye las agotadas.
function varietiesText(brand) {
  const n = new Set(brand.products.map((p) => p.id)).size;
  return `${n} ${n === 1 ? "variedad" : "variedades"}`;
}

function renderAisle() {
  const layout = shelfLayout();
  ui.track.removeAttribute("aria-busy");
  if (!catalog.brands.length) {
    ui.track.innerHTML = `<section class="y-gondola y-empty"><p>Por ahora no hay yerbas publicadas. Volvé pronto.</p><a class="y-btn-ghost" href="/">Ir a la tienda</a></section>`;
    ui.tabs.innerHTML = "";
    return;
  }
  ui.track.innerHTML = catalog.brands.map((b, i) => {
    const rows = shelfRows(b.products, layout);
    return `
      <section class="y-gondola" id="g-${b.key}" data-index="${i}" aria-label="${escapeHtml(b.name)}" aria-roledescription="góndola">
        <header class="y-gondola-head">
          <h2>${escapeHtml(b.name)}</h2>
          <p>${varietiesText(b)}</p>
        </header>
        <div class="y-shelves" style="--pack-w:${layout.W}px;--group-gap:${layout.gap}px"${layout.W < 105 ? ' data-tags="stack"' : ""}>
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

// Tocar o hacer clic en un paquete: reacciona todo el grupo de esa yerba.
// (Solo visual: no cambia qué presentación se eligió ni cómo abre la ficha.)
let pressedGroup = null;
let pressedAt = 0;
function releaseGroup() {
  const group = pressedGroup;
  if (!group) return;
  pressedGroup = null;
  setTimeout(() => group.classList.remove("is-pressed"), Math.max(0, 140 - (Date.now() - pressedAt)));
}
ui.track.addEventListener("pointerdown", (e) => {
  const group = e.target.closest(".y-variant")?.closest(".y-group");
  if (!group) return;
  pressedGroup = group;
  pressedAt = Date.now();
  group.classList.add("is-pressed");
}, { passive: true });
for (const type of ["pointerup", "pointercancel", "pointerleave"]) ui.track.addEventListener(type, releaseGroup, { passive: true });
ui.track.addEventListener("scroll", releaseGroup, { passive: true });   // deslizar entre marcas no deja el grupo hundido

ui.track.addEventListener("click", (e) => {
  const item = e.target.closest(".y-item");
  if (!item) return;
  const product = catalog.products.find((p) => p.id === Number(item.dataset.product));
  if (!product) return;
  const variant = e.target.closest(".y-variant[data-variant]");
  openProduct(product, { focusVariant: variant ? Number(variant.dataset.variant) : null });
});

// Cambio de ancho: se rearman las filas (3 por estante en celular, más en pantallas grandes).
let lastPerRow = null;
window.addEventListener("resize", () => {
  if (!catalog) return;
  const n = shelfLayout().key + ":" + Math.round((ui.track.clientWidth || 0) / 40);
  if (n !== lastPerRow) { lastPerRow = n; renderAisle(); }
  else setCurrent(current, { scroll: true, instant: true });
});

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
  if (!openSheet || document.querySelector(".account-modal.open")) return;
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

// Aviso cuando el carrito ya tiene todo lo que se puede pedir de una
// presentación. Solo si se llegó al límite agregando (qty > 0): una
// presentación que ya estaba agotada muestra «Agotado», no esto.
const ALL_STOCK_TEXT = "Ya agregaste todo el stock disponible.";
function limitNote(qty, variant) {
  if (qty <= 0) return "";
  if (variant.stock !== null && variant.stock > 0 && qty >= variant.stock && variant.stock <= MAX_PER_PRESENTATION) {
    return `<small class="y-line-max">${ALL_STOCK_TEXT}</small>`;
  }
  if (qty >= MAX_PER_PRESENTATION) return `<small class="y-line-max">Máximo ${MAX_PER_PRESENTATION} por presentación en cada pedido.</small>`;
  return "";
}

function stepperHtml(value, max, label) {
  return `
    <div class="y-stepper" role="group" aria-label="${escapeHtml(label)}">
      <button type="button" data-step="-1" aria-label="Quitar uno" ${value <= 0 ? "disabled" : ""}>−</button>
      <output aria-live="polite">${value}</output>
      <button type="button" data-step="1" aria-label="Agregar uno" ${value >= max ? "disabled" : ""}>+</button>
    </div>`;
}

// ---------- Avisos de reposición («Avisarme cuando vuelva») ----------
// Un aviso por presentación agotada (si se repone 1 kg, quien pidió 500 g no
// figura). Requiere cuenta. Si la base todavía no tiene los avisos, no se
// muestra la opción.
let restockAlerts = new Set();     // presentaciones con aviso activo de esta cuenta
let restockEnabled = true;
let restockBusy = null;            // presentación que se está guardando
let pendingRestock = null;         // { product, variantId } pedido antes de ingresar

async function loadRestockAlerts() {
  restockAlerts = new Set();
  if (!hasStoredSession() || !restockEnabled) return;
  try {
    const api = await import("./api.js");
    restockAlerts = new Set(await api.listMyRestockAlerts());
  } catch (err) {
    const api = await import("./api.js").catch(() => null);
    if (api?.restockMissing(err)) restockEnabled = false;
    else console.warn("Avisos de reposición:", err);
  }
  if (pendingRestock && hasStoredSession()) {
    const { product, variantId } = pendingRestock;
    pendingRestock = null;
    if (!restockAlerts.has(variantId)) toggleRestockAlert(product, variantId, true);
  }
}

function restockHtml(v) {
  if (!restockEnabled) return "";
  const busy = restockBusy === v.id ? " disabled aria-busy=\"true\"" : "";
  if (restockAlerts.has(v.id)) {
    return `<div class="y-notify is-on">
      <span class="y-notify-state">Te avisamos cuando vuelva</span>
      <button type="button" class="y-notify-cancel" data-notify-cancel${busy}>Cancelar aviso</button>
    </div>`;
  }
  return `<button type="button" class="y-notify-btn" data-notify${busy} aria-label="Avisarme cuando vuelva ${escapeHtml(v.label)}">Avisarme cuando vuelva</button>`;
}

async function toggleRestockAlert(product, variantId, on, rerender = null) {
  const v = catalog?.byVariant.get(variantId)?.variant;
  if (!v || restockBusy) return;
  const label = `${product.name} ${v.label}`;
  if (on && !hasStoredSession()) {
    pendingRestock = { product, variantId };
    hideSheet();
    document.dispatchEvent(new CustomEvent("povmatero:account-login", { detail: { mode: "login" } }));
    return;
  }
  restockBusy = variantId;
  rerender?.();
  try {
    const api = await import("./api.js");
    if (on) {
      await api.requestRestockAlert(variantId);
      restockAlerts.add(variantId);
      showToast(`Listo: te avisamos cuando vuelva ${label}.`);
    } else {
      await api.cancelRestockAlert(variantId);
      restockAlerts.delete(variantId);
      showToast("Cancelaste el aviso.");
    }
  } catch (err) {
    console.warn("Aviso de reposición:", err);
    const api = await import("./api.js").catch(() => null);
    if (api?.restockMissing(err)) { restockEnabled = false; showToast("Los avisos de reposición todavía no están disponibles."); }
    else if (err?.hint === "available") { showToast("¡Ya hay stock! Podés pedirla ahora."); refreshCatalog(); }
    else showToast(err?.hint && err?.message ? err.message : "No pudimos guardar el aviso. Intentá de nuevo.");
  } finally {
    restockBusy = null;
    rerender?.();
  }
}

// ---------- Presentaciones de un paquete ----------
function openProduct(product, { focusVariant = null } = {}) {
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
            <li class="y-pres${vOut ? " is-out" : ""}${v.id === focusVariant ? " is-focus" : ""}" data-variant="${v.id}">
              <span class="y-pres-thumb" style="--scale:${packScale(product, v)}">${packHtml(product, { variant: v, size: "y-pack--xs" })}</span>
              <div class="y-pres-info">
                <strong>${escapeHtml(v.label)}</strong>
                <span class="y-pres-price">${money(v.price)}</span>
                <span class="y-pres-stock${vOut ? " is-out" : v.stock !== null && v.stock <= 3 ? " is-low" : ""}">${escapeHtml(availabilityText(v))}${inCart ? ` · ${inCart} en tu carrito` : ""}</span>
                ${vOut ? "" : limitNote(inCart, v)}
              </div>
              ${vOut ? restockHtml(v) : stepperHtml(n, max, `Cantidad de ${v.label}`)}
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
    const notify = e.target.closest("[data-notify], [data-notify-cancel]");
    if (notify) {
      const id = Number(notify.closest("[data-variant]").dataset.variant);
      toggleRestockAlert(product, id, notify.hasAttribute("data-notify"), render);
      return;
    }
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
      const added = [...chosen];
      // El carrito se dibuja al agregar; los paquetitos nuevos esperan a que
      // «llegue» la animación (ver flyToCart).
      arriving.push(...added.map(([id, n]) => [id, n]));
      for (const [id, n] of added) {
        basket.add(id, n);
        units += n;
        track("add_to_cart", { path: "/yerbas", productId: product.id });
      }
      if (!units) return;
      const sheetPack = ui.productSheet.querySelector(".y-sheet-pack .y-pack")?.getBoundingClientRect();
      hideSheet();
      flyToCart(product, added, sheetPack);
      showToast(units === 1 ? "Agregaste 1 paquete al carrito" : `Agregaste ${units} paquetes al carrito`);
    }
  };

  render();
  showSheet(ui.productSheet);
  // Tocar una presentación en la góndola la deja a mano en la ficha.
  if (focusVariant) {
    requestAnimationFrame(() => ui.productSheet.querySelector(`[data-variant="${focusVariant}"] [data-step="1"]:not([disabled])`)?.focus({ preventScroll: true }));
  }
}

// Altura relativa en miniaturas (ficha y carrito): el de menos gramos, más bajo.
function packScale(product, variant) {
  const max = Math.max(...product.variants.map((v) => v.grams ?? 0));
  if (!variant.grams || !max) return 1;
  // 500 g va a escala aunque sea la única presentación de la yerba.
  if (variant.grams >= max && variant.grams >= 1000) return 1;
  return FRONT_SCALE;
}

// ---------- Carrito visual ----------
function cartLines() {
  return basket.lines()
    .map((l) => ({ ...l, ...catalog?.byVariant.get(l.variant_id) }))
    .filter((l) => l.product);
}

// Paquetes dentro del carrito: hasta MAX_IN_CART unidades, en el orden del
// carrito, con su imagen (presentación → general → genérico) y a escala
// (500 g más chico que 1 kg). Asoman por encima de la canasta.
const MAX_IN_CART = 8;
let arriving = [];   // [variantId, unidades] que todavía «vuelan» hacia el carrito

function renderDock() {
  const lines = catalog ? cartLines() : [];
  const units = lines.reduce((n, l) => n + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.variant.price, 0);
  ui.count.textContent = units;
  ui.dock.classList.toggle("has-items", units > 0);
  ui.total.textContent = units ? money(total) : "";
  ui.dock.setAttribute("aria-label", units ? `Carrito: ${units} ${units === 1 ? "paquete" : "paquetes"}, ${money(total)}` : "Carrito vacío");
  const minis = [];
  for (const l of lines) for (let i = 0; i < l.qty && minis.length < MAX_IN_CART; i++) minis.push(l);
  ui.load.dataset.count = String(minis.length);
  ui.load.innerHTML = minis.map((l, i) =>
    `<span class="y-mini" data-variant="${l.variant_id}" style="--scale:${packScale(l.product, l.variant)};--i:${i}">${packHtml(l.product, { variant: l.variant, size: "y-pack--mini" })}</span>`).join("");
  ui.load.querySelectorAll("img").forEach((img) => img.removeAttribute("loading"));
  wirePackImages(ui.load);
  // Lo que todavía está en el aire no se ve en la canasta hasta que llega.
  for (const [id, n] of arriving) {
    const mine = [...ui.load.querySelectorAll(`.y-mini[data-variant="${id}"]`)];
    mine.slice(Math.max(0, mine.length - n)).forEach((m) => m.classList.add("is-arriving"));
  }
}

function bumpCart() {
  ui.dock.classList.remove("bump");
  void ui.dock.offsetWidth;
  ui.dock.classList.add("bump");
}

// ---------- Animación: el paquete viaja de la góndola al carrito ----------
// Una copia del paquete sale desde su lugar en la góndola (el original se
// queda) y hace un arco hasta la canasta: sube un poco y se acerca (sensación
// de profundidad) y baja achicándose. Al llegar, aparece en la canasta y el
// carrito reacciona. Solo transform/opacity (fluido) y sin capturar toques.
// Con «reducir movimiento» no hay viaje: el carrito se actualiza directo.
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const FLIGHT_MS = 680;

function flyToCart(product, added, fallbackRect) {
  const basketRect = ui.load.getBoundingClientRect();
  const canAnimate = typeof Element.prototype.animate === "function" && !reduceMotion?.matches && basketRect.width > 0;
  if (!canAnimate) {
    arriving = [];
    renderDock();
    return;
  }
  let k = 0;
  for (const [id, n] of added) {
    const variant = catalog.byVariant.get(id)?.variant;
    const copies = Math.min(n, 2);   // hasta 2 copias por presentación: se lee la cantidad sin saturar
    for (let c = 0; c < copies; c++) launch(product, variant, id, c === copies - 1, k++ * 110, fallbackRect);
  }
}

function launch(product, variant, id, last, delay, fallbackRect) {
  const source = ui.track.querySelector(`.y-variant[data-variant="${id}"] .y-pack`);
  let r = source?.getBoundingClientRect();
  const visible = r && r.width > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  if (!visible) r = fallbackRect?.width ? fallbackRect : { left: innerWidth / 2 - 40, top: innerHeight * 0.4, width: 80, height: 120 };

  const fly = document.createElement("div");
  fly.className = "y-flight";
  fly.setAttribute("aria-hidden", "true");
  fly.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  // Copia del paquete ya dibujado (no se vuelve a decodificar la imagen).
  const inner = document.createElement("div");
  inner.className = "y-flight-inner";
  if (visible) {
    const copy = source.cloneNode(true);
    copy.querySelectorAll(".y-out-tag, .y-item-badge").forEach((el) => el.remove());
    inner.append(copy);
  } else {
    inner.innerHTML = packHtml(product, { variant });
    inner.querySelectorAll("img").forEach((img) => img.removeAttribute("loading"));
  }
  fly.append(inner);
  document.body.append(fly);

  const t = ui.load.getBoundingClientRect();
  const dx = t.left + t.width / 2 - (r.left + r.width / 2);
  const dy = t.top + t.height * 0.62 - (r.top + r.height / 2);
  const end = Math.max(0.12, Math.min(0.6, 34 / r.width));
  const lift = Math.max(50, Math.min(150, Math.abs(dy) * 0.32));
  const duration = FLIGHT_MS + Math.min(160, Math.hypot(dx, dy) * 0.12);
  const timing = { duration, delay, fill: "both" };

  fly.animate([{ transform: "translateX(0)" }, { transform: `translateX(${dx}px)` }],
    { ...timing, easing: "cubic-bezier(.42,0,.48,1)" });
  // Solo transform y opacity: el navegador lo anima fuera del hilo principal,
  // así sigue fluido aunque la página esté actualizando el carrito.
  const flight = inner.animate([
    { transform: "translateY(0) scale(1) rotate(0deg)", opacity: 1 },
    { transform: `translateY(${-lift}px) scale(1.12) rotate(-7deg)`, opacity: 1, offset: 0.38, easing: "cubic-bezier(.4,0,.8,.6)" },
    { transform: `translateY(${dy}px) scale(${end}) rotate(5deg)`, opacity: 0.96 },
  ], { ...timing, easing: "cubic-bezier(.25,.1,.35,1)" });

  const done = () => { fly.remove(); land(id, last); };
  flight.finished.then(done, done);
}

function land(id, all) {
  const waiting = [...ui.load.querySelectorAll(`.y-mini.is-arriving[data-variant="${id}"]`)];
  (all ? waiting : waiting.slice(0, 1)).forEach((m) => {
    m.classList.remove("is-arriving");
    m.classList.add("drop");
  });
  const entry = arriving.find(([v]) => v === id);
  if (entry) {
    entry[1] = all ? 0 : entry[1] - 1;
    if (entry[1] <= 0) arriving = arriving.filter((e) => e !== entry);
  }
  bumpCart();
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
              <span class="y-line-pack" style="--scale:${packScale(l.product, l.variant)}">${packHtml(l.product, { variant: l.variant, size: "y-pack--line" })}</span>
              <div class="y-line-info">
                <strong>${escapeHtml(l.product.name)}</strong>
                <span>${escapeHtml(l.variant.label)} · ${money(l.variant.price)}</span>
                ${limitNote(l.qty, l.variant)}
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
      <button type="button" class="y-btn-primary y-send" data-send ${sending ? 'disabled aria-busy="true"' : ""} data-autofocus>
        ${sending ? "Realizando pedido…" : !signedIn ? "Ingresá para enviar el pedido" : sendFailed ? "Reintentar el pedido" : "Realizar pedido"}
      </button>
      <p class="y-fineprint">${signedIn
        ? "Es una solicitud: te confirmamos disponibilidad, entrega y pago por WhatsApp. Reservamos tus paquetes por 72 horas."
        : "Para pedir yerbas necesitás una cuenta (así reservamos tus paquetes y te avisamos). Tu carrito se guarda."}</p>`
    : `
      <div class="y-cart-empty">
        <p>Tu carrito está vacío.</p>
        <p class="y-sheet-sub">Tocá un paquete de la góndola para elegir presentación y cantidad.</p>
        <button type="button" class="y-btn-ghost" data-close data-autofocus>Ver la góndola</button>
      </div>`}`;
  wirePackImages(ui.cartSheet);
}

// Pantalla de éxito: solo después de que la base confirmó el pedido.
function renderOrderSent() {
  const o = lastOrder;
  ui.cartSheet.innerHTML = `
    <div class="y-sheet-grip" aria-hidden="true"></div>
    ${closeBtn}
    <div class="y-sent" role="status">
      <span class="y-sent-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5L20 7"/></svg></span>
      <h2 id="cartSheetTitle">Pedido realizado correctamente</h2>
      ${o.id ? `<p class="y-sent-number">Pedido #${escapeHtml(String(o.id))}</p>` : ""}
      <p>Reservamos tus paquetes por 72 horas. Te confirmamos disponibilidad, entrega y pago por WhatsApp.</p>
      <div class="y-sent-actions">
        <a class="y-btn-primary" href="/cuenta?seccion=pedidos" data-autofocus>Ver mis pedidos</a>
        <button type="button" class="y-btn-ghost" data-close>Volver a la góndola de yerbas</button>
        <a class="y-btn-ghost" href="/">Volver a la web</a>
      </div>
      ${o.url ? `<a class="y-link" href="${escapeHtml(o.url)}" target="_blank" rel="noopener">También podés avisarnos por WhatsApp</a>` : ""}
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

// Envío en curso guardado en esta pestaña: si se recarga la página a mitad
// del envío, al volver se busca el pedido antes de dejar enviarlo de nuevo.
const SENDING_KEY = "povmatero-yerbas-sending";
const SKEW_MS = 2 * 60 * 1000;   // margen por si el reloj del teléfono no coincide con el de la base
let sendFailed = false;

function rememberSending(value) {
  try {
    if (value) sessionStorage.setItem(SENDING_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(SENDING_KEY);
  } catch { /* sin almacenamiento: solo se pierde la recuperación tras recargar */ }
}

function orderSucceeded(order) {
  rememberSending(null);
  sendFailed = false;
  basket.clear();
  lastOrder = { id: order.id, url: order.items ? `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(whatsappText(order))}` : null };
  sending = false;
  cartMessage = null;
  renderCartSheet();
  refreshCatalog();
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
  sending = true;
  cartMessage = null;
  renderCartSheet();
  const owner = basket.owner;
  const startedAt = Date.now();
  let api;
  let signature = null;
  try {
    api = await import("./api.js");
    signature = api.itemsSignature(lines);
    const session = await api.getSession();
    if (!session || session.user.id !== owner) throw Object.assign(new Error("La sesión cambió."), { hint: "owner_changed" });
    rememberSending({ owner, signature, at: startedAt });
    const order = await withTimeout(api.createYerbaOrder(lines, profile?.phone ? null : phone), 15000);
    if (profile && !profile.phone) profile.phone = phone;
    // El carrito se vacía recién con el pedido confirmado por la base.
    orderSucceeded(order);
  } catch (err) {
    console.warn("Pedido de yerbas:", err);
    // Sin respuesta (corte, demora): puede haberse guardado igual. Antes de
    // ofrecer reintentar se busca; si está, es un éxito y no se duplica.
    if (api && signature && !err?.hint && !err?.code) {
      try {
        const found = await api.findRecentOrder(owner, startedAt - SKEW_MS, signature);
        if (found) return orderSucceeded(found);
      } catch (checkErr) {
        console.warn("Pedido de yerbas: no se pudo comprobar si se guardó.", checkErr);
        sending = false;
        sendFailed = true;
        return setMessage("No pudimos confirmar si tu pedido se registró. Revisá «Mis pedidos» en tu cuenta antes de volver a enviarlo.");
      }
    }
    rememberSending(null);
    sending = false;
    sendFailed = true;
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

// Se recargó la página a mitad de un envío: si el pedido se guardó, se muestra
// el éxito (y se vacía el carrito) en vez de dejar enviarlo otra vez.
async function resumeInterruptedSend() {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(SENDING_KEY) ?? "null"); } catch { /* nada */ }
  if (!pending) return;
  if (!pending.signature || !hasStoredSession() || Date.now() - pending.at > 30 * 60 * 1000 || pending.owner !== basket.owner) {
    return rememberSending(null);
  }
  try {
    const api = await import("./api.js");
    const found = await api.findRecentOrder(pending.owner, pending.at - SKEW_MS, pending.signature);
    if (found) {
      orderSucceeded(found);
      showSheet(ui.cartSheet);
    }
    rememberSending(null);
  } catch (err) {
    console.warn("Pedido de yerbas: no se pudo comprobar el envío anterior.", err);
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
  lastPerRow = shelfLayout().key + ":" + Math.round((ui.track.clientWidth || 0) / 40);
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
  // La ayuda de abajo se va sola a los pocos segundos (o al deslizar).
  setTimeout(() => ui.hint.classList.add("is-gone"), 6000);

  try {
    catalog = await loadYerbas();
  } catch (err) {
    console.error(err);
    ui.track.removeAttribute("aria-busy");
    ui.track.innerHTML = `<section class="y-gondola y-empty"><p>No pudimos cargar las yerbas. Probá recargar la página en unos minutos.</p><button type="button" class="y-btn-ghost" onclick="location.reload()">Reintentar</button></section>`;
    return;
  }
  lastPerRow = shelfLayout().key + ":" + Math.round((ui.track.clientWidth || 0) / 40);
  renderAisle();
  const changes = basket.reconcile(catalog);
  renderDock();
  if (changes.length) showToast("Actualizamos tu carrito según el stock disponible.");
  resumeInterruptedSend();
  loadRestockAlerts();

  // Al volver a la pestaña después de un rato, el stock se actualiza.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > 60000 && !sending) refreshCatalog();
  });
}

start();
