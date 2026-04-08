import {
  CANCEL_POLICIES,
  EVENT_STATUSES,
  REGISTRATION_MODES,
  RESUBMISSION_POLICIES,
} from "../config/appConfig.js";

export function parseIsoDateOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
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

  const hoursValue = body?.hours_value === undefined ? 0 : Number(body.hours_value);
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
  const allowSelfCheckin = Boolean(body?.allow_self_checkin ?? false);
  const geoEnforced = Boolean(body?.geo_enforced ?? false);
  const cancelPolicy =
    body?.cancel_policy === undefined ? "free_cancel" : String(body.cancel_policy).trim();
  const cancelDeadline =
    body?.cancel_deadline === undefined || body?.cancel_deadline === null
      ? null
      : parseIsoDateOrNull(body.cancel_deadline);
  const attributes = body?.attributes === undefined ? {} : body.attributes;

  if (!title) return { error: "title es requerido." };
  if (!startsAt) return { error: "starts_at es requerido y debe ser una fecha ISO válida." };
  if (!endsAt) return { error: "ends_at es requerido y debe ser una fecha ISO válida." };
  if (endsAt <= startsAt) return { error: "ends_at debe ser mayor que starts_at." };
  if (Number.isNaN(hoursValue) || hoursValue < 0) {
    return { error: "hours_value debe ser un número mayor o igual a 0." };
  }
  if (capacityEnabled) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      return { error: "capacity debe ser un entero mayor a 0 cuando capacity_enabled=true." };
    }
  } else if (capacity !== null && (Number.isNaN(capacity) || !Number.isInteger(capacity))) {
    return { error: "capacity debe ser un entero válido." };
  }
  if (!category) return { error: "category es requerido." };
  if (!EVENT_STATUSES.has(status)) return { error: "status inválido." };
  if (!REGISTRATION_MODES.has(registrationMode)) return { error: "registration_mode inválido." };
  if (!RESUBMISSION_POLICIES.has(resubmissionPolicy)) {
    return { error: "resubmission_policy inválido." };
  }
  if (!CANCEL_POLICIES.has(cancelPolicy)) return { error: "cancel_policy inválido." };
  if (cancelDeadline && cancelDeadline > startsAt) {
    return { error: "cancel_deadline no puede ser posterior a starts_at." };
  }
  if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
    return { error: "attributes debe ser un objeto JSON." };
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
      return { error: "geo es requerido cuando geo_enforced=true." };
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
          "geo.center_lat, geo.center_lng y geo.radius_m son requeridos y deben ser numéricos.",
      };
    }
    if (radiusM <= 0) return { error: "geo.radius_m debe ser mayor a 0." };
    if (strictAccuracyM !== null && (Number.isNaN(strictAccuracyM) || strictAccuracyM <= 0)) {
      return { error: "geo.strict_accuracy_m debe ser mayor a 0 cuando se envía." };
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
      return { error: "sessions debe ser un arreglo con al menos una sesión." };
    }

    for (let i = 0; i < body.sessions.length; i += 1) {
      const session = body.sessions[i];
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
        return {
          error: `sessions[${i}] requiere starts_at y ends_at con fechas ISO válidas.`,
        };
      }
      if (sessionEndsAt <= sessionStartsAt) {
        return { error: `sessions[${i}] debe cumplir ends_at > starts_at.` };
      }
      if (
        sessionHoursValue !== null &&
        (Number.isNaN(sessionHoursValue) || sessionHoursValue < 0)
      ) {
        return { error: `sessions[${i}].hours_value debe ser >= 0 o null.` };
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
