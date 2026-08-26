import assert from "node:assert/strict";
import test from "node:test";

import adminUsersRouter from "../src/routes/adminUsersRoutes.js";
import {
  buildRequestAuth,
  isGlobalCareerAdmin,
  normalizeCareerId,
  requireCareerAdmin,
} from "../src/middleware/auth.js";
import {
  AdminUserCareerScopeError,
  assertRequestedCareerAccess,
  assertTargetCareerAccess,
  buildAdminCareerFilter,
  lockAdminUserTarget,
  resolveEffectiveCreateCareer,
} from "../src/services/adminUserCareerScope.js";

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

function scopeError(code) {
  return (error) => error instanceof AdminUserCareerScopeError && error.code === code;
}

test("normalizes career IDs and identifies only career 1 as a global admin", () => {
  assert.equal(normalizeCareerId("2"), 2);
  assert.equal(normalizeCareerId(null), null);
  assert.equal(normalizeCareerId("2.5"), null);
  assert.equal(normalizeCareerId(-1), null);
  assert.equal(isGlobalCareerAdmin({ role: "admin", careerId: "1" }), true);
  assert.equal(isGlobalCareerAdmin({ role: "admin", careerId: 2 }), false);
  assert.equal(isGlobalCareerAdmin({ role: "staff", careerId: 1 }), false);
});

test("career admin middleware denies old, null, and invalid career sessions", () => {
  for (const session of [
    { userId: "1", role: "admin" },
    { userId: "1", role: "admin", careerId: null },
    { userId: "1", role: "admin", careerId: "invalid" },
  ]) {
    const req = { auth: buildRequestAuth("sid", session) };
    const res = response();
    let nextCalled = false;
    requireCareerAdmin(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.payload.code, "career_required");
  }
});

test("career admin middleware preserves the admin-only rule and accepts valid career scope", () => {
  const forbiddenRes = response();
  requireCareerAdmin(
    { auth: { role: "staff", careerId: 2 } },
    forbiddenRes,
    () => assert.fail("staff must not pass"),
  );
  assert.equal(forbiddenRes.statusCode, 403);
  assert.equal(forbiddenRes.payload.code, undefined);

  const req = { auth: { role: "admin", careerId: "8" } };
  let nextCalled = false;
  requireCareerAdmin(req, response(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.auth.careerId, 8);
});

test("global list scope adds no career filter while scoped list uses a parameter", () => {
  assert.deepEqual(buildAdminCareerFilter({ role: "admin", careerId: 1 }, 2), {
    clause: "",
    params: [],
  });
  assert.deepEqual(buildAdminCareerFilter({ role: "admin", careerId: 7 }, 2), {
    clause: "u.career_id = $2",
    params: [7],
  });
});

test("scoped creation forces an omitted career and rejects explicit null or mismatch", () => {
  const scoped = { role: "admin", careerId: 6 };
  assert.equal(resolveEffectiveCreateCareer(scoped, { provided: false, value: undefined }), 6);
  assert.equal(resolveEffectiveCreateCareer(scoped, { provided: true, value: "6" }), 6);
  assert.throws(
    () => resolveEffectiveCreateCareer(scoped, { provided: true, value: null }),
    scopeError("career_scope_mismatch"),
  );
  assert.throws(
    () => resolveEffectiveCreateCareer(scoped, { provided: true, value: 9 }),
    scopeError("career_scope_mismatch"),
  );

  const global = { role: "admin", careerId: 1 };
  assert.equal(resolveEffectiveCreateCareer(global, { provided: true, value: null }), null);
  assert.equal(resolveEffectiveCreateCareer(global, { provided: true, value: 9 }), 9);
});

test("same-career update and password access is allowed while cross-career targets are denied", () => {
  const scoped = { role: "admin", careerId: 4 };
  assert.doesNotThrow(() => assertTargetCareerAccess(scoped, "4"));
  assert.throws(() => assertTargetCareerAccess(scoped, 5), scopeError("career_scope_mismatch"));
  assert.throws(() => assertTargetCareerAccess(scoped, null), scopeError("career_scope_mismatch"));

  assert.doesNotThrow(() =>
    assertRequestedCareerAccess(scoped, { provided: false, value: undefined }));
  assert.doesNotThrow(() =>
    assertRequestedCareerAccess(scoped, { provided: true, value: 4 }));
  assert.throws(
    () => assertRequestedCareerAccess(scoped, { provided: true, value: null }),
    scopeError("career_scope_mismatch"),
  );
  assert.throws(
    () => assertRequestedCareerAccess(scoped, { provided: true, value: 5 }),
    scopeError("career_scope_mismatch"),
  );

  const global = { role: "admin", careerId: 1 };
  assert.doesNotThrow(() => assertTargetCareerAccess(global, null));
  assert.doesNotThrow(() =>
    assertRequestedCareerAccess(global, { provided: true, value: null }));
});

test("target authorization service locks before allowing update or password work", async () => {
  const statements = [];
  const sameCareerTx = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [{ id: "25", career_id: "4", attributes: {} }] };
    },
  };
  const target = await lockAdminUserTarget(
    sameCareerTx,
    { role: "admin", careerId: 4 },
    25,
    { includeAttributes: true },
  );
  assert.equal(target.id, "25");
  assert.match(statements[0].sql, /FOR UPDATE/u);
  assert.match(statements[0].sql, /attributes/u);
  assert.deepEqual(statements[0].params, [25]);

  const crossCareerTx = {
    async query() { return { rows: [{ id: "26", career_id: "5" }] }; },
  };
  await assert.rejects(
    lockAdminUserTarget(crossCareerTx, { role: "admin", careerId: 4 }, 26),
    scopeError("career_scope_mismatch"),
  );
});

test("every admin-user route uses career-aware admin middleware", () => {
  const protectedRoutes = adminUsersRouter.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods),
      handlers: layer.route.stack.map((routeLayer) => routeLayer.handle),
    }));

  assert.deepEqual(
    protectedRoutes.map(({ path, methods }) => `${methods[0].toUpperCase()} ${path}`),
    [
      "POST /api/admin/users/import/preview",
      "POST /api/admin/users/import/:importId/commit",
      "GET /api/admin/users",
      "GET /api/admin/staff-users",
      "POST /api/admin/users",
      "PUT /api/admin/users/:userId",
      "PATCH /api/admin/users/:userId/password",
    ],
  );
  assert.ok(protectedRoutes.every(({ handlers }) => handlers.includes(requireCareerAdmin)));
});
