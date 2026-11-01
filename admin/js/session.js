// Datos de la sesión del panel que muestran el menú y la pantalla «Más».
const ROLE_LABELS = { owner: "Dueño", admin: "Administrador" };

let current = { email: "", role: "" };

export function setSession({ email, role }) {
  current = { email: email ?? "", role: role ?? "" };
}

export function getSession() {
  return { ...current, roleLabel: ROLE_LABELS[current.role] ?? current.role };
}
