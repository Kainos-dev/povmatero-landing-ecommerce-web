// Panel · Productos: Publicados / Borradores, columna Costo y edición rápida de
// precio, costo y stock (variantes correctas, precio automático de yerbas
// ceil50(costo × 1,20), precio a mano respetado,
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

  // ---------- 2. Producto simple (no yerba): precio y costo general, sin cálculo automático ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    await fillQ(page, "Costo de Mate Imperial", "21000");
    check("no yerba: cambiar el costo no toca el precio", (await page.inputValue('input[aria-label="Precio de Mate Imperial"]')) === "30000" && !(await page.$eval('input[aria-label="Precio de Mate Imperial"]', (i) => i.classList.contains("is-dirty"))));
    await fillQ(page, "Precio de Mate Imperial", "32.000");
    check("edición: el input queda marcado y muestra «era $30.000 → $32.000»", await page.$eval('input[aria-label="Precio de Mate Imperial"]', (i) => i.classList.contains("is-dirty")) && /era\s\$\s?30\.000 → \$\s?32\.000/.test(await text(page, ".table-products")), await text(page, ".table-products"));
    check("edición: la fila se marca y aparece la barra «1 variante con cambios»", (await page.$$(".table-products tr.row-dirty")).length === 1 && /1 variante con cambios/.test(await text(page, ".save-bar")));
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

  // ---------- 3. Yerba con dos presentaciones: precio automático (costo × 1,20 → múltiplo de $50) ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    const P500 = 'input[aria-label="Precio de Canarias Tradicional 500gr"]', P1K = 'input[aria-label="Precio de Canarias Tradicional 1kg"]';
    const val = (sel) => page.inputValue(sel);
    const dirty = (sel) => page.$eval(sel, (i) => i.classList.contains("is-dirty"));
    check("varias presentaciones: rango de precios y botón «Editar 2»", /\$\s?5\.600 – \$\s?11\.600/.test(await text(page, ".table-products")) && !!(await page.$(".qe-toggle")));
    await page.click(".qe-toggle");
    await page.waitForTimeout(100);
    check("abierta: una fila por presentación (500gr y 1kg)", (await page.$$eval(".row-variant .c-vname", (t) => t.map((x) => x.innerText))).join("|").match(/500gr.*1kg/) != null);
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5000");
    check("costo 5000 → precio 6000 al instante, marcado", (await val(P500)) === "6000" && await dirty(P500));
    check("sin botones Aplicar/No ni casillas de sugerencia", !(await page.$(".qe-suggest")) && !(await page.$("text=Aplicar")) && !(await page.$(".table-products input[type=checkbox]:not([aria-label^='Seleccionar'])")));
    check("hint del precio: «era $5.600 → $6.000 · costo + 20 %»", /era\s\$\s?5\.600 → \$\s?6\.000 · costo \+ 20 %/.test(await text(page, ".table-products")), await text(page, ".table-products"));
    // Redondeo: exacto y hacia arriba (precio = ceil50(costo × 1,20))
    for (const [cost, want] of [["5500", "6600"], ["5501", "6650"], ["5502", "6650"], ["5545", "6700"], ["5541,66", "6650"], ["5541,67", "6700"], ["5.000", "6000"]]) {
      await fillQ(page, "Costo de Canarias Tradicional 500gr", cost);
      check(`redondeo: costo ${cost} → precio ${want}`, (await val(P500)) === want, await val(P500));
    }
    const f = await page.evaluate(async () => {
      const qe = await import("/admin/js/api/quickEdit.js");
      const ex = [6602, 6654, 6600, 6601].map((n) => qe.ceilToStep(n));
      // Igual a Math.ceil((costo * 1.20) / 50) * 50 en todos los costos enteros hasta $200.000
      let diff = 0;
      for (let c = 1; c <= 200000; c++) if (qe.yerbaPrice(c) !== Math.ceil((c * 1.2) / 50) * 50) diff++;
      // Decimales: 41,67 × 1,2 = 50,004 → 100 (no 50); 5501,67 × 1,2 = 6602,004 → 6650
      return { ex, diff, dec: [qe.yerbaPrice(41.67), qe.yerbaPrice(5501.67), qe.yerbaPrice(5545)] };
    });
    check("redondeo de los ejemplos: 6602→6650, 6654→6700, 6600→6600, 6601→6650", f.ex.join(",") === "6650,6700,6600,6650", JSON.stringify(f));
    check("fórmula = Math.ceil((costo × 1,20) / 50) × 50 para costos enteros 1…200.000", f.diff === 0, JSON.stringify(f));
    check("fórmula con centavos: 41,67 → 100 · 5501,67 → 6650 · 5545 → 6700", f.dec.join(",") === "100,6650,6700", JSON.stringify(f));
    // Volver al costo original: el precio vuelve al guardado y nada queda pendiente
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "4000");
    check("costo vuelve al original: precio vuelve a 5600 y sin pendientes", (await val(P500)) === "5600" && !(await dirty(P500)) && await page.$eval(".save-bar", (b) => b.hidden));
    // Costo vacío o inválido: no se inventa un precio
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "abc");
    check("costo inválido: el precio queda en el guardado", (await val(P500)) === "5600" && !(await dirty(P500)));
    // Costo cuyo precio calculado coincide con el actual: solo cambia el costo
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "4666");
    check("costo 4666 → 5600 (igual al actual): el precio no queda como cambio", (await val(P500)) === "5600" && !(await dirty(P500)));
    await fillQ(page, "Costo de Canarias Tradicional 500gr", "5545");
    // 1 kg: independiente; luego precio a mano y cambio de costo → se respeta
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "9000");
    check("1kg: costo 9000 → 10800, sin tocar 500gr (6700)", (await val(P1K)) === "10800" && (await val(P500)) === "6700");
    await fillQ(page, "Precio de Canarias Tradicional 1kg", "12500");
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "9500");
    check("precio escrito a mano: cambiar el costo NO lo pisa (12500, no 11400)", (await val(P1K)) === "12500");
    check("precio a mano: el hint no dice «costo + 20 %»", !/12\.500 · costo/.test(await text(page, ".table-products")));
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "8000");
    check("precio a mano: aunque el costo vuelva al original, se conserva", (await val(P1K)) === "12500" && await dirty(P1K));
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "9500");
    check("sin confirmar: nada se escribió", st.calls.filter(([m, p]) => !p.includes("/rpc/variant_commitments")).length === 0, JSON.stringify(st.calls));
    await page.click(".save-bar >> text=Revisar y guardar");
    const rv = await text(page, ".save-bar");
    check("revisión: 500gr costo y precio automático (costo + 20 %, redondeado a $50)", /500gr: costo \$\s?4\.000 → \$\s?5\.545 · precio \$\s?5\.600 → \$\s?6\.700 \(costo \+ 20 %, redondeado a \$50\)/.test(rv), rv);
    check("revisión: 1kg costo y precio a mano (sin la leyenda)", /1kg: costo \$\s?8\.000 → \$\s?9\.500 · precio \$\s?11\.600 → \$\s?12\.500$/m.test(rv), rv);
    check("revisión: sin casillas para aceptar sugerencias", !(await page.$(".save-bar input[type=checkbox]")));
    await page.click(".save-bar >> text=Confirmar y guardar");
    await page.waitForTimeout(700);
    const cost5 = calls(st, "PATCH", "variant_costs?variant_id=eq.5");
    const cost6 = calls(st, "PATCH", "variant_costs?variant_id=eq.6");
    const price5 = calls(st, "PATCH", "product_variants?id=eq.5");
    const price6 = calls(st, "PATCH", "product_variants?id=eq.6");
    check("500gr: costo 4000 → 5545 condicionado", cost5.length === 1 && /cost=eq\.4000/.test(cost5[0][1]) && cost5[0][2].cost === 5545, JSON.stringify(cost5));
    check("500gr: precio 5600 → 6700 condicionado (en la variante, no en el general)", price5.length === 1 && /price=eq\.5600/.test(price5[0][1]) && price5[0][2].price === 6700 && !calls(st, "PATCH", "/rest/v1/products?").length, JSON.stringify(price5));
    check("1kg: costo 9500 y precio manual 12500, una vez cada uno", cost6.length === 1 && cost6[0][2].cost === 9500 && price6.length === 1 && /price=eq\.11600/.test(price6[0][1]) && price6[0][2].price === 12500, JSON.stringify([cost6, price6]));
    check("cada valor en su presentación: 500gr 6700/5545, 1kg 12500/9500", st.variants.find((v) => v.id === 5).price === 6700 && st.variant_costs.find((c) => c.variant_id === 5).cost === 5545 && st.variants.find((v) => v.id === 6).price === 12500 && st.variant_costs.find((c) => c.variant_id === 6).cost === 9500);
    check("guardado: barra cerrada", await page.$eval(".save-bar", (b) => b.hidden));
    // Después de guardar, un costo nuevo vuelve a calcular el precio (el «a mano» era de la edición anterior)
    await page.click(".qe-toggle").catch(() => {});
    await page.waitForTimeout(100);
    if (!(await page.$(P1K))) await page.click(".qe-toggle");
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "10000");
    check("tras guardar: costo 10000 → precio 12000 automático", (await val(P1K)) === "12000");
    check("yerba: sin errores", !errors.length, errors.join(" | "));
    await ctx.close(); }

  // ---------- 4. Una presentación, sin cambio de costo, costo cambiado por otro ----------
  { const st = catalogState();
    const { ctx, page, errors } = await open("#/productos", st);
    await fillQ(page, "Costo de Canarias Suave", "10000");
    check("una presentación: costo 10000 → precio 12000", (await page.inputValue('input[aria-label="Precio de Canarias Suave"]')) === "12000");
    await reviewAndSave(page);
    const saved = st.variants.find((v) => v.id === 102).price === 12000 || st.products.find((p) => p.id === 61).base_price === 12000;
    check("una presentación: guarda costo 10000 y precio 12000", saved && (calls(st, "PATCH", "variant_costs?variant_id=eq.102").some(([, , b]) => b.cost === 10000) || calls(st, "PATCH", "product_internal").some(([, , b]) => b.base_cost === 10000)), JSON.stringify(st.calls));
    // Solo stock en una yerba: el precio no cambia
    const before = st.calls.length;
    await page.click(".qe-toggle");
    await fillQ(page, "Stock de Canarias Tradicional 500gr", "2");
    check("solo stock: el precio no se toca", (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 500gr"]')) === "5600");
    await reviewAndSave(page);
    check("solo stock: ningún PATCH de precio", !st.calls.slice(before).some(([m, p]) => m === "PATCH" && /product_variants|\/products\?/.test(p)), JSON.stringify(st.calls.slice(before)));
    // Otra pestaña cambió el costo: no se guarda ni el costo ni el precio calculado
    await page.click(".qe-toggle").catch(() => {});
    await page.waitForTimeout(100);
    if (!(await page.$('input[aria-label="Costo de Canarias Tradicional 1kg"]'))) await page.click(".qe-toggle");
    await fillQ(page, "Costo de Canarias Tradicional 1kg", "9000");
    st.variant_costs.find((c) => c.variant_id === 6).cost = 8200;
    const b2 = st.calls.length;
    await reviewAndSave(page);
    check("costo cambiado por otro: avisa y no guarda el precio calculado", /Cambió mientras tanto \(ahora es 8200\)/.test(await text(page)) && !st.calls.slice(b2).some(([m, p]) => m === "PATCH" && p.includes("product_variants?id=eq.6")) && st.variants.find((v) => v.id === 6).price === 11600, await text(page));
    if (!(await page.$('input[aria-label="Precio de Canarias Tradicional 1kg"]'))) await page.click(".qe-toggle");
    check("costo cambiado por otro: la tabla muestra 8200 y el precio guardado, sin pendientes", (await page.inputValue('input[aria-label="Costo de Canarias Tradicional 1kg"]')) === "8200" && (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 1kg"]')) === "11600" && await page.$eval(".save-bar", (b) => b.hidden));
    check("una presentación / sin costo / ajeno: sin errores", !errors.length, errors.join(" | "));
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
    check("celular: el precio pasa solo a 6000", (await page.inputValue('input[aria-label="Precio de Canarias Tradicional 500gr"]')) === "6000");
    check("celular: sigue sin desplazamiento horizontal con el precio calculado",await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
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
