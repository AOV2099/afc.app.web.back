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
import alertsRoutes from "./src/routes/alertsRoutes.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_LOCAL_RUNTIME = process.env.NODE_ENV !== "production";
const allowAnyCorsOrigin = IS_LOCAL_RUNTIME || CORS_ALLOW_ANY_ORIGIN;

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
    return callback(new Error("Origen no permitido por CORS"));
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cookieParser());
app.use(cors(corsOptions));
app.use(express.json());

app.use(healthRoutes);
app.use(authRoutes);
app.use(adminUsersRoutes);
app.use(eventsRoutes);
app.use(alertsRoutes);

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

  app.listen(PORT, () => {
    console.log(`Servidor Express escuchando en puerto ${PORT}`);
    console.log(
      `Gateway confiable: ${TRUST_PROXY || "desactivado"}; URL pública: ${PUBLIC_URL || "no configurada"}`,
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

