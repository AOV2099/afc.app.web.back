import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import express from "express";

import { createHealthRouter } from "../src/routes/healthRoutes.js";
import { createHealthChecker } from "../src/services/healthService.js";

const PUBLIC_URL = "https://public.example.test";

function dependencies(overrides = {}) {
  const calls = { postgres: 0, redis: 0, ngrok: 0 };
  const pool = {
    async query(query) {
      calls.postgres += 1;
      assert.equal(query.text, "SELECT 1");
    },
  };
  const redis = {
    async ping() {
      calls.redis += 1;
      return "PONG";
    },
  };
  const fetchImpl = async (url) => {
    calls.ngrok += 1;
    assert.equal(url, `${PUBLIC_URL}/health/live`);
    return { status: 200 };
  };

  return {
    calls,
    getPostgresPool: () => overrides.pool ?? pool,
    getRedisClient: () => overrides.redis ?? redis,
    fetchImpl: overrides.fetchImpl ?? fetchImpl,
  };
}

function checker(overrides = {}) {
  const deps = dependencies(overrides);
  const logs = [];
  return {
    calls: deps.calls,
    logs,
    run: createHealthChecker({
      ...deps,
      publicUrl: overrides.publicUrl ?? PUBLIC_URL,
      timeoutMs: overrides.timeoutMs ?? 500,
      logger: { error: (message) => logs.push(message) },
      uptime: () => 12345.9,
      now: () => new Date("2026-08-18T22:00:00.000Z"),
    }),
  };
}

test("reports healthy when PostgreSQL, Redis and public HTTPS are available", async () => {
  const { run } = checker();
  const result = await run();

  assert.equal(result.status, "healthy");
  assert.equal(result.timestamp, "2026-08-18T22:00:00.000Z");
  assert.equal(result.uptime, 12345);
  assert.equal(result.services.backend.status, "up");
  assert.equal(result.services.postgres.status, "up");
  assert.equal(result.services.redis.status, "up");
  assert.equal(result.services.ngrok.status, "up");
  assert.equal(result.services.ngrok.url, PUBLIC_URL);
});

test("PostgreSQL failure degrades health without blocking Redis or ngrok checks", async () => {
  const failingPool = { async query() { throw new Error("postgres://user:secret@private/db"); } };
  const { run, calls, logs } = checker({ pool: failingPool });
  const result = await run();

  assert.equal(result.status, "degraded");
  assert.equal(result.services.postgres.status, "down");
  assert.equal(result.services.postgres.error, "Database unavailable");
  assert.equal(result.services.redis.status, "up");
  assert.equal(result.services.ngrok.status, "up");
  assert.equal(calls.redis, 1);
  assert.equal(calls.ngrok, 1);
  assert.ok(logs.includes("[HEALTH] PostgreSQL check failed"));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Redis failure returns a sanitized degraded result", async () => {
  const failingRedis = { async ping() { throw new Error("redis://:secret@private:6379"); } };
  const { run, logs } = checker({ redis: failingRedis });
  const result = await run();

  assert.equal(result.status, "degraded");
  assert.equal(result.services.redis.status, "down");
  assert.equal(result.services.redis.error, "Redis unavailable");
  assert.ok(logs.includes("[HEALTH] Redis check failed"));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("unreachable PUBLIC_URL degrades health without recursion", async () => {
  const { run, logs } = checker({
    fetchImpl: async (url) => {
      assert.equal(url, `${PUBLIC_URL}/health/live`);
      throw new Error("NGROK_AUTHTOKEN=secret");
    },
  });
  const result = await run();

  assert.equal(result.status, "degraded");
  assert.equal(result.services.ngrok.status, "down");
  assert.equal(result.services.ngrok.error, "Public HTTPS endpoint unavailable");
  assert.ok(logs.includes("[HEALTH] Public HTTPS endpoint check failed"));
  assert.equal(JSON.stringify(result).includes("NGROK_AUTHTOKEN"), false);
});

test("dependency timeout is isolated and other checks still finish", async () => {
  const never = new Promise(() => {});
  const { run } = checker({ pool: { query: () => never }, timeoutMs: 500 });
  const result = await run();

  assert.equal(result.status, "degraded");
  assert.equal(result.services.postgres.status, "down");
  assert.ok(result.services.postgres.responseTimeMs >= 450);
  assert.equal(result.services.redis.status, "up");
  assert.equal(result.services.ngrok.status, "up");
});

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("HTTP routes return 200 healthy, 503 degraded, and live never checks dependencies", async (context) => {
  let mode = "healthy";
  let checks = 0;
  const app = express();
  app.use(
    createHealthRouter({
      healthCheck: async () => {
        checks += 1;
        return {
          status: mode,
          timestamp: "2026-08-18T22:00:00.000Z",
          uptime: 1,
          services: { backend: { status: "up" } },
        };
      },
    }),
  );
  const server = await listen(app);
  context.after(() => close(server));
  const port = server.address().port;

  const live = await fetch(`http://127.0.0.1:${port}/api/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "up" });
  assert.equal(checks, 0);

  const healthy = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(healthy.status, 200);
  mode = "degraded";
  const degraded = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(degraded.status, 503);
  assert.equal(checks, 2);
});
