// Fuente del catálogo de la tienda.
//
// Por defecto usa la fuente actual (js/products.js + hoja WEB).
// Con ?fuente=supabase lee la vista public.storefront_catalog, que solo
// devuelve productos, variantes y categorías publicados (activos).
//
// Las dos fuentes entregan el mismo formato que ya usan catalog.js, modal.js
// y cart.js:
//   { id, name, category, description, price, image, variants? }
//   variants: [{ name, price, image, stock }]   (stock null = no se controla)

import { products as legacyProducts } from "./products.js";
import { getYerbas, transformarYerbas } from "./yerbas.js";

const SUPABASE_JS_URL = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.3/+esm";
const REQUEST_TIMEOUT_MS = 10000;

// Mismas fotos de respaldo que usa hoy la tienda cuando falta la imagen.
const YERBA_PLACEHOLDER = "images/yerbas/canarias-tradicional.png";
const PRODUCT_PLACEHOLDER = "images/Logo.png";

const SINGLE_VARIANT_NAME = "Único";

const VIEW_COLUMNS = [
  "product_id", "product_name", "description", "category_slug", "cover_image",
  "variant_name", "price", "track_stock", "stock", "variant_image",
  "product_sort", "variant_sort",
].join(", ");

export function getCatalogSourceName() {
  const param = new URLSearchParams(window.location.search).get("fuente");
  return param === "supabase" ? "supabase" : "legacy";
}

// Devuelve { source, getCategory(category) } donde category es "all",
// "yerbas" o el slug de una categoría. "all" no incluye yerbas (como hoy).
export async function loadCatalog() {
  const source = getCatalogSourceName();
  return source === "supabase" ? loadSupabaseCatalog() : loadLegacyCatalog();
}

// ---------------------------------------------------------------------
// Fuente actual: products.js + hoja WEB (sin cambios de comportamiento)
// ---------------------------------------------------------------------
function loadLegacyCatalog() {
  return {
    source: "legacy",
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
// Supabase: una sola consulta, después se filtra en memoria
// ---------------------------------------------------------------------
async function loadSupabaseCatalog() {
  const rows = await fetchStorefrontRows();
  const products = mapRowsToProducts(rows);

  return {
    source: "supabase",
    async getCategory(category) {
      if (category === "all") return products.filter((p) => p.category !== "yerbas");
      return products.filter((p) => p.category === category);
    },
  };
}

async function fetchStorefrontRows() {
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
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const { data, error } = await supabase
      .from("storefront_catalog")
      .select(VIEW_COLUMNS)
      .order("product_sort")
      .order("product_id")
      .order("variant_sort")
      .abortSignal(controller.signal);

    if (error) throw new Error(`Supabase: ${error.message}`);
    return data ?? [];
  } finally {
    clearTimeout(timer);
  }
}

export function mapRowsToProducts(rows) {
  const byId = new Map();

  for (const row of rows) {
    let product = byId.get(row.product_id);
    if (!product) {
      product = {
        id: row.product_id,
        name: row.product_name,
        category: row.category_slug,
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

    // Un producto con su única variante "Único" se muestra sin variantes.
    const single = variants.length === 1 && variants[0].name === SINGLE_VARIANT_NAME;

    return {
      ...product,
      price,
      image,
      ...(single ? {} : { variants }),
    };
  });
}
