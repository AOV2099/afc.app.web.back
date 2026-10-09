import express, { Router } from "express";

import { query } from "../postgresClient.js";
import { requireAuth } from "../middleware/auth.js";
import { createOAuthRateLimit } from "../middleware/oauthRateLimit.js";
import {
  DEFAULT_ORG_ID,
  FILE_ALLOWED_MIME_TYPES,
  FILE_PURPOSES,
  FILE_UPLOAD_MAX_BYTES,
  PRIVILEGED_EVENT_CREATOR_ROLES,
} from "../config/appConfig.js";
import { assertEventCareerAccess } from "../services/eventCareerAccess.js";
import {
  buildContentDisposition,
  cleanupStagedFiles,
  createFileReadStream,
  sanitizeFileName,
  saveUploadedFile,
  validateFileUpload,
} from "../services/fileStorageService.js";

const router = Router();

// Propósitos que ya se pueden subir; el resto queda reservado para flujos futuros.
const UPLOADABLE_PURPOSES = new Set([FILE_PURPOSES.AFC_HOURS_EVIDENCE]);
const MANAGER_ONLY_PURPOSES = new Set([FILE_PURPOSES.AFC_HOURS_EVIDENCE]);

const fileParser = express.raw({ type: FILE_ALLOWED_MIME_TYPES, limit: FILE_UPLOAD_MAX_BYTES });
const limitFileUpload = createOAuthRateLimit({
  limit: 20,
  windowMs: 60_000,
  scope: "file-upload",
  code: "file_upload_rate_limited",
  message: "Demasiadas cargas de archivos. Espera un minuto e intenta nuevamente.",
});

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function isEventManager(auth) {
  return PRIVILEGED_EVENT_CREATOR_ROLES.has(auth?.role);
}

function sendError(res, err, fallbackMessage, logLabel) {
  if ([400, 403, 404, 409, 415].includes(err?.statusCode)) {
    return res.status(err.statusCode).json({ ok: false, code: err.code ?? undefined, message: err.message });
  }
  console.error(`Error en ${logLabel}:`, err?.message);
  return res.status(500).json({ ok: false, message: fallbackMessage });
}

function parseFileBody(req, res, next) {
  fileParser(req, res, (err) => {
    if (!err) return next();
    if (err.type === "entity.too.large") {
      const maxMb = (FILE_UPLOAD_MAX_BYTES / (1024 * 1024)).toFixed(1);
      return res.status(413).json({ ok: false, message: `El archivo supera el límite de ${maxMb} MB.` });
    }
    return res.status(400).json({ ok: false, message: "No se pudo leer el archivo enviado." });
  });
}

function checkUploadPurpose(req, res, next) {
  const purpose = String(req.query?.purpose || "").trim();
  if (!UPLOADABLE_PURPOSES.has(purpose)) {
    return res.status(400).json({ ok: false, message: "El propósito del archivo no es válido." });
  }
  if (MANAGER_ONLY_PURPOSES.has(purpose) && !isEventManager(req.auth)) {
    return res.status(403).json({ ok: false, message: "No autorizado para subir este tipo de archivo." });
  }
  req.filePurpose = purpose;
  return next();
}

async function loadEventOwnerCareer(eventId) {
  const result = await query(
    `SELECT e.id, owner_user.career_id AS owner_career_id
     FROM events e
     LEFT JOIN users owner_user ON owner_user.id = e.created_by
     WHERE e.id = $1 AND e.org_id = $2
     LIMIT 1`,
    [eventId, DEFAULT_ORG_ID],
  );
  return result.rows?.[0] ?? null;
}

router.post("/api/files", requireAuth, checkUploadPurpose, limitFileUpload, parseFileBody, async (req, res) => {
  const validation = validateFileUpload({ buffer: req.body, declaredMimeType: req.get("content-type") });
  if (validation.error) {
    return res.status(validation.statusCode).json({ ok: false, message: validation.error });
  }

  const rawEventId = req.query?.event_id;
  const hasEventId = rawEventId !== undefined && rawEventId !== "";
  const eventId = hasEventId ? parsePositiveId(rawEventId) : null;
  if (hasEventId && eventId === null) {
    return res.status(400).json({ ok: false, message: "event_id inválido." });
  }

  try {
    if (eventId !== null) {
      const event = await loadEventOwnerCareer(eventId);
      if (!event) return res.status(404).json({ ok: false, message: "Evento no encontrado." });
      assertEventCareerAccess(req.auth.careerId, event.owner_career_id);
    }

    await cleanupStagedFiles({ query });
    const file = await saveUploadedFile({ query }, {
      buffer: req.body,
      mimeType: validation.mimeType,
      originalName: sanitizeFileName(req.get("x-file-name"), validation.mimeType),
      purpose: req.filePurpose,
      uploadedBy: req.auth.userId,
      // Se registra el evento como contexto; queda staged hasta que el evento se guarde con este archivo.
      metadata: eventId ? { intended_event_id: eventId } : {},
    });

    return res.status(201).json({ ok: true, message: "Archivo cargado correctamente.", file });
  } catch (err) {
    return sendError(res, err, "No se pudo guardar el archivo.", "POST /api/files");
  }
});

router.get("/api/files/:fileId", requireAuth, async (req, res) => {
  const fileId = parsePositiveId(req.params.fileId);
  if (!fileId) return res.status(400).json({ ok: false, message: "Archivo inválido." });
  const notFound = () => res.status(404).json({ ok: false, message: "Archivo no encontrado." });

  try {
    const result = await query(
      `SELECT f.id, f.org_id, f.storage_key, f.original_name, f.mime_type, f.size_bytes,
              f.purpose, f.status, f.event_id, f.uploaded_by,
              owner_user.career_id AS owner_career_id
       FROM files f
       LEFT JOIN events e ON e.id = f.event_id
       LEFT JOIN users owner_user ON owner_user.id = e.created_by
       WHERE f.id = $1
       LIMIT 1`,
      [fileId],
    );
    const file = result.rows?.[0];
    if (!file || file.status === "deleted" || Number(file.org_id) !== DEFAULT_ORG_ID) return notFound();

    const isUploader = String(file.uploaded_by) === String(req.auth.userId);
    if (MANAGER_ONLY_PURPOSES.has(file.purpose) && !isEventManager(req.auth)) return notFound();
    if (file.event_id === null) {
      if (!isUploader) return notFound();
    } else if (isEventManager(req.auth)) {
      assertEventCareerAccess(req.auth.careerId, file.owner_career_id);
    } else if (!isUploader) {
      return notFound();
    }

    const stream = createFileReadStream(file.storage_key);
    stream.on("error", (err) => {
      if (!res.headersSent) {
        if (err?.code === "ENOENT") return notFound();
        console.error("Error leyendo archivo:", err?.message);
        return res.status(500).json({ ok: false, message: "No se pudo leer el archivo." });
      }
      return res.destroy(err);
    });
    stream.once("open", () => {
      res.set({
        "Content-Type": file.mime_type,
        "Content-Length": String(file.size_bytes),
        "Content-Disposition": buildContentDisposition(file.original_name, req.query?.download === "1"),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      stream.pipe(res);
    });
    return undefined;
  } catch (err) {
    return sendError(res, err, "No se pudo consultar el archivo.", "GET /api/files/:fileId");
  }
});

export default router;
