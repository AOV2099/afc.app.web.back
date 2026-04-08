import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const PG_CONFIG = {
  connectionString: DATABASE_URL,
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "afc",
  user: process.env.PGUSER || "afc",
  password: process.env.PGPASSWORD || "admin",
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS || 5000),
  ssl:
    process.env.PG_SSL === "true"
      ? {
          rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== "false",
        }
      : false,
};

const MAX_RETRIES = Number(process.env.PG_MAX_RETRIES || 10);
const RETRY_BASE_DELAY_MS = Number(process.env.PG_RETRY_DELAY_MS || 2000);
const RETRY_BACKOFF_FACTOR = Number(process.env.PG_RETRY_BACKOFF_FACTOR || 1.5);
const RETRY_MAX_DELAY_MS = Number(process.env.PG_RETRY_MAX_DELAY_MS || 60000);

let pool;
let connectPromise;
let retryTimer;
let retries = 0;
let isShuttingDown = false;

function buildPoolConfig() {
  if (DATABASE_URL) {
    return {
      connectionString: PG_CONFIG.connectionString,
      max: PG_CONFIG.max,
      idleTimeoutMillis: PG_CONFIG.idleTimeoutMillis,
      connectionTimeoutMillis: PG_CONFIG.connectionTimeoutMillis,
      ssl: PG_CONFIG.ssl,
    };
  }

  return {
    host: PG_CONFIG.host,
    port: PG_CONFIG.port,
    database: PG_CONFIG.database,
    user: PG_CONFIG.user,
    password: PG_CONFIG.password,
    max: PG_CONFIG.max,
    idleTimeoutMillis: PG_CONFIG.idleTimeoutMillis,
    connectionTimeoutMillis: PG_CONFIG.connectionTimeoutMillis,
    ssl: PG_CONFIG.ssl,
  };
}

function registerPoolEvents(nextPool) {
  nextPool.on("connect", () => console.log("Postgres: nueva conexión abierta"));
  nextPool.on("acquire", () => console.log("Postgres: conexión adquirida del pool"));
  nextPool.on("remove", () => console.warn("Postgres: conexión removida del pool"));
  nextPool.on("error", (err) => {
    console.error("Postgres pool error:", err.message);
  });
}

function getRetryDelay(attempt) {
  const exponentialDelay = Math.round(
    RETRY_BASE_DELAY_MS * Math.pow(RETRY_BACKOFF_FACTOR, Math.max(0, attempt - 1))
  );
  return Math.min(exponentialDelay, RETRY_MAX_DELAY_MS);
}

function scheduleReconnect() {
  if (isShuttingDown) return;

  if (MAX_RETRIES > 0 && retries >= MAX_RETRIES) {
    console.error(
      `Postgres: se alcanzó el máximo de reintentos (${MAX_RETRIES}). No se intentará reconectar automáticamente.`
    );
    return;
  }

  retries += 1;
  const delay = getRetryDelay(retries);
  console.warn(`Postgres: reintento #${retries} en ${delay}ms...`);

  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    connectPostgres().catch(() => {
      // El manejo de errores ya se registra en connectPostgres
    });
  }, delay);
}

async function testConnection(nextPool) {
  const client = await nextPool.connect();
  try {
    await client.query("SELECT 1");
  } finally {
    client.release();
  }
}

export async function connectPostgres() {
  if (isShuttingDown) {
    throw new Error("Postgres: el cliente está en proceso de cierre");
  }

  if (pool) return pool;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    let nextPool;

    try {
      console.log("Conectando a Postgres...");
      nextPool = new Pool(buildPoolConfig());
      registerPoolEvents(nextPool);

      await testConnection(nextPool);

      pool = nextPool;
      retries = 0;

      //green emoji
      console.log("Conexión a Postgres establecida correctamente");
      return pool;
    } catch (err) {
      console.error("Error al conectar con Postgres:", err.message);

      if (nextPool) {
        try {
          await nextPool.end();
        } catch (closeErr) {
          console.error("Error cerrando pool fallido:", closeErr.message);
        }
      }

      scheduleReconnect();
      throw err;
    } finally {
      connectPromise = undefined;
    }
  })();

  return connectPromise;
}

export function getPostgresPool() {
  return pool;
}

export async function query(text, params = []) {
  if (!pool) {
    await connectPostgres();
  }

  if (!pool) {
    throw new Error("Postgres: pool no inicializado");
  }

  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error("Postgres query error:", err.message);
    throw err;
  }
}

export async function closePostgres() {
  isShuttingDown = true;
  clearTimeout(retryTimer);

  if (!pool) return;

  const currentPool = pool;
  pool = undefined;

  try {
    await currentPool.end();
    console.log("Postgres: conexiones cerradas correctamente");
  } catch (err) {
    console.error("Postgres: error cerrando conexiones:", err.message);
    throw err;
  }
}

export async function withTransaction(work) {
  if (typeof work !== "function") {
    throw new Error("Postgres: withTransaction requiere una función de trabajo");
  }

  if (!pool) {
    await connectPostgres();
  }

  if (!pool) {
    throw new Error("Postgres: pool no inicializado");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Postgres: error en rollback:", rollbackErr.message);
    }
    throw err;
  } finally {
    client.release();
  }
}
