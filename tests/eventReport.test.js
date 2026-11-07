import assert from "node:assert/strict";
import test from "node:test";

import { mapEventReportRow } from "../src/routes/eventsRoutes.js";

test("report rows keep missing data blank and list check-ins in order", () => {
  assert.deepEqual(
    mapEventReportRow({
      student_id: "320226160",
      email: "ana@aragon.unam.mx",
      career_name: "Ingeniería en Computación",
      checkins: [new Date("2026-11-06T18:05:00.000Z"), "2026-11-07T18:01:00.000Z"],
    }),
    {
      numero_cuenta: "320226160",
      correo: "ana@aragon.unam.mx",
      carrera: "Ingeniería en Computación",
      check_in: true,
      checkins: ["2026-11-06T18:05:00.000Z", "2026-11-07T18:01:00.000Z"],
    },
  );
  assert.deepEqual(mapEventReportRow({ student_id: null, email: "x@afc.local", career_name: null, checkins: null }), {
    numero_cuenta: null,
    correo: "x@afc.local",
    carrera: null,
    check_in: false,
    checkins: [],
  });
});
