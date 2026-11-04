// Copia imágenes que ya tenés en disco a la caché de las pruebas (sin red).
//   node seed-image-cache.cjs <carpeta> [<carpeta>…]
// Se guardan por nombre de archivo (ej. shelf-1793662327309.png): guard.cjs
// las usa cuando una prueba pide esa imagen de Storage.
const fs = require("fs"), path = require("path");
const CACHE_DIR = process.env.GUARD_CACHE_DIR || path.join(__dirname, ".image-cache");
const dest = path.join(CACHE_DIR, "by-name");
fs.mkdirSync(dest, { recursive: true });
let n = 0, bytes = 0;
for (const dir of process.argv.slice(2)) {
  for (const f of fs.readdirSync(dir).filter((f) => /\.(png|webp|jpe?g|avif)$/i.test(f))) {
    const to = path.join(dest, f);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(dir, f), to);
    n++; bytes += fs.statSync(to).size;
  }
}
console.log(`Caché: ${n} imágenes nuevas (${(bytes / 1048576).toFixed(2)} MB) en ${dest}`);
