import { createClient } from "redis";

const redisURL = process.env.REDIS_URL || "redis://localhost:6379";

let client;

export const connectRedis = async () => {

  console.log("Connecting to Redis at", redisURL);
  

  client = createClient({ url: redisURL });

  client.on("error", (err) => console.error("Redis error:", err));
  client.on("reconnecting", () => console.warn("Reconnecting to Redis..."));
  client.on("connect", () => console.log("Connected to Redis!"));
  client.on("ready", () =>
    console.log("Redis client ready (modules disponibles)")
  );
  client.on("end", () =>
    console.warn("Redis connection closed. Attempting reconnect in 60s...")
  );

  try {
    await client.connect();
  } catch (err) {
    console.error("Initial Redis connection failed:", err.message);
    setTimeout(connectRedis, 60 * 1000);
  }
};

export const getRedisClient = () => client;

// Helper genérico: asegura que exista un documento JSON raíz como array
export async function ensureJsonArrayKey(key) {
  const c = getRedisClient();
  if (!c) throw new Error("Redis client not initialized yet");

  const exists = await c.exists(key);
  if (exists) {
    console.log(`Key existente en Redis: ${key}`);
    return;
  }
  await c.json.set(key, "$", [], { NX: true }); // crea sólo si no existe
  console.log(`Key creada en Redis: ${key}`);
}
