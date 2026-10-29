// Cuentas de clientes con Supabase Auth.
//
// Este módulo se carga recién cuando hace falta (al tocar el ícono de cuenta o
// al volver de un enlace de email), así supabase-js no demora la tienda.
//
// Usa el mismo cliente que el panel (/js/lib/supabaseClient.js): la sesión es
// compartida, por eso un admin que ingresa desde la tienda entra al panel sin
// volver a loguearse. Los permisos los decide la base (RLS), nunca el navegador.
import { supabase } from "./supabaseClient.js";

// A dónde vuelve el cliente desde los emails (confirmación y recuperación).
// Tiene que estar en Supabase → Authentication → URL Configuration → Redirect URLs.
function redirectUrl() {
  return `${location.origin}/`;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session ?? null;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

export async function signOut() {
  // scope "local": cierra la sesión en este navegador.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) throw error;
}

// Los datos del perfil viajan como metadata del registro: un trigger de la base
// los copia a customer_profiles (ver la migración 20261030000000). No dan permisos.
export async function signUp({ email, password, firstName, lastName, phone, marketingOptIn, marketingMethod, marketingText }) {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: redirectUrl(),
      data: {
        first_name: firstName,
        last_name: lastName,
        phone: phone || null,
        marketing_opt_in: marketingOptIn,
        marketing_method: marketingMethod,
        marketing_text: marketingText,
      },
    },
  });
  if (error) throw error;
  // Con la confirmación de email activada, Supabase no informa si el email ya
  // existía (protege la privacidad): devuelve un usuario sin identidades.
  const alreadyRegistered = Array.isArray(data.user?.identities) && data.user.identities.length === 0;
  return { session: data.session ?? null, alreadyRegistered };
}

export async function resendConfirmation(email) {
  const { error } = await supabase.auth.resend({ type: "signup", email, options: { emailRedirectTo: redirectUrl() } });
  if (error) throw error;
}

export async function requestPasswordReset(email) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
  if (error) throw error;
}

export async function updatePassword(password) {
  const { error } = await supabase.auth.updateUser({ password });
  if (error) throw error;
}

// Perfil propio (la RLS solo devuelve el del usuario logueado).
// null si todavía no existe (por ejemplo, cuentas creadas antes de la migración).
export async function getProfile(userId) {
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("first_name, last_name, phone, email, marketing_opt_in")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.warn("Cuenta: no se pudo leer el perfil.", error);
    return null;
  }
  return data;
}

export async function setMarketingOptIn(userId, optIn) {
  const { data, error } = await supabase
    .from("customer_profiles")
    .update({ marketing_opt_in: optIn })
    .eq("user_id", userId)
    .select("marketing_opt_in")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("profile_not_found");
  return data.marketing_opt_in;
}

// Solo para mostrar el acceso al panel. La base vuelve a verificarlo en cada
// acción del panel (private.is_admin()), así que no se puede falsear desde acá.
export async function isAdmin(userId) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) return false;
  return Boolean(data?.role);
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    // No se llama a Supabase dentro del callback: se difiere.
    setTimeout(() => callback(event, session), 0);
  });
  return () => data.subscription.unsubscribe();
}

// Vuelta desde un email de Supabase (confirmación de cuenta o recuperación).
// Los tokens llegan en el fragmento de la URL (#access_token=...&type=...).
// Devuelve { type } si se inició sesión, { error } si el enlace falló, o null.
export async function handleAuthRedirect(hash) {
  const params = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const errorCode = params.get("error_code") || params.get("error");
  if (errorCode) {
    return { error: { code: errorCode, message: params.get("error_description") ?? "" } };
  }
  const access_token = params.get("access_token");
  const refresh_token = params.get("refresh_token");
  if (!access_token || !refresh_token) return null;

  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) return { error };
  return { type: params.get("type") ?? "signup" };
}

// Mensajes claros para los errores de Supabase Auth.
export function authErrorMessage(error) {
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");

  if (code === "invalid_credentials" || /invalid login credentials/i.test(message)) {
    return "Email o contraseña incorrectos.";
  }
  // Antes que "email inválido": Supabase dice "Email link is invalid or has expired".
  if (code === "otp_expired" || code === "access_denied" || code === "invalid_jwt" || code === "bad_jwt" || /link is invalid|expired/i.test(message)) {
    return "El enlace venció o ya se usó. Pedí uno nuevo.";
  }
  if (code === "email_not_confirmed" || /email not confirmed/i.test(message)) {
    return "Todavía no confirmaste tu email. Buscá el mensaje que te enviamos (revisá también spam).";
  }
  if (code === "user_already_exists" || code === "email_exists" || /already registered/i.test(message)) {
    return "Ya existe una cuenta con ese email. Probá ingresar o recuperar tu contraseña.";
  }
  if (code === "weak_password" || /password should/i.test(message)) {
    return "La contraseña es muy débil. Usá al menos 8 caracteres, combinando letras y números.";
  }
  if (code === "same_password") return "La nueva contraseña tiene que ser distinta de la anterior.";
  if (code === "signup_disabled" || /signups not allowed/i.test(message)) {
    return "Por el momento no se pueden crear cuentas nuevas. Si necesitás ayuda, escribinos por WhatsApp.";
  }
  if (code === "email_address_invalid" || code === "validation_failed" || /invalid.*email|email.*invalid/i.test(message)) {
    return "Revisá el email: no parece válido.";
  }
  if (/rate_limit/.test(code) || /rate limit|too many/i.test(message) || error?.status === 429) {
    return "Hiciste muchos intentos seguidos. Esperá unos minutos y volvé a probar.";
  }
  if (code === "session_not_found" || code === "refresh_token_not_found" || /session/i.test(code)) {
    return "Tu sesión expiró. Volvé a ingresar.";
  }
  if (error?.name === "AuthRetryableFetchError" || error instanceof TypeError || /fetch|network/i.test(message)) {
    return "No pudimos conectarnos. Revisá tu conexión e intentá de nuevo.";
  }
  return "Algo salió mal. Intentá de nuevo en unos minutos.";
}
