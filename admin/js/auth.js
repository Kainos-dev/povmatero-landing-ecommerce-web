import { supabase } from "/js/lib/supabaseClient.js";

export async function getCurrentUser() {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session?.user ?? null;
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

export async function signOut() {
  await supabase.auth.signOut();
}

// Devuelve el rol ("owner" | "admin") o null si el usuario no es admin.
// La RLS solo deja ver la propia fila de admin_users: si no existe, no es admin.
// Esto es solo para la interfaz; la base rechaza igual cualquier acción no autorizada.
export async function getAdminRole(userId) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.role ?? null;
}

export function onSignedOut(callback) {
  supabase.auth.onAuthStateChange((event) => {
    // No llamar a Supabase dentro del callback: se difiere al próximo ciclo.
    if (event === "SIGNED_OUT") setTimeout(callback, 0);
  });
}
