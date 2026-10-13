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

export function assertAdminRoleAssignmentAccess(auth, roleValue) {
  const role = String(roleValue || "").trim().toLowerCase();
  if (role !== ROLES.ADMIN && role !== ROLES.AUDITOR) return;
  if (isGlobalCareerAdmin(auth)) return;

  throw new AdminUserCareerScopeError(
    403,
    "privileged_role_required",
    "Solo el administrador global puede asignar los roles admin o auditor.",
  );
}

// Áreas (no carreras) cuyos admins pueden dar de alta alumnos y visitantes, además de staff.
const USER_PROVISIONING_CAREER_NAMES = new Set(["deportivas", "culturales"]);
const ALL_ROLES = [ROLES.ADMIN, ROLES.STAFF, ROLES.STUDENT, ROLES.AUDITOR, ROLES.VISITOR];
const PROVISIONING_AREA_ROLES = [ROLES.STAFF, ROLES.STUDENT, ROLES.VISITOR];
const SCOPED_ADMIN_ROLES = [ROLES.STAFF];
export const PASSWORD_MANAGED_ROLES = new Set([ROLES.VISITOR, ROLES.STAFF]);

export function normalizeCareerName(name) {
  return String(name || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLowerCase();
}

export function isUserProvisioningCareer(careerName) {
  return USER_PROVISIONING_CAREER_NAMES.has(normalizeCareerName(careerName));
}

export const STUDY_SYSTEMS = new Set(["esc", "sua"]);

// Valor ausente => null; valor inválido => undefined.
export function normalizeStudySystem(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const normalized = String(value).trim().toLowerCase();
  return STUDY_SYSTEMS.has(normalized) ? normalized : undefined;
}

// Su admin puede consultar a los alumnos SUA de cualquier carrera (solo lectura).
export function isSuaDivisionCareer(careerName) {
  return normalizeCareerName(careerName).replace(/[^a-z]/gu, "").includes("universidadabiertacontinuayadistancia");
}

export function getAssignableUserRoles(auth, adminCareerName) {
  if (auth?.role !== ROLES.ADMIN) return [];
  if (isGlobalCareerAdmin(auth)) return [...ALL_ROLES];
  return isUserProvisioningCareer(adminCareerName) ? [...PROVISIONING_AREA_ROLES] : [...SCOPED_ADMIN_ROLES];
}

export function canImportStudents(auth, adminCareerName) {
  if (auth?.role !== ROLES.ADMIN) return false;
  return isGlobalCareerAdmin(auth) || isUserProvisioningCareer(adminCareerName);
}

export function assertUserRoleAssignmentAccess(auth, roleValue, adminCareerName) {
  const role = String(roleValue || "").trim().toLowerCase();
  if (getAssignableUserRoles(auth, adminCareerName).includes(role)) return;

  const onlyStaff = !isGlobalCareerAdmin(auth) && !isUserProvisioningCareer(adminCareerName);
  throw new AdminUserCareerScopeError(
    403,
    "role_assignment_forbidden",
    onlyStaff
      ? "Solo puedes crear o asignar usuarios staff."
      : "Solo puedes crear o asignar alumnos, visitantes o staff.",
  );
}

export function assertStudentImportAccess(auth, adminCareerName) {
  if (canImportStudents(auth, adminCareerName)) return;
  throw new AdminUserCareerScopeError(
    403,
    "student_import_forbidden",
    "Solo el administrador global, Deportivas y Culturales pueden importar estudiantes.",
  );
}

export function assertPasswordChangeAllowed(targetRole) {
  if (PASSWORD_MANAGED_ROLES.has(String(targetRole || "").trim().toLowerCase())) return;
  throw new AdminUserCareerScopeError(
    403,
    "password_change_forbidden",
    "Solo se puede cambiar la contraseña de visitantes y staff.",
  );
}

export async function loadAdminCareerName(db, auth) {
  const careerId = normalizeCareerId(auth?.careerId);
  if (careerId === null) return null;
  const result = await db.query(`SELECT name FROM careers WHERE id = $1 LIMIT 1`, [careerId]);
  return result.rows?.[0]?.name ?? null;
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

export function resolveAdminUserListCareerFilter(
  auth,
  requestedValue,
  parameterIndex,
  column = "u.career_id",
  { includeSuaStudents = false } = {},
) {
  const adminCareerId = requireValidAdminCareer(auth);
  const ownCareerClause = includeSuaStudents
    ? `(${column} = $${parameterIndex} OR m.study_system = 'sua')`
    : `${column} = $${parameterIndex}`;
  const requestedText =
    requestedValue === null || requestedValue === undefined
      ? ""
      : String(requestedValue).trim().toLowerCase();

  if (requestedText === "" || requestedText === "all") {
    return adminCareerId === 1
      ? { clause: "", params: [] }
      : { clause: ownCareerClause, params: [adminCareerId] };
  }

  if (requestedText === "none") {
    if (adminCareerId !== 1) {
      throw new AdminUserCareerScopeError(
        403,
        "career_scope_mismatch",
        "Solo puedes consultar usuarios de tu propia carrera.",
      );
    }
    return { clause: `${column} IS NULL`, params: [] };
  }

  const requestedCareerId = normalizeCareerId(requestedText);
  if (requestedCareerId === null) {
    throw new AdminUserCareerScopeError(
      400,
      "invalid_career_id",
      "career_id inválido. Usa all, none o un entero positivo.",
    );
  }

  if (adminCareerId !== 1 && requestedCareerId !== adminCareerId) {
    throw new AdminUserCareerScopeError(
      403,
      "career_scope_mismatch",
      "Solo puedes consultar usuarios de tu propia carrera.",
    );
  }

  return {
    clause: adminCareerId === 1 ? `${column} = $${parameterIndex}` : ownCareerClause,
    params: [adminCareerId === 1 ? requestedCareerId : adminCareerId],
  };
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
