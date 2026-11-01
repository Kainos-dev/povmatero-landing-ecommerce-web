// «Más»: en el celular reúne lo que no entra en la barra inferior
// (clientes, herramientas y cuenta). En escritorio todo está en la barra lateral.
import { h, mount } from "../ui.js";
import { icon } from "../icons.js";
import { getSession } from "../session.js";
import { signOut } from "../auth.js";

function item(href, iconName, title, detail) {
  return h("li", {},
    h("a", { class: "task", href },
      h("span", { class: "task-icon" }, icon(iconName)),
      h("span", { class: "task-text" },
        h("span", { class: "task-title" }, title),
        detail ? h("span", { class: "task-detail" }, detail) : null),
      h("span", { class: "task-action" }, icon("chevron"))));
}

export function renderMore(view) {
  const session = getSession();
  const logout = h("button", { type: "button", class: "btn-ghost btn-block" }, icon("logout"), "Cerrar sesión");
  logout.addEventListener("click", async () => {
    logout.disabled = true;
    await signOut();
    logout.disabled = false;
  });

  mount(view,
    h("div", { class: "page-header" }, h("h1", {}, "Más")),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Herramientas")),
      h("ul", { class: "task-list" },
        item("#/importar-precios", "upload", "Importar precios", "Lista mayorista (costos) o minorista (precios), en Excel o CSV"),
        item("#/imagenes", "image", "Verificar imágenes", "Estado de todas las fotos y migración a Storage"),
        item("#/revision", "check", "Revisión del catálogo", "Qué falta antes de publicar"))),
    h("section", { class: "panel" },
      h("div", { class: "panel-head" }, h("h2", {}, "Cuenta")),
      h("div", { class: "account" },
        h("span", { class: "account-email" }, session.email),
        h("span", { class: "chip" }, session.roleLabel)),
      h("ul", { class: "task-list" },
        item("/", "store", "Ver tienda", "Abre la tienda pública")),
      logout));
}
