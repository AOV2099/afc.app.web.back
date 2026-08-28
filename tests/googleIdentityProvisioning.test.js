import assert from "node:assert/strict";
import test from "node:test";

import {
  authenticateGoogleIdentity,
  GoogleIdentityError,
  normalizeGooglePictureUrl,
} from "../src/services/googleIdentityService.js";
import { safeOAuthErrorCode } from "../src/routes/authRoutes.js";

const PROFILE = {
  email: "student@example.com",
  sub: "google-subject-1",
  email_verified: true,
  given_name: "Student",
  family_name: "Example",
  picture: "https://lh3.googleusercontent.com/a/example=s96-c",
};

function transactionWith(tx) {
  return async (work) => work(tx);
}

test("accepts only HTTPS Google-hosted profile pictures", () => {
  assert.equal(normalizeGooglePictureUrl(PROFILE.picture), PROFILE.picture);
  assert.equal(normalizeGooglePictureUrl("http://lh3.googleusercontent.com/avatar"), null);
  assert.equal(normalizeGooglePictureUrl("https://example.com/avatar"), null);
  assert.equal(normalizeGooglePictureUrl("javascript:alert(1)"), null);
});

test("maps provisioning failures to sanitized callback query codes", () => {
  assert.equal(
    safeOAuthErrorCode(new GoogleIdentityError(403, "google_user_not_provisioned", "private")),
    "not_provisioned",
  );
  assert.equal(
    safeOAuthErrorCode(new GoogleIdentityError(403, "google_user_not_authorized", "private")),
    "not_authorized",
  );
});

test("rejects an unknown verified Google user without creating an account", async () => {
  const statements = [];
  const tx = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
  };

  await assert.rejects(
    authenticateGoogleIdentity(PROFILE, { withTransactionFn: transactionWith(tx) }),
    (error) =>
      error instanceof GoogleIdentityError &&
      error.status === 403 &&
      error.code === "google_user_not_provisioned",
  );
  assert.equal(statements.length, 1);
  assert.equal(statements.some((sql) => /INSERT\s+INTO\s+users/iu.test(sql)), false);
});

test("rejects an existing active user without an organization membership before linking", async () => {
  const statements = [];
  const tx = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM memberships")) return { rows: [] };
      return {
        rows: [{
          id: "10",
          email: PROFILE.email,
          status: "active",
          oauth_provider: null,
          oauth_subject: null,
          role: null,
        }],
      };
    },
  };

  await assert.rejects(
    authenticateGoogleIdentity(PROFILE, { withTransactionFn: transactionWith(tx) }),
    (error) => error.status === 403 && error.code === "google_user_not_authorized",
  );
  assert.equal(statements.length, 2);
  assert.equal(statements.some((sql) => /^\s*UPDATE/iu.test(sql)), false);
});

test("links any active existing authorized user and preserves the membership role", async () => {
  const statements = [];
  const existing = {
    id: "10",
    email: PROFILE.email,
    first_name: "Student",
    last_name: "Example",
    student_id: "123456789",
    career_id: "2",
    status: "active",
    oauth_provider: null,
    oauth_subject: null,
    role: "auditor",
  };
  const tx = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("WHERE (u.oauth_provider")) return { rows: [existing] };
      if (sql.includes("FROM memberships")) return { rows: [{ role: "auditor" }] };
      if (/^\s*UPDATE\s+users/iu.test(sql)) return { rows: [], rowCount: 1 };
      if (sql.includes("JOIN memberships") && sql.includes("WHERE u.id")) {
        return { rows: [{ ...existing, career_name: "Carrera", career_faculty: "Facultad" }] };
      }
      throw new Error("Consulta inesperada");
    },
  };

  const user = await authenticateGoogleIdentity(PROFILE, {
    withTransactionFn: transactionWith(tx),
  });

  assert.equal(user.role, "auditor");
  assert.equal(user.picture, PROFILE.picture);
  assert.equal(statements.some((sql) => /INSERT\s+INTO/iu.test(sql)), false);
  assert.equal(statements.filter((sql) => /^\s*UPDATE\s+users/iu.test(sql)).length, 1);
});
