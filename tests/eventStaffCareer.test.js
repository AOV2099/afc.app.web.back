import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EventStaffCareerError,
  assertEventStaffCareer,
  loadEventManagerCareerId,
  normalizeEventStaffCareerId,
} from "../src/services/eventStaffCareer.js";

function careerError(code) {
  const expectedMessages = {
    career_required: "Se requiere una carrera válida para crear o administrar el staff de eventos.",
    staff_career_mismatch: "El usuario staff seleccionado no pertenece a tu carrera.",
  };
  return (error) =>
    error instanceof EventStaffCareerError &&
    error.statusCode === 403 &&
    error.code === code &&
    error.message === expectedMessages[code];
}

test("normalizes only positive, safe career IDs", () => {
  assert.equal(normalizeEventStaffCareerId(1), 1);
  assert.equal(normalizeEventStaffCareerId(" 24 "), 24);

  for (const invalid of [null, undefined, "", "0", 0, -1, "1.5", "1e2", "career", Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeEventStaffCareerId(invalid), null);
  }
});

test("loads and share-locks the manager career in the current transaction", async () => {
  const statements = [];
  const tx = {
    async query(sql, params) {
      statements.push({ sql, params });
      return { rows: [{ career_id: "7" }] };
    },
  };

  assert.equal(await loadEventManagerCareerId(tx, 41), 7);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /FROM users/u);
  assert.match(statements[0].sql, /FOR SHARE/u);
  assert.deepEqual(statements[0].params, [41]);
});

test("rejects a missing, null, or invalid manager career", async () => {
  const results = [
    { rows: [] },
    { rows: [{ career_id: null }] },
    { rows: [{ career_id: "invalid" }] },
    { rows: [{ career_id: 0 }] },
  ];

  for (const result of results) {
    const tx = { async query() { return result; } };
    await assert.rejects(loadEventManagerCareerId(tx, 41), careerError("career_required"));
  }

  assert.throws(
    () => assertEventStaffCareer(null, 4),
    careerError("career_required"),
  );
});

test("allows regional managers to assign only staff from the same career", () => {
  assert.doesNotThrow(() => assertEventStaffCareer(8, "8"));
  assert.throws(
    () => assertEventStaffCareer(8, 9),
    careerError("staff_career_mismatch"),
  );
  assert.throws(
    () => assertEventStaffCareer(8, null),
    careerError("staff_career_mismatch"),
  );
  assert.throws(
    () => assertEventStaffCareer(8, "invalid"),
    careerError("staff_career_mismatch"),
  );
});

test("career 1 managers may assign staff from any career, including legacy null", () => {
  for (const staffCareerId of [1, 2, "99", null, "invalid"]) {
    assert.doesNotThrow(() => assertEventStaffCareer(1, staffCareerId));
  }
});

test("event creation source assigns careers in both auto-created staff paths", async () => {
  const source = await readFile(
    new URL("../src/routes/eventsRoutes.js", import.meta.url),
    "utf8",
  );
  const helperStart = source.indexOf("async function createEventRecords");
  const bulkStart = source.indexOf('router.post("/api/admin/events/bulk"');
  const singleStart = source.indexOf('router.post("/api/admin/events"');
  const updateStart = source.indexOf('router.put("/api/admin/events/:eventId"');

  assert.ok(helperStart >= 0 && bulkStart > helperStart);
  assert.ok(singleStart > bulkStart && updateStart > singleStart);

  const helperCreateSource = source.slice(helperStart, bulkStart);
  assert.match(
    helperCreateSource,
    /INSERT INTO users \(email, password_hash, first_name, last_name, status, career_id, attributes\)/u,
  );
  assert.match(helperCreateSource, /RETURNING id, email, career_id/u);
  assert.match(helperCreateSource, /assertEventStaffCareer\(managerCareerId, staffUser\.career_id\)/u);

  const singleCreateSource = source.slice(singleStart, updateStart);
  assert.match(singleCreateSource, /status,\s+career_id,\s+attributes/u);
  assert.match(singleCreateSource, /RETURNING id, email, career_id/u);
  assert.match(singleCreateSource, /assertEventStaffCareer\(managerCareerId, staffUser\.career_id\)/u);
});

test("bulk creation resolves the manager career once and passes it to every item", async () => {
  const source = await readFile(
    new URL("../src/routes/eventsRoutes.js", import.meta.url),
    "utf8",
  );
  const bulkStart = source.indexOf('router.post("/api/admin/events/bulk"');
  const singleStart = source.indexOf('router.post("/api/admin/events"');
  const bulkSource = source.slice(bulkStart, singleStart);

  assert.equal(
    (bulkSource.match(/loadEventManagerCareerId\(tx, authUserId\)/gu) || []).length,
    1,
  );
  assert.match(
    bulkSource,
    /createEventRecords\([\s\S]*?authUserId,\s+managerCareerId,\s+\)/u,
  );
});
