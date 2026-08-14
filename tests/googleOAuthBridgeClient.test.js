import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

process.env.GOOGLE_OAUTH_BRIDGE_START_URL = "https://bridge.example.test/auth/google/start";
process.env.GOOGLE_OAUTH_BRIDGE_VERIFY_URL = "https://bridge.example.test/api/auth/verify";
process.env.GOOGLE_OAUTH_BRIDGE_SHARED_SECRET = "test-only-shared-secret-with-at-least-32-characters";
process.env.GOOGLE_OAUTH_BRIDGE_TIMEOUT_MS = "1000";

const {
  buildGoogleBridgeAuthorizationUrl,
  GoogleOAuthBridgeError,
  redeemGoogleBridgeCode,
} = await import("../src/services/googleOAuthBridgeClient.js");

const attempt = crypto.randomBytes(32).toString("base64url");

test("buildGoogleBridgeAuthorizationUrl signs a short-lived HTTPS request", () => {
  const expiresAt = Math.floor(Date.now() / 1000) + 300;
  const url = new URL(buildGoogleBridgeAuthorizationUrl({ attempt, expiresAt }));
  const expectedSignature = crypto
    .createHmac("sha256", process.env.GOOGLE_OAUTH_BRIDGE_SHARED_SECRET)
    .update(`${attempt}.${expiresAt}`)
    .digest("hex");

  assert.equal(url.protocol, "https:");
  assert.equal(url.searchParams.get("attempt"), attempt);
  assert.equal(url.searchParams.get("expires"), String(expiresAt));
  assert.equal(url.searchParams.get("signature"), expectedSignature);
});

test("redeemGoogleBridgeCode signs the exact body and validates identity", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), process.env.GOOGLE_OAUTH_BRIDGE_VERIFY_URL);
    assert.equal(options.method, "POST");
    const timestamp = options.headers["X-Bridge-Timestamp"];
    const nonce = options.headers["X-Bridge-Nonce"];
    const expected = crypto
      .createHmac("sha256", process.env.GOOGLE_OAUTH_BRIDGE_SHARED_SECRET)
      .update(`${timestamp}.${nonce}.${options.body}`)
      .digest("hex");
    assert.equal(options.headers["X-Bridge-Signature"], expected);

    return new Response(
      JSON.stringify({
        ok: true,
        identity: {
          provider: "google",
          subject: "google-subject",
          email: "user@example.test",
          email_verified: true,
          first_name: "Test",
          last_name: "User",
          picture: null,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  const identity = await redeemGoogleBridgeCode({ code: "opaque-code", attempt });
  assert.deepEqual(identity, {
    subject: "google-subject",
    email: "user@example.test",
    emailVerified: true,
    firstName: "Test",
    lastName: "User",
    picture: null,
  });
});

test("redeemGoogleBridgeCode distinguishes an expired one-time code", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: false, error: "code_expired" }), {
      status: 410,
      headers: { "Content-Type": "application/json" },
    });

  await assert.rejects(
    redeemGoogleBridgeCode({ code: "expired-code", attempt }),
    (error) =>
      error instanceof GoogleOAuthBridgeError &&
      error.status === 410 &&
      error.code === "code_expired" &&
      error.terminal === true,
  );
});
