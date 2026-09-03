import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  EventCareerAccessError,
  assertEventCareerAccess,
  canManageEventCareer,
  normalizeEventCareerId,
} from "../src/services/eventCareerAccess.js";

test("normalizes only positive event career IDs", () => {
  assert.equal(normalizeEventCareerId("2"), 2);
  assert.equal(normalizeEventCareerId(null), null);
  assert.equal(normalizeEventCareerId("2.5"), null);
  assert.equal(normalizeEventCareerId("career-2"), null);
});

test("global admins can manage every event career", () => {
  assert.equal(canManageEventCareer(1, 2), true);
  assert.equal(canManageEventCareer("1", null), true);
});

test("regional admins can manage only events owned by their career", () => {
  assert.equal(canManageEventCareer(7, "7"), true);
  assert.equal(canManageEventCareer(7, 8), false);
  assert.equal(canManageEventCareer(7, null), false);
  assert.throws(
    () => assertEventCareerAccess(7, 8),
    (error) => error instanceof EventCareerAccessError && error.code === "event_career_forbidden",
  );
});

test("admin event routes expose and enforce career management access", async () => {
  const source = await readFile(new URL("../src/routes/eventsRoutes.js", import.meta.url), "utf8");

  assert.match(source, /can_manage:\s*canManageEventCareer\(/u);
  assert.match(source, /owner_user\.career_id AS owner_career_id/u);
  assert.equal((source.match(/assertEventCareerAccess\(/gu) || []).length >= 7, true);
});