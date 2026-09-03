import crypto from "node:crypto";
import { parse } from "csv-parse/sync";

import {
  BULK_STUDENT_IMPORT_MAX_ROWS,
  BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
  DEFAULT_ORG_ID,
  ROLES,
} from "../config/appConfig.js";
import { query, withTransaction } from "../postgresClient.js";
import { getRedisClient } from "../redisClient.js";
import { assertTargetCareerAccess, normalizeCareerId } from "./adminUserCareerScope.js";
import {
  normalizeAccountNumber,
  normalizeAdjustmentCategory,
  normalizeAdjustmentMotive,
  normalizeManualHours,
} from "./manualHoursAdjustmentService.js";

export const HOURS_CSV_HEADERS = Object.freeze(["numero_cuenta", "horas", "motivo"]);

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const FORMULA_PREFIX_PATTERN = /^[=+\-@]/u;
const IMPORT_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const IMPORT_KEY_PREFIX = "bulk-hours-import:";

export class BulkHoursImportError extends Error {
  constructor(status, code, message, errors = undefined) {
    super(message);
    this.name = "BulkHoursImportError";
    this.status = status;
    this.code = code;
    this.errors = errors;
  }
}

function csvError(row, field, code, message) {
  return { row, field, code, message };
}

function validateImporter(importer) {
  const careerId = normalizeCareerId(importer?.careerId);
  if (importer?.role !== ROLES.ADMIN) {
    throw new BulkHoursImportError(403, "admin_required", "Se requiere rol admin.");
  }
  if (careerId === null) {
    throw new BulkHoursImportError(
      403,
      "admin_career_required",
      "El administrador debe tener una carrera válida.",
    );
  }
  return careerId;
}

function validateHeaders(headers) {
  const actual = headers.map((header) => String(header ?? ""));
  if (
    actual.length !== HOURS_CSV_HEADERS.length ||
    actual.some((header, index) => header !== HOURS_CSV_HEADERS[index])
  ) {
    return [
      csvError(
        1,
        "encabezados",
        "invalid_headers",
        `Los encabezados deben ser exactamente: ${HOURS_CSV_HEADERS.join(",")}.`,
      ),
    ];
  }
  return [];
}

function validateSafeValue(value, row, field, errors) {
  const raw = String(value ?? "");
  const trimmed = raw.trim();
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    errors.push(csvError(row, field, "control_character", `${field} contiene caracteres de control.`));
  }
  if (FORMULA_PREFIX_PATTERN.test(trimmed)) {
    errors.push(csvError(row, field, "formula_not_allowed", `${field} no puede iniciar con una fórmula.`));
  }
}

export function parseAndValidateHoursCsv(
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
    return { rows: [], errors: [csvError(1, "archivo", "csv_empty", "El archivo CSV está vacío.")] };
  }

  const headerErrors = validateHeaders(records[0]?.record || []);
  if (headerErrors.length > 0) return { rows: [], errors: headerErrors };

  const dataRecords = records.slice(1);
  if (dataRecords.length === 0) {
    return {
      rows: [],
      errors: [csvError(2, "archivo", "csv_no_data_rows", "El CSV debe contener al menos una fila.")],
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
          `El archivo no puede contener más de ${maxRows} filas.`,
        ),
      ],
    };
  }

  const rows = [];
  const errors = [];
  const seen = new Set();

  dataRecords.forEach(({ record }, index) => {
    const rowNumber = index + 2;
    const values = record.map((value) => String(value ?? "").trim());
    const [rawAccount, rawHours, rawMotive] = values;

    validateSafeValue(rawAccount, rowNumber, "numero_cuenta", errors);
    validateSafeValue(rawHours, rowNumber, "horas", errors);
    validateSafeValue(rawMotive, rowNumber, "motivo", errors);

    const accountNumber = normalizeAccountNumber(rawAccount);
    const hours = normalizeManualHours(rawHours);
    const motive = normalizeAdjustmentMotive(rawMotive);

    if (!accountNumber) {
      errors.push(
        csvError(
          rowNumber,
          "numero_cuenta",
          "invalid_account_number",
          "numero_cuenta debe contener entre 8 y 10 dígitos.",
        ),
      );
    }
    if (hours === null) {
      errors.push(
        csvError(
          rowNumber,
          "horas",
          "invalid_hours",
          "horas debe ser mayor a 0, no exceder 100 y tener máximo 2 decimales.",
        ),
      );
    }
    if (!motive) {
      errors.push(
        csvError(
          rowNumber,
          "motivo",
          "invalid_motive",
          "motivo debe contener entre 5 y 500 caracteres.",
        ),
      );
    }

    if (accountNumber) {
      if (seen.has(accountNumber)) {
        errors.push(
          csvError(
            rowNumber,
            "numero_cuenta",
            "duplicate_adjustment",
            "numero_cuenta está duplicado dentro del CSV.",
          ),
        );
      }
      seen.add(accountNumber);
    }

    rows.push({ row: rowNumber, accountNumber, hours, motive });
  });

  return { rows, errors };
}

async function loadTargets(executor, rows, { lock = false } = {}) {
  const accountNumbers = [...new Set(rows.map((row) => row.accountNumber).filter(Boolean))];
  if (accountNumbers.length === 0) return [];
  const result = await executor.query(
    `SELECT u.id, u.student_id, u.career_id, u.status
     FROM users u
     JOIN memberships m
       ON m.user_id = u.id
      AND m.org_id = $1
     WHERE u.student_id = ANY($2::text[])
     ${lock ? "FOR UPDATE OF u" : ""}`,
    [DEFAULT_ORG_ID, accountNumbers],
  );
  return result.rows || [];
}

async function loadCategory(executor, category) {
  const result = await executor.query(
    `SELECT key FROM event_categories WHERE key = $1 LIMIT 1`,
    [category],
  );
  return result.rows?.[0] ?? null;
}

function validateRowsAgainstDatabase(rows, targets, importer) {
  const byAccount = new Map(targets.map((target) => [String(target.student_id), target]));
  const errors = [];
  const validatedRows = [];

  for (const row of rows) {
    const target = byAccount.get(row.accountNumber) || null;
    if (!target) {
      errors.push(
        csvError(row.row, "numero_cuenta", "account_not_found", "No existe un usuario con ese número de cuenta."),
      );
      continue;
    }
    if (target.status !== "active") {
      errors.push(csvError(row.row, "numero_cuenta", "user_inactive", "El usuario está inactivo."));
      continue;
    }
    try {
      assertTargetCareerAccess(importer, target.career_id);
    } catch {
      errors.push(
        csvError(
          row.row,
          "numero_cuenta",
          "career_scope_mismatch",
          "El usuario no pertenece a la carrera administrada.",
        ),
      );
      continue;
    }
    validatedRows.push({ ...row, userId: String(target.id), careerId: Number(target.career_id) });
  }

  return { rows: validatedRows, errors };
}

function importRedisKey(importId) {
  const digest = crypto.createHash("sha256").update(importId).digest("hex");
  return `${IMPORT_KEY_PREFIX}${digest}`;
}

function getReadyRedis(getRedisClientFn) {
  const redis = getRedisClientFn();
  if (!redis) throw new BulkHoursImportError(503, "redis_unavailable", "Redis no está listo.");
  return redis;
}

export async function previewBulkHoursImport({ csvText, category, importer, dependencies = {} }) {
  const queryFn = dependencies.queryFn || query;
  const getRedisClientFn = dependencies.getRedisClientFn || getRedisClient;
  const randomBytesFn = dependencies.randomBytesFn || crypto.randomBytes;
  const randomUuidFn = dependencies.randomUuidFn || crypto.randomUUID;
  const importerCareerId = validateImporter(importer);
  const normalizedCategory = normalizeAdjustmentCategory(category);
  if (!normalizedCategory) {
    throw new BulkHoursImportError(400, "invalid_category", "Selecciona una categoría válida.");
  }

  const parsed = parseAndValidateHoursCsv(csvText);
  if (parsed.errors.length > 0) {
    throw new BulkHoursImportError(422, "csv_validation_failed", "El CSV contiene errores.", parsed.errors);
  }

  const [targets, categoryRow] = await Promise.all([
    loadTargets({ query: queryFn }, parsed.rows),
    loadCategory({ query: queryFn }, normalizedCategory),
  ]);
  if (!categoryRow) {
    throw new BulkHoursImportError(400, "invalid_category", "La categoría seleccionada no existe.");
  }
  const validated = validateRowsAgainstDatabase(parsed.rows, targets, importer);
  if (validated.errors.length > 0) {
    throw new BulkHoursImportError(
      422,
      "database_validation_failed",
      "El CSV contiene cuentas o categorías no válidas.",
      validated.errors,
    );
  }

  const tokenRows = validated.rows.map((row) => ({ ...row, requestId: randomUuidFn() }));
  const importId = randomBytesFn(32).toString("base64url");
  const summary = {
    rows: tokenRows.length,
    users: new Set(tokenRows.map((row) => row.userId)).size,
    total_hours: tokenRows.reduce((sum, row) => sum + row.hours, 0),
  };
  const token = {
    version: 1,
    importerUserId: String(importer.userId),
    importerCareerId,
    category: normalizedCategory,
    rows: tokenRows,
    summary,
  };
  const redis = getReadyRedis(getRedisClientFn);
  await redis.set(importRedisKey(importId), JSON.stringify(token), {
    EX: BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
  });

  return {
    ok: true,
    import_id: importId,
    expires_in: BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS,
    summary,
  };
}

function parseToken(rawToken) {
  try {
    const token = JSON.parse(rawToken);
    if (
      token?.version !== 1 ||
      !token.importerUserId ||
      !Number.isInteger(token.importerCareerId) ||
      !normalizeAdjustmentCategory(token.category) ||
      !Array.isArray(token.rows) ||
      token.rows.length === 0 ||
      token.rows.length > BULK_STUDENT_IMPORT_MAX_ROWS ||
      token.rows.some((row) => !normalizeAdjustmentMotive(row?.motive))
    ) {
      throw new Error("invalid token");
    }
    return token;
  } catch {
    throw new BulkHoursImportError(410, "import_expired", "La vista previa expiró o ya fue utilizada.");
  }
}

export async function commitBulkHoursImport({ importId, importer, dependencies = {} }) {
  const getRedisClientFn = dependencies.getRedisClientFn || getRedisClient;
  const withTransactionFn = dependencies.withTransactionFn || withTransaction;
  if (!IMPORT_ID_PATTERN.test(String(importId || ""))) {
    throw new BulkHoursImportError(410, "import_expired", "La vista previa expiró o ya fue utilizada.");
  }

  const sessionCareerId = validateImporter(importer);
  const redis = getReadyRedis(getRedisClientFn);
  const rawToken = await redis.getDel(importRedisKey(importId));
  if (!rawToken) {
    throw new BulkHoursImportError(410, "import_expired", "La vista previa expiró o ya fue utilizada.");
  }
  const token = parseToken(rawToken);
  if (
    String(token.importerUserId) !== String(importer?.userId) ||
    token.importerCareerId !== sessionCareerId
  ) {
    throw new BulkHoursImportError(403, "importer_scope_changed", "El alcance del administrador cambió.");
  }

  return withTransactionFn(async (tx) => {
    const importerResult = await tx.query(
      `SELECT u.id, u.career_id, u.status, m.role::text AS role
       FROM users u
       JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
       WHERE u.id = $1
       LIMIT 1
       FOR SHARE OF u, m`,
      [token.importerUserId, DEFAULT_ORG_ID],
    );
    const currentImporter = importerResult.rows?.[0] || null;
    if (
      !currentImporter ||
      currentImporter.status !== "active" ||
      currentImporter.role !== ROLES.ADMIN ||
      normalizeCareerId(currentImporter.career_id) !== token.importerCareerId
    ) {
      throw new BulkHoursImportError(403, "importer_scope_changed", "El alcance del administrador cambió.");
    }

    const [targets, categoryRow] = await Promise.all([
      loadTargets(tx, token.rows, { lock: true }),
      loadCategory(tx, token.category),
    ]);
    if (!categoryRow) {
      throw new BulkHoursImportError(409, "import_conflict", "La categoría ya no está disponible.");
    }
    const revalidated = validateRowsAgainstDatabase(token.rows, targets, {
      role: currentImporter.role,
      careerId: currentImporter.career_id,
    });
    if (revalidated.errors.length > 0) {
      throw new BulkHoursImportError(
        409,
        "import_conflict",
        "Los datos cambiaron después de la vista previa. No se agregaron horas.",
        revalidated.errors,
      );
    }

    let adjusted = 0;
    let totalHours = 0;
    for (const row of token.rows) {
      const inserted = await tx.query(
        `INSERT INTO hours_ledger (
           user_id, event_id, hours_delta, reason, source_checkin_id,
           created_by, note, category, request_id
         )
         VALUES ($1, NULL, $2, 'adjustment'::ledger_reason, NULL, $3, $4, $5, $6::uuid)
         ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [row.userId, row.hours, token.importerUserId, row.motive, token.category, row.requestId],
      );
      if (!inserted.rows?.[0]) {
        throw new BulkHoursImportError(
          409,
          "import_conflict",
          "La importación ya fue procesada parcialmente. No se agregaron horas.",
        );
      }
      adjusted += 1;
      totalHours += row.hours;
    }

    return {
      ok: true,
      adjusted,
      users: token.summary.users,
      total_hours: totalHours,
    };
  });
}