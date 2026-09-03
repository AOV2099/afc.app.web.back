import { DEFAULT_ORG_ID } from "../config/appConfig.js";
import { withTransaction } from "../postgresClient.js";
import { assertTargetCareerAccess } from "./adminUserCareerScope.js";

const ACCOUNT_NUMBER_PATTERN = /^\d{8,10}$/u;
const HOURS_PATTERN = /^\d{1,3}(?:\.\d{1,2})?$/u;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/u;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISALLOWED_NOTE_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;

export class ManualHoursAdjustmentError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = "ManualHoursAdjustmentError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function normalizeAccountNumber(value) {
  const accountNumber = String(value || "").trim();
  return ACCOUNT_NUMBER_PATTERN.test(accountNumber) ? accountNumber : null;
}

export function normalizeManualHours(value) {
  const text = String(value ?? "").trim();
  if (!HOURS_PATTERN.test(text)) return null;

  const hours = Number(text);
  return Number.isFinite(hours) && hours > 0 && hours <= 100 ? hours : null;
}

export function normalizeAdjustmentCategory(value) {
  const category = String(value || "").trim().toLowerCase();
  return CATEGORY_PATTERN.test(category) ? category : null;
}

export function normalizeAdjustmentMotive(value) {
  const motive = String(value || "").trim();
  if (motive.length < 5 || motive.length > 500 || DISALLOWED_NOTE_CONTROLS.test(motive)) {
    return null;
  }
  return motive;
}

export function normalizeAdjustmentRequestId(value) {
  const requestId = String(value || "").trim().toLowerCase();
  return REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

export async function addManualAccountHours(
  { accountNumber, hours, category, motive, requestId, admin },
  { withTransactionFn = withTransaction } = {},
) {
  const normalizedAccountNumber = normalizeAccountNumber(accountNumber);
  const normalizedHours = normalizeManualHours(hours);
  const normalizedCategory = normalizeAdjustmentCategory(category);
  const normalizedMotive = normalizeAdjustmentMotive(motive);
  const normalizedRequestId = normalizeAdjustmentRequestId(requestId);

  if (!normalizedAccountNumber) {
    throw new ManualHoursAdjustmentError(
      400,
      "invalid_account_number",
      "La matrícula debe contener entre 8 y 10 dígitos.",
    );
  }
  if (normalizedHours === null) {
    throw new ManualHoursAdjustmentError(
      400,
      "invalid_hours",
      "Las horas deben ser mayores a 0, no exceder 100 y tener máximo 2 decimales.",
    );
  }
  if (!normalizedCategory) {
    throw new ManualHoursAdjustmentError(
      400,
      "invalid_category",
      "Selecciona una categoría válida.",
    );
  }
  if (!normalizedMotive) {
    throw new ManualHoursAdjustmentError(
      400,
      "invalid_motive",
      "El motivo debe contener entre 5 y 500 caracteres.",
    );
  }
  if (!normalizedRequestId) {
    throw new ManualHoursAdjustmentError(
      400,
      "invalid_request_id",
      "La clave de la operación no es válida.",
    );
  }

  return withTransactionFn(async (tx) => {
    const targetResult = await tx.query(
      `SELECT
         u.id,
         u.student_id,
         u.career_id,
         u.status,
         m.role::text AS role
       FROM users u
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $2
       WHERE u.student_id = $1
       LIMIT 1
       FOR UPDATE OF u`,
      [normalizedAccountNumber, DEFAULT_ORG_ID],
    );

    const target = targetResult.rows?.[0] ?? null;
    if (!target) {
      throw new ManualHoursAdjustmentError(
        404,
        "account_not_found",
        "No se encontró un usuario con ese número de cuenta.",
      );
    }

    assertTargetCareerAccess(admin, target.career_id);

    if (target.status !== "active") {
      throw new ManualHoursAdjustmentError(
        409,
        "user_inactive",
        "No se pueden agregar horas a un usuario inactivo.",
      );
    }

    const categoryResult = await tx.query(
      `SELECT key
       FROM event_categories
       WHERE key = $1
       LIMIT 1`,
      [normalizedCategory],
    );
    if (!categoryResult.rows?.[0]) {
      throw new ManualHoursAdjustmentError(
        400,
        "invalid_category",
        "La categoría seleccionada no existe.",
      );
    }

    const insertResult = await tx.query(
      `INSERT INTO hours_ledger (
         user_id,
         event_id,
         hours_delta,
         reason,
         source_checkin_id,
         created_by,
         note,
         category,
         request_id
       )
       VALUES ($1, NULL, $2, 'adjustment'::ledger_reason, NULL, $3, $4, $5, $6::uuid)
      ON CONFLICT (request_id) WHERE request_id IS NOT NULL DO NOTHING
       RETURNING id, user_id, hours_delta, reason::text AS reason, note, category, created_at, request_id`,
      [target.id, normalizedHours, admin.userId, normalizedMotive, normalizedCategory, normalizedRequestId],
    );

    let entry = insertResult.rows?.[0] ?? null;
    let created = true;
    if (!entry) {
      created = false;
      const existingResult = await tx.query(
        `SELECT id, user_id, hours_delta, reason::text AS reason, note, category, created_at, request_id,
                created_by
         FROM hours_ledger
         WHERE request_id = $1::uuid
         LIMIT 1`,
        [normalizedRequestId],
      );
      entry = existingResult.rows?.[0] ?? null;

      if (
        !entry ||
        String(entry.user_id) !== String(target.id) ||
        String(entry.created_by) !== String(admin.userId) ||
        Number(entry.hours_delta) !== normalizedHours ||
        entry.category !== normalizedCategory ||
        entry.note !== normalizedMotive
      ) {
        throw new ManualHoursAdjustmentError(
          409,
          "request_id_conflict",
          "La clave de la operación ya fue utilizada con datos diferentes.",
        );
      }
    }

    const balanceResult = await tx.query(
      `SELECT COALESCE(SUM(hours_delta), 0)::numeric(10,2) AS total_hours
       FROM hours_ledger
       WHERE user_id = $1`,
      [target.id],
    );

    return {
      created,
      account_number: normalizedAccountNumber,
      hours_added: Number(entry.hours_delta),
      total_hours: Number(balanceResult.rows?.[0]?.total_hours ?? 0),
      entry: {
        id: entry.id,
        hours_delta: Number(entry.hours_delta),
        reason: entry.reason,
        category: entry.category,
        note: entry.note,
        created_at: entry.created_at,
        request_id: entry.request_id,
      },
    };
  });
}