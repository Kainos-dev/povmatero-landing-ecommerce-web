// Página «Mi cuenta» (/cuenta): Mis datos, Preferencias y Mis pedidos.
// La arma js/router.js. Se carga recién cuando hace falta, junto con supabase-js.
//
// Los permisos los decide la base (RLS): cada cliente lee y edita solo su perfil
// y ve solo sus pedidos. El navegador nunca elige de quién son los datos.
import { escapeHtml } from "../lib/html.js";
import * as api from "../lib/customerAuth.js";

const SECTIONS = [
  ["datos", "Mis datos"],
  ["preferencias", "Preferencias"],
  ["pedidos", "Mis pedidos"],
];
const MARKETING_TEXT = "Quiero recibir novedades, promociones y ofertas de Povmatero.";
const PHONE_RE = /^\+?[\d\s()-]{8,25}$/;
const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "long", year: "numeric" });
const TIME = new Intl.DateTimeFormat("es-AR", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

const money = (n) => "$" + Number(n).toLocaleString("es-AR", { maximumFractionDigits: 2 });

// Pedidos de yerbas: estado que ve el cliente (los de la tienda no tienen estados).
const YERBA_STATUS = {
  pendiente:  ["Pendiente de confirmación", ""],
  confirmado: ["Confirmado", "ok"],
  preparando: ["En preparación", "ok"],
  listo:      ["Listo", "ok"],
  entregado:  ["Entregado", "done"],
  cancelado:  ["Cancelado", "off"],
};
function orderTag(o) {
  if (o.kind !== "yerbas") return `<span class="acc-order-tag">Enviado por WhatsApp</span>`;
  const expired = o.status === "pendiente" && o.expires_at && new Date(o.expires_at) <= new Date();
  const [label, tone] = expired ? ["Reserva vencida", "off"] : (YERBA_STATUS[o.status] ?? [o.status ?? "", ""]);
  return `<span class="acc-order-tag acc-order-tag--${tone || "wait"}">${escapeHtml(label)}</span>`;
}

let unsubscribe = null;
let renderToken = 0;

function sectionFromUrl() {
  const s = new URLSearchParams(location.search).get("seccion");
  return SECTIONS.some(([k]) => k === s) ? s : "datos";
}

// Pide al modal de cuenta que abra el ingreso o el registro (ver account.js).
function askLogin(mode) {
  document.dispatchEvent(new CustomEvent("povmatero:account-login", { detail: { mode } }));
}

// notice: { message, ok } que llega desde el ingreso, el registro o un email.
export async function renderAccountPage(root, { notice = null } = {}) {
  const token = ++renderToken;
  root.innerHTML = `<p class="acc-loading" role="status">Cargando tu cuenta…</p>`;

  // Si la sesión cambia (ingreso, cierre en otra pestaña o vencimiento), se
  // redibuja. Solo cuando cambia de verdad: supabase-js repite SIGNED_IN al volver
  // a la pestaña, y redibujar ahí borraría lo que se está escribiendo.
  let shownSignedIn = null;
  unsubscribe?.();
  unsubscribe = api.onAuthChange((event) => {
    if (!document.documentElement.classList.contains("route-account") || shownSignedIn === null) return;
    if ((event === "SIGNED_OUT" && shownSignedIn) || (event === "SIGNED_IN" && !shownSignedIn)) renderAccountPage(root);
  });

  let session;
  try {
    session = await api.getSession();
  } catch (err) {
    console.error(err);
    if (token !== renderToken) return;
    root.innerHTML = `
      <div class="acc-empty">
        <p>No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.</p>
        <button type="button" class="acc-btn" data-retry>Reintentar</button>
      </div>`;
    root.querySelector("[data-retry]").onclick = () => renderAccountPage(root);
    return;
  }
  if (token !== renderToken) return;
  shownSignedIn = Boolean(session);

  if (!session) {
    root.innerHTML = `
      <header class="acc-head">
        <p class="acc-eyebrow">MI CUENTA</p>
        <h1 class="acc-title">Ingresá para ver tu cuenta</h1>
        <p class="acc-lead">Tus datos, tus preferencias y los pedidos que hiciste, en un solo lugar.</p>
      </header>
      <div class="acc-actions">
        <button type="button" class="acc-btn" data-login>Ingresar</button>
        <button type="button" class="acc-btn acc-btn-ghost" data-signup>Crear cuenta</button>
      </div>`;
    root.querySelector("[data-login]").onclick = () => askLogin("login");
    root.querySelector("[data-signup]").onclick = () => askLogin("signup");
    return;
  }

  const user = session.user;
  let profile, admin;
  try {
    [profile, admin] = await Promise.all([api.getProfile(user.id), api.isAdmin(user.id)]);
  } catch (err) {
    console.error(err);
  }
  if (token !== renderToken) return;

  let current = sectionFromUrl();
  const firstName = profile?.first_name?.trim();

  root.innerHTML = `
    <header class="acc-head">
      <p class="acc-eyebrow">MI CUENTA</p>
      <h1 class="acc-title">${firstName ? `Hola, ${escapeHtml(firstName)}.` : "Hola."}</h1>
      <p class="acc-lead">${escapeHtml(user.email ?? "")}</p>
    </header>
    ${notice ? `<p class="acc-notice${notice.ok ? " ok" : ""}" role="status">${escapeHtml(notice.message)}</p>` : ""}
    <nav class="acc-tabs" role="tablist" aria-label="Secciones de tu cuenta">
      ${SECTIONS.map(([key, label]) => `<button type="button" class="acc-tab" role="tab" id="acc-tab-${key}" aria-controls="acc-panel-${key}" data-section="${key}">${label}</button>`).join("")}
    </nav>
    <section class="acc-panel" id="acc-panel-datos" role="tabpanel" aria-labelledby="acc-tab-datos"></section>
    <section class="acc-panel" id="acc-panel-preferencias" role="tabpanel" aria-labelledby="acc-tab-preferencias"></section>
    <section class="acc-panel" id="acc-panel-pedidos" role="tabpanel" aria-labelledby="acc-tab-pedidos"></section>
    ${admin ? `<div class="acc-foot"><a class="acc-btn acc-btn-ghost" href="/admin/">Ir al panel de administración</a></div>` : ""}`;

  const panels = Object.fromEntries(SECTIONS.map(([k]) => [k, root.querySelector(`#acc-panel-${k}`)]));
  const loaded = new Set();

  function select(key, { focus = false } = {}) {
    current = key;
    root.querySelectorAll(".acc-tab").forEach((tab) => {
      const on = tab.dataset.section === key;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    for (const [k, panel] of Object.entries(panels)) panel.hidden = k !== key;
    // La sección queda en la dirección (para volver o compartir el enlace).
    const url = key === "datos" ? "/cuenta" : `/cuenta?seccion=${key}`;
    if (location.pathname + location.search !== url) history.replaceState(history.state, "", url);
    if (!loaded.has(key)) {
      loaded.add(key);
      if (key === "datos") renderData(panels.datos, user, profile, (p) => { profile = p; refreshGreeting(); }, logout);
      if (key === "preferencias") renderPreferences(panels.preferencias, user, profile);
      if (key === "pedidos") renderOrders(panels.pedidos);
    }
  }

  function refreshGreeting() {
    const name = profile?.first_name?.trim();
    root.querySelector(".acc-title").textContent = name ? `Hola, ${name}.` : "Hola.";
  }

  root.querySelectorAll(".acc-tab").forEach((tab) => {
    tab.onclick = () => select(tab.dataset.section);
    tab.onkeydown = (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const i = SECTIONS.findIndex(([k]) => k === current);
      const next = SECTIONS[(i + (e.key === "ArrowRight" ? 1 : SECTIONS.length - 1)) % SECTIONS.length][0];
      select(next, { focus: true });
    };
  });

  // «Cerrar sesión» está en «Mis datos» (mismo estilo ghost que el menú de cuenta).
  async function logout(e) {
    e.currentTarget.disabled = true;
    try { await api.signOut(); } catch (err) { console.warn(err); }
    document.dispatchEvent(new CustomEvent("povmatero:signed-out"));
    renderAccountPage(root, { notice: { message: "Cerraste sesión.", ok: true } });
  }

  select(current);
}

// ---------------------------------------------------------------------
// Mis datos
// ---------------------------------------------------------------------
const LOGOUT_BUTTON = `<button type="button" class="account-logout acc-logout" data-logout>Cerrar sesión</button>`;

function renderData(panel, user, profile, onSaved, onLogout) {
  if (!profile) {
    panel.innerHTML = `
      <div class="acc-card">
        <div class="acc-card-top"><h2>Mis datos</h2>${LOGOUT_BUTTON}</div>
        <p class="acc-muted">No encontramos los datos de tu cuenta. Escribinos por WhatsApp y lo resolvemos.</p>
      </div>`;
    panel.querySelector("[data-logout]").onclick = onLogout;
    return;
  }
  panel.innerHTML = `
    <form class="acc-card acc-form" novalidate>
      <div class="acc-card-top">
        <div class="acc-card-head">
          <h2>Mis datos</h2>
          <p class="acc-muted">Los usamos para identificar tus pedidos y contactarte por WhatsApp.</p>
        </div>
        ${LOGOUT_BUTTON}
      </div>
      <div class="account-row">
        <label class="account-field">
          <span>Nombre</span>
          <input name="firstName" autocomplete="given-name" maxlength="80" required />
          <small class="account-field-error" data-error-for="firstName"></small>
        </label>
        <label class="account-field">
          <span>Apellido</span>
          <input name="lastName" autocomplete="family-name" maxlength="80" required />
          <small class="account-field-error" data-error-for="lastName"></small>
        </label>
      </div>
      <label class="account-field">
        <span>Teléfono <small>(opcional, para coordinar por WhatsApp)</small></span>
        <input name="phone" type="tel" inputmode="tel" autocomplete="tel" maxlength="25" />
        <small class="account-field-error" data-error-for="phone"></small>
      </label>
      <div class="account-field">
        <span>Email</span>
        <p class="acc-static">${escapeHtml(user.email ?? "")}</p>
        <small class="account-hint">Es el email con el que ingresás. Si necesitás cambiarlo, escribinos.</small>
      </div>
      <p class="account-alert" role="status" hidden></p>
      <button type="submit" class="account-submit" disabled>Guardar cambios</button>
    </form>`;

  const form = panel.querySelector("form");
  panel.querySelector("[data-logout]").onclick = onLogout;
  const submit = form.querySelector(".account-submit");
  const alert = form.querySelector(".account-alert");
  form.firstName.value = profile.first_name ?? "";
  form.lastName.value = profile.last_name ?? "";
  form.phone.value = profile.phone ?? "";

  const setError = (name, message) => {
    form.querySelector(`[data-error-for="${name}"]`).textContent = message;
    form.elements[name].setAttribute("aria-invalid", message ? "true" : "false");
  };
  form.addEventListener("input", (e) => {
    if (e.target.name) setError(e.target.name, "");
    submit.disabled = false;
    alert.hidden = true;
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const firstName = form.firstName.value.trim();
    const lastName = form.lastName.value.trim();
    const phone = form.phone.value.trim();
    const errors = {
      firstName: firstName ? "" : "Ingresá tu nombre.",
      lastName: lastName ? "" : "Ingresá tu apellido.",
      phone: phone && !PHONE_RE.test(phone) ? "Revisá el teléfono (solo números, espacios, + o guiones)." : "",
    };
    Object.entries(errors).forEach(([k, m]) => setError(k, m));
    const first = Object.keys(errors).find((k) => errors[k]);
    if (first) { form.elements[first].focus(); return; }

    submit.disabled = true;
    submit.textContent = "Guardando…";
    try {
      const saved = await api.updateProfile(user.id, { firstName, lastName, phone });
      onSaved(saved);
      alert.textContent = "Listo: tus datos quedaron guardados.";
      alert.className = "account-alert ok";
      alert.hidden = false;
      submit.textContent = "Guardar cambios";
    } catch (err) {
      console.warn(err);
      alert.textContent = api.authErrorMessage(err) === "Algo salió mal. Intentá de nuevo en unos minutos."
        ? "No pudimos guardar tus datos. Intentá de nuevo."
        : api.authErrorMessage(err);
      alert.className = "account-alert";
      alert.hidden = false;
      submit.disabled = false;
      submit.textContent = "Guardar cambios";
    }
  };
}

// ---------------------------------------------------------------------
// Preferencias
// ---------------------------------------------------------------------
function renderPreferences(panel, user, profile) {
  if (!profile) {
    panel.innerHTML = `<div class="acc-card"><p class="acc-muted">No encontramos los datos de tu cuenta. Escribinos por WhatsApp y lo resolvemos.</p></div>`;
    return;
  }
  panel.innerHTML = `
    <div class="acc-card">
      <div class="acc-card-head">
        <h2>Preferencias</h2>
      </div>
      <label class="acc-switch-row">
        <span class="acc-switch-text">
          <strong>Novedades por email</strong>
          <span>${escapeHtml(MARKETING_TEXT)}</span>
        </span>
        <span class="acc-switch">
          <input type="checkbox" role="switch" name="marketing"${profile.marketing_opt_in ? " checked" : ""} />
          <span class="acc-switch-track" aria-hidden="true"></span>
        </span>
      </label>
      <p class="acc-switch-state" role="status" aria-live="polite"></p>
    </div>`;

  const input = panel.querySelector('input[name="marketing"]');
  const state = panel.querySelector(".acc-switch-state");
  const describe = (on) => (on ? "Estás suscripto: te vamos a enviar novedades." : "No estás suscripto: no te vamos a enviar novedades.");
  state.textContent = describe(input.checked);

  // Se guarda apenas se toca (y queda registrado cuándo y cómo se cambió).
  input.onchange = async () => {
    const wanted = input.checked;
    input.disabled = true;
    state.textContent = "Guardando…";
    try {
      const saved = await api.setMarketingOptIn(user.id, wanted);
      input.checked = saved;
      profile.marketing_opt_in = saved;
      state.textContent = saved ? "Listo: vas a recibir nuestras novedades." : "Listo: te diste de baja. No vas a recibir más novedades.";
    } catch (err) {
      console.warn(err);
      input.checked = !wanted;
      state.textContent = "No pudimos guardar el cambio. Intentá de nuevo.";
    } finally {
      input.disabled = false;
    }
  };
}

// ---------------------------------------------------------------------
// Mis pedidos
// ---------------------------------------------------------------------
async function renderOrders(panel) {
  panel.innerHTML = `<p class="acc-loading" role="status">Cargando tus pedidos…</p>`;
  let orders;
  try {
    orders = await api.listMyOrders();
  } catch (err) {
    console.error(err);
    panel.innerHTML = `
      <div class="acc-card">
        <p class="acc-muted">No pudimos cargar tus pedidos. Intentá de nuevo en unos minutos.</p>
        <button type="button" class="account-secondary" data-retry>Reintentar</button>
      </div>`;
    panel.querySelector("[data-retry]").onclick = () => renderOrders(panel);
    return;
  }

  if (!orders.length) {
    panel.innerHTML = `
      <div class="acc-card acc-orders-empty">
        <h2>Todavía no hay pedidos</h2>
        <p class="acc-muted">Cuando envíes un pedido por WhatsApp con tu sesión iniciada, va a quedar guardado acá.</p>
        <a class="account-submit acc-link-btn" href="/#productos">Ver productos</a>
        <a class="account-secondary acc-link-btn" href="/yerbas">Pedir yerbas</a>
      </div>`;
    return;
  }

  panel.innerHTML = `
    <p class="acc-orders-note">Estos son los pedidos que enviaste por WhatsApp. El pago y la entrega se coordinan por ese medio.</p>
    <ol class="acc-orders">
      ${orders.map((o) => {
        const date = new Date(o.created_at);
        const items = o.order_items ?? [];
        return `
          <li class="acc-card acc-order">
            <div class="acc-order-head">
              <div>
                <h2>${o.kind === "yerbas" ? "Yerbas · " : ""}Pedido #${escapeHtml(String(o.id))}</h2>
                <p class="acc-muted"><time datetime="${escapeHtml(o.created_at)}">${escapeHtml(DATE.format(date))} · ${escapeHtml(TIME.format(date))}</time></p>
              </div>
              ${orderTag(o)}
            </div>
            <ul class="acc-order-items">
              ${items.map((i) => `
                <li>
                  <span class="acc-qty">${escapeHtml(String(i.quantity))}×</span>
                  <span class="acc-item-name">${escapeHtml(i.product_name)}${i.variant_name ? ` <small>${escapeHtml(i.variant_name)}</small>` : ""}</span>
                  <span class="acc-item-total">${money(i.line_total)}</span>
                </li>`).join("")}
            </ul>
            <div class="acc-order-total"><span>Total</span><strong>${money(o.total)}</strong></div>
          </li>`;
      }).join("")}
    </ol>`;
}

// Al salir de /cuenta se deja de escuchar la sesión.
export function leaveAccountPage() {
  renderToken++;
  unsubscribe?.();
  unsubscribe = null;
}
