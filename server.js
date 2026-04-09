import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { connectRedis, getRedisClient } from "./src/redisClient.js";
import { connectPostgres, closePostgres } from "./src/postgresClient.js";

import healthRoutes from "./src/routes/healthRoutes.js";
import authRoutes from "./src/routes/authRoutes.js";
import adminUsersRoutes from "./src/routes/adminUsersRoutes.js";
import eventsRoutes from "./src/routes/eventsRoutes.js";
import alertsRoutes from "./src/routes/alertsRoutes.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
 
const corsOptions = {
  // Temporal: permitir cualquier origen.
  origin: true,
  // Lógica anterior de lista blanca (temporalmente deshabilitada):
  // origin(origin, callback) {
  //   if (!origin) return callback(null, true);
  //   if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
  //   return callback(new Error("Origen no permitido por CORS"));
  // },
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
  });
}

startServer().catch((err) => {
  console.error("Error iniciando el servidor:", err.message);
  process.exit(1);
});

