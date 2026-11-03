// Menú de cuenta: lo abre el ícono de persona cuando hay una sesión iniciada,
// en todas las páginas (tienda, «Mi cuenta», productos y /yerbas). Tiene el
// nombre del cliente, «Mi cuenta» (va a /cuenta) y «Cerrar sesión».
// Sin sesión, el ícono sigue abriendo el ingreso de siempre (account.js).
// No depende del rol: clientes y administradores ven lo mismo.
import { SESSION_KEY } from "../lib/session.js";
import { showToast } from "./ui.js";

// «agustin acevedo» → «Agustin Acevedo»: solo la primera letra de cada palabra
// pasa a mayúscula; el resto queda como lo escribió la persona.
export function displayName(firstName, lastName) {
  const cap = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean)
    .map((w) => w.split("-").map((p) => (p ? p[0].toLocaleUpperCase("es") + p.slice(1) : p)).join("-"))
    .join(" ");
  return [cap(firstName), cap(lastName)].filter(Boolean).join(" ");
}

function storedUser() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null")?.user ?? null; } catch { return null; }
}

const MARKUP = `
  <div class="account-overlay" data-menu-close></div>
  <div class="account-box" role="dialog" aria-modal="true" aria-labelledby="accountMenuTitle" tabindex="-1">
    <button type="button" class="account-close" aria-label="Cerrar" data-menu-close>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="16" height="16" aria-hidden="true">
        <line x1="18" y1="6" x2="6" y2="18"/>
        <line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
    <p class="account-title account-menu-title" id="accountMenuTitle">TU CUENTA</p>
    <p class="account-menu-email" id="accountMenuEmail" data-menu-email></p>
    <a class="account-submit account-menu-account" href="/cuenta" data-menu-account>Mi cuenta</a>
    <button type="button" class="account-logout account-menu-logout" data-menu-logout>Cerrar sesión</button>
  </div>`;

/**
 * Crea el menú (una vez) y devuelve { open, close, isOpen }.
 * loadApi: carga js/lib/customerAuth.js (la misma promesa que usa account.js).
 */
export function createAccountMenu({ loadApi }) {
  let menu = document.getElementById("accountMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.className = "account-modal account-menu";
    menu.id = "accountMenu";
    menu.setAttribute("aria-hidden", "true");
    menu.innerHTML = MARKUP;
    document.body.append(menu);
  }
  const title = menu.querySelector("#accountMenuTitle");
  const email = menu.querySelector("[data-menu-email]");
  const names = new Map();   // user id → nombre del perfil (se actualiza en cada apertura)
  let returnFocus = null;
  let token = 0;

  const isOpen = () => menu.classList.contains("open");

  function setTitle(name) {
    title.textContent = name || "TU CUENTA";
    title.classList.toggle("is-name", Boolean(name));
  }

  async function fillName() {
    const mine = ++token;
    const user = storedUser();
    email.textContent = user?.email ?? "";
    const meta = user?.user_metadata ?? {};
    setTitle(names.get(user?.id) ?? displayName(meta.first_name, meta.last_name));
    if (!user?.id) return;
    // El perfil manda («Mis datos» puede haber cambiado el nombre del registro).
    try {
      const api = await loadApi();
      const profile = await api.getProfile(user.id);
      if (mine !== token) return;
      const name = displayName(profile?.first_name, profile?.last_name);
      if (name) { names.set(user.id, name); setTitle(name); }
    } catch (err) {
      console.warn("Cuenta: no se pudo leer el nombre.", err);
    }
  }

  function open() {
    if (!isOpen()) {
      returnFocus = document.activeElement;
      menu.classList.add("open");
      menu.setAttribute("aria-hidden", "false");
    }
    fillName();
    requestAnimationFrame(() => menu.querySelector("[data-menu-account]")?.focus({ preventScroll: true }));
  }

  function close({ restoreFocus = true } = {}) {
    if (!isOpen()) return;
    token++;
    menu.classList.remove("open");
    menu.setAttribute("aria-hidden", "true");
    if (restoreFocus && returnFocus?.focus) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }

  menu.addEventListener("click", async (e) => {
    if (e.target.closest("[data-menu-close]")) return close();
    if (e.target.closest("[data-menu-account]")) {
      // En la tienda, /cuenta se abre sin recargar (js/router.js); en /yerbas,
      // el aviso «povmatero:navigate» lleva a la tienda.
      e.preventDefault();
      close({ restoreFocus: false });
      document.dispatchEvent(new CustomEvent("povmatero:navigate", { detail: { path: "/cuenta" } }));
      return;
    }
    const logout = e.target.closest("[data-menu-logout]");
    if (!logout || logout.disabled) return;
    logout.disabled = true;
    try {
      const api = await loadApi();
      await api.signOut();
      close();
      document.dispatchEvent(new CustomEvent("povmatero:signed-out"));
      showToast("Cerraste sesión.");
    } catch (err) {
      console.warn(err);
      showToast("No pudimos cerrar la sesión. Intentá de nuevo.");
    } finally {
      logout.disabled = false;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "Tab") {
      const f = [...menu.querySelectorAll("a[href], button")].filter((el) => !el.disabled && el.offsetParent);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
      else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
    }
  });

  // Sesión cerrada por otro lado (otra pestaña, «Mi cuenta», el panel): se cierra.
  document.addEventListener("povmatero:signed-out", () => close({ restoreFocus: false }));
  window.addEventListener("storage", (e) => { if (e.key === SESSION_KEY && !e.newValue) close({ restoreFocus: false }); });

  return { open, close, isOpen };
}
