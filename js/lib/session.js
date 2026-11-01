// ¿Hay una sesión guardada en este navegador? Se mira la clave en la que
// supabase-js guarda la sesión (sb-<proyecto>-auth-token), sin descargar
// supabase-js. Solo sirve para la interfaz (mostrar el punto en el ícono, saber
// si vale la pena intentar guardar el pedido); los permisos los decide la base.
import { SUPABASE_URL } from "./supabaseConfig.js";

export const SESSION_KEY = `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`;

export function hasStoredSession() {
  try { return Boolean(localStorage.getItem(SESSION_KEY)); } catch { return false; }
}
