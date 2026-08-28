import { withTransaction } from "../postgresClient.js";
import {
  DEFAULT_ORG_ID,
  GOOGLE_ALLOWED_EMAIL_DOMAIN,
} from "../config/appConfig.js";

export class GoogleIdentityError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "GoogleIdentityError";
    this.status = status;
    this.code = code;
  }
}

export function normalizeGooglePictureUrl(value) {
  const picture = String(value || "").trim();
  if (!picture || picture.length > 2048) return null;

  try {
    const url = new URL(picture);
    const hostname = url.hostname.toLowerCase();
    const isGoogleImageHost =
      hostname === "googleusercontent.com" || hostname.endsWith(".googleusercontent.com");

    if (url.protocol !== "https:" || url.username || url.password || !isGoogleImageHost) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function normalizeIdentity(profile) {
  const email = String(profile?.email || "").trim().toLowerCase();
  const subject = String(profile?.sub || "").trim();
  const fullNameParts = String(profile?.name || "").trim().split(/\s+/).filter(Boolean);
  const firstName =
    String(profile?.given_name || "").trim() ||
    fullNameParts.shift() ||
    email.split("@")[0];
  const lastName =
    String(profile?.family_name || "").trim() || fullNameParts.join(" ") || "-";

  if (!email || !subject || profile?.email_verified !== true) {
    throw new GoogleIdentityError(
      401,
      "google_email_unverified",
      "La cuenta de Google no tiene un correo verificado.",
    );
  }
  if (
    GOOGLE_ALLOWED_EMAIL_DOMAIN &&
    email.split("@").pop() !== GOOGLE_ALLOWED_EMAIL_DOMAIN
  ) {
    throw new GoogleIdentityError(
      403,
      "google_email_domain_forbidden",
      `Debes utilizar una cuenta de ${GOOGLE_ALLOWED_EMAIL_DOMAIN}.`,
    );
  }

  return {
    email,
    subject,
    firstName,
    lastName,
    picture: normalizeGooglePictureUrl(profile?.picture),
  };
}

export async function authenticateGoogleIdentity(
  profile,
  { withTransactionFn = withTransaction } = {},
) {
  const identity = normalizeIdentity(profile);

  try {
    const user = await withTransactionFn(async (tx) => {
      const existingResult = await tx.query(
        `SELECT
           u.id, u.email, u.first_name, u.last_name, u.student_id, u.career_id,
           u.status, u.oauth_provider, u.oauth_subject,
           c.name AS career_name, c.faculty AS career_faculty
         FROM users u
         LEFT JOIN careers c ON c.id = u.career_id
         WHERE (u.oauth_provider = 'google' AND u.oauth_subject = $1) OR u.email = $2
         ORDER BY CASE
           WHEN u.oauth_provider = 'google' AND u.oauth_subject = $1 THEN 0 ELSE 1
         END
         LIMIT 1
         FOR UPDATE OF u`,
        [identity.subject, identity.email],
      );

      const currentUser = existingResult.rows?.[0] || null;
      if (!currentUser) {
        throw new GoogleIdentityError(
          403,
          "google_user_not_provisioned",
          "Tu cuenta aún no ha sido registrada. Solicita a un administrador que la dé de alta.",
        );
      }
      if (currentUser.status !== "active") {
        throw new GoogleIdentityError(
          403,
          "user_disabled",
          "El usuario se encuentra deshabilitado. Consulta a un administrador.",
        );
      }
      if (
        currentUser?.oauth_subject &&
        (currentUser.oauth_provider !== "google" || currentUser.oauth_subject !== identity.subject)
      ) {
        throw new GoogleIdentityError(
          409,
          "oauth_account_conflict",
          "El correo ya está vinculado con otra cuenta de acceso.",
        );
      }
      const membershipResult = await tx.query(
        `SELECT role::text AS role
         FROM memberships
         WHERE org_id = $1 AND user_id = $2
         LIMIT 1
         FOR SHARE`,
        [DEFAULT_ORG_ID, currentUser.id],
      );
      if (!membershipResult.rows?.[0]?.role) {
        throw new GoogleIdentityError(
          403,
          "google_user_not_authorized",
          "Tu cuenta no tiene autorización para acceder. Contacta a un administrador.",
        );
      }

      await tx.query(
        `UPDATE users
         SET oauth_provider = 'google', oauth_subject = $2,
             email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
         WHERE id = $1`,
        [currentUser.id, identity.subject],
      );

      const authenticated = await tx.query(
        `SELECT
           u.id, u.email, u.first_name, u.last_name, u.student_id, u.career_id,
           u.status, c.name AS career_name, c.faculty AS career_faculty,
           m.role::text AS role
         FROM users u
         LEFT JOIN careers c ON c.id = u.career_id
         JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
         WHERE u.id = $1 LIMIT 1`,
        [currentUser.id, DEFAULT_ORG_ID],
      );
      return authenticated.rows?.[0] || null;
    });

    if (!user) throw new Error("No se pudo recuperar el usuario autenticado con Google.");
    return { ...user, picture: identity.picture };
  } catch (error) {
    if (error instanceof GoogleIdentityError) throw error;
    if (error?.code === "23505") {
      throw new GoogleIdentityError(
        409,
        "oauth_account_conflict",
        "La cuenta de Google ya está vinculada con otro usuario.",
      );
    }
    throw error;
  }
}
