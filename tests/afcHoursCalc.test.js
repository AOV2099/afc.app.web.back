import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AFC_METHOD,
  afcSelectionFingerprint,
  calculateAfcHours,
  calculateCourseDurationHours,
  calculatePercentRangeHours,
  checkScenarioFitsType,
  normalizeAfcScenarioInput,
  normalizeAfcTypeInput,
  roundUpToHalfHour,
} from "../src/catalogs/afcHoursCalc.js";

const conferences = {
  id: "1", origin: "fes_aragon", key: "conferences", name: "Conferencias",
  min_hours: "10.00", max_hours: "50.00", valuation_mode: "scenarios", is_active: true,
};
const courses = {
  id: "4", origin: "fes_aragon", key: "courses", name: "Talleres y cursos",
  min_hours: null, max_hours: "150.00", valuation_mode: "scenarios", is_active: true,
};
const cultural = {
  id: "9", origin: "fes_aragon", key: "cultural", name: "Actividades culturales",
  min_hours: "20.00", max_hours: "100.00", valuation_mode: "manual", is_active: true,
};
const committee = {
  id: "16", origin: "fes_aragon", key: "committee", name: "Comité",
  min_hours: null, max_hours: null, valuation_mode: "committee", is_active: true,
};
const percent = (key, value) => ({ id: "100", key, label: key, kind: "percent", percent: value, fixed_hours: null });
const fixed = (key, value) => ({ id: "200", key, label: key, kind: "fixed_hours", percent: null, fixed_hours: value });
const courseDuration = { id: "300", key: "course_defined_duration", label: "Curso", kind: "course_duration", percent: null, fixed_hours: null };

test("rounds up to the next half hour exactly", () => {
  assert.equal(roundUpToHalfHour("8.75"), 9);
  assert.equal(roundUpToHalfHour("8.000001"), 8.5);
  assert.equal(roundUpToHalfHour("8"), 8);
  assert.equal(roundUpToHalfHour("-1"), null);
  assert.equal(roundUpToHalfHour("1e3"), null);
});

test("percent applies to the interval between minimum and maximum", () => {
  assert.deepEqual(calculatePercentRangeHours("10", "50", "50"), { hours_before_rounding: "30", final_hours: 30 });
  assert.equal(calculatePercentRangeHours("5.00", "20.00", "25.0000").final_hours, 9);
  assert.equal(calculatePercentRangeHours("30", "80", "37.5").final_hours, 49);
  assert.equal(calculatePercentRangeHours("40", "150", "27").final_hours, 70);
});

test("scenario valuations use catalog rows, not client values", () => {
  const result = calculateAfcHours({ type: conferences, scenario: percent("conf_internal_attendance", "20.0000") });
  assert.equal(result.ok, true);
  assert.equal(result.valuation.final_hours, 18);
  assert.equal(result.valuation.method, AFC_METHOD.PERCENT_RANGE);
  assert.equal(result.valuation.percent, "20");
  assert.equal(result.valuation.min_hours, "10");

  const fixedResult = calculateAfcHours({ type: courses, scenario: fixed("course_ref_basic", "20.00") });
  assert.equal(fixedResult.valuation.final_hours, 20);

  assert.equal(calculateAfcHours({ type: conferences, scenario: null }).code, "invalid_scenario");
  assert.equal(calculateAfcHours({ type: conferences, scenario: fixed("x", "60") }).code, "invalid_rule_config");
  assert.equal(calculateAfcHours({ type: courses, scenario: percent("x", "50") }).code, "invalid_rule_config");
});

test("course duration doubles hours with daily and total caps", () => {
  const twoDays = calculateAfcHours({
    type: courses,
    scenario: courseDuration,
    inputs: { course_days: [{ date: "2026-11-01", effective_hours: "4" }, { date: "2026-11-02", effective_hours: "12" }] },
  });
  assert.equal(twoDays.valuation.final_hours, 28);
  assert.equal(twoDays.valuation.input_value, "16");

  const capped = calculateCourseDurationHours(
    Array.from({ length: 10 }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, "0")}`, effective_hours: "10" })),
  );
  assert.equal(capped.final_hours, 150);

  const incomplete = calculateAfcHours({ type: courses, scenario: courseDuration, inputs: { course_days: [] } });
  assert.equal(incomplete.valuation.complete, false);
  assert.equal(incomplete.valuation.final_hours, null);

  const duplicated = calculateCourseDurationHours([
    { date: "2026-11-01", effective_hours: "2" },
    { date: "2026-11-01", effective_hours: "2" },
  ]);
  assert.equal(duplicated.code, "duplicate_day");
});

test("manual activities accept free hours within their range", () => {
  const ok = calculateAfcHours({ type: cultural, inputs: { manual_hours: "35.2" } });
  assert.equal(ok.valuation.final_hours, 35.5);
  assert.equal(ok.valuation.method, AFC_METHOD.MANUAL);
  assert.equal(ok.valuation.evidence_required, false);

  assert.equal(calculateAfcHours({ type: cultural, inputs: { manual_hours: "10" } }).code, "out_of_range");
  assert.equal(calculateAfcHours({ type: cultural, inputs: { manual_hours: "abc" } }).code, "invalid_manual_hours");
  assert.equal(calculateAfcHours({ type: cultural, inputs: {} }).valuation.complete, false);
  assert.equal(calculateAfcHours({ type: cultural, scenario: fixed("x", "20") }).code, "scenario_not_applicable");
});

test("committee activities accept free hours up to 200 and require evidence", () => {
  const result = calculateAfcHours({ type: committee, inputs: { manual_hours: "120" } });
  assert.equal(result.valuation.final_hours, 120);
  assert.equal(result.valuation.evidence_required, true);
  assert.equal(result.valuation.method, AFC_METHOD.COMMITTEE);
  assert.equal(calculateAfcHours({ type: committee, inputs: { manual_hours: "201" } }).code, "out_of_range");
});

test("fingerprints ignore results and normalize inputs", () => {
  const a = calculateAfcHours({ type: cultural, inputs: { manual_hours: "35.20" } }).valuation;
  const b = calculateAfcHours({ type: cultural, inputs: { manual_hours: "35.2" } }).valuation;
  assert.equal(afcSelectionFingerprint(a), afcSelectionFingerprint({ ...b, final_hours: 999 }));
  const c = calculateAfcHours({ type: cultural, inputs: { manual_hours: "36" } }).valuation;
  assert.notEqual(afcSelectionFingerprint(a), afcSelectionFingerprint(c));
});

test("catalog admin inputs are validated", () => {
  assert.ok(normalizeAfcTypeInput({ origin: "fes_aragon", key: "Bad Key", name: "x", valuation_mode: "manual" }).error);
  assert.ok(normalizeAfcTypeInput({ origin: "fes_aragon", key: "ok", name: "x", valuation_mode: "manual", min_hours: "30", max_hours: "20" }).error);
  assert.ok(normalizeAfcTypeInput({ origin: "fes_aragon", key: "ok", name: "x", valuation_mode: "scenarios", max_hours: "250" }).error);
  const committeeType = normalizeAfcTypeInput({ origin: "fes_aragon", key: "c", name: "C", valuation_mode: "committee", max_hours: "50" });
  assert.equal(committeeType.value.multi_session, false);
  assert.equal(
    normalizeAfcTypeInput({ origin: "fes_aragon", key: "s", name: "S", valuation_mode: "committee", multi_session: true }).value
      .multi_session,
    true,
  );
  assert.equal(committeeType.value.max_hours, null);

  assert.ok(normalizeAfcScenarioInput({ key: "s", label: "S", kind: "percent", percent: "101" }).error);
  assert.equal(normalizeAfcScenarioInput({ key: "s", label: "S", kind: "percent", percent: "37.5" }).value.percent, "37.5");
  assert.equal(normalizeAfcScenarioInput({ key: "s", label: "S", kind: "course_duration", percent: "3" }).value.percent, null);

  assert.equal(checkScenarioFitsType(conferences, percent("p", "50")), null);
  assert.match(checkScenarioFitsType(conferences, fixed("f", "60")), /rango/u);
  assert.match(checkScenarioFitsType(cultural, percent("p", "50")), /Solo las actividades/u);
});

test("frontend copy of the calculator is identical", async () => {
  const backSource = await readFile(new URL("../src/catalogs/afcHoursCalc.js", import.meta.url), "utf8");
  const frontSource = await readFile(
    new URL("../../AFC-Front/src/lib/catalogs/afcHoursCalc.js", import.meta.url),
    "utf8",
  );
  assert.equal(frontSource, backSource, "AFC-Front/src/lib/catalogs/afcHoursCalc.js debe ser idéntico");
});
