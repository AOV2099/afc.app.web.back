export class EventStaffCareerError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "EventStaffCareerError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const CAREER_REQUIRED_MESSAGE =
  "Se requiere una carrera válida para crear o administrar el staff de eventos.";
const STAFF_CAREER_MISMATCH_MESSAGE =
  "El usuario staff seleccionado no pertenece a tu carrera.";

export function normalizeEventStaffCareerId(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;

  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return null;

  const careerId = Number(text);
  return Number.isSafeInteger(careerId) && careerId > 0 ? careerId : null;
}

function requireManagerCareerId(value) {
  const managerCareerId = normalizeEventStaffCareerId(value);
  if (managerCareerId === null) {
    throw new EventStaffCareerError(403, "career_required", CAREER_REQUIRED_MESSAGE);
  }
  return managerCareerId;
}

export async function loadEventManagerCareerId(tx, authUserId) {
  if (!tx || typeof tx.query !== "function") {
    throw new TypeError("Se requiere una transacción válida.");
  }

  const managerResult = await tx.query(
    `SELECT career_id
     FROM users
     WHERE id = $1
     LIMIT 1
     FOR SHARE`,
    [authUserId],
  );

  return requireManagerCareerId(managerResult.rows?.[0]?.career_id);
}

export function assertEventStaffCareer(managerCareerIdValue, staffCareerIdValue) {
  const managerCareerId = requireManagerCareerId(managerCareerIdValue);
  if (managerCareerId === 1) return;

  const staffCareerId = normalizeEventStaffCareerId(staffCareerIdValue);
  if (staffCareerId !== managerCareerId) {
    throw new EventStaffCareerError(
      403,
      "staff_career_mismatch",
      STAFF_CAREER_MISMATCH_MESSAGE,
    );
  }
}
