// Góndola (#/gondola): pestañas
//   Imágenes          ?tab=imagenes (por defecto)  → shelfImages.js
//   Ordenar góndolas  ?tab=gondolas                → orden de las marcas en /yerbas
//   Ordenar yerbas    ?tab=yerbas&g=<clave>        → orden de las yerbas dentro de una góndola
// El orden se guarda en Supabase (migración 20261113000000_shelf_order.sql) con
// control de cambios simultáneos: si otro administrador lo cambió mientras
// tanto, no se pisa y se pide recargar. Solo cambia el orden: nunca precios,
// costos, stock, imágenes ni pedidos.
import { h, mount, toast, errorMessage } from "../ui.js";
import { icon } from "../icons.js";
import { thumbnail } from "../thumbs.js";
import { presentationLabel } from "../api/yerbas.js";
import { renderShelfImages } from "./shelfImages.js";
import {
  loadShelfOrder, saveBrandOrder, saveProductOrder, isOnShelf, missingSchema, orderErrorMessage,
  OTHER_KEY, OTHER_NAME,
} from "../api/shelfOrder.js";

const TABS = [
  ["imagenes", "Imágenes", "Imágenes"],
  ["gondolas", "Ordenar góndolas", "Góndolas"],
  ["yerbas", "Ordenar yerbas", "Yerbas"],
];
const OTHER_PARAM = "_otras";  // «Otras marcas» en la dirección (las claves de marca no llevan «_»)
const sameOrder = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function renderShelf(view, query = {}) {
  const tab = TABS.some(([k]) => k === query.tab) ? query.tab : "imagenes";
  const body = h("div", { class: "pane-stack" });
  mount(view,
    h("div", { class: "page-header" },
      h("div", { class: "title-block" },
        h("h1", {}, "Góndola"),
        h("p", { class: "page-sub" }, "Envases, orden de las góndolas y de las yerbas en /yerbas."))),
    h("nav", { class: "segmented", "aria-label": "Secciones de la góndola" },
      TABS.map(([k, label, short]) => h("a", { href: `#/gondola?tab=${k}`, class: k === tab ? "active" : null, "aria-current": k === tab ? "page" : null, "aria-label": label },
        h("span", { class: "seg-long" }, label), h("span", { class: "seg-short", "aria-hidden": "true" }, short)))),
    body);
  if (tab === "imagenes") return renderShelfImages(body, { ...query, embedded: true });
  return renderOrder(body, tab, query);
}

async function renderOrder(root, tab, query) {
  mount(root, h("p", { class: "muted" }, "Cargando góndolas…"));
  let data;
  try {
    data = await loadShelfOrder();
  } catch (err) {
    (missingSchema(err) ? console.warn : console.error)(err);
    mount(root, h("p", { class: "notice-warn" }, missingSchema(err)
      ? "Para ordenar las góndolas falta aplicar la migración supabase/migrations/20261113000000_shelf_order.sql en el SQL Editor de Supabase. Mientras tanto, /yerbas mantiene el orden de siempre."
      : errorMessage(err)));
    return;
  }
  if (tab === "gondolas") brandsPane(root, data);
  else productsPane(root, data, query);
}

// ---------------------------------------------------------------------
// Lista ordenable: arrastrar desde el asa (mouse o dedo) o con Subir/Bajar.
//   ids: orden inicial; row(id): contenido de la fila; name(id): para los botones
//   onChange(ids): cada vez que cambia
// Devuelve { el, set(ids), get() }.
// ---------------------------------------------------------------------
function sortableList({ ids, row, name, onChange, label }) {
  let items = ids.slice();
  const ol = h("ol", { class: "so-list", "aria-label": label });

  function paint(focus) {
    mount(ol, items.map((id, i) => {
      const up = h("button", { type: "button", class: "so-btn", "aria-label": `Subir ${name(id)}`, title: "Subir", disabled: i === 0, "data-move": "up" }, icon("up"));
      const down = h("button", { type: "button", class: "so-btn", "aria-label": `Bajar ${name(id)}`, title: "Bajar", disabled: i === items.length - 1, "data-move": "down" }, icon("down"));
      up.addEventListener("click", () => move(i, i - 1, "up"));
      down.addEventListener("click", () => move(i, i + 1, "down"));
      const grip = h("span", { class: "so-grip", title: "Arrastrar para mover", "aria-hidden": "true" }, icon("grip"));
      const li = h("li", { class: "so-row", "data-id": String(id) },
        grip, h("span", { class: "so-pos" }, String(i + 1)), h("div", { class: "so-main" }, row(id)), h("div", { class: "so-move" }, up, down));
      grip.addEventListener("pointerdown", (e) => startDrag(e, li));
      return li;
    }));
    if (focus) {
      const li = ol.querySelector(`.so-row[data-id="${CSS.escape(String(focus.id))}"]`);
      const btn = li?.querySelector(`[data-move="${focus.dir}"]:not(:disabled)`) ?? li?.querySelector(".so-btn:not(:disabled)");
      btn?.focus();
    }
  }

  function move(from, to, dir) {
    if (to < 0 || to >= items.length) return;
    const [id] = items.splice(from, 1);
    items.splice(to, 0, id);
    paint({ id, dir });
    onChange(items.slice());
  }

  // Arrastre con Pointer Events: la fila se mueve en el DOM mientras se arrastra
  // y al soltar se lee el orden. Funciona igual con mouse, lápiz o dedo.
  // Se escucha en window: al mover la fila en el DOM el navegador suelta la
  // captura del puntero, y así el arrastre sigue igual.
  function startDrag(e, li) {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    const pointer = e.pointerId;
    li.classList.add("is-dragging");
    ol.classList.add("is-sorting");
    const startOrder = items.slice();
    const onMove = (ev) => {
      if (ev.pointerId !== pointer) return;
      ev.preventDefault();
      const y = ev.clientY;
      const rows = [...ol.children].filter((x) => x !== li);
      const before = rows.find((r) => { const b = r.getBoundingClientRect(); return y < b.top + b.height / 2; });
      if (before) { if (li.nextElementSibling !== before) ol.insertBefore(li, before); }
      else if (ol.lastElementChild !== li) ol.append(li);
      // Cerca de los bordes de la pantalla, se desplaza sola.
      if (y < 70) window.scrollBy(0, -12);
      else if (y > window.innerHeight - 90) window.scrollBy(0, 12);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pointer) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      li.classList.remove("is-dragging");
      ol.classList.remove("is-sorting");
      const next = [...ol.children].map((x) => items.find((id) => String(id) === x.dataset.id));
      items = next;
      paint();
      if (!sameOrder(next, startOrder)) onChange(items.slice());
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  paint();
  return { el: ol, set(next) { items = next.slice(); paint(); }, get: () => items.slice() };
}

// Barra de guardado: aparece solo con cambios sin guardar.
function saveBar({ onSave, onDiscard }) {
  const text = h("span", { class: "so-savebar-text" }, "Cambios sin guardar");
  const discard = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Descartar");
  const save = h("button", { type: "button", class: "btn-primary btn-sm" }, icon("check"), "Guardar orden");
  discard.addEventListener("click", onDiscard);
  save.addEventListener("click", onSave);
  const el = h("div", { class: "so-savebar", hidden: true, role: "region", "aria-label": "Guardar orden" }, text, h("div", { class: "row-actions" }, discard, save));
  return {
    el,
    show(on) { el.hidden = !on; },
    busy(on) { save.disabled = discard.disabled = on; save.lastChild.textContent = on ? "Guardando…" : "Guardar orden"; },
  };
}

// Aviso de error con «Recargar».
function errorBox(message, onReload) {
  const reload = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Recargar");
  reload.addEventListener("click", onReload);
  return h("div", { class: "notice-warn so-error", role: "alert" }, h("span", {}, message), reload);
}

// Imagen para reconocer la yerba: la general de góndola, si no la de alguna presentación.
function shelfPicture(p, width = 128) {
  const src = p.shelf_image ?? p.variants.find((v) => v.shelf_image)?.shelf_image ?? null;
  return src
    ? h("span", { class: "so-thumb" }, thumbnail(src, { alt: "", width }))
    : h("span", { class: "so-thumb so-thumb-empty", "aria-hidden": "true" }, (p.name ?? "?").trim().charAt(0).toUpperCase());
}

// ---------------------------------------------------------------------
// Ordenar góndolas (marcas)
// ---------------------------------------------------------------------
function brandsPane(root, data) {
  const byKey = new Map(data.brands.map((b) => [b.key, b]));
  let saved = data.brands.map((b) => b.key);
  const counts = (key) => {
    const own = data.products.filter((p) => p.group === key);
    const sent = data.products.filter((p) => p.group === OTHER_KEY && p.brand && data.brands.find((b) => b.name === p.brand)?.key === key);
    return { shelf: own.filter(isOnShelf).length, total: own.length, sent: sent.length };
  };
  const otherCount = data.products.filter((p) => p.group === OTHER_KEY && isOnShelf(p)).length;

  const preview = h("div", { class: "so-tabs-preview", "aria-live": "polite" });
  const error = h("div", { class: "so-slot" });
  const bar = saveBar({ onSave: save, onDiscard: () => { list.set(saved); changed(saved); } });

  const list = sortableList({
    ids: saved,
    label: "Orden de las góndolas",
    name: (k) => byKey.get(k).name,
    row: (k) => {
      const c = counts(k);
      const meta = c.shelf
        ? `${c.shelf} ${c.shelf === 1 ? "yerba" : "yerbas"} en /yerbas`
        : c.total ? "Sin yerbas publicadas: no se muestra" : "Sin yerbas: no se muestra";
      return [
        h("strong", { class: "so-name" }, byKey.get(k).name),
        h("span", { class: c.shelf ? "so-meta" : "so-meta so-meta-off" }, meta,
          c.sent ? ` · ${c.sent} en «${OTHER_NAME}»` : ""),
      ];
    },
    onChange: changed,
  });

  function changed(order) {
    bar.show(!sameOrder(order, saved));
    paintPreview(order);
  }

  function paintPreview(order) {
    const visible = order.filter((k) => counts(k).shelf > 0).map((k) => byKey.get(k).name);
    if (otherCount) visible.push(OTHER_NAME);
    mount(preview, visible.length
      ? visible.map((n, i) => h("span", { class: i === 0 ? "so-chip active" : "so-chip" }, n))
      : h("span", { class: "muted" }, "Todavía no hay yerbas publicadas."));
  }

  async function save() {
    const order = list.get();
    bar.busy(true);
    mount(error);
    try {
      await saveBrandOrder(order, saved);
      saved = order;
      bar.show(false);
      toast("Orden de las góndolas guardado.");
    } catch (err) {
      (err?.hint ? console.warn : console.error)(err);
      mount(error, errorBox(orderErrorMessage(err, errorMessage(err)), () => renderOrder(root, "gondolas", {})));
    } finally {
      bar.busy(false);
    }
  }

  const otherRow = h("div", { class: "so-row so-row-fixed", "aria-label": `${OTHER_NAME}: siempre al final` },
    h("span", { class: "so-grip so-lock", "aria-hidden": "true" }, icon("lock")),
    h("span", { class: "so-pos" }, String(saved.length + 1)),
    h("div", { class: "so-main" },
      h("strong", { class: "so-name" }, OTHER_NAME),
      h("span", { class: "so-meta" }, `Siempre al final · ${otherCount} ${otherCount === 1 ? "yerba" : "yerbas"} en /yerbas`)));

  mount(root,
    h("div", { class: "so-layout" },
      h("section", { class: "card so-card" },
        h("div", { class: "so-head" },
          h("h3", {}, "Orden de las góndolas"),
          h("p", { class: "hint" }, "Arrastrá desde ", icon("grip", "icon so-inline-icon"), " o usá las flechas. Las marcas nuevas se agregan al final solas.")),
        error,
        list.el,
        otherRow),
      h("aside", { class: "card so-preview" },
        h("h3", {}, "Vista previa"),
        h("p", { class: "hint" }, "Las pestañas de /yerbas, en este orden. Las marcas sin yerbas publicadas no se muestran."),
        preview)),
    bar.el);
  paintPreview(saved);
}

// ---------------------------------------------------------------------
// Ordenar yerbas dentro de una góndola
// ---------------------------------------------------------------------
function productsPane(root, data, query) {
  const groups = [
    ...data.brands.map((b) => ({ key: b.key, name: b.name })),
    { key: OTHER_KEY, name: OTHER_NAME },
  ].map((g) => ({ ...g, products: data.products.filter((p) => p.group === g.key) }))
   .filter((g) => g.products.length);

  if (!groups.length) {
    mount(root, h("p", { class: "empty-box" }, "Todavía no hay yerbas cargadas."));
    return;
  }
  const wanted = query.g === OTHER_PARAM ? OTHER_KEY : query.g;
  let group = groups.find((g) => g.key === wanted) ?? groups[0];
  let saved = [], list = null, dirty = false;
  const byId = new Map(data.products.map((p) => [p.id, p]));

  const picker = h("div", { class: "so-groups", role: "tablist", "aria-label": "Góndola" });
  const confirmSlot = h("div", { class: "so-slot" });
  const listSlot = h("div");
  const error = h("div", { class: "so-slot" });
  const preview = h("div", { class: "so-shelf", "aria-live": "polite" });
  const title = h("h3", {});
  const bar = saveBar({ onSave: save, onDiscard: () => { list.set(saved); changed(saved); } });

  function paintPicker() {
    mount(picker, groups.map((g) => {
      const b = h("button", { type: "button", role: "tab", class: g === group ? "so-group active" : "so-group", "aria-selected": String(g === group) },
        g.name, h("small", {}, String(g.products.length)));
      b.addEventListener("click", () => choose(g));
      return b;
    }));
    // En el celular la lista de góndolas se desliza: la elegida queda a la vista.
    const active = picker.querySelector(".so-group.active");
    if (active) picker.scrollLeft = Math.max(0, active.offsetLeft - picker.offsetLeft - 16);
  }

  function choose(g) {
    if (g === group) return;
    if (dirty) {
      const yes = h("button", { type: "button", class: "btn-primary btn-sm btn-danger-solid" }, "Descartar");
      const no = h("button", { type: "button", class: "btn-ghost btn-sm" }, "Seguir ordenando");
      no.addEventListener("click", () => mount(confirmSlot));
      yes.addEventListener("click", () => { mount(confirmSlot); dirty = false; choose(g); });
      mount(confirmSlot, h("div", { class: "confirm-box" },
        h("span", {}, `Tenés cambios sin guardar en ${group.name}. ¿Descartarlos?`),
        h("div", { class: "row-actions" }, yes, no)));
      return;
    }
    group = g;
    history.replaceState(null, "", `#/gondola?tab=yerbas&g=${g.key === OTHER_KEY ? OTHER_PARAM : encodeURIComponent(g.key)}`);
    draw();
  }

  function row(id) {
    const p = byId.get(id);
    const pres = p.variants.filter((v) => v.is_active).map((v) => presentationLabel(v.name)).join(" · ") || "Sin presentaciones publicadas";
    return [
      shelfPicture(p),
      h("span", { class: "so-text" },
        h("strong", { class: "so-name" }, p.name),
        h("span", { class: "so-meta" }, pres,
          group.key === OTHER_KEY && p.brand ? ` · Marca ${p.brand}` : ""),
        isOnShelf(p) ? null : h("span", { class: "badge" }, p.is_active ? "No se ve en /yerbas" : "Borrador")),
    ];
  }

  function changed(order) {
    dirty = !sameOrder(order, saved);
    bar.show(dirty);
    paintPreview(order);
  }

  function paintPreview(order) {
    const visible = order.map((id) => byId.get(id)).filter(isOnShelf);
    mount(preview, visible.length
      ? visible.map((p, i) => h("figure", { class: "so-pack" }, shelfPicture(p, 256), h("figcaption", {}, h("b", {}, String(i + 1)), " ", p.name)))
      : h("span", { class: "muted" }, "Ninguna yerba de esta góndola está publicada: no se muestra en /yerbas."));
  }

  async function save() {
    const order = list.get();
    bar.busy(true);
    mount(error);
    try {
      await saveProductOrder(group.key, order, saved);
      order.forEach((id, i) => { byId.get(id).shelf_position = i + 1; });
      group.products = order.map((id) => byId.get(id));
      saved = order;
      dirty = false;
      bar.show(false);
      toast(`Orden de ${group.name} guardado.`);
    } catch (err) {
      (err?.hint ? console.warn : console.error)(err);
      mount(error, errorBox(orderErrorMessage(err, errorMessage(err)), () => renderOrder(root, "yerbas", { g: group.key === OTHER_KEY ? OTHER_PARAM : group.key })));
    } finally {
      bar.busy(false);
    }
  }

  function draw() {
    paintPicker();
    mount(error);
    saved = group.products.map((p) => p.id);
    dirty = false;
    bar.show(false);
    title.textContent = group.key === OTHER_KEY ? `${OTHER_NAME} (yerbas de distintas marcas)` : group.name;
    list = sortableList({ ids: saved, label: `Yerbas de ${group.name}`, name: (id) => byId.get(id).name, row, onChange: changed });
    mount(listSlot, list.el);
    paintPreview(saved);
  }

  mount(root,
    picker,
    confirmSlot,
    h("div", { class: "so-layout" },
      h("section", { class: "card so-card" },
        h("div", { class: "so-head" }, title,
          h("p", { class: "hint" }, "Arrastrá desde ", icon("grip", "icon so-inline-icon"), " o usá las flechas. Las presentaciones de cada yerba van juntas. Una yerba nueva, o que cambia de góndola, queda al final.")),
        error,
        listSlot),
      h("aside", { class: "card so-preview" },
        h("h3", {}, "Vista previa"),
        h("p", { class: "hint" }, "Así queda la góndola en /yerbas (solo las publicadas)."),
        preview)),
    bar.el);
  draw();
}
