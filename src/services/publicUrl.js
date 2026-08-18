export class PublicUrlConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicUrlConfigError";
    this.code = code;
  }
}

function parseHttpsUrl(value, name) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    throw new PublicUrlConfigError("invalid_public_url", `${name} no contiene una URL válida.`);
  }

  if (url.protocol !== "https:") {
    throw new PublicUrlConfigError(
      "public_url_https_required",
      `${name} debe utilizar HTTPS para Google OAuth.`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new PublicUrlConfigError(
      "invalid_public_url",
      `${name} contiene componentes no permitidos.`,
    );
  }
  return url;
}

export function resolveOAuthPublicConfig({ publicUrl, googleCallbackUrl }) {
  if (!String(publicUrl || "").trim()) {
    throw new PublicUrlConfigError(
      "public_url_missing",
      "PUBLIC_URL no está configurada para Google OAuth.",
    );
  }

  const publicUrlObject = parseHttpsUrl(publicUrl, "PUBLIC_URL");
  if (publicUrlObject.pathname !== "/") {
    throw new PublicUrlConfigError(
      "invalid_public_url",
      "PUBLIC_URL debe contener únicamente el origen, sin rutas.",
    );
  }

  const callback = googleCallbackUrl
    ? parseHttpsUrl(googleCallbackUrl, "GOOGLE_CALLBACK_URL")
    : new URL("/auth/google/callback", publicUrlObject);

  if (callback.origin !== publicUrlObject.origin) {
    throw new PublicUrlConfigError(
      "callback_origin_mismatch",
      "GOOGLE_CALLBACK_URL debe utilizar el mismo origen que PUBLIC_URL.",
    );
  }

  return {
    publicOrigin: publicUrlObject.origin,
    publicHostname: publicUrlObject.hostname.toLowerCase(),
    callbackUrl: callback.toString(),
  };
}

export function validatePublicProxyRequest(req, config) {
  if (!req.secure) {
    throw new PublicUrlConfigError(
      "forwarded_https_missing",
      "La solicitud no fue reconocida como HTTPS. Revisa el gateway y TRUST_PROXY.",
    );
  }

  const hostname = String(req.hostname || "").trim().toLowerCase();
  if (!hostname || hostname !== config.publicHostname) {
    throw new PublicUrlConfigError(
      "forwarded_host_mismatch",
      "El host reenviado por el gateway no coincide con PUBLIC_URL.",
    );
  }
}

export function roleHomePath(role) {
  const normalizedRole = String(role || "").trim().toLowerCase();
  if (normalizedRole === "admin") return "/admin/home";
  if (normalizedRole === "staff") return "/staff/scanner";
  return "/app/home";
}
