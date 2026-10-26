import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPasswordChangeAllowed,
  assertStudentImportAccess,
  assertUserRoleAssignmentAccess,
  canImportStudents,
  getAssignableUserRoles,
  isSuaDivisionCareer,
  isUserProvisioningCareer,
  normalizeStudySystem,
  resolveAdminUserListCareerFilter,
} from "../src/services/adminUserCareerScope.js";
import { buildEventConditions, parseEventStatusesParam } from "../src/routes/eventsRoutes.js";

test("sistema de estudios: esc/sua, vac\u00edo es null e inv\u00e1lido es undefined", () => {
  assert.equal(normalizeStudySystem("ESC"), "esc");
  assert.equal(normalizeStudySystem(" sua "), "sua");
  assert.equal(normalizeStudySystem(""), null);
  assert.equal(normalizeStudySystem(null), null);
  assert.equal(normalizeStudySystem("mixto"), undefined);
});

test("la División SUA solo ve alumnos SUA y las carreras solo a su alumnado escolarizado", () => {
  assert.equal(isSuaDivisionCareer("División de Universidad Abierta, Continua y a Distancia"), true);
  assert.equal(isSuaDivisionCareer("Derecho"), false);

  const division = resolveAdminUserListCareerFilter({ role: "admin", careerId: 23 }, "23", 2, "u.career_id", { includeSuaStudents: true });
  assert.deepEqual(division, {
    clause: "((u.career_id = $2 AND m.study_system IS DISTINCT FROM 'esc') OR m.study_system = 'sua')",
    params: [23],
  });
  const regular = resolveAdminUserListCareerFilter({ role: "admin", careerId: 13 }, undefined, 2);
  assert.deepEqual(regular, { clause: "(u.career_id = $2 AND m.study_system IS DISTINCT FROM 'sua')", params: [13] });
  const global = resolveAdminUserListCareerFilter({ role: "admin", careerId: 1 }, "13", 2, "u.career_id", { includeSuaStudents: true });
  assert.deepEqual(global, { clause: "u.career_id = $2", params: [13] });
});

const superAdmin = { role: "admin", careerId: 1 };
const careerAdmin = { role: "admin", careerId: 14 };
const sportsAdmin = { role: "admin", careerId: 4 };
const forbidden = { statusCode: 403 };

test("Deportivas y Culturales se reconocen sin importar acentos o may\u00fasculas", () => {
  assert.equal(isUserProvisioningCareer("Deportivas"), true);
  assert.equal(isUserProvisioningCareer(" CULTURALES "), true);
  assert.equal(isUserProvisioningCareer("Ingenier\u00eda en Computaci\u00f3n"), false);
  assert.equal(isUserProvisioningCareer(null), false);
});

test("solo el superadmin crea cualquier rol; Deportivas/Culturales alumnos, visitantes y staff; el resto solo staff", () => {
  assert.deepEqual(getAssignableUserRoles(superAdmin, "Carrera Admin").sort(), ["admin", "auditor", "staff", "student", "visitor"]);
  assert.deepEqual(getAssignableUserRoles(sportsAdmin, "Deportivas").sort(), ["staff", "student", "visitor"]);
  assert.deepEqual(getAssignableUserRoles(careerAdmin, "Ingenier\u00eda en Computaci\u00f3n"), ["staff"]);
  assert.deepEqual(getAssignableUserRoles({ role: "staff", careerId: 4 }, "Deportivas"), []);

  assert.doesNotThrow(() => assertUserRoleAssignmentAccess(careerAdmin, "staff", "Derecho"));
  assert.throws(() => assertUserRoleAssignmentAccess(careerAdmin, "student", "Derecho"), {
    ...forbidden,
    message: "Solo puedes crear o asignar usuarios staff.",
  });
  assert.doesNotThrow(() => assertUserRoleAssignmentAccess(sportsAdmin, "visitor", "Deportivas"));
  assert.throws(() => assertUserRoleAssignmentAccess(sportsAdmin, "admin", "Deportivas"), forbidden);
  assert.doesNotThrow(() => assertUserRoleAssignmentAccess(superAdmin, "admin", "Carrera Admin"));
});

test("importar estudiantes: superadmin, Deportivas y Culturales", () => {
  assert.equal(canImportStudents(superAdmin, "Carrera Admin"), true);
  assert.equal(canImportStudents({ role: "admin", careerId: 5 }, "Culturales"), true);
  assert.equal(canImportStudents(careerAdmin, "Sociolog\u00eda"), false);
  assert.throws(() => assertStudentImportAccess(careerAdmin, "Sociolog\u00eda"), forbidden);
});

test("solo se cambian contrase\u00f1as de visitantes y staff", () => {
  assert.doesNotThrow(() => assertPasswordChangeAllowed("visitor"));
  assert.doesNotThrow(() => assertPasswordChangeAllowed("staff"));
  for (const role of ["student", "admin", "auditor", null]) {
    assert.throws(() => assertPasswordChangeAllowed(role), forbidden);
  }
});

test("el filtro de estatus acepta varios valores y rechaza desconocidos", () => {
  assert.deepEqual(parseEventStatusesParam("published,draft"), { statuses: ["published", "draft"] });
  assert.deepEqual(parseEventStatusesParam(["ended", "ended", " cancelled "]), { statuses: ["ended", "cancelled"] });
  assert.deepEqual(parseEventStatusesParam(undefined), { statuses: [] });
  assert.deepEqual(parseEventStatusesParam("published,borrado"), { error: "status inv\u00e1lido." });
});

test("de otras carreras el admin de carrera solo ve eventos publicados vigentes", () => {
  const scoped = buildEventConditions({ statuses: ["published", "draft"], onlyPublishedFromOtherCareersOf: 14 });
  assert.equal(scoped.conditions[0], "e.status::text = ANY($1::text[])");
  assert.match(scoped.conditions[1], /e\.status = 'published'::event_status/u);
  assert.match(scoped.conditions[1], /e\.ends_at >= now\(\)/u);
  assert.match(scoped.conditions[1], /ou\.career_id = \$2/u);
  assert.deepEqual(scoped.params, [["published", "draft"], 14]);

  const global = buildEventConditions({ statuses: [] });
  assert.deepEqual(global, { conditions: [], params: [] });
});
