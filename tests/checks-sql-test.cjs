// El SQL de controles de 20261112 corre sin errores después de la migración.
const { PGlite } = require(process.env.PW + "/node_modules/@electric-sql/pglite");
const fs = require("fs"), path = require("path");
const ROOT = process.argv[2], MIG = path.join(ROOT, "supabase/migrations");
const STUB = fs.readFileSync(path.join(__dirname, "db-test.cjs"), "utf8").match(/const STUB = `([\s\S]*?)`;/)[1];
(async () => {
  const db = new PGlite();
  await db.exec(STUB);
  for (const f of fs.readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) await db.exec(fs.readFileSync(path.join(MIG, f), "utf8"));
  const sql = fs.readFileSync(path.join(ROOT, "supabase/checks/20261112_antes_y_despues_cancelacion.sql"), "utf8");
  const parts = sql.split(/;\s*\n/).map((s) => s.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean);
  for (const p of parts) { const r = await db.query(p); console.log(JSON.stringify(r.rows[0] ?? {})); }
})().catch((e) => { console.error("ERROR", e.message); process.exit(1); });
