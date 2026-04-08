import { Router } from "express";
import crypto from "crypto";
import bcrypt from "bcryptjs";

import { getRedisClient } from "../redisClient.js";
import { query, withTransaction } from "../postgresClient.js";
import {
  COOKIE_DOMAIN,
  COOKIE_SAMESITE,
  COOKIE_SECURE,
  DEFAULT_ORG_ID,
  SESSION_COOKIE_NAME,
  SESSION_TTL_SECONDS,
  ROLES,
} from "../config/appConfig.js";
import { requireAuth } from "../middleware/auth.js";
import { safeUserPayload, sessionKey } from "../utils/session.js";

const router = Router();

router.post("/api/login", async (req, res) => {
  const emailRaw = req.body?.email ?? req.body?.correo;
  const passwordRaw =
    req.body?.password ?? req.body?.contrasena ?? req.body?.contraseña;

  const email = String(emailRaw || "").trim().toLowerCase();
  const password = String(passwordRaw || "").trim();

  if (!email || !password) {
    return res.status(400).json({
      ok: false,
      message: "Faltan datos requeridos: email/correo y password.",
    });
  }

  try {
    const redis = getRedisClient();
    if (!redis) {
      return res.status(503).json({ ok: false, message: "Redis no está listo." });
    }

    const result = await query(
      `SELECT
         u.id,
         u.email,
         u.password_hash,
         u.first_name,
         u.last_name,
         u.student_id,
         u.career_id,
         u.status,
         u.email_verified_at,
         c.name AS career_name,
         c.faculty AS career_faculty,
         m.role::text AS role
       FROM users u
       LEFT JOIN careers c ON c.id = u.career_id
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $2
       WHERE u.email = $1
       LIMIT 1`,
      [email, DEFAULT_ORG_ID],
    );

    const userRow = result.rows?.[0];
    if (!userRow) {
      return res.status(401).json({
        ok: false,
        message: "Credenciales inválidas o usuario sin rol asignado.",
      });
    }

    if (userRow.status !== "active") {
      return res.status(403).json({
        ok: false,
        message:
          "El usuario se encuentra deshabilitado. Por favor consulta a un administrador.",
      });
    }

    const passwordOk = await bcrypt.compare(password, userRow.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ ok: false, message: "Credenciales inválidas." });
    }

    const sessionId = crypto.randomUUID();
    const session = {
      userId: userRow.id,
      role: userRow.role,
      createdAt: Date.now(),
    };

    await redis.set(sessionKey(sessionId), JSON.stringify(session), {
      EX: SESSION_TTL_SECONDS,
    });

    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: COOKIE_SAMESITE,
      domain: COOKIE_DOMAIN,
      maxAge: SESSION_TTL_SECONDS * 1000,
      path: "/",
    });

    return res.status(200).json({
      ok: true,
      message: "Login correcto.",
      user: safeUserPayload(userRow),
      role: userRow.role,
    });
  } catch (err) {
    console.error("Error en /api/login:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo iniciar sesión." });
  }
});

router.get("/api/me", requireAuth, async (req, res) => {
  const result = await query(
    `SELECT
       u.id,
       u.email,
       u.first_name,
       u.last_name,
       u.student_id,
       u.career_id,
       u.status,
       u.email_verified_at,
       c.name AS career_name,
       c.faculty AS career_faculty,
       m.role::text AS role
     FROM users u
     LEFT JOIN careers c ON c.id = u.career_id
     JOIN memberships m
       ON m.user_id = u.id
      AND m.org_id = $2
     WHERE u.id = $1
     LIMIT 1`,
    [req.auth.userId, DEFAULT_ORG_ID],
  );

  const userRow = result.rows?.[0];
  if (!userRow) {
    return res.status(401).json({ ok: false, message: "Usuario inválido." });
  }

  return res.status(200).json({ ok: true, user: safeUserPayload(userRow) });
});

router.get("/api/careers", async (_req, res) => {
  try {
    const result = await query(
      `SELECT id, name, faculty
       FROM careers
       ORDER BY name ASC`,
    );

    return res.status(200).json({
      ok: true,
      careers: result.rows,
    });
  } catch (err) {
    console.error("Error en GET /api/careers:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudieron consultar las carreras.",
    });
  }
});

router.patch("/api/me/profile", requireAuth, async (req, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  const firstNameInput = req.body?.firstName ?? req.body?.nombre;
  const studentIdInput = req.body?.studentId ?? req.body?.matricula;
  const careerIdInput =
    req.body?.career_id ?? req.body?.careerId ?? req.body?.carrera_id ?? req.body?.carreraId;

  try {
    const userResult = await query(
      `SELECT
         u.id,
         u.email,
         u.password_hash,
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
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $2
       WHERE u.id = $1
       LIMIT 1`,
      [userId, DEFAULT_ORG_ID],
    );

    const userRow = userResult.rows?.[0];
    if (!userRow) {
      return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
    }

    const fields = [];
    const values = [];
    let idx = 1;

    if (
      req.body?.currentPassword !== undefined ||
      req.body?.passwordActual !== undefined ||
      req.body?.contrasenaActual !== undefined ||
      req.body?.contraseñaActual !== undefined ||
      req.body?.newPassword !== undefined ||
      req.body?.passwordNueva !== undefined ||
      req.body?.contrasenaNueva !== undefined ||
      req.body?.contraseñaNueva !== undefined ||
      req.body?.password !== undefined
    ) {
      return res.status(400).json({
        ok: false,
        message: "Para cambiar contraseña usa PATCH /api/me/password.",
      });
    }

    if (firstNameInput !== undefined) {
      const nextFirstName = String(firstNameInput || "").trim();
      if (!nextFirstName) {
        return res.status(400).json({ ok: false, message: "nombre/firstName no puede ir vacío." });
      }

      fields.push(`first_name = $${idx++}`);
      values.push(nextFirstName);
    }

    if (studentIdInput !== undefined || careerIdInput !== undefined) {
      if (userRow.role !== "student") {
        return res.status(400).json({
          ok: false,
          message: "matrícula y carrera solo se pueden editar si el usuario es student.",
        });
      }

      if (studentIdInput !== undefined) {
        const nextStudentId = String(studentIdInput ?? "").trim();
        if (!nextStudentId) {
          return res.status(400).json({
            ok: false,
            message: "matrícula/studentId no puede ir vacío.",
          });
        }

        fields.push(`student_id = $${idx++}`);
        values.push(nextStudentId);
      }

      if (careerIdInput !== undefined) {
        if (careerIdInput === null || String(careerIdInput).trim() === "") {
          return res.status(400).json({
            ok: false,
            message: "career_id/careerId no puede ir vacío.",
          });
        }

        const nextCareerId = Number(careerIdInput);
        if (!Number.isInteger(nextCareerId) || nextCareerId <= 0) {
          return res.status(400).json({
            ok: false,
            message: "career_id/careerId inválido.",
          });
        }

        const careerExistsResult = await query(
          `SELECT id
           FROM careers
           WHERE id = $1
           LIMIT 1`,
          [nextCareerId],
        );

        if (!careerExistsResult.rows?.[0]) {
          return res.status(400).json({
            ok: false,
            message: "La carrera indicada no existe.",
          });
        }

        fields.push(`career_id = $${idx++}`);
        values.push(nextCareerId);
      }
    }

    if (!fields.length) {
      return res.status(400).json({ ok: false, message: "No se enviaron cambios para actualizar." });
    }

    fields.push("updated_at = now()");

    values.push(userId);
    const userIdIdx = values.length;

    const updateResult = await query(
      `UPDATE users
       SET ${fields.join(", ")}
       WHERE id = $${userIdIdx}
       RETURNING id, email, first_name, last_name, student_id, career_id, status`,
      values,
    );

    const updatedUserBase = updateResult.rows?.[0] || null;

    const updatedCareerResult = await query(
      `SELECT name, faculty
       FROM careers
       WHERE id = $1
       LIMIT 1`,
      [updatedUserBase?.career_id ?? null],
    );

    const updatedCareer = updatedCareerResult.rows?.[0] ?? null;

    const updatedUser = {
      ...updatedUserBase,
      career_name: updatedCareer?.name ?? null,
      career_faculty: updatedCareer?.faculty ?? null,
    };

    return res.status(200).json({
      ok: true,
      message: "Perfil actualizado correctamente.",
      user: safeUserPayload({
        ...updatedUser,
        role: userRow.role,
      }),
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({
        ok: false,
        message: "La matrícula/studentId ya está registrada.",
      });
    }

    console.error("Error en PATCH /api/me/profile:", err.message);
    return res.status(500).json({ ok: false, message: "No se pudo actualizar el perfil." });
  }
});

router.patch("/api/me/password", requireAuth, async (req, res) => {
  const userId = req.auth?.userId;

  if (!userId) {
    return res.status(401).json({ ok: false, message: "Sesión inválida." });
  }

  const currentPasswordRaw =
    req.body?.currentPassword ??
    req.body?.passwordActual ??
    req.body?.contrasenaActual ??
    req.body?.contraseñaActual;
  const newPasswordRaw =
    req.body?.newPassword ??
    req.body?.passwordNueva ??
    req.body?.contrasenaNueva ??
    req.body?.contraseñaNueva ??
    req.body?.password;

  const currentPassword = String(currentPasswordRaw || "").trim();
  const newPassword = String(newPasswordRaw || "").trim();

  if (!currentPassword || !newPassword) {
    return res.status(400).json({
      ok: false,
      message: "Debes enviar currentPassword y newPassword.",
    });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({
      ok: false,
      message: "La nueva contraseña debe tener al menos 8 caracteres.",
    });
  }

  if (newPassword === currentPassword) {
    return res.status(400).json({
      ok: false,
      message: "La nueva contraseña debe ser diferente a la actual.",
    });
  }

  try {
    const userResult = await query(
      `SELECT
         u.id,
         u.password_hash
       FROM users u
       JOIN memberships m
         ON m.user_id = u.id
        AND m.org_id = $2
       WHERE u.id = $1
       LIMIT 1`,
      [userId, DEFAULT_ORG_ID],
    );

    const userRow = userResult.rows?.[0];
    if (!userRow) {
      return res.status(404).json({ ok: false, message: "Usuario no encontrado." });
    }

    const passwordOk = await bcrypt.compare(currentPassword, userRow.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ ok: false, message: "La contraseña actual es incorrecta." });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);

    await query(
      `UPDATE users
       SET password_hash = $1,
           updated_at = now()
       WHERE id = $2`,
      [passwordHash, userId],
    );

    return res.status(200).json({
      ok: true,
      message: "Contraseña actualizada correctamente.",
    });
  } catch (err) {
    console.error("Error en PATCH /api/me/password:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo actualizar la contraseña.",
    });
  }
});

router.post("/api/logout", requireAuth, async (req, res) => {
  const redis = getRedisClient();
  if (redis) {
    await redis.del(sessionKey(req.auth.sessionId));
  }

  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    domain: COOKIE_DOMAIN,
    path: "/",
  });

  return res.status(200).json({ ok: true, message: "Sesión cerrada." });
});

router.post("/api/register", async (req, res) => {
  const emailRaw = req.body?.email ?? req.body?.correo;
  const firstNameRaw = req.body?.firstName ?? req.body?.nombre;
  const lastNameRaw = req.body?.lastName ?? req.body?.apellido;
  const studentIdRaw = req.body?.studentId ?? req.body?.matricula;
  const careerIdRaw =
    req.body?.career_id ?? req.body?.careerId ?? req.body?.carrera_id ?? req.body?.carreraId;
  const isStudentRaw = req.body?.is_student ?? req.body?.isStudent ?? false;
  const passwordRaw =
    req.body?.password ?? req.body?.contrasena ?? req.body?.contraseña;

  const email = String(emailRaw || "").trim().toLowerCase();
  const firstName = String(firstNameRaw || "").trim();
  const lastName = String(lastNameRaw || "").trim();
  const studentId = studentIdRaw === undefined ? null : String(studentIdRaw || "").trim() || null;
  const careerId =
    careerIdRaw === undefined || careerIdRaw === null || String(careerIdRaw).trim() === ""
      ? null
      : Number(careerIdRaw);
  const isStudent = Boolean(isStudentRaw);
  const password = String(passwordRaw || "").trim();

  if (!email || !firstName || !lastName || !password) {
    return res.status(400).json({
      ok: false,
      message:
        "Faltan datos requeridos: email/correo, nombre, apellido y password.",
    });
  }

  if (password.length < 8) {
    return res.status(400).json({
      ok: false,
      message: "La contraseña debe tener al menos 8 caracteres.",
    });
  }

  try {
    if (isStudent) {
      if (!studentId) {
        return res.status(400).json({
          ok: false,
          message: "matrícula/studentId es requerido cuando is_student=true.",
        });
      }
      if (careerId === null || !Number.isInteger(careerId) || careerId <= 0) {
        return res.status(400).json({
          ok: false,
          message: "career_id/careerId es requerido y válido cuando is_student=true.",
        });
      }

      const careerExists = await query(
        `SELECT id FROM careers WHERE id = $1 LIMIT 1`,
        [careerId],
      );
      if (!careerExists.rows?.[0]) {
        return res.status(400).json({
          ok: false,
          message: "La carrera indicada no existe.",
        });
      }
    } else if (careerId !== null) {
      if (!Number.isInteger(careerId) || careerId <= 0) {
        return res.status(400).json({
          ok: false,
          message: "career_id/careerId inválido.",
        });
      }
    }

    const role = isStudent ? ROLES.STUDENT : ROLES.VISITOR;

    const createdUser = await withTransaction(async (tx) => {
      const passwordHash = await bcrypt.hash(password, 12);

      const userResult = await tx.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, student_id, career_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email, first_name, last_name, student_id, career_id, status, created_at`,
        [email, passwordHash, firstName, lastName, studentId, careerId],
      );

      const user = userResult.rows[0];

      await tx.query(
        `INSERT INTO memberships (org_id, user_id, role)
         VALUES ($1, $2, $3::membership_role)
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [DEFAULT_ORG_ID, user.id, role],
      );

      return user;
    });

    return res.status(201).json({
      ok: true,
      message: "Usuario registrado correctamente.",
      user: { ...createdUser, role },
    });
  } catch (err) {
    if (err?.code === "23505") {
      return res.status(409).json({ ok: false, message: "El email ya está registrado." });
    }

    console.error("Error en /api/register:", err.message);
    return res.status(500).json({
      ok: false,
      message: "No se pudo registrar el usuario.",
    });
  }
});

export default router;
