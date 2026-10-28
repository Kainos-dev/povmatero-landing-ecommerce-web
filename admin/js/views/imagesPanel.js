// Sección "Imágenes" de un producto: galería del producto e imágenes de variantes,
// subir a Storage, portada, orden, texto alternativo y eliminación segura.
// Las rutas viejas del repo (images/...) se pasan a Storage desde la pantalla "Imágenes".
import * as img from "../api/images.js";
import { convertToWebp } from "../imageConvert.js";
import { h, mount, field, showError, toast, errorMessage } from "../ui.js";

const SOURCE_LABELS = { storage: "Storage", repo: "Repo", other: "Externa" };

/**
 * product:  { id, name }
 * variants: lista de variantes del producto (para asignar imágenes)
 */
export function renderImagesPanel(section, { product, variants }) {
  const gallery = h("div", { class: "image-groups" });
  let images = [];

  const variantName = new Map(variants.map((v) => [v.id, v.name]));

  function variantSelect(selected) {
    const select = h("select", { class: "input", "aria-label": "Variante" },
      h("option", { value: "" }, "Todo el producto"),
      variants.map((v) => h("option", { value: String(v.id) }, v.is_active ? v.name : `${v.name} (inactiva)`))
    );
    select.value = selected == null ? "" : String(selected);
    return select;
  }
  const selectedVariant = (select) => (select.value === "" ? null : Number(select.value));
  const nextSortOrder = () => (images.length ? Math.max(...images.map((i) => i.sort_order)) + 1 : 0);
  const hasCover = () => images.some((i) => i.is_cover);

  async function load() {
    mount(gallery, h("p", { class: "muted" }, "Cargando imágenes…"));
    try {
      images = await img.listImages(product.id);
    } catch (err) {
      console.error(err);
      mount(gallery, h("p", { class: "form-error" }, errorMessage(err)));
      return;
    }
    renderGallery();
  }

  // Galería del producto (sin variante) y, aparte, las imágenes de cada variante.
  // El orden se cambia dentro de cada grupo.
  const productImages = () => images.filter((i) => i.variant_id == null);
  const variantImages = () => images.filter((i) => i.variant_id != null);

  function renderGallery() {
    if (!images.length) {
      mount(gallery, h("p", { class: "empty-box" }, "Este producto todavía no tiene imágenes."));
      return;
    }
    const own = productImages();
    const byVariant = variantImages();
    mount(gallery,
      h("h4", {}, "Galería del producto"),
      own.length
        ? h("div", { class: "image-grid" }, own.map((image, index) => imageCard(image, index, own)))
        : h("p", { class: "muted" }, "Sin imágenes generales. Subí fotos con “Asignar a: Todo el producto”."),
      byVariant.length
        ? [h("h4", {}, "Imágenes de variantes"),
           h("p", { class: "muted" }, "Se muestran en la tienda al elegir esa variante."),
           h("div", { class: "image-grid" }, byVariant.map((image, index) => imageCard(image, index, byVariant)))]
        : null
    );
  }

  // ---------------- Acciones ----------------
  async function setCover(image) {
    const current = images.find((i) => i.is_cover);
    try {
      // La base admite una sola portada: primero se desmarca la anterior.
      if (current && current.id !== image.id) await img.updateImage(current.id, { is_cover: false });
      await img.updateImage(image.id, { is_cover: true });
      toast("Portada actualizada.");
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), "error");
    }
    await load();
  }

  // Mueve una imagen dentro de su grupo y renumera el orden de todas, para que
  // los dos grupos no compartan números.
  async function move(group, index, direction) {
    const reordered = [...group];
    const [item] = reordered.splice(index, 1);
    reordered.splice(index + direction, 0, item);
    const all = item.variant_id == null
      ? [...reordered, ...variantImages()]
      : [...productImages(), ...reordered];
    try {
      for (let i = 0; i < all.length; i++) {
        if (all[i].sort_order !== i) await img.updateImage(all[i].id, { sort_order: i });
      }
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), "error");
    }
    await load();
  }

  async function remove(image) {
    let result;
    try {
      result = await img.deleteImage(image, product.id);
    } catch (err) {
      console.error(err);
      toast(errorMessage(err), "error");
      await load();
      return;
    }

    let message = "Imagen quitada del producto.";
    let type = "ok";
    if (result.source === "storage") {
      if (result.fileRemoved) {
        message += " El archivo se borró del Storage.";
      } else {
        message += ` El archivo quedó en el Storage: ${result.reason}.`;
        type = "error";
      }
    } else if (result.source === "repo") {
      message += " El archivo del repositorio no se tocó.";
    }

    // Si se borró la portada, pasa a serlo la primera de la galería del producto
    // (o, si no hay, la primera imagen restante).
    if (image.is_cover) {
      try {
        const remaining = await img.listImages(product.id);
        const next = remaining.find((i) => i.variant_id == null) ?? remaining[0];
        if (next && !remaining.some((i) => i.is_cover)) {
          await img.updateImage(next.id, { is_cover: true });
          message += " La primera imagen pasó a ser la portada.";
        }
      } catch (err) {
        console.error(err);
        message += " No se pudo asignar una nueva portada.";
        type = "error";
      }
    }

    toast(message, type);
    await load();
  }

  // ---------------- Tarjeta ----------------
  function imageCard(image, index, group) {
    const source = img.imageSource(image.src);
    const alt = h("input", { class: "input", maxlength: "160", value: image.alt, placeholder: "Texto alternativo", "aria-label": "Texto alternativo" });
    const variant = variantSelect(image.variant_id);
    const save = h("button", { type: "button", class: "btn-primary btn-sm", disabled: true }, "Guardar");
    const confirmSlot = h("div");

    const markDirty = () => { save.disabled = false; };
    alt.addEventListener("input", markDirty);
    variant.addEventListener("change", markDirty);

    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await img.updateImage(image.id, { alt: alt.value.trim(), variant_id: selectedVariant(variant) });
        toast("Imagen guardada.");
      } catch (err) {
        console.error(err);
        toast(errorMessage(err), "error");
      }
      await load();
    });

    const deleteButton = h("button", { type: "button", class: "btn-ghost btn-sm btn-danger" }, "Eliminar");
    deleteButton.addEventListener("click", () => {
      const detail = source === "storage"
        ? "Se quita del producto y se borra el archivo del Storage."
        : "Se quita del producto. El archivo del repositorio no se borra.";
      const yes = h("button", { type: "button", class: "btn-primary btn-sm btn-danger-solid" }, "Sí, eliminar");
      const no = h("button", { type: "button", class: "btn-ghost btn-sm", onClick: () => mount(confirmSlot) }, "Cancelar");
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        no.disabled = true;
        await remove(image);
      });
      mount(confirmSlot, h("div", { class: "confirm-box" },
        h("p", {}, "¿Eliminar esta imagen? ", detail),
        h("div", { class: "actions" }, yes, no)
      ));
    });

    return h("article", { class: "image-card" },
      h("div", { class: "image-thumb" },
        h("img", { src: img.previewUrl(image.src), alt: image.alt || product.name, loading: "lazy" })
      ),
      h("div", { class: "image-badges" },
        image.is_cover ? h("span", { class: "badge badge-ok" }, "Portada") : null,
        h("span", { class: "badge" }, SOURCE_LABELS[source]),
        h("span", { class: "badge" }, image.variant_id == null ? "Todo el producto" : (variantName.get(image.variant_id) ?? "Variante"))
      ),
      h("p", { class: "image-src", title: image.src }, source === "storage" ? img.storagePathFromSrc(image.src) : image.src),
      variants.length || image.variant_id != null ? field("Asignar a", variant) : null,
      field("Texto alternativo", alt),
      h("div", { class: "actions" },
        save,
        // La portada se elige entre las imágenes de la galería del producto.
        image.variant_id == null || image.is_cover
          ? h("button", { type: "button", class: "btn-ghost btn-sm", disabled: image.is_cover, onClick: () => setCover(image) },
              image.is_cover ? "Es la portada" : "Hacer portada")
          : null,
        h("button", { type: "button", class: "btn-ghost btn-sm", disabled: index === 0, "aria-label": "Mover antes", onClick: () => move(group, index, -1) }, "↑"),
        h("button", { type: "button", class: "btn-ghost btn-sm", disabled: index === group.length - 1, "aria-label": "Mover después", onClick: () => move(group, index, 1) }, "↓"),
        deleteButton
      ),
      confirmSlot
    );
  }

  // ---------------- Subir a Storage ----------------
  function uploadForm() {
    const fileInput = h("input", { type: "file", class: "input", accept: "image/jpeg,image/png,image/webp,image/avif", multiple: true });
    const variant = variantSelect(null);
    const status = h("p", { class: "muted", hidden: true });
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Subir");

    const form = h("form", { class: "image-add-form", novalidate: true },
      h("h4", {}, "Subir imágenes"),
      h("p", { class: "muted" }, "Se convierten a WebP (máx. 1600 px, calidad 85 %) antes de subirse."),
      field("Archivos", fileInput),
      variants.length ? field("Asignar a", variant) : null,
      status,
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const files = [...(fileInput.files ?? [])];
      if (!files.length) { showError(error, "Elegí al menos una imagen."); return; }

      submit.disabled = true;
      status.hidden = false;
      const failures = [];
      let uploaded = 0;

      for (const [i, file] of files.entries()) {
        const step = files.length > 1 ? ` (${i + 1} de ${files.length})` : "";
        try {
          status.textContent = `Convirtiendo “${file.name}”${step}…`;
          const { blob } = await convertToWebp(file);
          status.textContent = `Subiendo “${file.name}”${step}…`;
          await img.uploadImage(product.id, blob, file.name, {
            variantId: selectedVariant(variant),
            alt: product.name,
            // La primera imagen de la galería pasa a ser la portada si todavía no hay.
            isCover: !hasCover() && selectedVariant(variant) == null,
            sortOrder: nextSortOrder(),
          });
          uploaded++;
          images = await img.listImages(product.id); // mantiene portada y orden al día
        } catch (err) {
          console.error(err);
          failures.push(`${file.name}: ${errorMessage(err)}`);
        }
      }

      fileInput.value = "";
      submit.disabled = false;
      status.hidden = true;
      if (failures.length) showError(error, `No se pudieron subir ${failures.length}: ${failures.join(" · ")}`);
      if (uploaded) toast(uploaded === 1 ? "Imagen subida." : `${uploaded} imágenes subidas.`);
      await load();
    });

    return form;
  }

  // ---------------- Armado ----------------
  mount(section,
    h("h3", {}, "Imágenes"),
    h("p", { class: "muted" },
      "La portada es la imagen principal del producto y se elige entre las de la galería. ",
      "Las demás imágenes de la galería se muestran en la ficha del producto. ",
      "Las imágenes asignadas a una variante se muestran al elegir esa variante. ",
      "Todo se guarda en Supabase Storage."),
    gallery,
    h("div", { class: "image-add" }, uploadForm())
  );

  return load();
}
