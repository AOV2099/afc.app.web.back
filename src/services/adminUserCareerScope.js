import { ROLES } from "../config/appConfig.js";

export class AdminUserCareerScopeError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "AdminUserCareerScopeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeCareerId(value) {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return null;
  const careerId = Number(text);
  return Number.isSafeInteger(careerId) && careerId > 0 ? careerId : null;
}

export function isGlobalCareerAdmin(auth) {
  return auth?.role === ROLES.ADMIN && normalizeCareerId(auth?.careerId) === 1;
}

export function getScopedAdminCareerId(auth) {
  if (auth?.role !== ROLES.ADMIN) return null;
  const careerId = normalizeCareerId(auth?.careerId);
  return careerId !== null && careerId > 1 ? careerId : null;
}

function requireValidAdminCareer(auth) {
  if (auth?.role !== ROLES.ADMIN) {
    throw new AdminUserCareerScopeError(
      403,
      "admin_required",
      "No autorizado. Se requiere rol admin.",
    );
  }

  const careerId = normalizeCareerId(auth?.careerId);
  if (careerId === null) {
    throw new AdminUserCareerScopeError(
      403,
      "career_required",
      "El administrador debe iniciar sesión con una carrera válida asignada.",
    );
  }
  return careerId;
}

export function buildAdminCareerFilter(auth, parameterIndex, column = "u.career_id") {
  const careerId = requireValidAdminCareer(auth);
  if (careerId === 1) return { clause: "", params: [] };
  return { clause: `${column} = $${parameterIndex}`, params: [careerId] };
}

export function resolveEffectiveCreateCareer(auth, { provided, value }) {
  const adminCareerId = requireValidAdminCareer(auth);

  if (adminCareerId === 1) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const requestedCareerId = normalizeCareerId(value);
    if (requestedCareerId === null) {
      throw new AdminUserCareerScopeError(400, "invalid_career_id", "career_id inválido.");
    }
    return requestedCareerId;
  }

  if (!provided) return adminCareerId;
  const requestedCareerId = normalizeCareerId(value);
  if (requestedCareerId !== adminCareerId) {
    throw new AdminUserCareerScopeError(
      403,
      "career_scope_mismatch",
      "Solo puedes administrar usuarios de tu propia carrera.",
    );
  }
  return adminCareerId;
}

export function assertTargetCareerAccess(auth, targetCareerId) {
  const adminCareerId = requireValidAdminCareer(auth);
  if (adminCareerId === 1) return;

  if (normalizeCareerId(targetCareerId) !== adminCareerId) {
    throw new AdminUserCareerScopeError(
      403,
      "career_scope_mismatch",
      "No autorizado para administrar este usuario.",
    );
  }
}

export async function lockAdminUserTarget(
  tx,
  auth,
  userId,
  { includeAttributes = false } = {},
) {
  const attributesColumn = includeAttributes ? ", attributes" : "";
  const targetResult = await tx.query(
    `SELECT id, career_id${attributesColumn}
     FROM users
     WHERE id = $1
     LIMIT 1
     FOR UPDATE`,
    [userId],
  );
  const targetUser = targetResult.rows?.[0] ?? null;
  if (!targetUser) {
    throw new AdminUserCareerScopeError(
      404,
      "user_not_found",
      "Usuario no encontrado.",
    );
  }

  assertTargetCareerAccess(auth, targetUser.career_id);
  return targetUser;
}

export function assertRequestedCareerAccess(auth, { provided, value }) {
  const adminCareerId = requireValidAdminCareer(auth);
  if (adminCareerId === 1 || !provided) return;

  if (normalizeCareerId(value) !== adminCareerId) {
    throw new AdminUserCareerScopeError(
      403,
      "career_scope_mismatch",
      "No puedes cambiar la carrera de este usuario.",
    );
  }
}
