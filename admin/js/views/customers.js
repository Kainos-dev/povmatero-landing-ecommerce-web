// Clientes registrados en la tienda.
// Muestra quiénes aceptaron recibir novedades y cómo lo hicieron, permite
// exportar la lista y eliminar cuentas (por ejemplo, las de prueba). Los datos
// salen de public.customer_profiles: la RLS solo se los devuelve a los
// administradores.
import { supabase } from "/js/lib/supabaseClient.js";
import { h, mount, errorMessage, normalizeText, toast } from "../ui.js";
import { getCurrentUserId } from "../api/inventory.js";
import { icon } from "../icons.js";

const METHOD_LABELS = {
  signup_prechecked: "Registro (casilla premarcada)",
  signup_checked: "Registro (la marcó)",
  signup_unchecked: "Registro (no aceptó)",
  account_opt_in: "Desde su cuenta (alta)",
  account_opt_out: "Desde su cuenta (baja)",
};

const DATE = new Intl.DateTimeFormat("es-AR", { dateStyle: "short", timeStyle: "short" });
const formatDate = (value) => (value ? DATE.format(new Date(value)) : "—");

async function listCustomers() {
  const { data, error } = await supabase
    .from("customer_profiles")
    .select("user_id, email, first_name, last_name, phone, marketing_opt_in, marketing_consent_method, marketing_updated_at, created_at")
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

// Elimina la cuenta de Auth del cliente (y en cascada su perfil e historial de
// novedades). Lo hace una función de la base que verifica que quien llama sea
// administrador, que no sea su propia cuenta ni la de otro administrador, y que
// el cliente no tenga pedidos. El navegador nunca usa claves secretas.
// Ver supabase/migrations/20261102000000_admin_delete_customer.sql
async function deleteCustomer(userId) {
  const { data, error } = await supabase.rpc("admin_delete_customer", { target: userId });
  if (error) throw error;
  return data;
}

// Rechazos de la base con un mensaje ya pensado para el panel.
const KNOWN_REFUSALS = new Set(["own_account", "admin_account", "not_found", "has_orders"]);
function deleteErrorMessage(err) {
  if (KNOWN_REFUSALS.has(err?.hint)) return err.message;
  if (err?.code === "PGRST202" || /admin_delete_customer/.test(err?.message ?? "")) {
    return "Falta aplicar la migración supabase/migrations/20261102000000_admin_delete_customer.sql en el SQL Editor de Supabase.";
  }
  if (err?.code === "42501") return "No tenés permisos para eliminar clientes.";
  return errorMessage(err);
}

function toCsv(rows) {
  const header = ["email", "nombre", "apellido", "telefono", "acepta_novedades", "como", "fecha_preferencia", "alta"];
  const escape = (v) => {
    const text = String(v ?? "");
    // Evita que una planilla interprete el texto como fórmula.
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const lines = rows.map((c) => [
    c.email, c.first_name, c.last_name, c.phone,
    c.marketing_opt_in ? "si" : "no",
    METHOD_LABELS[c.marketing_consent_method] ?? c.marketing_consent_method ?? "",
    c.marketing_updated_at ?? "", c.created_at ?? "",
  ].map(escape).join(","));
  return "﻿" + [header.join(","), ...lines].join("\r\n");
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fullName = (c) => [c.first_name, c.last_name].filter(Boolean).join(" ");

export async function renderCustomers(view) {
  mount(view, h("p", { class: "muted" }, "Cargando clientes…"));

  let customers, me;
  try {
    [customers, me] = await Promise.all([listCustomers(), getCurrentUserId()]);
  } catch (err) {
    console.error(err);
    // 42P01 / PGRST205: la tabla todavía no existe (falta aplicar la migración).
    const missing = err?.code === "42P01" || err?.code === "PGRST205" || /customer_profiles/.test(err?.message ?? "");
    mount(view,
      h("div", { class: "page-header" }, h("h2", {}, "Clientes")),
      h("p", { class: "notice-warn" }, missing
        ? "Todavía no está creada la tabla de clientes. Hay que ejecutar la migración supabase/migrations/20261030000000_customer_accounts.sql en el SQL Editor de Supabase."
        : errorMessage(err))
    );
    return;
  }

  const search = h("input", { type: "search", class: "input", placeholder: "Buscar por nombre, email o teléfono…", "aria-label": "Buscar" });
  const filter = h("select", { class: "input", "aria-label": "Novedades" },
    h("option", { value: "" }, "Todos los clientes"),
    h("option", { value: "yes" }, "Aceptan novedades"),
    h("option", { value: "active" }, "Aceptan novedades (sin contar casilla premarcada)"),
    h("option", { value: "no" }, "No aceptan novedades")
  );
  const exportBtn = h("button", { type: "button", class: "btn-ghost" }, "Exportar CSV");
  const count = h("p", { class: "muted" });
  const tbody = h("tbody");
  const summary = h("div", { class: "customers-summary" });
  const confirmSlot = h("div", { hidden: true });

  let visible = customers;

  function renderSummary() {
    const opted = customers.filter((c) => c.marketing_opt_in);
    const actively = opted.filter((c) => c.marketing_consent_method !== "signup_prechecked");
    mount(summary,
      h("div", { class: "card" }, h("strong", {}, String(customers.length)), h("span", { class: "muted" }, "registrados")),
      h("div", { class: "card" }, h("strong", {}, String(opted.length)), h("span", { class: "muted" }, "aceptan novedades")),
      h("div", { class: "card" }, h("strong", {}, String(actively.length)), h("span", { class: "muted" }, "las aceptaron marcando la casilla o desde su cuenta")));
  }

  // ---------- Eliminar ----------
  function closeConfirm() {
    confirmSlot.hidden = true;
    mount(confirmSlot);
  }

  // Confirmación: quién es, qué se borra y qué no. Único lugar con rojo.
  function askDelete(c) {
    const who = fullName(c) ? `«${fullName(c)}» (${c.email})` : c.email;
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const cancel = h("button", { type: "button", class: "btn-ghost", onClick: closeConfirm }, "Cancelar");
    const confirm = h("button", { type: "button", class: "btn-primary btn-danger-solid" }, "Sí, eliminar la cuenta");

    confirm.addEventListener("click", async () => {
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = "Eliminando…";
      try {
        const result = await deleteCustomer(c.user_id);
        customers = customers.filter((x) => x.user_id !== c.user_id);
        closeConfirm();
        apply();
        renderSummary();
        toast(`Se eliminó la cuenta de ${result?.email ?? c.email}. Ese email ya puede registrarse de nuevo.`);
        // Se vuelve a leer la lista para confirmar con la base.
        try { customers = await listCustomers(); apply(); renderSummary(); } catch (err) { console.error(err); }
      } catch (err) {
        console.error(err);
        error.textContent = `No se eliminó: ${deleteErrorMessage(err)}`;
        error.hidden = false;
        confirm.disabled = false;
        cancel.disabled = false;
        confirm.textContent = "Sí, eliminar la cuenta";
      }
    });

    confirmSlot.hidden = false;
    mount(confirmSlot, h("div", { class: "confirm-box confirm-danger", role: "alertdialog", "aria-label": `Eliminar la cuenta de ${c.email}` },
      h("p", {}, h("strong", {}, `¿Eliminar la cuenta de ${who}?`)),
      h("ul", { class: "change-list" },
        h("li", {}, "Se borra su cuenta de acceso: el email queda libre para registrarse de nuevo."),
        h("li", {}, "Se borran su perfil (nombre y teléfono) y su historial de preferencias de novedades."),
        h("li", {}, "No se tocan productos, precios, stock ni movimientos. Si tuviera pedidos, la base no deja eliminarla.")),
      h("p", {}, "No se puede deshacer."),
      error,
      h("div", { class: "actions" }, confirm, cancel)));
    confirmSlot.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
    confirm.focus();
  }

  function actionCell(c) {
    if (c.user_id === me) return h("span", { class: "chip", title: "Es la cuenta con la que estás usando el panel" }, "Vos");
    return h("button", {
      type: "button", class: "btn-ghost btn-danger btn-sm",
      "aria-label": `Eliminar la cuenta de ${c.email}`, onClick: () => askDelete(c),
    }, icon("trash"), "Eliminar");
  }

  // ---------- Tabla ----------
  function apply() {
    const q = normalizeText(search.value.trim());
    visible = customers.filter((c) => {
      if (filter.value === "yes" && !c.marketing_opt_in) return false;
      if (filter.value === "active" && !(c.marketing_opt_in && c.marketing_consent_method !== "signup_prechecked")) return false;
      if (filter.value === "no" && c.marketing_opt_in) return false;
      if (!q) return true;
      return normalizeText([c.first_name, c.last_name, c.email, c.phone].join(" ")).includes(q);
    });

    count.textContent = `${visible.length} de ${customers.length} clientes`;
    mount(tbody, visible.length
      ? visible.map((c) => h("tr", {},
          h("td", { class: "c-name" }, fullName(c) || "—"),
          h("td", { class: "c-email" }, c.email),
          h("td", { class: "c-phone" }, c.phone || "—"),
          h("td", { class: "center c-news" }, h("span", { class: `badge ${c.marketing_opt_in ? "badge-ok" : ""}` }, c.marketing_opt_in ? "Sí" : "No")),
          h("td", { class: "c-how" }, METHOD_LABELS[c.marketing_consent_method] ?? "—"),
          h("td", { class: "c-pref" }, formatDate(c.marketing_updated_at)),
          h("td", { class: "c-date" }, formatDate(c.created_at)),
          h("td", { class: "c-action" }, actionCell(c))
        ))
      : h("tr", {}, h("td", { colspan: 8, class: "empty" }, customers.length ? "Ningún cliente coincide con la búsqueda." : "Todavía no hay clientes registrados."))
    );
  }

  search.addEventListener("input", apply);
  filter.addEventListener("change", apply);
  exportBtn.addEventListener("click", () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`clientes-povmatero-${stamp}.csv`, toCsv(visible));
  });

  renderSummary();
  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Clientes")),
    summary,
    h("p", { class: "notice-info" },
      "«Casilla premarcada» = la persona dejó marcada la opción que ya venía marcada. ",
      "Si para tus envíos necesitás un consentimiento expreso, usá el filtro «sin contar casilla premarcada»."
    ),
    h("div", { class: "toolbar" }, search, filter, exportBtn),
    count,
    confirmSlot,
    h("div", { class: "table-wrap" },
      h("table", { class: "table table-cards table-customers" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Nombre"), h("th", {}, "Email"), h("th", {}, "Teléfono"),
          h("th", { class: "center" }, "Novedades"), h("th", {}, "Cómo"),
          h("th", {}, "Última preferencia"), h("th", {}, "Alta"), h("th", {}, "")
        )),
        tbody
      )
    )
  );
  apply();
}
