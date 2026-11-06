// Notificaciones (#/notificaciones): activar o desactivar los avisos de pedidos
// nuevos en ESTE dispositivo, ver los dispositivos propios y mandar una prueba.
// Nunca pide permiso solo: siempre con el botón (iOS lo exige).
//
// iPhone: las notificaciones web funcionan solo con el panel instalado en la
// pantalla de inicio (iOS 16.4 o posterior) y abierto desde ese ícono.
import { h, mount, toast, errorMessage } from "../ui.js";
import { icon } from "../icons.js";
import { pushSupport, currentSubscription, getPublicKey, enablePush, disablePush, listMyDevices, removeDevice, sendTest, pushErrorMessage, pushMissing } from "../api/push.js";

const DATE = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

function iphoneSteps() {
  return h("ol", { class: "push-steps" },
    h("li", {}, "Abrí ", h("strong", {}, `${location.host}/admin`), " en ", h("strong", {}, "Safari"), "."),
    h("li", {}, "Tocá ", h("strong", {}, "Compartir"), " (el cuadrado con la flecha) y elegí ", h("strong", {}, "Agregar a inicio"), "."),
    h("li", {}, "Abrí ", h("strong", {}, "Povmatero"), " desde el ícono nuevo de la pantalla de inicio e ingresá con tu cuenta."),
    h("li", {}, "Volvé a esta pantalla (", h("strong", {}, "Más → Notificaciones"), ") y tocá ", h("strong", {}, "Activar notificaciones"), "."),
    h("li", {}, "Cuando el iPhone pregunte, tocá ", h("strong", {}, "Permitir"), "."));
}

export async function renderNotifications(view) {
  const status = h("div", { class: "pane-stack" }, h("p", { class: "muted" }, "Revisando este dispositivo…"));
  const devices = h("div", { class: "pane-stack" });
  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Notificaciones"),
        h("p", { class: "page-sub" }, "Recibí un aviso en el teléfono cuando entra un pedido nuevo."))),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Este dispositivo")), status),
    h("section", { class: "panel" }, h("div", { class: "panel-head" }, h("h2", {}, "Tus dispositivos")), devices),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Para tener en cuenta")),
      h("ul", { class: "push-notes" },
        h("li", {}, "Los avisos llegan con la app cerrada, pero el teléfono puede demorarlos (modo de concentración, ahorro de batería, sin conexión)."),
        h("li", {}, "El aviso es una ayuda: todos los pedidos quedan siempre en «Pedidos», lleguen o no las notificaciones."),
        h("li", {}, "Muestran el nombre de pila, el código del pedido, la cantidad y el total. Nunca el teléfono ni el email del cliente."),
        h("li", {}, "Podés activarlas en varios dispositivos (iPhone, iPad, computadora): cada uno se activa desde sí mismo."))));

  const s = pushSupport();
  let busy = false;

  async function paintStatus() {
    let sub = null;
    try { sub = await currentSubscription(); } catch { sub = null; }
    const parts = [];

    if (!s.secure) {
      parts.push(h("p", { class: "notice-warn" }, "Las notificaciones necesitan una conexión segura (https)."));
    } else if (s.ios && !s.standalone) {
      parts.push(
        h("p", { class: "notice-info" }, "En el iPhone, primero instalá el panel en la pantalla de inicio:"),
        iphoneSteps(),
        h("p", { class: "hint" }, "Hace falta iOS 16.4 o posterior. En Chrome u otras apps del iPhone no se puede: tiene que ser Safari."));
    } else if (!s.supported) {
      parts.push(h("p", { class: "notice-warn" }, "Este navegador no admite notificaciones web. Probá con Safari (iPhone, instalado en la pantalla de inicio), Chrome, Edge o Firefox."));
    } else if (Notification.permission === "denied") {
      parts.push(h("p", { class: "notice-warn" }, s.ios
        ? "Las notificaciones están bloqueadas. Activalas en Ajustes → Notificaciones → Povmatero y volvé a abrir el panel."
        : "Las notificaciones están bloqueadas para este sitio. Habilitalas desde el candado de la barra de direcciones."));
    } else {
      const on = !!sub && Notification.permission === "granted";
      if (!on) {
        try { await getPublicKey(); }
        catch { mount(status, h("p", { class: "notice-info" }, "Las notificaciones todavía no están habilitadas.")); return; }
      }
      const stateLine = h("p", { class: on ? "push-state is-on" : "push-state" },
        icon(on ? "check" : "bell"), on ? "Activadas en este dispositivo." : "Desactivadas en este dispositivo.");
      const main = h("button", { type: "button", class: on ? "btn-ghost" : "btn-primary" }, on ? "Desactivar en este dispositivo" : "Activar notificaciones");
      const test = on ? h("button", { type: "button", class: "btn-ghost" }, "Enviar notificación de prueba") : null;
      main.addEventListener("click", async () => {
        if (busy) return;
        busy = true; main.disabled = true;
        main.textContent = on ? "Desactivando…" : "Activando…";
        try {
          if (on) { await disablePush(); toast("Notificaciones desactivadas en este dispositivo."); }
          else { await enablePush(); toast("Listo: este dispositivo va a recibir los pedidos nuevos."); }
        } catch (err) {
          console.warn("Notificaciones:", err);
          toast(pushErrorMessage(err, errorMessage), "error");
        } finally {
          busy = false;
          paintStatus(); paintDevices();
        }
      });
      test?.addEventListener("click", async () => {
        test.disabled = true;
        try {
          const r = await sendTest();
          toast(r?.devices > 1 ? `Prueba enviada a tus ${r.devices} dispositivos.` : "Prueba enviada. Debería llegar en unos segundos.");
        } catch (err) {
          console.warn(err);
          toast(pushErrorMessage(err, errorMessage), "error");
        } finally {
          setTimeout(() => { test.disabled = false; }, 3000);
        }
      });
      parts.push(stateLine,
        on ? h("p", { class: "hint" }, "Vas a recibir un aviso por cada pedido nuevo. Tocalo para abrir el pedido.")
          : h("p", { class: "hint" }, "Al tocar «Activar», el dispositivo te va a pedir permiso para mostrar notificaciones."),
        h("div", { class: "actions" }, main, test));
    }
    mount(status, ...parts);
  }

  async function paintDevices() {
    let rows;
    try {
      rows = await listMyDevices();
    } catch (err) {
      console.warn(err);
      mount(devices, h("p", { class: pushMissing(err) ? "notice-warn" : "muted" }, pushErrorMessage(err, () => "No se pudieron cargar tus dispositivos.")));
      return;
    }
    let mine = null;
    try { mine = (await currentSubscription())?.endpoint ?? null; } catch { mine = null; }
    if (!rows.length) {
      mount(devices, h("p", { class: "muted" }, "Todavía no activaste las notificaciones en ningún dispositivo."));
      return;
    }
    mount(devices, h("ul", { class: "alert-list" }, rows.map((d) => {
      const remove = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Quitar");
      remove.addEventListener("click", async () => {
        remove.disabled = true;
        try {
          if (d.endpoint === mine) await disablePush(); else await removeDevice(d.id);
          toast("Dispositivo quitado.");
        } catch (err) {
          console.warn(err);
          toast(pushErrorMessage(err, errorMessage), "error");
        }
        paintStatus(); paintDevices();
      });
      const state = d.disabled_at ? "Venció: activalo de nuevo desde ese dispositivo"
        : d.last_success_at ? `Último aviso: ${DATE.format(new Date(d.last_success_at))}`
        : d.failure_count ? "No se pudo entregar el último aviso" : "Activo";
      return h("li", { class: "alert-row" },
        h("div", { class: "alert-main" },
          h("strong", {}, d.label || "Dispositivo", d.endpoint === mine ? h("span", { class: "chip push-chip" }, "Este") : null),
          h("small", { class: d.disabled_at || d.failure_count ? "notice-inline-warn" : "muted" }, state),
          h("small", { class: "muted" }, `Activado el ${DATE.format(new Date(d.created_at))}`)),
        h("div", { class: "actions" }, remove));
    })));
  }

  paintStatus();
  paintDevices();
}
