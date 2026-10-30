// Navegación de la tienda: portada (catálogo) y páginas de producto
// (/producto/<slug>) en el mismo documento.
//
// Ir y volver de un producto no recarga la página: el catálogo queda tal cual
// (categoría, orden de las cards) y al volver se recupera la posición de scroll.
// Una URL de producto abierta directamente (o recargada) funciona igual: Vercel
// la sirve con index.html (ver vercel.json) y este módulo muestra el producto.
import { renderProductDetail } from "./components/productDetail.js";
import { productPath } from "./components/catalog.js";
import { createRelatedCarousel } from "./components/relatedCarousel.js";
import { closeLightbox, isLightboxOpen } from "./components/lightbox.js";
import { scrollToUnderHeader } from "./lib/scroll.js";
import { absoluteSrc } from "./lib/images.js";
import { escapeHtml } from "./lib/html.js";

const SITE_URL = "https://povmatero-landing-ecommerce-web.vercel.app";
const PRODUCT_RE = /^\/producto\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/;
const RELATED_MAX = 12;
// Ancho de cada card del carrusel (ver .pdp-related-track en product.css)
const RELATED_SIZES = "(min-width: 1024px) 21vw, (min-width: 640px) 30vw, 72vw";

export function slugFromPath(pathname = location.pathname) {
  return pathname.match(PRODUCT_RE)?.[1] ?? null;
}

// ---------- Metadatos (título, descripción, canónica, Open Graph) ----------
function meta(selector, attr, key) {
  let el = document.head.querySelector(selector);
  if (!el) {
    el = document.createElement(selector.startsWith("link") ? "link" : "meta");
    el.setAttribute(attr, key);
    document.head.append(el);
  }
  return el;
}
const setMeta = (name, value) => meta(`meta[name="${name}"]`, "name", name).setAttribute("content", value);
const setOg = (prop, value) => meta(`meta[property="${prop}"]`, "property", prop).setAttribute("content", value);
const setCanonical = (href) => meta('link[rel="canonical"]', "rel", "canonical").setAttribute("href", href);

function absoluteUrl(src) {
  const s = absoluteSrc(src);
  return /^https?:\/\//.test(s) ? s : SITE_URL + s;
}

function priceText(product) {
  const prices = product.variants ? product.variants.map((v) => v.price).filter((p) => p > 0) : [product.price];
  if (!prices.length) return "";
  const min = Math.min(...prices);
  return `${product.variants && prices.length > 1 ? "Desde " : ""}$${min.toLocaleString("es-AR")}`;
}

function productDescription(product) {
  const text = String(product.description ?? "").trim().replace(/\s+/g, " ");
  const base = text || `${product.name} en povmatero. ${product.categoryName ?? ""}`.trim();
  const price = priceText(product);
  return (price ? `${base} ${price}.` : base).slice(0, 200);
}

export function initRouter({ cart }) {
  const html = document.documentElement;
  const page = document.getElementById("productPage");
  const detail = document.getElementById("pdpDetail");
  const crumb = document.getElementById("pdpCrumb");
  const backLink = document.getElementById("pdpBack");
  const related = document.getElementById("pdpRelated");
  const track = document.getElementById("pdpRelatedTrack");
  const prevBtn = related?.querySelector(".pdp-related-arrow.prev");
  const nextBtn = related?.querySelector(".pdp-related-arrow.next");
  if (!page || !detail) return { goHome: () => {} };

  let catalogPromise = null;
  let galleryNav = null;
  history.scrollRestoration = "manual";

  // Metadatos originales de la portada (se restauran al volver).
  const homeMeta = {
    title: document.title,
    description: document.head.querySelector('meta[name="description"]')?.content ?? "",
    ogTitle: document.head.querySelector('meta[property="og:title"]')?.content ?? "",
    ogDescription: document.head.querySelector('meta[property="og:description"]')?.content ?? "",
    ogImage: document.head.querySelector('meta[property="og:image"]')?.content ?? "",
  };

  function applyHomeMeta() {
    document.title = homeMeta.title;
    setMeta("description", homeMeta.description);
    setMeta("robots", "index, follow");
    setOg("og:title", homeMeta.ogTitle);
    setOg("og:description", homeMeta.ogDescription);
    setOg("og:image", absoluteUrl(homeMeta.ogImage || "images/Logo.jpeg"));
    setOg("og:type", "website");
    setOg("og:url", `${SITE_URL}/`);
    setCanonical(`${SITE_URL}/`);
  }

  function applyProductMeta(product) {
    const title = `${product.name} — povmatero`;
    const description = productDescription(product);
    const url = `${SITE_URL}${productPath(product)}`;
    document.title = title;
    setMeta("description", description);
    setMeta("robots", "index, follow");
    setOg("og:title", title);
    setOg("og:description", description);
    setOg("og:image", absoluteUrl(product.image));
    setOg("og:type", "product");
    setOg("og:url", url);
    setMeta("twitter:card", "summary_large_image");
    setCanonical(url);
  }

  function applyNotFoundMeta() {
    document.title = "Producto no disponible — povmatero";
    setMeta("robots", "noindex");
  }

  // ---------- Vistas ----------
  function showHomeView() {
    closeLightbox();
    galleryNav = null;
    html.classList.remove("route-product");
    page.setAttribute("aria-hidden", "true");
    applyHomeMeta();
  }

  async function showProductView(slug) {
    closeLightbox();
    html.classList.add("route-product");
    page.removeAttribute("aria-hidden");
    window.scrollTo({ top: 0, behavior: "instant" });

    let catalog;
    try {
      catalog = await catalogPromise;
    } catch {
      renderMessage("No pudimos cargar el producto. Probá recargar la página en unos minutos.");
      return;
    }
    if (slugFromPath() !== slug) return; // se navegó a otra cosa mientras cargaba

    const product = catalog.products.find((p) => p.slug === slug);
    if (!product) {
      renderMessage("Este producto no está disponible. Mirá el resto del catálogo.");
      applyNotFoundMeta();
      return;
    }

    crumb.textContent = product.categoryName ?? product.category;
    galleryNav = renderProductDetail(detail, product, { cart, layout: "page" }).step;
    renderRelated(product, catalog.products);
    applyProductMeta(product);
  }

  function renderMessage(text) {
    crumb.textContent = "";
    detail.innerHTML = `<div class="pdp-message"><p>${escapeHtml(text)}</p><a class="btn-add" href="/" data-route-home>Ver el catálogo</a></div>`;
    related.hidden = true;
    galleryNav = null;
  }

  // ---------- Productos similares (carrusel infinito) ----------
  const carousel = track ? createRelatedCarousel({ track, prevBtn, nextBtn, sizes: RELATED_SIZES }) : null;

  function renderRelated(product, products) {
    const items = products.filter((p) => p.category === product.category && p.id !== product.id).slice(0, RELATED_MAX);
    related.hidden = items.length === 0;
    carousel?.render(items);
  }

  // ---------- Navegación ----------
  function render() {
    const slug = slugFromPath();
    if (slug) return showProductView(slug);
    showHomeView();
    const y = history.state?.scrollY;
    if (typeof y === "number") requestAnimationFrame(() => window.scrollTo({ top: y, behavior: "instant" }));
  }

  // Guarda la posición del catálogo antes de salir de la portada.
  function rememberScroll() {
    if (!slugFromPath()) history.replaceState({ ...(history.state ?? {}), scrollY: window.scrollY }, "");
  }

  function navigate(path) {
    if (path === location.pathname) return;
    rememberScroll();
    // depth: cuántas páginas de producto se recorrieron desde el catálogo.
    const depth = slugFromPath() ? (history.state?.depth ?? 0) + 1 : 1;
    history.pushState({ depth, fromCatalog: Boolean(slugFromPath()) ? history.state?.fromCatalog : true }, "", path);
    render();
  }

  // Volver a la portada; "section" = id al que ir (p. ej. "productos").
  function goHome({ section = "productos" } = {}) {
    const fromProduct = Boolean(slugFromPath());
    if (fromProduct) {
      history.pushState({}, "", "/");
      showHomeView();
    }
    const target = section && document.getElementById(section);
    if (!target) return;
    // En la portada recién mostrada, el salto es directo (no hay recorrido que animar).
    requestAnimationFrame(() => {
      if (fromProduct) {
        window.scrollTo({ top: 0, behavior: "instant" });
        const top = target.getBoundingClientRect().top + window.scrollY - (document.querySelector(".site-header")?.offsetHeight ?? 0) - 12;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      } else {
        scrollToUnderHeader(target);
      }
    });
  }

  // «Volver al catálogo»: si se llegó desde el catálogo, se vuelve en el
  // historial (conserva categoría, orden y posición); si no, se va al catálogo.
  backLink?.addEventListener("click", (e) => {
    e.preventDefault();
    const depth = history.state?.depth ?? 0;
    if (history.state?.fromCatalog && depth > 0) history.go(-depth);
    else goHome({ section: "productos" });
  });

  // Enlaces a productos (cards, carrusel) sin recargar la página.
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest("a[href]");
    if (!link || link.target === "_blank") return;
    if (link.hasAttribute("data-route-home")) {
      e.preventDefault();
      goHome({ section: "productos" });
      return;
    }
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    if (slugFromPath(url.pathname)) {
      e.preventDefault();
      navigate(url.pathname);
      return;
    }
    // Desde una página de producto: enlaces a la portada (logo «/», «#hero»,
    // «#productos»…) vuelven al inicio y van a la sección pedida.
    if (slugFromPath() && (url.pathname === "/" || url.pathname === "/index.html" || link.getAttribute("href").startsWith("#"))) {
      e.preventDefault();
      const id = url.hash.slice(1);
      goHome({ section: id || "hero" });
    }
  });

  // Pedido de otros módulos (menú «Productos», pie): ir a una sección de la portada.
  document.addEventListener("povmatero:go-home", (e) => goHome({ section: e.detail?.section ?? "productos" }));

  window.addEventListener("popstate", render);

  // ← → recorren las fotos en la página de producto (como en el modal).
  document.addEventListener("keydown", (e) => {
    if (!html.classList.contains("route-product") || !galleryNav || isLightboxOpen()) return;
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tag = document.activeElement?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || document.querySelector(".account-modal.open, #cartPanel.open")) return;
    e.preventDefault();
    galleryNav(e.key === "ArrowLeft" ? -1 : 1);
  });

  return {
    start(promise) {
      catalogPromise = promise;
      render();
    },
    goHome,
    isProductView: () => Boolean(slugFromPath()),
  };
}
