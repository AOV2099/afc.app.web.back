export class EventCareerAccessError extends Error {
  constructor(message = "No puedes administrar eventos de otra carrera.") {
    super(message);
    this.name = "EventCareerAccessError";
    this.statusCode = 403;
    this.code = "event_career_forbidden";
  }
}

export function normalizeEventCareerId(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;

  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return null;

  const careerId = Number(text);
  return Number.isSafeInteger(careerId) && careerId > 0 ? careerId : null;
}

export function canManageEventCareer(managerCareerValue, ownerCareerValue) {
  const managerCareerId = normalizeEventCareerId(managerCareerValue);
  const ownerCareerId = normalizeEventCareerId(ownerCareerValue);

  if (managerCareerId === 1) return true;
  return managerCareerId !== null && ownerCareerId === managerCareerId;
}

export function assertEventCareerAccess(managerCareerValue, ownerCareerValue) {
  if (!canManageEventCareer(managerCareerValue, ownerCareerValue)) {
    throw new EventCareerAccessError();
  }
}