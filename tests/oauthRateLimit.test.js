import assert from "node:assert/strict";
import test from "node:test";

import { createOAuthRateLimit } from "../src/middleware/oauthRateLimit.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    set(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("limits repeated OAuth starts by trusted request IP", () => {
  const middleware = createOAuthRateLimit({ limit: 2, windowMs: 60_000, scope: "test" });
  const req = { ip: "203.0.113.10" };
  let nextCalls = 0;

  const first = response();
  const second = response();
  const third = response();
  middleware(req, first, () => nextCalls++);
  middleware(req, second, () => nextCalls++);
  middleware(req, third, () => nextCalls++);

  assert.equal(nextCalls, 2);
  assert.equal(third.statusCode, 429);
  assert.equal(third.payload.code, "oauth_rate_limited");
  assert.equal(
    third.payload.message,
    "Demasiados intentos de acceso. Espera un minuto e intenta nuevamente.",
  );
  assert.equal(third.headers["Retry-After"], "60");
});

test("supports a custom 429 code and message without changing limit behavior", () => {
  const middleware = createOAuthRateLimit({
    limit: 1,
    windowMs: 60_000,
    scope: "bulk-preview-test",
    code: "bulk_student_import_preview_rate_limited",
    message: "Demasiadas validaciones de archivos CSV.",
  });
  const req = { ip: "203.0.113.11" };
  let nextCalls = 0;

  middleware(req, response(), () => nextCalls++);
  const rejected = response();
  middleware(req, rejected, () => nextCalls++);

  assert.equal(nextCalls, 1);
  assert.equal(rejected.statusCode, 429);
  assert.deepEqual(rejected.payload, {
    ok: false,
    code: "bulk_student_import_preview_rate_limited",
    message: "Demasiadas validaciones de archivos CSV.",
  });
});
