// Panel · Productos: Publicados / Borradores, columna Costo y edición rápida de
// precio, costo y stock (variantes correctas, sugerencia de yerbas costo × 1,20,
// confirmación explícita, sin duplicados, cortes de conexión, cambios ajenos).
// Supabase simulado en memoria (mock-sb.cjs) + guard.cjs: no escribe nada real.
//   node -r ./guard.cjs products-quick-edit-test.cjs .. shots
const serve = require("./serve.cjs");
const { chromium } = require(process.env.PW + "/node_modules/playwright-core");
const { installMock, catalogState } = require("./mock-sb.cjs");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], OUT = process.argv[3];
const BASE = "http://localhost:5207";
let ok = 0, fail = 0;
const check = (n, c, d = "") => { c ? ok++ : fail++; console.log(`${c ? "OK   " : "FALLA"} ${n}${!c && d ? "  → " + d : ""}`); };
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const srv = await serve(ROOT, 5207);
  const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };

  async function open(hash, st, vp = DESK, extra) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: vp.width < 700, hasTouch: vp.width < 700 });
    await installMock(ctx, st, { extra });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (mm) => { if (mm.type() === "error" && !/Failed to load resource|net::ERR_FAILED/.test(mm.text())) errors.push(mm.text()); });
    await page.goto(BASE + "/admin/" + hash);
    await page.waitForFunction(() => document.querySelector(".table-products tbody tr"), null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(250);
    return { ctx, page, errors };
  }
  const text = (page, sel = "#adminContent") => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
  const toastText = (page) => page.evaluate(() => document.querySelector(".toast")?.textContent ?? "");
  const names = (page) => page.$$eval(".table-products tbody tr:not(.row-variant) .c-name a", (a) => a.map((x) => x.textContent));
  const calls = (st, m, frag) => st.calls.filter(([mm, p]) => mm === m && p.includes(frag));
  const fillQ = async (page, label, value) => { await page.fill(`input[aria-label="${label}"]`, value); await page.waitForTimeout(80); };
  async function reviewAndSave(page) {
    await page.click(".save-bar >> text=Revisar y guardar");
    await page.waitForTimeout(100);
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForFunction(() => !/Guardando/.test(document.querySelector(".save-bar")?.innerText ?? ""), null, { timeout: 10000 });
    await page.waitForTimeout(300);
  }

  // ---------- 1. Tabla: columnas, Publicados / Borradores, búsqueda ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    const heads = await page.$$eval(".table-products thead th", (t) => t.map((x) => x.innerText.trim()).filter(Boolean));
    check("columnas: … Precio · Costo · Stock (Costo entre Precio y Stock)", heads.join(",").toLowerCase() === "producto,sku,categoría,variantes,precio,costo,stock", heads.join(","));
    check("columnas: ya no está «Estado»", !heads.some((h) => /estado/i.test(h)));
    const seg = await page.$$eval(".product-groups button", (b) => b.map((x) => ({ t: x.innerText.replace(/\s+/g, " ").trim(), on: x.classList.contains("active") })));
    check("selector: «Publicados 3» activo y «Borradores 1»", seg.length === 2 && /Publicadoss*3/.test(seg[0].t) && seg[0].on && /Borradoress*1/.test(seg[1].t) && !seg[1].on, JSON.stringify(seg));
    check("al entrar: solo publicados", (await names(page)).sort().join(",") === "Canarias Suave,Canarias Tradicional,Mate Imperial", (await names(page)).join(","));
    await page.click(".product-groups >> text=Borradores");
    await page.waitForTimeout(100);
    check("Borradores: solo Sara Tradicional", (await names(page)).join(",") === "Sara Tradicional");
    await page.click(".product-groups >> text=Publicados");
    await page.fill('input[aria-label="Buscar"]', "sara");
    await page.waitForTimeout(100);
    check("búsqueda en Publicados: avisa «1 coincidencia en Borradores»", /1 coincidencia en Borradores/.test(await text(page, ".product-count")) && (await names(page)).length === 0);
    await page.click(".product-count .link-btn");
    await page.waitForTimeout(100);
    check("tocar el aviso: pasa a Borradores con la búsqueda", (await names(page)).join(",") === "Sara Tradicional" && await page.$eval(".product-groups button.active", (b) => /Borradores/.test(b.innerText)));
    await page.fill('input[aria-label="Buscar"]', "");
    await page.selectOption('select[aria-label="Categoría"]', "5");
    await page.click(".product-groups >> text=Publicados");
    await page.waitForTimeout(100);
    check("categoría + selector: Yerbas publicadas", (await names(page)).sort().join(",") === "Canarias Suave,Canarias Tradicional");
    await page.selectOption('select[aria-label="Categoría"]', "");
    // Acción en lote desde Borradores (publicar) sigue funcionando
    await page.click(".product-groups >> text=Borradores");
    await page.waitForTimeout(100);
    await page.click('input[aria-label="Seleccionar Sara Tradicional"]');
    await page.click(".bulk-bar >> text=Publicar");
    await page.click(".bulk-bar >> text=Confirmar publicación");
    await page.waitForTimeout(400);
    check("lote: publicar un borrador (PATCH is_active) y pasa a Publicados", calls(st, "PATCH", "/products").some(([, , b]) => b?.is_active === true) && /Publicadoss*4/.test(await text(page, ".product-groups")));
    // Enlace de Inicio a borradores
    await page.goto(BASE + "/admin/#/productos?estado=draft");
    await page.waitForTimeout(500);
    check("enlace ?estado=draft abre Borradores", await page.$eval(".product-groups button.active", (b) => /Borradores/.test(b.innerText)));
    // Clic en la fila abre la ficha; clic en un input no
    await page.goto(BASE + "/admin/#/productos");
    await page.waitForFunction(() => document.querySelector('input[aria-label="Precio de Mate Imperial"]'));
    await page.click('input[aria-label="Precio de Mate Imperial"]');
    await page.waitForTimeout(150);
    check("clic en un valor no abre la ficha", (await page.evaluate(() => location.hash)) === "#/productos");
    await page.click(".table-products tbody tr >> text=Mate Imperial");
    await page.waitForTimeout(300);
    check("clic en el nombre sigue abriendo la ficha", /#\/productos\/2/.test(await page.evaluate(() => location.hash)));
    check("tabla: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 2. Producto simple (no yerba): precio y costo general, sin sugerencia ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    await fillQ(page, "Precio de Mate Imperial", "32.000");
    check("edición: el input queda marcado y muestra «era $30.000 → $32.000»", await page.$eval('input[aria-label="Precio de Mate Imperial"]', (i) => i.classList.contains("is-dirty")) && /era\s\$\s?30\.000 → \$\s?32\.000/.test(await text(page, ".table-products")), await text(page, ".table-products"));
    check("edición: la fila se marca y aparece la barra «1 variante con cambios»", (await page.$$(".table-products tr.row-dirty")).length === 1 && /1 variante con cambios/.test(await text(page, ".save-bar")));
    await fillQ(page, "Costo de Mate Imperial", "21000");
    check("no yerba: sin precio sugerido", !(await page.$(".qe-suggest:visible")));
    check("sin confirmar: nada se escribió", st.calls.filter(([m, p]) => !p.includes("/rpc/variant_commitments")).length === 0, JSON.stringify(st.calls));
    await page.click(".save-bar >> text=Revisar y guardar");
    const rv = await text(page, ".save-bar");
    check("revisión: lista costo y precio con el valor anterior", /costo \$\s?20\.000 → \$\s?21\.000/.test(rv) && /precio \$\s?30\.000 → \$\s?32\.000/.test(rv), rv);
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(600);
    const pPatch = calls(st, "PATCH", "/rest/v1/products?");
    check("simple que hereda: guarda el precio GENERAL, condicionado al anterior", pPatch.length === 1 && /base_price=eq\.30000/.test(pPatch[0][1]) && pPatch[0][2].base_price === 32000, JSON.stringify(pPatch));
    const iPatch = calls(st, "PATCH", "/product_internal");
    check("simple que hereda: guarda el costo GENERAL, condicionado al anterior", iPatch.length === 1 && /base_cost=eq\.20000/.test(iPatch[0][1]) && iPatch[0][2].base_cost === 21000, JSON.stringify(iPatch));
    check("no toca la variante directamente", !calls(st, "PATCH", "/product_variants").length);
    check("guardado: aviso y barra cerrada", /1 variante guardada/.test(await toastText(page)) && await page.$eval(".save-bar", (b) => b.hidden));
    check("simple: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 3. Yerba con dos presentaciones: sugerencia aceptada / rechazada ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    check("varias presentaciones: rango de precios y botón «Editar 2»", /\$\s?5\.600 – \$\s?11\.600/.test(await text(page, ".table-products")) && !!(await page.$(".qe-toggle")));
    await page.click(".qe-toggle");
    await page.waitForTimeout(100);
    check("abierta: una fila por presentación (500gr y 1kg)", (await page.$$eval(".row-variant .c-vname", (t) => t.map((x) => x.innerText))).join("|").match(/500gr.*1kg/) != null);
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5000");
    const sug = await page.locator(".qe-suggest:visible").first().innerText();
    check("yerba: costo $5.000 → «Precio sugerido: $6.000 (costo + 20 %)»", /Precio sugerido: \$\s?6\.000/.test(sug), sug);
    check("sugerencia: no cambia el precio sola", (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 500gr"]')) === "5600");
    await page.click(".qe-suggest:visible >> text=Aplicar");
    check("aplicar: el precio pasa a 6000 y queda marcado", (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 500gr"]')) === "6000" && await page.$eval('input[aria-label="Precio de Canarias Tradicional 500gr"]', (i) => i.classList.contains("is-dirty")));
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5100");
    check("aceptada: si cambio el costo, el precio sigue la sugerencia (5100 × 1,20 = 6120)", (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 500gr"]')) === "6120");
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5000");
    // 1 kg: rechazar
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "9000");
    const boxes = await page.$$(".qe-suggest:visible");
    await boxes[1].evaluate((b) => [...b.querySelectorAll("button")].find((x) => x.textContent === "No").click());
    await page.waitForTimeout(80);
    check("rechazar: la sugerencia se oculta y el precio no cambia", (await page.$$(".qe-suggest:visible")).length === 1 && (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 1kg"]')) === "11600");
    await page.click(".save-bar >> text=Revisar y guardar");
    const rv = await text(page, ".save-bar");
    check("revisión: 500gr costo y precio (costo + 20 %); 1kg solo costo", /500gr: costo \$\s?4\.000 → \$\s?5\.000 · precio \$\s?5\.600 → \$\s?6\.000 \(costo \+ 20 %\)/.test(rv) && /1kg: costo \$\s?8\.000 → \$\s?9\.000$/m.test(rv), rv);
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    const cost5 = calls(st, "PATCH", "variant_costs?variant_id=eq.5");
    const cost6 = calls(st, "PATCH", "variant_costs?variant_id=eq.6");
    const price5 = calls(st, "PATCH", "product_variants?id=eq.5");
    const price6 = calls(st, "PATCH", "product_variants?id=eq.6");
    check("500gr: costo 4000 → 5000 condicionado", cost5.length === 1 && /cost=eq\.4000/.test(cost5[0][1]) && cost5[0][2].cost === 5000, JSON.stringify(cost5));
    check("500gr: precio 5600 → 6000 condicionado (en la variante, no en el general)", price5.length === 1 && /price=eq\.5600/.test(price5[0][1]) && price5[0][2].price === 6000 && !calls(st, "PATCH", "/rest/v1/products?").length, JSON.stringify(price5));
    check("1kg: solo el costo (rechazó la sugerencia), precio intacto", cost6.length === 1 && cost6[0][2].cost === 9000 && price6.length === 0 && st.variants.find((v) => v.id === 6).price === 11600);
    check("cada valor en su presentación: 500gr 6000/5000, 1kg 11600/9000", st.variants.find((v) => v.id === 5).price === 6000 && st.variant_costs.find((c) => c.variant_id === 5).cost === 5000 && st.variant_costs.find((c) => c.variant_id === 6).cost === 9000);
    check("yerba: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 4. Sugerencia sin decidir (se decide en la revisión) y precio manual ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    await fillQ(page, "Costo de Canarias Suave", "10000");
    await page.click(".save-bar >> text=Revisar y guardar");
    const rv = await text(page, ".save-bar");
    check("revisión: pregunta si actualizar el precio a $12.000 (costo × 1,20)", /Actualizar también el precio de venta: \$\s?13\.900 → \$\s?12\.000 \(costo × 1,20\)/.test(rv), rv);
    await page.check(".qe-review-opt input");
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    check("marcada en la revisión: guarda costo 10000 y precio 12000 juntos", calls(st, "PATCH", "variant_costs?variant_id=eq.102").some(([, , b]) => b.cost === 10000) && calls(st, "PATCH", "product_variants?id=eq.102").some(([, p, b]) => b.price === 12000 && /price=eq\.13900/.test(p)));
    // Sin marcar: solo costo
    await page.click(".qe-toggle");
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "4500");
    await page.click(".save-bar >> text=Revisar y guardar");
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    check("sin marcar la sugerencia: guarda solo el costo", calls(st, "PATCH", "variant_costs?variant_id=eq.5").some(([, , b]) => b.cost === 4500) && !calls(st, "PATCH", "product_variants?id=eq.5").length);
    // Precio manual: se respeta
    await page.click(".qe-toggle").catch(() => {});
    await page.waitForTimeout(100);
    if (!(await page.$('input[aria-label="Precio de Canarias Tradicional 1kg"]'))) await page.click(".qe-toggle");
    await fillQ(page, "Precio de Canarias Tradicional 1kg", "12500");
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "8500");
    check("precio escrito a mano: la sugerencia lo respeta", /Se respeta el precio que escribiste/.test(await page.locator(".qe-suggest:visible").first().innerText()) && (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 1kg"]')) === "12500");
    await page.click(".save-bar >> text=Revisar y guardar");
    check("revisión: sin casilla de sugerencia cuando el precio es manual", !(await page.$(".qe-review-opt")));
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    check("precio manual guardado tal cual (12500, no 10200)", calls(st, "PATCH", "product_variants?id=eq.6").some(([, , b]) => b.price === 12500));
    check("sin editar el costo, ningún precio cambia (Mate Imperial intacto)", !calls(st, "PATCH", "/rest/v1/products?").length && !calls(st, "PATCH", "product_variants?id=eq.21").length);
    check("sugerencia/manual: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 5. Stock: movimiento por la diferencia, reservas, corte de conexión, doble clic ----------
  { const st = catalogState();
    st.commitments = [{ variant_id: 5, quantity: 1 }];
    let dropOnce = true;
    // La primera vez la base registra la operación pero la respuesta se pierde (corte).
    const extra = ({ route, p, st: s, body }) => {
      if (p === "/rest/v1/rpc/admin_stock_movement" && dropOnce && body()?.variant_id === 21) {
        dropOnce = false;
        const a = body(); s.operations.add(a.operation_id);
        const v = s.variants.find((x) => x.id === 21); v.stock += a.quantity;
        s.inventory_movements.unshift({ id: 1, variant_id: 21, movement_type: "entrada", quantity: a.quantity, stock_after: v.stock });
        return route.abort("failed");
      }
    };
    const { ctx, page, errors } = await open("#/productos", st, DESK, extra);
    await fillQ(page, "Stock de Mate Imperial", "5");
    check("stock: muestra «era 3 (+2)»", /era 3 \(\+2\)/.test(await text(page, ".table-products")));
    await page.click(".save-bar >> text=Revisar y guardar");
    check("revisión: «stock 3 → 5 (entrada +2)»", /stock 3 → 5 \(entrada \+2\)/.test(await text(page, ".save-bar")));
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(800);
    const v21 = st.variants.find((v) => v.id === 21);
    check("respuesta perdida (la base sí guardó): al recargar se confirma, sin error ni pendiente", !/Se cortó la conexión/.test(await text(page)) && await page.$eval(".save-bar", (b) => b.hidden) && (await page.inputValue('input[aria-label="Stock de Mate Imperial"]')) === "5", await text(page));
    check("respuesta perdida: una sola entrada (stock 5)", st.inventory_movements.filter((m) => m.variant_id === 21).length === 1 && v21.stock === 5);
    // Corte ANTES de llegar a la base: queda pendiente; el reintento usa la misma operación.
    await fillQ(page, "Stock de Mate Imperial", "7");
    const before = calls(st, "POST", "admin_stock_movement").length;
    st.failNext = { path: "/rpc/admin_stock_movement", method: "POST" };
    await reviewAndSave(page);
    check("corte antes de llegar: avisa y deja el cambio pendiente", /Se cortó la conexión/.test(await text(page)) && /1 variante con cambios/.test(await text(page, ".save-bar")) && v21.stock === 5, await text(page));
    const tries = () => calls(st, "POST", "admin_stock_movement").slice(before).filter(([, , b]) => b.variant_id === 21);
    await reviewAndSave(page);
    check("reintento: registra una vez, con la MISMA operación", tries().length >= 2 && new Set(tries().map(([, , b]) => b.operation_id)).size === 1 && v21.stock === 7 && st.inventory_movements.filter((m) => m.variant_id === 21).length === 2, JSON.stringify({ ops: tries().map(([, , b]) => b.operation_id.slice(0, 8)), mv: st.inventory_movements.filter((m) => m.variant_id === 21).length, stock: v21.stock }));
    await reviewAndSave(page).catch(() => {});
    check("reintento: el cambio deja de estar pendiente (y no se repite)", await page.$eval(".save-bar", (b) => b.hidden) && v21.stock === 7);
    // Baja que no cubre reservas: pide confirmación explícita
    await page.click(".qe-toggle");
    await fillQ(page, "Stock de Canarias Tradicional 500gr", "0");
    await page.click(".save-bar >> text=Revisar y guardar");
    check("baja bajo lo reservado: avisa «Hay 1 reservadas… quedarían 0»", /Hay 1 reservadas en pedidos web y quedarían 0/.test(await text(page, ".save-bar")));
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(300);
    check("sin confirmar las reservas: no guarda", !calls(st, "POST", "admin_stock_movement").some(([, , b]) => b.variant_id === 5));
    await page.check(".qe-review-opt input");
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    const s5 = calls(st, "POST", "admin_stock_movement").filter(([, , b]) => b.variant_id === 5);
    check("confirmado: salida 1, stock declarado 0, confirm_shortage, desde «inventario»", s5.length === 1 && s5[0][2].movement_type === "salida" && s5[0][2].quantity === 1 && s5[0][2].declared_physical === 0 && s5[0][2].confirm_shortage === true && s5[0][2].source === "inventario", JSON.stringify(s5));
    // Doble clic en Confirmar: una sola operación
    await fillQ(page, "Stock de Canarias Tradicional 1kg", "4");
    await page.click(".save-bar >> text=Revisar y guardar");
    st.slow = 400;
    await page.evaluate(() => { const b = [...document.querySelectorAll(".save-bar button")].find((x) => x.textContent === "Confirmar y guardar"); b.click(); b.click(); });
    await page.waitForTimeout(1500);
    st.slow = 0;
    check("doble clic: una sola entrada para 1kg", calls(st, "POST", "admin_stock_movement").filter(([, , b]) => b.variant_id === 6).length === 1 && st.variants.find((v) => v.id === 6).stock === 4);
    check("stock: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 6. Cambio ajeno mientras se editaba, valores inválidos ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    await fillQ(page, "Precio de Canarias Suave", "abc");
    await page.click(".save-bar >> text=Revisar y guardar");
    check("inválido: lo marca y no deja confirmar", /el precio debe ser un número mayor a 0/.test(await text(page, ".save-bar")) && await page.$eval(".save-bar .btn-primary", (b) => b.disabled));
    await page.click(".save-bar >> text=Volver a editar");
    await fillQ(page, "Precio de Canarias Suave", "14500");
    st.variants.find((v) => v.id === 102).price = 14000;   // otra pestaña lo cambió
    await reviewAndSave(page);
    check("cambio ajeno: no pisa (precio sigue 14000) y lo avisa", st.variants.find((v) => v.id === 102).price === 14000 && /Cambió mientras tanto \(ahora es 14000\)/.test(await text(page)), await text(page));
    check("cambio ajeno: la tabla muestra el valor nuevo", (await page.inputValue('input[aria-label="Precio de Canarias Suave"]')) === "14000");
    check("cambio ajeno: sin errores de consola", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 7. Celular ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st, PHONE);
    check("celular: sin desplazamiento horizontal", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const box = await page.$eval('input[aria-label="Precio de Mate Imperial"]', (i) => { const r = i.getBoundingClientRect(); return { w: r.width, h: r.height, fs: getComputedStyle(i).fontSize }; });
    check("celular: inputs cómodos (≥ 40 px de alto, letra 16 px sin zoom)", box.h >= 40 && box.fs === "16px", JSON.stringify(box));
    const labels = await page.$$eval(".table-products tbody tr:first-child .c-qe", (t) => t.map((x) => getComputedStyle(x, "::before").content));
    check("celular: etiquetas Precio / Costo / Stock en la tarjeta", labels.join(",").includes("Precio") && labels.join(",").includes("Costo"), labels.join(","));
    await page.click(".qe-toggle");
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5000");
    check("celular: sugerencia visible", /Precio sugerido: \$\s?6\.000/.test(await page.locator(".qe-suggest:visible").first().innerText()));
    await page.click(".qe-suggest:visible >> text=Aplicar");
    check("celular: sigue sin desplazamiento horizontal con la sugerencia", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(OUT, "productos-390.png"), fullPage: true });
    await reviewAndSave(page);
    check("celular: guarda costo y precio", st.variants.find((v) => v.id === 5).price === 6000 && st.variant_costs.find((c) => c.variant_id === 5).cost === 5000);
    check("celular: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }
  { const st = catalogState();
    const { ctx, page } = await open("#/productos", st);
    await page.click(".qe-toggle");
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5000");
    await page.screenshot({ path: path.join(OUT, "productos-1440.png"), fullPage: true });
    await ctx.close(); }

  await browser.close(); srv.close();
  console.log(`\n${ok} OK · ${fail} fallas`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
