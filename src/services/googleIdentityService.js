import crypto from "crypto";
import bcrypt from "bcryptjs";

import { withTransaction } from "../postgresClient.js";
import {
  DEFAULT_ORG_ID,
  GOOGLE_ALLOWED_EMAIL_DOMAIN,
  ROLES,
} from "../config/appConfig.js";

export class GoogleIdentityError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "GoogleIdentityError";
    this.status = status;
    this.code = code;
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
    picture: String(profile?.picture || "").trim() || null,
  };
}

export async function authenticateGoogleIdentity(profile) {
  const identity = normalizeIdentity(profile);

  try {
    const user = await withTransaction(async (tx) => {
      const existingResult = await tx.query(
        `SELECT
           u.id, u.email, u.first_name, u.last_name, u.student_id, u.career_id,
           u.status, u.oauth_provider, u.oauth_subject,
           c.name AS career_name, c.faculty AS career_faculty,
           m.role::text AS role
         FROM users u
         LEFT JOIN careers c ON c.id = u.career_id
         LEFT JOIN memberships m ON m.user_id = u.id AND m.org_id = $3
         WHERE (u.oauth_provider = 'google' AND u.oauth_subject = $1) OR u.email = $2
         ORDER BY CASE
           WHEN u.oauth_provider = 'google' AND u.oauth_subject = $1 THEN 0 ELSE 1
         END
         LIMIT 1
         FOR UPDATE OF u`,
        [identity.subject, identity.email, DEFAULT_ORG_ID],
      );

      let currentUser = existingResult.rows?.[0] || null;
      if (currentUser?.status && currentUser.status !== "active") {
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

      if (currentUser) {
        await tx.query(
          `UPDATE users
           SET oauth_provider = 'google', oauth_subject = $2,
               email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
           WHERE id = $1`,
          [currentUser.id, identity.subject],
        );
        if (!currentUser.role) {
          await tx.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, $3::membership_role)
             ON CONFLICT (org_id, user_id) DO NOTHING`,
            [DEFAULT_ORG_ID, currentUser.id, ROLES.VISITOR],
          );
        }
      } else {
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
        const created = await tx.query(
          `INSERT INTO users (
             email, password_hash, first_name, last_name, email_verified_at,
             oauth_provider, oauth_subject, attributes
           ) VALUES ($1, $2, $3, $4, now(), 'google', $5, $6::jsonb)
           RETURNING id`,
          [
            identity.email,
            passwordHash,
            identity.firstName,
            identity.lastName,
            identity.subject,
            JSON.stringify({ google_picture: identity.picture }),
          ],
        );
        await tx.query(
          `INSERT INTO memberships (org_id, user_id, role)
           VALUES ($1, $2, $3::membership_role)`,
          [DEFAULT_ORG_ID, created.rows[0].id, ROLES.VISITOR],
        );
        currentUser = { id: created.rows[0].id };
      }

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
    return user;
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
