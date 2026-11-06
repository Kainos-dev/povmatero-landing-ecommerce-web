# Revisión local de pedidos y avisos

Implementación preparada en `dev`, sin aplicar migraciones remotas, publicar, commit ni push.

La implementación heredada generaba códigos por iniciales y contador de cliente: podían repetirse entre cuentas. Los avisos de reposición dependían de WhatsApp y marcado manual. Se continuó sobre esa base: se conservan las reservas de 12 h, las claves de reintento de checkout y la infraestructura Push; se agregan códigos globales y un procesador independiente de email.

## Migraciones y referencias

Aplicar **en una base local/de staging primero**: las existentes `20261114` (12 h y reintentos de checkout), `20261115` (Push), luego `20261116000000_random_public_codes.sql` y `20261117000000_restock_email.sql`. Las migraciones de Claude se conservan tal como estaban. No ejecutar los scripts de configuración Push todavía.

`20261116` asigna `PV-` más diez caracteres hexadecimales aleatorios mayúsculos (ej. `PV-7A4FC29B01`), independientes del ID, nombre y contadores. La reserva del código usa una tabla privada con clave única y hasta 32 intentos ante colisiones; `orders.public_code` tiene además `UNIQUE NOT NULL`. El código no cambia al editar el pedido, vincular una venta o borrar una cuenta. Todos los pedidos históricos reciben código, incluso ventas sin cuenta. Se conservan IDs, relaciones, importes, fechas y vencimientos; los códigos anteriores quedan en `legacy_public_code`. Estos códigos antiguos NO son únicos entre clientes: conciliar siempre con la cuenta y el ID interno. Los contadores y secuencias antiguos permanecen para auditoría, sin volver a incrementarse.

Las reservas nuevas duran 12 h; las históricas conservan su vencimiento original (72 h si así se crearon). El stock disponible excluye reservas vigentes, aun si el cron todavía no marcó su cancelación. Checkout, WhatsApp, cuenta y panel muestran el código. Los IDs siguen usándose en operaciones y rutas privadas del panel; las pantallas de clientes muestran “Código pendiente” si falta la columna/respuesta.

Controles posteriores: `supabase/checks/20261117_codigos_email.sql`. Los controles y rollbacks `20261114/15` describen sus estados intermedios, **no** el esquema posterior a `20261116/17`. No ejecutar el rollback antiguo sobre el esquema nuevo: borraría funciones/columnas que ahora tienen dependencias. Desactivar el worker ante un problema y preparar una corrección hacia adelante; no renumerar pedidos publicados.

## Configuración de email (no realizada)

1. Verificar el dominio `povmatero.com` en Resend y agregar los registros DNS que indique el proveedor (SPF/DKIM; revisar DMARC). Crear una clave de envío restringida al dominio.
2. Configurar en el servidor: `RESEND_API_KEY`, `RESTOCK_EMAIL_FROM=avisos@povmatero.com`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY` y `CRON_SECRET` aleatorio de 24 caracteres como mínimo. `SUPABASE_URL` permite usar una base de staging con su propia clave; si falta, se conserva la URL existente del proyecto. Separar las variables de producción y preview/staging; no heredar credenciales reales en pruebas. Nunca exponer estas claves en JS del navegador. El remitente debe ser una dirección simple del dominio; el nombre de marca va en asunto/cuerpo.
3. Mantener `RESTOCK_EMAIL_ENABLED=false` durante revisión. Preparar un **scheduler autenticado cada 5 minutos** que llame `GET https://povmatero.com/api/restock-send` con `Authorization: Bearer <CRON_SECRET>`. Puede ser un scheduler externo o un cron de Vercel si el plan admite esa frecuencia. No se agregó una frecuencia incompatible al cron diario existente: este scheduler debe configurarse antes de activar los envíos. La función tiene presupuesto de 60 s.
4. Verificar que `https://povmatero.com/yerbas` y `/api/restock-unsubscribe` estén servidos por este proyecto. Es el dominio fijo usado por los correos. Probar primero una base aislada con destinatarios de prueba del proveedor y `fetch` simulado; no habilitar contra producción para hacer pruebas.
5. Después de revisar migraciones, DNS, scheduler y consentimiento, activar deliberadamente `RESTOCK_EMAIL_ENABLED=true`. Sin este valor exacto o sin configuración completa, el worker no reclama trabajos ni manda correos.

El worker consulta disponibilidad real cada vez que corre: contempla ingresos manuales, cancelaciones y vencimientos por el solo paso del tiempo. No depende de triggers de inventario ni de Push y no participa en transacciones de pedidos. Procesa hasta cinco solicitudes por invocación; monitorear backlog y ajustar capacidad antes de un volumen mayor.

## Consentimiento, cancelación y reintentos

Las suscripciones anteriores conservan sus datos, pero tienen `email_consent_at=NULL`: **no se envía ningún email automáticamente**. El cliente debe marcar la casilla de aceptación, inicialmente desmarcada, y tocar “Avisarme por email cuando haya stock”. Solo esa acción envía `email_consent=true` a `request_restock_alert(bigint,boolean)`; una llamada antigua de un parámetro conserva el comportamiento anterior sin conceder consentimiento. La tienda identifica el aviso antiguo y permite cancelarlo. No se ejecuta una actualización masiva de consentimiento. La confirmación es específica para esa presentación y no depende ni modifica la preferencia de novedades comerciales. Cancelar la solicitud desde la tienda o desde el correo impide nuevos intentos. El enlace del correo abre una confirmación; requiere POST para que un escáner de enlaces no cancele solicitudes accidentalmente. Las suscripciones nuevas siguen el email de la cuenta; si el email de Auth cambia y difiere del consentido, se suspende el envío hasta que el cliente cancele y vuelva a suscribirse.

La migración 17 habilita RLS sin políticas en la cola y exige un contexto `service_role` en las cuatro funciones del servidor. El panel revisado no ofrece “Marcar avisado”; el marcado manual queda revocado. Coordinar la publicación de la tienda y del panel revisados con la aplicación manual de la migración, manteniendo `RESTOCK_EMAIL_ENABLED=false`. No habilitar envíos hasta verificar esa versión de interfaz. Los controles `20261117_antes_email.sql` y `20261117_codigos_email.sql` permiten comparar huellas e IDs históricos sin mostrar destinatarios o tokens.

Una baja prevalece sobre el acuse de aceptación, incluso si este se registró inmediatamente antes. La solicitud queda cancelada sin `notified_at`; el trabajo conserva el resultado del proveedor para auditoría. Un token de lease vencido o sustituido no puede confirmar otro intento. Al perder el octavo lease o superar la ventana de reintentos, el trabajo termina fallido.

Cada solicitud tiene un único trabajo, con bloqueo `SKIP LOCKED`, lease de cinco minutos y token de intento. Se comprueba otra vez stock y consentimiento justo antes de contactar al proveedor. Destinatario, remitente y contenido quedan congelados para reintentos idénticos; la clave Resend es `restock-request/<solicitud>`. Reintentos con espera exponencial, máximo ocho intentos y una ventana de 20 h desde el primero: Resend retiene sus claves de idempotencia durante 24 h. Un trabajo ambiguo fuera de esa ventana pasa a fallido y requiere investigar en Resend; **no resetearlo ni reenviarlo a ciegas**.

La aceptación por Resend marca “avisada”; no certifica entrega en bandeja de entrada. Los errores permanentes quedan fallidos. Consultar la cola con el control agregado, revisar el ID del proveedor desde un entorno autorizado y monitorear rebotes/quejas en Resend. No hay reenvío automático tras un fallo permanente. Si hay incidentes, desactivar `RESTOCK_EMAIL_ENABLED`; las bajas siguen funcionando mientras exista la clave de Supabase.

Hay una ventana inevitable entre la última comprobación y la aceptación por el proveedor: una cancelación o un cambio de stock que ocurra durante esa llamada puede llegar después de que el correo esté en tránsito. El mensaje aclara que no reserva stock. El email nunca bloquea compras ni inventario.

## Web Push

`PUSH_ENABLED=false` es el estado de publicación. Si falta el flag o no es
exactamente `true`, ni el endpoint, ni la clave pública, ni el worker del cron
habilitan Push, aunque existan todas las claves VAPID. La plantilla `.env.example`
deja ambos canales apagados y no contiene credenciales. No crear un `.env` real ni
cambiar variables de Vercel como parte de las pruebas locales.

El worker limita cada claim a una ola de hasta seis dispositivos, reserva tiempo
para informar resultados y aplica timeouts a RPC, cuerpo de respuesta y proveedor.
Las RPC pendientes que no se confirman se recuperan mediante leases; no se promete
exactamente una entrega al proveedor ante una aceptación ambigua.

Se conserva la implementación de Claude: permisos por administrador/dispositivo, service worker limitado a `/admin/`, cola, reintentos y cifrado. Sin claves VAPID ni secretos de webhook no hay envíos. No configurar `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_WEBHOOK_SECRET`, Vault ni `20261115_configurar_push.sql` en esta etapa. La migración conserva la infraestructura sin activarla. Más adelante se revisará el alta de dispositivos y los avisos históricos antes de habilitarla.

## Operaciones de compra y recuperación

La clave de un intento sin resolver no caduca a las seis ni a las doce horas.
Se conserva por cuenta y contenido de carrito y se comparte entre pestañas. La
reserva sigue venciendo a las doce horas desde la creación original: recuperar
el pedido no reserva otra vez ni renueva el vencimiento. Tras confirmar, armar un
nuevo carrito inicia otra operación y permite una segunda compra legítima.

La recuperación usa `client_key`, no coincidencias de productos/fechas. Una
respuesta tardía no vacía el carrito de otra cuenta ni una edición posterior.
El request se vincula al token de la cuenta validada al iniciarlo. Si no se puede
guardar la clave en el navegador, el envío se bloquea con un mensaje; borrar
manualmente el almacenamiento o cambiar de dispositivo exige consultar Mis
pedidos antes de repetir una compra cuya respuesta se perdió.

El procedimiento de publicación y rollback del frontend está en
`PUBLICACION-Y-ROLLBACK.md`; no utiliza reversiones SQL.

## Verificación reproducible

Usar Node 20+, `PW` apuntando a dependencias de prueba (`@electric-sql/pglite`, `embedded-postgres`, `pg`, `playwright-core`, `web-push`, `http_ece`) y ruta absoluta del repo para las suites. Todas las pruebas usan datos locales o servicios simulados:

```text
node tests/db-test.cjs <repo>
node tests/random-email-db-test.cjs <repo>
node tests/restock-send-test.cjs
node tests/codes-push-db-test.cjs <repo>
node tests/codes-push-concurrency-test.cjs <repo>
node tests/codes-push-rollback-test.cjs <repo>
node tests/push-send-test.cjs <repo>
node tests/cron-test.cjs <repo>
node -r ./tests/guard.cjs tests/codes-push-browser-test.cjs <repo>
node -r ./tests/guard.cjs tests/legacy/restock-test.cjs <repo>
```

Fuentes del proveedor: [dominios](https://resend.com/docs/dashboard/domains/introduction), [idempotencia](https://resend.com/docs/dashboard/emails/idempotency-keys).

## Resultado de la revisión local (6 de noviembre de 2026)

Corridas finales sin fallas: base completa (135), códigos/email y controles nuevos (25), concurrencia PostgreSQL 17 (19), navegador principal (132), sesión (60), carrito (50), confirmación (29), reposición en navegador (14), cifrado/API Push (26), cron (10) y controles/reversiones del estado intermedio 20261114/15 (17). La suite de base del estado intermedio 20261114/15 pasó 74 comprobaciones. El worker de Resend, sus errores, configuración, autorización y bajas también se verificaron con `fetch` simulado.

Se inspeccionó la captura móvil del aviso con stock disponible. Las corridas de navegador informaron cero escrituras reales, cero lecturas JSON reales de Supabase y cero descargas de imágenes. No se probó entrega real de email, DNS ni Push en dispositivos reales: requieren la configuración posterior. `git diff --check` no detectó errores de espacios. Los logs y capturas de esta sesión están en la carpeta temporal `povmatero-review-20261106` del usuario; no se incorporaron al sitio.
