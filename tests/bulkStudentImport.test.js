import assert from "node:assert/strict";
import test from "node:test";

import {
  BulkStudentImportError,
  classifyProvisioningRows,
  commitBulkStudentImport,
  parseAndValidateStudentCsv,
  previewBulkStudentImport,
  resolveImportCareer,
} from "../src/services/bulkStudentImportService.js";

const VALID_CSV = [
  "nombres,apellidos,correo,numero_cuenta",
  '"Ana   María","Pérez, López",ALUMNA@EXAMPLE.COM,123456789',
  "Luis,Ruiz,luis@example.com,987654321",
].join("\r\n");

class FakeRedis {
  constructor() {
    this.values = new Map();
    this.setCalls = [];
  }

  async set(key, value, options) {
    this.values.set(key, value);
    this.setCalls.push({ key, value, options });
  }

  async getDel(key) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

function previewDependencies(redis, existingUsers = []) {
  const statements = [];
  return {
    statements,
    dependencies: {
      getRedisClientFn: () => redis,
      randomBytesFn: () => Buffer.alloc(32, 1),
      async queryFn(sql) {
        statements.push(sql);
        if (sql.includes("FROM careers")) return { rows: [{ id: 2 }] };
        if (sql.includes("FROM users")) return { rows: existingUsers };
        throw new Error("Consulta inesperada en preview");
      },
    },
  };
}

function transactionWith(tx) {
  return async (work) => work(tx);
}

test("parses BOM and RFC 4180 quoted commas while normalizing fields", () => {
  const result = parseAndValidateStudentCsv(`\uFEFF${VALID_CSV}`);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0], {
    row: 2,
    firstName: "Ana María",
    lastName: "Pérez, López",
    email: "alumna@example.com",
    studentId: "123456789",
  });
});

test("rejects exact headers without data rows after skipping empty lines", () => {
  const result = parseAndValidateStudentCsv(
    "\uFEFFnombres,apellidos,correo,numero_cuenta\r\n\r\n\r\n",
  );

  assert.deepEqual(result, {
    rows: [],
    errors: [{
      row: 2,
      field: "archivo",
      code: "csv_no_data_rows",
      message: "El archivo CSV debe contener al menos una fila de estudiante.",
    }],
  });
});

test("rejects wrong headers, formulas, controls, invalid accounts, and CSV duplicates", () => {
  const wrongHeaders = parseAndValidateStudentCsv(
    "nombres,apellidos,correo,extra\nAna,Ruiz,a@example.com,123456789",
  );
  assert.ok(wrongHeaders.errors.some((error) => error.code === "missing_header"));
  assert.ok(wrongHeaders.errors.some((error) => error.code === "unexpected_header"));

  const invalid = parseAndValidateStudentCsv([
    "nombres,apellidos,correo,numero_cuenta",
    "=CMD(),Ruiz,INVALID,123",
    '"Ana\tMaría",Ruiz,duplicado@example.com,123456789',
    "Otra,Persona,DUPLICADO@example.com,123456789",
  ].join("\n"));
  const codes = new Set(invalid.errors.map((error) => error.code));
  assert.ok(codes.has("formula_not_allowed"));
  assert.ok(codes.has("control_character"));
  assert.ok(codes.has("invalid_email"));
  assert.ok(codes.has("invalid_student_id"));
  assert.ok(codes.has("duplicate_email"));
  assert.ok(codes.has("duplicate_student_id"));
});

test("resolves global and career-admin scope and rejects staff, null, career 1, and mismatch", () => {
  assert.equal(resolveImportCareer({ role: "admin", careerId: 1, requestedCareerId: 8 }), 8);
  assert.equal(resolveImportCareer({ role: "admin", careerId: 4, requestedCareerId: null }), 4);
  assert.throws(
    () => resolveImportCareer({ role: "staff", careerId: 4, requestedCareerId: 4 }),
    (error) => error instanceof BulkStudentImportError && error.code === "admin_required",
  );
  assert.throws(
    () => resolveImportCareer({ role: "admin", careerId: null, requestedCareerId: 4 }),
    (error) => error.code === "admin_career_required",
  );
  assert.throws(
    () => resolveImportCareer({ role: "admin", careerId: 1, requestedCareerId: 1 }),
    (error) => error.code === "target_career_required",
  );
  assert.throws(
    () => resolveImportCareer({ role: "admin", careerId: 4, requestedCareerId: 5 }),
    (error) => error.code === "career_scope_mismatch",
  );
});

test("classifies only the exact active student account as a skip", () => {
  const row = {
    row: 2,
    firstName: "Ana",
    lastName: "Ruiz",
    email: "ana@example.com",
    studentId: "123456789",
  };
  const exact = {
    id: "10",
    email: "ANA@example.com",
    student_id: "123456789",
    career_id: "2",
    status: "active",
    role: "student",
  };

  assert.deepEqual(classifyProvisioningRows([row], [exact], 2), {
    toCreate: [],
    toSkip: 1,
    errors: [],
  });

  for (const changed of [
    { career_id: "3" },
    { role: "staff" },
    { status: "disabled" },
    { student_id: "111111111" },
  ]) {
    const result = classifyProvisioningRows([row], [{ ...exact, ...changed }], 2);
    assert.equal(result.toSkip, 0);
    assert.ok(result.errors.length > 0);
  }
});

test("preview performs reads only and stores every normalized parsed row under a hashed key", async () => {
  const redis = new FakeRedis();
  const exactDuplicate = {
    id: "80",
    email: "alumna@example.com",
    student_id: "123456789",
    career_id: "2",
    status: "active",
    role: "student",
  };
  const { dependencies, statements } = previewDependencies(redis, [exactDuplicate]);
  const result = await previewBulkStudentImport({
    csvText: VALID_CSV,
    importer: { userId: "7", role: "admin", careerId: 2 },
    requestedCareerId: undefined,
    dependencies,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { rows: 2, to_create: 1, to_skip: 1, career_id: 2 });
  assert.equal(redis.setCalls.length, 1);
  assert.equal(redis.setCalls[0].options.EX, 600);
  assert.equal(redis.setCalls[0].key.includes(result.import_id), false);
  const stored = JSON.parse(redis.setCalls[0].value);
  assert.equal(stored.version, 2);
  assert.equal(stored.rows.length, 2);
  assert.equal(stored.rows[0].email, "alumna@example.com");
  assert.equal(stored.rows[1].email, "luis@example.com");
  assert.ok(statements.every((sql) => /^\s*SELECT/iu.test(sql)));
});

test("preview rejects DB conflicts without issuing a token", async () => {
  const redis = new FakeRedis();
  const existing = [{
    id: "20",
    email: "alumna@example.com",
    student_id: "123456789",
    career_id: "3",
    status: "active",
    role: "student",
  }];
  const { dependencies } = previewDependencies(redis, existing);

  await assert.rejects(
    previewBulkStudentImport({
      csvText: VALID_CSV,
      importer: { userId: "7", role: "admin", careerId: 2 },
      dependencies,
    }),
    (error) => error.status === 422 && error.code === "database_conflict" && error.errors.length > 0,
  );
  assert.equal(redis.setCalls.length, 0);
});

test("commit skips a new exact duplicate and creates remaining students with one batch hash", async () => {
  const redis = new FakeRedis();
  const { dependencies: previewDeps } = previewDependencies(redis);
  const preview = await previewBulkStudentImport({
    csvText: VALID_CSV,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: previewDeps,
  });
  let hashCalls = 0;
  let insertedParams = null;
  let membershipParams = null;
  const tx = {
    async query(sql, params) {
      if (sql.includes("SELECT u.id, u.career_id, u.status")) {
        return { rows: [{ id: "7", career_id: "2", status: "active", role: "admin" }] };
      }
      if (sql.includes("SELECT id FROM careers")) return { rows: [{ id: 2 }] };
      if (sql.includes("FROM users u") && sql.includes("u.student_id = ANY")) {
        return {
          rows: [{
            id: "80",
            email: "alumna@example.com",
            student_id: "123456789",
            career_id: "2",
            status: "active",
            role: "student",
          }],
        };
      }
      if (sql.includes("INSERT INTO users")) {
        insertedParams = params;
        return { rows: [{ id: "102" }] };
      }
      if (sql.includes("INSERT INTO memberships")) {
        membershipParams = params;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  const result = await commitBulkStudentImport({
    importId: preview.import_id,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: {
      getRedisClientFn: () => redis,
      randomBytesFn: () => Buffer.alloc(32, 3),
      async hashPasswordFn() {
        hashCalls += 1;
        return "one-unknown-batch-hash";
      },
      withTransactionFn: transactionWith(tx),
    },
  });

  assert.deepEqual(result, { ok: true, created: 1, skipped: 1, career_id: 2 });
  assert.equal(hashCalls, 1);
  assert.equal(insertedParams[0], "luis@example.com");
  assert.equal(insertedParams[1], "one-unknown-batch-hash");
  assert.equal(membershipParams[2], "student");
  const attributes = JSON.parse(insertedParams[6]);
  assert.equal(attributes.provisioned_via, "csv_bulk");
  assert.equal(attributes.imported_by_user_id, "7");
  assert.equal(attributes.import_id, preview.import_id);
  assert.ok(Number.isFinite(Date.parse(attributes.imported_at)));
});

test("commit counts unchanged preview duplicates once and does not hash without inserts", async () => {
  const redis = new FakeRedis();
  const exactDuplicates = [
    {
      id: "80",
      email: "alumna@example.com",
      student_id: "123456789",
      career_id: "2",
      status: "active",
      role: "student",
    },
    {
      id: "81",
      email: "luis@example.com",
      student_id: "987654321",
      career_id: "2",
      status: "active",
      role: "student",
    },
  ];
  const { dependencies: previewDeps } = previewDependencies(redis, exactDuplicates);
  const preview = await previewBulkStudentImport({
    csvText: VALID_CSV,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: previewDeps,
  });

  let hashCalls = 0;
  let insertCount = 0;
  const tx = {
    async query(sql) {
      if (sql.includes("SELECT u.id, u.career_id, u.status")) {
        return { rows: [{ id: "7", career_id: "2", status: "active", role: "admin" }] };
      }
      if (sql.includes("SELECT id FROM careers")) return { rows: [{ id: 2 }] };
      if (sql.includes("FROM users u") && sql.includes("u.student_id = ANY")) {
        return { rows: exactDuplicates };
      }
      if (sql.includes("INSERT INTO users")) {
        insertCount += 1;
        return { rows: [{ id: "102" }] };
      }
      if (sql.includes("INSERT INTO memberships")) return { rows: [], rowCount: 1 };
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  const result = await commitBulkStudentImport({
    importId: preview.import_id,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: {
      getRedisClientFn: () => redis,
      randomBytesFn: () => Buffer.alloc(32, 3),
      async hashPasswordFn() {
        hashCalls += 1;
        return "one-unknown-batch-hash";
      },
      withTransactionFn: transactionWith(tx),
    },
  });

  assert.deepEqual(result, { ok: true, created: 0, skipped: 2, career_id: 2 });
  assert.equal(insertCount, 0);
  assert.equal(hashCalls, 0);
});

test("commit rolls back when a preview-skipped exact duplicate changes to a conflict", async () => {
  const redis = new FakeRedis();
  const previewDuplicate = {
    id: "80",
    email: "alumna@example.com",
    student_id: "123456789",
    career_id: "2",
    status: "active",
    role: "student",
  };
  const { dependencies: previewDeps } = previewDependencies(redis, [previewDuplicate]);
  const preview = await previewBulkStudentImport({
    csvText: VALID_CSV,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: previewDeps,
  });

  let hashCalls = 0;
  let insertCount = 0;
  let rolledBack = false;
  const tx = {
    async query(sql) {
      if (sql.includes("SELECT u.id, u.career_id, u.status")) {
        return { rows: [{ id: "7", career_id: "2", status: "active", role: "admin" }] };
      }
      if (sql.includes("SELECT id FROM careers")) return { rows: [{ id: 2 }] };
      if (sql.includes("FROM users u") && sql.includes("u.student_id = ANY")) {
        return { rows: [{ ...previewDuplicate, career_id: "3" }] };
      }
      if (sql.includes("INSERT INTO users")) {
        insertCount += 1;
        return { rows: [{ id: "102" }] };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  await assert.rejects(
    commitBulkStudentImport({
      importId: preview.import_id,
      importer: { userId: "7", role: "admin", careerId: 2 },
      dependencies: {
        getRedisClientFn: () => redis,
        async hashPasswordFn() {
          hashCalls += 1;
          return "unused-hash";
        },
        async withTransactionFn(work) {
          try {
            return await work(tx);
          } catch (error) {
            rolledBack = true;
            throw error;
          }
        },
      },
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "import_conflict");
      assert.deepEqual(error.errors, [{
        row: 2,
        field: "correo",
        code: "existing_account_conflict",
        message: "La cuenta existente no coincide con un estudiante activo de la carrera destino.",
      }]);
      return true;
    },
  );

  assert.equal(rolledBack, true);
  assert.equal(insertCount, 0);
  assert.equal(hashCalls, 0);
});

test("commit rolls back staged inserts when a concurrent conflict appears", async () => {
  const redis = new FakeRedis();
  const { dependencies: previewDeps } = previewDependencies(redis);
  const preview = await previewBulkStudentImport({
    csvText: VALID_CSV,
    importer: { userId: "7", role: "admin", careerId: 2 },
    dependencies: previewDeps,
  });

  let existingLookupCount = 0;
  let userInsertCount = 0;
  let stagedWrites = 0;
  let committedWrites = 0;
  let rolledBack = false;
  const tx = {
    async query(sql, params) {
      if (sql.includes("SELECT u.id, u.career_id, u.status")) {
        return { rows: [{ id: "7", career_id: "2", status: "active", role: "admin" }] };
      }
      if (sql.includes("SELECT id FROM careers")) return { rows: [{ id: 2 }] };
      if (sql.includes("FROM users u") && sql.includes("u.student_id = ANY")) {
        existingLookupCount += 1;
        if (existingLookupCount === 1) return { rows: [] };
        return {
          rows: [{
            id: "88",
            email: params[1][0],
            student_id: params[2][0],
            career_id: "3",
            status: "active",
            role: "student",
          }],
        };
      }
      if (sql.includes("INSERT INTO users")) {
        userInsertCount += 1;
        stagedWrites += 1;
        return userInsertCount === 1 ? { rows: [{ id: "101" }] } : { rows: [] };
      }
      if (sql.includes("INSERT INTO memberships")) {
        stagedWrites += 1;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Consulta inesperada: ${sql}`);
    },
  };

  await assert.rejects(
    commitBulkStudentImport({
      importId: preview.import_id,
      importer: { userId: "7", role: "admin", careerId: 2 },
      dependencies: {
        getRedisClientFn: () => redis,
        randomBytesFn: () => Buffer.alloc(32, 2),
        hashPasswordFn: async () => "unknown-bcrypt-hash",
        async withTransactionFn(work) {
          try {
            const result = await work(tx);
            committedWrites = stagedWrites;
            return result;
          } catch (error) {
            rolledBack = true;
            stagedWrites = 0;
            throw error;
          }
        },
      },
    }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, "import_conflict");
      assert.deepEqual(error.errors, [{
        row: 3,
        field: "correo",
        code: "existing_account_conflict",
        message: "La cuenta existente no coincide con un estudiante activo de la carrera destino.",
      }]);
      return true;
    },
  );

  assert.equal(userInsertCount, 2);
  assert.equal(rolledBack, true);
  assert.equal(stagedWrites, 0);
  assert.equal(committedWrites, 0);
  await assert.rejects(
    commitBulkStudentImport({
      importId: preview.import_id,
      importer: { userId: "7", role: "admin", careerId: 2 },
      dependencies: { getRedisClientFn: () => redis },
    }),
    (error) => error.status === 410 && error.code === "import_expired",
  );
});
