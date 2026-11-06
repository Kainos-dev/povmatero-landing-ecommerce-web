# Pruebas locales de Povmatero

No se publican (`.vercelignore`). Nunca escriben en Supabase real ni descargan
imágenes de Storage: todo se corre con la protección `guard.cjs`.

## Requisitos

- Node 20+ y Google Chrome instalado (`C:/Program Files/Google/Chrome/Application/chrome.exe`).
- Una carpeta con `playwright-core`, `@electric-sql/pglite`, `embedded-postgres`, `pg`, `web-push` y `http_ece`
  instalados (`npm i playwright-core @electric-sql/pglite embedded-postgres pg web-push http_ece`).
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
node random-email-db-test.cjs ..    # 20261116/17: códigos PV, colisiones, consentimiento y cola email
node restock-send-test.cjs          # Resend y bajas, todo simulado, sin red
node shelf-order-db-test.cjs ..     # 20261113: orden de góndolas, Otras marcas, permisos, reversión
node shelf-order-concurrency-test.cjs .. # 20261113 con dos administradores a la vez (Postgres 17)
node codes-push-db-test.cjs ..      # estado intermedio 20261114/15: 12 h, códigos antiguos, client_key y Push
node codes-push-concurrency-test.cjs .. # esquema completo (Postgres 17): última unidad, colisiones PV, Push y emails simultáneos
node order-code-locale-db-test.cjs .. 55448 # PostgreSQL local ya iniciado en 127.0.0.1:55448: locale C, iniciales, concurrencia y secuencia 14–17; crea y elimina su propia base temporal
node random-codes-security-db-test.cjs .. 55448 # PostgreSQL local: 9 históricos/16 líneas, RLS, permisos RPC, controles 16, colisiones y secuencia 14–17; base temporal propia
node restock-email-security-db-test.cjs .. 55448 # PostgreSQL local: seguridad 17, consentimiento, bajas concurrentes, leases, reintentos y conservación histórica
node restock-email-endpoints-test.cjs # endpoints/Resend/cron simulados; flag false bloquea todo envío
node restock-consent-browser-test.cjs # Chrome móvil/escritorio, casilla explícita y panel; bloquea toda red externa
node push-send-test.cjs ..          # /api/push-send y /api/push-config: cifrado (verificado con http_ece), VAPID, errores
node legacy/concurrency-test.cjs .. # proveedor, ventas, conciliación a la vez
```

## Navegador (Supabase simulado + guard)

Para correr sin ninguna lectura de Supabase real, preparar una vez la caché del
SDK público con `node tests/cache-browser-sdk.cjs` desde la raíz (solo descarga
desde jsDelivr). Para los controles tipográficos, ejecutar también
`node tests/cache-browser-font.cjs` (solo Google Fonts, caché temporal de Inter).
Después precargar `tests/offline-browser.cjs`; bloquea la red
externa y reemplaza los catálogos leídos por suites antiguas con fixtures. Ejemplo:

```sh
node -r ./tests/offline-browser.cjs tests/codes-push-browser-test.cjs /ruta/absoluta/repo /ruta/temporal/capturas
node -r ./tests/offline-browser.cjs tests/legacy/restock-test.cjs /ruta/absoluta/repo /ruta/temporal/capturas
node -r ./tests/offline-browser.cjs tests/legacy/admin-tools-test.cjs /ruta/absoluta/repo /ruta/temporal/capturas
node tests/order-attempts-test.cjs
node tests/order-attempts-browser-test.cjs
node tests/push-worker-limits-test.cjs
node tests/run-postgres-concurrency.cjs codes-push-concurrency-test.cjs /ruta/absoluta/repo 55448
```

Las pruebas de intentos de pedido y límites de Push usan reloj/servicios
simulados y bloqueos de red propios. El runner de concurrencia exige un
PostgreSQL ya iniciado en loopback y crea una base temporal por suite.
Las pruebas de Push que habilitan el flag usan únicamente claves ficticias y fetch
simulado. `PUSH_ENABLED` y `RESTOCK_EMAIL_ENABLED` siguen apagados por defecto.
No ejecutar scripts `*-prod-*` ni reversiones SQL como parte de una validación
del frontend actual con migraciones 14–17.

```sh
node -r ./guard.cjs codes-push-browser-test.cjs .. shots   # /yerbas, Mis pedidos, panel: códigos, 12 h, cambio de stock, avisos, Notificaciones, service worker
node -r ./guard.cjs session-test.cjs .. shots              # sesión de clientes (cerrar/abrir navegador, vencida, pedido), saludo, WhatsApp, menú
node -r ./guard.cjs shelf-order-test.cjs .. shots           # Góndola: ordenar góndolas/yerbas, casilla Otras marcas, /yerbas
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

## Artefacto local de rescate con esquema 14–17

```sh
node tests/prepare-rollback.cjs
node tests/rollback-artifact-test.cjs /ruta/al/directorio-generado
node tests/prepare-rollback.cjs --seal /ruta/al/directorio-generado
```

Ejecutar desde la raíz, con `PW` configurado. Genera `.release-local/`, ignorado
por Git y Vercel; no usa CLI de Vercel, red, credenciales ni SQL. El ZIP fuente
necesita un build futuro autorizado y no equivale a un deployment Ready.
Las pruebas exportadas de checkout y consentimiento aceptan `{root: rutaSite}`
para probar la copia generada, siempre con mocks. No probarla con Supabase real.
No reconstruir ni sobrescribir un ZIP sellado: registrar la nueva huella si se
genera otro. El procedimiento de publicación vive en `PUBLICACION-Y-ROLLBACK.md`.
