import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function request(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

function upstream(name) {
  return http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      upstream: name,
      path: req.url,
      forwardedProto: req.headers["x-forwarded-proto"],
      forwardedHost: req.headers["x-forwarded-host"],
    }));
  });
}

test("routes UI to front and /api plus /auth to back while preserving public HTTPS metadata", async (context) => {
  const front = upstream("front");
  const back = upstream("back");
  const frontAddress = await listen(front);
  const backAddress = await listen(back);

  process.env.AFC_FRONT_TARGET = `http://127.0.0.1:${frontAddress.port}`;
  process.env.AFC_BACK_TARGET = `http://127.0.0.1:${backAddress.port}`;
  process.env.GATEWAY_HOST = "127.0.0.1";
  process.env.GATEWAY_PORT = "3010";

  const moduleUrl = new URL(`./server.js?test=${Date.now()}`, import.meta.url);
  const { server } = await import(moduleUrl);
  const gatewayAddress = await listen(server);

  context.after(async () => {
    await Promise.all([close(server), close(front), close(back)]);
  });

  const headers = {
    Host: "reclining-sulfur-reward.ngrok-free.dev",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "reclining-sulfur-reward.ngrok-free.dev",
  };
  const ui = JSON.parse((await request(gatewayAddress.port, "/", headers)).body);
  const api = JSON.parse((await request(gatewayAddress.port, "/api/me", headers)).body);
  const auth = JSON.parse((await request(gatewayAddress.port, "/auth/google", headers)).body);
  const health = await request(gatewayAddress.port, "/gateway-health");
  const publicLive = await request(gatewayAddress.port, "/health/live");

  assert.equal(ui.upstream, "front");
  assert.equal(api.upstream, "back");
  assert.equal(auth.upstream, "back");
  assert.equal(auth.forwardedProto, "https");
  assert.equal(auth.forwardedHost, "reclining-sulfur-reward.ngrok-free.dev");
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.body).service, "afc-gateway");
  assert.equal(publicLive.status, 200);
  assert.equal(JSON.parse(publicLive.body).service, "afc-gateway");
});
