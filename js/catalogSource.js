// Fuente del catálogo de la tienda.
//
// Por defecto lee Supabase (vista public.storefront_catalog: solo productos,
// variantes y categorías publicados). Si Supabase falla, tarda demasiado o
// todavía no hay nada publicado, usa la fuente anterior (js/products.js +
// hoja WEB), así la tienda nunca queda vacía durante la transición.
//
//   ?fuente=supabase  solo Supabase, sin respaldo (para probar)
//   ?fuente=legacy    solo la fuente anterior
//
// Las dos fuentes entregan el mismo formato que ya usan catalog.js, modal.js
// y cart.js:
//   { id, name, category, description, price, image, variants? }
//   variants: [{ name, price, image, stock }]   (stock null = no se controla)
//   stock:    solo en productos simples (sin variantes), mismo criterio
//   gallery:  [src] portada + imágenes generales del producto (solo Supabase)

import { products as legacyProducts } from "./products.js";
import { getYerbas, transformarYerbas } from "./yerbas.js";

const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
const REQUEST_TIMEOUT_MS = 10000;
// Con respaldo disponible no conviene esperar tanto antes de usarlo.
const AUTO_TIMEOUT_MS = 6000;

// Mismas fotos de respaldo que usa hoy la tienda cuando falta la imagen.
const YERBA_PLACEHOLDER = "images/yerbas/canarias-tradicional.png";
const PRODUCT_PLACEHOLDER = "images/Logo.png";

const SINGLE_VARIANT_NAME = "Único";

const VIEW_COLUMNS = [
  "product_id", "product_name", "description", "category_slug", "category_name", "cover_image",
  "variant_name", "price", "track_stock", "stock", "variant_image",
  "product_sort", "variant_sort",
].join(", ");

export function getCatalogSourceName() {
  const param = new URLSearchParams(window.location.search).get("fuente");
  return param === "supabase" || param === "legacy" ? param : "auto";
}

// Devuelve { source, categories, getCategory(category) } donde category es
// "all", "yerbas" o el slug de una categoría. "all" no incluye yerbas (como hoy).
// categories: [{ slug, name }] con productos publicados, en el orden definido en
// el panel (null en la fuente anterior).
export async function loadCatalog() {
  const source = getCatalogSourceName();
  if (source === "legacy") return loadLegacyCatalog();
  if (source === "supabase") return loadSupabaseCatalog(REQUEST_TIMEOUT_MS);

  try {
    // El límite cubre también la descarga de la librería de Supabase.
    const catalog = await withTimeout(loadSupabaseCatalog(AUTO_TIMEOUT_MS), AUTO_TIMEOUT_MS);
    if (catalog.productCount > 0) return catalog;
    console.warn("Catálogo: Supabase no tiene productos publicados; se usa la fuente anterior.");
  } catch (error) {
    console.warn("Catálogo: no se pudo leer Supabase; se usa la fuente anterior.", error);
  }
  return loadLegacyCatalog();
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Supabase no respondió en ${ms / 1000} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------
// Fuente actual: products.js + hoja WEB (sin cambios de comportamiento)
// ---------------------------------------------------------------------
function loadLegacyCatalog() {
  return {
    source: "legacy",
    categories: null,
    async getCategory(category) {
      if (category === "yerbas") {
        // Igual que antes: se consulta la hoja en cada visita al filtro.
        return transformarYerbas(await getYerbas());
      }
      return category === "all"
        ? legacyProducts
        : legacyProducts.filter((p) => p.category === category);
    },
  };
}

// ---------------------------------------------------------------------
// Supabase: catálogo (vista) + galería (imágenes generales), en paralelo;
// después se filtra en memoria
// ---------------------------------------------------------------------
async function loadSupabaseCatalog(timeoutMs) {
  const { rows, galleryRows, categoryRows } = await fetchStorefrontRows(timeoutMs);
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
    categories,
    async getCategory(category) {
      if (category === "all") return products.filter((p) => p.category !== "yerbas");
      return products.filter((p) => p.category === category);
    },
  };
}

async function fetchStorefrontRows(timeoutMs) {
  const [{ createClient }, { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY }] = await Promise.all([
    import(SUPABASE_JS_URL),
    import("./lib/supabaseConfig.js"),
  ]);

  // Cliente anónimo propio de la tienda: no lee ni guarda sesión, así una
  // sesión de admin abierta en el panel no cambia lo que ve la tienda.
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const [catalog, gallery, cats] = await Promise.all([
      supabase
        .from("storefront_catalog")
        .select(VIEW_COLUMNS)
        .order("product_sort")
        .order("product_id")
        .order("variant_sort")
        .abortSignal(controller.signal),
      // Imágenes generales de productos publicados (la RLS filtra el resto).
      supabase
        .from("product_images")
        .select("product_id, src, is_cover, sort_order")
        .is("variant_id", null)
        .order("product_id")
        .order("sort_order")
        .order("id")
        .abortSignal(controller.signal),
      // Orden de las categorías para los filtros (la RLS solo devuelve las activas).
      supabase
        .from("categories")
        .select("slug, sort_order")
        .order("sort_order")
        .abortSignal(controller.signal),
    ]);

    if (catalog.error) throw new Error(`Supabase: ${catalog.error.message}`);
    // Sin galería la tienda funciona igual (portada y fotos de variantes).
    if (gallery.error) console.warn("Catálogo: no se pudo leer la galería de imágenes.", gallery.error);
    if (cats.error) console.warn("Catálogo: no se pudo leer el orden de las categorías.", cats.error);
    return {
      rows: catalog.data ?? [],
      galleryRows: gallery.error ? [] : (gallery.data ?? []),
      categoryRows: cats.error ? [] : (cats.data ?? []),
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
