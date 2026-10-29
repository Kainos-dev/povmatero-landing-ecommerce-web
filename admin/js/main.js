import { getCurrentUser, signIn, signOut, getAdminRole, onSignedOut } from "./auth.js";
import { startRouter, stopRouter } from "./router.js";

const views = {
  loading: document.getElementById("viewLoading"),
  login:   document.getElementById("viewLogin"),
  panel:   document.getElementById("viewPanel"),
};

const loginForm   = document.getElementById("loginForm");
const loginButton = document.getElementById("loginButton");
const loginError  = document.getElementById("loginError");
const userEmail   = document.getElementById("userEmail");
const userRole    = document.getElementById("userRole");
const logoutBtn   = document.getElementById("logoutButton");

const ROLE_LABELS = { owner: "Dueño", admin: "Administrador" };

function show(name) {
  Object.entries(views).forEach(([key, el]) => { el.hidden = key !== name; });
}

function showLogin(message = "") {
  stopRouter();
  loginError.textContent = message;
  loginError.hidden = !message;
  loginButton.disabled = false;
  loginButton.textContent = "Ingresar";
  show("login");
}

function showPanel(user, role) {
  userEmail.textContent = user.email ?? "";
  userRole.textContent = ROLE_LABELS[role] ?? role;
  show("panel");
  startRouter(document.getElementById("adminContent"));
}

// Verifica que el usuario logueado sea admin.
// Si es un cliente de la tienda, NO se le cierra la sesión (la comparte con la
// tienda): solo se le avisa que no tiene acceso. La base rechaza igual cualquier
// acción del panel para quien no figure en admin_users.
async function enterIfAdmin(user) {
  let role;
  try {
    role = await getAdminRole(user.id);
  } catch (err) {
    console.error(err);
    await signOut();
    showLogin("No se pudieron verificar los permisos. Intentá de nuevo.");
    return;
  }

  if (!role) {
    showLogin(`La cuenta ${user.email ?? ""} no tiene permisos de administrador. Volvé a la tienda o ingresá con una cuenta de administrador.`);
    return;
  }

  showPanel(user, role);
}

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = loginForm.email.value.trim();
  const password = loginForm.password.value;

  loginButton.disabled = true;
  loginButton.textContent = "Ingresando…";
  loginError.hidden = true;

  try {
    const user = await signIn(email, password);
    loginForm.password.value = "";
    await enterIfAdmin(user);
  } catch (err) {
    console.error(err);
    showLogin("Email o contraseña incorrectos.");
  }
});

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  await signOut();
  logoutBtn.disabled = false;
});

// Sesión cerrada o expirada (también desde otra pestaña): volver al login.
onSignedOut(() => {
  if (views.login.hidden) showLogin();
});

async function init() {
  try {
    const user = await getCurrentUser();
    if (user) {
      await enterIfAdmin(user);
    } else {
      showLogin();
    }
  } catch (err) {
    console.error(err);
    showLogin("No se pudo conectar. Revisá tu conexión e intentá de nuevo.");
  }
}

init();
