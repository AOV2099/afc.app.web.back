import { Router } from "express";
import bcrypt from "bcryptjs";

import { query, withTransaction } from "../postgresClient.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import {
  ALLOWED_MEMBERSHIP_ROLES,
  DEFAULT_ORG_ID,
  ROLES,
} from "../config/appConfig.js";

const router = Router();

router.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.min(100, Math.max(1, Number(req.query?.pageSize || 20)));
  const q = String(req.query?.q || "").trim();
  const status = req.query?.status ? String(req.query.status).trim() : undefined;
  const role = req.query?.role ? String(req.query.role).trim() : undefined;

  if (role !== undefined && !ALLOWED_MEMBERSHIP_ROLES.has(role)) {
    return res.status(400).json({ ok: false, message: "Rol inválido." });
  }

  const filters = [];
  const params = [DEFAULT_ORG_ID];

  if (q) {
    const idx = params.length + 1;
    filters.push(
      `(u.email ILIKE $${idx} OR u.first_name ILIKE $${idx} OR u.last_name ILIKE $${idx} OR COALESCE(u.student_id, '') ILIKE $${idx})`,
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
         u.status,
         u.created_at,
         m.role::text AS role
       FROM users u
       LEFT JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $1
       ${whereSql}
       ORDER BY u.id DESC
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

router.get("/api/admin/staff-users", requireAuth, requireAdmin, async (_req, res) => {
  try {
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
       GROUP BY u.id, u.email
       ORDER BY u.id DESC`,
      [DEFAULT_ORG_ID, ROLES.STAFF],
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

router.post("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "").trim();
  const firstName = String(req.body?.firstName ?? req.body?.nombre ?? "").trim();
  const lastName = String(req.body?.lastName ?? req.body?.apellido ?? "").trim();
  const studentId = req.body?.studentId ? String(req.body.studentId).trim() : null;
  const careerIdInput =
    req.body?.career_id ?? req.body?.careerId ?? req.body?.carrera_id ?? req.body?.carreraId;
  const status = req.body?.status ? String(req.body.status).trim() : "active";
  const role = String(req.body?.role || ROLES.STUDENT).trim();
  const emailVerifiedInput = req.body?.email_verified ?? req.body?.emailVerified;
  const emailVerifiedAtInput = req.body?.email_verified_at ?? req.body?.emailVerifiedAt;

  const careerId =
    careerIdInput === undefined || careerIdInput === null || String(careerIdInput).trim() === ""
      ? null
      : Number(careerIdInput);

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

router.put("/api/admin/users/:userId", requireAuth, requireAdmin, async (req, res) => {
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
  const careerIdInput =
    req.body?.career_id ?? req.body?.careerId ?? req.body?.carrera_id ?? req.body?.carreraId;
  const status =
    req.body?.status !== undefined ? String(req.body.status || "").trim() : undefined;
  const role = req.body?.role !== undefined ? String(req.body.role || "").trim() : undefined;
  const careerId =
    careerIdInput === undefined
      ? undefined
      : careerIdInput === null || String(careerIdInput).trim() === ""
        ? null
        : Number(careerIdInput);

  if (email !== undefined && (!email || !email.includes("@"))) {
    return res.status(400).json({ ok: false, message: "Email inválido." });
  }
  if (careerId !== undefined && careerId !== null) {
    if (!Number.isInteger(careerId) || careerId <= 0) {
      return res.status(400).json({ ok: false, message: "career_id inválido." });
    }
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
    careerId !== undefined ||
    status !== undefined;

  if (!hasUserUpdate && role === undefined) {
    return res.status(400).json({ ok: false, message: "No hay cambios para actualizar." });
  }

  try {
    const finalUser = await withTransaction(async (tx) => {
      const attributesResult = await tx.query(
        `SELECT attributes
         FROM users
         WHERE id = $1
         LIMIT 1`,
        [userId],
      );
      const attributes = attributesResult.rows?.[0]?.attributes ?? null;
      if (attributes && attributes.event_staff === true) {
        const forbiddenError = new Error("No se puede editar un usuario staff ligado a evento.");
        forbiddenError.statusCode = 403;
        throw forbiddenError;
      }

      if (careerId !== undefined && careerId !== null) {
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
        if (careerId !== undefined) {
          fields.push(`career_id = $${idx++}`);
          values.push(careerId);
        }
        if (status !== undefined) {
          fields.push(`status = $${idx++}`);
          values.push(status);
        }

        fields.push(`updated_at = now()`);
        values.push(userId);

        const updatedUserResult = await tx.query(
          `UPDATE users
           SET ${fields.join(", ")}
           WHERE id = $${idx}
           RETURNING id`,
          values,
        );

        if (updatedUserResult.rowCount === 0) {
          const notFoundError = new Error("Usuario no encontrado.");
          notFoundError.statusCode = 404;
          throw notFoundError;
        }
      } else {
        const exists = await tx.query(`SELECT id FROM users WHERE id = $1 LIMIT 1`, [userId]);
        if (!exists.rows?.[0]) {
          const notFoundError = new Error("Usuario no encontrado.");
          notFoundError.statusCode = 404;
          throw notFoundError;
        }
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
    if (err?.statusCode === 400) {
      return res.status(400).json({ ok: false, message: err.message });
    }
    if (err?.statusCode === 403) {
      return res.status(403).json({ ok: false, message: err.message });
    }
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
  requireAdmin,
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
      const passwordHash = await bcrypt.hash(nextPassword, 12);

      const updateResult = await query(
        `UPDATE users
         SET password_hash = $1,
             updated_at = now()
         WHERE id = $2
         RETURNING id`,
        [passwordHash, userId],
      );

      if (updateResult.rowCount === 0) {
        return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
      }

      return res.status(200).json({
        ok: true,
        message: "Contraseña actualizada correctamente.",
      });
    } catch (err) {
      console.error("Error en PATCH /api/admin/users/:userId/password:", err.message);
      return res.status(500).json({
        ok: false,
        message: "No se pudo actualizar la contraseña.",
      });
    }
  },
);

export default router;
