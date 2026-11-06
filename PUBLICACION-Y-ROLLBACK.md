# Publicación y rollback de frontend con esquema 14–17

Estado: autorización condicional de publicación recibida del responsable.
Antes del push deben pasar las pruebas finales y existir recuperación viable.
Las migraciones 14–17 ya están aplicadas; no ejecutarlas otra vez ni usar los
rollbacks SQL 14/15. Un despliegue de frontend no debe ejecutar SQL.

## Verificación externa y autorización — 2026-11-06

El responsable confirmó manualmente: Production Ready, rama main, commit
`06400b4`; SUPABASE_URL, SUPABASE_SECRET_KEY, RESEND_API_KEY, RESTOCK_EMAIL_FROM
y CRON_SECRET presentes en Production; RESTOCK_EMAIL_ENABLED explícitamente
false en Production; PUSH_ENABLED ausente. SUPABASE_SECRET_KEY también existe
en Preview: no usarlo para operaciones contra la base real.

No hay conector/CLI autenticada de Vercel en este entorno. Se corroboraron las
referencias remotas por Git y el estado Vercel success del commit completo por
la API pública de GitHub. No se leyeron, guardaron ni cambiaron valores secretos.
La integración Git existente publica main; los estados y URLs se pueden leer
por GitHub sin abrir la aplicación Preview.

Las referencias locales `main`, `dev`, `origin/main` y `origin/dev` apuntan a
`06400b4d1de0e62fc288763d2576c70ef31d1228`; `git ls-remote` lo corroboró antes
de publicar. El dominio y Ready fueron confirmados por el responsable.

Consulta manual exacta, sin modificar nada:

1. Vercel → equipo/proyecto → Settings → Domains → `povmatero.com`. Confirmar
   proyecto, entorno/rama asignada y redirecciones. No asumir que el último
   deployment Ready tiene asignado el dominio.
2. Abrir el deployment que efectivamente tiene ese dominio, marcado Current
   Production si corresponde. En sus detalles anotar URL/ID, estado, fecha,
   Environment, Source/Git branch y SHA completo. Si se desplegó por CLI y no
   hay Source, dejar la rama/SHA como no disponibles; no inventarlos.
3. Settings → Git/Environments: confirmar repositorio y Production Branch.
   Settings → Build and Deployment: confirmar Root Directory, Node 20+ y que
   Build/Install Commands no ejecuten migraciones. Confirmar soporte de las
   funciones con `maxDuration: 60`, sin cambiar ajustes.
4. Settings → Environment Variables: listar **solo nombres y alcances** de
   Production y Preview, Shared Variables heredadas y overrides de rama `dev`.
   Para los dos flags no secretos, registrar false/true/ausente. No revelar
   claves ni copiarlas al chat, archivos, consola o capturas.
5. Distinguir configuración actual y la usada por el deployment activo. Si no
   se puede acreditar el valor efectivo de sus flags, seguir marcándolos como
   pendientes. Cambiar la configuración del proyecto no actualiza deployments
   anteriores; tampoco ejecutar Redeploy para comprobarlo.

| Variable | Production verificado | Preview verificado | Requisito del candidato |
| --- | --- | --- | --- |
| RESTOCK_EMAIL_ENABLED | false, confirmado por responsable | No verificado | `false` explícito; no habilitar |
| PUSH_ENABLED | Ausente, confirmado por responsable | No verificado | Ausente deshabilita el código nuevo |
| SUPABASE_SECRET_KEY | Presente, confirmado por responsable | Presente, confirmado por responsable | Requerida para mantenimiento, analítica y bajas; nunca exponer al frontend |
| CRON_SECRET | Presente, confirmado por responsable | No verificado | Mantener autorización del mantenimiento existente; no crear cron |
| SUPABASE_URL | Presente, confirmado por responsable | No verificado | Override opcional solo del módulo email; no aísla todo el sitio |
| RESEND_API_KEY, RESTOCK_EMAIL_FROM | Presentes, confirmadas por responsable | No verificado | Opcionales con email apagado; no configurarlas para esta publicación |
| PUSH_WEBHOOK_SECRET | Pendiente | Pendiente | Opcional con Push apagado; no configurarlo |
| VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT | Pendiente | Pendiente | Opcionales con Push apagado; no configurarlas |

Las demás variables no se consultaron. `.env.example` solo documenta defaults
locales; no demuestra configuración de Vercel. En Preview no
usar credenciales de producción para pruebas. Las URLs fijas requieren mocks
incluso aunque exista un override `SUPABASE_URL`.

Referencia: [variables de Vercel](https://vercel.com/docs/environment-variables)
y [alcances y overrides](https://vercel.com/docs/environment-variables/manage-across-environments).

## Artefacto local de rescate preparado

- ZIP: `.release-local/rollback-14-17-ropHAw.zip` (90.740.408 bytes).
- SHA-256 ZIP: `d50160fdc2690bd43046b3f926d666b19c9dc0bb33fc112fa74049fee0fd2efd`.
- Manifiesto: `.release-local/rollback-14-17-ropHAw/manifest.json`.
- SHA-256 del árbol: `4b2d2e1416c8f7114e5c53e3394f85fbe2d8543de8a8bd10dddf2b9b7ab57930`.
- Contiene `site/` con 253 archivos de aplicación y, fuera de `site/`, manifiesto,
  instrucciones y resultados de prueba. No incluye SQL, tests, `.env`, informes
  del repositorio, `.git` ni credenciales privadas. Se verificó también el ZIP
  extraído y cada hash de sus 253 archivos.

Es un **artefacto fuente de rescate**, no un deployment Ready ni una salida
precompilada `.vercel/output`. Aún necesita autorización, acceso a Vercel y un
build allí para poder promoverse. No equivale a un Instant Rollback disponible.

Seis archivos de la interfaz administrativa provienen de `06400b4`: CSS, HTML,
íconos, main, router y Más. Retiran la integración opcional Push/PWA. El resto de
la aplicación conserva el snapshot aprobado: códigos PV, reservas de 12 horas,
vencimientos históricos, idempotencia, stock, consentimiento y ausencia del
marcado manual de avisos. Los módulos críticos y `vercel.json` se compararon byte
por byte con el candidato. Las funciones de baja permanecen disponibles.

Solo en la copia del artefacto, `pushEnabled` y `configured` de email retornan
siempre false. Por eso ni variables completas con flags true pueden habilitar
sus envíos. El código normal del candidato sigue usando sus flags. El cron de
mantenimiento conserva exactamente la configuración existente; no se configuró
ni ejecutó ningún cron. No se modificaron SQL, contadores, stock ni datos.

Pasaron **129 controles** sobre el artefacto: integridad/guardas 11, checkout 10,
consentimiento 22, administración heredada 38 y cancelaciones 48. Los servicios
fueron simulados y la red externa bloqueada. No se ejecutaron migraciones en
esta etapa; la compatibilidad SQL se apoya en las pruebas locales ya aprobadas
y la identidad de los módulos críticos conservados.

Este rescate permite retirar la integración opcional de notificaciones; no
revierte cada cambio de pedidos. Si el incidente está dentro de un módulo
crítico conservado, hará falta una corrección específica sobre el esquema 17.
No afirmar que el ZIP resuelve cualquier regresión.

## Recuperación por la integración Git existente

Antes del primer push del candidato, preparar una revisión local de rescate hija
del commit candidato, con los ocho archivos que difieren del ZIP probado: los
seis archivos del shell administrativo y las dos guardas de email/Push forzadas
a false. Verificar el árbol de runtime contra el ZIP, normalizando únicamente
LF/CRLF en archivos de texto. No incluir ni cambiar SQL.

La rama local `recovery/yerbas-14-17-20261106` y el bundle ignorado
`.release-local/rollback14-17-git.bundle` deben contener esa revisión.
`.release-local/recovery-git.json` registra candidato, recuperación y hashes.
El bundle requiere el commit candidato como prerrequisito; verificarlo con
`git bundle verify`. No subir la rama de rescate como Preview.

Si main sigue exactamente en el candidato y hace falta recuperar, la integración
Git permite un avance normal, sin force push:

```text
git switch main
git merge --ff-only recovery/yerbas-14-17-20261106
git push origin main
```

Si se trabaja desde otra copia, traer antes la rama del bundle usando el mismo
nombre y verificar los SHAs del registro. Si main avanzó por cambios ajenos,
detenerse y revisar una integración normal; no sobrescribir historia. Consultar
el deployment Production de ese SHA mediante los estados publicados por Vercel
en GitHub y verificar HTML/assets del dominio sin ejecutar JavaScript. La
recuperación tarda un build; no es Instant Rollback. Si la propia integración
Git/Vercel está caída, requiere intervención en Vercel con el ZIP ya preparado.

Reproducción local (Node y dependencias de tests en `PW`):

```text
node tests/prepare-rollback.cjs
node tests/rollback-artifact-test.cjs <directorio-generado>
node tests/prepare-rollback.cjs --seal <directorio-generado>
```

Cada ejecución crea un directorio nuevo; nunca sobrescribir el ZIP sellado. Un
artefacto reconstruido tiene otra fecha y otro hash: volver a probarlo y registrar
su huella. `tests/README.md` describe los tests de navegador con mocks.

## Inventario del futuro commit

Lista positiva: `.release-local/commit-allowlist.txt` (83 rutas); versión NUL:
`.release-local/commit-allowlist.nul`. Inventario completo con clasificación,
tamaños y hashes: `.release-local/pending-inventory.json`. Revalidarlo si se
cambia cualquier archivo antes del commit. No usar `git add .`.

No incluir ZIPs, copias extraídas, credenciales, cachés, capturas ni informes
`INFORME-*.md`; son evidencia local ignorada. Versionar el procedimiento, las
herramientas reproducibles, tests actuales, migraciones ya aplicadas y controles
de lectura. Versionar SQL no significa ejecutarlo otra vez.

Mantener fuera de este commit de publicación, sin borrarlos:

- `supabase/rollbacks/20261114_revertir_codigos_12h.sql`.
- `supabase/rollbacks/20261115_revertir_push.sql`.
- `tests/codes-push-rollback-test.cjs` (suite histórica de reversiones).
- `supabase/checks/20261115_configurar_push.sql` (configura pg_net/Vault;
  reservarlo para una activación separada).

Estos cuatro siguen visibles sin seguimiento para revisión explícita. El ZIP y
los informes locales se excluyen tanto de Git como del upload de Vercel.

## Requisitos previos

- Identificar en Vercel el deployment/alias y SHA actuales. `main` y `dev` en Git
  no prueban por sí solos qué artefacto atiende el dominio.
- Mantener `RESTOCK_EMAIL_ENABLED=false` y `PUSH_ENABLED=false` en Production y
  Preview. La ausencia de ambos flags también deshabilita sus workers. No copiar
  credenciales reales a Preview ni configurar VAPID, Vault o schedulers.
- Revisar el inventario completo: los módulos, endpoints e íconos nuevos están
  sin seguimiento hasta que se autorice un commit. `.vercelignore` excluye tests,
  SQL, documentación, configuración del editor y archivos `.env`.
- El frontend y algunos endpoints conservan URLs de producción fijas. Un Preview
  no es una base de pruebas aislada: sus pruebas de compra deben usar mocks.

## Operaciones y rollback

1. Ejecutar las suites locales de base de datos y de navegador con servicios
   simulados. Guardar resultados, huellas y el inventario del candidato.
2. Resolver la verificación externa pendiente y validar las huellas del ZIP
   preparado. No considerar el deployment anterior como rollback compatible.
3. La versión de rescate debe conservar códigos `PV-`, vencimientos históricos,
   textos de 12 horas, claves de idempotencia, consentimiento explícito y ausencia
   del marcado manual de avisos. Conservar los endpoints actuales de baja y las
   guardas de seguridad; retroceder únicamente los cambios visuales/funcionales
   que se identifiquen como causantes del incidente.
4. Solo tras autorización explícita de commit/push/merge/deploy: revisar la lista
   positiva, preparar esas rutas en staging y comprobar el diff staged; hacer
   commit en `dev` y guardar su SHA. Un push puede generar un deployment: no
   hacerlo antes de verificar Build Commands y el aislamiento de Preview.
5. Si la integración confirmada usa `main` para Production: probar el Preview
   del candidato únicamente con mocks; tras aprobación de publicación, integrar
   en `main` mediante el flujo revisado. La integración puede publicar
   automáticamente. Registrar el SHA integrado y su correspondencia con el
   candidato; verificar deployment Ready y dominio asignado. Si la integración
   tiene otra rama o está desconectada, detenerse y adaptar el paso con esa
   información; no ejecutar una secuencia supuesta. El build de Production usa
   su configuración verificada, no asumir que hereda las variables de Preview.
6. Verificar HTML/assets por HTTP sin JS ni credenciales según la tabla de smoke.
   Guardar ID/SHA/estado del nuevo deployment, huellas y resultado. No probar
   compras ni abrir automáticamente Pedidos → Yerbas en producción.
7. Ante fallo, detener la promoción si aún no se asignó el dominio. Si ya sirve
   tráfico, usar únicamente un deployment compatible Ready previamente probado.
   Actualmente no existe uno acreditado aquí: el ZIP es la fuente preparada
   para construir ese rescate, no una promoción instantánea lista.
8. Con autorización de recuperación, verificar `Get-FileHash -Algorithm SHA256`
   del ZIP, extraer a un directorio nuevo y usar solo `site/` como raíz del
   deployment. Confirmar proyecto/equipo y ajustes; no crear un proyecto nuevo
   ni subir la raíz del repositorio. Una futura CLI autenticada permite:

   ```text
   vercel deploy --cwd <rescate-extraído>/site --project <proyecto-verificado> --scope <equipo-verificado> --prod --skip-domain
   ```

   No ejecutar ahora. Construye un deployment sin asignar el dominio; comprobar
   Ready y smoke sin JS. El deployment de Production puede tener efectos de
   plataforma: revisar cron y no añadir ni cambiar su configuración. Promover
   ese deployment solo con autorización y verificar luego dominio/estado. Si
   el error pertenece a los módulos conservados, preparar una corrección local
   en vez de promover el rescate a ciegas. No usar `vercel --public`.
9. No revertir la base, regenerar códigos, devolver stock ni resetear trabajos de
   email ambiguos. Esas operaciones no forman parte de un rollback de frontend.

## Smoke sin escrituras ni mantenimiento

Se pueden comprobar por HTTP, sin ejecutar JavaScript ni enviar credenciales:

- `GET /`, `/yerbas`, `/cuenta`, `/admin/`: HTML y referencias a assets.
- `GET /admin/manifest.webmanifest`, `/admin/sw.js` e íconos: contenido y headers.
- `GET /api/push-config`: 503 con Push deshabilitado, sin consultar la base.
- `GET /api/restock-send`: 503 con email deshabilitado, sin reclamar trabajos.
- `GET /api/push-send`: 405; el método no permitido se rechaza antes del worker.
- `GET /api/restock-unsubscribe?token=invalido`: 400 sin RPC.
- `GET /api/cron-pedidos` **sin Authorization**: 401 o 503, sin mantenimiento.

No invocar `/api/cron-pedidos` con el secreto. No abrir automáticamente
`/admin/#/pedidos?tab=yerbas`: su carga ejecuta `run_order_maintenance` y puede
cancelar o entregar pedidos. No confirmar bajas con tokens reales, activar Push,
probar correos ni realizar compras de producción como smoke.

Una navegación normal puede enviar analítica. Para inspecciones estrictamente
sin escrituras usar HTTP sin JS o un navegador con todos los servicios simulados,
tracking deshabilitado y bloqueos de red hacia producción.

**Mientras no estén verificados el código desplegado y los flags efectivos, no
invocar `GET /api/restock-send`: con email habilitado es un worker que envía.**
No usar respuestas 503 de workers como prueba de flags false: también pueden
significar configuración incompleta. Para la primera inspección limitarse a
HTML/assets y métodos rechazados conocidos. El smoke no certifica por sí solo
RLS, stock ni toda la configuración de Vercel.

Referencias del procedimiento futuro: [deploy y --skip-domain](https://vercel.com/docs/cli/deploy),
[proyecto y scope explícitos](https://vercel.com/docs/cli/global-options),
[limitaciones de Instant Rollback](https://vercel.com/docs/instant-rollback).

## Condiciones antes de habilitar servicios opcionales

Email y Push son cambios posteriores separados. Requieren autorización, dominio,
remitente, destinatarios/dispositivos de prueba, capacidad y monitoreo verificados.
Los workers tienen entrega al menos una vez: no se promete retirar un correo
aceptado ni impedir que un proveedor repita una notificación tras un error ambiguo.

El almacenamiento persistente del navegador es necesario para conservar intentos
de compra. Si se borra manualmente o se usa otro dispositivo, no se puede recuperar
su clave solo desde ese almacenamiento; antes de volver a comprar se debe consultar
Mis pedidos. Un intento pendiente no vence por reloj ni renueva su reserva al
recuperarse. Un carrito nuevo tras confirmar la compra constituye otra operación.
