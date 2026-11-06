// Ícono de cuenta + modal de acceso: ingreso, registro y recuperación de
// contraseña. Con la sesión iniciada, el ícono abre el menú de cuenta
// (accountMenu.js: nombre, «Mi cuenta» → /cuenta y «Cerrar sesión»), en todas
// las páginas; nunca va directo a /cuenta.
// La lógica de Supabase vive en ../lib/customerAuth.js y se carga recién
// cuando hace falta (la tienda no espera a supabase-js para mostrarse).
import { escapeHtml } from "../lib/html.js";
import { SESSION_KEY, hasStoredSession } from "../lib/session.js";
import { showToast } from "./ui.js";
import { createAccountMenu } from "./accountMenu.js";

// Casilla de novedades: marcada por defecto (pedido del negocio). Se guarda
// además CÓMO quedó marcada (premarcada sin tocar / marcada por la persona /
// desmarcada) para poder filtrar solo los consentimientos activos si hace falta.
// Para que arranque desmarcada, cambiar a false.
const MARKETING_DEFAULT_CHECKED = true;
const MARKETING_TEXT = "Quiero recibir novedades, promociones y ofertas de Povmatero.";
const CONTACT_EMAIL = "povmatero@gmail.com";

const PASSWORD_MIN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[\d\s()-]{8,25}$/;

const EYE_LABEL = { show: "Mostrar", hide: "Ocultar" };

// Nombre de pila para saludar: sin espacios de más, sin «null»/«undefined», corto.
export function cleanName(value) {
  const t = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!t || /^(null|undefined)$/i.test(t)) return "";
  return t.split(" ")[0].slice(0, 40);
}

export function initAccount() {
  const modal = document.getElementById("accountModal");
  const body = document.getElementById("accountBody");
  const button = document.getElementById("accountBtn");
  if (!modal || !body || !button) return;

  let apiPromise = null;
  let lastFocus = null;
  let renderToken = 0;

  const loadApi = () => {
    apiPromise ??= import("../lib/customerAuth.js").catch((err) => {
      apiPromise = null;
      throw err;
    });
    return apiPromise;
  };

  // ---------- Indicador de sesión en el ícono ----------
  function setSignedIn(value) {
    button.classList.toggle("is-signed-in", value);
    button.setAttribute("aria-label", value ? "Mi cuenta (sesión iniciada)" : "Ingresar o crear cuenta");
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-controls", value ? "accountMenu" : "accountModal");
  }
  setSignedIn(hasStoredSession());

  // Menú de cuenta (con sesión).
  const menu = createAccountMenu({ loadApi });
  function openMenu() {
    close();
    setSignedIn(true);
    menu.open();
  }

  // Después de ingresar o registrarse, la persona sigue en la página donde
  // estaba (con la sesión iniciada); «Mi cuenta» queda en el ícono.
  function stayHere(message) {
    close();
    setSignedIn(true);
    // El carrito suma lo que había como invitado al de esta cuenta (js/components/cart.js).
    document.dispatchEvent(new CustomEvent("povmatero:signed-in"));
    if (message) showToast(message);
  }

  // Se adelanta la descarga al acercar el mouse o el dedo.
  button.addEventListener("pointerenter", () => loadApi().catch(() => {}), { once: true });
  button.addEventListener("touchstart", () => loadApi().catch(() => {}), { once: true, passive: true });
  // Con sesión: el menú de cuenta. Sin sesión: el modal para ingresar.
  button.addEventListener("click", () => (hasStoredSession() ? openMenu() : open()));

  // Pedidos de otras partes de la tienda (página «Mi cuenta», carrito).
  //   detail: { mode: "login" | "signup", notice?: texto para mostrar arriba del formulario }
  document.addEventListener("povmatero:account-login", (e) => {
    const notice = typeof e.detail?.notice === "string" ? { message: e.detail.notice } : null;
    open(() => showAuth(e.detail?.mode === "signup" ? "signup" : "login", { notice }));
  });
  document.addEventListener("povmatero:signed-out", () => setSignedIn(false));

  // ---------- La sesión guardada, ¿sigue valiendo? ----------
  // El ícono se dibuja enseguida con lo guardado en el navegador (sin esperar a
  // supabase-js). Apenas la página termina de cargar se confirma con Supabase:
  // si el token venció se renueva solo (y supabase-js lo sigue renovando
  // mientras la página esté abierta); si la sesión se revocó o ya no existe, se
  // muestra como cerrada en vez de aparentar que sigue iniciada. Sin conexión
  // no se cambia nada (se vuelve a probar más tarde).
  let watching = false;
  function sessionEnded() {
    if (!button.classList.contains("is-signed-in")) return;
    setSignedIn(false);
    document.dispatchEvent(new CustomEvent("povmatero:signed-out", { detail: { reason: "expired" } }));
    showToast("Tu sesión venció. Ingresá de nuevo cuando quieras: tu carrito quedó guardado.");
  }
  async function verifySession() {
    if (!hasStoredSession()) return;
    let api;
    try {
      api = await loadApi();
      const session = await api.getSession();
      if (session) setSignedIn(true);
      else sessionEnded();
    } catch (err) {
      // Si Supabase rechazó la renovación, supabase-js ya borró la sesión.
      if (!hasStoredSession()) sessionEnded();
      else console.warn("Cuenta: no se pudo comprobar la sesión (se reintenta luego).", err);
    }
    if (api && !watching) {
      watching = true;
      // Más adelante (renovación automática fallida): misma respuesta. Un
      // «Cerrar sesión» pedido por la persona no muestra el aviso de vencida.
      api.onAuthChange((event) => {
        if (event === "SIGNED_OUT" && !api.consumeLocalSignOut()) sessionEnded();
      });
    }
  }
  const idle = window.requestIdleCallback ?? ((fn) => setTimeout(fn, 1200));
  if (document.readyState === "complete") idle(verifySession, { timeout: 4000 });
  else window.addEventListener("load", () => idle(verifySession, { timeout: 4000 }), { once: true });
  // Al volver a la pestaña después de un rato, se confirma otra vez.
  let hiddenSince = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") hiddenSince = Date.now();
    else if (hiddenSince && Date.now() - hiddenSince > 5 * 60 * 1000) verifySession();
  });

  // ---------- Saludo al ingresar ----------
  // Nombre de pila del perfil (o el que se cargó al registrarse). Nunca «null»,
  // «undefined» ni el email: si no hay nombre, el saludo va sin nombre.
  async function firstNameOf(api, session) {
    const fromMeta = cleanName(session?.user?.user_metadata?.first_name);
    if (!session?.user?.id) return fromMeta;
    try {
      const profile = await Promise.race([
        api.getProfile(session.user.id),
        new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
      ]);
      return cleanName(profile?.first_name) || fromMeta;
    } catch {
      return fromMeta;
    }
  }

  // ---------- Abrir / cerrar ----------
  function isOpen() { return modal.classList.contains("open"); }

  function open(initialView) {
    if (!isOpen()) {
      lastFocus = document.activeElement;
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
    if (initialView) initialView();
    else showStart();
  }

  function close() {
    if (!isOpen()) return;
    modal.classList.remove("open");
    modal.setAttribute("aria-hidden", "true");
    renderToken++;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  }

  modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-account-close]")) close();
  });

  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Tab") {
      trapFocus(e);
    }
  });

  // El foco no sale del modal mientras está abierto.
  function trapFocus(e) {
    const focusable = [...modal.querySelectorAll("button, a[href], input, select, textarea")]
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function render(html, focusSelector = "input, .account-submit") {
    renderToken++;
    body.innerHTML = html;
    const target = body.querySelector(focusSelector);
    // En celulares no se enfoca un campo de entrada al abrir (abriría el teclado).
    const coarse = window.matchMedia("(pointer: coarse)").matches;
    if (target && !(coarse && target.tagName === "INPUT")) target.focus({ preventScroll: true });
    else body.closest(".account-box")?.focus({ preventScroll: true });
    return renderToken;
  }

  const stillCurrent = (token) => token === renderToken && isOpen();

  // ---------- Vistas ----------
  async function showStart() {
    const token = render(`<p class="account-loading" role="status">Cargando…</p>`, ".account-close");
    try {
      const api = await loadApi();
      const session = await api.getSession();
      if (!stillCurrent(token)) return;
      setSignedIn(Boolean(session));
      if (session) openMenu();
      else showAuth("login");
    } catch (err) {
      console.error(err);
      if (!stillCurrent(token)) return;
      render(`
        <h2 class="account-title" id="accountTitle">MI CUENTA</h2>
        <p class="account-subtitle">No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.</p>
        <button type="button" class="account-submit" data-retry>Reintentar</button>
      `);
      body.querySelector("[data-retry]").onclick = () => showStart();
    }
  }

  function header(subtitle) {
    return `
      <h2 class="account-title" id="accountTitle">MI CUENTA</h2>
      ${subtitle ? `<p class="account-subtitle">${subtitle}</p>` : ""}
    `;
  }

  function tabs(active) {
    return `
      <div class="account-tabs" role="tablist" aria-label="Cuenta">
        <button type="button" class="account-tab" role="tab" data-tab="login" aria-selected="${active === "login"}">Ingresar</button>
        <button type="button" class="account-tab" role="tab" data-tab="signup" aria-selected="${active === "signup"}">Crear cuenta</button>
      </div>
    `;
  }

  function passwordField({ name, label, autocomplete, hint = "" }) {
    return `
      <label class="account-field">
        <span>${label}${hint ? ` <small>${hint}</small>` : ""}</span>
        <div class="account-input-wrap">
          <input type="password" name="${name}" autocomplete="${autocomplete}" required />
          <button type="button" class="account-reveal" data-reveal aria-label="Mostrar contraseña">${EYE_LABEL.show}</button>
        </div>
        <small class="account-field-error" data-error-for="${name}"></small>
      </label>
    `;
  }

  function textField({ name, label, type = "text", autocomplete, hint = "", required = true, inputmode = "", maxlength = 80 }) {
    return `
      <label class="account-field">
        <span>${label}${hint ? ` <small>${hint}</small>` : ""}</span>
        <input type="${type}" name="${name}" autocomplete="${autocomplete}" maxlength="${maxlength}"${required ? " required" : ""}${inputmode ? ` inputmode="${inputmode}"` : ""} />
        <small class="account-field-error" data-error-for="${name}"></small>
      </label>
    `;
  }

  function wireCommon(form) {
    body.querySelectorAll("[data-tab]").forEach((tab) => {
      tab.onclick = () => showAuth(tab.dataset.tab, { email: form?.email?.value });
    });
    body.querySelectorAll("[data-reveal]").forEach((btn) => {
      btn.onclick = () => {
        const input = btn.previousElementSibling;
        const show = input.type === "password";
        input.type = show ? "text" : "password";
        btn.textContent = show ? EYE_LABEL.hide : EYE_LABEL.show;
        btn.setAttribute("aria-label", show ? "Ocultar contraseña" : "Mostrar contraseña");
      };
    });
    // El error de un campo se borra apenas se corrige.
    form?.addEventListener("input", (e) => {
      if (e.target.name) setFieldError(form, e.target.name, "");
    });
  }

  function setFieldError(form, name, message) {
    const input = form.elements[name];
    const slot = form.querySelector(`[data-error-for="${name}"]`);
    if (slot) slot.textContent = message;
    if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function showAlert(form, message, ok = false) {
    const alert = form.querySelector(".account-alert");
    alert.textContent = message;
    alert.classList.toggle("ok", ok);
    alert.hidden = !message;
  }

  function setBusy(form, busy, label) {
    const submit = form.querySelector(".account-submit");
    submit.disabled = busy;
    if (busy) {
      submit.dataset.label = submit.textContent;
      submit.textContent = label;
    } else if (submit.dataset.label) {
      submit.textContent = submit.dataset.label;
    }
  }

  // Valida y devuelve true si todo está bien (marca los campos con error).
  function validate(form, rules) {
    let firstInvalid = null;
    for (const [name, check] of Object.entries(rules)) {
      const message = check(form.elements[name]?.value ?? "");
      setFieldError(form, name, message || "");
      if (message && !firstInvalid) firstInvalid = form.elements[name];
    }
    firstInvalid?.focus();
    return !firstInvalid;
  }

  const rules = {
    email: (v) => !v.trim() ? "Ingresá tu email." : !EMAIL_RE.test(v.trim()) ? "Revisá el email: no parece válido." : "",
    loginPassword: (v) => !v ? "Ingresá tu contraseña." : "",
    newPassword: (v) => v.length < PASSWORD_MIN ? `La contraseña tiene que tener al menos ${PASSWORD_MIN} caracteres.` : "",
    firstName: (v) => !v.trim() ? "Ingresá tu nombre." : "",
    lastName: (v) => !v.trim() ? "Ingresá tu apellido." : "",
    phone: (v) => v.trim() && !PHONE_RE.test(v.trim()) ? "Revisá el teléfono (solo números, espacios, + o guiones)." : "",
  };
  const matches = (form) => (v) => !v ? "Repetí la contraseña." : v !== form.elements.password.value ? "Las contraseñas no coinciden." : "";

  function showAuth(mode, { email = "", notice = null } = {}) {
    if (mode === "signup") return showSignup({ email });

    render(`
      ${header("Ingresá para ver tu cuenta.")}
      ${tabs("login")}
      <form class="account-form" novalidate>
        <p class="account-alert" role="alert" hidden></p>
        ${textField({ name: "email", label: "Email", type: "email", autocomplete: "email", inputmode: "email", maxlength: 254 })}
        ${passwordField({ name: "password", label: "Contraseña", autocomplete: "current-password" })}
        <button type="button" class="account-link" data-forgot>¿Olvidaste tu contraseña?</button>
        <button type="submit" class="account-submit">Ingresar</button>
        <button type="button" class="account-link" data-resend hidden>Reenviar email de confirmación</button>
      </form>
    `);

    const form = body.querySelector("form");
    form.email.value = email ?? "";
    if (email && !window.matchMedia("(pointer: coarse)").matches) form.password.focus({ preventScroll: true });
    wireCommon(form);
    if (notice) showAlert(form, notice.message, notice.ok);

    const resend = form.querySelector("[data-resend]");
    form.querySelector("[data-forgot]").onclick = () => showForgot(form.email.value);

    resend.onclick = async () => {
      if (!validate(form, { email: rules.email })) return;
      resend.disabled = true;
      try {
        const api = await loadApi();
        await api.resendConfirmation(form.email.value.trim());
        showAlert(form, "Listo: te reenviamos el email de confirmación.", true);
      } catch (err) {
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
      } finally {
        resend.disabled = false;
      }
    };

    form.onsubmit = async (e) => {
      e.preventDefault();
      showAlert(form, "");
      if (!validate(form, { email: rules.email, password: rules.loginPassword })) return;
      setBusy(form, true, "Ingresando…");
      try {
        const api = await loadApi();
        const session = await api.signIn(form.email.value.trim(), form.password.value);
        form.password.value = "";
        // Volver a ingresar (cuenta que ya existía): saludo con el nombre del perfil.
        const name = await firstNameOf(api, session);
        stayHere(name ? `¡Hola de nuevo, ${name}!` : "¡Hola de nuevo!");
      } catch (err) {
        console.warn(err);
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
        resend.hidden = !(err?.code === "email_not_confirmed" || /not confirmed/i.test(err?.message ?? ""));
        setBusy(form, false);
      }
    };
  }

  function showSignup({ email = "" } = {}) {
    render(`
      ${header("Creá tu cuenta en un minuto.")}
      ${tabs("signup")}
      <form class="account-form" novalidate>
        <p class="account-alert" role="alert" hidden></p>
        <div class="account-row">
          ${textField({ name: "firstName", label: "Nombre", autocomplete: "given-name" })}
          ${textField({ name: "lastName", label: "Apellido", autocomplete: "family-name" })}
        </div>
        ${textField({ name: "email", label: "Email", type: "email", autocomplete: "email", inputmode: "email", maxlength: 254 })}
        ${textField({ name: "phone", label: "Teléfono", type: "tel", autocomplete: "tel", inputmode: "tel", hint: "(opcional)", required: false, maxlength: 25 })}
        ${passwordField({ name: "password", label: "Contraseña", autocomplete: "new-password", hint: `(mínimo ${PASSWORD_MIN} caracteres)` })}
        ${passwordField({ name: "password2", label: "Repetir contraseña", autocomplete: "new-password" })}
        <label class="account-check">
          <input type="checkbox" name="marketing"${MARKETING_DEFAULT_CHECKED ? " checked" : ""} />
          <span>${escapeHtml(MARKETING_TEXT)}<small>Podés darte de baja cuando quieras desde tu cuenta.</small></span>
        </label>
        <button type="submit" class="account-submit">Crear cuenta</button>
        <p class="account-legal">
          Usamos tus datos solo para gestionar tu cuenta y tus pedidos${MARKETING_DEFAULT_CHECKED ? " y, si lo aceptás, para enviarte novedades" : ""}.
          Podés pedir que los corrijamos o eliminemos escribiendo a
          <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>.
        </p>
      </form>
    `);

    const form = body.querySelector("form");
    form.email.value = email ?? "";
    wireCommon(form);

    // ¿La persona tocó la casilla? (para registrar cómo dio su consentimiento)
    let marketingTouched = false;
    form.marketing.addEventListener("change", () => { marketingTouched = true; });

    form.onsubmit = async (e) => {
      e.preventDefault();
      showAlert(form, "");
      const ok = validate(form, {
        firstName: rules.firstName,
        lastName: rules.lastName,
        email: rules.email,
        phone: rules.phone,
        password: rules.newPassword,
        password2: matches(form),
      });
      if (!ok) return;

      const optIn = form.marketing.checked;
      const method = !optIn ? "signup_unchecked"
        : (MARKETING_DEFAULT_CHECKED && !marketingTouched) ? "signup_prechecked"
        : "signup_checked";
      const emailValue = form.email.value.trim();

      setBusy(form, true, "Creando cuenta…");
      try {
        const api = await loadApi();
        const result = await api.signUp({
          email: emailValue,
          password: form.password.value,
          firstName: form.firstName.value.trim(),
          lastName: form.lastName.value.trim(),
          phone: form.phone.value.trim(),
          marketingOptIn: optIn,
          marketingMethod: method,
          marketingText: MARKETING_TEXT,
        });
        if (result.alreadyRegistered) {
          showAuth("login", {
            email: emailValue,
            notice: { message: "Ya existe una cuenta con ese email. Ingresá con tu contraseña o recuperala." },
          });
          return;
        }
        if (result.session) {
          // Primer registro: bienvenida (no «hola de nuevo»).
          const name = cleanName(form.firstName.value);
          stayHere(name ? `¡Te damos la bienvenida, ${name}! Tu cuenta ya está creada.` : "¡Listo! Tu cuenta ya está creada.");
          return;
        }
        showCheckEmail(emailValue);
      } catch (err) {
        console.warn(err);
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
        setBusy(form, false);
      }
    };
  }

  function showCheckEmail(email) {
    render(`
      ${header(`Te enviamos un email a <strong>${escapeHtml(email)}</strong> para confirmar tu cuenta.`)}
      <div class="account-form">
        <p class="account-alert ok" role="status">Abrí el enlace del email y vas a volver a la tienda con tu sesión iniciada. Si no lo ves en unos minutos, revisá spam o promociones.</p>
        <button type="button" class="account-secondary" data-resend>Reenviar email</button>
        <button type="button" class="account-link" data-login>Ya confirmé: ingresar</button>
      </div>
    `, ".account-secondary");
    const alert = body.querySelector(".account-alert");
    const resend = body.querySelector("[data-resend]");
    body.querySelector("[data-login]").onclick = () => showAuth("login", { email });
    resend.onclick = async () => {
      resend.disabled = true;
      try {
        const api = await loadApi();
        await api.resendConfirmation(email);
        alert.textContent = "Te reenviamos el email. Puede tardar unos minutos en llegar.";
        alert.className = "account-alert ok";
      } catch (err) {
        const api = await loadApi().catch(() => null);
        alert.textContent = api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.";
        alert.className = "account-alert";
      } finally {
        resend.disabled = false;
      }
    };
  }

  function showForgot(email = "") {
    render(`
      ${header("Te enviamos un enlace para que elijas una contraseña nueva.")}
      <form class="account-form" novalidate>
        <p class="account-alert" role="alert" hidden></p>
        ${textField({ name: "email", label: "Email", type: "email", autocomplete: "email", inputmode: "email", maxlength: 254 })}
        <button type="submit" class="account-submit">Enviar enlace</button>
        <button type="button" class="account-link" data-back>Volver a ingresar</button>
      </form>
    `);
    const form = body.querySelector("form");
    form.email.value = email ?? "";
    wireCommon(form);
    form.querySelector("[data-back]").onclick = () => showAuth("login", { email: form.email.value });
    form.onsubmit = async (e) => {
      e.preventDefault();
      showAlert(form, "");
      if (!validate(form, { email: rules.email })) return;
      setBusy(form, true, "Enviando…");
      try {
        const api = await loadApi();
        await api.requestPasswordReset(form.email.value.trim());
        // Mismo mensaje exista o no la cuenta (no se revela quién está registrado).
        showAlert(form, "Si hay una cuenta con ese email, te llegará un enlace en unos minutos. Revisá también spam.", true);
      } catch (err) {
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
      } finally {
        setBusy(form, false);
      }
    };
  }

  function showNewPassword() {
    render(`
      ${header("Elegí tu nueva contraseña.")}
      <form class="account-form" novalidate>
        <p class="account-alert" role="alert" hidden></p>
        ${passwordField({ name: "password", label: "Nueva contraseña", autocomplete: "new-password", hint: `(mínimo ${PASSWORD_MIN} caracteres)` })}
        ${passwordField({ name: "password2", label: "Repetir contraseña", autocomplete: "new-password" })}
        <button type="submit" class="account-submit">Guardar contraseña</button>
      </form>
    `);
    const form = body.querySelector("form");
    wireCommon(form);
    form.onsubmit = async (e) => {
      e.preventDefault();
      showAlert(form, "");
      if (!validate(form, { password: rules.newPassword, password2: matches(form) })) return;
      setBusy(form, true, "Guardando…");
      try {
        const api = await loadApi();
        await api.updatePassword(form.password.value);
        const session = await api.getSession();
        if (session) stayHere("Listo: tu contraseña quedó actualizada.");
        else showAuth("login", { notice: { message: "Contraseña actualizada. Ya podés ingresar.", ok: true } });
      } catch (err) {
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
        setBusy(form, false);
      }
    };
  }

  // ---------- Vuelta desde un email (confirmación o recuperación) ----------
  async function handleRedirect() {
    const hash = location.hash;
    if (!/(^|[#&])(access_token|error_description|error_code)=/.test(hash)) return;
    // Se quitan los tokens de la barra de direcciones enseguida.
    history.replaceState(null, "", location.pathname + location.search);
    try {
      const api = await loadApi();
      const result = await api.handleAuthRedirect(hash);
      if (!result) return;
      if (result.error) {
        open(() => showAuth("login", { notice: { message: api.authErrorMessage(result.error) } }));
        return;
      }
      setSignedIn(true);
      if (result.type === "recovery") {
        open(() => showNewPassword());
      } else {
        const session = await api.getSession();
        // Confirmación del email = primer ingreso de la cuenta: bienvenida.
        const name = session ? await firstNameOf(api, session) : "";
        const message = result.type === "signup"
          ? (name ? `¡Te damos la bienvenida, ${name}! Tu email quedó confirmado y ya ingresaste.` : "¡Listo! Tu email quedó confirmado y ya ingresaste.")
          : (name ? `¡Hola de nuevo, ${name}!` : "Ya ingresaste.");
        if (session) stayHere(message);
        else open(() => showAuth("login"));
      }
    } catch (err) {
      console.error(err);
      open(() => showAuth("login", { notice: { message: "No pudimos validar el enlace. Probá ingresar de nuevo." } }));
    }
  }

  // Sesión cerrada o iniciada en otra pestaña (o expirada): se actualiza el ícono.
  window.addEventListener("storage", (e) => {
    if (e.key === SESSION_KEY) setSignedIn(Boolean(e.newValue));
  });

  handleRedirect();
}
