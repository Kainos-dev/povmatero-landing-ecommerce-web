// ¿Hay una sesión guardada en este navegador? Se mira la clave en la que
// supabase-js guarda la sesión (sb-<proyecto>-auth-token), sin descargar
// supabase-js. Solo sirve para la interfaz (mostrar el punto en el ícono, saber
// si vale la pena intentar guardar el pedido); los permisos los decide la base.
import { SUPABASE_URL } from "./supabaseConfig.js";

export const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

export function hasStoredSession() {
  try { return Boolean(localStorage.getItem(SESSION_KEY)); } catch { return false; }
}

// Id del usuario de la sesión guardada (o null). Lo usa el carrito para saber
// de quién es. Si la sesión no trae el usuario, se lee del token (campo "sub").
export function storedUserId() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    let id = session?.user?.id;
    if (!id && typeof session?.access_token === "string") {
      const part = session.access_token.split(".")[1] ?? "";
      id = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))).sub;
    }
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}
