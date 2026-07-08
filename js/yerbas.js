const YERBAS_URL = "https://opensheet.elk.sh/1TFmZ1hbO5bXh5MGktpUzM7MJTZwyoknVLyVHRNBbwso/WEB";

const YERBAS_IMAGES = {
  "Canarias Tradicional": "images/yerbas/canarias-tradicional.png",
  "Canarias Serena": "images/yerbas/canarias-tradicional.png",
  "Canarias Ed. Especial": "images/yerbas/canarias-tradicional.png",
  "Canarias Te Verde y Jengibre": "images/yerbas/canarias-tradicional.png",
  "Canarias Te Rojo y Centella": "images/yerbas/canarias-tradicional.png",
  "Canarias Contigo": "images/yerbas/canarias-tradicional.png",
  "Baldo": "images/yerbas/canarias-tradicional.png",
  "Esmeralda": "images/yerbas/canarias-tradicional.png",
  "Rei Verde Tradicional": "images/yerbas/canarias-tradicional.png",
  "Rei Verde Premium": "images/yerbas/canarias-tradicional.png",
  "Rei Verde Orgánica": "images/yerbas/canarias-tradicional.png",
  "Rei Verde Compuesta": "images/yerbas/canarias-tradicional.png",
  "Sara Tradicional": "images/yerbas/canarias-tradicional.png",
  "Sara Extrasuave": "images/yerbas/canarias-tradicional.png",
  "Sara Espléndida": "images/yerbas/canarias-tradicional.png",
  "Sara Coco": "images/yerbas/canarias-tradicional.png",
  "Sara Cúrcuma y Pimienta": "images/yerbas/canarias-tradicional.png",
  "Sara Compuesta": "images/yerbas/canarias-tradicional.png",
  "Barao": "images/yerbas/canarias-tradicional.png",
  "Verdecita": "images/yerbas/canarias-tradicional.png",
  "Pindaré": "images/yerbas/canarias-tradicional.png",
  "Consentina con Colágeno": "images/yerbas/canarias-tradicional.png",
  "Uruguay": "images/yerbas/canarias-tradicional.png",
  "La Selva para Nerviosos": "images/yerbas/canarias-tradicional.png",
  "Armiño Clásica": "images/yerbas/canarias-tradicional.png",
  "Armiño Suave": "images/yerbas/canarias-tradicional.png",
  "Canabbis": "images/yerbas/canarias-tradicional.png",
  "Canarias Suave": "images/yerbas/canarias-tradicional.png",
};

export async function getYerbas() {
  const res = await fetch(YERBAS_URL);
  const data = await res.json();
  return data;
}

export function agruparYerbas(data) {
  const grupos = {};

  data.forEach(item => {
    const nombre = item.Nombre;

    if (!grupos[nombre]) {
      grupos[nombre] = [];
    }

    grupos[nombre].push(item);
  });

  return grupos;
}

export function transformarYerbas(data) {
  const grupos = {};

  data.forEach(item => {
    const nombre = item.Nombre;

    if (!grupos[nombre]) {
      grupos[nombre] = {
        id: `yerba-${nombre}`,
        name: nombre,
        category: "yerbas",
        description: "",
        image: YERBAS_IMAGES[nombre] || "images/yerbas/default.webp",
        variants: []
      };
    }

    const price = parsePrecio(item.Precio);

    if (price > 0) {
      grupos[nombre].variants.push({
      name: item.Peso,
      price: price,
      stock: Number(item.Stock || 0)
    });
}
  });

  return Object.values(grupos);
}

function parsePrecio(precio) {
  if (!precio) return 0;

  return Number(
    precio.replace("$", "").replace(",", "").trim()
  );
}
