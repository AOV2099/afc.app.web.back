const MAX_TRACKED_CLIENTS = 10_000;

export function createOAuthRateLimit({ limit, windowMs, scope }) {
  const clients = new Map();

  return function oauthRateLimit(req, res, next) {
    const now = Date.now();
    const clientId = `${scope}:${req.ip || req.socket?.remoteAddress || "unknown"}`;
    let record = clients.get(clientId);

    if (!record || record.resetAt <= now) {
      if (!record && clients.size >= MAX_TRACKED_CLIENTS) {
        clients.delete(clients.keys().next().value);
      }
      record = { count: 0, resetAt: now + windowMs };
      clients.set(clientId, record);
    }

    record.count += 1;
    const remaining = Math.max(0, limit - record.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((record.resetAt - now) / 1000));

    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(remaining));
    res.set("RateLimit-Reset", String(Math.ceil(record.resetAt / 1000)));

    if (record.count > limit) {
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        ok: false,
        code: "oauth_rate_limited",
        message: "Demasiados intentos de acceso. Espera un minuto e intenta nuevamente.",
      });
    }

    return next();
  };
}
