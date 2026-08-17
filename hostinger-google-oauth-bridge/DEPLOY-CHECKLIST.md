# Checklist de despliegue — Google OAuth Bridge en Hostinger

> Marca cada casilla únicamente después de comprobarla. No pegues contraseñas, Client Secrets, accesos FTP ni el secreto compartido dentro de este archivo.

## Datos que debes tener a la mano

- [ ] URL HTTPS definitiva del bridge: `https://________________________________`
- [ ] URL de retorno de la aplicación principal: `http://ecosistemadigital.aragon.unam.mx:3005/auth/callback`
- [ ] Nombre de la base MySQL/MariaDB: `________________________________`
- [ ] Host de MySQL/MariaDB: `________________________________`
- [ ] Puerto de MySQL/MariaDB, normalmente `3306`: `________________________________`
- [ ] Usuario de MySQL/MariaDB: `________________________________`
- [ ] Contraseña de MySQL guardada en un administrador de contraseñas.
- [ ] Google OAuth Client ID disponible.
- [ ] Google OAuth Client Secret disponible y enviado por un medio seguro.
- [ ] Secreto HMAC nuevo de al menos 32 caracteres disponible y guardado de forma segura.
- [ ] Acceso FileZilla mediante SFTP o FTPS. Evitar FTP sin cifrado si el hosting ofrece una opción segura.

---

## Fase 1 — Verificar el hosting antes de subir archivos

- [ ] Confirmar que el subdominio abre mediante `https://` sin advertencias del navegador.
- [ ] Confirmar que el certificado pertenece al dominio correcto y no está expirado.
- [ ] Seleccionar PHP 8.1 o una versión superior desde hPanel.
- [ ] Confirmar que PHP tiene habilitadas las extensiones:
  - [ ] JSON.
  - [ ] OpenSSL.
  - [ ] PDO.
  - [ ] PDO MySQL.
  - [ ] cURL.
- [ ] Confirmar que el hosting permite reglas `.htaccess` y `mod_rewrite`.
- [ ] Confirmar si Hostinger permite variables de entorno para PHP.
- [ ] Si no las permite, utilizar `config.local.php` en la raíz privada del proyecto, fuera de `public_html`.
- [ ] Confirmar que el servidor puede realizar conexiones HTTPS salientes hacia Google.

**Punto de control:** no continuar si el certificado HTTPS, PHP 8.1+, PDO MySQL o la configuración privada de variables no están disponibles.

---

## Fase 2 — Preparar los archivos para FileZilla

- [ ] Descargar o localizar `hostinger-google-oauth-bridge-deploy.zip`.
- [ ] Verificar el SHA-256 recibido junto con el ZIP.
- [ ] Extraer el ZIP en la computadora antes de usar FileZilla.
- [ ] Confirmar que la carpeta extraída contiene:
  - [ ] `composer.json`.
  - [ ] `composer.lock`.
  - [ ] `src/`.
  - [ ] `vendor/`.
  - [ ] `public/`.
  - [ ] `database/schema.sql`.
  - [ ] `README.md`.
  - [ ] Este archivo `DEPLOY-CHECKLIST.md`.
- [ ] Confirmar que no existe ningún archivo de entorno con credenciales dentro del paquete.
- [ ] En FileZilla, habilitar la visualización y transferencia de archivos ocultos para que `.htaccess` no sea omitido.

---

## Fase 3 — Subir la estructura correcta

### Opción A — Hostinger permite elegir el document root

- [ ] Crear una carpeta privada para el proyecto, por ejemplo `oauth-bridge/`.
- [ ] Subir dentro de esa carpeta `src/`, `vendor/`, `public/`, `composer.json` y `composer.lock`.
- [ ] Configurar el document root del subdominio para que apunte exclusivamente a `oauth-bridge/public/`.
- [ ] Confirmar que `src/`, `vendor/` y `database/` no son accesibles directamente desde Internet.

### Opción B — El subdominio utiliza obligatoriamente `public_html`

Usar una estructura equivalente a:

```text
directorio-del-subdominio/
├── afcloginbridge-private/
│   ├── src/
│   ├── vendor/
│   ├── config.local.php
│   ├── composer.json
│   └── composer.lock
└── public_html/
  └── afcloginbrige/
    ├── index.php
    ├── .htaccess
    └── bridge-root.php
```

- [ ] Crear `afcloginbridge-private` fuera de `public_html`.
- [ ] Subir `src/`, `vendor/`, `composer.json` y `composer.lock` dentro de `afcloginbridge-private`.
- [ ] Copiar `config.local.php.example` como `afcloginbridge-private/config.local.php`.
- [ ] Subir el contenido de `public/` dentro de `public_html/afcloginbrige`.
- [ ] Copiar `bridge-root.php.example` como `public_html/afcloginbrige/bridge-root.php`.
- [ ] Editar `bridge-root.php` para que retorne la ruta absoluta o relativa correcta de `afcloginbridge-private`.
- [ ] Confirmar que `index.php` y `.htaccess` quedan directamente dentro de `public_html/afcloginbrige`.
- [ ] Confirmar desde el navegador que `/afcloginbrige/bridge-root.php` devuelve 403.

### Permisos

- [ ] Directorios con permisos recomendados `755`.
- [ ] Archivos PHP y `.htaccess` con permisos recomendados `644`.
- [ ] No utilizar permisos `777`.
- [ ] No subir accesos FTP, archivos de configuración local, respaldos ni archivos `.log`.

**Punto de control:** visitar temporalmente la raíz HTTPS. Una respuesta JSON de configuración faltante es aceptable en este momento; un error 404, 500 genérico o código PHP visible no lo es.

---

## Fase 4 — Preparar la base MySQL/MariaDB

- [ ] Entrar a phpMyAdmin desde Hostinger.
- [ ] Seleccionar la base creada para el bridge.
- [ ] Importar `database/schema.sql`.
- [ ] Confirmar que existen estas tablas:
  - [ ] `oauth_bridge_states`.
  - [ ] `oauth_bridge_codes`.
  - [ ] `oauth_bridge_nonces`.
- [ ] Confirmar que las tablas utilizan InnoDB.
- [ ] Confirmar que el usuario del bridge tiene permisos `SELECT`, `INSERT`, `UPDATE` y `DELETE` únicamente sobre esta base.
- [ ] No reutilizar el usuario administrador general de MySQL si puede crearse uno restringido.

---

## Fase 5 — Configurar los datos privados en Hostinger

Para este despliegue directo, abrir el archivo privado `config.local.php`, ubicado junto a `src/` y `vendor/`, y completar el arreglo usando `config.local.php.example` como plantilla.

La ubicación correcta es:

```text
directorio-del-subdominio/config.local.php
```

La ubicación incorrecta es:

```text
directorio-del-subdominio/public_html/config.local.php
```

Los nombres que debe completar son:

```dotenv
BRIDGE_GOOGLE_CLIENT_ID=<client-id>
BRIDGE_GOOGLE_CLIENT_SECRET=<client-secret>
BRIDGE_GOOGLE_REDIRECT_URI=https://<dominio-bridge>/auth/google/callback
BRIDGE_APP_CALLBACK_URL=http://ecosistemadigital.aragon.unam.mx:3005/auth/callback
BRIDGE_BASE_PATH=/afcloginbrige

BRIDGE_SHARED_SECRET=<secreto-hmac-de-32-o-mas-caracteres>

BRIDGE_DB_HOST=<host-mysql>
BRIDGE_DB_PORT=3306
BRIDGE_DB_NAME=<base-mysql>
BRIDGE_DB_USER=<usuario-mysql>
BRIDGE_DB_PASSWORD=<contraseña-mysql>

BRIDGE_CODE_TTL_SECONDS=45
BRIDGE_STATE_TTL_SECONDS=300
BRIDGE_SIGNATURE_TOLERANCE_SECONDS=60
BRIDGE_HTTP_TIMEOUT_SECONDS=10
```

- [ ] `BRIDGE_GOOGLE_REDIRECT_URI` utiliza HTTPS.
- [ ] `BRIDGE_GOOGLE_REDIRECT_URI` no termina con `/` adicional.
- [ ] `BRIDGE_APP_CALLBACK_URL` termina exactamente en `/auth/callback`.
- [ ] `BRIDGE_SHARED_SECRET` tiene como mínimo 32 caracteres aleatorios.
- [ ] El secreto compartido no es el mismo que el Client Secret de Google.
- [ ] `config.local.php` está junto a `src/` y `vendor/`, fuera de `public_html`.
- [ ] Asignar a `config.local.php` permisos `600`; si el hosting no lo permite, usar `640`.
- [ ] Confirmar desde el navegador que `/config.local.php` devuelve 404 o 403 y nunca su contenido.
- [ ] Ningún secreto quedó dentro de `public_html`.
- [ ] Reiniciar PHP o el sitio desde hPanel si el proveedor lo requiere para aplicar variables.

---

## Fase 6 — Configurar Google Cloud

- [ ] Abrir Google Cloud Console y seleccionar el proyecto correcto.
- [ ] Abrir el cliente OAuth de tipo **Aplicación web** usado por el bridge.
- [ ] En URI de redireccionamiento autorizado agregar exactamente:

```text
https://<dominio-bridge>/auth/google/callback
```

- [ ] No agregar la URL HTTP de la aplicación principal como redirect URI de Google.
- [ ] Confirmar que la pantalla de consentimiento está configurada.
- [ ] Confirmar que el dominio HTTPS está autorizado cuando Google lo solicite.
- [ ] Si la aplicación sigue en modo Testing, agregar las cuentas que realizarán las pruebas.
- [ ] Guardar cambios y esperar algunos minutos para su propagación.

---

## Fase 7 — Probar solamente el bridge

- [ ] Abrir `https://vinculacionydesarrollo.net/afcloginbrige/health`.
- [ ] Confirmar HTTP `200`.
- [ ] Confirmar una respuesta equivalente a:

```json
{"ok":true,"service":"google-oauth-bridge"}
```

- [ ] Confirmar que la respuesta incluye `Cache-Control: no-store`.
- [ ] Confirmar que `/src/`, `/vendor/`, `/database/` y `composer.json` no son accesibles públicamente.
- [ ] Revisar el log PHP y confirmar que no haya errores de conexión a MySQL o dependencias faltantes.
- [ ] No abrir manualmente `/auth/google/start`; necesita una firma generada por el backend.

**Punto de control:** no desplegar el frontend en modo bridge hasta que `/health` responda correctamente.

---

## Fase 8 — Configurar el backend principal

En el contenedor backend configurar:

```dotenv
GOOGLE_OAUTH_BRIDGE_START_URL=https://<dominio-bridge>/auth/google/start
GOOGLE_OAUTH_BRIDGE_VERIFY_URL=https://<dominio-bridge>/api/auth/verify
GOOGLE_OAUTH_BRIDGE_SHARED_SECRET=<mismo-valor-de-BRIDGE_SHARED_SECRET>
GOOGLE_OAUTH_BRIDGE_TIMEOUT_MS=5000
GOOGLE_OAUTH_BRIDGE_ATTEMPT_TTL_SECONDS=300
GOOGLE_OAUTH_BRIDGE_ATTEMPT_COOKIE_NAME=afc_oauth_attempt

COOKIE_SECURE=false
COOKIE_SAMESITE=lax
```

- [ ] Desplegar la rama backend `feature/google-oauth-https-bridge`.
- [ ] Confirmar que `GOOGLE_OAUTH_BRIDGE_SHARED_SECRET` coincide exactamente con Hostinger.
- [ ] Confirmar que `COOKIE_SECURE=false` mientras la aplicación principal siga en HTTP.
- [ ] Confirmar que Redis y PostgreSQL están disponibles.
- [ ] Confirmar que el contenedor puede resolver el dominio HTTPS de Hostinger.
- [ ] Confirmar que el contenedor puede conectarse al puerto 443 de Hostinger.
- [ ] Recrear el contenedor; no limitarse a reiniciarlo.
- [ ] Revisar los logs y confirmar que no aparezcan secretos, códigos ni tokens.

---

## Fase 9 — Configurar el frontend principal

En el contenedor frontend configurar:

```dotenv
PUBLIC_GOOGLE_AUTH_MODE=bridge
PUBLIC_API_BASE_URL=
AFC_BACKEND_URL=http://<nombre-interno-del-backend>:3000
```

- [ ] Desplegar la rama frontend `feature/google-oauth-https-bridge`.
- [ ] Configurar `PUBLIC_GOOGLE_AUTH_MODE=bridge`.
- [ ] Dejar `PUBLIC_GOOGLE_CLIENT_ID` vacío en modo bridge.
- [ ] Configurar correctamente `PUBLIC_API_BASE_URL` si frontend y backend no comparten `/api`.
- [ ] Configurar `AFC_BACKEND_URL` con la dirección interna Docker del backend.
- [ ] Recrear el contenedor frontend.
- [ ] Abrir el login en una ventana privada para evitar caché o sesiones anteriores.

---

## Fase 10 — Prueba completa de autenticación

### Flujo exitoso

- [ ] Abrir `http://ecosistemadigital.aragon.unam.mx:3005/login`.
- [ ] Presionar **Ingresar con Google**.
- [ ] Confirmar que el navegador navega al dominio HTTPS de Hostinger.
- [ ] Confirmar que Google muestra el nombre correcto de la aplicación.
- [ ] Elegir una cuenta de prueba.
- [ ] Confirmar que Google regresa a Hostinger mediante HTTPS.
- [ ] Confirmar que Hostinger regresa a `http://ecosistemadigital.aragon.unam.mx:3005/auth/callback?code=...`.
- [ ] Confirmar que el código desaparece rápidamente de la barra de direcciones.
- [ ] Confirmar que la aplicación crea la sesión local.
- [ ] Confirmar que el usuario llega a la pantalla correspondiente a su rol.
- [ ] Confirmar que `/api/me` devuelve el usuario autenticado.

### Errores controlados

- [ ] Cancelar el login en Google y comprobar un mensaje comprensible.
- [ ] Esperar más de 60 segundos antes de completar el retorno y comprobar expiración.
- [ ] Recargar `/auth/callback` y comprobar que el código no pueda reutilizarse.
- [ ] Detener temporalmente el bridge y comprobar un mensaje de comunicación.
- [ ] Probar una cuenta fuera del dominio permitido.
- [ ] Probar un usuario deshabilitado.
- [ ] Confirmar que el login tradicional con correo y contraseña sigue funcionando.

---

## Fase 11 — Revisión de seguridad

En las herramientas de red del navegador confirmar que nunca aparezcan:

- [ ] `access_token`.
- [ ] `id_token`.
- [ ] `refresh_token`.
- [ ] Google Client Secret.
- [ ] `BRIDGE_SHARED_SECRET`.
- [ ] Contraseña de MySQL.
- [ ] Perfil completo del usuario en query params.

Debe aparecer únicamente un código opaco y temporal durante el retorno HTTP.

- [ ] Confirmar que el código de un solo uso expira entre 30 y 60 segundos.
- [ ] Confirmar que un segundo canje devuelve código ya utilizado o inválido.
- [ ] Confirmar que Hostinger no imprime tokens en logs PHP.
- [ ] Reducir o desactivar el registro de query strings sensibles en logs de acceso si Hostinger lo permite.
- [ ] Restringir `/api/auth/verify` a la IP pública del backend si la IP es fija y Hostinger permite reglas de acceso.
- [ ] Rotar el Client Secret de Google si fue compartido previamente por un medio no seguro.
- [ ] Guardar un respaldo de las imágenes anteriores de frontend y backend.

---

## Fase 12 — Cierre y monitoreo

- [ ] Registrar la fecha y hora del despliegue: `________________________________`.
- [ ] Registrar quién realizó el despliegue: `________________________________`.
- [ ] Monitorear errores del bridge durante las primeras 24 horas.
- [ ] Monitorear respuestas 400, 401, 409, 410, 502 y 504 sin guardar información sensible.
- [ ] Confirmar que las tablas temporales eliminan registros expirados progresivamente.
- [ ] Documentar dónde están almacenados los secretos y quién tiene acceso.
- [ ] Programar la migración futura del servidor principal a HTTPS.
- [ ] Cuando el servidor principal tenga HTTPS, cambiar a `PUBLIC_GOOGLE_AUTH_MODE=direct`, activar `COOKIE_SECURE=true` y retirar el bridge de forma controlada.

---

## Rollback

Si el bridge falla y afecta el acceso:

- [ ] Restaurar la imagen anterior del frontend.
- [ ] Restaurar la imagen anterior del backend si fuera necesario.
- [ ] Cambiar temporalmente `PUBLIC_GOOGLE_AUTH_MODE=direct` solo si el servidor ya tiene HTTPS; en HTTP Google seguirá bloqueándolo.
- [ ] Mantener disponible el login tradicional con correo y contraseña.
- [ ] No eliminar inmediatamente las tablas del bridge; conservarlas hasta terminar el diagnóstico y después purgar datos expirados.
