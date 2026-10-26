import { FILE_PURPOSES } from "../config/appConfig.js";
import {
  AFC_KEY_PATTERN,
  AFC_SCENARIO_KIND,
  AFC_VALUATION_MODE,
  afcSelectionFingerprint,
  calculateAfcHours,
  isAfcManualMode,
} from "../catalogs/afcHoursCalc.js";
import { findAfcActivityType, findAfcScenario } from "./afcCatalogRepository.js";
import { eventDayKey } from "./eventAttendance.js";
import { attachFileToEvent } from "./fileStorageService.js";

export const HOURS_PENDING_ALLOWED_STATUSES = new Set(["draft", "cancelled"]);

export class EventHoursValuationError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.name = "EventHoursValuationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

function normalizeOptionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/**
 * Valida la forma del bloque `afc_valuation` enviado por el cliente (sin consultar la BD).
 * Devuelve { value } o { error }.
 */
export function normalizeAfcValuationInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "La valoración de horas AFC no tiene un formato válido." };
  }

  const origin = String(raw.origin ?? "").trim();
  const typeKey = String(raw.type_key ?? "").trim();
  const scenarioKey = String(raw.scenario_key ?? "").trim();
  if (!AFC_KEY_PATTERN.test(origin)) return { error: "Selecciona el origen de la actividad." };
  if (!AFC_KEY_PATTERN.test(typeKey)) return { error: "Selecciona el tipo de actividad." };
  if (scenarioKey && !AFC_KEY_PATTERN.test(scenarioKey)) return { error: "El supuesto seleccionado no es válido." };

  if (raw.course_days !== undefined && raw.course_days !== null && !Array.isArray(raw.course_days)) {
    return { error: "Las sesiones del curso no tienen un formato válido." };
  }
  const manualHours = raw.manual_hours;
  if (manualHours !== undefined && manualHours !== null && !["string", "number"].includes(typeof manualHours)) {
    return { error: "Las horas AFC capturadas no tienen un formato válido." };
  }

  const evidenceFileId = normalizeOptionalId(raw.evidence_file_id);
  if (evidenceFileId === undefined) return { error: "El archivo de evidencia indicado no es válido." };

  return {
    value: {
      origin,
      typeKey,
      scenarioKey: scenarioKey || null,
      courseDays: raw.course_days ?? null,
      manualHours: manualHours ?? null,
      evidenceFileId,
    },
  };
}

export function assertHoursAllowStatus(hoursValue, status) {
  if ((hoursValue === null || hoursValue === undefined) && !HOURS_PENDING_ALLOWED_STATUSES.has(status)) {
    throw new EventHoursValuationError(
      400,
      "Las horas AFC del evento aún no están completas; guárdalo como borrador hasta capturarlas.",
      "hours_pending",
    );
  }
}

/** Horas efectivas de cada sesión (fecha local y duración), en el formato de `course_days`. */
export function courseDaysFromSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .map((session) => ({ start: new Date(session?.starts_at), end: new Date(session?.ends_at) }))
    .filter(({ start, end }) => !Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start)
    .sort((a, b) => a.start - b.start)
    .map(({ start, end }) => ({
      date: eventDayKey(start),
      effective_hours: String(Math.round(((end - start) / 3_600_000) * 100) / 100),
    }));
}

// Con `sessions`, las horas de cursos salen del horario de las sesiones y no de lo capturado por el cliente.
async function calculateFromCatalog(executor, input, sessions) {
  const type = await findAfcActivityType(executor, { origin: input.origin, typeKey: input.typeKey });
  if (!type) {
    throw new EventHoursValuationError(400, "El tipo de actividad seleccionado no existe en el catálogo AFC.", "invalid_type");
  }
  let scenario = null;
  if (type.valuation_mode === AFC_VALUATION_MODE.SCENARIOS) {
    if (!input.scenarioKey) {
      throw new EventHoursValuationError(400, "Selecciona el supuesto o actividad realizada.", "invalid_scenario");
    }
    scenario = await findAfcScenario(executor, { typeId: type.id, scenarioKey: input.scenarioKey });
    if (!scenario) {
      throw new EventHoursValuationError(
        400,
        "El supuesto seleccionado no corresponde a la actividad.",
        "invalid_scenario",
      );
    }
  }

  const courseDays =
    sessions !== undefined && scenario?.kind === AFC_SCENARIO_KIND.COURSE_DURATION
      ? courseDaysFromSessions(sessions)
      : input.courseDays;
  const calculation = calculateAfcHours({
    type,
    scenario,
    inputs: { course_days: courseDays, manual_hours: input.manualHours },
  });
  if (!calculation.ok) {
    throw new EventHoursValuationError(400, calculation.message, calculation.code);
  }
  return { type, scenario, valuation: calculation.valuation };
}

/**
 * Calcula la valoración AFC con el catálogo de la BD.
 * existing: { afc_valuation, hours_value } del evento, o null si es nuevo.
 * Si la selección no cambió, conserva el valor vigente aunque el catálogo se haya editado después.
 * Devuelve { hoursValue, valuation, evidenceFileId }.
 */
/** Un evento de varias sesiones solo puede valorarse con actividades marcadas como multisesión. */
export async function assertAfcSessionsSupported(executor, { valuation, sessionCount }) {
  if (!valuation?.type_key || Number(sessionCount) <= 1) return;
  const type = await findAfcActivityType(executor, { origin: valuation.origin, typeKey: valuation.type_key });
  if (type && !type.multi_session) {
    throw new EventHoursValuationError(
      400,
      `La actividad AFC "${type.name}" no admite varias sesiones. Elige una actividad de varias sesiones o deja el evento en una sola sesión.`,
      "afc_single_session",
    );
  }
}

export async function prepareEventHoursValuation(executor, { existing = null, input, sessions }) {
  const { type, scenario, valuation } = await calculateFromCatalog(executor, input, sessions);
  const previousValuation = existing?.afc_valuation ?? null;
  const sameSelection =
    previousValuation !== null &&
    afcSelectionFingerprint(previousValuation) === afcSelectionFingerprint(valuation);

  if (!sameSelection && (!type.is_active || (scenario && !scenario.is_active))) {
    throw new EventHoursValuationError(
      400,
      "La actividad o el supuesto seleccionado ya no está disponible en el catálogo AFC.",
      "inactive_selection",
    );
  }

  const effective = sameSelection ? previousValuation : valuation;
  const evidenceFileId = isAfcManualMode(type.valuation_mode) ? input.evidenceFileId : null;

  if (effective.evidence_required && effective.complete && !evidenceFileId) {
    throw new EventHoursValuationError(
      400,
      "Adjunta el dictamen o evidencia del Comité de Carrera para registrar estas horas.",
      "evidence_required",
    );
  }

  let hoursValue = effective.complete ? effective.final_hours : null;
  if (sameSelection) {
    hoursValue =
      existing.hours_value === null || existing.hours_value === undefined ? null : Number(existing.hours_value);
  }

  return {
    hoursValue,
    valuation: { ...effective, evidence_file_id: evidenceFileId },
    evidenceFileId,
  };
}

export async function attachAfcEvidence(tx, { eventId, fileId, authUserId }) {
  if (!fileId) return null;
  return attachFileToEvent(tx, {
    fileId,
    eventId,
    purpose: FILE_PURPOSES.AFC_HOURS_EVIDENCE,
    authUserId,
  });
}
