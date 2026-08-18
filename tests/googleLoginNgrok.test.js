import assert from "node:assert/strict";
import test from "node:test";

import {
  PublicUrlConfigError,
  resolveOAuthPublicConfig,
  validatePublicProxyRequest,
} from "../src/services/publicUrl.js";
import {
  createGoogleOAuthState,
  consumeGoogleOAuthState,
  statesMatch,
} from "../src/services/googleOAuthState.js";

class FakeRedis {
  values = new Map();
  async set(key, value) { this.values.set(key, value); }
  async getDel(key) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

test("builds exact /auth/google/callback under PUBLIC_URL", () => {
  assert.deepEqual(
    resolveOAuthPublicConfig({
      publicUrl: "https://reclining-sulfur-reward.ngrok-free.dev",
      googleCallbackUrl: "",
    }),
    {
      publicOrigin: "https://reclining-sulfur-reward.ngrok-free.dev",
      publicHostname: "reclining-sulfur-reward.ngrok-free.dev",
      callbackUrl: "https://reclining-sulfur-reward.ngrok-free.dev/auth/google/callback",
    },
  );
});

test("rejects HTTP, host injection and mismatched callback origins", () => {
  assert.throws(
    () => resolveOAuthPublicConfig({ publicUrl: "http://example.test", googleCallbackUrl: "" }),
    (error) => error instanceof PublicUrlConfigError && error.code === "public_url_https_required",
  );
  assert.throws(
    () => resolveOAuthPublicConfig({ publicUrl: "https://example.test/path", googleCallbackUrl: "" }),
    (error) => error.code === "invalid_public_url",
  );
  assert.throws(
    () => resolveOAuthPublicConfig({
      publicUrl: "https://example.test",
      googleCallbackUrl: "https://attacker.test/auth/google/callback",
    }),
    (error) => error.code === "callback_origin_mismatch",
  );
});

test("requires HTTPS and host metadata trusted through the gateway", () => {
  const config = resolveOAuthPublicConfig({ publicUrl: "https://example.test", googleCallbackUrl: "" });
  assert.doesNotThrow(() => validatePublicProxyRequest({ secure: true, hostname: "example.test" }, config));
  assert.throws(
    () => validatePublicProxyRequest({ secure: false, hostname: "example.test" }, config),
    (error) => error.code === "forwarded_https_missing",
  );
  assert.throws(
    () => validatePublicProxyRequest({ secure: true, hostname: "other.test" }, config),
    (error) => error.code === "forwarded_host_mismatch",
  );
});

test("stores PKCE state and consumes it exactly once", async () => {
  const redis = new FakeRedis();
  const oauthClient = {
    async generateCodeVerifierAsync() {
      return { codeVerifier: "verifier", codeChallenge: "challenge" };
    },
  };

  const created = await createGoogleOAuthState({ redis, oauthClient, ttlSeconds: 300 });
  assert.equal(created.codeChallenge, "challenge");
  assert.equal(statesMatch(created.state, created.state), true);
  assert.equal(statesMatch(created.state, "wrong"), false);
  assert.equal((await consumeGoogleOAuthState({ redis, state: created.state })).codeVerifier, "verifier");
  assert.equal(await consumeGoogleOAuthState({ redis, state: created.state }), null);
});
