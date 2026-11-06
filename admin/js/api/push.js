// Notificaciones Web Push del panel (migración 20261115000000_admin_push.sql).
// El navegador solo guarda o quita SU suscripción; los permisos los controla
// la base (solo administradores, cada uno sus dispositivos). La clave privada
// VAPID vive en Vercel; acá solo se pide la pública (/api/push-config).
import { supabase } from "/js/lib/supabaseClient.js";

const SW_URL = "/admin/sw.js";
const SW_SCOPE = "/admin/";

// ¿Qué puede hacer este navegador?
//   ios: iPhone/iPad. standalone: abierto desde el ícono de la pantalla de inicio.
export function pushSupport() {
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  return { ios, standalone, supported, permission: "Notification" in window ? Notification.permission : "unsupported", secure: window.isSecureContext };
}

export async function getPublicKey() {
  const res = await fetch("/api/push-config", { cache: "no-store" });
  if (res.status === 503) throw Object.assign(new Error("Las notificaciones todavía no están habilitadas."), { hint: "not_configured" });
  if (!res.ok) throw new Error(`push-config: ${res.status}`);
  const { publicKey } = await res.json();
  return publicKey;
}

function keyBytes(b64u) {
  const s = b64u.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64u.length % 4)) % 4);
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// Registro existente (sin crear uno): para saber si ESTE dispositivo ya está activo.
export async function currentSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  return reg ? reg.pushManager.getSubscription() : null;
}

function deviceLabel() {
  const ua = navigator.userAgent || "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  return "Este dispositivo";
}

// Activar en este dispositivo. Se llama SOLO desde el botón (iOS exige un toque
// para pedir permiso). Pasos: permiso → service worker → suscripción → base.
export async function enablePush() {
  const publicKey = await getPublicKey(); // disabled => no permission prompt or subscription
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw Object.assign(new Error(permission === "denied"
      ? "Las notificaciones están bloqueadas para el panel. Habilitalas en los ajustes del dispositivo."
      : "No se activaron las notificaciones."), { hint: "permission_" + permission });
  }
  const reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Si la suscripción existente es de otra clave VAPID, se rehace.
  const current = sub?.options?.applicationServerKey;
  if (sub && current && btoa(String.fromCharCode(...new Uint8Array(current))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = sub.toJSON();
  const { error } = await supabase.rpc("admin_push_subscribe", {
    endpoint: json.endpoint, p256dh: json.keys?.p256dh, auth_secret: json.keys?.auth, label: deviceLabel(),
  });
  if (error) throw error;
  return json.endpoint;
}

// Desactivar en este dispositivo: se borra en la base y en el navegador.
export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return false;
  const { error } = await supabase.rpc("admin_push_unsubscribe", { endpoint: sub.endpoint });
  if (error) throw error;
  await sub.unsubscribe().catch(() => {});
  return true;
}

// Dispositivos del administrador con sesión (la RLS devuelve solo los propios).
export async function listMyDevices() {
  const { data, error } = await supabase
    .from("admin_push_subscriptions")
    .select("id, endpoint, label, created_at, last_success_at, last_error, failure_count, disabled_at")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

export async function removeDevice(id) {
  const { error } = await supabase.rpc("admin_push_remove", { subscription_id: id });
  if (error) throw error;
}

export async function sendTest() {
  const { data, error } = await supabase.rpc("admin_push_test");
  if (error) throw error;
  return data;
}

// La base todavía no tiene la migración de notificaciones.
export function pushMissing(err) {
  return ["PGRST202", "PGRST205", "42P01", "42883"].includes(err?.code);
}

export function pushErrorMessage(err, fallback) {
  if (pushMissing(err)) return "Falta aplicar la migración 20261115000000_admin_push.sql en Supabase.";
  if (["not_configured", "permission_denied", "permission_default", "no_devices", "rate_limit", "too_many", "invalid_subscription", "admin_only"].includes(err?.hint)) return err.message;
  return fallback(err);
}
