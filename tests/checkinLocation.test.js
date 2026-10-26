import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCheckinLocation } from "../src/routes/eventsRoutes.js";

const empty = { clientLat: null, clientLng: null, accuracyM: null };

test("devices without location send nothing and the check-in still proceeds", () => {
  assert.deepEqual(normalizeCheckinLocation({}), empty);
  assert.deepEqual(normalizeCheckinLocation(undefined), empty);
  assert.deepEqual(normalizeCheckinLocation({ client_lat: null, client_lng: "", accuracy_m: undefined }), empty);
});

test("decimal accuracy reported by browsers is rounded for the INTEGER column", () => {
  assert.deepEqual(
    normalizeCheckinLocation({ client_lat: 19.4769381234, client_lng: -99.0435912345, accuracy_m: 12.38 }),
    { clientLat: 19.476938, clientLng: -99.043591, accuracyM: 12 },
  );
  assert.equal(normalizeCheckinLocation({ lat: "19.47", lng: "-99.04", accuracy: "35.5" }).accuracyM, 36);
});

test("invalid or out-of-range coordinates are discarded instead of failing", () => {
  assert.deepEqual(normalizeCheckinLocation({ client_lat: 500, client_lng: -99, accuracy_m: 10 }), empty);
  assert.deepEqual(normalizeCheckinLocation({ client_lat: 19, client_lng: 200, accuracy_m: 10 }), empty);
  assert.deepEqual(normalizeCheckinLocation({ client_lat: "abc", client_lng: -99, accuracy_m: 10 }), empty);
  assert.deepEqual(normalizeCheckinLocation({ client_lat: 19, accuracy_m: 10 }), empty);
  assert.deepEqual(normalizeCheckinLocation({ client_lat: true, client_lng: false }), empty);
});

test("absurd accuracy values are dropped but valid coordinates are kept", () => {
  const coords = { client_lat: 19.47, client_lng: -99.04 };
  assert.equal(normalizeCheckinLocation({ ...coords, accuracy_m: -5 }).accuracyM, null);
  assert.equal(normalizeCheckinLocation({ ...coords, accuracy_m: 1e12 }).accuracyM, null);
  assert.equal(normalizeCheckinLocation({ ...coords, accuracy_m: "NaN" }).accuracyM, null);
  assert.equal(normalizeCheckinLocation({ ...coords, accuracy_m: 0 }).accuracyM, 0);
  assert.equal(normalizeCheckinLocation({ ...coords, accuracy_m: 1e12 }).clientLat, 19.47);
});
