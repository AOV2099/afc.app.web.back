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
  assert.equal(third.headers["Retry-After"], "60");
});
