// Sección "Imágenes" de un producto: galería, subir a Storage, registrar del repo,
// portada, variante, orden, texto alternativo y eliminación segura.
import * as img from "../api/images.js";
import { convertToWebp } from "../imageConvert.js";
import { h, mount, field, showError, toast, errorMessage } from "../ui.js";

const SOURCE_LABELS = { storage: "Storage", repo: "Repo", other: "Externa" };

/**
 * product:  { id, name }
 * variants: lista de variantes del producto (para asignar imágenes)
 */
export function renderImagesPanel(section, { product, variants }) {
  const gallery = h("div", { class: "image-grid" });
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

  function renderGallery() {
    if (!images.length) {
      mount(gallery, h("p", { class: "empty-box" }, "Este producto todavía no tiene imágenes."));
      return;
    }
    mount(gallery, images.map((image, index) => imageCard(image, index)));
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

  async function move(index, direction) {
    const reordered = [...images];
    const [item] = reordered.splice(index, 1);
    reordered.splice(index + direction, 0, item);
    try {
      for (let i = 0; i < reordered.length; i++) {
        if (reordered[i].sort_order !== i) await img.updateImage(reordered[i].id, { sort_order: i });
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

    // Si se borró la portada, la primera imagen restante pasa a serlo.
    if (image.is_cover) {
      try {
        const remaining = await img.listImages(product.id);
        if (remaining.length && !remaining.some((i) => i.is_cover)) {
          await img.updateImage(remaining[0].id, { is_cover: true });
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
  function imageCard(image, index) {
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
      field("Variante", variant),
      field("Texto alternativo", alt),
      h("div", { class: "actions" },
        save,
        h("button", { type: "button", class: "btn-ghost btn-sm", disabled: image.is_cover, onClick: () => setCover(image) },
          image.is_cover ? "Es la portada" : "Hacer portada"),
        h("button", { type: "button", class: "btn-ghost btn-sm", disabled: index === 0, "aria-label": "Mover antes", onClick: () => move(index, -1) }, "↑"),
        h("button", { type: "button", class: "btn-ghost btn-sm", disabled: index === images.length - 1, "aria-label": "Mover después", onClick: () => move(index, 1) }, "↓"),
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
      field("Asignar a", variant),
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
            isCover: !hasCover(),
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

  // ---------------- Registrar del repositorio ----------------
  function repoForm() {
    const path = h("input", { class: "input", placeholder: "images/2300/a.webp", "aria-label": "Ruta en el repositorio" });
    const variant = variantSelect(null);
    const error = h("p", { class: "form-error", role: "alert", hidden: true });
    const submit = h("button", { type: "submit", class: "btn-primary btn-inline" }, "Agregar");

    const form = h("form", { class: "image-add-form", novalidate: true },
      h("h4", {}, "Usar imagen del repositorio"),
      h("p", { class: "muted" }, "Para imágenes que ya están en la carpeta images/ del sitio. No se vuelven a subir."),
      field("Ruta", path, "Respetá mayúsculas, espacios y extensión."),
      field("Asignar a", variant),
      error,
      h("div", { class: "actions" }, submit)
    );

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      error.hidden = true;
      const src = path.value.trim();

      const problem = img.validateRepoPath(src);
      if (problem) { showError(error, problem); return; }
      if (images.some((i) => i.src === src)) { showError(error, "Esta imagen ya está cargada en este producto."); return; }

      submit.disabled = true;
      try {
        if (!(await img.repoFileExists(src))) {
          showError(error, "No se encontró ese archivo en el sitio. Revisá mayúsculas, espacios y extensión.");
          return;
        }
        await img.addImage({
          productId: product.id,
          variantId: selectedVariant(variant),
          src,
          alt: product.name,
          isCover: !hasCover(),
          sortOrder: nextSortOrder(),
        });
        path.value = "";
        toast("Imagen agregada.");
        await load();
      } catch (err) {
        console.error(err);
        showError(error, errorMessage(err));
      } finally {
        submit.disabled = false;
      }
    });

    return form;
  }

  // ---------------- Armado ----------------
  mount(section,
    h("h3", {}, "Imágenes"),
    h("p", { class: "muted" },
      "La portada es la imagen principal del producto. Las imágenes asignadas a una variante se muestran al elegir esa variante."),
    gallery,
    h("div", { class: "image-add" }, uploadForm(), repoForm())
  );

  return load();
}
