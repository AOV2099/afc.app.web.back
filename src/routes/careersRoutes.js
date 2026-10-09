import { Router } from "express";

import { query } from "../postgresClient.js";
import { requireAuth, requireCareerAdmin, requireGlobalAdmin } from "../middleware/auth.js";

const router = Router();

const CLAVE_PATTERN = /^\d{1,10}$/u;
const HOURS_PATTERN = /^\d{1,4}(?:\.\d{1,2})?$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/u;

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (CONTROL_CHARACTERS.test(text) || text.length > maxLength) return null;
  return text;
}

export function normalizeCareerInput(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Datos de carrera inválidos." };

  const name = cleanText(raw.name, 160);
  if (!name) return { error: "El nombre de la carrera es obligatorio (máximo 160 caracteres)." };

  const faculty = cleanText(raw.faculty, 160);
  if (faculty === null) return { error: "La facultad no puede exceder 160 caracteres." };

  const clave = cleanText(raw.clave_carrera, 10);
  if (clave === null || (clave && !CLAVE_PATTERN.test(clave))) {
    return { error: "La clave de carrera solo admite dígitos (máximo 10)." };
  }

  const hoursText = String(raw.afc_hours ?? "").trim();
  const hours = Number(hoursText);
  if (!HOURS_PATTERN.test(hoursText) || !(hours > 0)) {
    return { error: "Las horas AFC deben ser un número mayor a 0 con hasta 2 decimales." };
  }

  return {
    value: {
      name,
      faculty: faculty || null,
      clave_carrera: clave || null,
      afc_hours: hours,
    },
  };
}

function sendDbError(res, err, fallback, label) {
  if (err?.code === "23505") {
    const field = String(err.constraint || "").includes("clave") ? "clave" : "nombre";
    return res.status(409).json({ ok: false, message: `Ya existe una carrera con ese ${field}.` });
  }
  if (err?.code === "23514") {
    return res.status(400).json({ ok: false, message: "Los datos de la carrera no son válidos." });
  }
  console.error(`Error en ${label}:`, err?.message);
  return res.status(500).json({ ok: false, message: fallback });
}

const CAREER_COLUMNS = `c.id, c.name, c.faculty, c.clave_carrera, c.afc_hours::float AS afc_hours, c.created_at`;

router.get("/api/admin/careers", requireAuth, requireCareerAdmin, requireGlobalAdmin, async (_req, res) => {
  try {
    const result = await query(
      `SELECT ${CAREER_COLUMNS}, COUNT(u.id)::int AS users_count
       FROM careers c
       LEFT JOIN users u ON u.career_id = c.id
       GROUP BY c.id
       ORDER BY c.name ASC`,
    );
    return res.status(200).json({ ok: true, careers: result.rows });
  } catch (err) {
    return sendDbError(res, err, "No se pudieron consultar las carreras.", "GET /api/admin/careers");
  }
});

router.post("/api/admin/careers", requireAuth, requireCareerAdmin, requireGlobalAdmin, async (req, res) => {
  const normalized = normalizeCareerInput(req.body);
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const career = normalized.value;

  try {
    const result = await query(
      `INSERT INTO careers (name, faculty, clave_carrera, afc_hours)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, faculty, clave_carrera, afc_hours::float AS afc_hours, created_at`,
      [career.name, career.faculty, career.clave_carrera, career.afc_hours],
    );
    return res.status(201).json({ ok: true, message: "Carrera creada.", career: { ...result.rows[0], users_count: 0 } });
  } catch (err) {
    return sendDbError(res, err, "No se pudo crear la carrera.", "POST /api/admin/careers");
  }
});

router.put("/api/admin/careers/:careerId", requireAuth, requireCareerAdmin, requireGlobalAdmin, async (req, res) => {
  const careerId = Number(req.params.careerId);
  if (!Number.isSafeInteger(careerId) || careerId <= 0) {
    return res.status(400).json({ ok: false, message: "Carrera inválida." });
  }
  const normalized = normalizeCareerInput(req.body);
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const career = normalized.value;

  try {
    const result = await query(
      `UPDATE careers
       SET name = $2, faculty = $3, clave_carrera = $4, afc_hours = $5
       WHERE id = $1
       RETURNING id, name, faculty, clave_carrera, afc_hours::float AS afc_hours, created_at`,
      [careerId, career.name, career.faculty, career.clave_carrera, career.afc_hours],
    );
    if (!result.rows?.[0]) return res.status(404).json({ ok: false, message: "Carrera no encontrada." });
    return res.status(200).json({ ok: true, message: "Carrera actualizada.", career: result.rows[0] });
  } catch (err) {
    return sendDbError(res, err, "No se pudo actualizar la carrera.", "PUT /api/admin/careers/:careerId");
  }
});

export default router;
