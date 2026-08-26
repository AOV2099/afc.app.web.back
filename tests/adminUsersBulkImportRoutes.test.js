import assert from "node:assert/strict";
import test from "node:test";

import {
  logBulkStudentImportSuccess,
  sendBulkImportError,
} from "../src/routes/adminUsersRoutes.js";
import { BulkStudentImportError } from "../src/services/bulkStudentImportService.js";

function response() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
}

test("returns nonempty row errors for a 409 bulk import conflict", () => {
  const res = response();
  const errors = [{
    row: 7,
    field: "numero_cuenta",
    code: "student_id_in_use",
    message: "El numero_cuenta ya está asociado con otra cuenta.",
  }];

  sendBulkImportError(
    res,
    new BulkStudentImportError(409, "import_conflict", "Conflicto durante la importación.", errors),
    "commit",
  );

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.payload, {
    ok: false,
    code: "import_conflict",
    message: "Conflicto durante la importación.",
    errors,
  });
});

test("omits an empty errors array from bulk import error responses", () => {
  const res = response();

  sendBulkImportError(
    res,
    new BulkStudentImportError(410, "import_expired", "La vista previa expiró.", []),
    "commit",
  );

  assert.deepEqual(res.payload, {
    ok: false,
    code: "import_expired",
    message: "La vista previa expiró.",
  });
});

test("writes one structured success line containing only safe import metadata", () => {
  const lines = [];
  logBulkStudentImportSuccess({
    importerUserId: "42",
    importId: "sensitive-import-token",
    result: { career_id: 8, created: 4, skipped: 2 },
    logger: { info: (line) => lines.push(line) },
  });

  assert.equal(lines.length, 1);
  assert.equal(lines[0].includes("sensitive-import-token"), false);
  const entry = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(entry).sort(), [
    "created",
    "event",
    "import_id_hash",
    "importer_user_id",
    "skipped",
    "target_career_id",
  ]);
  assert.equal(entry.event, "bulk_student_import_committed");
  assert.equal(entry.importer_user_id, "42");
  assert.equal(entry.target_career_id, 8);
  assert.equal(entry.created, 4);
  assert.equal(entry.skipped, 2);
  assert.match(entry.import_id_hash, /^[a-f0-9]{64}$/u);
});
