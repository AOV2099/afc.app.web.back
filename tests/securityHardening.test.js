import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isSessionStillValid } from "../src/middleware/auth.js";
import { escapeLikePattern, parsePositiveIntParam } from "../src/utils/requestParams.js";
import { parseRequestPath } from "../gateway/server.js";

test("sessions are revoked when the user is disabled or loses role/career", () => {
  const session = { role: "admin", careerId: 3 };
  assert.equal(isSessionStillValid(session, { status: "active", role: "admin", career_id: "3" }), true);
  assert.equal(isSessionStillValid(session, { status: "inactive", role: "admin", career_id: "3" }), false);
  assert.equal(isSessionStillValid(session, { status: "active", role: "student", career_id: "3" }), false);
  assert.equal(isSessionStillValid(session, { status: "active", role: "admin", career_id: "1" }), false);
  assert.equal(isSessionStillValid(session, null), false);
  assert.equal(isSessionStillValid({ role: "visitor", careerId: null }, { status: "active", role: "visitor", career_id: null }), true);
});

test("search terms are matched literally and pagination ignores invalid values", () => {
  assert.equal(escapeLikePattern("100%_a\\b"), "100\\%\\_a\\\\b");
  assert.equal(parsePositiveIntParam("abc", 1), 1);
  assert.equal(parsePositiveIntParam("2.5", 1), 1);
  assert.equal(parsePositiveIntParam("-3", 1), 1);
  assert.equal(parsePositiveIntParam("500", 20, 100), 100);
  assert.equal(parsePositiveIntParam("7", 20, 100), 7);
});

test("gateway rejects malformed request targets instead of crashing", () => {
  assert.equal(parseRequestPath("//["), null);
  assert.equal(parseRequestPath("/api/me?x=1"), "/api/me");
});

test("login and registration are rate limited and do not reveal whether an account exists", async () => {
  const source = await readFile(new URL("../src/routes/authRoutes.js", import.meta.url), "utf8");
  assert.match(source, /"\/api\/login", limitPasswordLogin/u);
  assert.match(source, /"\/api\/register", limitRegister/u);
  assert.match(source, /userRow\?\.password_hash \|\| DUMMY_PASSWORD_HASH/u);
  assert.doesNotMatch(source, /usuario sin rol asignado/u);
});

test("staff can only scan check-ins; event management is admin-only", async () => {
  const { requireEventManager, requireCheckinScanner } = await import("../src/middleware/auth.js");
  const run = (middleware, role) => {
    let nextCalled = false;
    let statusCode = null;
    const res = { status(code) { statusCode = code; return { json: () => null }; } };
    middleware({ auth: { role } }, res, () => { nextCalled = true; });
    return nextCalled ? "next" : statusCode;
  };
  assert.equal(run(requireEventManager, "admin"), "next");
  assert.equal(run(requireEventManager, "staff"), 403);
  assert.equal(run(requireCheckinScanner, "staff"), "next");
  assert.equal(run(requireCheckinScanner, "admin"), "next");
  assert.equal(run(requireCheckinScanner, "student"), 403);

  const source = await readFile(new URL("../src/routes/eventsRoutes.js", import.meta.url), "utf8");
  assert.match(source, /"\/api\/admin\/events\/checkins\/scan",\s*requireAuth,\s*requireCheckinScanner/u);
  assert.match(
    source,
    /if \(req\.auth\?\.role !== ROLES\.STAFF\) \{\s*assertEventCareerAccess\(req\.auth\.careerId, event\.owner_career_id\);/u,
  );
});

test("alerts can be managed by the superadmin or admins of the alert's career", async () => {
  const { canManageAlert } = await import("../src/routes/alertsRoutes.js");
  const alert = { career_id: 4 };
  assert.equal(canManageAlert({ role: "admin", careerId: 1 }, alert), true);
  assert.equal(canManageAlert({ role: "admin", careerId: 4 }, alert), true);
  assert.equal(canManageAlert({ role: "admin", careerId: 5 }, alert), false);
  assert.equal(canManageAlert({ role: "staff", careerId: 4 }, alert), false);
  assert.equal(canManageAlert({ role: "admin", careerId: 4 }, { career_id: null }), false);
});

test("events with attendance cannot be deleted and only reschedule sessions without check-ins", async () => {
  const source = await readFile(new URL("../src/routes/eventsRoutes.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DELETE FROM hours_ledger/u);
  assert.match(source, /code: "event_has_attendance"/u);
  assert.match(source, /planSessionReschedule\(existingSessions, normalizedSessions\)/u);
});

test("events with attendance keep their dates, hours and closed status", async () => {
  const { assertAttendanceLockedFields } = await import("../src/routes/eventsRoutes.js");
  const existing = {
    starts_at: "2026-10-01T16:00:00.000Z",
    ends_at: "2026-10-01T18:00:00.000Z",
    hours_value: "4.00",
    status: "ended",
  };
  const conflict = { statusCode: 409 };
  assert.doesNotThrow(() => assertAttendanceLockedFields(existing, { title: "Nuevo título", status: "ended" }));
  assert.doesNotThrow(() => assertAttendanceLockedFields(existing, { status: "cancelled", hours_value: "4" }));
  assert.doesNotThrow(() => assertAttendanceLockedFields(existing, { starts_at: existing.starts_at }));
  assert.throws(() => assertAttendanceLockedFields(existing, { starts_at: "2026-10-02T16:00:00.000Z" }), conflict);
  assert.doesNotThrow(
    () =>
      assertAttendanceLockedFields(existing, {
        starts_at: "2026-10-02T16:00:00.000Z",
        sessions: [{ starts_at: "2026-10-02T16:00:00.000Z", ends_at: "2026-10-02T18:00:00.000Z" }],
      }),
    "con sesiones, la reprogramación se valida sesión por sesión",
  );
  assert.throws(() => assertAttendanceLockedFields(existing, { hours_value: "6" }), conflict);
  assert.throws(() => assertAttendanceLockedFields(existing, { afc_valuation: { activity_type_key: "x" } }), conflict);
  assert.throws(() => assertAttendanceLockedFields(existing, { status: "published" }), conflict);
  assert.throws(() => assertAttendanceLockedFields(existing, { status: "draft" }), conflict);
  assert.throws(() => assertAttendanceLockedFields(existing, { afc_hours_enabled: false }), conflict);
  assert.throws(
    () => assertAttendanceLockedFields({ ...existing, min_attendance_percent: 80 }, { min_attendance_percent: 60 }),
    conflict,
  );
  assert.doesNotThrow(() =>
    assertAttendanceLockedFields({ ...existing, min_attendance_percent: 80 }, { min_attendance_percent: 80 }),
  );
  assert.doesNotThrow(() =>
    assertAttendanceLockedFields({ ...existing, hours_value: "0.00" }, { afc_hours_enabled: false }),
  );
});
