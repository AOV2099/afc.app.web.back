import crypto from "crypto";

import {
  GOOGLE_OAUTH_BRIDGE_SHARED_SECRET,
  GOOGLE_OAUTH_BRIDGE_START_URL,
  GOOGLE_OAUTH_BRIDGE_TIMEOUT_MS,
  GOOGLE_OAUTH_BRIDGE_VERIFY_URL,
} from "../config/appConfig.js";

export class GoogleOAuthBridgeError extends Error {
  constructor(status, code, message, terminal = false) {
    super(message);
    this.name = "GoogleOAuthBridgeError";
    this.status = status;
    this.code = code;
    this.terminal = terminal;
  }
}

function requireHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new GoogleOAuthBridgeError(
      503,
      "bridge_not_configured",
      `La variable ${name} no contiene una URL válida.`,
    );
  }

  if (url.protocol !== "https:") {
    throw new GoogleOAuthBridgeError(
      503,
      "bridge_https_required",
      `La variable ${name} debe utilizar HTTPS.`,
    );
  }

  return url;
}

function assertBridgeConfigured() {
  if (
    !GOOGLE_OAUTH_BRIDGE_START_URL ||
    !GOOGLE_OAUTH_BRIDGE_VERIFY_URL ||
    !GOOGLE_OAUTH_BRIDGE_SHARED_SECRET
  ) {
    throw new GoogleOAuthBridgeError(
      503,
      "bridge_not_configured",
      "El intermediario HTTPS de Google aún no está configurado.",
    );
  }
}

function hmacHex(value) {
  return crypto
    .createHmac("sha256", GOOGLE_OAUTH_BRIDGE_SHARED_SECRET)
    .update(value)
    .digest("hex");
}

export function buildGoogleBridgeAuthorizationUrl({ attempt, expiresAt }) {
  assertBridgeConfigured();
  const url = requireHttpsUrl(GOOGLE_OAUTH_BRIDGE_START_URL, "GOOGLE_OAUTH_BRIDGE_START_URL");
  const signature = hmacHex(`${attempt}.${expiresAt}`);

  url.searchParams.set("attempt", attempt);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", signature);

  return url.toString();
}

function bridgeErrorFromResponse(status, payload) {
  const code = String(payload?.error || payload?.code || "bridge_rejected").trim();

  if (status === 409 || code === "code_already_used") {
    return new GoogleOAuthBridgeError(
      409,
      "code_already_used",
      "El código de acceso ya fue utilizado. Inicia sesión nuevamente.",
      true,
    );
  }

  if (status === 410 || code === "code_expired") {
    return new GoogleOAuthBridgeError(
      410,
      "code_expired",
      "El código de acceso expiró. Inicia sesión nuevamente.",
      true,
    );
  }

  if (status === 400 || code === "invalid_code" || code === "invalid_attempt") {
    return new GoogleOAuthBridgeError(
      400,
      "invalid_code",
      "El código de acceso no es válido. Inicia sesión nuevamente.",
      true,
    );
  }

  return new GoogleOAuthBridgeError(
    502,
    "bridge_rejected",
    "El servicio de autenticación HTTPS rechazó la solicitud.",
    status >= 400 && status < 500,
  );
}

function normalizeBridgeIdentity(payload) {
  const identity = payload?.identity;
  const provider = String(identity?.provider || "").trim().toLowerCase();
  const subject = String(identity?.subject || "").trim();
  const email = String(identity?.email || "").trim().toLowerCase();

  if (
    payload?.ok !== true ||
    provider !== "google" ||
    !subject ||
    !email ||
    identity?.email_verified !== true
  ) {
    throw new GoogleOAuthBridgeError(
      502,
      "invalid_bridge_response",
      "El servicio de autenticación HTTPS devolvió una respuesta inválida.",
    );
  }

  return {
    subject,
    email,
    emailVerified: true,
    firstName: String(identity?.first_name || "").trim(),
    lastName: String(identity?.last_name || "").trim(),
    picture: String(identity?.picture || "").trim() || null,
  };
}

export async function redeemGoogleBridgeCode({ code, attempt }) {
  assertBridgeConfigured();
  const verifyUrl = requireHttpsUrl(
    GOOGLE_OAUTH_BRIDGE_VERIFY_URL,
    "GOOGLE_OAUTH_BRIDGE_VERIFY_URL",
  );
  const body = JSON.stringify({ code, attempt });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID();
  const signature = hmacHex(`${timestamp}.${nonce}.${body}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GOOGLE_OAUTH_BRIDGE_TIMEOUT_MS);

  try {
    const response = await fetch(verifyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Cache-Control": "no-store",
        "X-Bridge-Timestamp": timestamp,
        "X-Bridge-Nonce": nonce,
        "X-Bridge-Signature": signature,
      },
      body,
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);

    if (!response.ok) throw bridgeErrorFromResponse(response.status, payload);
    return normalizeBridgeIdentity(payload);
  } catch (error) {
    if (error instanceof GoogleOAuthBridgeError) throw error;
    if (error?.name === "AbortError") {
      throw new GoogleOAuthBridgeError(
        504,
        "bridge_timeout",
        "El servicio de autenticación HTTPS tardó demasiado en responder.",
      );
    }
    throw new GoogleOAuthBridgeError(
      502,
      "bridge_unreachable",
      "No fue posible comunicarse con el servicio de autenticación HTTPS.",
    );
  } finally {
    clearTimeout(timeout);
  }
}
