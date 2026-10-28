// Imágenes: estado de todas las imágenes del catálogo y migración de las rutas
// del repo (images/...) a Supabase Storage. Nada se sube ni se cambia hasta confirmar.
import * as img from "../api/images.js";
import { listProducts } from "../api/catalog.js";
import { h, mount, toast, errorMessage } from "../ui.js";

const CONCURRENCY = 4;

// Tamaño entre paréntesis, o nada si el servidor no informa el peso de los archivos.
function size(bytes) {
  return bytes > 0 ? ` (${(bytes / 1048576).toFixed(1)} MB)` : "";
}

// Ejecuta fn sobre items con N tareas en paralelo, avisando el progreso.
async function runPool(items, fn, onProgress) {
  let next = 0, done = 0;
  async function worker() {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
      onProgress(++done);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

function csvCell(value) {
  const s = String(value ?? "");
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename, header, rows) {
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function renderImageMigration(view) {
  mount(view, h("p", { class: "muted" }, "Cargando imágenes…"));

  let images, productName;
  async function load() {
    const [list, products] = await Promise.all([img.listAllImages(), listProducts()]);
    images = list;
    productName = new Map(products.map((p) => [p.id, p.name]));
  }
  try {
    await load();
  } catch (err) {
    console.error(err);
    mount(view, h("p", { class: "form-error" }, errorMessage(err)));
    return;
  }

  const summary = h("section", { class: "card" });
  const plan = h("section", { class: "card" });
  const verify = h("section", { class: "card" });
  let analysis = null;     // resultado del análisis de archivos del repo
  let migrationLog = [];   // filas para el CSV
  let running = false;

  const label = (row) => `${productName.get(row.product_id) ?? `Producto ${row.product_id}`}`;

  // ---------- 1. Estado ----------
  function groupRepoImages() {
    const groups = new Map();   // "productId|src" → { productId, src, rows }
    const invalid = [];
    for (const row of images) {
      if (img.imageSource(row.src) !== "repo") continue;
      const problem = img.validateRepoPath(row.src);
      if (problem) { invalid.push({ row, problem }); continue; }
      const key = `${row.product_id}|${row.src}`;
      if (!groups.has(key)) groups.set(key, { productId: row.product_id, src: row.src, rows: [] });
      groups.get(key).rows.push(row);
    }
    return { groups: [...groups.values()], invalid };
  }

  function renderSummary() {
    const bySource = { storage: 0, repo: 0, other: 0 };
    images.forEach((i) => { bySource[img.imageSource(i.src)]++; });

    mount(summary,
      h("h3", {}, "Estado actual"),
      h("ul", { class: "change-list" },
        h("li", {}, `${images.length} imágenes registradas en ${new Set(images.map((i) => i.product_id)).size} productos.`),
        h("li", {}, `${bySource.storage} en Supabase Storage.`),
        h("li", {}, `${bySource.repo} con ruta del repo (carpeta images/ del sitio).`),
        bySource.other ? h("li", {}, `${bySource.other} con una dirección externa (no se migran).`) : null
      )
    );
  }

  // ---------- 2. Análisis y migración ----------
  async function analyze() {
    const { groups, invalid } = groupRepoImages();
    if (!groups.length && !invalid.length) {
      analysis = { groups: [], invalid: [], missing: [], ready: [], bytes: 0 };
      renderPlan();
      return;
    }

    mount(plan, h("h3", {}, "Migración a Storage"), h("p", { class: "muted" }, `Revisando ${groups.length} archivos del repo…`));
    const results = new Map();
    await runPool(groups, async (g) => { results.set(g, await img.checkImageUrl(`/${encodeURI(g.src)}`)); }, () => {});

    const missing = groups.filter((g) => !results.get(g).ok);
    const ready = groups.filter((g) => results.get(g).ok);
    const bytes = ready.reduce((sum, g) => sum + (results.get(g).bytes ?? 0), 0);
    analysis = { groups, invalid, missing, ready, bytes };
    renderPlan();
  }

  function renderPlan(confirming = false) {
    const { invalid, missing, ready, bytes } = analysis;
    const repeated = ready.filter((g) => g.rows.length > 1);
    const rowsToUpdate = ready.reduce((n, g) => n + g.rows.length, 0);

    const problems = [
      ...invalid.map(({ row, problem }) => `${label(row)} · ${row.src}: ruta no válida (${problem})`),
      ...missing.flatMap((g) => g.rows.map((row) => `${label(row)} · ${row.src}: el archivo no existe en el sitio`)),
    ];

    const button = h("button", { type: "button", class: "btn-primary btn-inline", disabled: running || !ready.length },
      ready.length ? `Migrar ${ready.length} ${ready.length === 1 ? "archivo" : "archivos"} a Storage` : "No hay nada para migrar");
    button.addEventListener("click", () => renderPlan(true));

    const confirmBox = confirming
      ? h("div", { class: "confirm-box" },
          h("p", {}, `Se van a subir ${ready.length} archivos${size(bytes)} al bucket product-images y se van a cambiar las rutas de ${rowsToUpdate} imágenes para que carguen desde Storage.`),
          h("p", {}, "Los archivos originales de la carpeta images/ no se borran ni se modifican. Si una subida falla, esa imagen queda como está."),
          h("div", { class: "actions" },
            h("button", { type: "button", class: "btn-primary btn-inline", disabled: running, onClick: migrate }, "Confirmar migración"),
            h("button", { type: "button", class: "btn-ghost", disabled: running, onClick: () => renderPlan(false) }, "Cancelar")))
      : null;

    mount(plan,
      h("h3", {}, "Migración a Storage"),
      ready.length
        ? h("p", {}, `Listas para migrar: ${ready.length} archivos${size(bytes)} usados por ${rowsToUpdate} imágenes.`)
        : h("p", {}, "No quedan imágenes del repo para migrar."),
      repeated.length
        ? h("p", { class: "muted" }, `${repeated.length} ${repeated.length === 1 ? "archivo se usa" : "archivos se usan"} más de una vez en el mismo producto (por ejemplo, portada y variante): se suben una sola vez.`)
        : null,
      problems.length
        ? h("div", { class: "notice-warn" },
            h("p", {}, `${problems.length} ${problems.length === 1 ? "imagen no se puede migrar" : "imágenes no se pueden migrar"} y quedan como están:`),
            h("ul", { class: "change-list" }, problems.map((t) => h("li", {}, t))))
        : null,
      h("div", { class: "actions" }, confirming ? null : button),
      confirmBox
    );
  }

  async function migrate() {
    running = true;
    const { ready } = analysis;
    const progress = h("p", {}, `Migrando 0 de ${ready.length}…`);
    const failures = h("ul", { class: "change-list" });
    mount(plan, h("h3", {}, "Migración a Storage"), progress, failures);
    migrationLog = [];
    let ok = 0, reused = 0, failed = 0;

    await runPool(ready, async (g) => {
      let upload;
      try {
        upload = await img.uploadRepoFile(g.productId, g.src);
        if (upload.reused) reused++;
      } catch (err) {
        console.error(err);
        failed++;
        const msg = err?.message || errorMessage(err);
        failures.append(h("li", { class: "form-error" }, `${label(g.rows[0])} · ${g.src}: ${msg}`));
        g.rows.forEach((row) => migrationLog.push([row.id, label(row), row.src, "", `error: ${msg}`]));
        return;
      }
      for (const row of g.rows) {
        try {
          await img.replaceImageSrc(row.id, row.src, upload.url);
          ok++;
          migrationLog.push([row.id, label(row), row.src, upload.url, upload.reused ? "ok (archivo ya subido)" : "ok"]);
        } catch (err) {
          console.error(err);
          failed++;
          const msg = errorMessage(err);
          failures.append(h("li", { class: "form-error" }, `${label(row)} · ${row.src}: ${msg}`));
          migrationLog.push([row.id, label(row), row.src, upload.url, `error: ${msg}`]);
        }
      }
    }, (done) => { progress.textContent = `Migrando ${done} de ${ready.length}…`; });

    running = false;
    try { await load(); } catch (err) { console.error(err); }
    renderSummary();
    await analyze();

    const result = h("div", { class: failed ? "notice-warn" : "notice-info" },
      h("p", {}, `Resultado: ${ok} imágenes actualizadas${reused ? ` (${reused === 1 ? "1 archivo ya estaba subido" : `${reused} archivos ya estaban subidos`} de antes)` : ""}${failed ? ` · ${failed} con error` : ""}.`),
      failed ? h("p", {}, "Las que fallaron siguen con su ruta del repo. Podés volver a correr la migración: no duplica archivos.") : null,
      h("div", { class: "actions" },
        h("button", { type: "button", class: "btn-ghost", onClick: () => downloadCsv("migracion-imagenes.csv", ["id", "producto", "ruta anterior", "ruta nueva", "resultado"], migrationLog) }, "Descargar registro (CSV)"))
    );
    plan.prepend(result);
    if (failures.childElementCount) plan.append(h("h4", {}, "Errores"), failures);
    toast(failed ? `Migración terminada con ${failed} errores.` : "Migración terminada.", failed ? "error" : "ok");
  }

  // ---------- 3. Verificación ----------
  function renderVerify(result = null) {
    const button = h("button", { type: "button", class: "btn-ghost" }, "Verificar todas las imágenes");
    button.addEventListener("click", async () => {
      button.disabled = true;
      button.textContent = "Verificando…";
      const broken = [];
      let done = 0;
      await runPool(images, async (row) => {
        const r = await img.checkImageUrl(img.previewUrl(row.src));
        if (!r.ok) broken.push(row);
      }, (n) => { done = n; button.textContent = `Verificando ${done} de ${images.length}…`; });
      renderVerify({ broken, total: images.length });
    });

    const repoLeft = images.filter((i) => img.imageSource(i.src) === "repo").length;
    const checklist = result ? [
      [repoLeft === 0, repoLeft === 0 ? "Ninguna imagen del catálogo usa rutas del repo." : `${repoLeft} imágenes todavía usan rutas del repo.`],
      [result.broken.length === 0, result.broken.length === 0 ? `Las ${result.total} imágenes cargan correctamente.` : `${result.broken.length} de ${result.total} imágenes no cargan.`],
    ] : [];

    mount(verify,
      h("h3", {}, "Verificación"),
      h("p", { class: "muted" }, "Comprueba que cada imagen registrada responda con una imagen válida."),
      h("div", { class: "actions" }, button),
      result
        ? h("ul", { class: "change-list" }, checklist.map(([ok, text]) => h("li", { class: ok ? "" : "form-error" }, `${ok ? "✓" : "✗"} ${text}`)))
        : null,
      result && result.broken.length
        ? h("ul", { class: "change-list" }, result.broken.map((row) => h("li", {}, h("a", { href: `#/productos/${row.product_id}` }, label(row)), ` · ${row.src}`)))
        : null,
      result && repoLeft === 0 && result.broken.length === 0
        ? h("p", { class: "notice-info" },
            "El catálogo de Supabase ya no depende de la carpeta images/. Antes de borrarla: la tienda tiene que leer de Supabase por defecto (hoy todavía usa js/products.js y la hoja WEB, que apuntan a images/), y hay que conservar los archivos propios del sitio (logo, fondos, ícono e imagen de respaldo).")
        : null
    );
  }

  mount(view,
    h("div", { class: "page-header" }, h("h2", {}, "Imágenes")),
    summary, plan, verify
  );
  renderSummary();
  renderVerify();
  await analyze();
}
