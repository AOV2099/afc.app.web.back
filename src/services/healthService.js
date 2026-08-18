import { performance } from "node:perf_hooks";

const PUBLIC_ERRORS = {
  postgres: "Database unavailable",
  redis: "Redis unavailable",
  ngrok: "Public HTTPS endpoint unavailable",
};

class DependencyCheckError extends Error {
  constructor(service, responseTimeMs) {
    super(`${service} health check failed`);
    this.name = "DependencyCheckError";
    this.service = service;
    this.responseTimeMs = responseTimeMs;
  }
}

function elapsedMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function withTimeout(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("health_check_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function timedCheck(service, timeoutMs, work) {
  const startedAt = performance.now();
  try {
    const details = await withTimeout(work, timeoutMs);
    return {
      status: "up",
      responseTimeMs: elapsedMs(startedAt),
      ...(details || {}),
    };
  } catch {
    throw new DependencyCheckError(service, elapsedMs(startedAt));
  }
}

function publicHealthUrl(publicUrl) {
  let url;
  try {
    url = new URL(String(publicUrl || "").trim());
  } catch {
    throw new Error("public_url_invalid");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("public_url_https_required");
  }

  return {
    origin: url.origin,
    healthUrl: new URL("/health/live", url.origin).toString(),
  };
}

export function createHealthChecker({
  getPostgresPool,
  getRedisClient,
  fetchImpl = globalThis.fetch,
  publicUrl,
  timeoutMs = 5000,
  logger = console,
  uptime = () => process.uptime(),
  now = () => new Date(),
}) {
  const normalizedTimeout = Number.isFinite(Number(timeoutMs))
    ? Math.min(10_000, Math.max(500, Math.trunc(Number(timeoutMs))))
    : 5000;

  const checks = {
    postgres: () =>
      timedCheck("postgres", normalizedTimeout, async () => {
        const pool = getPostgresPool();
        if (!pool || typeof pool.query !== "function") throw new Error("pool_not_ready");
        await pool.query({ text: "SELECT 1", query_timeout: normalizedTimeout });
      }),
    redis: () =>
      timedCheck("redis", normalizedTimeout, async () => {
        const client = getRedisClient();
        if (!client || typeof client.ping !== "function") throw new Error("client_not_ready");
        const reply = await client.ping();
        if (String(reply).toUpperCase() !== "PONG") throw new Error("unexpected_ping_reply");
      }),
    ngrok: () =>
      timedCheck("ngrok", normalizedTimeout, async () => {
        const target = publicHealthUrl(publicUrl);
        const controller = new AbortController();
        const abortTimer = setTimeout(() => controller.abort(), normalizedTimeout);
        try {
          const response = await fetchImpl(target.healthUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              Accept: "application/json",
              "User-Agent": "AFC-HealthCheck/1.0",
            },
          });
          if (response.status < 200 || response.status >= 400) {
            throw new Error("unexpected_public_status");
          }
          return { url: target.origin };
        } finally {
          clearTimeout(abortTimer);
        }
      }),
  };

  return async function runHealthChecks() {
    const names = Object.keys(checks);
    const settled = await Promise.allSettled(names.map((name) => checks[name]()));
    const services = {
      backend: { status: "up" },
    };

    settled.forEach((result, index) => {
      const name = names[index];
      if (result.status === "fulfilled") {
        services[name] = result.value;
        return;
      }

      const responseTimeMs =
        result.reason instanceof DependencyCheckError
          ? result.reason.responseTimeMs
          : normalizedTimeout;
      services[name] = {
        status: "down",
        responseTimeMs,
        error: PUBLIC_ERRORS[name],
        ...(name === "ngrok" && String(publicUrl || "").trim()
          ? { url: (() => {
              try {
                return new URL(String(publicUrl).trim()).origin;
              } catch {
                return undefined;
              }
            })() }
          : {}),
      };
      if (services[name].url === undefined) delete services[name].url;
      logger.error(`[HEALTH] ${name === "postgres" ? "PostgreSQL" : name === "redis" ? "Redis" : "Public HTTPS endpoint"} check failed`);
    });

    const healthy = names.every((name) => services[name]?.status === "up");
    return {
      status: healthy ? "healthy" : "degraded",
      timestamp: now().toISOString(),
      uptime: Math.floor(uptime()),
      services,
    };
  };
}
