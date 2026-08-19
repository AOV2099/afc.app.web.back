import http from "node:http";
import { pathToFileURL } from "node:url";
import process from "node:process";
import httpProxy from "http-proxy";

const HOST = String(process.env.GATEWAY_HOST || "127.0.0.1").trim();
const PORT = parsePort(process.env.GATEWAY_PORT, 3010, "GATEWAY_PORT");
const FRONT_TARGET = parseTarget(
  process.env.AFC_FRONT_TARGET || "http://127.0.0.1:3005",
  "AFC_FRONT_TARGET",
);
const BACK_TARGET = parseTarget(
  process.env.AFC_BACK_TARGET || "http://127.0.0.1:3004",
  "AFC_BACK_TARGET",
);

function parsePort(value, fallback, name) {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} debe ser un puerto válido.`);
  }
  return parsed;
}

function parseTarget(value, name) {
  let target;
  try {
    target = new URL(String(value || "").trim());
  } catch {
    throw new Error(`${name} no contiene una URL válida.`);
  }

  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error(`${name} debe utilizar HTTP o HTTPS.`);
  }
  if (target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error(`${name} debe contener únicamente un origen interno.`);
  }
  return target.origin;
}

function firstForwardedValue(value) {
  return String(value || "").split(",")[0].trim();
}

function forwardedProtocol(req) {
  const forwarded = firstForwardedValue(req.headers["x-forwarded-proto"]).toLowerCase();
  if (forwarded === "http" || forwarded === "https") return forwarded;
  return req.socket.encrypted ? "https" : "http";
}

function forwardedHost(req) {
  return firstForwardedValue(req.headers["x-forwarded-host"]) || String(req.headers.host || "").trim();
}

function appendForwardedFor(req) {
  const existing = String(req.headers["x-forwarded-for"] || "").trim();
  const remoteAddress = String(req.socket.remoteAddress || "").trim();
  if (!remoteAddress) return existing;
  return existing ? `${existing}, ${remoteAddress}` : remoteAddress;
}

export function prepareForwardedHeaders(req) {
  const protocol = forwardedProtocol(req);
  const host = forwardedHost(req);
  const port = firstForwardedValue(req.headers["x-forwarded-port"]) ||
    (protocol === "https" ? "443" : "80");

  req.headers["x-forwarded-proto"] = protocol;
  req.headers["x-forwarded-host"] = host;
  req.headers["x-forwarded-port"] = port;
  req.headers["x-forwarded-for"] = appendForwardedFor(req);
}

export function isBackendPath(rawUrl) {
  const pathname = new URL(rawUrl || "/", "http://gateway.local").pathname;
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/")
  );
}

function targetFor(req) {
  return isBackendPath(req.url) ? BACK_TARGET : FRONT_TARGET;
}

const proxy = httpProxy.createProxyServer({
  changeOrigin: false,
  xfwd: false,
  ws: true,
  proxyTimeout: 30_000,
  timeout: 30_000,
});

proxy.on("error", (error, req, res) => {
  console.error("Gateway proxy error", {
    code: error?.code || "proxy_error",
    upstream: isBackendPath(req?.url) ? "backend" : "frontend",
  });

  if (res && !res.headersSent && typeof res.writeHead === "function") {
    res.writeHead(502, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
  }
  if (res && !res.writableEnded && typeof res.end === "function") {
    res.end(JSON.stringify({ ok: false, message: "Servicio AFC no disponible." }));
  }
});

export const server = http.createServer((req, res) => {
  const pathname = new URL(req.url || "/", "http://gateway.local").pathname;
  if (pathname === "/gateway-health" || pathname === "/health/live") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, service: "afc-gateway" }));
    return;
  }

  prepareForwardedHeaders(req);
  proxy.web(req, res, { target: targetFor(req) });
});

server.on("upgrade", (req, socket, head) => {
  prepareForwardedHeaders(req);
  proxy.ws(req, socket, head, { target: targetFor(req) });
});

function shutdown(signal) {
  console.log(`Gateway recibió ${signal}; cerrando...`);
  server.close(() => process.exit(0));
}

const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  server.listen(PORT, HOST, () => {
    console.log(`AFC Gateway escuchando en http://${HOST}:${PORT}`);
    console.log(`Frontend upstream: ${FRONT_TARGET}`);
    console.log(`Backend upstream (/api, /auth): ${BACK_TARGET}`);
  });

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}
