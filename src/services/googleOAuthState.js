import crypto from "crypto";

function stateKey(state) {
  return `oauth_google_state:${crypto.createHash("sha256").update(state).digest("hex")}`;
}

export async function createGoogleOAuthState({ redis, oauthClient, ttlSeconds }) {
  const state = crypto.randomBytes(32).toString("base64url");
  const { codeVerifier, codeChallenge } = await oauthClient.generateCodeVerifierAsync();
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;

  await redis.set(
    stateKey(state),
    JSON.stringify({ codeVerifier, expiresAt }),
    { EX: ttlSeconds },
  );

  return { state, codeChallenge };
}

export async function consumeGoogleOAuthState({ redis, state }) {
  const normalizedState = String(state || "").trim();
  if (!normalizedState) return null;

  const raw = await redis.getDel(stateKey(normalizedState));
  if (!raw) return null;

  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return null;
  }

  if (
    !stored?.codeVerifier ||
    !Number.isFinite(stored?.expiresAt) ||
    stored.expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return stored;
}

export function statesMatch(expected, actual) {
  const left = Buffer.from(String(expected || ""));
  const right = Buffer.from(String(actual || ""));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}
