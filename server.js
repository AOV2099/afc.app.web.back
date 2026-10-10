import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import {
  ALLOWED_ORIGINS,
  CORS_ALLOW_ANY_ORIGIN,
  PUBLIC_URL,
  TRUST_PROXY,
} from "./src/config/appConfig.js";

import { connectRedis, getRedisClient } from "./src/redisClient.js";
import { connectPostgres, closePostgres } from "./src/postgresClient.js";

import healthRoutes from "./src/routes/healthRoutes.js";
import authRoutes from "./src/routes/authRoutes.js";
import adminUsersRoutes from "./src/routes/adminUsersRoutes.js";
import eventsRoutes from "./src/routes/eventsRoutes.js";
import afcCatalogRoutes from "./src/routes/afcCatalogRoutes.js";
import filesRoutes from "./src/routes/filesRoutes.js";
import careersRoutes from "./src/routes/careersRoutes.js";
import alertsRoutes from "./src/routes/alertsRoutes.js";
import viewAsRoutes from "./src/routes/viewAsRoutes.js";
import {
  EVENT_TIME_ZONE,
  startEventFinalizationScheduler,
} from "./src/services/eventFinalizationScheduler.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_LOCAL_RUNTIME = process.env.NODE_ENV !== "production";
const allowAnyCorsOrigin = CORS_ALLOW_ANY_ORIGIN;
let eventFinalizationScheduler = null;

app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY);

if (PUBLIC_URL && !TRUST_PROXY) {
  console.error(
    "PUBLIC_URL está configurada pero TRUST_PROXY está desactivado; OAuth HTTPS será rechazado.",
  );
}

const allowedOrigins = new Set([
  ...ALLOWED_ORIGINS,
  ...(PUBLIC_URL ? [PUBLIC_URL] : []),
]);
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowAnyCorsOrigin || allowedOrigins.has(origin)) {
      return callback(null, true);
    }
    // Sin cabeceras CORS: el navegador bloquea la respuesta sin provocar un error 500.
    return callback(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use((_req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  next();
});
app.use(cookieParser());
app.use(cors(corsOptions));
app.use(express.json({ limit: "200kb" }));

app.use(healthRoutes);
app.use(authRoutes);
app.use(adminUsersRoutes);
app.use(eventsRoutes);
app.use(afcCatalogRoutes);
app.use(filesRoutes);
app.use(careersRoutes);
app.use(alertsRoutes);
app.use(viewAsRoutes);

app.use((req, res) => {
  res.status(404).json({ ok: false, message: "Recurso no encontrado." });
});

// Respuesta JSON genérica: nunca expone stack traces ni mensajes internos.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, message: "El cuerpo de la solicitud no es JSON válido." });
  }
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ ok: false, message: "La solicitud es demasiado grande." });
  }
  console.error(`Error no controlado en ${req.method} ${req.path}:`, err?.message);
  return res.status(500).json({ ok: false, message: "Error interno del servidor." });
});

async function initializeDbClients() {
  console.log("Inicializando clientes de base de datos...");

  const results = await Promise.allSettled([connectRedis(), connectPostgres()]);
  const [redisResult, postgresResult] = results;

  if (redisResult.status === "fulfilled") {
    console.log("Redis inicializado 🟢");
  } else {
    console.error("Redis no pudo inicializarse:", redisResult.reason?.message);
  }

  if (postgresResult.status === "fulfilled") {
    console.log("Postgres inicializado 🟢");
  } else {
    console.error(
      "Postgres no pudo inicializarse:",
      postgresResult.reason?.message,
    );
  }
}

async function shutdown(signal) {
  console.log(`Recibida señal ${signal}. Cerrando servidor...`);

  eventFinalizationScheduler?.stop();
  eventFinalizationScheduler = null;

  try {
    const redisClient = getRedisClient();
    if (redisClient?.isOpen) {
      await redisClient.quit();
      console.log("Redis cerrado correctamente");
    }
  } catch (err) {
    console.error("Error cerrando Redis:", err.message);
  }

  try {
    await closePostgres();
  } catch (err) {
    console.error("Error cerrando Postgres:", err.message);
  }

  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

async function startServer() {
  await initializeDbClients();
  eventFinalizationScheduler = startEventFinalizationScheduler();

  app.listen(PORT, () => {
    console.log(`Servidor Express escuchando en puerto ${PORT}`);
    console.log(
      `Gateway confiable: ${TRUST_PROXY || "desactivado"}; URL pública: ${PUBLIC_URL || "no configurada"}`,
    );
    console.log(
      `Finalización automática activa: eventos publicados pasan a finalizados a las 00:00 (${EVENT_TIME_ZONE}) del día siguiente.`,
    );
    if (IS_LOCAL_RUNTIME) {
      console.log("Entorno no productivo/local: CORS acepta cualquier origen.");
    } else if (CORS_ALLOW_ANY_ORIGIN) {
      console.warn(
        "Producción: CORS acepta cualquier origen porque CORS_ALLOW_ANY_ORIGIN está activado.",
      );
    } else {
      console.log("Producción: CORS restringido a la lista de orígenes permitidos.");
    }
  });
}

startServer().catch((err) => {
  console.error("Error iniciando el servidor:", err.message);
  process.exit(1);
});

