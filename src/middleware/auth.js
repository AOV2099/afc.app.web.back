import { getRedisClient } from "../redisClient.js";
import { query } from "../postgresClient.js";
import {
  DEFAULT_ORG_ID,
  SESSION_COOKIE_NAME,
  ROLES,
  PRIVILEGED_EVENT_CREATOR_ROLES,
  CHECKIN_SCANNER_ROLES,
} from "../config/appConfig.js";
import { sessionKey } from "../utils/session.js";
import {
  isGlobalCareerAdmin,
  normalizeCareerId,
} from "../services/adminUserCareerScope.js";

export { isGlobalCareerAdmin, normalizeCareerId };

export function buildRequestAuth(sessionId, session) {
  return {
    sessionId,
    userId: session.userId,
    role: session.role,
    careerId: session.careerId ?? null,
    picture: typeof session.picture === "string" ? session.picture : null,
    viewAs: session.viewAs
      ? {
          adminUserId: session.viewAs.adminUserId,
          startedAt: session.viewAs.startedAt,
          expiresAt: session.viewAs.expiresAt,
        }
      : null,
  };
}

export const VIEW_AS_EXIT_PATH = "/api/view-as/exit";
const VIEW_AS_WRITABLE_PATHS = new Set([VIEW_AS_EXIT_PATH, "/api/logout"]);
const READ_ONLY_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isViewAsRequestAllowed(method, path) {
  return READ_ONLY_METHODS.has(String(method || "").toUpperCase()) || VIEW_AS_WRITABLE_PATHS.has(path);
}

/** Sesión original del superadmin guardada al iniciar "Ver como usuario". */
export function restoreViewAsSession(session) {
  const { viewAs, ...rest } = session;
  return {
    ...rest,
    userId: viewAs.adminUserId,
    role: viewAs.adminRole,
    careerId: viewAs.adminCareerId ?? null,
    picture: viewAs.adminPicture ?? null,
  };
}

/**
 * La sesión guarda rol y carrera al iniciar sesión; se invalida si el usuario fue desactivado
 * o si su rol/carrera cambiaron desde entonces.
 */
export function isSessionStillValid(session, currentUser) {
  if (!currentUser || currentUser.status !== "active") return false;
  if (String(currentUser.role) !== String(session.role)) return false;
  return normalizeCareerId(currentUser.career_id) === normalizeCareerId(session.careerId);
}

async function loadCurrentUser(userId) {
  const result = await query(
    `SELECT u.status, u.career_id, m.role::text AS role
     FROM users u
     JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
     WHERE u.id = $1
     LIMIT 1`,
    [userId, DEFAULT_ORG_ID],
  );
  return result.rows?.[0] ?? null;
}

// Devuelve la sesión vigente, la del superadmin si la vista caducó o el usuario visto cambió,
// o null si la sesión debe revocarse.
async function resolveSession(redis, sessionId, session) {
  if (!session.viewAs) {
    return isSessionStillValid(session, await loadCurrentUser(session.userId)) ? session : null;
  }

  const adminSession = restoreViewAsSession(session);
  const admin = await loadCurrentUser(adminSession.userId);
  if (!isSessionStillValid(adminSession, admin) || !isGlobalCareerAdmin(adminSession)) return null;

  const expired = Date.now() >= Number(session.viewAs.expiresAt);
  if (expired || !isSessionStillValid(session, await loadCurrentUser(session.userId))) {
    await redis.set(sessionKey(sessionId), JSON.stringify(adminSession), { KEEPTTL: true });
    return adminSession;
  }
  return session;
}

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

    const parsed = JSON.parse(raw);
    if (!parsed?.userId) {
      return res.status(401).json({ ok: false, message: "Sesión inválida." });
    }

    const session = await resolveSession(redis, sessionId, parsed);
    if (!session) {
      await redis.del(sessionKey(sessionId));
      return res.status(401).json({
        ok: false,
        code: "session_revoked",
        message: "Tu sesión ya no es válida. Inicia sesión nuevamente.",
      });
    }

    req.auth = buildRequestAuth(sessionId, session);

    const requestPath = String(req.originalUrl || req.url || "").split("?")[0];
    if (req.auth.viewAs && !isViewAsRequestAllowed(req.method, requestPath)) {
      return res.status(403).json({
        ok: false,
        code: "view_as_read_only",
        message: "Estás en «Ver como usuario» (solo lectura). Sal de esta vista para hacer cambios.",
      });
    }

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

export function requireCareerAdmin(req, res, next) {
  if (req.auth?.role !== ROLES.ADMIN) {
    return res.status(403).json({
      ok: false,
      message: "No autorizado. Se requiere rol admin.",
    });
  }

  const careerId = normalizeCareerId(req.auth?.careerId);
  if (careerId === null) {
    return res.status(403).json({
      ok: false,
      code: "career_required",
      message: "El administrador debe volver a iniciar sesión con una carrera válida asignada.",
    });
  }

  req.auth.careerId = careerId;
  return next();
}

export function requireGlobalAdmin(req, res, next) {
  if (!isGlobalCareerAdmin(req.auth)) {
    return res.status(403).json({
      ok: false,
      code: "global_admin_required",
      message: "Solo el administrador global puede realizar esta acción.",
    });
  }
  return next();
}

export function requireCheckinScanner(req, res, next) {
  if (!CHECKIN_SCANNER_ROLES.has(req.auth?.role)) {
    return res.status(403).json({
      ok: false,
      message: "No autorizado para registrar check-ins.",
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
