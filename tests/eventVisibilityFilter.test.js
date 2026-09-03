import assert from "node:assert/strict";
import test from "node:test";

import { buildEventConditions } from "../src/routes/eventsRoutes.js";

test("public event filters parameterize the expiration cutoff", () => {
  const endsFrom = new Date("2026-09-01T12:00:00.000Z");
  const result = buildEventConditions({
    q: "",
    status: undefined,
    category: undefined,
    startsFrom: null,
    startsTo: null,
    endsFrom,
    forcePublished: true,
  });

  assert.deepEqual(result.params, ["published", endsFrom]);
  assert.deepEqual(result.conditions, [
    "e.status = $1::event_status",
    "e.ends_at >= $2",
  ]);
});