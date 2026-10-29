// Clientes registrados en la tienda (solo lectura).
// Muestra quiénes aceptaron recibir novedades y cómo lo hicieron, y permite
// exportar la lista. Los datos salen de public.customer_profiles: la RLS solo
// se los devuelve a los administradores.
import { supabase } from "/js/lib/supabaseClient.js";
import { h, mount, errorMessage, normalizeText } from "../ui.js";

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

export async function renderCustomers(view) {
  mount(view, h("p", { class: "muted" }, "Cargando clientes…"));

  let customers;
  try {
    customers = await listCustomers();
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

  const optedIn = customers.filter((c) => c.marketing_opt_in);
  const active = optedIn.filter((c) => c.marketing_consent_method !== "signup_prechecked");

  let visible = customers;

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
          h("td", {}, [c.first_name, c.last_name].filter(Boolean).join(" ") || "—"),
          h("td", {}, c.email),
          h("td", {}, c.phone || "—"),
          h("td", { class: "center" }, h("span", { class: `badge ${c.marketing_opt_in ? "badge-ok" : ""}` }, c.marketing_opt_in ? "Sí" : "No")),
          h("td", {}, METHOD_LABELS[c.marketing_consent_method] ?? "—"),
          h("td", {}, formatDate(c.marketing_updated_at)),
          h("td", {}, formatDate(c.created_at))
        ))
      : h("tr", {}, h("td", { colspan: 7, class: "empty" }, customers.length ? "Ningún cliente coincide con la búsqueda." : "Todavía no hay clientes registrados."))
    );
  }

  search.addEventListener("input", apply);
  filter.addEventListener("change", apply);
  exportBtn.addEventListener("click", () => {
    const stamp = new Date().toISOString().slice(0, 10);
    download(`clientes-povmatero-${stamp}.csv`, toCsv(visible));
  });

  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Clientes")),
    h("div", { class: "customers-summary" },
      h("div", { class: "card" }, h("strong", {}, String(customers.length)), h("span", { class: "muted" }, "registrados")),
      h("div", { class: "card" }, h("strong", {}, String(optedIn.length)), h("span", { class: "muted" }, "aceptan novedades")),
      h("div", { class: "card" }, h("strong", {}, String(active.length)), h("span", { class: "muted" }, "las aceptaron marcando la casilla o desde su cuenta"))
    ),
    h("p", { class: "notice-info" },
      "«Casilla premarcada» = la persona dejó marcada la opción que ya venía marcada. ",
      "Si para tus envíos necesitás un consentimiento expreso, usá el filtro «sin contar casilla premarcada»."
    ),
    h("div", { class: "toolbar" }, search, filter, exportBtn),
    count,
    h("div", { class: "table-wrap" },
      h("table", { class: "table" },
        h("thead", {}, h("tr", {},
          h("th", {}, "Nombre"), h("th", {}, "Email"), h("th", {}, "Teléfono"),
          h("th", { class: "center" }, "Novedades"), h("th", {}, "Cómo"),
          h("th", {}, "Última preferencia"), h("th", {}, "Alta")
        )),
        tbody
      )
    )
  );
  apply();
}
