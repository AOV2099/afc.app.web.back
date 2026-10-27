import assert from "node:assert/strict";
import test from "node:test";

import { normalizeCareerInput } from "../src/routes/careersRoutes.js";

test("accepts a zero AFC hours goal for careers that do not count AFC hours", () => {
  assert.equal(normalizeCareerInput({ name: "Carrera sin AFC", afc_hours: "0" }).value.afc_hours, 0);
  assert.equal(normalizeCareerInput({ name: "Ingeniería", afc_hours: "480" }).value.afc_hours, 480);
  assert.match(normalizeCareerInput({ name: "Ingeniería", afc_hours: "-1" }).error, /mayor o igual a 0/u);
  assert.match(normalizeCareerInput({ name: "Ingeniería", afc_hours: "" }).error, /mayor o igual a 0/u);
});
