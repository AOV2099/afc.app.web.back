import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { capHoursToGoal, loadUserHoursProgress } from "../src/services/afcHoursGoal.js";

test("check-in hours never exceed the career AFC goal", () => {
  assert.equal(capHoursToGoal(30, 100, 480), 30);
  assert.equal(capHoursToGoal(30, 470, 480), 10);
  assert.equal(capHoursToGoal(30, 480, 480), 0);
  assert.equal(capHoursToGoal(30, 500, 480), 0, "saldo previo por encima de la meta");
  assert.equal(capHoursToGoal(0.1 + 0.2, 239.7, 240), 0.3);
  assert.equal(capHoursToGoal(-5, 0, 240), 0);
});

test("goal comes from the user's career with a 480 h fallback", async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("FROM users u")) return { rows: [{ goal: "240.00" }] };
      return { rows: [{ total: "120.50" }] };
    },
  };
  assert.deepEqual(await loadUserHoursProgress(executor, 7, { lock: true }), { goal: 240, total: 120.5 });
  assert.match(calls[0].sql, /COALESCE\(c\.afc_hours, \$2\)/u);
  assert.match(calls[0].sql, /FOR UPDATE OF u/u);
  assert.equal(calls[0].params[1], 480);
});

test("staff check-in credits capped hours and history exposes the goal", async () => {
  const source = await readFile(new URL("../src/routes/eventsRoutes.js", import.meta.url), "utf8");
  assert.match(source, /loadUserHoursProgress\(tx, ticket\.user_id, \{ lock: true \}\)/u);
  assert.match(source, /creditedHours,\s*insertedCheckin\.id/u);
  assert.match(source, /hours_capped: hoursCapped/u);
  assert.doesNotMatch(source, /Se han agregado/u, "las horas parciales no llevan leyenda");
  assert.match(source, /hours_goal: hoursGoal/u);
});
