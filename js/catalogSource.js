// Fuente del catálogo de la tienda: Supabase es la única fuente.
//
// Lee la vista public.storefront_catalog (solo productos, variantes y
// categorías publicados), la galería de imágenes y el orden de las categorías.
// La tienda ya no consulta js/products.js ni la hoja WEB de Google Sheets.
//
// Formato que usan catalog.js, modal.js y cart.js:
//   { id, name, category, categoryName, description, price, image, gallery, variants? }
//   variants: [{ name, price, image, stock }]   (stock null = no se controla)
//   stock:    solo en productos simples (sin variantes), mismo criterio
//   gallery:  [src] portada + imágenes generales del producto

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./lib/supabaseConfig.js";

const REQUEST_TIMEOUT_MS = 10000;
// Si falla (por ejemplo, un corte de red momentáneo), se reintenta una vez.
const RETRY_DELAY_MS = 1500;

// Imagen genérica cuando un producto no tiene foto (archivos propios del sitio).
const YERBA_PLACEHOLDER = "images/yerbas/canarias-tradicional.png";
const PRODUCT_PLACEHOLDER = "images/Logo.png";

const SINGLE_VARIANT_NAME = "Único";

const VIEW_COLUMNS = [
  "product_id", "product_name", "description", "category_slug", "category_name", "cover_image",
  "variant_name", "price", "track_stock", "stock", "variant_image",
  "product_sort", "variant_sort",
].join(",");

// Consultas directas a la API REST de Supabase (sin descargar supabase-js).
// La clave pública va en la URL para que el pedido sea "simple" (sin consulta
// previa de CORS) y el navegador pueda empezarlo desde el HTML.
// IMPORTANTE: index.html precarga estas mismas URLs (<link rel="preload">).
// Si cambian acá, hay que copiarlas allá; si no coinciden, todo funciona igual
// pero se pierde la precarga.
const REST_URL = `${SUPABASE_URL}/rest/v1/`;
export const CATALOG_URLS = {
  catalog: `${REST_URL}storefront_catalog?select=${VIEW_COLUMNS}&order=product_sort.asc,product_id.asc,variant_sort.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`,
  // Imágenes generales de productos publicados (la RLS filtra el resto).
  gallery: `${REST_URL}product_images?select=product_id,src,is_cover,sort_order&variant_id=is.null&order=product_id.asc,sort_order.asc,id.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`,
  // Orden de las categorías para los filtros (la RLS solo devuelve las activas).
  categories: `${REST_URL}categories?select=slug,sort_order&order=sort_order.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`,
};

// Devuelve { source, categories, productCount, getCategory(category) } donde
// category es "all", "yerbas" o el slug de una categoría. "all" no incluye yerbas.
// categories: [{ slug, name }] con productos publicados, en el orden del panel.
export async function loadCatalog() {
  try {
    return await withTimeout(loadSupabaseCatalog(REQUEST_TIMEOUT_MS), REQUEST_TIMEOUT_MS);
  } catch (error) {
    console.warn("Catálogo: primer intento fallido, se reintenta.", error);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    return withTimeout(loadSupabaseCatalog(REQUEST_TIMEOUT_MS), REQUEST_TIMEOUT_MS);
  }
}

// El límite cubre también la descarga de la librería de Supabase.
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Supabase no respondió en ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------
// Supabase: catálogo (vista) + galería (imágenes generales), en paralelo;
// después se filtra en memoria
// ---------------------------------------------------------------------
async function loadSupabaseCatalog(timeoutMs) {
  const fetched = await fetchStorefrontRows(timeoutMs);
  const { galleryRows, categoryRows } = fetched;
  // Solo presentaciones comercializables: sin precio válido no se muestran.
  const rows = fetched.rows.filter((r) => Number(r.price) > 0);
  const products = mapRowsToProducts(rows, galleryRows);
  const order = new Map(categoryRows.map((c, i) => [c.slug, i]));

  // Categorías con al menos un producto publicado, en el orden en que aparecen.
  const categories = [];
  for (const row of rows) {
    if (!categories.some((c) => c.slug === row.category_slug)) {
      categories.push({ slug: row.category_slug, name: row.category_name ?? row.category_slug });
    }
  }
  // Orden del panel (categories.sort_order); las que no figuran, al final.
  categories.sort((a, b) => (order.get(a.slug) ?? 1e9) - (order.get(b.slug) ?? 1e9));

  return {
    source: "supabase",
    productCount: products.length,
    products,
    categories,
    async getCategory(category) {
      if (category === "all") return products.filter((p) => p.category !== "yerbas");
      return products.filter((p) => p.category === category);
    },
  };
}

// Un pedido de solo lectura, sin sesión: la tienda siempre ve lo mismo que un
// visitante anónimo (aunque haya un admin con la sesión abierta).
async function getJson(url, signal) {
  // Mismo modo que la precarga de index.html (crossorigin="anonymous"): sin cookies.
  const res = await fetch(url, { signal });
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).message ?? message; } catch { /* sin cuerpo JSON */ }
    throw new Error(`Supabase ${res.status}: ${message}`);
  }
  return res.json();
}

async function fetchStorefrontRows(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [catalog, gallery, cats] = await Promise.allSettled([
      getJson(CATALOG_URLS.catalog, controller.signal),
      getJson(CATALOG_URLS.gallery, controller.signal),
      getJson(CATALOG_URLS.categories, controller.signal),
    ]);

    if (catalog.status === "rejected") throw catalog.reason;
    // Sin galería la tienda funciona igual (portada y fotos de variantes).
    if (gallery.status === "rejected") console.warn("Catálogo: no se pudo leer la galería de imágenes.", gallery.reason);
    if (cats.status === "rejected") console.warn("Catálogo: no se pudo leer el orden de las categorías.", cats.reason);
    return {
      rows: catalog.value ?? [],
      galleryRows: gallery.status === "fulfilled" ? (gallery.value ?? []) : [],
      categoryRows: cats.status === "fulfilled" ? (cats.value ?? []) : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

export function mapRowsToProducts(rows, galleryRows = []) {
  const byId = new Map();

  const galleryByProduct = new Map();
  for (const g of galleryRows) {
    if (!galleryByProduct.has(g.product_id)) galleryByProduct.set(g.product_id, []);
    galleryByProduct.get(g.product_id).push(g.src);
  }

  for (const row of rows) {
    let product = byId.get(row.product_id);
    if (!product) {
      product = {
        id: row.product_id,
        name: row.product_name,
        category: row.category_slug,
        categoryName: row.category_name ?? row.category_slug,
        description: row.description ?? "",
        cover: row.cover_image,
        variants: [],
      };
      byId.set(row.product_id, product);
    }

    product.variants.push({
      name: row.variant_name,
      price: Number(row.price),
      image: row.variant_image ?? null,
      // La vista solo informa stock si la variante lo controla.
      stock: row.track_stock ? Number(row.stock ?? 0) : null,
    });
  }

  return [...byId.values()].map(({ cover, variants, ...product }) => {
    const isYerba = product.category === "yerbas";
    const image = cover
      ?? variants.find((v) => v.image)?.image
      ?? (isYerba ? YERBA_PLACEHOLDER : PRODUCT_PLACEHOLDER);
    const price = Math.min(...variants.map((v) => v.price));

    // Un producto con su única variante "Único" es un producto simple: se muestra
    // sin variantes, pero conserva su stock (null = no lo controla).
    const single = variants.length === 1 && variants[0].name === SINGLE_VARIANT_NAME;

    // Galería: la portada primero y después las demás imágenes generales, sin repetir.
    const gallery = [...new Set([image, ...(galleryByProduct.get(product.id) ?? [])])];

    return {
      ...product,
      price,
      image,
      gallery,
      ...(single ? { stock: variants[0].stock } : { variants }),
    };
  });
}
