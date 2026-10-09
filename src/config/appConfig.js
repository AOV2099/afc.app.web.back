import path from "node:path";

import ROLES from "../catalogs/roles.json" with { type: "json" };

export { ROLES };

export const DEFAULT_ORG_ID = Number(process.env.DEFAULT_ORG_ID || 1);

export const SESSION_TTL_SECONDS = Number(
  process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 7,
);
export const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME || "afc_sid";
export const COOKIE_SECURE = String(process.env.COOKIE_SECURE || "false") === "true";
export const COOKIE_SAMESITE = process.env.COOKIE_SAMESITE || "lax";
export const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || undefined;

export const PUBLIC_URL = String(process.env.PUBLIC_URL || "").trim().replace(/\/$/, "");
export const GOOGLE_CALLBACK_URL = String(process.env.GOOGLE_CALLBACK_URL || "").trim();
const googleOAuthStateTtl = Number(process.env.GOOGLE_OAUTH_STATE_TTL_SECONDS || 300);
export const GOOGLE_OAUTH_STATE_TTL_SECONDS = Number.isFinite(googleOAuthStateTtl)
  ? Math.min(600, Math.max(60, Math.trunc(googleOAuthStateTtl)))
  : 300;
export const GOOGLE_OAUTH_STATE_COOKIE_NAME =
  process.env.GOOGLE_OAUTH_STATE_COOKIE_NAME || "afc_google_oauth_state";

const healthcheckTimeout = Number(process.env.HEALTHCHECK_TIMEOUT_MS || 5000);
export const HEALTHCHECK_TIMEOUT_MS = Number.isFinite(healthcheckTimeout)
  ? Math.min(10_000, Math.max(500, Math.trunc(healthcheckTimeout)))
  : 5000;

const bulkStudentImportMaxFileBytes = Number(
  process.env.BULK_STUDENT_IMPORT_MAX_FILE_BYTES || 2 * 1024 * 1024,
);
export const BULK_STUDENT_IMPORT_MAX_FILE_BYTES = Number.isFinite(
  bulkStudentImportMaxFileBytes,
)
  ? Math.min(2 * 1024 * 1024, Math.max(1024, Math.trunc(bulkStudentImportMaxFileBytes)))
  : 2 * 1024 * 1024;

const bulkStudentImportMaxRows = Number(process.env.BULK_STUDENT_IMPORT_MAX_ROWS || 1000);
export const BULK_STUDENT_IMPORT_MAX_ROWS = Number.isFinite(bulkStudentImportMaxRows)
  ? Math.min(1000, Math.max(1, Math.trunc(bulkStudentImportMaxRows)))
  : 1000;

const bulkStudentImportPreviewTtl = Number(
  process.env.BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS || 600,
);
export const BULK_STUDENT_IMPORT_PREVIEW_TTL_SECONDS = Number.isFinite(
  bulkStudentImportPreviewTtl,
)
  ? Math.min(600, Math.max(60, Math.trunc(bulkStudentImportPreviewTtl)))
  : 600;

// Archivos subidos: el contenido vive en FILE_STORAGE_DIR (volumen Docker) y la tabla files guarda la ubicación.
export const FILE_STORAGE_DIR = path.resolve(
  String(process.env.FILE_STORAGE_DIR || "").trim() || path.join(process.cwd(), "storage"),
);
const fileUploadMaxBytes = Number(
  process.env.FILE_UPLOAD_MAX_BYTES || process.env.AFC_EVIDENCE_MAX_FILE_BYTES || 5 * 1024 * 1024,
);
export const FILE_UPLOAD_MAX_BYTES = Number.isFinite(fileUploadMaxBytes)
  ? Math.min(10 * 1024 * 1024, Math.max(1024, Math.trunc(fileUploadMaxBytes)))
  : 5 * 1024 * 1024;
export const FILE_ALLOWED_MIME_TYPES = Object.freeze([
  "application/pdf",
  "image/png",
  "image/jpeg",
]);
export const FILE_STAGED_TTL_HOURS = 24;
export const FILE_PURPOSES = Object.freeze({
  AFC_HOURS_EVIDENCE: "afc_hours_evidence",
  PARTICIPATION_EVIDENCE: "participation_evidence",
  REGISTRATION_REQUIREMENT: "registration_requirement",
  EVENT_COVER: "event_cover",
  OTHER: "other",
});

const trustProxyRaw = String(process.env.TRUST_PROXY || "").trim();
export const TRUST_PROXY = /^\d+$/.test(trustProxyRaw)
  ? Number(trustProxyRaw)
  : trustProxyRaw || false;
const corsAllowAnyRaw = process.env.CORS_ALLOW_ANY_ORIGIN;
export const CORS_ALLOW_ANY_ORIGIN =
  corsAllowAnyRaw === undefined
    ? process.env.NODE_ENV !== "production"
    : String(corsAllowAnyRaw) === "true";

export const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || "").trim();
export const GOOGLE_CLIENT_SECRET = String(process.env.GOOGLE_CLIENT_SECRET || "").trim();
export const GOOGLE_OAUTH_REDIRECT_URI =
  String(process.env.GOOGLE_OAUTH_REDIRECT_URI || "").trim().replace(/\/$/, "");
export const GOOGLE_ALLOWED_EMAIL_DOMAIN = String(
  process.env.GOOGLE_ALLOWED_EMAIL_DOMAIN || "",
)
  .trim()
  .replace(/^@/, "")
  .toLowerCase();

export const ALLOWED_MEMBERSHIP_ROLES = new Set(Object.values(ROLES));

export const EVENT_STATUSES = new Set(["draft", "published", "cancelled", "ended"]);
export const REGISTRATION_MODES = new Set(["auto", "manual_review"]);
export const RESUBMISSION_POLICIES = new Set([
  "allowed",
  "only_changes_requested",
  "not_allowed",
]);
export const CANCEL_POLICIES = new Set(["free_cancel", "locked", "penalize_no_show"]);

// Solo administradores gestionan eventos; el staff únicamente escanea check-ins de su evento asignado.
export const PRIVILEGED_EVENT_CREATOR_ROLES = new Set([ROLES.ADMIN]);
export const CHECKIN_SCANNER_ROLES = new Set([ROLES.ADMIN, ROLES.STAFF]);

export const EVENT_LIST_PAGE_SIZE_DEFAULT = 20;
export const EVENT_LIST_PAGE_SIZE_MAX = 100;

export const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
