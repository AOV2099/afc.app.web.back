import { Router } from "express";

import { DEFAULT_ORG_ID } from "../config/appConfig.js";
import {
  isGlobalCareerAdmin,
  normalizeCareerId,
  requireAuth,
  requireGlobalAdmin,
  restoreViewAsSession,
  VIEW_AS_EXIT_PATH,
} from "../middleware/auth.js";
import { query } from "../postgresClient.js";
import { getRedisClient } from "../redisClient.js";
import { roleHomePath } from "../services/publicUrl.js";
import { sessionKey } from "../utils/session.js";

export const VIEW_AS_DURATION_MS = 30 * 60 * 1000;
const ADMIN_USERS_PATH = "/admin/users";

const router = Router();

async function readSession(redis, sessionId) {
  const raw = await redis.get(sessionKey(sessionId));
  return raw ? JSON.parse(raw) : null;
}

export function buildViewAsSession(adminSession, target, now = Date.now()) {
  return {
    ...adminSession,
    userId: target.id,
    role: target.role,
    careerId: normalizeCareerId(target.career_id),
    picture: null,
    viewAs: {
      adminUserId: adminSession.userId,
      adminRole: adminSession.role,
      adminCareerId: adminSession.careerId ?? null,
      adminPicture: adminSession.picture ?? null,
      startedAt: now,
      expiresAt: now + VIEW_AS_DURATION_MS,
    },
  };
}

router.post("/api/admin/users/:userId/view-as", requireAuth, requireGlobalAdmin, async (req, res) => {
  const targetId = Number(req.params.userId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ ok: false, message: "userId inválido." });
  }
  if (targetId === Number(req.auth.userId)) {
    return res.status(400).json({ ok: false, message: "Ya estás viendo tu propia cuenta." });
  }

  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  try {
    const result = await query(
      `SELECT u.id, u.status, u.career_id, m.role::text AS role
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
       WHERE u.id = $1
       LIMIT 1`,
      [targetId, DEFAULT_ORG_ID],
    );
    const target = result.rows?.[0];
    if (!target) {
      return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
    }
    if (target.status !== "active") {
      return res.status(409).json({ ok: false, message: "Solo se puede ver la cuenta de usuarios activos." });
    }
    if (isGlobalCareerAdmin({ role: target.role, careerId: target.career_id })) {
      return res.status(403).json({ ok: false, message: "No se puede ver como otro administrador global." });
    }

    const adminSession = await readSession(redis, req.auth.sessionId);
    if (!adminSession) {
      return res.status(401).json({ ok: false, message: "Sesión expirada." });
    }

    const viewAsSession = buildViewAsSession(adminSession, target);
    await redis.set(sessionKey(req.auth.sessionId), JSON.stringify(viewAsSession), { KEEPTTL: true });

    return res.status(200).json({
      ok: true,
      home_path: roleHomePath(target.role),
      expires_at: new Date(viewAsSession.viewAs.expiresAt).toISOString(),
    });
  } catch (err) {
    console.error("Error en POST /api/admin/users/:userId/view-as:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo abrir la vista del usuario." });
  }
});

router.post(VIEW_AS_EXIT_PATH, requireAuth, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  try {
    const session = await readSession(redis, req.auth.sessionId);
    if (session?.viewAs) {
      const adminSession = restoreViewAsSession(session);
      await redis.set(sessionKey(req.auth.sessionId), JSON.stringify(adminSession), { KEEPTTL: true });
      return res.status(200).json({ ok: true, home_path: ADMIN_USERS_PATH });
    }

    // La vista pudo haber caducado y el middleware ya restauró la sesión del superadmin.
    const homePath = isGlobalCareerAdmin(req.auth) ? ADMIN_USERS_PATH : roleHomePath(req.auth.role);
    return res.status(200).json({ ok: true, home_path: homePath });
  } catch (err) {
    console.error("Error en POST /api/view-as/exit:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo salir de la vista." });
  }
});

export default router;
