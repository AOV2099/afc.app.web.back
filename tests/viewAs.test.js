import assert from "node:assert/strict";
import test from "node:test";

import { isViewAsRequestAllowed, restoreViewAsSession } from "../src/middleware/auth.js";
import { buildViewAsSession, VIEW_AS_DURATION_MS } from "../src/routes/viewAsRoutes.js";

const adminSession = { userId: "16", role: "admin", careerId: 1, picture: "https://lh3.googleusercontent.com/a", createdAt: 1 };
const target = { id: "18", role: "visitor", career_id: "21" };

test("view-as session takes the target identity and keeps the admin to restore", () => {
  const session = buildViewAsSession(adminSession, target, 1_000);
  assert.equal(session.userId, "18");
  assert.equal(session.role, "visitor");
  assert.equal(session.careerId, 21);
  assert.equal(session.picture, null);
  assert.equal(session.viewAs.adminUserId, "16");
  assert.equal(session.viewAs.expiresAt, 1_000 + VIEW_AS_DURATION_MS);
});

test("exiting view-as restores exactly the admin session", () => {
  const restored = restoreViewAsSession(buildViewAsSession(adminSession, target, 1_000));
  assert.deepEqual(restored, adminSession);
});

test("view-as is read-only except for exit and logout", () => {
  assert.equal(isViewAsRequestAllowed("GET", "/api/me/hours/history"), true);
  assert.equal(isViewAsRequestAllowed("head", "/api/events"), true);
  assert.equal(isViewAsRequestAllowed("POST", "/api/view-as/exit"), true);
  assert.equal(isViewAsRequestAllowed("POST", "/api/logout"), true);
  assert.equal(isViewAsRequestAllowed("POST", "/api/events/5/register"), false);
  assert.equal(isViewAsRequestAllowed("POST", "/api/admin/events/checkins/scan"), false);
  assert.equal(isViewAsRequestAllowed("PATCH", "/api/me/password"), false);
  assert.equal(isViewAsRequestAllowed("DELETE", "/api/admin/events/5"), false);
  assert.equal(isViewAsRequestAllowed("POST", "/api/admin/users/20/view-as"), false);
});
