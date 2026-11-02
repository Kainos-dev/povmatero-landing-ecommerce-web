// Catálogo de /yerbas: la categoría «yerbas» de Supabase (sin catálogo aparte).
//
// Lee la vista pública storefront_catalog, donde «stock» ya es lo DISPONIBLE
// (stock físico menos lo comprometido en pedidos de yerbas; ver la migración
// 20261105000000_yerba_orders.sql). Solo presentaciones publicadas con precio.
//
// Formato:
//   { brands: [{ key, name, products }], products, byVariant: Map<variantId, { product, variant }> }
//   product: { id, slug, name, brand, image, shelfImage, variants }
//     image:      foto del catálogo (se usa como frente del paquete genérico)
//     shelfImage: PNG del envase para la góndola (products.shelf_image), o null
//   variant: { id, name, label, grams, price, stock, image }   stock null = no se controla
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../lib/supabaseConfig.js";

// Góndolas en este orden; las yerbas sin marca van a «Otras marcas», al final.
// Si en el panel se carga otra marca, aparece su góndola antes de «Otras marcas».
const BRAND_ORDER = ["Canarias", "Rei Verde", "Sara", "Armiño"];
export const OTHER_BRANDS = "Otras marcas";

const BASE_COLUMNS = [
  "product_id", "product_slug", "product_name", "brand", "cover_image",
  "variant_id", "variant_name", "price", "track_stock", "stock", "variant_image",
  "product_sort", "variant_sort",
];
const COLUMNS = [...BASE_COLUMNS, "shelf_image"].join(",");

const urlFor = (columns) =>
  `${SUPABASE_URL}/rest/v1/storefront_catalog?select=${columns}&category_slug=eq.yerbas` +
  `&order=product_sort.asc,product_id.asc,variant_sort.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`;
export const YERBAS_URL = urlFor(COLUMNS);
// Sin la columna shelf_image (antes de aplicar la migración 20261106000000):
// la góndola funciona igual, con el paquete genérico.
const YERBAS_URL_NO_SHELF = urlFor(BASE_COLUMNS.join(","));

const TIMEOUT_MS = 10000;

// «500gr» → «500 g», «1kg» → «1 kg». Lo demás queda como está.
export function presentationLabel(name) {
  const text = String(name ?? "").trim();
  let m = text.match(/^(\d+(?:[.,]\d+)?)\s*(?:g|gr|grs|gramos)\.?$/i);
  if (m) return `${m[1]} g`;
  m = text.match(/^(\d+(?:[.,]\d+)?)\s*(?:kg|kgs|kilo|kilos)\.?$/i);
  if (m) return `${m[1]} kg`;
  return text === "Único" ? "Unidad" : text;
}

// Gramos de una presentación («500gr» → 500, «1kg» → 1000), para dibujar
// los paquetes chicos más bajos. null si no se puede saber.
export function presentationGrams(name) {
  const text = String(name ?? "").trim().replace(",", ".");
  let m = text.match(/^(\d+(?:\.\d+)?)\s*(?:g|gr|grs|gramos)\.?$/i);
  if (m) return Number(m[1]);
  m = text.match(/^(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilo|kilos)\.?$/i);
  if (m) return Number(m[1]) * 1000;
  return null;
}

async function fetchRows() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Sin sesión ni cookies: siempre lo mismo que ve un visitante.
    let res = await fetch(YERBAS_URL, { signal: controller.signal });
    // 400 = la vista todavía no tiene shelf_image: se pide sin esa columna.
    if (res.status === 400) res = await fetch(YERBAS_URL_NO_SHELF, { signal: controller.signal });
    if (!res.ok) throw new Error(`Supabase ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function loadYerbas() {
  let rows;
  try {
    rows = await fetchRows();
  } catch (err) {
    console.warn("Yerbas: primer intento fallido, se reintenta.", err);
    await new Promise((r) => setTimeout(r, 1500));
    rows = await fetchRows();
  }
  return buildCatalog(rows);
}

export function buildCatalog(rows) {
  const byId = new Map();
  for (const r of rows ?? []) {
    if (!(Number(r.price) > 0)) continue;
    let p = byId.get(r.product_id);
    if (!p) {
      p = {
        id: r.product_id,
        slug: r.product_slug,
        name: r.product_name,
        brand: r.brand ?? null,
        cover: r.cover_image ?? null,
        shelfImage: r.shelf_image ?? null,
        variants: [],
      };
      byId.set(r.product_id, p);
    }
    p.variants.push({
      id: r.variant_id,
      name: r.variant_name,
      label: presentationLabel(r.variant_name),
      grams: presentationGrams(r.variant_name),
      price: Number(r.price),
      stock: r.track_stock ? Math.max(0, Number(r.stock ?? 0)) : null,
      image: r.variant_image ?? null,
    });
  }

  const products = [...byId.values()].map(({ cover, ...p }) => ({
    ...p,
    image: cover ?? p.variants.find((v) => v.image)?.image ?? null,
  }));

  const groups = new Map();
  for (const p of products) {
    const key = p.brand?.trim() || OTHER_BRANDS;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const rank = (name) => {
    if (name === OTHER_BRANDS) return [2, ""];
    const i = BRAND_ORDER.findIndex((b) => b.toLowerCase() === name.toLowerCase());
    return i >= 0 ? [0, String(i).padStart(3, "0")] : [1, name.toLowerCase()];
  };
  const brands = [...groups.entries()]
    .map(([name, list]) => ({ key: slugKey(name), name, products: list }))
    .sort((a, b) => {
      const [ga, ka] = rank(a.name), [gb, kb] = rank(b.name);
      return ga - gb || ka.localeCompare(kb);
    });

  const byVariant = new Map();
  for (const p of products) for (const v of p.variants) byVariant.set(v.id, { product: p, variant: v });

  return { brands, products, byVariant };
}

function slugKey(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ¿Queda algo para pedir de este producto?
export const isAvailable = (variant) => variant.stock === null || variant.stock > 0;
export const productAvailable = (product) => product.variants.some(isAvailable);

// Texto de disponibilidad de una presentación.
export function availabilityText(variant) {
  if (variant.stock === null) return "Disponible";
  if (variant.stock <= 0) return "Agotado";
  if (variant.stock <= 3) return variant.stock === 1 ? "Queda 1" : `Quedan ${variant.stock}`;
  return "Disponible";
}
