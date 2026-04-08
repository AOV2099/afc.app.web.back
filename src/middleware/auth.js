import { getRedisClient } from "../redisClient.js";
import { SESSION_COOKIE_NAME, ROLES, PRIVILEGED_EVENT_CREATOR_ROLES } from "../config/appConfig.js";
import { sessionKey } from "../utils/session.js";

export async function requireAuth(req, res, next) {
  try {
    const redis = getRedisClient();
    if (!redis) {
      return res.status(503).json({ ok: false, message: "Redis no está listo." });
    }

    const sessionId = req.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      return res.status(401).json({ ok: false, message: "Sin sesión." });
    }

    const raw = await redis.get(sessionKey(sessionId));
    if (!raw) {
      return res.status(401).json({ ok: false, message: "Sesión expirada." });
    }

    const session = JSON.parse(raw);
    if (!session?.userId) {
      return res.status(401).json({ ok: false, message: "Sesión inválida." });
    }

    req.auth = {
      sessionId,
      userId: session.userId,
      role: session.role,
    };

    return next();
  } catch (err) {
    console.error("Error en requireAuth:", err.message);
    return res.status(500).json({ ok: false, message: "Error de autenticación." });
  }
}

export function requireAdmin(req, res, next) {
  if (req.auth?.role !== ROLES.ADMIN) {
    return res.status(403).json({
      ok: false,
      message: "No autorizado. Se requiere rol admin.",
    });
  }
  return next();
}

export function requireEventManager(req, res, next) {
  if (!PRIVILEGED_EVENT_CREATOR_ROLES.has(req.auth?.role)) {
    return res.status(403).json({
      ok: false,
      message: "No autorizado para administrar eventos.",
    });
  }
  return next();
}
