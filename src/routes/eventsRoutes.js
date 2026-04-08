import crypto from "crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";

import { query, withTransaction } from "../postgresClient.js";
import { getRedisClient } from "../redisClient.js";
import { requireAdmin, requireAuth, requireEventManager } from "../middleware/auth.js";
import {
  CANCEL_POLICIES,
  DEFAULT_ORG_ID,
  EVENT_LIST_PAGE_SIZE_DEFAULT,
  EVENT_LIST_PAGE_SIZE_MAX,
  EVENT_STATUSES,
  REGISTRATION_MODES,
  ROLES,
  RESUBMISSION_POLICIES,
} from "../config/appConfig.js";
import { normalizeCreateEventPayload, parseIsoDateOrNull } from "../validators/events.js";

const router = Router();
const COUNTER_TTL_SECONDS = 60 * 5;
const RECENT_CHECKINS_DEFAULT_LIMIT = 20;
const RECENT_CHECKINS_MAX_LIMIT = 50;
const TIMESERIES_DEFAULT_TIMEZONE = "America/Mexico_City";
const TIMESERIES_DEFAULT_WINDOW_HOURS = 24;
const VIEWS_SERIES_TTL_SECONDS = 60 * 60 * 24 * 90;
const TIMELINE_TTL_SECONDS = 60 * 60 * 24 * 90;

const EVENT_TYPE_CATALOG = Object.freeze({
  inscription: "Inscripción",
  inscription_request: "Solicitud de inscripción",
  unregistration: "Baja",
  unregistration_request: "Solicitud de baja",
  checkin_accepted: "Check-in exitoso",
  checkin_rejected: "Check-in rechazado",
  checkin_duplicate: "Check-in duplicado",
  checkin_invalid_ticket: "Check-in inválido",
  checkin_cancelled_ticket: "Check-in con ticket cancelado",
  checkin_failed: "Check-in fallido",
});

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
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

async function ensureEventCategoryExists(category, tx = null) {
  const normalizedCategory = String(category || "").trim();
  if (!normalizedCategory) {
    throw createHttpError(400, "category es requerido.");
  }

  const executor = tx && typeof tx.query === "function" ? tx : { query };
  const result = await executor.query(
    `SELECT key
     FROM event_categories
     WHERE key = $1
     LIMIT 1`,
    [normalizedCategory],
  );

  if (!result.rows?.[0]) {
    throw createHttpError(400, "category inválido. Debe existir en event_categories.");
  }

  return normalizedCategory;
}

function generateTicketCode() {
  return `${Date.now().toString(36)}_${crypto.randomBytes(18).toString("base64url")}`;
}

function generateStaffEmail(eventId) {
  return `staff_${eventId}@afc.local`;
}

function generateStaffPassword() {
  return crypto.randomBytes(6).toString("base64url").slice(0, 8);
}

function mapEventForResponse(event) {
  if (!event || typeof event !== "object") return event;

  const capacityEnabled = Boolean(event.capacity_enabled);
  const mapped = {
    ...event,
    capacity_enabled: capacityEnabled,
  };

  if (!capacityEnabled || event.capacity === null || event.capacity === undefined) {
    delete mapped.capacity;
  } else {
    mapped.capacity = Number(event.capacity);
  }

  return mapped;
}

function parseDashboardTimeFilter(queryParams) {
  const bucketInput = String(queryParams?.bucket || "hour").trim().toLowerCase();
  if (bucketInput !== "hour" && bucketInput !== "day") {
    throw createHttpError(400, "bucket inválido. Usa 'hour' o 'day'.");
  }

  const tz = String(queryParams?.tz || TIMESERIES_DEFAULT_TIMEZONE).trim();
  try {
    Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
  } catch {
    throw createHttpError(400, "tz inválido.");
  }

  const to = queryParams?.to ? new Date(String(queryParams.to)) : new Date();
  if (Number.isNaN(to.getTime())) {
    throw createHttpError(400, "to inválido. Debe ser ISO date-time.");
  }

  const from = queryParams?.from
    ? new Date(String(queryParams.from))
    : new Date(to.getTime() - TIMESERIES_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);

  if (Number.isNaN(from.getTime())) {
    throw createHttpError(400, "from inválido. Debe ser ISO date-time.");
  }

  if (from > to) {
    throw createHttpError(400, "from no puede ser mayor que to.");
  }

  return {
    bucket: bucketInput,
    tz,
    from: from.toISOString(),
    to: to.toISOString(),
  };
}

function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const earthRadiusM = 6371000;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return Math.round(2 * earthRadiusM * Math.asin(Math.sqrt(a)));
}

function getCheckinEventTypeByResult(result) {
  if (result === "accepted") return EVENT_TYPE_CATALOG.checkin_accepted;
  if (result === "rejected") return EVENT_TYPE_CATALOG.checkin_rejected;
  if (result === "duplicate") return EVENT_TYPE_CATALOG.checkin_duplicate;
  if (result === "invalid_ticket") return EVENT_TYPE_CATALOG.checkin_invalid_ticket;
  if (result === "cancelled_ticket") return EVENT_TYPE_CATALOG.checkin_cancelled_ticket;
  return EVENT_TYPE_CATALOG.checkin_failed;
}

async function incrementCachedCounter({ key, countSql, countParams = [] }) {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    void countSql;
    void countParams;
    await redis.set(key, "0", { EX: COUNTER_TTL_SECONDS, NX: true });
    await redis.incr(key);
    await redis.expire(key, COUNTER_TTL_SECONDS);
  } catch (err) {
    console.warn(`Redis counter update failed for ${key}:`, err.message);
  }
}

export async function getEventRegistrationsCount(eventId) {
  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM registrations
     WHERE event_id = $1`,
    [normalizedEventId],
  );

  return Number(countResult.rows?.[0]?.total ?? 0);
}

async function getCachedCounterValue({ key, countSql, countParams = [] }) {
  const redis = getRedisClient();

  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached !== null) {
        const parsed = Number(cached);
        if (Number.isInteger(parsed) && parsed >= 0) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`Redis read failed for ${key}:`, err.message);
    }
  }

  const countResult = await query(countSql, countParams);
  const total = Number(countResult.rows?.[0]?.total ?? 0);

  if (redis) {
    try {
      await redis.set(key, String(total), { EX: COUNTER_TTL_SECONDS });
    } catch (err) {
      console.warn(`Redis write failed for ${key}:`, err.message);
    }
  }

  return total;
}

async function getEventRegistrationStats(eventId) {
  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }

  const totalResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM registrations
     WHERE event_id = $1`,
    [normalizedEventId],
  );
  const approvedResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM registrations
     WHERE event_id = $1
       AND status = 'approved'::registration_status`,
    [normalizedEventId],
  );
  const pendingResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM registrations
     WHERE event_id = $1
       AND status = 'pending'::registration_status`,
    [normalizedEventId],
  );

  const total = Number(totalResult.rows?.[0]?.total ?? 0);
  const approved = Number(approvedResult.rows?.[0]?.total ?? 0);
  const pending = Number(pendingResult.rows?.[0]?.total ?? 0);

  return { total, approved, pending };
}

async function getSessionLiveStats(eventId, sessionId) {
  const normalizedEventId = Number(eventId);
  const normalizedSessionId = Number(sessionId);

  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }
  if (!Number.isInteger(normalizedSessionId) || normalizedSessionId <= 0) {
    throw createHttpError(400, "sessionId inválido.");
  }

  const statsKey = `event:${normalizedEventId}:session:${normalizedSessionId}:stats`;
  const presentUsersKey = `event:${normalizedEventId}:session:${normalizedSessionId}:present_users_count`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const [rawStats, rawPresentUsers] = await Promise.all([
        redis.hGetAll(statsKey),
        redis.get(presentUsersKey),
      ]);

      if (rawStats && Object.keys(rawStats).length > 0) {
        const parsed = {
          accepted: Number(rawStats.accepted ?? 0),
          rejected: Number(rawStats.rejected ?? 0),
          duplicate: Number(rawStats.duplicate ?? 0),
          invalid_ticket: Number(rawStats.invalid_ticket ?? 0),
          cancelled_ticket: Number(rawStats.cancelled_ticket ?? 0),
          total: Number(rawStats.total ?? 0),
          present_users: Number(rawPresentUsers ?? 0),
        };

        if (
          Object.values(parsed).every((v) => Number.isInteger(v) && v >= 0)
        ) {
          return parsed;
        }
      }
    } catch (err) {
      console.warn(`Redis read failed for ${statsKey}:`, err.message);
    }
  }

  return {
    accepted: 0,
    rejected: 0,
    duplicate: 0,
    invalid_ticket: 0,
    cancelled_ticket: 0,
    total: 0,
    present_users: 0,
  };
}

async function getRecentSessionCheckins(eventId, sessionId, limit) {
  const normalizedEventId = Number(eventId);
  const normalizedSessionId = Number(sessionId);
  const normalizedLimit = Math.min(
    RECENT_CHECKINS_MAX_LIMIT,
    Math.max(1, Number(limit || RECENT_CHECKINS_DEFAULT_LIMIT)),
  );

  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }
  if (!Number.isInteger(normalizedSessionId) || normalizedSessionId <= 0) {
    throw createHttpError(400, "sessionId inválido.");
  }

  const cacheKey = `event:${normalizedEventId}:session:${normalizedSessionId}:recent_checkins:${RECENT_CHECKINS_MAX_LIMIT}`;
  const redis = getRedisClient();

  if (redis) {
    try {
      const raw = await redis.lRange(cacheKey, 0, normalizedLimit - 1);
      return raw
        .map((item) => {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch (err) {
      console.warn(`Redis read failed for ${cacheKey}:`, err.message);
    }
  }

  return [];
}

function formatBucketKey(timestampMs, tz, bucket) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: bucket === "hour" ? "2-digit" : undefined,
    hour12: false,
  }).formatToParts(new Date(timestampMs));

  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  if (bucket === "hour") {
    return `${map.year}-${map.month}-${map.day}T${map.hour}:00:00`;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function buildBucketTimeline({ from, to, tz, bucket }) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const stepMs = bucket === "day" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const keys = [];

  for (let t = start; t <= end; t += stepMs) {
    const key = formatBucketKey(t, tz, bucket);
    if (keys[keys.length - 1] !== key) keys.push(key);
  }

  return keys;
}

async function getHourlySeriesFromRedis(redisKey, { from, to, tz, bucket }) {
  const redis = getRedisClient();
  const timeline = buildBucketTimeline({ from, to, tz, bucket });
  const values = new Map(timeline.map((key) => [key, 0]));

  if (!redis) {
    return timeline.map((key) => ({ bucket_start: key, count: 0 }));
  }

  try {
    const items = await redis.zRangeWithScores(redisKey, 0, -1);
    const fromSec = Math.floor(new Date(from).getTime() / 1000);
    const toSec = Math.floor(new Date(to).getTime() / 1000);

    for (const item of items) {
      const epochSec = Number(item.value);
      if (!Number.isInteger(epochSec)) continue;
      if (epochSec < fromSec || epochSec > toSec) continue;

      const key = formatBucketKey(epochSec * 1000, tz, bucket);
      if (values.has(key)) {
        values.set(key, Number(values.get(key) || 0) + Number(item.score || 0));
      }
    }
  } catch (err) {
    console.warn(`Redis read failed for ${redisKey}:`, err.message);
  }

  return timeline.map((key) => ({ bucket_start: key, count: Number(values.get(key) || 0) }));
}

async function getTimelineEvents(redisKey) {
  const redis = getRedisClient();
  if (!redis) return [];

  try {
    const rows = await redis.zRange(redisKey, 0, -1);
    return rows
      .map((row) => {
        try {
          return JSON.parse(row);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn(`Redis read failed for ${redisKey}:`, err.message);
    return [];
  }
}

async function getEventActivitySeries({ eventId }) {
  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }

  const [inscriptionsTimeline, viewsTimeline, checkinsTimeline] = await Promise.all([
    getTimelineEvents(`event:${normalizedEventId}:inscriptions:timeline`),
    getTimelineEvents(`event:${normalizedEventId}:views:timeline`),
    getTimelineEvents(`event:${normalizedEventId}:checkins:timeline`),
  ]);

  const registrationsCreated = inscriptionsTimeline.filter(
    (event) =>
      event?.event_type === "inscripcion" ||
      event?.event_type === "Inscripción" ||
      event?.event_type === EVENT_TYPE_CATALOG.inscription ||
      event?.type === "registration",
  ).length;
  const registrationRequests = inscriptionsTimeline.filter(
    (event) => event?.event_type === EVENT_TYPE_CATALOG.inscription_request,
  ).length;
  const registrationsCancelled = inscriptionsTimeline.filter(
    (event) =>
      event?.event_type === "baja" ||
      event?.event_type === "Baja" ||
      event?.event_type === EVENT_TYPE_CATALOG.unregistration ||
      event?.type === "unregistration",
  ).length;

  const checkinsAccepted = checkinsTimeline.filter(
    (event) =>
      event?.event_type === "checkin_exitoso" ||
      event?.event_type === EVENT_TYPE_CATALOG.checkin_accepted ||
      (event?.type === "checkin" && event?.result === "accepted"),
  ).length;
  const checkinsRejected = checkinsTimeline.filter(
    (event) =>
      event?.event_type === "checkin_rechazado" ||
      event?.event_type === EVENT_TYPE_CATALOG.checkin_rejected ||
      (event?.type === "checkin" && event?.result === "rejected"),
  ).length;
  const checkinsDuplicate = checkinsTimeline.filter(
    (event) =>
      event?.event_type === EVENT_TYPE_CATALOG.checkin_duplicate ||
      (event?.type === "checkin" && event?.result === "duplicate"),
  ).length;
  const checkinsInvalidTicket = checkinsTimeline.filter(
    (event) =>
      event?.event_type === EVENT_TYPE_CATALOG.checkin_invalid_ticket ||
      (event?.type === "checkin" && event?.result === "invalid_ticket"),
  ).length;
  const checkinsCancelledTicket = checkinsTimeline.filter(
    (event) =>
      event?.event_type === EVENT_TYPE_CATALOG.checkin_cancelled_ticket ||
      (event?.type === "checkin" && event?.result === "cancelled_ticket"),
  ).length;
  const checkinsFailed = checkinsTimeline.filter(
    (event) =>
      event?.event_type === "checkin_fallido" ||
      event?.event_type === EVENT_TYPE_CATALOG.checkin_failed ||
      (event?.type === "checkin" && event?.result !== "accepted" && event?.result !== "rejected"),
  ).length;

  return {
    inscriptions_count: Math.max(0, Number(registrationsCreated || 0) - Number(registrationsCancelled || 0)),
    views_count: viewsTimeline.length,
    checkins_count: checkinsTimeline.length,
    checkins_breakdown: {
      exitosos: checkinsAccepted,
      rechazados: checkinsRejected,
      fallidos: checkinsFailed,
      duplicados: checkinsDuplicate,
      ticket_invalido: checkinsInvalidTicket,
      ticket_cancelado: checkinsCancelledTicket,
    },
    registrations_breakdown: {
      inscripciones: registrationsCreated,
      solicitudes_inscripcion: registrationRequests,
      bajas: registrationsCancelled,
    },
  };
}

async function getRecentActivityStack({ eventId, limit = 30 }) {
  const normalizedEventId = Number(eventId);
  if (!Number.isInteger(normalizedEventId) || normalizedEventId <= 0) {
    throw createHttpError(400, "eventId inválido.");
  }

  const redis = getRedisClient();
  if (!redis) {
    return [];
  }

  const normalizedLimit = Math.min(200, Math.max(1, Number(limit || 30)));
  const baseLimitPerTimeline = Math.max(100, normalizedLimit * 4);

  const inscriptionsKey = `event:${normalizedEventId}:inscriptions:timeline`;
  const checkinsKey = `event:${normalizedEventId}:checkins:timeline`;

  const normalizeEventTypeLabel = (eventType, fallbackType, fallbackResult) => {
    const raw = String(eventType || "").trim().toLowerCase();

    if (raw === "inscripcion" || raw === "inscripción" || raw === "registration") {
      return EVENT_TYPE_CATALOG.inscription;
    }
    if (
      raw === "solicitud de inscripción" ||
      raw === "solicitud_inscripcion" ||
      raw === "inscription_request"
    ) {
      return EVENT_TYPE_CATALOG.inscription_request;
    }
    if (raw === "baja" || raw === "unregistration") {
      return EVENT_TYPE_CATALOG.unregistration;
    }
    if (
      raw === "solicitud_baja" ||
      raw === "solicitud de baja" ||
      raw === "unregistration_request"
    ) {
      return EVENT_TYPE_CATALOG.unregistration_request;
    }
    if (raw === "checkin_exitoso" || raw === "check-in exitoso") {
      return EVENT_TYPE_CATALOG.checkin_accepted;
    }
    if (raw === "checkin_rechazado" || raw === "check-in rechazado") {
      return EVENT_TYPE_CATALOG.checkin_rejected;
    }
    if (raw === "checkin_duplicado" || raw === "check-in duplicado" || raw === "duplicate") {
      return EVENT_TYPE_CATALOG.checkin_duplicate;
    }
    if (
      raw === "checkin_invalido" ||
      raw === "check-in inválido" ||
      raw === "invalid_ticket"
    ) {
      return EVENT_TYPE_CATALOG.checkin_invalid_ticket;
    }
    if (
      raw === "checkin_ticket_cancelado" ||
      raw === "check-in con ticket cancelado" ||
      raw === "cancelled_ticket"
    ) {
      return EVENT_TYPE_CATALOG.checkin_cancelled_ticket;
    }
    if (raw === "checkin_fallido" || raw === "check-in fallido") {
      return EVENT_TYPE_CATALOG.checkin_failed;
    }

    if (raw) return eventType;

    if (fallbackType === "registration") {
      return fallbackResult === "pending"
        ? EVENT_TYPE_CATALOG.inscription_request
        : EVENT_TYPE_CATALOG.inscription;
    }
    if (fallbackType === "unregistration") return EVENT_TYPE_CATALOG.unregistration;
    if (fallbackType === "unregistration_request") return EVENT_TYPE_CATALOG.unregistration_request;
    if (fallbackType === "checkin") return getCheckinEventTypeByResult(fallbackResult);

    return null;
  };

  try {
    const [inscriptionsRaw, checkinsRaw] = await Promise.all([
      redis.zRange(inscriptionsKey, -baseLimitPerTimeline, -1),
      redis.zRange(checkinsKey, -baseLimitPerTimeline, -1),
    ]);

    const rows = [...inscriptionsRaw, ...checkinsRaw]
      .map((item) => {
        try {
          const parsed = JSON.parse(item);
          const resolvedType = normalizeEventTypeLabel(
            parsed?.event_type,
            parsed?.type,
            parsed?.result,
          );

          if (!resolvedType) return null;

          return {
            ts: Number(parsed?.ts || 0),
            event_type: resolvedType,
            ...(parsed?.type ? { type: parsed.type } : {}),
            ...(parsed?.result ? { result: parsed.result } : {}),
            ...(parsed?.session_id !== undefined && parsed?.session_id !== null
              ? { session_id: parsed.session_id }
              : {}),
            ...(parsed?.user_id !== undefined && parsed?.user_id !== null
              ? { user_id: parsed.user_id }
              : {}),
            ...(parsed?.ticket_id !== undefined && parsed?.ticket_id !== null
              ? { ticket_id: parsed.ticket_id }
              : {}),
            ...(parsed?.registration_id !== undefined && parsed?.registration_id !== null
              ? { registration_id: parsed.registration_id }
              : {}),
            ...(parsed?.registration_status
              ? { registration_status: parsed.registration_status }
              : {}),
            ...(parsed?.reactivated === true ? { reactivated: true } : {}),
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0))
      .slice(0, normalizedLimit);

    return rows;
  } catch (err) {
    console.warn(`Redis read failed for recent activity stack event=${normalizedEventId}:`, err.message);
    return [];
  }
}

async function invalidateRecentCheckinsCache(eventId, sessionId) {
  const redis = getRedisClient();
  if (!redis?.scanIterator) return;

  const pattern = `event:${eventId}:session:${sessionId}:recent_checkins:*`;

  try {
    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      await redis.del(key);
    }
  } catch (err) {
    console.warn(`Redis cache invalidation failed for ${pattern}:`, err.message);
  }
}

async function incrementSessionLiveCounter(eventId, sessionId, result) {
  const redis = getRedisClient();
  if (!redis) return;

  const statsKey = `event:${eventId}:session:${sessionId}:stats`;
  const presentUsersKey = `event:${eventId}:session:${sessionId}:present_users_count`;

  try {
    await redis.hIncrBy(statsKey, result, 1);
    await redis.hIncrBy(statsKey, "total", 1);
    await redis.expire(statsKey, COUNTER_TTL_SECONDS);

    if (result === "accepted") {
      await redis.incr(presentUsersKey);
      await redis.expire(presentUsersKey, COUNTER_TTL_SECONDS);
    }

  } catch (err) {
    console.warn(`Redis live counter update failed for ${statsKey}:`, err.message);
  }
}

async function incrementHourlyCounter(redisKey, incrementBy = 1) {
  const redis = getRedisClient();
  if (!redis) return;

  const now = Date.now();
  const hourBucketEpochSec = Math.floor(now / (60 * 60 * 1000)) * 60 * 60;

  await redis.zIncrBy(redisKey, incrementBy, String(hourBucketEpochSec));
  await redis.expire(redisKey, VIEWS_SERIES_TTL_SECONDS);
}

async function appendTimelineEvent(redisKey, payload = {}) {
  const redis = getRedisClient();
  if (!redis) return;

  const ts = Date.now();
  const member = `${ts}:${crypto.randomUUID()}`;

  await redis.zAdd(redisKey, [{ score: ts, value: JSON.stringify({ ts, ...payload, member }) }]);
  await redis.expire(redisKey, TIMELINE_TTL_SECONDS);
}

async function appendRecentCheckin({ eventId, sessionId, payload }) {
  const redis = getRedisClient();
  if (!redis) return;

  const key = `event:${eventId}:session:${sessionId}:recent_checkins:${RECENT_CHECKINS_MAX_LIMIT}`;

  await redis.lPush(key, JSON.stringify(payload));
  await redis.lTrim(key, 0, RECENT_CHECKINS_MAX_LIMIT - 1);
  await redis.expire(key, COUNTER_TTL_SECONDS);
}

async function decrementCachedCounter(key) {
  const redis = getRedisClient();
  if (!redis) return;

  try {
    await redis.set(key, "0", { EX: COUNTER_TTL_SECONDS, NX: true });
    const nextValue = await redis.decr(key);
    if (Number(nextValue) < 0) {
      await redis.set(key, "0", { EX: COUNTER_TTL_SECONDS });
    } else {
      await redis.expire(key, COUNTER_TTL_SECONDS);
    }
  } catch (err) {
    console.warn(`Redis counter decrement failed for ${key}:`, err.message);
  }
}

async function trackEventView(eventId) {
  const redis = getRedisClient();
  if (!redis) return { tracked: false, reason: "Redis no está listo." };

  const normalizedEventId = Number(eventId);

  await appendTimelineEvent(`event:${normalizedEventId}:views:timeline`, { type: "view" });

  return { tracked: true };
}

async function getTimelineFromRedis({ eventId, type, from, to, limit }) {
  const redis = getRedisClient();
  if (!redis) {
    throw createHttpError(503, "Redis no está listo.");
  }

  const timelineKeys = {
    views: `event:${eventId}:views:timeline`,
    inscriptions: `event:${eventId}:inscriptions:timeline`,
    checkins: `event:${eventId}:checkins:timeline`,
  };

  const redisKey = timelineKeys[type];
  if (!redisKey) {
    throw createHttpError(400, "type inválido. Usa: views, inscriptions, checkins.");
  }

  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();

  const rows = await redis.zRangeByScore(redisKey, fromMs, toMs, {
    LIMIT: { offset: 0, count: limit },
  });

  return rows
    .map((row) => {
      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function buildEventConditions({ q, status, category, startsFrom, startsTo, forcePublished }) {
  const conditions = [];
  const params = [];

  if (forcePublished) {
    const idx = params.length + 1;
    conditions.push(`e.status = $${idx}::event_status`);
    params.push("published");
  } else if (status) {
    const idx = params.length + 1;
    conditions.push(`e.status = $${idx}::event_status`);
    params.push(status);
  }

  if (q) {
    const idx = params.length + 1;
    conditions.push(
      `(e.title ILIKE $${idx}
        OR COALESCE(e.description, '') ILIKE $${idx}
        OR COALESCE(e.category, '') ILIKE $${idx})`,
    );
    params.push(`%${q}%`);
  }

  if (category) {
    const idx = params.length + 1;
    conditions.push(`LOWER(e.category) = LOWER($${idx})`);
    params.push(category);
  }

  if (startsFrom) {
    const idx = params.length + 1;
    conditions.push(`e.starts_at >= $${idx}`);
    params.push(startsFrom);
  }

  if (startsTo) {
    const idx = params.length + 1;
    conditions.push(`e.starts_at <= $${idx}`);
    params.push(startsTo);
  }

  return { conditions, params };
}

function buildEventWhereSql(conditions, startIndex = 2) {
  if (!conditions.length) return "";

  return conditions
    .map((condition) =>
      condition.replace(/\$(\d+)/g, (_match, group) => `$${Number(group) + (startIndex - 1)}`),
    )
    .join(" AND ");
}

async function listEvents({
  res,
  q,
  status,
  category,
  startsFrom,
  startsTo,
  forcePublished,
  includeStaff = false,
}) {
  const page = Math.max(1, Number(res.req.query?.page || 1));
  const pageSize = Math.min(
    EVENT_LIST_PAGE_SIZE_MAX,
    Math.max(1, Number(res.req.query?.pageSize || EVENT_LIST_PAGE_SIZE_DEFAULT)),
  );

  const { conditions, params } = buildEventConditions({
    q,
    status,
    category,
    startsFrom,
    startsTo,
    forcePublished,
  });

  const shiftedConditionsSql = buildEventWhereSql(conditions, 2);
  const whereSql = shiftedConditionsSql
    ? `WHERE e.org_id = $1 AND ${shiftedConditionsSql}`
    : "WHERE e.org_id = $1";

  const offset = (page - 1) * pageSize;

  const countResult = await query(
    `SELECT COUNT(*)::int AS total
     FROM events e
     ${whereSql}`,
    [DEFAULT_ORG_ID, ...params],
  );

  const total = countResult.rows?.[0]?.total ?? 0;

  const listParams = [DEFAULT_ORG_ID, ...params, pageSize, offset];
  const limitIdx = listParams.length - 1;
  const offsetIdx = listParams.length;

  const staffJoinSql = includeStaff
    ? `LEFT JOIN users su
         ON su.id = (
           CASE
             WHEN e.attributes ? 'staff_user_id'
              AND (e.attributes->>'staff_user_id') ~ '^[0-9]+$'
               THEN (e.attributes->>'staff_user_id')::bigint
             ELSE NULL
           END
         )`
    : "";

  const staffSelectSql = includeStaff
    ? `,
       su.id AS staff_user_id,
       su.email AS staff_user_email`
    : "";

  const staffGroupSql = includeStaff ? ", su.id" : "";

  const listResult = await query(
    `SELECT
       e.id,
       e.org_id,
       e.title,
       e.description,
       e.category,
       e.location,
       e.organizer,
       e.starts_at,
       e.ends_at,
       e.hours_value,
       e.cover_image_url,
       e.capacity,
       e.capacity_enabled,
       e.status,
       e.registration_mode,
       e.resubmission_policy,
       e.allow_self_checkin,
       e.geo_enforced,
       e.cancel_policy,
       e.cancel_deadline,
       e.attributes,
       e.created_by,
       e.created_at,
       eg.center_lat,
       eg.center_lng,
       eg.radius_m,
       eg.strict_accuracy_m,
       COUNT(DISTINCT es.id)::int AS sessions_count,
       COUNT(DISTINCT r.id)::int AS registrations_count${staffSelectSql}
     FROM events e
     LEFT JOIN event_geo eg ON eg.event_id = e.id
     LEFT JOIN event_sessions es ON es.event_id = e.id
     LEFT JOIN registrations r ON r.event_id = e.id
     ${staffJoinSql}
     ${whereSql}
     GROUP BY e.id, eg.event_id${staffGroupSql}
     ORDER BY e.starts_at DESC
     LIMIT $${limitIdx}
     OFFSET $${offsetIdx}`,
    listParams,
  );

  return {
    events: listResult.rows.map((row) => {
      const mapped = mapEventForResponse(row);
      if (includeStaff) {
        mapped.staff_user =
          row.staff_user_id === null || row.staff_user_id === undefined
            ? null
            : {
                id: row.staff_user_id,
                email: row.staff_user_email ?? null,
              };
      }
      return mapped;
    }),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

router.get("/api/events", requireAuth, async (req, res) => {
  const q = String(req.query?.q || "").trim();
  const status = req.query?.status ? String(req.query.status).trim() : undefined;
  const category = req.query?.category ? String(req.query.category).trim() : undefined;
  const startsFrom = req.query?.starts_from ? parseIsoDateOrNull(req.query.starts_from) : null;
  const startsTo = req.query?.starts_to ? parseIsoDateOrNull(req.query.starts_to) : null;

  if (status && !EVENT_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, message: "status inválido." });
  }

  if (req.query?.starts_from && !startsFrom) {
    return res.status(400).json({ ok: false, message: "starts_from inválido." });
  }
  if (req.query?.starts_to && !startsTo) {
    return res.status(400).json({ ok: false, message: "starts_to inválido." });
  }

  try {
    const result = await listEvents({
      res,
      q,
      status,
      category,
      startsFrom,
      startsTo,
      forcePublished: true,
      includeStaff: false,
    });

    return res.status(200).json({
      ok: true,
      message: "Eventos publicados obtenidos correctamente.",
      events: result.events,
      pagination: result.pagination,
    });
  } catch (err) {
    console.error("Error en GET /api/events:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar los eventos.",
    });
  }
});

router.post("/api/events/:eventId/view", requireAuth, async (req, res) => {
  const eventId = Number(req.params.eventId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  try {
    const tracked = await trackEventView(eventId);

    return res.status(200).json({
      ok: true,
      event_id: eventId,
      tracked: tracked.tracked,
      message: tracked.tracked
        ? "Visualización registrada correctamente."
        : "Visualización no registrada en Redis.",
    });
  } catch (err) {
    console.error("Error en POST /api/events/:eventId/view:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo registrar la visualización del evento.",
    });
  }
});

router.post("/api/events/:eventId/register", requireAuth, async (req, res) => {
  const eventId = Number(req.params.eventId);
  const userId = req.auth?.userId;
  const role = req.auth?.role;

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  if (role !== ROLES.VISITOR && role !== ROLES.STUDENT) {
    return res.status(403).json({ ok: false, message: "No autorizado para registrarse." });
  }

  const payloadInput = req.body?.payload;
  const payload = payloadInput === undefined ? {} : payloadInput;

  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return res.status(400).json({ ok: false, message: "payload debe ser un objeto JSON." });
  }

  try {
    const created = await withTransaction(async (tx) => {
      const eventResult = await tx.query(
        `SELECT id, org_id, status, registration_mode, ends_at, capacity, capacity_enabled
         FROM events
         WHERE id = $1 AND org_id = $2
         LIMIT 1`,
        [eventId, DEFAULT_ORG_ID],
      );

      const event = eventResult.rows?.[0];
      if (!event) {
        throw createHttpError(404, "Evento no encontrado.");
      }
      if (String(event.status) !== "published") {
        throw createHttpError(400, "El evento no está publicado.");
      }

      const endsAt = new Date(event.ends_at);
      if (Number.isNaN(endsAt.getTime()) || new Date() >= endsAt) {
        throw createHttpError(400, "El evento ya no acepta registros.");
      }

      const duplicateResult = await tx.query(
        `SELECT id, status::text AS status, blocked_until
         FROM registrations
         WHERE event_id = $1 AND user_id = $2
         LIMIT 1`,
        [eventId, userId],
      );

      const existingRegistration = duplicateResult.rows?.[0] ?? null;

      const isAuto = String(event.registration_mode) === "auto";
      const registrationStatus = isAuto ? "approved" : "pending";

      const ensureCapacityAvailable = async () => {
        if (!Boolean(event.capacity_enabled)) return;

        const eventCapacity = Number(event.capacity);
        if (!Number.isInteger(eventCapacity) || eventCapacity <= 0) {
          throw createHttpError(400, "El evento tiene configuración de cupo inválida.");
        }

        const occupiedResult = await tx.query(
          `SELECT COUNT(*)::int AS total
           FROM registrations
           WHERE event_id = $1
             AND status::text = ANY($2::text[])`,
          [eventId, ["approved", "pending", "changes_requested", "cancel_pending"]],
        );

        const occupied = Number(occupiedResult.rows?.[0]?.total ?? 0);
        if (occupied >= eventCapacity) {
          throw createHttpError(409, "El evento alcanzó el cupo máximo.");
        }
      };

      let registration = null;
      let previousStatus = null;
      let registrationCountDelta = 0;

      if (!existingRegistration) {
        await ensureCapacityAvailable();

        const registrationResult = await tx.query(
          `INSERT INTO registrations (event_id, user_id, status, payload)
           VALUES ($1, $2, $3::registration_status, $4::jsonb)
           RETURNING *`,
          [eventId, userId, registrationStatus, JSON.stringify(payload)],
        );

        registration = registrationResult.rows[0];
        registrationCountDelta = 1;
      } else {
        previousStatus = String(existingRegistration.status || "");
        const blockedUntil = existingRegistration.blocked_until
          ? new Date(existingRegistration.blocked_until)
          : null;
        const isBlockedByDate =
          blockedUntil && !Number.isNaN(blockedUntil.getTime()) && blockedUntil > new Date();

        if (previousStatus === "blocked" || isBlockedByDate) {
          throw createHttpError(409, "Tu registro está bloqueado y no permite reinscripción.");
        }

        const canReRegister =
          previousStatus === "cancelled_by_user" || previousStatus === "cancelled_by_admin";

        if (!canReRegister) {
          throw createHttpError(409, "Ya existe un registro para este evento.");
        }

        await ensureCapacityAvailable();

        const reactivatedResult = await tx.query(
          `UPDATE registrations
           SET status = $1::registration_status,
               payload = $2::jsonb,
               submitted_at = now(),
               reviewed_at = NULL,
               reviewed_by = NULL,
               decision_reason = NULL,
               blocked_until = NULL
           WHERE id = $3
           RETURNING *`,
          [registrationStatus, JSON.stringify(payload), existingRegistration.id],
        );

        registration = reactivatedResult.rows[0];
        registrationCountDelta = 1;
      }

      let ticket = null;

      if (isAuto) {
        let issued = false;

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const ticketCode = generateTicketCode();

          try {
            const existingTicketResult = await tx.query(
              `UPDATE tickets
               SET registration_id = $1,
                   ticket_code = $2,
                   status = 'active'::ticket_status,
                   revoked_at = NULL,
                   issued_at = now()
               WHERE event_id = $3 AND user_id = $4
               RETURNING *`,
              [registration.id, ticketCode, eventId, userId],
            );

            if (existingTicketResult.rows?.[0]) {
              ticket = existingTicketResult.rows[0];
              issued = true;
              break;
            }

            const ticketInsertResult = await tx.query(
              `INSERT INTO tickets (event_id, user_id, registration_id, ticket_code, status)
               VALUES ($1, $2, $3, $4, 'active'::ticket_status)
               RETURNING *`,
              [eventId, userId, registration.id, ticketCode],
            );

            ticket = ticketInsertResult.rows[0];
            issued = true;
            break;
          } catch (ticketErr) {
            if (
              ticketErr?.code === "23505" &&
              (ticketErr?.constraint === "tickets_ticket_code_key" ||
                String(ticketErr?.detail || "").includes("ticket_code"))
            ) {
              continue;
            }
            throw ticketErr;
          }
        }

        if (!issued) {
          throw createHttpError(500, "No se pudo generar un ticket único.");
        }
      } else {
        await tx.query(
          `UPDATE tickets
           SET status = 'cancelled'::ticket_status,
               revoked_at = now(),
               registration_id = $1
           WHERE event_id = $2
             AND user_id = $3
             AND status = 'active'::ticket_status`,
          [registration.id, eventId, userId],
        );
      }

      const approvedDelta =
        (registrationStatus === "approved" ? 1 : 0) - (previousStatus === "approved" ? 1 : 0);
      const pendingDelta =
        (registrationStatus === "pending" ? 1 : 0) - (previousStatus === "pending" ? 1 : 0);

      return {
        eventId,
        registration,
        ticket,
        approved: registrationStatus === "approved",
        isReactivation: Boolean(existingRegistration),
        previousStatus,
        registrationCountDelta,
        approvedDelta,
        pendingDelta,
      };
    });

    if (created.registrationCountDelta > 0) {
      await incrementCachedCounter({
        key: `event:${created.eventId}:registrations_count`,
        countSql: `SELECT COUNT(*)::int AS total FROM registrations WHERE event_id = $1`,
        countParams: [created.eventId],
      });
    }

    await appendTimelineEvent(`event:${created.eventId}:inscriptions:timeline`, {
      type: "registration",
      event_type:
        created.registration?.status === "pending"
          ? EVENT_TYPE_CATALOG.inscription_request
          : EVENT_TYPE_CATALOG.inscription,
      registration_status: created.registration?.status || null,
      user_id: created.registration?.user_id || null,
      registration_id: created.registration?.id || null,
      reactivated: Boolean(created.isReactivation),
    });

    if (created.approvedDelta > 0) {
      await incrementCachedCounter({
        key: `event:${created.eventId}:approved_count`,
        countSql: `SELECT COUNT(*)::int AS total
                   FROM registrations
                   WHERE event_id = $1 AND status = 'approved'::registration_status`,
        countParams: [created.eventId],
      });
    } else if (created.approvedDelta < 0) {
      await decrementCachedCounter(`event:${created.eventId}:approved_count`);
    }

    if (created.pendingDelta > 0) {
      await incrementCachedCounter({
        key: `event:${created.eventId}:pending_count`,
        countSql: `SELECT COUNT(*)::int AS total
                   FROM registrations
                   WHERE event_id = $1 AND status = 'pending'::registration_status`,
        countParams: [created.eventId],
      });
    } else if (created.pendingDelta < 0) {
      await decrementCachedCounter(`event:${created.eventId}:pending_count`);
    }

    return res.status(created.isReactivation ? 200 : 201).json({
      ok: true,
      message: created.isReactivation
        ? "Reinscripción realizada correctamente."
        : "Registro creado correctamente.",
      registration: created.registration,
      ticket: created.ticket,
      reactivated: Boolean(created.isReactivation),
    });
  } catch (err) {
    if (err?.statusCode === 403) {
      return res.status(403).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 404) {
      return res.status(404).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 409) {
      return res.status(409).json({ ok: false, message: err.message });
    }
    if (err?.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Ya existe un registro para este evento.",
      });
    }

    console.error("Error en POST /api/events/:eventId/register:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo completar el registro al evento.",
    });
  }
});

router.post("/api/events/:eventId/unregister", requireAuth, async (req, res) => {
  const eventId = Number(req.params.eventId);
  const userId = req.auth?.userId;
  const reason =
    req.body?.reason === undefined || req.body?.reason === null
      ? null
      : String(req.body.reason).trim() || null;

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  try {
    const result = await withTransaction(async (tx) => {
      const eventResult = await tx.query(
        `SELECT id, org_id, cancel_policy, cancel_deadline
         FROM events
         WHERE id = $1 AND org_id = $2
         LIMIT 1`,
        [eventId, DEFAULT_ORG_ID],
      );

      const event = eventResult.rows?.[0];
      if (!event) {
        throw createHttpError(404, "Evento no encontrado.");
      }

      const registrationResult = await tx.query(
        `SELECT id, status::text AS status, payload
         FROM registrations
         WHERE event_id = $1 AND user_id = $2
         LIMIT 1`,
        [eventId, userId],
      );

      const registration = registrationResult.rows?.[0];
      if (!registration) {
        throw createHttpError(404, "No existe inscripción para este evento.");
      }

      if (
        registration.status === "cancelled_by_user" ||
        registration.status === "cancelled_by_admin"
      ) {
        throw createHttpError(409, "La inscripción ya se encuentra cancelada.");
      }

      if (registration.status === "cancel_pending") {
        throw createHttpError(409, "Ya existe una solicitud de baja pendiente de validación.");
      }

      const now = new Date();
      const cancelDeadline = event.cancel_deadline ? new Date(event.cancel_deadline) : null;
      const afterDeadline = cancelDeadline ? now > cancelDeadline : false;

      const requiresOrganizerValidation =
        registration.status === "approved" &&
        (String(event.cancel_policy) === "locked" ||
          (String(event.cancel_policy) === "penalize_no_show" && afterDeadline));

      if (requiresOrganizerValidation) {
        const payloadBase =
          registration.payload && typeof registration.payload === "object"
            ? registration.payload
            : {};

        const existingRequest = payloadBase?.cancel_request;
        if (existingRequest?.status === "pending") {
          throw createHttpError(409, "Ya existe una solicitud de baja pendiente de validación.");
        }

        const nextPayload = {
          ...payloadBase,
          cancel_request: {
            status: "pending",
            requested_at: now.toISOString(),
            reason,
            policy: String(event.cancel_policy),
            previous_status: registration.status,
          },
        };

        const updated = await tx.query(
          `UPDATE registrations
           SET status = 'cancel_pending'::registration_status,
               payload = $1::jsonb
           WHERE id = $2
           RETURNING id, status::text AS status, payload, submitted_at`,
          [JSON.stringify(nextPayload), registration.id],
        );

        return {
          mode: "requested",
          registration: updated.rows[0],
          previousStatus: registration.status,
        };
      }

      const cancelled = await tx.query(
        `UPDATE registrations
         SET status = 'cancelled_by_user'::registration_status,
             reviewed_at = now(),
             reviewed_by = $1,
             decision_reason = $2
         WHERE id = $3
         RETURNING id, status::text AS status, payload, submitted_at`,
        [userId, reason, registration.id],
      );

      await tx.query(
        `UPDATE tickets
         SET status = 'cancelled'::ticket_status,
             revoked_at = now()
         WHERE registration_id = $1
           AND status = 'active'::ticket_status`,
        [registration.id],
      );

      return {
        mode: "cancelled",
        registration: cancelled.rows[0],
        previousStatus: registration.status,
      };
    });

    if (result.mode === "cancelled") {
      await decrementCachedCounter(`event:${eventId}:registrations_count`);

      if (result.previousStatus === "approved") {
        await decrementCachedCounter(`event:${eventId}:approved_count`);
      }
      if (result.previousStatus === "pending") {
        await decrementCachedCounter(`event:${eventId}:pending_count`);
      }

      await appendTimelineEvent(`event:${eventId}:inscriptions:timeline`, {
        type: "unregistration",
        event_type: EVENT_TYPE_CATALOG.unregistration,
        registration_status: "cancelled_by_user",
        user_id: userId,
        registration_id: result.registration?.id || null,
      });

      return res.status(200).json({
        ok: true,
        message: "Baja de evento realizada correctamente.",
        mode: result.mode,
        registration: result.registration,
      });
    }

    await appendTimelineEvent(`event:${eventId}:inscriptions:timeline`, {
      type: "unregistration_request",
      event_type: EVENT_TYPE_CATALOG.unregistration_request,
      registration_status: result.registration?.status || null,
      user_id: userId,
      registration_id: result.registration?.id || null,
    });

    if (result.previousStatus === "approved") {
      await decrementCachedCounter(`event:${eventId}:approved_count`);
    }
    if (result.previousStatus === "pending") {
      await decrementCachedCounter(`event:${eventId}:pending_count`);
    }

    return res.status(202).json({
      ok: true,
      message: "Solicitud de baja enviada. Requiere validación del organizador.",
      mode: result.mode,
      registration: result.registration,
    });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 401) {
      return res.status(401).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 404) {
      return res.status(404).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 409) {
      return res.status(409).json({ ok: false, message: err.message });
    }

    console.error("Error en POST /api/events/:eventId/unregister:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo procesar la baja del evento.",
    });
  }
});

router.get("/api/events/:eventId/registrations-count", requireAuth, async (req, res) => {
  const eventId = Number(req.params.eventId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  try {
    const eventResult = await query(
      `SELECT id
       FROM events
       WHERE id = $1 AND org_id = $2
       LIMIT 1`,
      [eventId, DEFAULT_ORG_ID],
    );

    if (!eventResult.rows?.[0]) {
      return res.status(404).json({ ok: false, message: "Evento no encontrado." });
    }

    const registrationsCount = await getEventRegistrationsCount(eventId);

    return res.status(200).json({
      ok: true,
      eventId,
      registrations_count: registrationsCount,
    });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, message: err.message });
    }

    console.error("Error en GET /api/events/:eventId/registrations-count:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo obtener el contador de inscritos.",
    });
  }
});

router.get("/api/events/:eventId/ticket", requireAuth, async (req, res) => {
  const eventId = Number(req.params.eventId);
  const userId = req.auth?.userId;

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  try {
    const registrationResult = await query(
      `SELECT
         r.id AS registration_id,
         r.status AS registration_status,
         r.submitted_at AS registration_submitted_at,
         e.id AS event_id,
         e.title,
         e.description,
         e.starts_at,
         e.ends_at,
         e.location,
         e.organizer,
         e.cover_image_url,
         t.id AS ticket_id,
         t.ticket_code,
         t.status AS ticket_status,
         t.issued_at,
         t.revoked_at
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN LATERAL (
         SELECT id, ticket_code, status, issued_at, revoked_at
         FROM tickets
         WHERE registration_id = r.id
         ORDER BY issued_at DESC NULLS LAST, id DESC
         LIMIT 1
       ) t ON TRUE
       WHERE r.event_id = $1
         AND r.user_id = $2
         AND e.org_id = $3
       LIMIT 1`,
      [eventId, userId, DEFAULT_ORG_ID],
    );

    const registration = registrationResult.rows?.[0];
    if (!registration) {
      return res.status(404).json({
        ok: false,
        message: "No existe inscripción para este evento y usuario.",
      });
    }

    const ticket =
      registration.ticket_id === null
        ? null
        : {
            id: registration.ticket_id,
            ticket_code: registration.ticket_code,
            status: registration.ticket_status,
            issued_at: registration.issued_at,
            revoked_at: registration.revoked_at,
          };

    return res.status(200).json({
      ok: true,
      registration: {
        id: registration.registration_id,
        status: registration.registration_status,
        submitted_at: registration.registration_submitted_at,
      },
      pending_approval: registration.registration_status === "pending",
      event: {
        id: registration.event_id,
        title: registration.title,
        description: registration.description,
        starts_at: registration.starts_at,
        ends_at: registration.ends_at,
        location: registration.location,
        organizer: registration.organizer,
        cover_image_url: registration.cover_image_url,
      },
      ticket,
    });
  } catch (err) {
    console.error("Error en GET /api/events/:eventId/ticket:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo consultar el ticket.",
    });
  }
});

router.get("/api/me/registrations", requireAuth, async (req, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.min(
    EVENT_LIST_PAGE_SIZE_MAX,
    Math.max(1, Number(req.query?.pageSize || EVENT_LIST_PAGE_SIZE_DEFAULT)),
  );
  const offset = (page - 1) * pageSize;

  try {
    const countResult = await query(
      `SELECT COUNT(*)::int AS total
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE r.user_id = $1
         AND e.org_id = $2`,
      [userId, DEFAULT_ORG_ID],
    );

    const total = Number(countResult.rows?.[0]?.total ?? 0);

    const listResult = await query(
      `SELECT
         r.id AS registration_id,
         r.status AS registration_status,
         r.submitted_at AS registration_submitted_at,
         e.id AS event_id,
         e.title,
         e.description,
         e.location,
         e.organizer,
         e.starts_at,
         e.ends_at,
         e.status AS event_status,
         e.cover_image_url,
         t.id AS ticket_id,
         t.ticket_code,
         t.status AS ticket_status,
         t.issued_at,
         t.revoked_at
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       LEFT JOIN LATERAL (
         SELECT id, ticket_code, status, issued_at, revoked_at
         FROM tickets
         WHERE registration_id = r.id
         ORDER BY issued_at DESC NULLS LAST, id DESC
         LIMIT 1
       ) t ON TRUE
       WHERE r.user_id = $1
         AND e.org_id = $2
       ORDER BY r.submitted_at DESC
       LIMIT $3
       OFFSET $4`,
      [userId, DEFAULT_ORG_ID, pageSize, offset],
    );

    const registrations = listResult.rows.map((row) => ({
      registration: {
        id: row.registration_id,
        status: row.registration_status,
        submitted_at: row.registration_submitted_at,
      },
      pending_approval: row.registration_status === "pending",
      event: {
        id: row.event_id,
        title: row.title,
        description: row.description,
        location: row.location,
        organizer: row.organizer,
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        status: row.event_status,
        cover_image_url: row.cover_image_url,
      },
      ticket:
        row.ticket_id === null
          ? null
          : {
              id: row.ticket_id,
              ticket_code: row.ticket_code,
              status: row.ticket_status,
              issued_at: row.issued_at,
              revoked_at: row.revoked_at,
            },
    }));

    return res.status(200).json({
      ok: true,
      registrations,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error("Error en GET /api/me/registrations:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar tus inscripciones.",
    });
  }
});

router.get("/api/me/hours/history", requireAuth, async (req, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.min(
    EVENT_LIST_PAGE_SIZE_MAX,
    Math.max(1, Number(req.query?.pageSize || EVENT_LIST_PAGE_SIZE_DEFAULT)),
  );
  const offset = (page - 1) * pageSize;

  try {
    const whereSql = `WHERE hl.user_id = $1
      AND (e.org_id = $2 OR e.id IS NULL)`;

    const countResult = await query(
      `SELECT COUNT(*)::int AS total
       FROM hours_ledger hl
       LEFT JOIN events e ON e.id = hl.event_id
       ${whereSql}`,
      [userId, DEFAULT_ORG_ID],
    );

    const totalHoursResult = await query(
      `SELECT COALESCE(SUM(hl.hours_delta), 0)::numeric(10,2) AS total_hours
       FROM hours_ledger hl
       LEFT JOIN events e ON e.id = hl.event_id
       ${whereSql}`,
      [userId, DEFAULT_ORG_ID],
    );

    const total = Number(countResult.rows?.[0]?.total ?? 0);
    const totalHours = Number(totalHoursResult.rows?.[0]?.total_hours ?? 0);

    const historyResult = await query(
      `SELECT
         hl.id,
         hl.created_at,
         hl.hours_delta,
         hl.reason::text AS reason,
         hl.note,
         e.id AS event_id,
         e.title,
         e.category,
         e.starts_at,
         e.ends_at,
         c.id AS checkin_id,
         c.scanned_at,
         c.result::text AS checkin_result
       FROM hours_ledger hl
       LEFT JOIN events e ON e.id = hl.event_id
       LEFT JOIN checkins c ON c.id = hl.source_checkin_id
       ${whereSql}
       ORDER BY hl.created_at DESC
       LIMIT $3
       OFFSET $4`,
      [userId, DEFAULT_ORG_ID, pageSize, offset],
    );

    const history = historyResult.rows.map((row) => ({
      id: row.id,
      created_at: row.created_at,
      hours_delta: Number(row.hours_delta),
      reason: row.reason,
      note: row.note,
      event:
        row.event_id === null
          ? null
          : {
              id: row.event_id,
              title: row.title,
              category: row.category,
              starts_at: row.starts_at,
              ends_at: row.ends_at,
            },
      checkin:
        row.checkin_id === null
          ? null
          : {
              id: row.checkin_id,
              scanned_at: row.scanned_at,
              result: row.checkin_result,
            },
    }));

    return res.status(200).json({
      ok: true,
      total_hours: totalHours,
      history,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error("Error en GET /api/me/hours/history:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo consultar el historial de horas.",
    });
  }
});

router.get("/api/admin/events", requireAuth, requireEventManager, async (req, res) => {
  const q = String(req.query?.q || "").trim();
  const status = req.query?.status ? String(req.query.status).trim() : undefined;
  const category = req.query?.category ? String(req.query.category).trim() : undefined;
  const startsFrom = req.query?.starts_from ? parseIsoDateOrNull(req.query.starts_from) : null;
  const startsTo = req.query?.starts_to ? parseIsoDateOrNull(req.query.starts_to) : null;

  if (status && !EVENT_STATUSES.has(status)) {
    return res.status(400).json({ ok: false, message: "status inválido." });
  }
  if (req.query?.starts_from && !startsFrom) {
    return res.status(400).json({ ok: false, message: "starts_from inválido." });
  }
  if (req.query?.starts_to && !startsTo) {
    return res.status(400).json({ ok: false, message: "starts_to inválido." });
  }

  try {
    const result = await listEvents({
      res,
      q,
      status,
      category,
      startsFrom,
      startsTo,
      forcePublished: false,
      includeStaff: true,
    });

    return res.status(200).json({
      ok: true,
      message: "Eventos de administración obtenidos correctamente.",
      events: result.events,
      pagination: result.pagination,
    });
  } catch (err) {
    console.error("Error en GET /api/admin/events:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar los eventos de administración.",
    });
  }
});

router.get("/api/admin/requests/pending", requireAuth, requireEventManager, async (req, res) => {
  const eventId = req.query?.event_id ? Number(req.query.event_id) : null;
  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize || 30)));
  const offset = (page - 1) * pageSize;

  if (req.query?.event_id && (!Number.isInteger(eventId) || eventId <= 0)) {
    return res.status(400).json({ ok: false, message: "event_id inválido." });
  }

  try {
    const params = [DEFAULT_ORG_ID];
    let whereExtra = "";

    if (eventId !== null) {
      params.push(eventId);
      whereExtra = ` AND r.event_id = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*)::int AS total
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       WHERE e.org_id = $1
         AND r.status IN ('pending'::registration_status, 'cancel_pending'::registration_status)
         ${whereExtra}`,
      params,
    );

    const total = Number(countResult.rows?.[0]?.total ?? 0);

    const listParams = [...params, pageSize, offset];
    const limitIdx = listParams.length - 1;
    const offsetIdx = listParams.length;

    const listResult = await query(
      `SELECT
         r.id AS registration_id,
         r.event_id,
         r.user_id,
         r.status::text AS status,
         r.submitted_at,
         r.payload,
         e.title AS event_title,
         e.starts_at AS event_starts_at,
         e.ends_at AS event_ends_at,
         u.email,
         u.first_name,
         u.last_name
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       JOIN users u ON u.id = r.user_id
       WHERE e.org_id = $1
         AND r.status IN ('pending'::registration_status, 'cancel_pending'::registration_status)
         ${whereExtra}
       ORDER BY r.submitted_at ASC
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      listParams,
    );

    const requests = listResult.rows.map((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      const cancelRequest = payload?.cancel_request && typeof payload.cancel_request === "object"
        ? payload.cancel_request
        : null;

      return {
        request_type: row.status === "cancel_pending" ? "cancellation" : "registration",
        registration_id: row.registration_id,
        status: row.status,
        submitted_at: row.submitted_at,
        event: {
          id: row.event_id,
          title: row.event_title,
          starts_at: row.event_starts_at,
          ends_at: row.event_ends_at,
        },
        user: {
          id: row.user_id,
          email: row.email,
          first_name: row.first_name,
          last_name: row.last_name,
        },
        request_detail:
          row.status === "cancel_pending"
            ? {
                requested_at: cancelRequest?.requested_at || row.submitted_at,
                reason: cancelRequest?.reason || null,
                policy: cancelRequest?.policy || null,
              }
            : null,
      };
    });

    return res.status(200).json({
      ok: true,
      requests,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error("Error en GET /api/admin/requests/pending:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar las solicitudes pendientes.",
    });
  }
});

router.post(
  "/api/admin/requests/:registrationId/approve",
  requireAuth,
  requireEventManager,
  async (req, res) => {
    const registrationId = Number(req.params.registrationId);
    const reviewerId = req.auth?.userId;
    const action = String(req.body?.action || "approve").trim().toLowerCase();
    const decisionReason =
      req.body?.reason === undefined || req.body?.reason === null
        ? null
        : String(req.body.reason).trim() || null;

    if (!Number.isInteger(registrationId) || registrationId <= 0) {
      return res.status(400).json({ ok: false, message: "registrationId inválido." });
    }
    if (!reviewerId) {
      return res.status(401).json({ ok: false, message: "Sesión inválida." });
    }
    if (action !== "approve" && action !== "deny") {
      return res.status(400).json({ ok: false, message: "action inválido. Usa: approve o deny." });
    }

    try {
      const reviewed = await withTransaction(async (tx) => {
        const registrationResult = await tx.query(
          `SELECT
             r.id,
             r.event_id,
             r.user_id,
             r.status::text AS status,
             r.payload
           FROM registrations r
           JOIN events e ON e.id = r.event_id
           WHERE r.id = $1
             AND e.org_id = $2
           LIMIT 1`,
          [registrationId, DEFAULT_ORG_ID],
        );

        const registration = registrationResult.rows?.[0];
        if (!registration) {
          throw createHttpError(404, "Solicitud no encontrada.");
        }

        if (registration.status !== "pending" && registration.status !== "cancel_pending") {
          throw createHttpError(409, "La solicitud ya no está pendiente de aprobación.");
        }

        if (registration.status === "pending") {
          if (action === "deny") {
            const deniedResult = await tx.query(
              `UPDATE registrations
               SET status = 'rejected'::registration_status,
                   reviewed_at = now(),
                   reviewed_by = $1,
                   decision_reason = $2
               WHERE id = $3
               RETURNING *`,
              [reviewerId, decisionReason, registrationId],
            );

            return {
              mode: "registration_denied",
              eventId: Number(registration.event_id),
              userId: Number(registration.user_id),
              registration: deniedResult.rows[0],
              ticket: null,
            };
          }

          const updatedResult = await tx.query(
            `UPDATE registrations
             SET status = 'approved'::registration_status,
                 reviewed_at = now(),
                 reviewed_by = $1,
                 decision_reason = $2
             WHERE id = $3
             RETURNING *`,
            [reviewerId, decisionReason, registrationId],
          );

          let ticket = null;
          let issued = false;

          for (let attempt = 0; attempt < 5; attempt += 1) {
            const ticketCode = generateTicketCode();

            try {
              const existingTicketResult = await tx.query(
                `UPDATE tickets
                 SET registration_id = $1,
                     ticket_code = $2,
                     status = 'active'::ticket_status,
                     revoked_at = NULL,
                     issued_at = now()
                 WHERE event_id = $3 AND user_id = $4
                 RETURNING *`,
                [registrationId, ticketCode, registration.event_id, registration.user_id],
              );

              if (existingTicketResult.rows?.[0]) {
                ticket = existingTicketResult.rows[0];
                issued = true;
                break;
              }

              const ticketInsertResult = await tx.query(
                `INSERT INTO tickets (event_id, user_id, registration_id, ticket_code, status)
                 VALUES ($1, $2, $3, $4, 'active'::ticket_status)
                 RETURNING *`,
                [registration.event_id, registration.user_id, registrationId, ticketCode],
              );

              ticket = ticketInsertResult.rows[0];
              issued = true;
              break;
            } catch (ticketErr) {
              if (
                ticketErr?.code === "23505" &&
                (ticketErr?.constraint === "tickets_ticket_code_key" ||
                  String(ticketErr?.detail || "").includes("ticket_code"))
              ) {
                continue;
              }
              throw ticketErr;
            }
          }

          if (!issued) {
            throw createHttpError(500, "No se pudo generar un ticket único.");
          }

          return {
            mode: "registration_approved",
            eventId: Number(registration.event_id),
            userId: Number(registration.user_id),
            registration: updatedResult.rows[0],
            ticket,
          };
        }

        if (action === "deny") {
          const payloadBase =
            registration.payload && typeof registration.payload === "object"
              ? registration.payload
              : {};

          const cancelRequestBase =
            payloadBase.cancel_request && typeof payloadBase.cancel_request === "object"
              ? payloadBase.cancel_request
              : {};

          const previousStatusRaw = String(cancelRequestBase.previous_status || "").trim();
          const fallbackStatus = "pending";
          const restoredStatus =
            previousStatusRaw === "approved" || previousStatusRaw === "pending"
              ? previousStatusRaw
              : fallbackStatus;

          const nextPayload = {
            ...payloadBase,
            cancel_request: {
              ...cancelRequestBase,
              status: "denied",
              reviewed_at: new Date().toISOString(),
              reviewed_by: reviewerId,
            },
          };

          const deniedCancelResult = await tx.query(
            `UPDATE registrations
             SET status = $1::registration_status,
                 reviewed_at = now(),
                 reviewed_by = $2,
                 decision_reason = $3,
                 payload = $4::jsonb
             WHERE id = $5
             RETURNING *`,
            [restoredStatus, reviewerId, decisionReason, JSON.stringify(nextPayload), registrationId],
          );

          return {
            mode: "cancellation_denied",
            eventId: Number(registration.event_id),
            userId: Number(registration.user_id),
            restoredStatus,
            registration: deniedCancelResult.rows[0],
            ticket: null,
          };
        }

        const payloadBase =
          registration.payload && typeof registration.payload === "object"
            ? registration.payload
            : {};
        const nextPayload = {
          ...payloadBase,
          cancel_request: {
            ...(payloadBase.cancel_request && typeof payloadBase.cancel_request === "object"
              ? payloadBase.cancel_request
              : {}),
            status: "approved",
            reviewed_at: new Date().toISOString(),
            reviewed_by: reviewerId,
          },
        };

        const updatedResult = await tx.query(
          `UPDATE registrations
           SET status = 'cancelled_by_admin'::registration_status,
               reviewed_at = now(),
               reviewed_by = $1,
               decision_reason = $2,
               payload = $3::jsonb
           WHERE id = $4
           RETURNING *`,
          [reviewerId, decisionReason, JSON.stringify(nextPayload), registrationId],
        );

        await tx.query(
          `UPDATE tickets
           SET status = 'cancelled'::ticket_status,
               revoked_at = now()
           WHERE registration_id = $1
             AND status = 'active'::ticket_status`,
          [registrationId],
        );

        return {
          mode: "cancellation_approved",
          eventId: Number(registration.event_id),
          userId: Number(registration.user_id),
          registration: updatedResult.rows[0],
          ticket: null,
        };
      });

      if (reviewed.mode === "registration_approved") {
        await incrementCachedCounter({
          key: `event:${reviewed.eventId}:approved_count`,
          countSql: `SELECT COUNT(*)::int AS total
                     FROM registrations
                     WHERE event_id = $1 AND status = 'approved'::registration_status`,
          countParams: [reviewed.eventId],
        });
        await decrementCachedCounter(`event:${reviewed.eventId}:pending_count`);

        await appendTimelineEvent(`event:${reviewed.eventId}:inscriptions:timeline`, {
          type: "registration",
          event_type: EVENT_TYPE_CATALOG.inscription,
          registration_status: reviewed.registration?.status || null,
          user_id: reviewed.userId,
          registration_id: reviewed.registration?.id || null,
          reviewed_by: reviewerId,
        });
      } else if (reviewed.mode === "registration_denied") {
        await decrementCachedCounter(`event:${reviewed.eventId}:pending_count`);

        await appendTimelineEvent(`event:${reviewed.eventId}:inscriptions:timeline`, {
          type: "registration",
          event_type: EVENT_TYPE_CATALOG.inscription_request,
          registration_status: reviewed.registration?.status || null,
          user_id: reviewed.userId,
          registration_id: reviewed.registration?.id || null,
          reviewed_by: reviewerId,
          review_action: "deny",
        });
      } else if (reviewed.mode === "cancellation_approved") {
        await decrementCachedCounter(`event:${reviewed.eventId}:registrations_count`);

        await appendTimelineEvent(`event:${reviewed.eventId}:inscriptions:timeline`, {
          type: "unregistration",
          event_type: EVENT_TYPE_CATALOG.unregistration,
          registration_status: reviewed.registration?.status || null,
          user_id: reviewed.userId,
          registration_id: reviewed.registration?.id || null,
          reviewed_by: reviewerId,
        });
      } else if (reviewed.mode === "cancellation_denied") {
        if (reviewed.restoredStatus === "approved") {
          await incrementCachedCounter({
            key: `event:${reviewed.eventId}:approved_count`,
            countSql: `SELECT COUNT(*)::int AS total
                       FROM registrations
                       WHERE event_id = $1 AND status = 'approved'::registration_status`,
            countParams: [reviewed.eventId],
          });
        } else if (reviewed.restoredStatus === "pending") {
          await incrementCachedCounter({
            key: `event:${reviewed.eventId}:pending_count`,
            countSql: `SELECT COUNT(*)::int AS total
                       FROM registrations
                       WHERE event_id = $1 AND status = 'pending'::registration_status`,
            countParams: [reviewed.eventId],
          });
        }

        await appendTimelineEvent(`event:${reviewed.eventId}:inscriptions:timeline`, {
          type: "unregistration_request",
          event_type: EVENT_TYPE_CATALOG.unregistration_request,
          registration_status: reviewed.registration?.status || null,
          user_id: reviewed.userId,
          registration_id: reviewed.registration?.id || null,
          reviewed_by: reviewerId,
          review_action: "deny",
        });
      }

      return res.status(200).json({
        ok: true,
        message:
          reviewed.mode === "registration_approved"
            ? "Solicitud de inscripción aprobada correctamente."
            : reviewed.mode === "registration_denied"
              ? "Solicitud de inscripción denegada correctamente."
              : reviewed.mode === "cancellation_approved"
                ? "Solicitud de baja aprobada correctamente."
                : "Solicitud de baja denegada correctamente.",
        mode: reviewed.mode,
        registration: reviewed.registration,
        ticket: reviewed.ticket,
      });
    } catch (err) {
      if (err?.statusCode === 404) {
        return res.status(404).json({ ok: false, message: err.message });
      }
      if (err?.statusCode === 409) {
        return res.status(409).json({ ok: false, message: err.message });
      }

      console.error("Error en POST /api/admin/requests/:registrationId/approve:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo aprobar la solicitud.",
      });
    }
  },
);

router.get(
  "/api/admin/events/:eventId/timeline",
  requireAuth,
  requireEventManager,
  async (req, res) => {
    const eventId = Number(req.params.eventId);
    const type = String(req.query?.type || "checkins").trim().toLowerCase();
    const from = req.query?.from
      ? new Date(String(req.query.from))
      : new Date(Date.now() - TIMESERIES_DEFAULT_WINDOW_HOURS * 60 * 60 * 1000);
    const to = req.query?.to ? new Date(String(req.query.to)) : new Date();
    const limit = Math.min(2000, Math.max(1, Number(req.query?.limit || 500)));

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ ok: false, message: "eventId inválido." });
    }
    if (Number.isNaN(from.getTime())) {
      return res.status(400).json({ ok: false, message: "from inválido. Debe ser ISO date-time." });
    }
    if (Number.isNaN(to.getTime())) {
      return res.status(400).json({ ok: false, message: "to inválido. Debe ser ISO date-time." });
    }
    if (from > to) {
      return res.status(400).json({ ok: false, message: "from no puede ser mayor que to." });
    }

    try {
      const timeline = await getTimelineFromRedis({
        eventId,
        type,
        from: from.toISOString(),
        to: to.toISOString(),
        limit,
      });

      return res.status(200).json({
        ok: true,
        event_id: eventId,
        type,
        from: from.toISOString(),
        to: to.toISOString(),
        limit,
        event_type_catalog: EVENT_TYPE_CATALOG,
        timeline,
      });
    } catch (err) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ ok: false, message: err.message });
      }
      if (err?.statusCode === 503) {
        return res.status(503).json({ ok: false, message: err.message });
      }

      console.error("Error en GET /api/admin/events/:eventId/timeline:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo obtener el timeline del evento.",
      });
    }
  },
);

router.get(
  "/api/admin/events/:eventId/dashboard",
  requireAuth,
  requireEventManager,
  async (req, res) => {
    const eventId = Number(req.params.eventId);
    const sessionId = req.query?.sessionId ? Number(req.query.sessionId) : null;
    const recentLimit = req.query?.recentLimit
      ? Number(req.query.recentLimit)
      : RECENT_CHECKINS_DEFAULT_LIMIT;

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ ok: false, message: "eventId inválido." });
    }

    if (req.query?.sessionId && (!Number.isInteger(sessionId) || sessionId <= 0)) {
      return res.status(400).json({ ok: false, message: "sessionId inválido." });
    }

    try {
      const eventResult = await query(
        `SELECT id, title, starts_at, ends_at, status, registration_mode, capacity, capacity_enabled,
          cover_image_url
         FROM events
         WHERE id = $1 AND org_id = $2
         LIMIT 1`,
        [eventId, DEFAULT_ORG_ID],
      );

      const event = eventResult.rows?.[0];
      if (!event) {
        return res.status(404).json({ ok: false, message: "Evento no encontrado." });
      }

      const registrationStats = await getEventRegistrationStats(eventId);
      const activitySeries = await getEventActivitySeries({
        eventId,
      });
      const recentActivityStack = await getRecentActivityStack({
        eventId,
        limit: 30,
      });

      const sessionsResult = await query(
        `SELECT id, starts_at, ends_at, label, hours_value
         FROM event_sessions
         WHERE event_id = $1
         ORDER BY starts_at ASC`,
        [eventId],
      );

      const sessions = sessionsResult.rows;

      let selectedSession = null;
      if (sessionId !== null) {
        selectedSession = sessions.find((s) => Number(s.id) === sessionId) || null;
        if (!selectedSession) {
          return res.status(404).json({ ok: false, message: "Sesión no encontrada." });
        }
      } else if (sessions.length > 0) {
        selectedSession = sessions[0];
      }

      let live = null;
      if (selectedSession) {
        const stats = await getSessionLiveStats(eventId, selectedSession.id);
        const recent = await getRecentSessionCheckins(eventId, selectedSession.id, recentLimit);

        live = {
          session: selectedSession,
          stats,
          recent_checkins: recent,
        };
      }

      return res.status(200).json({
        ok: true,
        event: mapEventForResponse(event),
        event_type_catalog: EVENT_TYPE_CATALOG,
        registration_stats: {
          registrations_count: registrationStats.total,
          approved_count: registrationStats.approved,
          pending_count: registrationStats.pending,
        },
        activity_series: activitySeries,
        recent_activity_stack: recentActivityStack,
        sessions,
        live,
      });
    } catch (err) {
      if (err?.statusCode === 400) {
        return res.status(400).json({ ok: false, message: err.message });
      }

      console.error("Error en GET /api/admin/events/:eventId/dashboard:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo obtener el dashboard del evento.",
      });
    }
  },
);

router.post(
  "/api/admin/events/checkins/scan",
  requireAuth,
  requireEventManager,
  async (req, res) => {
    //imprimir el body para debuggear
    console.log("Scan check-in request body:", req.body);
    const ticketCode = String(req.body?.ticket_code ?? req.body?.ticketCode ?? "").trim();
    const scannerAdminIdRaw = req.auth?.userId;
    const staffUserIdInput =
      req.body?.staff_user_id ?? req.body?.staffUserId ?? req.body?.staff_user;
    const staffUserId =
      staffUserIdInput === undefined || staffUserIdInput === null || String(staffUserIdInput).trim() === ""
        ? null
        : Number(staffUserIdInput);

    const clientLatRaw = req.body?.client_lat ?? req.body?.lat;
    const clientLngRaw = req.body?.client_lng ?? req.body?.lng;
    const accuracyRaw = req.body?.accuracy_m ?? req.body?.accuracy;

    const clientLat =
      clientLatRaw === undefined || clientLatRaw === null ? null : Number(clientLatRaw);
    const clientLng =
      clientLngRaw === undefined || clientLngRaw === null ? null : Number(clientLngRaw);
    const accuracyM =
      accuracyRaw === undefined || accuracyRaw === null ? null : Number(accuracyRaw);

    if (!ticketCode) {
      return res.status(400).json({ ok: false, message: "ticket_code es requerido." });
    }
    if (scannerAdminIdRaw === undefined || scannerAdminIdRaw === null) {
      return res.status(401).json({ ok: false, message: "Sesión inválida." });
    }
    const scannerAdminId = Number(scannerAdminIdRaw);
    if (!Number.isInteger(scannerAdminId) || scannerAdminId <= 0) {
      return res.status(401).json({ ok: false, message: "Sesión inválida." });
    }
    if (staffUserId === null) {
      return res.status(400).json({ ok: false, message: "staff_user_id es requerido." });
    }
    if (!Number.isInteger(staffUserId) || staffUserId <= 0) {
      return res.status(400).json({ ok: false, message: "staff_user_id inválido." });
    }
    if (req.auth?.role === ROLES.STAFF && staffUserId !== scannerAdminId) {
      return res.status(403).json({
        ok: false,
        message: "El staff_user_id debe coincidir con el usuario autenticado.",
      });
    }

    try {
      const scan = await withTransaction(async (tx) => {
        const ticketResult = await tx.query(
          `SELECT id, event_id, user_id, status::text AS status
           FROM tickets
           WHERE ticket_code = $1
           LIMIT 1`,
          [ticketCode],
        );

        const ticket = ticketResult.rows?.[0] ?? null;
        if (!ticket) {
          return {
            code: "TICKET_INVALID",
            result: "invalid_ticket",
            reason: "Ticket inválido.",
            checkin: null,
            event_id: null,
          };
        }

        const ticketEventId = Number(ticket.event_id);
        const resolvedEventId = ticketEventId;

        const eventResult = await tx.query(
          `SELECT id, org_id, title, starts_at, ends_at, geo_enforced, hours_value, attributes
           FROM events
           WHERE id = $1 AND org_id = $2
           LIMIT 1`,
          [resolvedEventId, DEFAULT_ORG_ID],
        );

        const event = eventResult.rows?.[0];
        if (!event) {
          throw createHttpError(404, "Evento no encontrado.");
        }

        const assignedStaffId = event.attributes?.staff_user_id ?? null;
        console.log("attributes", event.attributes);
        
        if (!assignedStaffId) {
          throw createHttpError(403, "El evento no tiene usuario staff asignado.");
        }
        if (Number(assignedStaffId) !== staffUserId) {
          throw createHttpError(403, "El usuario staff no está asignado a este evento.");
        }

        const staffResult = await tx.query(
          `SELECT 1
           FROM memberships
           WHERE org_id = $1
             AND user_id = $2
             AND role::text = $3
           LIMIT 1`,
          [DEFAULT_ORG_ID, staffUserId, ROLES.STAFF],
        );
        if (!staffResult.rows?.[0]) {
          throw createHttpError(400, "Usuario staff no encontrado.");
        }

        let session = null;
        const nowIso = new Date().toISOString();

        const activeResult = await tx.query(
          `SELECT id, starts_at, ends_at, hours_value
           FROM event_sessions
           WHERE event_id = $1
             AND starts_at <= $2
             AND ends_at >= $2
           ORDER BY starts_at DESC
           LIMIT 1`,
          [resolvedEventId, nowIso],
        );

        if (activeResult.rows.length > 0) {
          session = activeResult.rows[0];
        } else {
          const upcomingResult = await tx.query(
            `SELECT id, starts_at, ends_at, hours_value
             FROM event_sessions
             WHERE event_id = $1
               AND starts_at > $2
             ORDER BY starts_at ASC
             LIMIT 1`,
            [resolvedEventId, nowIso],
          );

          if (upcomingResult.rows.length > 0) {
            session = upcomingResult.rows[0];
          } else {
            const pastResult = await tx.query(
              `SELECT id, starts_at, ends_at, hours_value
               FROM event_sessions
               WHERE event_id = $1
                 AND ends_at < $2
               ORDER BY ends_at DESC
               LIMIT 1`,
              [resolvedEventId, nowIso],
            );

            if (pastResult.rows.length > 0) {
              session = pastResult.rows[0];
            }
          }
        }

        if (!session) {
          throw createHttpError(404, "Sesión no encontrada para el evento.");
        }

        const existingCheckinResult = await tx.query(
          `SELECT id, result::text AS result, scanned_at
           FROM checkins
           WHERE session_id = $1 AND user_id = $2
           LIMIT 1`,
          [session.id, ticket.user_id],
        );

        const existingCheckin = existingCheckinResult.rows?.[0] ?? null;
        if (existingCheckin) {
          return {
            code: "TICKET_ALREADY_SCANNED",
            result: "duplicate",
            reason: "El usuario ya tiene check-in para esta sesión.",
            checkin: existingCheckin,
            user_id: ticket.user_id,
            ticket_id: ticket.id,
            event_id: resolvedEventId,
          };
        }

        if (ticket.status !== "active") {
          const cancelledInsert = await tx.query(
            `INSERT INTO checkins (
              event_id,
              session_id,
              user_id,
              ticket_id,
              checkin_source,
              scanner_admin_id,
              result,
              geo_ok,
              geo_reason,
              meta
            ) VALUES (
              $1, $2, $3, $4, 'staff'::checkin_source, $5,
              'cancelled_ticket'::checkin_result, false, 'ok'::geo_reason, $6::jsonb
            )
            RETURNING id, scanned_at, result::text AS result`,
            [
              resolvedEventId,
              session.id,
              ticket.user_id,
              ticket.id,
              scannerAdminId,
              JSON.stringify({ ticket_status: ticket.status, staff_user_id: staffUserId }),
            ],
          );

          return {
            result: "cancelled_ticket",
            reason: "El ticket no está activo.",
            checkin: cancelledInsert.rows[0],
            user_id: ticket.user_id,
            ticket_id: ticket.id,
            event_id: resolvedEventId,
          };
        }

        let result = "accepted";
        let reason = "Check-in aceptado.";
        let geoOk = true;
        let geoReason = "ok";
        let distanceM = null;

        if (event.geo_enforced) {
          const geoConfigResult = await tx.query(
            `SELECT center_lat, center_lng, radius_m, strict_accuracy_m
             FROM event_geo
             WHERE event_id = $1
             LIMIT 1`,
            [resolvedEventId],
          );

          const geo = geoConfigResult.rows?.[0];
          if (!geo) {
            result = "rejected";
            reason = "Geocerca no configurada para el evento.";
            geoOk = false;
            geoReason = "out_of_radius";
          } else if (
            clientLat === null ||
            clientLng === null ||
            Number.isNaN(clientLat) ||
            Number.isNaN(clientLng)
          ) {
            result = "rejected";
            reason = "GPS requerido para este evento.";
            geoOk = false;
            geoReason = "no_gps";
          } else if (
            geo.strict_accuracy_m !== null &&
            geo.strict_accuracy_m !== undefined &&
            (accuracyM === null || Number.isNaN(accuracyM) || accuracyM > Number(geo.strict_accuracy_m))
          ) {
            result = "rejected";
            reason = "Precisión GPS insuficiente.";
            geoOk = false;
            geoReason = "low_accuracy";
          } else {
            distanceM = haversineDistanceMeters(
              Number(clientLat),
              Number(clientLng),
              Number(geo.center_lat),
              Number(geo.center_lng),
            );

            if (distanceM > Number(geo.radius_m)) {
              result = "rejected";
              reason = "Fuera del radio permitido.";
              geoOk = false;
              geoReason = "out_of_radius";
            }
          }
        }

        const insertCheckinResult = await tx.query(
          `INSERT INTO checkins (
            event_id,
            session_id,
            user_id,
            ticket_id,
            checkin_source,
            scanner_admin_id,
            client_lat,
            client_lng,
            accuracy_m,
            distance_m,
            geo_ok,
            geo_reason,
            result,
            meta
          ) VALUES (
            $1, $2, $3, $4, 'staff'::checkin_source, $5,
            $6, $7, $8, $9, $10, $11::geo_reason, $12::checkin_result, $13::jsonb
          )
          RETURNING id, scanned_at, result::text AS result, geo_ok, geo_reason::text AS geo_reason`,
          [
            resolvedEventId,
            session.id,
            ticket.user_id,
            ticket.id,
            scannerAdminId,
            clientLat,
            clientLng,
            accuracyM,
            distanceM,
            geoOk,
            geoReason,
            result,
            JSON.stringify({ reason, ticket_code: ticketCode, staff_user_id: staffUserId }),
          ],
        );

        const insertedCheckin = insertCheckinResult.rows[0];

        if (result === "accepted") {
          const grantedHours =
            session.hours_value !== null && session.hours_value !== undefined
              ? Number(session.hours_value)
              : Number(event.hours_value);

          await tx.query(
            `INSERT INTO hours_ledger (
              user_id,
              event_id,
              hours_delta,
              reason,
              source_checkin_id,
              created_by,
              note
            ) VALUES (
              $1, $2, $3, 'checkin'::ledger_reason, $4, $5, $6
            )
            ON CONFLICT (source_checkin_id) DO NOTHING`,
            [
              ticket.user_id,
              resolvedEventId,
              Number.isNaN(grantedHours) ? 0 : grantedHours,
              insertedCheckin.id,
              scannerAdminId,
              `Check-in staff session=${session.id}`,
            ],
          );

          await tx.query(
            `UPDATE tickets
             SET status = 'used'::ticket_status,
                 revoked_at = now()
             WHERE id = $1
               AND status = 'active'::ticket_status`,
            [ticket.id],
          );
        }

        return {
          result,
          reason,
          checkin: insertedCheckin,
          user_id: ticket.user_id,
          ticket_id: ticket.id,
          event_id: resolvedEventId,
          session_id: session.id,
        };
      });

      if (scan.event_id && scan.session_id) {
        await incrementSessionLiveCounter(scan.event_id, scan.session_id, scan.result);
        const checkinTimelineEventType = getCheckinEventTypeByResult(scan.result);

        await appendTimelineEvent(`event:${scan.event_id}:checkins:timeline`, {
          type: "checkin",
          event_type: checkinTimelineEventType,
          session_id: scan.session_id,
          result: scan.result,
          user_id: scan.user_id ?? null,
          ticket_id: scan.ticket_id ?? null,
        });
      }

      if (scan.event_id) {
        await appendRecentCheckin({
          eventId: scan.event_id,
          sessionId: scan.session_id ?? null,
          payload: {
            id: scan.checkin?.id ?? null,
            scanned_at: scan.checkin?.scanned_at ?? new Date().toISOString(),
            result: scan.result,
            reason: scan.reason,
            user_id: scan.user_id ?? null,
            ticket_id: scan.ticket_id ?? null,
          },
        });
      }

      const httpStatus =
        scan.result === "duplicate"
          ? 409
          : scan.result === "invalid_ticket"
            ? 400
            : 200;

      return res.status(httpStatus).json({
        ok: true,
        code: scan.code ?? null,
        event_id: scan.event_id ?? null,
        session_id: scan.session_id ?? null,
        result: scan.result,
        reason: scan.reason,
        checkin: scan.checkin,
        user_id: scan.user_id ?? null,
        ticket_id: scan.ticket_id ?? null,
      });
    } catch (err) {
      if (err?.statusCode === 400 || err?.statusCode === 403) {
        return res.status(err.statusCode).json({ ok: false, message: err.message });
      }
      if (err?.statusCode === 404) {
        return res.status(404).json({ ok: false, message: err.message });
      }

      console.error("Error en POST /api/admin/events/:eventId/checkins/scan:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo procesar el check-in.",
      });
    }
  },
);

router.post("/api/admin/events", requireAuth, requireEventManager, async (req, res) => {
  const authUserId = req.auth?.userId;

  if (!authUserId) {
    return res.status(401).json({ ok: false, success: false, message: "Sesión inválida." });
  }

  const normalized = normalizeCreateEventPayload(req.body);
  if (normalized.error) {
    return res.status(400).json({ ok: false, success: false, message: normalized.error });
  }

  const eventInput = normalized.value;

  try {
    const created = await withTransaction(async (tx) => {
      const category = await ensureEventCategoryExists(eventInput.category, tx);

      const eventInsertResult = await tx.query(
        `INSERT INTO events (
          org_id,
          title,
          description,
          category,
          location,
          organizer,
          starts_at,
          ends_at,
          hours_value,
          capacity,
          capacity_enabled,
          status,
          registration_mode,
          resubmission_policy,
          allow_self_checkin,
          geo_enforced,
          cancel_policy,
          cancel_deadline,
          cover_image_url,
          attributes,
          created_by
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::event_status, $13::registration_mode,
          $14::resubmission_policy, $15, $16, $17::cancel_policy, $18, $19, $20::jsonb, $21
        )
        RETURNING *`,
        [
          DEFAULT_ORG_ID,
          eventInput.title,
          eventInput.description,
          category,
          eventInput.location,
          eventInput.organizer,
          eventInput.starts_at,
          eventInput.ends_at,
          eventInput.hours_value,
          eventInput.capacity,
          eventInput.capacity_enabled,
          eventInput.status,
          eventInput.registration_mode,
          eventInput.resubmission_policy,
          eventInput.allow_self_checkin,
          eventInput.geo_enforced,
          eventInput.cancel_policy,
          eventInput.cancel_deadline,
          eventInput.cover_image_url,
          JSON.stringify(eventInput.attributes),
          authUserId,
        ],
      );

      const eventRow = eventInsertResult.rows[0];

      const staffUserIdInput =
        req.body?.staff_user_id ?? req.body?.staffUserId ?? req.body?.staff_user;
      const assignStaffRaw = req.body?.assign_staff ?? req.body?.assignStaff;
      const staffUserId =
        staffUserIdInput === undefined || staffUserIdInput === null || String(staffUserIdInput).trim() === ""
          ? null
          : Number(staffUserIdInput);
      const assignStaff =
        assignStaffRaw === undefined
          ? staffUserId !== null
          : parseBooleanInput(assignStaffRaw, false);

      if (assignStaff && staffUserId === null) {
        const validationError = new Error("assign_staff=true requiere staff_user_id.");
        validationError.statusCode = 400;
        throw validationError;
      }
      if (!assignStaff && staffUserId !== null) {
        const validationError = new Error("Enviaste staff_user_id pero assign_staff=false.");
        validationError.statusCode = 400;
        throw validationError;
      }

      let staffUser = null;
      let staffPassword = null;
      if (assignStaff && staffUserId !== null) {
        if (!Number.isInteger(staffUserId) || staffUserId <= 0) {
          const validationError = new Error("staff_user_id inválido.");
          validationError.statusCode = 400;
          throw validationError;
        }

        const staffResult = await tx.query(
          `SELECT u.id, u.email
           FROM users u
           JOIN memberships m
             ON m.user_id = u.id
            AND m.org_id = $2
           WHERE u.id = $1
             AND m.role::text = $3
           LIMIT 1`,
          [staffUserId, DEFAULT_ORG_ID, ROLES.STAFF],
        );

        staffUser = staffResult.rows?.[0] ?? null;
        if (!staffUser) {
          const validationError = new Error("Usuario staff no encontrado.");
          validationError.statusCode = 400;
          throw validationError;
        }

        const nextAttributes = {
          ...(eventInput.attributes || {}),
          staff_user_id: staffUser.id,
        };

        await tx.query(
          `UPDATE events
           SET attributes = $1::jsonb
           WHERE id = $2`,
          [JSON.stringify(nextAttributes), eventRow.id],
        );

        eventRow.attributes = nextAttributes;
      } else if (!assignStaff && staffUserId === null) {
        const staffEmail = generateStaffEmail(eventRow.id);
        const rawPassword = generateStaffPassword();
        const passwordHash = await bcrypt.hash(rawPassword, 12);

        try {
          const staffInsertResult = await tx.query(
            `INSERT INTO users (
              email,
              password_hash,
              first_name,
              last_name,
              status,
              attributes
            )
            VALUES ($1, $2, $3, $4, 'active', $5::jsonb)
            RETURNING id, email`,
            [
              staffEmail,
              passwordHash,
              "Staff",
              `Evento ${eventRow.id}`,
              JSON.stringify({ event_id: eventRow.id, event_staff: true }),
            ],
          );

          staffUser = staffInsertResult.rows[0];
          staffPassword = rawPassword;

          await tx.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, $3::membership_role)
             ON CONFLICT (org_id, user_id)
             DO UPDATE SET role = EXCLUDED.role`,
            [DEFAULT_ORG_ID, staffUser.id, ROLES.STAFF],
          );

          const nextAttributes = {
            ...(eventInput.attributes || {}),
            staff_user_id: staffUser.id,
          };

          await tx.query(
            `UPDATE events
             SET attributes = $1::jsonb
             WHERE id = $2`,
            [JSON.stringify(nextAttributes), eventRow.id],
          );

          eventRow.attributes = nextAttributes;
        } catch (err) {
          if (err?.code === "23505") {
            const conflictError = new Error("Ya existe un usuario staff para este evento.");
            conflictError.statusCode = 409;
            throw conflictError;
          }
          throw err;
        }
      }

      let geofenceRow = null;
      if (eventInput.geo_enforced && eventInput.geo) {
        const geoInsertResult = await tx.query(
          `INSERT INTO event_geo (
            event_id,
            center_lat,
            center_lng,
            radius_m,
            strict_accuracy_m
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [
            eventRow.id,
            eventInput.geo.center_lat,
            eventInput.geo.center_lng,
            eventInput.geo.radius_m,
            eventInput.geo.strict_accuracy_m,
          ],
        );
        geofenceRow = geoInsertResult.rows[0];
      }

      const createdSessions = [];
      for (const session of eventInput.sessions) {
        const sessionInsertResult = await tx.query(
          `INSERT INTO event_sessions (
            event_id,
            starts_at,
            ends_at,
            label,
            hours_value
          ) VALUES ($1, $2, $3, $4, $5)
          RETURNING *`,
          [
            eventRow.id,
            session.starts_at,
            session.ends_at,
            session.label,
            session.hours_value,
          ],
        );

        createdSessions.push(sessionInsertResult.rows[0]);
      }

      return {
        event: eventRow,
        sessions: createdSessions,
        geofence: geofenceRow,
        staff_user: staffUser,
        staff_password: staffPassword,
      };
    });

    return res.status(201).json({
      ok: true,
      success: true,
      message: "Evento creado correctamente.",
      event: mapEventForResponse(created.event),
      sessions: created.sessions,
      geofence: created.geofence,
      staff_user: created.staff_user
        ? { id: created.staff_user.id, email: created.staff_user.email }
        : null,
      staff_password: created.staff_password ?? null,
    });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, success: false, message: err.message });
    }
    if (err?.statusCode === 409) {
      return res.status(409).json({ ok: false, success: false, message: err.message });
    }
    if (err?.code === "23503") {
      return res.status(400).json({
        ok: false,
        success: false,
        message: "category inválido. Debe existir en event_categories.",
      });
    }

    console.error("Error en POST /api/admin/events:", err.message);
    return res.status(500).json({
      ok: false,
      success: false,
      message: "No se pudo crear el evento.",
    });
  }
});

router.put("/api/admin/events/:eventId", requireAuth, requireAdmin, async (req, res) => {
  const eventId = Number(req.params.eventId);

  if (!Number.isInteger(eventId) || eventId <= 0) {
    return res.status(400).json({ ok: false, message: "eventId inválido." });
  }

  const updates = req.body || {};
  const capacityEnabledInput =
    updates.capacity_enabled !== undefined ? updates.capacity_enabled : updates.capacityEnabled;
  const capacityInput = updates.capacity;
  const coverImageUrlInput =
    updates.cover_image_url !== undefined ? updates.cover_image_url : updates.coverImageUrl;
  const staffUserIdInput =
    updates.staff_user_id ?? updates.staffUserId ?? updates.staff_user;
  const assignStaffRaw = updates.assign_staff ?? updates.assignStaff;

  try {
    const updated = await withTransaction(async (tx) => {
      const existingResult = await tx.query(
        `SELECT *
         FROM events
         WHERE id = $1 AND org_id = $2
         LIMIT 1`,
        [eventId, DEFAULT_ORG_ID],
      );

      const existingEvent = existingResult.rows?.[0];
      if (!existingEvent) {
        const notFoundError = new Error("Evento no encontrado.");
        notFoundError.statusCode = 404;
        throw notFoundError;
      }

      const startsAt =
        updates.starts_at !== undefined
          ? parseIsoDateOrNull(updates.starts_at)
          : new Date(existingEvent.starts_at);
      const endsAt =
        updates.ends_at !== undefined
          ? parseIsoDateOrNull(updates.ends_at)
          : new Date(existingEvent.ends_at);

      if (!startsAt || !endsAt) {
        const validationError = new Error("starts_at y ends_at deben ser fechas ISO válidas.");
        validationError.statusCode = 400;
        throw validationError;
      }
      if (endsAt <= startsAt) {
        const validationError = new Error("ends_at debe ser mayor que starts_at.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const hoursValue =
        updates.hours_value !== undefined
          ? Number(updates.hours_value)
          : Number(existingEvent.hours_value);
      if (Number.isNaN(hoursValue) || hoursValue < 0) {
        const validationError = new Error("hours_value debe ser un número >= 0.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const capacityEnabled =
        capacityEnabledInput !== undefined
          ? parseBooleanInput(capacityEnabledInput, false)
          : Boolean(existingEvent.capacity_enabled);

      let capacity =
        capacityInput !== undefined
          ? capacityInput === null || capacityInput === ""
            ? null
            : Number(capacityInput)
          : existingEvent.capacity === null || existingEvent.capacity === undefined
            ? null
            : Number(existingEvent.capacity);

      if (capacityEnabled) {
        if (!Number.isInteger(capacity) || capacity <= 0) {
          const validationError = new Error(
            "capacity debe ser un entero mayor a 0 cuando capacity_enabled=true.",
          );
          validationError.statusCode = 400;
          throw validationError;
        }

        const occupiedResult = await tx.query(
          `SELECT COUNT(*)::int AS total
           FROM registrations
           WHERE event_id = $1
             AND status::text = ANY($2::text[])`,
          [eventId, ["approved", "pending", "changes_requested", "cancel_pending"]],
        );

        const occupied = Number(occupiedResult.rows?.[0]?.total ?? 0);
        if (capacity < occupied) {
          const validationError = new Error(
            "capacity no puede ser menor al total actual de inscritos activos del evento.",
          );
          validationError.statusCode = 400;
          throw validationError;
        }
      } else {
        capacity = null;
      }

      const status =
        updates.status !== undefined ? String(updates.status).trim() : String(existingEvent.status);
      if (!EVENT_STATUSES.has(status)) {
        const validationError = new Error("status inválido.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const registrationMode =
        updates.registration_mode !== undefined
          ? String(updates.registration_mode).trim()
          : String(existingEvent.registration_mode);
      if (!REGISTRATION_MODES.has(registrationMode)) {
        const validationError = new Error("registration_mode inválido.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const resubmissionPolicy =
        updates.resubmission_policy !== undefined
          ? String(updates.resubmission_policy).trim()
          : String(existingEvent.resubmission_policy);
      if (!RESUBMISSION_POLICIES.has(resubmissionPolicy)) {
        const validationError = new Error("resubmission_policy inválido.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const cancelPolicy =
        updates.cancel_policy !== undefined
          ? String(updates.cancel_policy).trim()
          : String(existingEvent.cancel_policy);
      if (!CANCEL_POLICIES.has(cancelPolicy)) {
        const validationError = new Error("cancel_policy inválido.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const cancelDeadline =
        updates.cancel_deadline !== undefined
          ? updates.cancel_deadline === null
            ? null
            : parseIsoDateOrNull(updates.cancel_deadline)
          : existingEvent.cancel_deadline;

      if (updates.cancel_deadline !== undefined && updates.cancel_deadline !== null && !cancelDeadline) {
        const validationError = new Error("cancel_deadline inválido.");
        validationError.statusCode = 400;
        throw validationError;
      }
      if (cancelDeadline && new Date(cancelDeadline) > startsAt) {
        const validationError = new Error(
          "cancel_deadline no puede ser posterior a starts_at.",
        );
        validationError.statusCode = 400;
        throw validationError;
      }

      const attributes = updates.attributes !== undefined ? updates.attributes : existingEvent.attributes;
      if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
        const validationError = new Error("attributes debe ser un objeto JSON.");
        validationError.statusCode = 400;
        throw validationError;
      }

      const staffUserId =
        staffUserIdInput === undefined || staffUserIdInput === null || String(staffUserIdInput).trim() === ""
          ? null
          : Number(staffUserIdInput);
      const assignStaff =
        assignStaffRaw === undefined
          ? staffUserIdInput !== undefined
          : parseBooleanInput(assignStaffRaw, false);

      if (assignStaff && staffUserId === null) {
        const validationError = new Error("assign_staff=true requiere staff_user_id.");
        validationError.statusCode = 400;
        throw validationError;
      }
      if (!assignStaff && staffUserId !== null) {
        const validationError = new Error("Enviaste staff_user_id pero assign_staff=false.");
        validationError.statusCode = 400;
        throw validationError;
      }
      if (staffUserId !== null) {
        if (!Number.isInteger(staffUserId) || staffUserId <= 0) {
          const validationError = new Error("staff_user_id inválido.");
          validationError.statusCode = 400;
          throw validationError;
        }

        const staffResult = await tx.query(
          `SELECT u.id
           FROM users u
           JOIN memberships m
             ON m.user_id = u.id
            AND m.org_id = $2
           WHERE u.id = $1
             AND m.role::text = $3
           LIMIT 1`,
          [staffUserId, DEFAULT_ORG_ID, ROLES.STAFF],
        );

        if (!staffResult.rows?.[0]) {
          const validationError = new Error("Usuario staff no encontrado.");
          validationError.statusCode = 400;
          throw validationError;
        }
      }

      const category =
        updates.category !== undefined
          ? await ensureEventCategoryExists(updates.category, tx)
          : await ensureEventCategoryExists(existingEvent.category, tx);

      const normalizedAttributes = { ...attributes };
      if (Object.prototype.hasOwnProperty.call(normalizedAttributes, "category")) {
        delete normalizedAttributes.category;
      }
      if (Object.prototype.hasOwnProperty.call(normalizedAttributes, "cupo")) {
        delete normalizedAttributes.cupo;
      }
      if (Object.prototype.hasOwnProperty.call(normalizedAttributes, "staff_user_id")) {
        delete normalizedAttributes.staff_user_id;
      }

      const existingStaffUserIdRaw = existingEvent.attributes?.staff_user_id;
      const existingStaffUserId =
        existingStaffUserIdRaw === undefined ||
        existingStaffUserIdRaw === null ||
        String(existingStaffUserIdRaw).trim() === ""
          ? null
          : Number(existingStaffUserIdRaw);

      if (assignStaff && staffUserId !== null) {
        normalizedAttributes.staff_user_id = staffUserId;
      } else if (
        staffUserIdInput === undefined &&
        Number.isInteger(existingStaffUserId) &&
        existingStaffUserId > 0
      ) {
        normalizedAttributes.staff_user_id = existingStaffUserId;
      }

      const location =
        updates.location !== undefined
          ? updates.location === null
            ? null
            : String(updates.location || "").trim()
          : existingEvent.location;

      const organizer =
        updates.organizer !== undefined
          ? updates.organizer === null
            ? null
            : String(updates.organizer || "").trim()
          : existingEvent.organizer;

      const geoEnforced =
        updates.geo_enforced !== undefined
          ? Boolean(updates.geo_enforced)
          : Boolean(existingEvent.geo_enforced);

      const allowSelfCheckin =
        updates.allow_self_checkin !== undefined
          ? Boolean(updates.allow_self_checkin)
          : Boolean(existingEvent.allow_self_checkin);

      const coverImageUrl =
        coverImageUrlInput !== undefined
          ? coverImageUrlInput === null
            ? null
            : String(coverImageUrlInput || "").trim() || null
          : existingEvent.cover_image_url;

      await tx.query(
        `UPDATE events
         SET title = $1,
             description = $2,
             category = $3,
             location = $4,
             organizer = $5,
             starts_at = $6,
             ends_at = $7,
             hours_value = $8,
             capacity = $9,
             capacity_enabled = $10,
             status = $11::event_status,
             registration_mode = $12::registration_mode,
             resubmission_policy = $13::resubmission_policy,
             allow_self_checkin = $14,
             geo_enforced = $15,
             cancel_policy = $16::cancel_policy,
             cancel_deadline = $17,
             cover_image_url = $18,
             attributes = $19::jsonb
         WHERE id = $20 AND org_id = $21`,
        [
          updates.title !== undefined ? String(updates.title || "").trim() : existingEvent.title,
          updates.description !== undefined
            ? updates.description === null
              ? null
              : String(updates.description || "").trim()
            : existingEvent.description,
          category,
          location,
          organizer,
          startsAt,
          endsAt,
          hoursValue,
          capacity,
          capacityEnabled,
          status,
          registrationMode,
          resubmissionPolicy,
          allowSelfCheckin,
          geoEnforced,
          cancelPolicy,
          cancelDeadline,
          coverImageUrl,
          JSON.stringify(normalizedAttributes),
          eventId,
          DEFAULT_ORG_ID,
        ],
      );

      const existingGeoResult = await tx.query(
        `SELECT * FROM event_geo WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );
      const existingGeo = existingGeoResult.rows?.[0] || null;

      if (!geoEnforced) {
        await tx.query(`DELETE FROM event_geo WHERE event_id = $1`, [eventId]);
      } else {
        const geoPayload = updates.geo;
        let nextGeo = existingGeo;

        if (geoPayload !== undefined) {
          const centerLat = Number(geoPayload?.center_lat);
          const centerLng = Number(geoPayload?.center_lng);
          const radiusM = Number(geoPayload?.radius_m);
          const strictAccuracyM =
            geoPayload?.strict_accuracy_m === undefined || geoPayload?.strict_accuracy_m === null
              ? null
              : Number(geoPayload.strict_accuracy_m);

          if (Number.isNaN(centerLat) || Number.isNaN(centerLng) || Number.isNaN(radiusM)) {
            const validationError = new Error(
              "geo.center_lat, geo.center_lng y geo.radius_m son requeridos y numéricos.",
            );
            validationError.statusCode = 400;
            throw validationError;
          }
          if (radiusM <= 0) {
            const validationError = new Error("geo.radius_m debe ser mayor a 0.");
            validationError.statusCode = 400;
            throw validationError;
          }
          if (strictAccuracyM !== null && (Number.isNaN(strictAccuracyM) || strictAccuracyM <= 0)) {
            const validationError = new Error(
              "geo.strict_accuracy_m debe ser mayor a 0 cuando se envía.",
            );
            validationError.statusCode = 400;
            throw validationError;
          }

          const upsertGeoResult = await tx.query(
            `INSERT INTO event_geo (event_id, center_lat, center_lng, radius_m, strict_accuracy_m)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (event_id)
             DO UPDATE SET
               center_lat = EXCLUDED.center_lat,
               center_lng = EXCLUDED.center_lng,
               radius_m = EXCLUDED.radius_m,
               strict_accuracy_m = EXCLUDED.strict_accuracy_m
             RETURNING *`,
            [eventId, centerLat, centerLng, radiusM, strictAccuracyM],
          );
          nextGeo = upsertGeoResult.rows[0];
        }

        if (!nextGeo) {
          const validationError = new Error(
            "geo es requerido cuando geo_enforced=true y el evento no tiene geocerca previa.",
          );
          validationError.statusCode = 400;
          throw validationError;
        }
      }

      if (updates.sessions !== undefined) {
        if (!Array.isArray(updates.sessions) || updates.sessions.length === 0) {
          const validationError = new Error(
            "sessions debe ser un arreglo con al menos una sesión.",
          );
          validationError.statusCode = 400;
          throw validationError;
        }

        const normalizedSessions = [];
        const seenDays = new Set();
        for (let i = 0; i < updates.sessions.length; i += 1) {
          const session = updates.sessions[i];
          const sessionStartsAt = parseIsoDateOrNull(session?.starts_at);
          const sessionEndsAt = parseIsoDateOrNull(session?.ends_at);
          const sessionLabel =
            session?.label === undefined || session?.label === null
              ? null
              : String(session.label).trim();
          const sessionHoursValue =
            session?.hours_value === undefined || session?.hours_value === null
              ? null
              : Number(session.hours_value);

          if (!sessionStartsAt || !sessionEndsAt) {
            const validationError = new Error(
              `sessions[${i}] requiere starts_at y ends_at válidos.`,
            );
            validationError.statusCode = 400;
            throw validationError;
          }
          if (sessionEndsAt <= sessionStartsAt) {
            const validationError = new Error(`sessions[${i}] debe cumplir ends_at > starts_at.`);
            validationError.statusCode = 400;
            throw validationError;
          }
          if (
            sessionHoursValue !== null &&
            (Number.isNaN(sessionHoursValue) || sessionHoursValue < 0)
          ) {
            const validationError = new Error(
              `sessions[${i}].hours_value debe ser >= 0 o null.`,
            );
            validationError.statusCode = 400;
            throw validationError;
          }

          normalizedSessions.push({
            starts_at: sessionStartsAt,
            ends_at: sessionEndsAt,
            label: sessionLabel,
            hours_value: sessionHoursValue,
          });

          const dayKey = sessionStartsAt.toISOString().slice(0, 10);
          if (seenDays.has(dayKey)) {
            const validationError = new Error(
              `No puede haber más de una sesión en el mismo día (${dayKey}).`,
            );
            validationError.statusCode = 400;
            throw validationError;
          }
          seenDays.add(dayKey);
        }

        await tx.query(`DELETE FROM event_sessions WHERE event_id = $1`, [eventId]);

        for (const session of normalizedSessions) {
          await tx.query(
            `INSERT INTO event_sessions (event_id, starts_at, ends_at, label, hours_value)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              eventId,
              session.starts_at,
              session.ends_at,
              session.label,
              session.hours_value,
            ],
          );
        }
      }

      const sessionsResult = await tx.query(
        `SELECT id, event_id, starts_at, ends_at, label, hours_value, created_at
         FROM event_sessions
         WHERE event_id = $1
         ORDER BY starts_at ASC`,
        [eventId],
      );

      if (!sessionsResult.rows.length) {
        const fallbackSession = await tx.query(
          `INSERT INTO event_sessions (event_id, starts_at, ends_at, label, hours_value)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, event_id, starts_at, ends_at, label, hours_value, created_at`,
          [eventId, startsAt, endsAt, null, null],
        );
        sessionsResult.rows.push(fallbackSession.rows[0]);
      }

      const eventResult = await tx.query(
        `SELECT * FROM events WHERE id = $1 AND org_id = $2 LIMIT 1`,
        [eventId, DEFAULT_ORG_ID],
      );

      const geoResult = await tx.query(
        `SELECT * FROM event_geo WHERE event_id = $1 LIMIT 1`,
        [eventId],
      );

      return {
        event: eventResult.rows[0],
        sessions: sessionsResult.rows,
        geofence: geoResult.rows?.[0] ?? null,
      };
    });

    return res.status(200).json({
      ok: true,
      success: true,
      message: "Evento actualizado correctamente.",
      event: mapEventForResponse(updated.event),
      sessions: updated.sessions,
      geofence: updated.geofence,
    });
  } catch (err) {
    if (err?.statusCode === 404) {
      return res.status(404).json({ ok: false, success: false, message: err.message });
    }
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, success: false, message: err.message });
    }
    if (err?.code === "23503") {
      return res.status(400).json({
        ok: false,
        success: false,
        message: "category inválido. Debe existir en event_categories.",
      });
    }

    console.error("Error en PUT /api/admin/events/:eventId:", err.message);
    return res.status(500).json({
      ok: false,
      success: false,
      message: "No se pudo actualizar el evento.",
    });
  }
});

router.delete(
  "/api/admin/events/:eventId",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const eventId = Number(req.params.eventId);

    if (!Number.isInteger(eventId) || eventId <= 0) {
      return res.status(400).json({ ok: false, message: "eventId inválido." });
    }

    try {
      const deleted = await withTransaction(async (tx) => {
        const existingResult = await tx.query(
          `SELECT id, title
           FROM events
           WHERE id = $1 AND org_id = $2
           LIMIT 1`,
          [eventId, DEFAULT_ORG_ID],
        );

        const existingEvent = existingResult.rows?.[0];
        if (!existingEvent) {
          const notFoundError = new Error("Evento no encontrado.");
          notFoundError.statusCode = 404;
          throw notFoundError;
        }

        const deletedHoursResult = await tx.query(
          `DELETE FROM hours_ledger
           WHERE event_id = $1`,
          [eventId],
        );

        // También elimina check-ins asociados a sesiones de este evento.
        await tx.query(
          `DELETE FROM event_sessions
           WHERE event_id = $1`,
          [eventId],
        );

        const deletedEventResult = await tx.query(
          `DELETE FROM events
           WHERE id = $1 AND org_id = $2
           RETURNING id, title`,
          [eventId, DEFAULT_ORG_ID],
        );

        return {
          event: deletedEventResult.rows[0],
          deletedHoursCount: deletedHoursResult.rowCount || 0,
        };
      });

      return res.status(200).json({
        ok: true,
        message: "Evento eliminado correctamente.",
        event: deleted.event,
        deletedHoursCount: deleted.deletedHoursCount,
      });
    } catch (err) {
      if (err?.statusCode === 404) {
        return res.status(404).json({ ok: false, message: err.message });
      }

      console.error("Error en DELETE /api/admin/events/:eventId:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo eliminar el evento.",
      });
    }
  },
);

export default router;
