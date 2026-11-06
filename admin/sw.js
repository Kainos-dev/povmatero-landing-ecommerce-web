// Service worker del panel (/admin/). SOLO notificaciones push:
//   * no intercepta pedidos de red (no hay evento «fetch») ni guarda caché,
//     así el panel y la tienda funcionan exactamente igual que sin él;
//   * su alcance es /admin/: no toca la tienda, el carrito ni /yerbas.
// Lo registra el panel recién cuando un administrador activa las
// notificaciones (botón en «Notificaciones»).

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Solo se abren direcciones del panel.
function safeUrl(url) {
  return typeof url === "string" && url.startsWith("/admin/") ? url : "/admin/#/pedidos";
}

function parse(event) {
  try {
    return event.data ? event.data.json() : {};
  } catch {
    return { body: event.data ? event.data.text() : "" };
  }
}

self.addEventListener("push", (event) => {
  const data = parse(event);
  // iOS exige mostrar una notificación por cada push.
  event.waitUntil(self.registration.showNotification(String(data.title || "Povmatero"), {
    body: String(data.body || "Hay novedades en el panel."),
    tag: String(data.tag || "povmatero"),
    icon: "/admin/icons/icon-192.png",
    badge: "/admin/icons/icon-192.png",
    data: { url: safeUrl(data.url) },
    renotify: false,
  }));
});

// Tocar la notificación: abre el pedido en el panel (si ya está abierto, lo usa).
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(safeUrl(event.notification.data && event.notification.data.url), self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const panel = windows.find((w) => new URL(w.url).pathname.startsWith("/admin"));
    if (panel) {
      try {
        await panel.focus();
        if ("navigate" in panel) return await panel.navigate(target);
        panel.postMessage({ type: "povmatero:open", url: target });
        return;
      } catch { /* si no se puede reutilizar, se abre una ventana */ }
    }
    return self.clients.openWindow(target);
  })());
});
