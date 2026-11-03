import assert from "node:assert/strict";
import test from "node:test";

import { registrationClosedReason } from "../src/routes/eventsRoutes.js";

const event = (registration_mode) => ({
  registration_mode,
  starts_at: "2026-09-01T17:00:00.000Z",
  ends_at: "2026-09-01T19:00:00.000Z",
});
const BEFORE = new Date("2026-09-01T16:59:59.000Z");
const IN_PROGRESS = new Date("2026-09-01T18:00:00.000Z");
const ENDED = new Date("2026-09-01T19:00:00.000Z");

test("automatic registration stays open after the event starts, until it ends", () => {
  assert.equal(registrationClosedReason(event("auto"), BEFORE), null);
  assert.equal(registrationClosedReason(event("auto"), IN_PROGRESS), null);
  assert.equal(registrationClosedReason(event("auto"), ENDED), "El evento ya no acepta registros.");
});

test("manual review registration closes when the event starts", () => {
  assert.equal(registrationClosedReason(event("manual_review"), BEFORE), null);
  assert.match(registrationClosedReason(event("manual_review"), IN_PROGRESS), /cerraron al iniciar/);
  assert.equal(registrationClosedReason(event("manual_review"), ENDED), "El evento ya no acepta registros.");
});

test("an event without a valid end date does not accept registrations", () => {
  assert.equal(registrationClosedReason({ ...event("auto"), ends_at: null }, BEFORE), "El evento ya no acepta registros.");
});
