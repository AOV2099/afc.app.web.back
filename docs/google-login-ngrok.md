# Google Login AFC con gateway Docker y ngrok

Ngrok se utiliza únicamente para HTTPS. OAuth, usuarios y sesiones pertenecen a AFC Back.

## Arquitectura

```text
https://reclining-sulfur-reward.ngrok-free.dev
                    │
                  ngrok
                    │
       http://afc-gateway:3010
                    │
              AFC Gateway
       ┌────────────┴────────────┐
       │                         │
 / y assets                 /api/* y /auth/*
       │                         │
http://afc-front:3000     http://afc-back:3000
```

Todos los contenedores deben pertenecer a `afc-network`.

## Una imagen backend, dos contenedores

El [Dockerfile](../Dockerfile) backend incluye `gateway/` mediante `COPY . .`. La imagen `afc-back:latest` se utiliza para:

- `afc-back`: comando predeterminado `npm start`.
- `afc-gateway`: comando sobrescrito `node gateway/server.js`.

### AFC Gateway

```text
docker run -d \
  --name afc-gateway \
  --restart unless-stopped \
  --network afc-network \
  -e GATEWAY_HOST=0.0.0.0 \
  -e GATEWAY_PORT=3010 \
  -e AFC_FRONT_TARGET=http://afc-front:3000 \
  -e AFC_BACK_TARGET=http://afc-back:3000 \
  afc-back:latest \
  node gateway/server.js
```

No es necesario publicar `3010` hacia el host porque ngrok está en la misma red Docker.

## Ngrok

```text
docker run -d \
  --name ngrok \
  --restart unless-stopped \
  --network afc-network \
  -e NGROK_AUTHTOKEN="$NGROK_AUTHTOKEN" \
  ngrok/ngrok:latest \
  http http://afc-gateway:3010 \
  --url=https://reclining-sulfur-reward.ngrok-free.dev
```

No configurar ngrok OAuth, Traffic Policy OAuth ni políticas de autenticación.

## Backend

Variables runtime principales:

```dotenv
GOOGLE_CLIENT_ID=<client-id-web>
GOOGLE_CLIENT_SECRET=<client-secret>
PUBLIC_URL=https://reclining-sulfur-reward.ngrok-free.dev
GOOGLE_CALLBACK_URL=https://reclining-sulfur-reward.ngrok-free.dev/auth/google/callback
GOOGLE_OAUTH_STATE_TTL_SECONDS=300
GOOGLE_OAUTH_STATE_COOKIE_NAME=afc_google_oauth_state
TRUST_PROXY=1
COOKIE_SECURE=false
COOKIE_SAMESITE=lax
HEALTHCHECK_TIMEOUT_MS=5000
CORS_ALLOW_ANY_ORIGIN=false
CORS_ORIGIN=http://ecosistemadigital.aragon.unam.mx:3005,https://reclining-sulfur-reward.ngrok-free.dev
```

`TRUST_PROXY=1` corresponde al salto `ngrok → gateway → backend`. El puerto backend no debe exponerse libremente a Internet.

## Frontend

```dotenv
PUBLIC_API_BASE_URL=
PUBLIC_GOOGLE_CLIENT_ID=<client-id-web>
PUBLIC_GOOGLE_AUTH_MODE=gateway
PUBLIC_GOOGLE_AUTH_URL=https://reclining-sulfur-reward.ngrok-free.dev/auth/google
AFC_BACKEND_URL=http://afc-back:3000
```

`PUBLIC_API_BASE_URL` debe quedar vacío para utilizar rutas relativas a través del gateway.
`PUBLIC_GOOGLE_AUTH_URL` evita que un frontend abierto directamente, por ejemplo Vite local,
intente resolver `/auth/google` contra su propio origen.

## Google Cloud

Origen JavaScript autorizado:

```text
https://reclining-sulfur-reward.ngrok-free.dev
```

Redirect URI autorizado:

```text
https://reclining-sulfur-reward.ngrok-free.dev/auth/google/callback
```

## Comprobaciones

```text
docker run --rm --network afc-network curlimages/curl:latest http://afc-gateway:3010/health/live

docker run --rm --network afc-network curlimages/curl:latest http://afc-front:3000/

docker run --rm --network afc-network curlimages/curl:latest http://afc-back:3000/api/health/live

curl https://reclining-sulfur-reward.ngrok-free.dev/health/live
curl https://reclining-sulfur-reward.ngrok-free.dev/api/health
```

El gateway enruta:

- `/` y assets hacia `afc-front:3000`.
- `/api/*` y `/auth/*` hacia `afc-back:3000`.
- `/health/live` responde directamente sin recursividad.

## Flujo Google

1. El navegador abre el frontend local, directo o mediante la URL HTTPS pública.
2. El botón navega a `PUBLIC_GOOGLE_AUTH_URL`; si no está configurada, utiliza
  `${PUBLIC_API_BASE_URL}/auth/google` o la ruta relativa `/auth/google`.
3. El gateway reenvía la solicitud a AFC Back.
4. AFC Back genera `state` y PKCE y redirige a Google.
5. Google retorna a `/auth/google/callback` bajo el mismo dominio HTTPS.
6. AFC Back valida el estado, canjea el código, verifica la identidad, crea/vincula usuario y crea sesión Redis.
7. AFC Back establece la cookie HTTP-only/Secure y redirige según el rol.

## Cloudflare Tunnel o HTTPS nativo

La lógica no depende de ngrok. Para migrar:

1. Cambiar `PUBLIC_URL`.
2. Cambiar `GOOGLE_CALLBACK_URL`.
3. Actualizar Google Cloud.
4. Apuntar la nueva entrada HTTPS a `afc-gateway:3010`.
