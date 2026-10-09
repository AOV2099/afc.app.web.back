import { Router } from "express";

import { getRedisClient } from "../redisClient.js";
import { query } from "../postgresClient.js";
import { ROLES } from "../config/appConfig.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { isGlobalCareerAdmin, normalizeCareerId } from "../services/adminUserCareerScope.js";
import { MAX_PAGE, parsePositiveIntParam } from "../utils/requestParams.js";

const router = Router();
const ALERTS_SEQ_KEY = "alerts:seq";
const ALERTS_INDEX_KEY = "alerts:index";
const ALERTS_PAGE_SIZE_DEFAULT = 20;
const ALERTS_PAGE_SIZE_MAX = 100;

function alertKey(id) {
  return `alerts:item:${id}`;
}

function parseDateOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseBooleanInput(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  }
  return Boolean(value);
}

function parseAlertPayload(body, { partial = false } = {}) {
  const titleRaw = body?.title;
  const descriptionRaw = body?.description;
  const categoryRaw = body?.category;
  const expiresAtRaw = body?.expires_at ?? body?.expiresAt;
  const autoDeleteRaw = body?.auto_delete ?? body?.autoDelete;

  const parsed = {};

  if (!partial || titleRaw !== undefined) {
    const title = String(titleRaw || "").trim();
    if (!title) return { error: "title es requerido." };
    parsed.title = title;
  }

  if (!partial || descriptionRaw !== undefined) {
    const description = String(descriptionRaw || "").trim();
    if (!description) return { error: "description es requerido." };
    parsed.description = description;
  }

  if (!partial || categoryRaw !== undefined) {
    const category = String(categoryRaw || "").trim();
    if (!category) return { error: "category es requerido." };
    parsed.category = category;
  }

  if (!partial || expiresAtRaw !== undefined) {
    const expiresAt = parseDateOrNull(expiresAtRaw);
    if (!expiresAt) {
      return { error: "expires_at es requerido y debe ser fecha ISO válida." };
    }
    if (expiresAt <= new Date()) {
      return { error: "expires_at debe ser una fecha futura." };
    }
    parsed.expires_at = expiresAt.toISOString();
  }

  if (!partial || autoDeleteRaw !== undefined) {
    parsed.auto_delete = parseBooleanInput(autoDeleteRaw, false);
  }

  return { value: parsed };
}

async function getAlertById(redis, id) {
  const raw = await redis.get(alertKey(id));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadUsersById(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))].filter((id) => /^\d+$/u.test(id));
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT id::text AS id, email, career_id FROM users WHERE id = ANY($1::bigint[])`,
    [ids],
  );
  return new Map(result.rows.map((row) => [row.id, row]));
}

// Alertas anteriores a este cambio no guardaban correo ni carrera: se toman del usuario que las creó.
async function withAuthorInfo(alerts) {
  const missing = alerts.filter((alert) => !alert.created_by_email || alert.career_id === undefined);
  const users = await loadUsersById(missing.map((alert) => alert.created_by));
  return alerts.map((alert) => {
    const author = users.get(String(alert.created_by));
    return {
      ...alert,
      created_by_email: alert.created_by_email ?? author?.email ?? null,
      career_id: alert.career_id !== undefined ? alert.career_id : normalizeCareerId(author?.career_id),
    };
  });
}

export function canManageAlert(auth, alert) {
  if (isGlobalCareerAdmin(auth)) return true;
  if (auth?.role !== ROLES.ADMIN) return false;
  const careerId = normalizeCareerId(auth?.careerId);
  return careerId !== null && careerId === normalizeCareerId(alert?.career_id);
}

// Alumnos y visitantes ven la alerta sin datos del autor.
function presentAlert(auth, alert) {
  if (auth?.role !== ROLES.ADMIN) {
    const { created_by: _by, created_by_email: _email, updated_by: _updated, career_id: _career, ...publicAlert } = alert;
    return publicAlert;
  }
  return { ...alert, can_manage: canManageAlert(auth, alert) };
}

async function loadManageableAlert(redis, alertId, auth, res) {
  const existing = await getAlertById(redis, alertId);
  if (!existing) {
    await redis.zRem(ALERTS_INDEX_KEY, String(alertId));
    res.status(404).json({ ok: false, message: "Alerta no encontrada." });
    return null;
  }
  const [alert] = await withAuthorInfo([existing]);
  if (!canManageAlert(auth, alert)) {
    res.status(403).json({
      ok: false,
      code: "alert_career_forbidden",
      message: "Solo los administradores de la carrera que publicó la alerta o el superadmin pueden modificarla.",
    });
    return null;
  }
  return alert;
}

async function saveAlert(redis, alert) {
  await redis.set(alertKey(alert.id), JSON.stringify(alert));

  if (alert.auto_delete) {
    const expiresAtDate = new Date(alert.expires_at);
    const ttlSec = Math.floor((expiresAtDate.getTime() - Date.now()) / 1000);
    if (ttlSec > 0) {
      await redis.expire(alertKey(alert.id), ttlSec);
    } else {
      await redis.del(alertKey(alert.id));
      await redis.zRem(ALERTS_INDEX_KEY, String(alert.id));
    }
  } else {
    await redis.persist(alertKey(alert.id));
  }
}

router.get("/api/alerts", requireAuth, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  const page = parsePositiveIntParam(req.query?.page, 1, MAX_PAGE);
  const pageSize = parsePositiveIntParam(req.query?.pageSize, ALERTS_PAGE_SIZE_DEFAULT, ALERTS_PAGE_SIZE_MAX);

  const includeExpired = parseBooleanInput(req.query?.includeExpired, false);

  try {
    const ids = await redis.zRange(ALERTS_INDEX_KEY, 0, -1, { REV: true });
    const rows = [];

    for (const id of ids) {
      const alert = await getAlertById(redis, id);
      if (!alert) {
        await redis.zRem(ALERTS_INDEX_KEY, id);
        continue;
      }

      const isExpired = new Date(alert.expires_at) <= new Date();
      if (!includeExpired && isExpired) continue;

      rows.push({
        ...alert,
        is_expired: isExpired,
      });
    }

    const total = rows.length;
    const offset = (page - 1) * pageSize;
    const alerts = (await withAuthorInfo(rows.slice(offset, offset + pageSize))).map((alert) =>
      presentAlert(req.auth, alert),
    );

    return res.status(200).json({
      ok: true,
      alerts,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error("Error en GET /api/alerts:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudieron consultar las alertas." });
  }
});

router.get("/api/alerts/:alertId", requireAuth, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  const alertId = Number(req.params.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return res.status(400).json({ ok: false, message: "alertId inválido." });
  }

  try {
    const alert = await getAlertById(redis, alertId);
    if (!alert) {
      await redis.zRem(ALERTS_INDEX_KEY, String(alertId));
      return res.status(404).json({ ok: false, message: "Alerta no encontrada." });
    }

    const [withAuthor] = await withAuthorInfo([alert]);
    return res.status(200).json({
      ok: true,
      alert: presentAlert(req.auth, {
        ...withAuthor,
        is_expired: new Date(alert.expires_at) <= new Date(),
      }),
    });
  } catch (err) {
    console.error("Error en GET /api/alerts/:alertId:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo consultar la alerta." });
  }
});

router.post("/api/admin/alerts", requireAuth, requireAdmin, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  const parsed = parseAlertPayload(req.body, { partial: false });
  if (parsed.error) {
    return res.status(400).json({ ok: false, message: parsed.error });
  }

  try {
    const users = await loadUsersById([req.auth.userId]);
    const author = users.get(String(req.auth.userId));
    const nextId = await redis.incr(ALERTS_SEQ_KEY);
    const nowIso = new Date().toISOString();

    const alert = {
      id: Number(nextId),
      title: parsed.value.title,
      description: parsed.value.description,
      category: parsed.value.category,
      expires_at: parsed.value.expires_at,
      auto_delete: parsed.value.auto_delete,
      created_at: nowIso,
      updated_at: nowIso,
      created_by: req.auth.userId,
      created_by_email: author?.email ?? null,
      career_id: normalizeCareerId(req.auth.careerId),
    };

    await saveAlert(redis, alert);
    await redis.zAdd(ALERTS_INDEX_KEY, [{ score: Date.now(), value: String(alert.id) }]);

    return res.status(201).json({
      ok: true,
      message: "Alerta creada correctamente.",
      alert,
    });
  } catch (err) {
    console.error("Error en POST /api/admin/alerts:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo crear la alerta." });
  }
});

router.put("/api/admin/alerts/:alertId", requireAuth, requireAdmin, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  const alertId = Number(req.params.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return res.status(400).json({ ok: false, message: "alertId inválido." });
  }

  const parsed = parseAlertPayload(req.body, { partial: true });
  if (parsed.error) {
    return res.status(400).json({ ok: false, message: parsed.error });
  }

  if (!Object.keys(parsed.value).length) {
    return res.status(400).json({ ok: false, message: "No hay cambios para actualizar." });
  }

  try {
    const existing = await loadManageableAlert(redis, alertId, req.auth, res);
    if (!existing) return undefined;

    const updated = {
      ...existing,
      ...parsed.value,
      id: alertId,
      updated_at: new Date().toISOString(),
      updated_by: req.auth.userId,
    };

    await saveAlert(redis, updated);

    if (parsed.value.expires_at !== undefined) {
      await redis.zAdd(ALERTS_INDEX_KEY, [{ score: Date.now(), value: String(alertId) }]);
    }

    return res.status(200).json({
      ok: true,
      message: "Alerta actualizada correctamente.",
      alert: updated,
    });
  } catch (err) {
    console.error("Error en PUT /api/admin/alerts/:alertId:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo actualizar la alerta." });
  }
});

router.delete("/api/admin/alerts/:alertId", requireAuth, requireAdmin, async (req, res) => {
  const redis = getRedisClient();
  if (!redis) {
    return res.status(503).json({ ok: false, message: "Redis no está listo." });
  }

  const alertId = Number(req.params.alertId);
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return res.status(400).json({ ok: false, message: "alertId inválido." });
  }

  try {
    const existing = await loadManageableAlert(redis, alertId, req.auth, res);
    if (!existing) return undefined;

    await redis.del(alertKey(alertId));
    await redis.zRem(ALERTS_INDEX_KEY, String(alertId));

    return res.status(200).json({
      ok: true,
      message: "Alerta eliminada correctamente.",
      deleted_id: alertId,
    });
  } catch (err) {
    console.error("Error en DELETE /api/admin/alerts/:alertId:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo eliminar la alerta." });
  }
});

export default router;
