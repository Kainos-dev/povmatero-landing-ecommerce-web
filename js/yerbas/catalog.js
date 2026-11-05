// Catálogo de /yerbas: la categoría «yerbas» de Supabase (sin catálogo aparte).
//
// Lee la vista pública storefront_catalog, donde «stock» ya es lo DISPONIBLE
// (stock físico menos lo comprometido en pedidos de yerbas; ver la migración
// 20261105000000_yerba_orders.sql). Solo presentaciones publicadas con precio.
//
// Formato:
//   { brands: [{ key, name, products }], products, byVariant: Map<variantId, { product, variant }> }
//   product: { id, slug, name, brand, shelfOther, image, shelfImage, variants }
//     brand:      marca real (products.brand)
//     shelfOther: true = se muestra en «Otras marcas» aunque tenga marca
//     image:      foto del catálogo (se usa como frente del paquete genérico)
//     shelfImage: PNG del envase para la góndola (products.shelf_image), o null
//   variant: { id, name, label, grams, price, stock, image, shelfImage }   stock null = no se controla
//     shelfImage: PNG propio de esa presentación (product_variants.shelf_image), o null
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../lib/supabaseConfig.js";

// Orden de las góndolas y de las yerbas: lo define el panel (Góndola › Orden) y
// llega en la vista (brand_position, shelf_position, shelf_other; migración
// 20261113000000_shelf_order.sql). «Otras marcas» va siempre al final.
// Solo mientras esa migración no esté aplicada se usa el orden de antes:
const LEGACY_BRAND_ORDER = ["Canarias", "Rei Verde", "Sara", "Armiño"];
export const OTHER_BRANDS = "Otras marcas";

const BASE_COLUMNS = [
  "product_id", "product_slug", "product_name", "brand", "cover_image",
  "variant_id", "variant_name", "price", "track_stock", "stock", "variant_image",
  "product_sort", "variant_sort",
];
const urlFor = (columns) =>
  `${SUPABASE_URL}/rest/v1/storefront_catalog?select=${columns.join(",")}&category_slug=eq.yerbas` +
  `&order=product_sort.asc,product_id.asc,variant_sort.asc&apikey=${SUPABASE_PUBLISHABLE_KEY}`;
// Imágenes de góndola: la de cada presentación (variant_shelf_image, migración
// 20261107000000) y la general del producto (shelf_image, 20261106000000).
// Si la base todavía no tiene alguna de esas columnas (400), se pide sin ella:
// la góndola funciona igual, con lo que haya.
const ORDER_COLUMNS = ["shelf_other", "shelf_position", "brand_position"];
export const YERBAS_URL = urlFor([...BASE_COLUMNS, "shelf_image", "variant_shelf_image", ...ORDER_COLUMNS]);
const FALLBACK_URLS = [
  urlFor([...BASE_COLUMNS, "shelf_image", "variant_shelf_image"]),
  urlFor([...BASE_COLUMNS, "shelf_image"]),
  urlFor(BASE_COLUMNS),
];

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
    for (const url of FALLBACK_URLS) {
      if (res.status !== 400) break;
      res = await fetch(url, { signal: controller.signal });
    }
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
        shelfOther: r.shelf_other === true,
        _pos: r.shelf_position ?? null,
        _brandPos: r.brand_position ?? null,
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
      image: r.variant_image ?? null,                 // foto del catálogo (no se usa en la góndola)
      shelfImage: r.variant_shelf_image ?? null,       // imagen de góndola propia de la presentación
    });
  }

  const products = [...byId.values()].map(({ cover, ...p }) => ({
    ...p,
    image: cover ?? p.variants.find((v) => v.image)?.image ?? null,
  }));

  // ¿La base ya manda el orden del panel? (migración 20261113 aplicada)
  const ordered = (rows ?? []).some((r) => "shelf_position" in r);

  // Góndola de cada yerba: su marca, o «Otras marcas» (sin marca, o con la
  // casilla marcada). Todas las presentaciones de una yerba van juntas.
  const groups = new Map();
  for (const p of products) {
    const key = (!p.shelfOther && p.brand?.trim()) || OTHER_BRANDS;
    if (!groups.has(key)) groups.set(key, { position: null, list: [] });
    const g = groups.get(key);
    g.list.push(p);
    if (key !== OTHER_BRANDS && p._brandPos != null) g.position = p._brandPos;
  }
  // Dentro de la góndola, el lugar del panel (sin la migración, las filas ya
  // llegan como antes: sort_order e id).
  if (ordered) {
    for (const g of groups.values()) g.list.sort((a, b) => (a._pos ?? Infinity) - (b._pos ?? Infinity) || a.id - b.id);
  }
  // [grupo, posición, nombre]: primero las del orden del panel, después las que
  // todavía no tienen lugar (alfabético) y «Otras marcas» siempre al final.
  const rank = (name, position) => {
    if (name === OTHER_BRANDS) return [2, 0, ""];
    if (ordered) return position != null ? [0, position, ""] : [1, 0, name.toLowerCase()];
    const i = LEGACY_BRAND_ORDER.findIndex((b) => b.toLowerCase() === name.toLowerCase());
    return i >= 0 ? [0, i, ""] : [1, 0, name.toLowerCase()];
  };
  const brands = [...groups.entries()]
    .map(([name, g]) => ({ name, list: g.list, rank: rank(name, g.position) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2].localeCompare(b.rank[2]))
    .map(({ name, list }) => ({ key: slugKey(name), name, products: list }));
  for (const p of products) { delete p._pos; delete p._brandPos; }

  const byVariant = new Map();
  for (const p of products) for (const v of p.variants) byVariant.set(v.id, { product: p, variant: v });

  return { brands, products, byVariant };
}

function slugKey(name) {
  return String(name).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Imagen de góndola de una presentación: la propia, si no la general del
// producto, si no null (paquete genérico).
export const shelfImageFor = (product, variant) => variant?.shelfImage ?? product.shelfImage ?? null;

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
