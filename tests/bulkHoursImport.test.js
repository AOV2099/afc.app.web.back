import assert from "node:assert/strict";
import test from "node:test";

import {
  BulkHoursImportError,
  commitBulkHoursImport,
  parseAndValidateHoursCsv,
  previewBulkHoursImport,
} from "../src/services/bulkHoursImportService.js";

const CSV = [
  "numero_cuenta,horas,motivo",
  "123456789,2.50,Participación cultural validada",
  "12345678,1,Apoyo en actividad deportiva",
].join("\r\n");

class FakeRedis {
  constructor() { this.values = new Map(); }
  async set(key, value) { this.values.set(key, value); }
  async getDel(key) {
    const value = this.values.get(key) ?? null;
    this.values.delete(key);
    return value;
  }
}

test("parses exact hours headers and normalized rows", () => {
  const result = parseAndValidateHoursCsv(`\uFEFF${CSV}`);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.rows[0], {
    row: 2,
    accountNumber: "123456789",
    hours: 2.5,
    motive: "Participación cultural validada",
  });
});

test("rejects invalid headers, unsafe values, hours, and duplicate accounts", () => {
  assert.equal(
    parseAndValidateHoursCsv("cuenta,horas,motivo\n123456789,1,Motivo válido").errors[0].code,
    "invalid_headers",
  );
  const invalid = parseAndValidateHoursCsv([
    "numero_cuenta,horas,motivo",
    "=123,-1,no",
    "123456789,1,Primer motivo válido",
    "123456789,2,Segundo motivo válido",
  ].join("\n"));
  const codes = new Set(invalid.errors.map((error) => error.code));
  assert.equal(codes.has("formula_not_allowed"), true);
  assert.equal(codes.has("invalid_account_number"), true);
  assert.equal(codes.has("invalid_hours"), true);
  assert.equal(codes.has("invalid_motive"), true);
  assert.equal(codes.has("duplicate_adjustment"), true);
});

test("preview validates database targets and stores an opaque one-use token", async () => {
  const redis = new FakeRedis();
  const statements = [];
  const result = await previewBulkHoursImport({
    csvText: CSV,
    category: "culturales",
    importer: { userId: "7", role: "admin", careerId: 3 },
    dependencies: {
      getRedisClientFn: () => redis,
      randomBytesFn: () => Buffer.alloc(32, 1),
      randomUuidFn: () => "123e4567-e89b-42d3-a456-426614174000",
      async queryFn(sql) {
        statements.push(sql);
        if (sql.includes("FROM users")) {
          return { rows: [
            { id: "21", student_id: "123456789", career_id: 3, status: "active" },
            { id: "22", student_id: "12345678", career_id: 3, status: "active" },
          ] };
        }
        if (sql.includes("event_categories")) {
          return { rows: [{ key: "culturales" }] };
        }
        throw new Error("Consulta inesperada");
      },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.summary, { rows: 2, users: 2, total_hours: 3.5 });
  assert.equal(statements.every((sql) => /^\s*SELECT/iu.test(sql)), true);
  const storedKey = [...redis.values.keys()][0];
  assert.equal(storedKey.includes(result.import_id), false);
  assert.equal(JSON.parse(redis.values.get(storedKey)).category, "culturales");
});

test("preview requires one selected catalog category", async () => {
  await assert.rejects(
    previewBulkHoursImport({
      csvText: CSV,
      category: "",
      importer: { userId: "7", role: "admin", careerId: 3 },
    }),
    (error) => error instanceof BulkHoursImportError && error.code === "invalid_category",
  );
});

test("preview rejects missing, inactive, cross-career, and unknown-category rows", async () => {
  const redis = new FakeRedis();
  await assert.rejects(
    previewBulkHoursImport({
      csvText: CSV,
      category: "culturales",
      importer: { userId: "7", role: "admin", careerId: 3 },
      dependencies: {
        getRedisClientFn: () => redis,
        async queryFn(sql) {
          if (sql.includes("FROM users")) {
            return { rows: [{ id: "21", student_id: "123456789", career_id: 4, status: "active" }] };
          }
          if (sql.includes("event_categories")) return { rows: [{ key: "culturales" }] };
          throw new Error("Consulta inesperada");
        },
      },
    }),
    (error) =>
      error instanceof BulkHoursImportError &&
      error.code === "database_validation_failed" &&
      error.errors.length === 2,
  );
  assert.equal(redis.values.size, 0);
});

test("commit consumes the token and inserts all adjustments atomically", async () => {
  const redis = new FakeRedis();
  const preview = await previewBulkHoursImport({
    csvText: CSV,
    category: "culturales",
    importer: { userId: "7", role: "admin", careerId: 3 },
    dependencies: {
      getRedisClientFn: () => redis,
      randomBytesFn: () => Buffer.alloc(32, 2),
      randomUuidFn: () => crypto.randomUUID(),
      async queryFn(sql) {
        if (sql.includes("FROM users")) return { rows: [
          { id: "21", student_id: "123456789", career_id: 3, status: "active" },
          { id: "22", student_id: "12345678", career_id: 3, status: "active" },
        ] };
        if (sql.includes("event_categories")) return { rows: [{ key: "culturales" }] };
        throw new Error("Consulta inesperada");
      },
    },
  });
  const inserts = [];
  const tx = {
    async query(sql, params) {
      if (sql.includes("WHERE u.id")) return { rows: [{ id: "7", career_id: 3, status: "active", role: "admin" }] };
      if (sql.includes("FROM users u") && sql.includes("student_id")) return { rows: [
        { id: "21", student_id: "123456789", career_id: 3, status: "active" },
        { id: "22", student_id: "12345678", career_id: 3, status: "active" },
      ] };
      if (sql.includes("event_categories")) return { rows: [{ key: "culturales" }] };
      if (sql.includes("INSERT INTO hours_ledger")) {
        inserts.push(params);
        return { rows: [{ id: String(inserts.length) }] };
      }
      throw new Error("Consulta inesperada");
    },
  };
  const result = await commitBulkHoursImport({
    importId: preview.import_id,
    importer: { userId: "7", role: "admin", careerId: 3 },
    dependencies: { getRedisClientFn: () => redis, withTransactionFn: async (work) => work(tx) },
  });
  assert.deepEqual(result, { ok: true, adjusted: 2, users: 2, total_hours: 3.5 });
  assert.equal(inserts.length, 2);
  assert.equal(inserts.every((params) => params[4] === "culturales"), true);
  await assert.rejects(
    commitBulkHoursImport({
      importId: preview.import_id,
      importer: { userId: "7", role: "admin", careerId: 3 },
      dependencies: { getRedisClientFn: () => redis },
    }),
    (error) => error.code === "import_expired",
  );
});