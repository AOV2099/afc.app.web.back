import { Router } from "express";

import { HEALTHCHECK_TIMEOUT_MS, PUBLIC_URL } from "../config/appConfig.js";
import { getPostgresPool } from "../postgresClient.js";
import { getRedisClient } from "../redisClient.js";
import { createHealthChecker } from "../services/healthService.js";

const runHealthChecks = createHealthChecker({
  getPostgresPool,
  getRedisClient,
  publicUrl: PUBLIC_URL,
  timeoutMs: HEALTHCHECK_TIMEOUT_MS,
});

export function createHealthRouter({ healthCheck = runHealthChecks } = {}) {
  const router = Router();

  const live = (_req, res) => {
    res.set("Cache-Control", "no-store");
    return res.status(200).json({ status: "up" });
  };

  router.get("/health", live);
  router.get("/api/health/live", live);

  router.get("/api/health", async (_req, res) => {
    res.set("Cache-Control", "no-store");

    try {
      const payload = await healthCheck();
      return res.status(payload.status === "healthy" ? 200 : 503).json(payload);
    } catch {
      console.error("[HEALTH] Unexpected health aggregation failure");
      return res.status(503).json({
        status: "degraded",
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        services: {
          backend: { status: "up" },
          postgres: { status: "down", error: "Database unavailable" },
          redis: { status: "down", error: "Redis unavailable" },
          ngrok: { status: "down", error: "Public HTTPS endpoint unavailable" },
        },
      });
    }
  });

  return router;
}

export default createHealthRouter();
