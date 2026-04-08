import { Router } from "express";
import { getRedisClient } from "../redisClient.js";
import { getPostgresPool } from "../postgresClient.js";

const router = Router();

router.get("/health", (_req, res) => {
  const redisReady = Boolean(getRedisClient());
  const postgresReady = Boolean(getPostgresPool());

  res.status(200).json({
    ok: true,
    service: "afc-back",
    db: {
      redis: redisReady ? "connected" : "not-ready",
      postgres: postgresReady ? "connected" : "not-ready",
    },
  });
});

export default router;
