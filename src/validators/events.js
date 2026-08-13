import {
  CANCEL_POLICIES,
  EVENT_STATUSES,
  REGISTRATION_MODES,
  RESUBMISSION_POLICIES,
} from "../config/appConfig.js";

export const MAX_EVENT_HOURS = 100;

export function parseIsoDateOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

export function parsePlainDecimalOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;

  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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

export function normalizeCreateEventPayload(body) {
  const title = String(body?.title || "").trim();
  const description =
    body?.description === undefined ? null : String(body.description || "").trim();
  const location =
    body?.location === undefined || body?.location === null
      ? null
      : String(body.location || "").trim();
  const organizer =
    body?.organizer === undefined || body?.organizer === null
      ? null
      : String(body.organizer || "").trim();
  const coverImageUrlInput =
    body?.cover_image_url !== undefined ? body.cover_image_url : body?.coverImageUrl;
  const coverImageUrl =
    coverImageUrlInput === undefined || coverImageUrlInput === null
      ? null
      : String(coverImageUrlInput || "").trim() || null;
  const startsAt = parseIsoDateOrNull(body?.starts_at);
  const endsAt = parseIsoDateOrNull(body?.ends_at);

  const hoursValue =
    body?.hours_value === undefined ? 0 : parsePlainDecimalOrNull(body.hours_value);
  const capacityEnabledRaw = body?.capacity_enabled ?? body?.capacityEnabled ?? false;
  const capacityEnabled = parseBooleanInput(capacityEnabledRaw, false);
  const capacityRaw = body?.capacity;
  const capacity =
    capacityRaw === undefined || capacityRaw === null || capacityRaw === ""
      ? null
      : Number(capacityRaw);
  const category = String(body?.category || "").trim();
  const status = body?.status === undefined ? "draft" : String(body.status).trim();
  const registrationMode =
    body?.registration_mode === undefined ? "auto" : String(body.registration_mode).trim();
  const resubmissionPolicy =
    body?.resubmission_policy === undefined
      ? "only_changes_requested"
      : String(body.resubmission_policy).trim();
  const allowSelfCheckin = parseBooleanInput(body?.allow_self_checkin, false);
  const geoEnforced = parseBooleanInput(body?.geo_enforced, false);
  const cancelPolicy =
    body?.cancel_policy === undefined ? "free_cancel" : String(body.cancel_policy).trim();
  const cancelDeadline =
    body?.cancel_deadline === undefined || body?.cancel_deadline === null
      ? null
      : parseIsoDateOrNull(body.cancel_deadline);
  const attributes = body?.attributes === undefined ? {} : body.attributes;

  if (!title) return { error: "El título del evento es obligatorio." };
  if (!startsAt) return { error: "La fecha y hora de inicio son obligatorias y deben ser válidas." };
  if (!endsAt) return { error: "La fecha y hora de fin son obligatorias y deben ser válidas." };
  const now = new Date();
  if (startsAt < now) return { error: "La fecha y hora de inicio no pueden estar en el pasado." };
  if (endsAt < now) return { error: "La fecha y hora de fin no pueden estar en el pasado." };
  if (endsAt <= startsAt) return { error: "La fecha y hora de fin deben ser posteriores al inicio." };
  if (hoursValue === null || hoursValue < 0 || hoursValue > MAX_EVENT_HOURS) {
    return {
      error: `Las horas acreditables deben ser un decimal entre 0 y ${MAX_EVENT_HOURS}, sin letras ni notación científica.`,
    };
  }
  if (capacityEnabled) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      return { error: "El cupo debe ser un entero mayor a 0 cuando está habilitado." };
    }
  } else if (capacity !== null && (Number.isNaN(capacity) || !Number.isInteger(capacity))) {
    return { error: "El cupo debe ser un número entero válido." };
  }
  if (!category) return { error: "La categoría es obligatoria." };
  if (!EVENT_STATUSES.has(status)) return { error: "El estatus seleccionado no es válido." };
  if (!REGISTRATION_MODES.has(registrationMode)) return { error: "El modo de registro seleccionado no es válido." };
  if (!RESUBMISSION_POLICIES.has(resubmissionPolicy)) {
    return { error: "La política de reenvío seleccionada no es válida." };
  }
  if (!CANCEL_POLICIES.has(cancelPolicy)) return { error: "La política de cancelación seleccionada no es válida." };
  if (cancelDeadline && cancelDeadline > startsAt) {
    return { error: "La fecha límite de cancelación no puede ser posterior al inicio del evento." };
  }
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    return { error: "Los datos adicionales del evento no tienen un formato válido." };
  }

  const normalizedAttributes = { ...attributes };
  if (Object.prototype.hasOwnProperty.call(normalizedAttributes, "category")) {
    delete normalizedAttributes.category;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedAttributes, "cupo")) {
    delete normalizedAttributes.cupo;
  }

  let geo = null;
  if (geoEnforced) {
    const geoPayload = body?.geo;
    if (!geoPayload || typeof geoPayload !== "object") {
      return { error: "Captura los datos de ubicación cuando la geocerca está habilitada." };
    }

    const centerLat = Number(geoPayload.center_lat);
    const centerLng = Number(geoPayload.center_lng);
    const radiusM = Number(geoPayload.radius_m);
    const strictAccuracyM =
      geoPayload.strict_accuracy_m === undefined || geoPayload.strict_accuracy_m === null
        ? null
        : Number(geoPayload.strict_accuracy_m);

    if (Number.isNaN(centerLat) || Number.isNaN(centerLng) || Number.isNaN(radiusM)) {
      return {
        error:
          "La latitud, longitud y radio de la geocerca son obligatorios y deben ser numéricos.",
      };
    }
    if (centerLat < -90 || centerLat > 90) {
      return { error: "La latitud debe estar entre -90 y 90." };
    }
    if (centerLng < -180 || centerLng > 180) {
      return { error: "La longitud debe estar entre -180 y 180." };
    }
    if (radiusM <= 0) return { error: "El radio de la geocerca debe ser mayor a 0." };
    if (strictAccuracyM !== null && (Number.isNaN(strictAccuracyM) || strictAccuracyM <= 0)) {
      return { error: "La precisión de la geocerca debe ser mayor a 0 cuando se captura." };
    }

    geo = {
      center_lat: centerLat,
      center_lng: centerLng,
      radius_m: radiusM,
      strict_accuracy_m: strictAccuracyM,
    };
  }

  let sessions = [];
  if (body?.sessions === undefined) {
    sessions = [
      {
        starts_at: startsAt,
        ends_at: endsAt,
        label: null,
        hours_value: null,
      },
    ];
  } else {
    if (!Array.isArray(body.sessions) || body.sessions.length === 0) {
      return { error: "Agrega al menos una sesión válida al evento." };
    }

    for (let i = 0; i < body.sessions.length; i += 1) {
      const session = body.sessions[i];
      const sessionStartsAt = parseIsoDateOrNull(session?.starts_at);
      const sessionEndsAt = parseIsoDateOrNull(session?.ends_at);
      const sessionLabel =
        session?.label === undefined || session?.label === null
          ? null
          : String(session.label).trim();
      const hasSessionHoursValue =
        session?.hours_value !== undefined && session?.hours_value !== null;
      const sessionHoursValue =
        !hasSessionHoursValue
          ? null
          : parsePlainDecimalOrNull(session.hours_value);

      if (!sessionStartsAt || !sessionEndsAt) {
        return {
          error: `La sesión ${i + 1} requiere una fecha y hora de inicio y fin válidas.`,
        };
      }
      if (sessionEndsAt <= sessionStartsAt) {
        return { error: `En la sesión ${i + 1}, la fecha y hora de fin deben ser posteriores al inicio.` };
      }
      if (sessionStartsAt < startsAt || sessionEndsAt > endsAt) {
        return { error: `La sesión ${i + 1} debe estar dentro de las fechas del evento.` };
      }
      if (
        hasSessionHoursValue &&
        (sessionHoursValue === null || sessionHoursValue < 0 || sessionHoursValue > MAX_EVENT_HOURS)
      ) {
        return { error: `Las horas acreditables de la sesión ${i + 1} deben estar entre 0 y ${MAX_EVENT_HOURS}.` };
      }

      sessions.push({
        starts_at: sessionStartsAt,
        ends_at: sessionEndsAt,
        label: sessionLabel,
        hours_value: sessionHoursValue,
      });
    }
  }

  if (sessions.length > 1) {
    const seenDays = new Set();
    for (let i = 0; i < sessions.length; i += 1) {
      const dayKey = sessions[i].starts_at.toISOString().slice(0, 10);
      if (seenDays.has(dayKey)) {
        return { error: `No puede haber más de una sesión en el mismo día (${dayKey}).` };
      }
      seenDays.add(dayKey);
    }
  }

  return {
    value: {
      title,
      description,
      location,
      organizer,
      cover_image_url: coverImageUrl,
      starts_at: startsAt,
      ends_at: endsAt,
      hours_value: hoursValue,
      capacity_enabled: capacityEnabled,
      capacity: capacityEnabled ? capacity : null,
      category,
      status,
      registration_mode: registrationMode,
      resubmission_policy: resubmissionPolicy,
      allow_self_checkin: allowSelfCheckin,
      geo_enforced: geoEnforced,
      cancel_policy: cancelPolicy,
      cancel_deadline: cancelDeadline,
      attributes: normalizedAttributes,
      geo,
      sessions,
    },
  };
}
