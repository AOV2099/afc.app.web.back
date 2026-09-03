import express, { Router } from "express";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";

import { query, withTransaction } from "../postgresClient.js";
import { requireAuth, requireCareerAdmin } from "../middleware/auth.js";
import { createOAuthRateLimit } from "../middleware/oauthRateLimit.js";
import {
  ALLOWED_MEMBERSHIP_ROLES,
  BULK_STUDENT_IMPORT_MAX_FILE_BYTES,
  DEFAULT_ORG_ID,
  ROLES,
} from "../config/appConfig.js";
import {
  BulkStudentImportError,
  commitBulkStudentImport,
  previewBulkStudentImport,
} from "../services/bulkStudentImportService.js";
import {
  BulkHoursImportError,
  commitBulkHoursImport,
  previewBulkHoursImport,
} from "../services/bulkHoursImportService.js";
import {
  addManualAccountHours,
  ManualHoursAdjustmentError,
} from "../services/manualHoursAdjustmentService.js";
import {
  assertRequestedCareerAccess,
  buildAdminCareerFilter,
  getScopedAdminCareerId,
  lockAdminUserTarget,
  normalizeCareerId,
  resolveAdminUserListCareerFilter,
  resolveEffectiveCreateCareer,
} from "../services/adminUserCareerScope.js";

const router = Router();
const csvTextParser = express.text({
  type: "text/csv",
  limit: BULK_STUDENT_IMPORT_MAX_FILE_BYTES,
});
const limitStudentImportPreview = createOAuthRateLimit({
  limit: 10,
  windowMs: 60_000,
  scope: "bulk-student-import-preview",
  code: "bulk_student_import_preview_rate_limited",
  message: "Demasiadas validaciones de archivos CSV. Espera un minuto e intenta nuevamente.",
});
const limitStudentImportCommit = createOAuthRateLimit({
  limit: 20,
  windowMs: 60_000,
  scope: "bulk-student-import-commit",
  code: "bulk_student_import_commit_rate_limited",
  message: "Demasiadas importaciones de estudiantes. Espera un minuto e intenta nuevamente.",
});
const limitManualHoursAdjustment = createOAuthRateLimit({
  limit: 30,
  windowMs: 60_000,
  scope: "manual-hours-adjustment",
  code: "manual_hours_adjustment_rate_limited",
  message: "Demasiados ajustes de horas. Espera un minuto e intenta nuevamente.",
});
const limitHoursImportPreview = createOAuthRateLimit({
  limit: 10,
  windowMs: 60_000,
  scope: "bulk-hours-import-preview",
  code: "bulk_hours_import_preview_rate_limited",
  message: "Demasiadas validaciones de horas. Espera un minuto e intenta nuevamente.",
});
const limitHoursImportCommit = createOAuthRateLimit({
  limit: 20,
  windowMs: 60_000,
  scope: "bulk-hours-import-commit",
  code: "bulk_hours_import_commit_rate_limited",
  message: "Demasiadas cargas de horas. Espera un minuto e intenta nuevamente.",
});

const CAREER_INPUT_KEYS = ["career_id", "careerId", "carrera_id", "carreraId"];
const ADMIN_USER_SORT_FIELDS = Object.freeze({
  name: "LOWER(CONCAT_WS(' ', u.first_name, u.last_name))",
  email: "LOWER(u.email)",
  account: "u.student_id",
  hours: "COALESCE(hb.hours_total, 0)",
  career: "LOWER(COALESCE(c.name, ''))",
  status: "u.status",
  role: "m.role::text",
});

export function resolveAdminUserOrder(sortBy, sortDirection) {
  const normalizedSortBy = String(sortBy || "").trim().toLowerCase();
  const normalizedDirection = String(sortDirection || "").trim().toLowerCase();

  if (!normalizedSortBy) return "u.id DESC";
  if (!Object.hasOwn(ADMIN_USER_SORT_FIELDS, normalizedSortBy)) return null;
  if (normalizedDirection && normalizedDirection !== "asc" && normalizedDirection !== "desc") {
    return null;
  }

  const direction = normalizedDirection === "desc" ? "DESC" : "ASC";
  return `${ADMIN_USER_SORT_FIELDS[normalizedSortBy]} ${direction} NULLS LAST, u.id DESC`;
}

function readCareerInput(body) {
  const key = CAREER_INPUT_KEYS.find((candidate) =>
    Object.prototype.hasOwnProperty.call(body ?? {}, candidate));
  return key ? { provided: true, value: body[key] } : { provided: false, value: undefined };
}

function sendScopeError(res, error) {
  return res.status(error.statusCode).json({
    ok: false,
    code: error.code,
    message: error.message,
  });
}

function parseStudentCsvBody(req, res, next) {
  if (!req.is("text/csv")) {
    return res.status(415).json({
      ok: false,
      code: "content_type_not_supported",
      message: "Content-Type debe ser text/csv.",
    });
  }

  return csvTextParser(req, res, (error) => {
    if (!error) return next();
    if (error?.type === "entity.too.large") {
      return res.status(413).json({
        ok: false,
        code: "csv_too_large",
        message: "El archivo CSV excede el límite permitido de 2 MB.",
      });
    }
    return res.status(400).json({
      ok: false,
      code: "csv_body_invalid",
      message: "No se pudo leer el archivo CSV.",
    });
  });
}

export function sendBulkImportError(res, error, operation) {
  if (error instanceof BulkStudentImportError) {
    const payload = { ok: false, code: error.code, message: error.message };
    if (Array.isArray(error.errors) && error.errors.length > 0) {
      payload.errors = error.errors;
    }
    return res.status(error.status).json(payload);
  }

  console.error(`Error en importación CSV (${operation}):`, error?.code || error?.name || "error");
  return res.status(500).json({
    ok: false,
    code: "bulk_student_import_failed",
    message: "No se pudo procesar la importación de estudiantes.",
  });
}

function sendBulkHoursImportError(res, error, operation) {
  if (error instanceof BulkHoursImportError) {
    const payload = { ok: false, code: error.code, message: error.message };
    if (Array.isArray(error.errors) && error.errors.length > 0) payload.errors = error.errors;
    return res.status(error.status).json(payload);
  }

  console.error(`Error en carga masiva de horas (${operation}):`, error?.code || error?.name || "error");
  return res.status(500).json({
    ok: false,
    code: "bulk_hours_import_failed",
    message: "No se pudo procesar la carga de horas.",
  });
}

export function logBulkStudentImportSuccess({ importerUserId, importId, result, logger = console }) {
  const importIdHash = crypto.createHash("sha256").update(String(importId)).digest("hex");
  logger.info(JSON.stringify({
    event: "bulk_student_import_committed",
    importer_user_id: String(importerUserId),
    target_career_id: Number(result.career_id),
    created: Number(result.created),
    skipped: Number(result.skipped),
    import_id_hash: importIdHash,
  }));
}

router.post(
  "/api/admin/users/import/preview",
  requireAuth,
  requireCareerAdmin,
  limitStudentImportPreview,
  parseStudentCsvBody,
  async (req, res) => {
    try {
      const result = await previewBulkStudentImport({
        csvText: req.body,
        importer: req.auth,
        requestedCareerId: req.query?.career_id,
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendBulkImportError(res, error, "preview");
    }
  },
);

router.post(
  "/api/admin/users/import/:importId/commit",
  requireAuth,
  requireCareerAdmin,
  limitStudentImportCommit,
  async (req, res) => {
    try {
      const result = await commitBulkStudentImport({
        importId: String(req.params.importId || ""),
        importer: req.auth,
      });
      logBulkStudentImportSuccess({
        importerUserId: req.auth.userId,
        importId: req.params.importId,
        result,
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendBulkImportError(res, error, "commit");
    }
  },
);

router.post(
  "/api/admin/users/account/:accountNumber/hours",
  requireAuth,
  requireCareerAdmin,
  limitManualHoursAdjustment,
  async (req, res) => {
    try {
      const result = await addManualAccountHours({
        accountNumber: req.params.accountNumber,
        hours: req.body?.hours,
        category: req.body?.category,
        motive: req.body?.motive,
        requestId: req.body?.requestId,
        admin: req.auth,
      });

      return res.status(result.created ? 201 : 200).json({
        ok: true,
        message: result.created
          ? "Horas agregadas correctamente."
          : "El ajuste ya había sido registrado.",
        adjustment: result,
      });
    } catch (error) {
      if (error instanceof ManualHoursAdjustmentError) {
        return res.status(error.statusCode).json({
          ok: false,
          code: error.code,
          message: error.message,
        });
      }
      if (error?.statusCode === 403 || error?.statusCode === 404) {
        return sendScopeError(res, error);
      }

      console.error(
        "Error en POST /api/admin/users/account/:accountNumber/hours:",
        error?.code || error?.name || "manual_hours_adjustment_failed",
      );
      return res.status(500).json({
        ok: false,
        code: "manual_hours_adjustment_failed",
        message: "No se pudieron agregar las horas.",
      });
    }
  },
);

router.post(
  "/api/admin/users/hours/import/preview",
  requireAuth,
  requireCareerAdmin,
  limitHoursImportPreview,
  parseStudentCsvBody,
  async (req, res) => {
    try {
      const result = await previewBulkHoursImport({
        csvText: req.body,
        category: req.query?.category,
        importer: req.auth,
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendBulkHoursImportError(res, error, "preview");
    }
  },
);

router.post(
  "/api/admin/users/hours/import/:importId/commit",
  requireAuth,
  requireCareerAdmin,
  limitHoursImportCommit,
  async (req, res) => {
    try {
      const result = await commitBulkHoursImport({
        importId: String(req.params.importId || ""),
        importer: req.auth,
      });
      return res.status(200).json(result);
    } catch (error) {
      return sendBulkHoursImportError(res, error, "commit");
    }
  },
);

router.get("/api/admin/users", requireAuth, requireCareerAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize || 20)));
  const q = String(req.query?.q || "").trim();
  const status = req.query?.status ? String(req.query.status).trim() : undefined;
  const role = req.query?.role ? String(req.query.role).trim() : undefined;
  const orderBy = resolveAdminUserOrder(req.query?.sortBy, req.query?.sortDirection);

  if (role !== undefined && !ALLOWED_MEMBERSHIP_ROLES.has(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido." });
  }
  if (!orderBy) {
    return res.status(400).json({ ok: false, message: "Ordenamiento inválido." });
  }

  const filters = [];
  const params = [DEFAULT_ORG_ID];

  try {
    const careerFilter = resolveAdminUserListCareerFilter(
      req.auth,
      req.query?.career_id,
      params.length + 1,
    );
    if (careerFilter.clause) filters.push(careerFilter.clause);
    params.push(...careerFilter.params);
  } catch (error) {
    return sendScopeError(res, error);
  }

  if (q) {
    const idx = params.length + 1;
    filters.push(
      `(u.email ILIKE $${idx} OR u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR COALESCE(u.student_id, '') ILIKE $${idx} OR COALESCE(c.name, '') ILIKE $${idx})`,
    );
    params.push(`%${q}%`);
  }

  if (status) {
    const idx = params.length + 1;
    filters.push(`u.status = $${idx}`);
    params.push(status);
  }

  if (role) {
    const idx = params.length + 1;
    filters.push(`m.role::text = $${idx}`);
    params.push(role);
  }

  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

  try {
    const countResult = await query(
      `SELECT COUNT(*)::int AS total
       FROM users u
       LEFT JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $1
       LEFT JOIN careers c ON c.id = u.career_id
       ${whereSql}`,
      params,
    );

    const total = countResult.rows?.[0]?.total ?? 0;

    const listParams = [...params, pageSize, offset];
    const limitIdx = listParams.length - 1;
    const offsetIdx = listParams.length;

    const listResult = await query(
      `SELECT
         u.id,
         u.email,
         u.first_name,
         u.last_name,
         u.student_id,
         u.career_id,
         u.status,
         u.created_at,
         COALESCE(hb.hours_total, 0)::numeric(10,2) AS hours_total,
         c.name AS career_name,
         c.faculty AS career_faculty,
         m.role::text AS role
       FROM users u
       LEFT JOIN careers c ON c.id = u.career_id
       LEFT JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $1
       LEFT JOIN v_user_hours_balance hb ON hb.user_id = u.id
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${limitIdx}
       OFFSET $${offsetIdx}`,
      listParams,
    );

    return res.status(200).json({
      ok: true,
      users: listResult.rows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  } catch (err) {
    console.error("Error en GET /api/admin/users:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo consultar usuarios.",
    });
  }
});

router.get("/api/admin/staff-users", requireAuth, requireCareerAdmin, async (req, res) => {
  try {
    const params = [DEFAULT_ORG_ID, ROLES.STAFF];
    const careerScope = buildAdminCareerFilter(req.auth, params.length + 1);
    const whereSql = careerScope.clause ? `WHERE ${careerScope.clause}` : "";
    params.push(...careerScope.params);

    const result = await query(
      `SELECT
         u.id,
         u.email,
         COALESCE(
           json_agg(
             json_build_object(
               'id', e.id,
               'title', e.title,
               'starts_at', e.starts_at,
               'status', e.status
             )
           ) FILTER (WHERE e.id IS NOT NULL),
           '[]'::json
         ) AS events
       FROM users u
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $1
        AND m.role::text = $2
       LEFT JOIN events e
         ON e.org_id = $1
        AND (
          CASE
            WHEN e.attributes ? 'staff_user_id'
             AND (e.attributes->>'staff_user_id') ~ '^[0-9]+$'
              THEN (e.attributes->>'staff_user_id')::bigint
            ELSE NULL
          END
        ) = u.id
       ${whereSql}
       GROUP BY u.id, u.email
       ORDER BY u.id DESC`,
      params,
    );

    return res.status(200).json({
      ok: true,
      staff_users: result.rows,
    });
  } catch (err) {
    console.error("Error en GET /api/admin/staff-users:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar usuarios staff.",
    });
  }
});

router.post("/api/admin/users", requireAuth, requireCareerAdmin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  const firstName = String(req.body?.firstName ?? req.body?.nombre ?? "").trim();
  const lastName = String(req.body?.lastName ?? req.body?.apellido ?? "").trim();
  const studentId = req.body?.studentId ? String(req.body.studentId).trim() : null;
  const careerInput = readCareerInput(req.body);
  const status = req.body?.status ? String(req.body.status).trim() : "active";
  const role = String(req.body?.role || ROLES.STUDENT).trim();
  const emailVerifiedInput = req.body?.email_verified ?? req.body?.emailVerified;
  const emailVerifiedAtInput = req.body?.email_verified_at ?? req.body?.emailVerifiedAt;

  let careerId;

  if (!email || !password || !firstName || !lastName) {
    return res.status(400).json({
      ok: false,
      message: "Campos requeridos: email, password, firstName y lastName.",
    });
  }

  if (!email.includes("@")) {
    return res.status(400).json({ ok: false, message: "Email inválido." });
  }

  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      message: "La contraseña debe tener al menos 8 caracteres.",
    });
  }

  if (!ALLOWED_MEMBERSHIP_ROLES.has(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido." });
  }

  try {
    careerId = resolveEffectiveCreateCareer(req.auth, careerInput);
  } catch (error) {
    return sendScopeError(res, error);
  }

  try {
    const user = await withTransaction(async (tx) => {
      if (careerId !== null) {
        if (!Number.isInteger(careerId) || careerId <= 0) {
          const validationError = new Error("career_id inválido.");
          validationError.statusCode = 400;
          throw validationError;
        }

        const careerExists = await tx.query(
          `SELECT id FROM careers WHERE id = $1 LIMIT 1`,
          [careerId],
        );
        if (!careerExists.rows?.[0]) {
          const validationError = new Error("La carrera indicada no existe.");
          validationError.statusCode = 400;
          throw validationError;
        }
      }

      let emailVerifiedAt = null;
      if (emailVerifiedAtInput !== undefined && emailVerifiedAtInput !== null) {
        const parsed = new Date(emailVerifiedAtInput);
        if (Number.isNaN(parsed.getTime())) {
          const validationError = new Error("email_verified_at inválido.");
          validationError.statusCode = 400;
          throw validationError;
        }
        emailVerifiedAt = parsed;
      } else if (emailVerifiedInput === true) {
        emailVerifiedAt = new Date();
      }

      const passwordHash = await bcrypt.hash(password, 12);

      const userInsert = await tx.query(
        `INSERT INTO users (
          email,
          password_hash,
          email_verified_at,
          first_name,
          last_name,
          student_id,
          career_id,
          status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id, email, first_name, last_name, student_id, career_id, status, created_at`,
        [
          email,
          passwordHash,
          emailVerifiedAt,
          firstName,
          lastName,
          studentId,
          careerId,
          status,
        ],
      );

      const createdUser = userInsert.rows[0];

      await tx.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ($1, $2, $3::membership_role)
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [DEFAULT_ORG_ID, createdUser.id, role],
      );

      const careerRow =
        createdUser.career_id === null
          ? null
          : (
              await tx.query(
                `SELECT name, faculty FROM careers WHERE id = $1 LIMIT 1`,
                [createdUser.career_id],
              )
            ).rows?.[0] ?? null;

      return {
        ...createdUser,
        career_name: careerRow?.name ?? null,
        career_faculty: careerRow?.faculty ?? null,
      };
    });

    return res.status(201).json({
      ok: true,
      message: "Usuario creado correctamente.",
      user: { ...user, role },
    });
  } catch (err) {
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (err?.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Ya existe un usuario con ese email o matrícula.",
      });
    }

    console.error("Error en POST /api/admin/users:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo crear el usuario." });
  }
});

router.put("/api/admin/users/:userId", requireAuth, requireCareerAdmin, async (req, res) => {
  const userId = Number(req.params.userId);

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, message: "userId inválido." });
  }

  const email =
    req.body?.email !== undefined
      ? String(req.body.email || "").trim().toLowerCase()
      : undefined;
  const firstName =
    req.body?.firstName !== undefined ? String(req.body.firstName || "").trim() : undefined;
  const lastName =
    req.body?.lastName !== undefined ? String(req.body.lastName || "").trim() : undefined;
  const studentId =
    req.body?.studentId !== undefined
      ? req.body.studentId === null
        ? null
        : String(req.body.studentId || "").trim()
      : undefined;
  const careerInput = readCareerInput(req.body);
  const status =
    req.body?.status !== undefined ? String(req.body.status || "").trim() : undefined;
  const role = req.body?.role !== undefined ? String(req.body.role || "").trim() : undefined;
  const careerId = careerInput.provided ? normalizeCareerId(careerInput.value) : undefined;

  if (email !== undefined && (!email || !email.includes("@"))) {
    return res.status(400).json({ ok: false, message: "Email inválido." });
  }
  if (
    careerInput.provided &&
    careerInput.value !== null &&
    String(careerInput.value).trim() !== "" &&
    careerId === null &&
    getScopedAdminCareerId(req.auth) === null
  ) {
    return res.status(400).json({ ok: false, message: "career_id inválido." });
  }
  if (role !== undefined && !ALLOWED_MEMBERSHIP_ROLES.has(role)) {
    return res.status(400).json({
      ok: false,
      message: "Rol inválido. Usa: student, staff, admin o auditor.",
    });
  }

  const hasUserUpdate =
    email !== undefined ||
    firstName !== undefined ||
    lastName !== undefined ||
    studentId !== undefined ||
    careerInput.provided ||
    status !== undefined;

  if (!hasUserUpdate && role === undefined) {
    return res.status(400).json({ ok: false, message: "No hay cambios para actualizar." });
  }

  try {
    const finalUser = await withTransaction(async (tx) => {
      const targetUser = await lockAdminUserTarget(tx, req.auth, userId, {
        includeAttributes: true,
      });
      assertRequestedCareerAccess(req.auth, careerInput);

      const attributes = targetUser.attributes ?? null;
      if (attributes && attributes.event_staff === true) {
        const forbiddenError = new Error("No se puede editar un usuario staff ligado a evento.");
        forbiddenError.statusCode = 403;
        throw forbiddenError;
      }

      if (careerInput.provided && careerId !== null) {
        const careerExists = await tx.query(
          `SELECT id FROM careers WHERE id = $1 LIMIT 1`,
          [careerId],
        );
        if (!careerExists.rows?.[0]) {
          const validationError = new Error("La carrera indicada no existe.");
          validationError.statusCode = 400;
          throw validationError;
        }
      }

      if (hasUserUpdate) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (email !== undefined) {
          fields.push(`email = $${idx++}`);
          values.push(email);
        }
        if (firstName !== undefined) {
          fields.push(`first_name = $${idx++}`);
          values.push(firstName);
        }
        if (lastName !== undefined) {
          fields.push(`last_name = $${idx++}`);
          values.push(lastName);
        }
        if (studentId !== undefined) {
          fields.push(`student_id = $${idx++}`);
          values.push(studentId);
        }
        if (careerInput.provided) {
          fields.push(`career_id = $${idx++}`);
          values.push(careerId);
        }
        if (status !== undefined) {
          fields.push(`status = $${idx++}`);
          values.push(status);
        }

        fields.push(`updated_at = now()`);
        values.push(userId);

        await tx.query(
          `UPDATE users
           SET ${fields.join(", ")}
           WHERE id = $${idx}
           RETURNING id`,
          values,
        );
      }

      if (role !== undefined) {
        await tx.query(
          `INSERT INTO memberships (org_id, user_id, role)
           VALUES ($1, $2, $3::membership_role)
           ON CONFLICT (org_id, user_id)
           DO UPDATE SET role = EXCLUDED.role`,
          [DEFAULT_ORG_ID, userId, role],
        );
      }

      const finalResult = await tx.query(
        `SELECT
           u.id,
           u.email,
           u.first_name,
           u.last_name,
           u.student_id,
           u.career_id,
           u.status,
           c.name AS career_name,
           c.faculty AS career_faculty,
           m.role::text AS role
         FROM users u
         LEFT JOIN careers c ON c.id = u.career_id
         LEFT JOIN memberships m
           ON m.user_id = u.id
          AND m.org_id = $2
         WHERE u.id = $1
         LIMIT 1`,
        [userId, DEFAULT_ORG_ID],
      );

      return finalResult.rows?.[0] ?? null;
    });

    return res.status(200).json({
      ok: true,
      message: "Usuario actualizado correctamente.",
      user: finalUser,
    });
  } catch (err) {
    if (err?.statusCode === 400 || err?.statusCode === 403) return sendScopeError(res, err);
    if (err?.statusCode === 404) {
      return res.status(404).json({ ok: false, message: err.message });
    }
    if (err?.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "Conflicto de datos únicos (email o matrícula).",
      });
    }

    console.error("Error en PUT /api/admin/users/:userId:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo actualizar el usuario.",
    });
  }
});

router.patch(
  "/api/admin/users/:userId/password",
  requireAuth,
  requireCareerAdmin,
  async (req, res) => {
    const userId = Number(req.params.userId);
    const nextPassword = String(req.body?.newPassword ?? req.body?.password ?? "").trim();

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ ok: false, message: "userId inválido." });
    }

    if (!nextPassword || nextPassword.length < 8) {
      return res.status(400).json({
        ok: false,
        message: "La nueva contraseña debe tener al menos 8 caracteres.",
      });
    }

    try {
      await withTransaction(async (tx) => {
        await lockAdminUserTarget(tx, req.auth, userId);
        const passwordHash = await bcrypt.hash(nextPassword, 12);
        await tx.query(
          `UPDATE users
           SET password_hash = $1,
               updated_at = now()
           WHERE id = $2`,
          [passwordHash, userId],
        );
      });

      return res.status(200).json({
        ok: true,
        message: "Contraseña actualizada correctamente.",
      });
    } catch (err) {
      if (err?.statusCode === 403) return sendScopeError(res, err);
      if (err?.statusCode === 404) {
        return res.status(404).json({ ok: false, message: err.message });
      }
      console.error("Error en PATCH /api/admin/users/:userId/password:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo actualizar la contraseña.",
      });
    }
  },
);

export default router;
