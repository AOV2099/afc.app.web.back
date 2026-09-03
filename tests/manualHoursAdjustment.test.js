import assert from "node:assert/strict";
import test from "node:test";

import {
  ManualHoursAdjustmentError,
  addManualAccountHours,
  normalizeAccountNumber,
  normalizeAdjustmentCategory,
  normalizeAdjustmentMotive,
  normalizeAdjustmentRequestId,
  normalizeManualHours,
} from "../src/services/manualHoursAdjustmentService.js";

const REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000";
const INPUT = {
  accountNumber: "123456789",
  hours: "2.50",
  category: "culturales",
  motive: "Participación en actividad complementaria.",
  requestId: REQUEST_ID,
  admin: { userId: "7", role: "admin", careerId: 3 },
};

function transactionWith(tx) {
  return async (work) => work(tx);
}

test("validates account, positive hours, motive, and request ID", () => {
  assert.equal(normalizeAccountNumber("123456789"), "123456789");
  assert.equal(normalizeAccountNumber("12345678"), "12345678");
  assert.equal(normalizeAccountNumber("1234567890"), "1234567890");
  assert.equal(normalizeAccountNumber("123"), null);
  assert.equal(normalizeManualHours("0.01"), 0.01);
  assert.equal(normalizeManualHours("100.00"), 100);
  assert.equal(normalizeManualHours("0"), null);
  assert.equal(normalizeManualHours("100.01"), null);
  assert.equal(normalizeManualHours("1.001"), null);
  assert.equal(normalizeAdjustmentCategory(" Culturales "), "culturales");
  assert.equal(normalizeAdjustmentCategory("categoría inválida"), null);
  assert.equal(normalizeAdjustmentMotive("Motivo válido"), "Motivo válido");
  assert.equal(normalizeAdjustmentMotive("no"), null);
  assert.equal(normalizeAdjustmentRequestId(REQUEST_ID), REQUEST_ID);
  assert.equal(normalizeAdjustmentRequestId("not-a-uuid"), null);
});

test("adds an auditable adjustment and returns the resulting balance", async () => {
  const statements = [];
  const tx = {
    async query(sql, params) {
      statements.push({ sql, params });
      if (sql.includes("FROM users u")) {
        return { rows: [{ id: "21", student_id: INPUT.accountNumber, career_id: 3, status: "active", role: "visitor" }] };
      }
      if (sql.includes("FROM event_categories")) return { rows: [{ key: INPUT.category }] };
      if (sql.includes("INSERT INTO hours_ledger")) {
        return { rows: [{ id: "30", user_id: "21", hours_delta: "2.50", reason: "adjustment", category: INPUT.category, note: INPUT.motive, created_at: new Date(), request_id: REQUEST_ID }] };
      }
      if (sql.includes("SUM(hours_delta)")) return { rows: [{ total_hours: "12.50" }] };
      throw new Error("Consulta inesperada");
    },
  };

  const result = await addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) });

  assert.equal(result.created, true);
  assert.equal(result.hours_added, 2.5);
  assert.equal(result.total_hours, 12.5);
  assert.match(statements[0].sql, /FOR UPDATE OF u/u);
  assert.match(statements[2].sql, /'adjustment'::ledger_reason/u);
  assert.deepEqual(statements[2].params, ["21", 2.5, "7", INPUT.motive, INPUT.category, REQUEST_ID]);
  assert.equal(result.entry.category, INPUT.category);
});

test("accepts any active role with an account number", async () => {
  const tx = {
    async query(sql) {
      if (sql.includes("FROM users u")) {
        return { rows: [{ id: "21", career_id: 3, status: "active", role: "student" }] };
      }
      if (sql.includes("FROM event_categories")) return { rows: [{ key: INPUT.category }] };
      if (sql.includes("INSERT INTO hours_ledger")) {
        return { rows: [{ id: "30", user_id: "21", hours_delta: "2.50", reason: "adjustment", category: INPUT.category, note: INPUT.motive, created_at: new Date(), request_id: REQUEST_ID }] };
      }
      if (sql.includes("SUM(hours_delta)")) return { rows: [{ total_hours: "2.50" }] };
      throw new Error("Consulta inesperada");
    },
  };

  const result = await addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) });
  assert.equal(result.created, true);
});

test("rejects a category missing from the database catalog", async () => {
  const tx = {
    async query(sql) {
      if (sql.includes("FROM users u")) {
        return { rows: [{ id: "21", career_id: 3, status: "active", role: "student" }] };
      }
      if (sql.includes("FROM event_categories")) return { rows: [] };
      throw new Error("Consulta inesperada");
    },
  };

  await assert.rejects(
    addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) }),
    (error) => error instanceof ManualHoursAdjustmentError && error.code === "invalid_category",
  );
});

test("rejects inactive users and cross-career targets", async () => {
  for (const [target, code] of [
    [{ id: "21", career_id: 3, status: "inactive", role: "visitor" }, "user_inactive"],
    [{ id: "21", career_id: 4, status: "active", role: "visitor" }, "career_scope_mismatch"],
  ]) {
    const tx = { async query() { return { rows: [target] }; } };
    await assert.rejects(
      addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) }),
      (error) => error.code === code,
    );
  }
});

test("replays an identical request without adding hours twice", async () => {
  const tx = {
    async query(sql) {
      if (sql.includes("FROM users u")) {
        return { rows: [{ id: "21", career_id: 3, status: "active", role: "visitor" }] };
      }
      if (sql.includes("FROM event_categories")) return { rows: [{ key: INPUT.category }] };
      if (sql.includes("INSERT INTO hours_ledger")) return { rows: [] };
      if (sql.includes("WHERE request_id")) {
        return { rows: [{ id: "30", user_id: "21", created_by: "7", hours_delta: "2.50", reason: "adjustment", category: INPUT.category, note: INPUT.motive, created_at: new Date(), request_id: REQUEST_ID }] };
      }
      if (sql.includes("SUM(hours_delta)")) return { rows: [{ total_hours: "12.50" }] };
      throw new Error("Consulta inesperada");
    },
  };

  const result = await addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) });
  assert.equal(result.created, false);
  assert.equal(result.total_hours, 12.5);
});

test("rejects an idempotency key reused with different data", async () => {
  const tx = {
    async query(sql) {
      if (sql.includes("FROM users u")) {
        return { rows: [{ id: "21", career_id: 3, status: "active", role: "visitor" }] };
      }
      if (sql.includes("FROM event_categories")) return { rows: [{ key: INPUT.category }] };
      if (sql.includes("INSERT INTO hours_ledger")) return { rows: [] };
      if (sql.includes("WHERE request_id")) {
        return { rows: [{ id: "31", user_id: "99", created_by: "7", hours_delta: "2.50", note: INPUT.motive }] };
      }
      throw new Error("Consulta inesperada");
    },
  };

  await assert.rejects(
    addManualAccountHours(INPUT, { withTransactionFn: transactionWith(tx) }),
    (error) => error instanceof ManualHoursAdjustmentError && error.code === "request_id_conflict",
  );
});