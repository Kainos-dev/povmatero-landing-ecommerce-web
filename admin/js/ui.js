// Utilidades de interfaz del panel.
// h() arma elementos con textContent: nunca se inserta HTML a partir de datos.

const PROPERTY_KEYS = new Set(["value", "checked", "disabled", "hidden", "selected", "required", "readOnly"]);

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPERTY_KEYS.has(key)) el[key] = value;
    else el.setAttribute(key, value === true ? "" : String(value));
  }

  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Reemplaza el contenido de "el". A diferencia de replaceChildren() nativo,
// aplana listas y descarta null/false (el nativo los convertiría en texto,
// por ejemplo "[object HTMLElement]" o "null").
export function mount(el, ...children) {
  const nodes = children
    .flat(Infinity)
    .filter((child) => child != null && child !== false)
    .map((child) => (child instanceof Node ? child : document.createTextNode(String(child))));
  el.replaceChildren(...nodes);
  return el;
}

// Campo de formulario con etiqueta y ayuda opcional.
export function field(label, control, hint) {
  return h("label", { class: "field" },
    h("span", {}, label),
    control,
    hint ? h("small", { class: "hint" }, hint) : null
  );
}

export function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

// ---------- Notificaciones ----------
let toastEl = null;
let toastTimer = null;

export function toast(message, type = "ok") {
  if (!toastEl) {
    toastEl = h("div", { class: "toast", role: "status", "aria-live": "polite" });
    document.body.append(toastEl);
  }
  toastEl.textContent = message;
  toastEl.className = `toast toast-${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("visible"), type === "error" ? 6000 : 2500);
}

// ---------- Formatos ----------
const ARS = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export function formatPrice(value) {
  return value == null || Number.isNaN(Number(value)) ? "—" : ARS.format(Number(value));
}

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Texto en minúsculas y sin tildes (para slugs y búsquedas).
export function normalizeText(text) {
  return String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function slugify(text) {
  return normalizeText(text).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------- Errores de Supabase en lenguaje claro ----------
export function errorMessage(err) {
  const code = err?.code;
  const message = String(err?.message ?? "");

  if (code === "23505") {
    if (message.includes("slug")) return "Ya existe un producto con ese slug. Cambialo por uno distinto.";
    if (message.includes("product_id_name")) return "Este producto ya tiene una variante con ese nombre.";
    if (message.includes("sku")) return "Ese SKU ya está asignado a otra variante.";
    return "Ya existe un registro con ese valor.";
  }
  if (code === "42501") return "No tenés permisos para esta acción.";
  if (code === "23514" || code === "22P02") return "Algún valor no es válido. Revisá los datos ingresados.";
  if (code === "23503") return "Este registro está vinculado a otros datos y no se puede cambiar así.";
  if (code === "PGRST301" || code === "PGRST303" || /jwt/i.test(message)) {
    return "Tu sesión expiró. Volvé a ingresar.";
  }
  if (err instanceof TypeError) return "Error de conexión. Revisá tu internet e intentá de nuevo.";
  return message || "Ocurrió un error inesperado.";
}
