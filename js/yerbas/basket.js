// Carrito de /yerbas: independiente del carrito de la tienda.
//
// Guarda solo { variant_id, qty } en este navegador, con un carrito por dueño
// (igual que el carrito de la tienda, ver js/components/cart.js):
//   * invitado: povmatero-yerbas-v1:guest
//   * cuenta:   povmatero-yerbas-v1:u:<id del usuario>
// Al ingresar o registrarse desde esta página, lo del invitado se suma al
// carrito de la cuenta (misma presentación = una línea, cantidades sumadas).
// Al cerrar sesión se ve el carrito de invitado; el de la cuenta queda guardado.
// Si la sesión cambia por otro lado (el panel, otra pestaña) solo se cambia de
// carrito, sin sumar nada.
import { SESSION_KEY, storedUserId } from "../lib/session.js";

const PREFIX = "povmatero-yerbas-v1:";
const keyFor = (owner) => `${PREFIX}${owner ? `u:${owner}` : "guest"}`;

function read(key) {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function write(key, lines) {
  try {
    if (lines.length) localStorage.setItem(key, JSON.stringify(lines));
    else localStorage.removeItem(key);
  } catch { /* sin almacenamiento: dura lo que la pestaña */ }
}

// Una línea por presentación, cantidades enteras positivas.
export function mergeLines(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const l of list) {
      const id = Number(l?.variant_id);
      const qty = Math.floor(Number(l?.qty) || 0);
      if (!Number.isInteger(id) || id < 1 || qty < 1) continue;
      map.set(id, (map.get(id) ?? 0) + qty);
    }
  }
  return [...map].map(([variant_id, qty]) => ({ variant_id, qty }));
}

// onChange(lines, { ownerChanged }) se llama cada vez que cambia el carrito.
export function createBasket({ onChange } = {}) {
  let owner = storedUserId();
  let lines = mergeLines(read(keyFor(owner)));

  const emit = (extra = {}) => onChange?.(lines.map((l) => ({ ...l })), extra);
  const save = () => write(keyFor(owner), lines);

  function set(variantId, qty) {
    syncOwner();
    const id = Number(variantId);
    const n = Math.max(0, Math.floor(Number(qty) || 0));
    const i = lines.findIndex((l) => l.variant_id === id);
    if (n === 0) { if (i >= 0) lines.splice(i, 1); }
    else if (i >= 0) lines[i].qty = n;
    else lines.push({ variant_id: id, qty: n });
    save();
    emit();
  }

  // ¿Cambió quién tiene la sesión? Si cambió, se pasa al carrito del nuevo
  // dueño ("merge": solo al ingresar desde esta página). Devuelve true si cambió.
  function syncOwner({ merge = false } = {}) {
    const next = storedUserId();
    if (next === owner) return false;
    const previous = owner;
    owner = next;
    if (merge && previous === null && next !== null) {
      const guest = read(keyFor(null));
      if (guest.length) {
        write(keyFor(next), mergeLines(read(keyFor(next)), guest));
        write(keyFor(null), []);
      }
    }
    lines = mergeLines(read(keyFor(owner)));
    emit({ ownerChanged: true });
    return true;
  }

  // Ajusta el carrito a lo que hay: quita lo que ya no se vende y baja las
  // cantidades al disponible. Devuelve los cambios hechos (para avisar).
  function reconcile(catalog) {
    const changes = [];
    const next = [];
    for (const l of lines) {
      const hit = catalog.byVariant.get(l.variant_id);
      if (!hit) { changes.push({ variant_id: l.variant_id, removed: true }); continue; }
      const max = hit.variant.stock;
      if (max !== null && l.qty > max) {
        changes.push({ variant_id: l.variant_id, name: `${hit.product.name} ${hit.variant.label}`, from: l.qty, to: max });
        if (max > 0) next.push({ ...l, qty: max });
      } else {
        next.push(l);
      }
    }
    if (changes.length) {
      lines = next;
      save();
      emit();
    }
    return changes;
  }

  // Otras pestañas: cambio de sesión o del carrito del dueño actual.
  window.addEventListener("storage", (e) => {
    if (e.key === null || e.key === SESSION_KEY) {
      if (!syncOwner() && e.key === null) { lines = mergeLines(read(keyFor(owner))); emit(); }
    } else if (e.key === keyFor(owner)) {
      lines = mergeLines(read(keyFor(owner)));
      emit();
    }
  });
  // Esta pestaña: ingreso o registro (suma el carrito de invitado) y salida.
  document.addEventListener("povmatero:signed-in", () => syncOwner({ merge: true }));
  document.addEventListener("povmatero:signed-out", () => syncOwner());

  return {
    get owner() { return owner; },
    lines: () => lines.map((l) => ({ ...l })),
    qty: (variantId) => lines.find((l) => l.variant_id === Number(variantId))?.qty ?? 0,
    units: () => lines.reduce((n, l) => n + l.qty, 0),
    set,
    add: (variantId, n = 1) => set(variantId, (lines.find((l) => l.variant_id === Number(variantId))?.qty ?? 0) + n),
    remove: (variantId) => set(variantId, 0),
    clear() { lines = []; save(); emit(); },
    syncOwner,
    reconcile,
    emit,
  };
}
