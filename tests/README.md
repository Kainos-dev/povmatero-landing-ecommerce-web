# Pruebas locales de Povmatero

No se publican (`.vercelignore`). Nunca escriben en Supabase real ni descargan
imágenes de Storage: todo se corre con la protección `guard.cjs`.

## Requisitos

- Node 20+ y Google Chrome instalado (`C:/Program Files/Google/Chrome/Application/chrome.exe`).
- Una carpeta con `playwright-core`, `@electric-sql/pglite`, `embedded-postgres` y `pg`
  instalados (`npm i playwright-core @electric-sql/pglite embedded-postgres pg`).
  Su ruta va en la variable `PW`.

```sh
export PW=/ruta/a/la/carpeta/con/node_modules
cd tests
```

## Base de datos (Postgres en memoria / embebido, sin Supabase)

```sh
node db-test.cjs ..                 # todas las migraciones + reglas de pedidos, stock, avisos
node cancel-db-test.cjs ..          # 20261112: cancelación por falta de respuesta (72 h)
node cancel-concurrency-test.cjs .. # lo mismo con conexiones simultáneas (Postgres 17)
node checks-sql-test.cjs ..         # el SQL de controles corre sin errores
node cron-test.cjs ..               # /api/cron-pedidos sin red
node legacy/concurrency-test.cjs .. # proveedor, ventas, conciliación a la vez
```

## Navegador (Supabase simulado + guard)

```sh
node -r ./guard.cjs products-quick-edit-test.cjs .. shots   # Productos: edición rápida, Publicados/Borradores
node -r ./guard.cjs contact-modal-test.cjs .. shots       # modal de contacto (TikTok), todas las entradas
node -r ./guard.cjs yerbas-header-test.cjs .. shots        # /yerbas: encabezado alineado, contador de variedades
node -r ./guard.cjs yerbas-cart-test.cjs .. shots          # /yerbas: carrito flotante, título, aviso de stock
node -r ./guard.cjs yerba-admin-test.cjs .. shots
node -r ./guard.cjs orders-cancel-test.cjs .. shots
node -r ./guard.cjs store-presentation-test.cjs .. shots
node -r ./guard.cjs image-optimize-test.cjs .. shots <carpeta con PNG reales de góndola>
node -r ./guard.cjs legacy/admin-tools-test.cjs .. shots   # y el resto de legacy/
```

`legacy/prod-new-smoke.cjs` y `legacy/supplier-prod-test.cjs` abren producción
(solo lecturas; todo lo que escribiría está simulado).

## Imágenes en las pruebas: caché local

`guard.cjs` sirve las imágenes de Storage y del optimizador de Vercel desde
`tests/.image-cache/` (fuera de git). Si una imagen no está, entrega una PNG
generada (la lógica de tamaños, recortes y respaldos se prueba igual).

- Sembrar con copias que ya tenés (sin red): `node seed-image-cache.cjs <carpeta>`
- Permitir descargar las que falten, una sola vez y con tope:
  `GUARD_FETCH=10 GUARD_FETCH_MAX_MB=20 node -r ./guard.cjs …`
- Si algo intenta escribir en Supabase o descargar de Storage sin permiso, la
  corrida termina con código 3 y el resumen `[protección]` dice qué fue.

## Medir la conversión a WebP (sin red)

```sh
node -r ./guard.cjs measure-webp.cjs .. salida "gondola=<carpeta PNG>" "yerba=../images/yerbas"
```

Pruebas retiradas: `store-yerbas-test` (la tienda cambió en 83b687c; la cubren
`store-presentation-test` y `legacy/order-confirm-test`).
