# AFC Google OAuth HTTPS Bridge

Módulo PHP temporal para completar Google OAuth en un dominio HTTPS cuando la aplicación principal todavía funciona mediante HTTP.

El bridge nunca redirige tokens de Google hacia la aplicación. Entrega solamente un código aleatorio opaco, de un solo uso y con expiración de 30 a 60 segundos. La identidad se obtiene posteriormente mediante una solicitud HTTPS server-to-server autenticada con HMAC.

## Requisitos

- PHP 8.1 o superior.
- MySQL o MariaDB con tablas InnoDB.
- Extensiones PHP: JSON, OpenSSL, PDO y PDO MySQL.
- Composer para instalar `google/apiclient`.
- HTTPS válido en el dominio del bridge.
- Posibilidad de configurar variables de entorno fuera del directorio público.

## Estructura de despliegue

- Configurar `public/` como document root del dominio o subdominio HTTPS.
- Mantener `src/`, `vendor/` y `database/` fuera del document root.
- Si Hostinger no permite seleccionar `public/` como document root, colocar el proyecto fuera de `public_html` y publicar únicamente el contenido de `public/`, ajustando la ruta a `vendor/autoload.php`.
- Para una carpeta pública como `public_html/afcloginbrige`, copiar `public/bridge-root.php.example` como `bridge-root.php` y hacer que retorne la ruta de `afcloginbridge-private`. No contiene secretos y `.htaccess` bloquea su acceso web.
- Ejecutar `composer install --no-dev --optimize-autoloader` antes de subir el módulo o mediante SSH en Hostinger.
- Importar `database/schema.sql` en una base MySQL/MariaDB exclusiva o en un esquema con permisos limitados.

## Variables del bridge PHP

El bridge acepta variables del proceso PHP. Para un hosting compartido sin contenedores también puede utilizar `config.local.php` en la raíz privada del proyecto, siempre fuera de `public_html`.

1. Copiar `config.local.php.example` como `config.local.php`.
2. Escribir ahí las credenciales de Google y MySQL.
3. Mantenerlo junto a `src/` y `vendor/`, nunca dentro de `public/` o `public_html`.
4. Asignarle permisos `600` o, si Hostinger no lo permite, `640`.

Las variables del proceso tienen prioridad sobre los valores de `config.local.php`. El archivo real está ignorado por Git y no debe enviarse dentro del ZIP.

| Variable | Requerida | Descripción |
| --- | --- | --- |
| `BRIDGE_GOOGLE_CLIENT_ID` | Sí | Client ID OAuth web de Google. |
| `BRIDGE_GOOGLE_CLIENT_SECRET` | Sí | Secreto OAuth; permanece únicamente en Hostinger. |
| `BRIDGE_GOOGLE_REDIRECT_URI` | Sí | Callback HTTPS exacto, por ejemplo `https://bridge.example.com/auth/google/callback`. |
| `BRIDGE_APP_CALLBACK_URL` | Sí | Retorno fijo de la aplicación, por ejemplo `http://app.example.com/auth/callback`. |
| `BRIDGE_BASE_PATH` | No | Prefijo URL cuando se publica en una carpeta, por ejemplo `/afcloginbrige`; vacío para un subdominio dedicado. |
| `BRIDGE_SHARED_SECRET` | Sí | Secreto aleatorio compartido con el backend, mínimo 32 caracteres. |
| `BRIDGE_DB_HOST` | Sí | Host de MySQL/MariaDB. |
| `BRIDGE_DB_PORT` | No | Puerto; predeterminado `3306`. |
| `BRIDGE_DB_NAME` | Sí | Base de datos. |
| `BRIDGE_DB_USER` | Sí | Usuario con acceso solo a las tablas del bridge. |
| `BRIDGE_DB_PASSWORD` | Sí | Contraseña de la base de datos. |
| `BRIDGE_CODE_TTL_SECONDS` | No | Vida del código opaco, entre 30 y 60; predeterminado `45`. |
| `BRIDGE_STATE_TTL_SECONDS` | No | Vida de `state` y del intento inicial, entre 60 y 600; predeterminado `300`. |
| `BRIDGE_SIGNATURE_TOLERANCE_SECONDS` | No | Tolerancia de firmas HMAC, entre 30 y 300; predeterminado `60`. |
| `BRIDGE_HTTP_TIMEOUT_SECONDS` | No | Tiempo máximo de comunicación con Google; predeterminado `10`. |

`BRIDGE_SHARED_SECRET` y `GOOGLE_OAUTH_BRIDGE_SHARED_SECRET` deben contener exactamente el mismo valor. Debe generarse con una fuente criptográficamente segura y nunca enviarse por chat, registrarse en logs ni versionarse.

## Variables del backend principal

| Variable | Descripción |
| --- | --- |
| `GOOGLE_OAUTH_BRIDGE_START_URL` | URL HTTPS completa: `https://bridge.example.com/auth/google/start`. |
| `GOOGLE_OAUTH_BRIDGE_VERIFY_URL` | URL HTTPS completa: `https://bridge.example.com/api/auth/verify`. |
| `GOOGLE_OAUTH_BRIDGE_SHARED_SECRET` | Mismo secreto HMAC configurado en Hostinger. |
| `GOOGLE_OAUTH_BRIDGE_TIMEOUT_MS` | Timeout server-to-server; predeterminado `5000`. |
| `GOOGLE_OAUTH_BRIDGE_ATTEMPT_TTL_SECONDS` | Vida del intento en Redis; predeterminado `300`. |
| `GOOGLE_OAUTH_BRIDGE_ATTEMPT_COOKIE_NAME` | Cookie HTTP-only temporal; predeterminado `afc_oauth_attempt`. |

Las variables directas `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` y `GOOGLE_OAUTH_REDIRECT_URI` pueden mantenerse para el modo `direct`, pero el bridge no depende de ellas en el backend principal.

Mientras la aplicación principal continúe en HTTP, `COOKIE_SECURE` debe ser `false`; de lo contrario el navegador no guardará ni la cookie temporal del intento ni la sesión local. Debe cambiarse a `true` en cuanto el dominio principal disponga de HTTPS.

## Variable del frontend

Configurar `PUBLIC_GOOGLE_AUTH_MODE=bridge`. En esta modalidad el navegador no necesita `PUBLIC_GOOGLE_CLIENT_ID`, porque el Client ID se utiliza exclusivamente en Hostinger.

Cuando el servidor principal tenga HTTPS, cambiar a `PUBLIC_GOOGLE_AUTH_MODE=direct` y retirar el bridge sin modificar la reconciliación de usuarios ni las sesiones.

## Google Cloud

En el cliente OAuth de tipo aplicación web, registrar exactamente como URI de redireccionamiento autorizada:

`https://bridge.example.com/auth/google/callback`

Si se publica bajo una carpeta, registrar la ruta completa, por ejemplo:

`https://vinculacionydesarrollo.net/afcloginbrige/auth/google/callback`

No registrar la URL HTTP de la aplicación principal como redirect URI de Google. También se debe configurar la pantalla de consentimiento, dominio autorizado y usuarios de prueba si la aplicación sigue en modo Testing.

## Endpoints

- `GET /auth/google/start`: valida el intento firmado, crea `state` y PKCE, y redirige a Google.
- `GET /auth/google/callback`: valida `state`, canjea el código con Google y genera un código opaco.
- `POST /api/auth/verify`: consume atómicamente el código opaco; requiere firma HMAC, timestamp y nonce.
- `GET /health`: comprobación mínima sin configuración sensible.

## Seguridad

- Estados, códigos y nonces se almacenan únicamente como hashes SHA-256.
- Verificadores PKCE e identidades temporales se cifran con AES-256-GCM.
- Los códigos son de un solo uso mediante transacciones y bloqueos `FOR UPDATE`.
- Las respuestas y redirecciones utilizan `Cache-Control: no-store`.
- La validación de ID tokens utiliza la biblioteca oficial de Google.
- Los logs contienen solamente evento, resultado, código de error e identificador aleatorio; no incluyen tokens, códigos, correo ni perfil.
- El bridge mitiga la exposición de tokens, pero no sustituye HTTPS en la aplicación principal. El código opaco todavía viaja por HTTP y debe considerarse una solución transitoria.
