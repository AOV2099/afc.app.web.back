import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { parse } from "csv-parse/sync";

import {
  BULK_STUDENT_IMPORT_MAX_ROWS,
  BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
  DEFAULT_ORG_ID,
  ROLES,
} from "../config/appConfig.js";
import { query, withTransaction } from "../postgresClient.js";
import { getRedisClient } from "../redisClient.js";

export const STUDENT_CSV_HEADERS = Object.freeze([
  "nombres",
  "apellidos",
  "correo",
  "numero_cuenta",
]);

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;
const IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IMPORT_KEY_PREFIX = "bulk-student-import:";

export class BulkStudentImportError extends Error {
  constructor(status, code, message, errors = undefined) {
    super(message);
    this.name = "BulkStudentImportError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

function csvError(row, field, code, message) {
  return { row, field, code, message };
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function resolveImportCareer({ role, careerId, requestedCareerId }) {
  if (role !== ROLES.ADMIN) {
    throw new BulkStudentImportError(
      403,
      "admin_required",
      "No autorizado. Se requiere rol admin.",
    );
  }

  const importerCareerId = parsePositiveInteger(careerId);
  if (importerCareerId === null || importerCareerId === undefined) {
    throw new BulkStudentImportError(
      403,
      "admin_career_required",
      "El administrador debe tener una carrera asignada.",
    );
  }

  const requested = parsePositiveInteger(requestedCareerId);
  if (requested === undefined) {
    throw new BulkStudentImportError(400, "invalid_career_id", "career_id inválido.");
  }

  if (importerCareerId === 1) {
    if (requested === null || requested <= 1) {
      throw new BulkStudentImportError(
        400,
        "target_career_required",
        "El administrador global debe indicar una career_id destino mayor a 1.",
      );
    }
    return requested;
  }

  if (importerCareerId <= 1) {
    throw new BulkStudentImportError(
      403,
      "admin_career_required",
      "El administrador debe tener una carrera válida asignada.",
    );
  }
  if (requested !== null && requested !== importerCareerId) {
    throw new BulkStudentImportError(
      403,
      "career_scope_mismatch",
      "Solo puedes importar estudiantes en tu propia carrera.",
    );
  }

  return importerCareerId;
}

function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ");
}

function validateSafeText(rawValue, row, field, errors) {
  const trimmed = String(rawValue ?? "").trim();
  if (CONTROL_CHARACTER_PATTERN.test(String(rawValue ?? ""))) {
    errors.push(
      csvError(row, field, "control_character", `El campo ${field} contiene caracteres de control.`),
    );
  }
  if (FORMULA_PREFIX_PATTERN.test(trimmed)) {
    errors.push(
      csvError(row, field, "formula_not_allowed", `El campo ${field} no puede iniciar con una fórmula.`),
    );
  }
}

function validateHeaders(headers) {
  const errors = [];
  const actual = headers.map((header) => String(header ?? ""));
  const expectedCounts = new Map(STUDENT_CSV_HEADERS.map((header) => [header, 1]));
  const actualCounts = new Map();
  for (const header of actual) actualCounts.set(header, (actualCounts.get(header) || 0) + 1);

  for (const header of STUDENT_CSV_HEADERS) {
    if (!actualCounts.has(header)) {
      errors.push(csvError(1, header, "missing_header", `Falta el encabezado obligatorio ${header}.`));
    }
  }
  for (const header of actual) {
    if (!expectedCounts.has(header) || (actualCounts.get(header) || 0) > 1) {
      errors.push(
        csvError(1, "encabezados", "unexpected_header", "El archivo contiene encabezados no permitidos o duplicados."),
      );
      break;
    }
  }

  if (
    errors.length === 0 &&
    (actual.length !== STUDENT_CSV_HEADERS.length ||
      actual.some((header, index) => header !== STUDENT_CSV_HEADERS[index]))
  ) {
    errors.push(
      csvError(
        1,
        "encabezados",
        "invalid_header_order",
        `Los encabezados deben ser exactamente: ${STUDENT_CSV_HEADERS.join(",")}.`,
      ),
    );
  }

  return errors;
}

export function parseAndValidateStudentCsv(
  csvText,
  { maxRows = BULK_STUDENT_IMPORT_MAX_ROWS } = {},
) {
  let records;
  try {
    records = parse(String(csvText ?? ""), {
      bom: true,
      info: true,
      relax_column_count: false,
      skip_empty_lines: true,
    });
  } catch (error) {
    return {
      rows: [],
      errors: [
        csvError(
          Number.isInteger(error?.lines) ? error.lines : 1,
          "archivo",
          "csv_invalid",
          "El archivo no tiene un formato CSV válido.",
        ),
      ],
    };
  }

  if (records.length === 0) {
    return {
      rows: [],
      errors: [csvError(1, "archivo", "csv_empty", "El archivo CSV está vacío.")],
    };
  }

  const headerRecord = records[0]?.record || [];
  const headerErrors = validateHeaders(headerRecord);
  if (headerErrors.length > 0) return { rows: [], errors: headerErrors };

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return {
      rows: [],
      errors: [
        csvError(
          2,
          "archivo",
          "csv_no_data_rows",
          "El archivo CSV debe contener al menos una fila de estudiante.",
        ),
      ],
    };
  }

  if (dataRecords.length > maxRows) {
    return {
      rows: [],
      errors: [
        csvError(
          maxRows + 2,
          "archivo",
          "too_many_rows",
          `El archivo no puede contener más de ${maxRows} estudiantes.`,
        ),
      ],
    };
  }

  const rows = [];
  const errors = [];
  const seenEmails = new Map();
  const seenStudentIds = new Map();

  dataRecords.forEach(({ record }, index) => {
    const rowNumber = index + 2;
    const rawFirstName = record[0] ?? "";
    const rawLastName = record[1] ?? "";
    const rawEmail = record[2] ?? "";
    const rawStudentId = record[3] ?? "";

    validateSafeText(rawFirstName, rowNumber, "nombres", errors);
    validateSafeText(rawLastName, rowNumber, "apellidos", errors);
    validateSafeText(rawEmail, rowNumber, "correo", errors);
    validateSafeText(rawStudentId, rowNumber, "numero_cuenta", errors);

    const firstName = normalizeName(rawFirstName);
    const lastName = normalizeName(rawLastName);
    const email = String(rawEmail).trim().toLowerCase();
    const studentId = String(rawStudentId).trim();

    if (!firstName) {
      errors.push(csvError(rowNumber, "nombres", "required", "nombres es obligatorio."));
    } else if (firstName.length > 120) {
      errors.push(csvError(rowNumber, "nombres", "too_long", "nombres no puede exceder 120 caracteres."));
    }
    if (!lastName) {
      errors.push(csvError(rowNumber, "apellidos", "required", "apellidos es obligatorio."));
    } else if (lastName.length > 120) {
      errors.push(csvError(rowNumber, "apellidos", "too_long", "apellidos no puede exceder 120 caracteres."));
    }
    if (!email) {
      errors.push(csvError(rowNumber, "correo", "required", "correo es obligatorio."));
    } else if (email.length > 254) {
      errors.push(csvError(rowNumber, "correo", "too_long", "correo no puede exceder 254 caracteres."));
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.push(csvError(rowNumber, "correo", "invalid_email", "correo no tiene un formato válido."));
    }
    if (!studentId) {
      errors.push(
        csvError(rowNumber, "numero_cuenta", "required", "numero_cuenta es obligatorio."),
      );
    } else if (!/^\d{9}$/u.test(studentId)) {
      errors.push(
        csvError(
          rowNumber,
          "numero_cuenta",
          "invalid_student_id",
          "numero_cuenta debe contener exactamente 9 dígitos ASCII.",
        ),
      );
    }

    if (email) {
      if (seenEmails.has(email)) {
        errors.push(
          csvError(rowNumber, "correo", "duplicate_email", "correo está duplicado dentro del CSV."),
        );
      } else {
        seenEmails.set(email, rowNumber);
      }
    }
    if (studentId) {
      if (seenStudentIds.has(studentId)) {
        errors.push(
          csvError(
            rowNumber,
            "numero_cuenta",
            "duplicate_student_id",
            "numero_cuenta está duplicado dentro del CSV.",
          ),
        );
      } else {
        seenStudentIds.set(studentId, rowNumber);
      }
    }

    rows.push({ row: rowNumber, firstName, lastName, email, studentId });
  });

  return { rows, errors };
}

function normalizedExistingUser(user) {
  return {
    ...user,
    id: String(user.id),
    email: String(user.email || "").trim().toLowerCase(),
    student_id: user.student_id === null ? null : String(user.student_id || "").trim(),
    career_id: Number(user.career_id),
    role: user.role ? String(user.role) : null,
    status: String(user.status || ""),
  };
}

export function classifyProvisioningRows(rows, existingUsers, targetCareerId) {
  const users = existingUsers.map(normalizedExistingUser);
  const byEmail = new Map(users.map((user) => [user.email, user]));
  const byStudentId = new Map(
    users.filter((user) => user.student_id).map((user) => [user.student_id, user]),
  );
  const toCreate = [];
  const errors = [];
  let toSkip = 0;

  for (const row of rows) {
    const emailMatch = byEmail.get(row.email) || null;
    const studentIdMatch = byStudentId.get(row.studentId) || null;
    const sameUser =
      emailMatch && studentIdMatch && String(emailMatch.id) === String(studentIdMatch.id);
    const isExactDuplicate =
      sameUser &&
      emailMatch.email === row.email &&
      emailMatch.student_id === row.studentId &&
      emailMatch.career_id === Number(targetCareerId) &&
      emailMatch.role === ROLES.STUDENT &&
      emailMatch.status === "active";

    if (isExactDuplicate) {
      toSkip += 1;
      continue;
    }
    if (emailMatch || studentIdMatch) {
      if (sameUser) {
        errors.push(
          csvError(
            row.row,
            "correo",
            "existing_account_conflict",
            "La cuenta existente no coincide con un estudiante activo de la carrera destino.",
          ),
        );
      } else {
        if (emailMatch) {
          errors.push(
            csvError(
              row.row,
              "correo",
              "email_in_use",
              "El correo ya está asociado con otra cuenta.",
            ),
          );
        }
        if (studentIdMatch) {
          errors.push(
            csvError(
              row.row,
              "numero_cuenta",
              "student_id_in_use",
              "El numero_cuenta ya está asociado con otra cuenta.",
            ),
          );
        }
      }
      continue;
    }

    toCreate.push(row);
  }

  return { toCreate, toSkip, errors };
}

async function findExistingUsers(executor, rows, { lock = false } = {}) {
  if (rows.length === 0) return [];
  const emails = rows.map((row) => row.email);
  const studentIds = rows.map((row) => row.studentId);
  const result = await executor.query(
    `SELECT
       u.id, u.email, u.student_id, u.career_id, u.status,
       m.role::text AS role
     FROM users u
     LEFT JOIN memberships m
       ON m.user_id = u.id
      AND m.org_id = $1
    WHERE u.email = ANY($2::citext[])
        OR u.student_id = ANY($3::text[])
     ${lock ? "FOR UPDATE OF u" : ""}`,
    [DEFAULT_ORG_ID, emails, studentIds],
  );
  return result.rows || [];
}

function importRedisKey(importId) {
  const digest = crypto.createHash("sha256").update(importId).digest("hex");
  return `${IMPORT_KEY_PREFIX}${digest}`;
}

function getReadyRedis(getRedisClientFn) {
  const redis = getRedisClientFn();
  if (!redis) {
    throw new BulkStudentImportError(503, "redis_unavailable", "Redis no está listo.");
  }
  return redis;
}

export async function previewBulkStudentImport({
  csvText,
  importer,
  requestedCareerId,
  dependencies = {},
}) {
  const queryFn = dependencies.queryFn || query;
  const getRedisClientFn = dependencies.getRedisClientFn || getRedisClient;
  const randomBytesFn = dependencies.randomBytesFn || crypto.randomBytes;
  const targetCareerId = resolveImportCareer({
    role: importer?.role,
    careerId: importer?.careerId,
    requestedCareerId,
  });
  const parsed = parseAndValidateStudentCsv(csvText);
  if (parsed.errors.length > 0) {
    throw new BulkStudentImportError(
      422,
      "csv_validation_failed",
      "El archivo CSV contiene errores.",
      parsed.errors,
    );
  }

  const careerResult = await queryFn(
    `SELECT id FROM careers WHERE id = $1 AND id > 1 LIMIT 1`,
    [targetCareerId],
  );
  if (!careerResult.rows?.[0]) {
    throw new BulkStudentImportError(
      400,
      "target_career_not_found",
      "La carrera destino no existe.",
    );
  }

  const existingUsers = await findExistingUsers({ query: queryFn }, parsed.rows);
  const classified = classifyProvisioningRows(parsed.rows, existingUsers, targetCareerId);
  if (classified.errors.length > 0) {
    throw new BulkStudentImportError(
      422,
      "database_conflict",
      "El archivo contiene cuentas que entran en conflicto con usuarios existentes.",
      classified.errors,
    );
  }

  const importId = randomBytesFn(32).toString("base64url");
  const summary = {
    rows: parsed.rows.length,
    to_create: classified.toCreate.length,
    to_skip: classified.toSkip,
    career_id: targetCareerId,
  };
  const tokenPayload = {
    version: 2,
    importerUserId: String(importer.userId),
    targetCareerId,
    rows: parsed.rows,
    summary,
  };
  const redis = getReadyRedis(getRedisClientFn);
  await redis.set(importRedisKey(importId), JSON.stringify(tokenPayload), {
    EX: BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
  });

  return {
    ok: true,
    import_id: importId,
    expires_in: BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
    summary,
  };
}

function parseClaimedToken(rawToken) {
  try {
    const token = JSON.parse(rawToken);
    if (
      token?.version !== 2 ||
      !token.importerUserId ||
      !Number.isInteger(token.targetCareerId) ||
      !Array.isArray(token.rows) ||
      !token.summary ||
      token.rows.length > BULK_STUDENT_IMPORT_MAX_ROWS
    ) {
      throw new Error("invalid token");
    }
    return token;
  } catch {
    throw new BulkStudentImportError(
      410,
      "import_expired",
      "La vista previa expiró o ya fue utilizada.",
    );
  }
}

function assertCurrentImporter(importerRow, importerUserId, targetCareerId) {
  if (!importerRow || importerRow.status !== "active") {
    throw new BulkStudentImportError(403, "importer_not_authorized", "Administrador no autorizado.");
  }
  const resolvedCareer = resolveImportCareer({
    role: importerRow.role,
    careerId: importerRow.career_id,
    requestedCareerId: targetCareerId,
  });
  if (String(importerRow.id) !== String(importerUserId) || resolvedCareer !== targetCareerId) {
    throw new BulkStudentImportError(403, "importer_scope_changed", "El alcance del administrador cambió.");
  }
}

export async function commitBulkStudentImport({ importId, importer, dependencies = {} }) {
  const getRedisClientFn = dependencies.getRedisClientFn || getRedisClient;
  const withTransactionFn = dependencies.withTransactionFn || withTransaction;
  const randomBytesFn = dependencies.randomBytesFn || crypto.randomBytes;
  const hashPasswordFn = dependencies.hashPasswordFn || ((password) => bcrypt.hash(password, 12));

  if (!IMPORT_ID_PATTERN.test(String(importId || ""))) {
    throw new BulkStudentImportError(
      410,
      "import_expired",
      "La vista previa expiró o ya fue utilizada.",
    );
  }

  const redis = getReadyRedis(getRedisClientFn);
  const rawToken = await redis.getDel(importRedisKey(importId));
  if (!rawToken) {
    throw new BulkStudentImportError(
      410,
      "import_expired",
      "La vista previa expiró o ya fue utilizada.",
    );
  }
  const token = parseClaimedToken(rawToken);

  if (String(token.importerUserId) !== String(importer?.userId)) {
    throw new BulkStudentImportError(403, "importer_mismatch", "La vista previa pertenece a otro administrador.");
  }
  const sessionCareerId = resolveImportCareer({
    role: importer?.role,
    careerId: importer?.careerId,
    requestedCareerId: token.targetCareerId,
  });
  if (sessionCareerId !== token.targetCareerId) {
    throw new BulkStudentImportError(403, "importer_scope_changed", "El alcance del administrador cambió.");
  }

  return withTransactionFn(async (tx) => {
    const importerResult = await tx.query(
      `SELECT u.id, u.career_id, u.status, m.role::text AS role
       FROM users u
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $2
       WHERE u.id = $1
       LIMIT 1
       FOR SHARE OF u, m`,
      [token.importerUserId, DEFAULT_ORG_ID],
    );
    assertCurrentImporter(
      importerResult.rows?.[0] || null,
      token.importerUserId,
      token.targetCareerId,
    );

    const careerResult = await tx.query(
      `SELECT id FROM careers WHERE id = $1 AND id > 1 LIMIT 1 FOR SHARE`,
      [token.targetCareerId],
    );
    if (!careerResult.rows?.[0]) {
      throw new BulkStudentImportError(409, "target_career_changed", "La carrera destino ya no está disponible.");
    }

    const revalidatedUsers = await findExistingUsers(tx, token.rows, { lock: true });
    const revalidated = classifyProvisioningRows(
      token.rows,
      revalidatedUsers,
      token.targetCareerId,
    );
    if (revalidated.errors.length > 0) {
      throw new BulkStudentImportError(
        409,
        "import_conflict",
        "Los datos cambiaron después de la vista previa. No se creó ningún estudiante.",
        revalidated.errors,
      );
    }

    const rowsToInsert = [...revalidated.toCreate].sort((left, right) =>
      left.email.localeCompare(right.email, "en"),
    );
    const passwordHash = rowsToInsert.length > 0
      ? await hashPasswordFn(randomBytesFn(32).toString("base64url"))
      : null;
    let created = 0;
    let skipped = revalidated.toSkip;
    const attributes = JSON.stringify({
      provisioned_via: "csv_bulk",
      imported_by_user_id: String(token.importerUserId),
      imported_at: new Date().toISOString(),
      import_id: importId,
    });

    for (const row of rowsToInsert) {
      const inserted = await tx.query(
        `INSERT INTO users (
           email, password_hash, first_name, last_name, student_id, career_id, status, attributes
         ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          row.email,
          passwordHash,
          row.firstName,
          row.lastName,
          row.studentId,
          token.targetCareerId,
          attributes,
        ],
      );

      const createdUserId = inserted.rows?.[0]?.id;
      if (!createdUserId) {
        const concurrentUsers = await findExistingUsers(tx, [row], { lock: true });
        const concurrent = classifyProvisioningRows([row], concurrentUsers, token.targetCareerId);
        if (concurrent.errors.length > 0 || concurrent.toSkip !== 1) {
          const conflictErrors = concurrent.errors.length > 0
            ? concurrent.errors
            : [
                csvError(
                  row.row,
                  "archivo",
                  "concurrent_insert_conflict",
                  "La fila entró en conflicto con otra importación.",
                ),
              ];
          throw new BulkStudentImportError(
            409,
            "import_conflict",
            "Los datos cambiaron durante la importación. No se creó ningún estudiante.",
            conflictErrors,
          );
        }
        skipped += 1;
        continue;
      }

      await tx.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ($1, $2, $3::membership_role)`,
        [DEFAULT_ORG_ID, createdUserId, ROLES.STUDENT],
      );
      created += 1;
    }

    return { ok: true, created, skipped, career_id: token.targetCareerId };
  });
}
