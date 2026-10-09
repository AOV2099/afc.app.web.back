import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_ORG_ID,
  FILE_ALLOWED_MIME_TYPES,
  FILE_STAGED_TTL_HOURS,
  FILE_STORAGE_DIR,
} from "../config/appConfig.js";

export class FileStorageError extends Error {
  constructor(statusCode, message, code = null) {
    super(message);
    this.name = "FileStorageError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

const FILE_SIGNATURES = [
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
];
const EXTENSION_BY_MIME = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
};
const STORAGE_KEY_PATTERN = /^\d{4}\/\d{2}\/[0-9a-f-]{36}\.(pdf|png|jpg)$/u;

export function detectFileMimeType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  const match = FILE_SIGNATURES.find(({ bytes }) =>
    buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte),
  );
  return match?.mime ?? null;
}

export function validateFileUpload({ buffer, declaredMimeType }) {
  const declared = String(declaredMimeType || "").split(";")[0].trim().toLowerCase();
  if (!FILE_ALLOWED_MIME_TYPES.includes(declared)) {
    return { error: "Tipo de archivo no permitido. Usa PDF, PNG o JPEG.", statusCode: 415 };
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { error: "El archivo está vacío.", statusCode: 400 };
  }
  const detected = detectFileMimeType(buffer);
  if (detected !== declared) {
    return { error: "El contenido del archivo no corresponde a su tipo.", statusCode: 415 };
  }
  return { mimeType: detected };
}

export function sanitizeFileName(rawName, mimeType) {
  let name = "";
  try {
    name = decodeURIComponent(String(rawName || ""));
  } catch {
    name = "";
  }
  name = name
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .replace(/[\\/]/gu, "_")
    .trim()
    .slice(0, 180);
  const extension = EXTENSION_BY_MIME[mimeType] || "bin";
  if (!name || name === "." || name === "..") return `archivo.${extension}`;
  return name;
}

export function buildContentDisposition(fileName, asAttachment = false) {
  const fallback = fileName.replace(/[^\w.\- ]/gu, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/gu, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${asAttachment ? "attachment" : "inline"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function buildStorageKey(mimeType, now = new Date()) {
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/${crypto.randomUUID()}.${EXTENSION_BY_MIME[mimeType] || "bin"}`;
}

// La clave la genera el servidor; aun así se valida para impedir rutas fuera del directorio base.
export function resolveStoragePath(storageKey, baseDir = FILE_STORAGE_DIR) {
  if (!STORAGE_KEY_PATTERN.test(String(storageKey || ""))) {
    throw new FileStorageError(500, "Ubicación de archivo inválida.", "invalid_storage_key");
  }
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, storageKey);
  if (!resolved.startsWith(`${base}${path.sep}`)) {
    throw new FileStorageError(500, "Ubicación de archivo inválida.", "invalid_storage_key");
  }
  return resolved;
}

async function removeQuietly(filePath) {
  try {
    await fsp.unlink(filePath);
  } catch (err) {
    if (err?.code !== "ENOENT") console.error("No se pudo eliminar el archivo:", err.message);
  }
}

/** Elimina los archivos staged que nunca se ligaron a su entidad. */
export async function cleanupStagedFiles(executor, { baseDir = FILE_STORAGE_DIR } = {}) {
  const result = await executor.query(
    `DELETE FROM files
     WHERE status = 'staged'
       AND created_at < now() - ($1::int * interval '1 hour')
     RETURNING storage_key`,
    [FILE_STAGED_TTL_HOURS],
  );
  for (const row of result.rows || []) {
    try {
      await removeQuietly(resolveStoragePath(row.storage_key, baseDir));
    } catch {
      // Clave inválida: no hay archivo que borrar dentro del directorio base.
    }
  }
}

/**
 * Escribe el archivo en el almacenamiento y registra su ubicación.
 * Si el registro falla, se elimina el archivo escrito.
 */
export async function saveUploadedFile(
  executor,
  { buffer, mimeType, originalName, purpose, uploadedBy, eventId = null, metadata = {} },
  { baseDir = FILE_STORAGE_DIR } = {},
) {
  const storageKey = buildStorageKey(mimeType);
  const filePath = resolveStoragePath(storageKey, baseDir);
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer, { flag: "wx", mode: 0o640 });

  try {
    const result = await executor.query(
      `INSERT INTO files (
         org_id, storage_provider, storage_key, original_name, mime_type, size_bytes,
         sha256, purpose, status, uploaded_by, event_id, metadata
       ) VALUES ($1, 'local', $2, $3, $4, $5, $6, $7, 'staged', $8, $9, $10::jsonb)
       RETURNING id, original_name, mime_type, size_bytes, sha256, purpose, status, event_id, created_at`,
      [
        DEFAULT_ORG_ID,
        storageKey,
        originalName,
        mimeType,
        buffer.length,
        sha256,
        purpose,
        uploadedBy,
        eventId,
        JSON.stringify(metadata || {}),
      ],
    );
    return result.rows[0];
  } catch (err) {
    await removeQuietly(filePath);
    throw err;
  }
}

/**
 * Liga un archivo a un evento. Acepta archivos staged del mismo usuario o ya ligados al evento.
 */
export async function attachFileToEvent(tx, { fileId, eventId, purpose, authUserId }) {
  const result = await tx.query(
    `UPDATE files
     SET event_id = $2,
         status = 'attached',
         attached_at = COALESCE(attached_at, now())
     WHERE id = $1
       AND org_id = $5
       AND purpose = $3
       AND status <> 'deleted'
       AND (
         event_id = $2
         OR (event_id IS NULL AND status = 'staged' AND uploaded_by = $4)
       )
     RETURNING id, original_name, mime_type, size_bytes, created_at`,
    [fileId, eventId, purpose, authUserId, DEFAULT_ORG_ID],
  );
  const row = result.rows?.[0];
  if (!row) {
    throw new FileStorageError(
      400,
      "El archivo de evidencia no existe o no pertenece a este evento. Vuelve a subirlo.",
      "file_not_found",
    );
  }
  return row;
}

export async function loadFileMetadata(executor, fileId) {
  if (!fileId) return null;
  const result = await executor.query(
    `SELECT id, original_name, mime_type, size_bytes, purpose, status, created_at
     FROM files
     WHERE id = $1 AND status <> 'deleted'
     LIMIT 1`,
    [fileId],
  );
  return result.rows?.[0] ?? null;
}

export function createFileReadStream(storageKey, { baseDir = FILE_STORAGE_DIR } = {}) {
  return fs.createReadStream(resolveStoragePath(storageKey, baseDir));
}
