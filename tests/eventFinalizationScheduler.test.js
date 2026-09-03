import assert from "node:assert/strict";
import test from "node:test";

import {
  EVENT_TIME_ZONE,
  finalizePreviousDayEvents,
  getMillisecondsUntilNextMidnight,
  startEventFinalizationScheduler,
} from "../src/services/eventFinalizationScheduler.js";

test("finalizes only published events from a previous local calendar day", async () => {
  const calls = [];
  const result = await finalizePreviousDayEvents({
    async queryFn(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ acquired: true, finalized_count: 3 }] };
    },
  });

  assert.deepEqual(result, { acquired: true, finalizedCount: 3 });
  assert.deepEqual(calls[0].params, [EVENT_TIME_ZONE]);
  assert.match(calls[0].sql, /status = 'published'::event_status/u);
  assert.match(calls[0].sql, /\(ends_at AT TIME ZONE \$1\)::date < \(now\(\) AT TIME ZONE \$1\)::date/u);
  assert.match(calls[0].sql, /pg_try_advisory_xact_lock/u);
});

test("uses PostgreSQL time to schedule the next local midnight", async () => {
  const delay = await getMillisecondsUntilNextMidnight({
    async queryFn(sql, params) {
      assert.match(sql, /AT TIME ZONE \$1/u);
      assert.deepEqual(params, [EVENT_TIME_ZONE]);
      return { rows: [{ delay_ms: "12345" }] };
    },
  });
  assert.equal(delay, 12345);
});

test("scheduler runs immediately, schedules midnight, and can stop", async () => {
  const delays = [];
  const cleared = [];
  let queryCount = 0;
  const timer = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const scheduler = startEventFinalizationScheduler({
    async queryFn(sql) {
      queryCount += 1;
      return sql.includes("UPDATE events")
        ? { rows: [{ acquired: true, finalized_count: 0 }] }
        : { rows: [{ delay_ms: "5000" }] };
    },
    setTimeoutFn(_callback, delay) {
      delays.push(delay);
      return timer;
    },
    clearTimeoutFn(value) { cleared.push(value); },
    logger: { info() {}, error() {} },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queryCount, 2);
  assert.deepEqual(delays, [5000]);
  assert.equal(timer.unrefCalled, true);
  scheduler.stop();
  assert.deepEqual(cleared, [timer]);
});

test("scheduler retries after a database failure", async () => {
  const delays = [];
  startEventFinalizationScheduler({
    async queryFn() { throw new Error("database unavailable"); },
    setTimeoutFn(_callback, delay) { delays.push(delay); return { unref() {} }; },
    logger: { info() {}, error() {} },
    retryDelayMs: 2500,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delays, [2500]);
});