// Modal «Mi cuenta»: registro, ingreso, recuperación de contraseña y datos del
// cliente. La lógica de Supabase vive en ../lib/customerAuth.js y se carga recién
// cuando hace falta (la tienda no espera a supabase-js para mostrarse).
import { escapeHtml } from "../lib/html.js";
import { SUPABASE_URL } from "../lib/supabaseConfig.js";

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

// Clave en la que supabase-js guarda la sesión (sb-<proyecto>-auth-token).
const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

const EYE_LABEL = { show: "Mostrar", hide: "Ocultar" };

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
  function hasStoredSession() {
    try { return Boolean(localStorage.getItem(SESSION_KEY)); } catch { return false; }
  }
  function setSignedIn(value) {
    button.classList.toggle("is-signed-in", value);
    button.setAttribute("aria-label", value ? "Mi cuenta (sesión iniciada)" : "Ingresar o crear cuenta");
  }
  setSignedIn(hasStoredSession());

  // Se adelanta la descarga al acercar el mouse o el dedo.
  button.addEventListener("pointerenter", () => loadApi().catch(() => {}), { once: true });
  button.addEventListener("touchstart", () => loadApi().catch(() => {}), { once: true, passive: true });
  button.addEventListener("click", () => open());

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
      if (session) await showAccount(session);
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
        setSignedIn(true);
        await showAccount(session, { message: "¡Hola de nuevo! Ya ingresaste.", ok: true });
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
          setSignedIn(true);
          await showAccount(result.session, { message: "¡Listo! Tu cuenta ya está creada.", ok: true });
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
        if (session) await showAccount(session, { message: "Listo: tu contraseña quedó actualizada.", ok: true });
        else showAuth("login", { notice: { message: "Contraseña actualizada. Ya podés ingresar.", ok: true } });
      } catch (err) {
        const api = await loadApi().catch(() => null);
        showAlert(form, api ? api.authErrorMessage(err) : "No pudimos conectarnos. Intentá de nuevo.");
        setBusy(form, false);
      }
    };
  }

  async function showAccount(session, notice = null) {
    const token = render(`<p class="account-loading" role="status">Cargando tu cuenta…</p>`, ".account-close");
    const api = await loadApi();
    const user = session.user;
    const [profile, admin] = await Promise.all([api.getProfile(user.id), api.isAdmin(user.id)]);
    if (!stillCurrent(token)) return;

    const name = profile?.first_name?.trim();
    render(`
      ${header(name ? `Hola, <strong>${escapeHtml(name)}</strong>.` : "Hola.")}
      <div class="account-profile">
        ${notice ? `<p class="account-alert${notice.ok ? " ok" : ""}" role="status">${escapeHtml(notice.message)}</p>` : ""}
        <p class="account-email">${escapeHtml(user.email ?? "")}</p>
        ${profile ? `
          <div class="account-card">
            <label class="account-check">
              <input type="checkbox" name="marketing"${profile.marketing_opt_in ? " checked" : ""} />
              <span>${escapeHtml(MARKETING_TEXT)}</span>
            </label>
            <p class="account-status" role="status" aria-live="polite"></p>
          </div>
        ` : ""}
        ${admin ? `<a class="account-secondary account-admin" href="/admin/">Ir al panel de administración</a>` : ""}
        <button type="button" class="account-secondary" data-logout>Cerrar sesión</button>
      </div>
    `, admin ? ".account-admin" : "[data-logout]");

    const marketing = body.querySelector('input[name="marketing"]');
    const status = body.querySelector(".account-status");
    if (marketing) {
      marketing.onchange = async () => {
        const wanted = marketing.checked;
        marketing.disabled = true;
        status.textContent = "Guardando…";
        try {
          const saved = await api.setMarketingOptIn(user.id, wanted);
          marketing.checked = saved;
          status.textContent = saved ? "Listo: vas a recibir nuestras novedades." : "Listo: no vas a recibir más novedades.";
        } catch (err) {
          console.warn(err);
          marketing.checked = !wanted;
          status.textContent = "No pudimos guardar el cambio. Intentá de nuevo.";
        } finally {
          marketing.disabled = false;
        }
      };
    }

    body.querySelector("[data-logout]").onclick = async (e) => {
      e.currentTarget.disabled = true;
      try { await api.signOut(); } catch (err) { console.warn(err); }
      setSignedIn(false);
      showAuth("login", { notice: { message: "Cerraste sesión.", ok: true } });
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
        const message = result.type === "signup" ? "¡Listo! Tu email quedó confirmado y ya ingresaste." : "Ya ingresaste.";
        open(() => (session ? showAccount(session, { message, ok: true }) : showAuth("login")));
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
