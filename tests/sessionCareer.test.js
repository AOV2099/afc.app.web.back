import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAuthenticatedSession,
  createAuthenticatedSession,
} from "../src/routes/authRoutes.js";
import { buildRequestAuth } from "../src/middleware/auth.js";

test("authenticated sessions persist careerId and requireAuth exposes it", async () => {
  let saved = null;
  const redis = {
    async set(key, value, options) {
      saved = { key, value: JSON.parse(value), options };
    },
  };
  const user = { id: "42", role: "admin", career_id: "9" };

  const built = buildAuthenticatedSession(user);
  assert.equal(built.careerId, 9);

  const sessionId = await createAuthenticatedSession(redis, user);
  assert.equal(saved.key, `sess:${sessionId}`);
  assert.equal(saved.value.careerId, 9);
  assert.equal(saved.options.EX > 0, true);

  assert.deepEqual(buildRequestAuth(sessionId, saved.value), {
    sessionId,
    userId: "42",
    role: "admin",
    careerId: 9,
    picture: null,
  });
});

test("sessions represent an unassigned career as null", () => {
  const session = buildAuthenticatedSession({ id: "43", role: "admin", career_id: null });
  assert.equal(session.careerId, null);
  assert.equal(buildRequestAuth("sid", session).careerId, null);
});

test("Google pictures remain session-only and are exposed by requireAuth", async () => {
  const picture = "https://lh3.googleusercontent.com/a/example=s96-c";
  let savedSession = null;
  const redis = {
    async set(_key, value) {
      savedSession = JSON.parse(value);
    },
  };

  await createAuthenticatedSession(redis, {
    id: "44",
    role: "student",
    career_id: "2",
    picture,
  });

  assert.equal(savedSession.picture, picture);
  assert.equal(buildRequestAuth("sid", savedSession).picture, picture);
});
