import { query } from "../postgresClient.js";

export const EVENT_TIME_ZONE = "America/Mexico_City";
const RETRY_DELAY_MS = 60_000;
const MIN_SCHEDULE_DELAY_MS = 1_000;

export async function finalizePreviousDayEvents({
  queryFn = query,
  timeZone = EVENT_TIME_ZONE,
} = {}) {
  const result = await queryFn(
    `WITH scheduler_lock AS (
       SELECT pg_try_advisory_xact_lock(18463, 90210) AS acquired
     ), finalized AS (
       UPDATE events
       SET status = 'ended'::event_status
       WHERE status = 'published'::event_status
         AND (ends_at AT TIME ZONE $1)::date < (now() AT TIME ZONE $1)::date
         AND (SELECT acquired FROM scheduler_lock)
       RETURNING id
     )
     SELECT
       (SELECT acquired FROM scheduler_lock) AS acquired,
       COUNT(*)::int AS finalized_count
     FROM finalized`,
    [timeZone],
  );

  return {
    acquired: Boolean(result.rows?.[0]?.acquired),
    finalizedCount: Number(result.rows?.[0]?.finalized_count ?? 0),
  };
}

export async function getMillisecondsUntilNextMidnight({
  queryFn = query,
  timeZone = EVENT_TIME_ZONE,
} = {}) {
  const result = await queryFn(
    `SELECT CEIL(
       EXTRACT(EPOCH FROM (
         (((now() AT TIME ZONE $1)::date + 1)::timestamp AT TIME ZONE $1) - now()
       )) * 1000
     )::bigint AS delay_ms`,
    [timeZone],
  );
  const delayMs = Number(result.rows?.[0]?.delay_ms);
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    throw new Error("No se pudo calcular la siguiente medianoche.");
  }
  return Math.max(MIN_SCHEDULE_DELAY_MS, delayMs);
}

export function startEventFinalizationScheduler({
  queryFn = query,
  timeZone = EVENT_TIME_ZONE,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
  retryDelayMs = RETRY_DELAY_MS,
} = {}) {
  let timer = null;
  let stopped = false;

  const schedule = (delayMs) => {
    if (stopped) return;
    timer = setTimeoutFn(run, delayMs);
    timer?.unref?.();
  };

  const run = async () => {
    if (stopped) return;
    try {
      const result = await finalizePreviousDayEvents({ queryFn, timeZone });
      if (result.acquired && result.finalizedCount > 0) {
        logger.info(`Eventos finalizados automáticamente: ${result.finalizedCount}`);
      }
      const delayMs = await getMillisecondsUntilNextMidnight({ queryFn, timeZone });
      schedule(delayMs);
    } catch (error) {
      logger.error("No se pudo ejecutar la finalización automática de eventos:", error.message);
      schedule(retryDelayMs);
    }
  };

  void run();

  return {
    stop() {
      stopped = true;
      if (timer !== null) clearTimeoutFn(timer);
      timer = null;
    },
  };
}