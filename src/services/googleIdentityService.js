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

function normalizeGoogleIdentity(identity) {
  const email = String(identity?.email || "").trim().toLowerCase();
  const subject = String(identity?.subject || "").trim();
  const fullNameParts = String(identity?.name || "").trim().split(/\s+/).filter(Boolean);
  const firstName =
    String(identity?.firstName || "").trim() ||
    String(identity?.givenName || "").trim() ||
    fullNameParts.shift() ||
    email.split("@")[0];
  const lastName =
    String(identity?.lastName || "").trim() ||
    String(identity?.familyName || "").trim() ||
    fullNameParts.join(" ") ||
    "-";
  const picture = String(identity?.picture || "").trim() || null;

  if (!email || !subject || identity?.emailVerified !== true) {
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

  return { email, subject, firstName, lastName, picture };
}

export async function authenticateGoogleIdentity(identity) {
  const normalized = normalizeGoogleIdentity(identity);

  try {
    const result = await withTransaction(async (tx) => {
      const existingResult = await tx.query(
        `SELECT
           u.id,
           u.email,
           u.first_name,
           u.last_name,
           u.student_id,
           u.career_id,
           u.status,
           u.oauth_provider,
           u.oauth_subject,
           c.name AS career_name,
           c.faculty AS career_faculty,
           m.role::text AS role
         FROM users u
         LEFT JOIN careers c ON c.id = u.career_id
         LEFT JOIN memberships m
           ON m.user_id = u.id
          AND m.org_id = $3
         WHERE (u.oauth_provider = 'google' AND u.oauth_subject = $1)
            OR u.email = $2
         ORDER BY CASE
           WHEN u.oauth_provider = 'google' AND u.oauth_subject = $1 THEN 0
           ELSE 1
         END
         LIMIT 1
         FOR UPDATE OF u`,
        [normalized.subject, normalized.email, DEFAULT_ORG_ID],
      );

      let user = existingResult.rows?.[0] || null;

      if (user?.status && user.status !== "active") {
        throw new GoogleIdentityError(
          403,
          "user_disabled",
          "El usuario se encuentra deshabilitado. Consulta a un administrador.",
        );
      }

      if (
        user?.oauth_subject &&
        (user.oauth_provider !== "google" || user.oauth_subject !== normalized.subject)
      ) {
        throw new GoogleIdentityError(
          409,
          "oauth_account_conflict",
          "El correo ya está vinculado con otra cuenta de acceso.",
        );
      }

      if (user) {
        await tx.query(
          `UPDATE users
           SET oauth_provider = 'google',
               oauth_subject = $2,
               email_verified_at = COALESCE(email_verified_at, now()),
               updated_at = now()
           WHERE id = $1`,
          [user.id, normalized.subject],
        );

        if (!user.role) {
          await tx.query(
            `INSERT INTO memberships (org_id, user_id, role)
             VALUES ($1, $2, $3::membership_role)
             ON CONFLICT (org_id, user_id) DO NOTHING`,
            [DEFAULT_ORG_ID, user.id, ROLES.VISITOR],
          );
        }
      } else {
        const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12);
        const createdResult = await tx.query(
          `INSERT INTO users (
             email,
             password_hash,
             first_name,
             last_name,
             email_verified_at,
             oauth_provider,
             oauth_subject,
             attributes
           )
           VALUES ($1, $2, $3, $4, now(), 'google', $5, $6::jsonb)
           RETURNING id`,
          [
            normalized.email,
            passwordHash,
            normalized.firstName,
            normalized.lastName,
            normalized.subject,
            JSON.stringify({ google_picture: normalized.picture }),
          ],
        );

        await tx.query(
          `INSERT INTO memberships (org_id, user_id, role)
           VALUES ($1, $2, $3::membership_role)`,
          [DEFAULT_ORG_ID, createdResult.rows[0].id, ROLES.VISITOR],
        );

        user = { id: createdResult.rows[0].id };
      }

      const authenticatedResult = await tx.query(
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
         JOIN memberships m
           ON m.user_id = u.id
          AND m.org_id = $2
         WHERE u.id = $1
         LIMIT 1`,
        [user.id, DEFAULT_ORG_ID],
      );

      return authenticatedResult.rows?.[0] || null;
    });

    if (!result) {
      throw new Error("No se pudo recuperar el usuario autenticado con Google.");
    }

    return result;
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
