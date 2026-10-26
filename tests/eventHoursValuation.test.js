import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { missingPublishFields, normalizeCreateEventPayload } from "../src/validators/events.js";
import {
  EventHoursValuationError,
  assertAfcSessionsSupported,
  assertHoursAllowStatus,
  attachAfcEvidence,
  courseDaysFromSessions,
  normalizeAfcValuationInput,
  prepareEventHoursValuation,
} from "../src/services/eventHoursValuation.js";
import {
  buildContentDisposition,
  detectFileMimeType,
  resolveStoragePath,
  sanitizeFileName,
  saveUploadedFile,
  validateFileUpload,
} from "../src/services/fileStorageService.js";

const PDF = Buffer.from("%PDF-1.7\n%test\n");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

const TYPES = [
  { id: "1", origin: "fes_aragon", key: "stands", name: "Stands", min_hours: "5.00", max_hours: "20.00", valuation_mode: "scenarios", is_active: true },
  { id: "2", origin: "fes_aragon", key: "cultural", name: "Culturales", min_hours: "20.00", max_hours: "100.00", valuation_mode: "manual", is_active: true },
  { id: "3", origin: "fes_aragon", key: "committee", name: "Comité", min_hours: null, max_hours: null, valuation_mode: "committee", is_active: true },
  { id: "4", origin: "fes_aragon", key: "old_type", name: "Anterior", min_hours: "5.00", max_hours: "20.00", valuation_mode: "scenarios", is_active: false },
  { id: "5", origin: "fes_aragon", key: "seminars", name: "Seminarios", min_hours: "30.00", max_hours: "80.00", valuation_mode: "scenarios", is_active: true, multi_session: true },
  { id: "6", origin: "fes_aragon", key: "courses", name: "Talleres y cursos", min_hours: null, max_hours: "150.00", valuation_mode: "scenarios", is_active: true, multi_session: true },
];
const SCENARIOS = [
  { id: "10", activity_type_id: "1", key: "stand_basic", label: "Básica", kind: "percent", percent: "25.0000", fixed_hours: null, is_active: true },
  { id: "11", activity_type_id: "1", key: "stand_retired", label: "Retirado", kind: "percent", percent: "50.0000", fixed_hours: null, is_active: false },
  { id: "12", activity_type_id: "4", key: "old_basic", label: "Anterior", kind: "percent", percent: "25.0000", fixed_hours: null, is_active: true },
  { id: "13", activity_type_id: "6", key: "course_defined_duration", label: "Duración definida", kind: "course_duration", percent: null, fixed_hours: null, is_active: true },
];

function createCatalogExecutor({ files = [] } = {}) {
  const state = { files: files.map((row) => ({ ...row })) };
  const same = (a, b) => String(a) === String(b);
  return {
    state,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/gu, " ");
      if (text.includes("FROM afc_activity_types t WHERE t.origin = $1 AND t.key = $2")) {
        return { rows: TYPES.filter((t) => t.origin === params[0] && t.key === params[1]) };
      }
      if (text.includes("FROM afc_valuation_scenarios s WHERE s.activity_type_id = $1 AND s.key = $2")) {
        return { rows: SCENARIOS.filter((s) => same(s.activity_type_id, params[0]) && s.key === params[1]) };
      }
      if (text.includes("UPDATE files SET event_id = $2")) {
        const [fileId, eventId, purpose, userId] = params;
        const row = state.files.find(
          (f) =>
            same(f.id, fileId) &&
            f.purpose === purpose &&
            f.status !== "deleted" &&
            (same(f.event_id, eventId) || (f.event_id === null && f.status === "staged" && same(f.uploaded_by, userId))),
        );
        if (!row) return { rows: [] };
        Object.assign(row, { event_id: eventId, status: "attached" });
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`Consulta no simulada: ${text.slice(0, 90)}`);
    },
  };
}

const input = (raw) => normalizeAfcValuationInput({ origin: "fes_aragon", ...raw }).value;

test("valuation input shape is validated without trusting client results", () => {
  assert.ok(normalizeAfcValuationInput([]).error);
  assert.ok(normalizeAfcValuationInput({ origin: "fes_aragon", type_key: "Bad Key" }).error);
  assert.ok(normalizeAfcValuationInput({ origin: "fes_aragon", type_key: "x", evidence_file_id: "abc" }).error);
  const normalized = input({ type_key: "stands", scenario_key: "stand_basic", final_hours: 999 });
  assert.deepEqual(Object.keys(normalized).sort(), [
    "courseDays", "evidenceFileId", "manualHours", "origin", "scenarioKey", "typeKey",
  ]);
});

test("hours are calculated from the database catalog", async () => {
  const result = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "stands", scenario_key: "stand_basic", evidence_file_id: 5 }),
  });
  assert.equal(result.hoursValue, 9);
  assert.equal(result.valuation.hours_before_rounding, "8.75");
  assert.equal(result.evidenceFileId, null, "los supuestos del tabulador no llevan evidencia");

  await assert.rejects(
    prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "stands", scenario_key: "nope" }) }),
    (error) => error.code === "invalid_scenario",
  );
  await assert.rejects(
    prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "missing" }) }),
    (error) => error.code === "invalid_type",
  );
});

test("manual activities keep optional evidence; committee requires it", async () => {
  const manual = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "cultural", manual_hours: "45" }),
  });
  assert.equal(manual.hoursValue, 45);
  assert.equal(manual.evidenceFileId, null);

  const withFile = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "cultural", manual_hours: "45", evidence_file_id: 7 }),
  });
  assert.equal(withFile.evidenceFileId, 7);

  await assert.rejects(
    prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "committee", manual_hours: "60" }) }),
    (error) => error.code === "evidence_required",
  );
  const committee = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "committee", manual_hours: "60", evidence_file_id: 7 }),
  });
  assert.equal(committee.hoursValue, 60);

  const pending = await prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "committee" }) });
  assert.equal(pending.hoursValue, null);
});

test("unchanged selections keep the hours in force even if the catalog changed", async () => {
  const first = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "stands", scenario_key: "stand_basic" }),
  });
  const existing = { afc_valuation: { ...first.valuation, final_hours: 7 }, hours_value: "7.00" };
  const again = await prepareEventHoursValuation(createCatalogExecutor(), {
    existing,
    input: input({ type_key: "stands", scenario_key: "stand_basic" }),
  });
  assert.equal(again.hoursValue, 7);
  assert.equal(again.valuation.final_hours, 7);
});

test("inactive catalog entries cannot be newly selected", async () => {
  await assert.rejects(
    prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "stands", scenario_key: "stand_retired" }) }),
    (error) => error.code === "inactive_selection",
  );
  await assert.rejects(
    prepareEventHoursValuation(createCatalogExecutor(), { input: input({ type_key: "old_type", scenario_key: "old_basic" }) }),
    (error) => error.code === "inactive_selection",
  );
});

test("evidence must be staged by the same user or already belong to the event", async () => {
  const executor = createCatalogExecutor({
    files: [
      { id: 5, purpose: "afc_hours_evidence", status: "staged", event_id: null, uploaded_by: 99 },
      { id: 6, purpose: "afc_hours_evidence", status: "staged", event_id: null, uploaded_by: 7 },
      { id: 8, purpose: "other", status: "staged", event_id: null, uploaded_by: 7 },
    ],
  });
  await assert.rejects(attachAfcEvidence(executor, { eventId: 1, fileId: 5, authUserId: 7 }), (error) => error.code === "file_not_found");
  await assert.rejects(attachAfcEvidence(executor, { eventId: 1, fileId: 8, authUserId: 7 }), (error) => error.code === "file_not_found");
  await attachAfcEvidence(executor, { eventId: 1, fileId: 6, authUserId: 7 });
  assert.equal(executor.state.files[1].status, "attached");
  assert.equal(executor.state.files[1].event_id, 1);
});

test("course hours come from the event sessions, not from client-captured hours", async () => {
  const course = input({
    type_key: "courses",
    scenario_key: "course_defined_duration",
    course_days: [{ date: "2026-11-03", effective_hours: "20" }],
  });
  // 10:00–13:00 y 16:00–18:30 en Ciudad de México.
  const sessions = [
    { starts_at: "2026-11-05T22:00:00.000Z", ends_at: "2026-11-06T00:30:00.000Z" },
    { starts_at: new Date("2026-11-03T16:00:00.000Z"), ends_at: new Date("2026-11-03T19:00:00.000Z") },
  ];
  assert.deepEqual(courseDaysFromSessions(sessions), [
    { date: "2026-11-03", effective_hours: "3" },
    { date: "2026-11-05", effective_hours: "2.5" },
  ]);

  const fromSessions = await prepareEventHoursValuation(createCatalogExecutor(), { input: course, sessions });
  assert.equal(fromSessions.valuation.input_value, "5.5");
  assert.equal(fromSessions.hoursValue, 11);

  const withoutDates = await prepareEventHoursValuation(createCatalogExecutor(), { input: course, sessions: [] });
  assert.equal(withoutDates.hoursValue, null, "sin horario el curso queda pendiente");

  const stands = await prepareEventHoursValuation(createCatalogExecutor(), {
    input: input({ type_key: "stands", scenario_key: "stand_basic" }),
    sessions,
  });
  assert.equal(stands.hoursValue, 9, "las sesiones solo afectan a los cursos");
});

test("multi-session events only accept AFC activities marked as multi-session", async () => {
  const executor = createCatalogExecutor();
  const stands = { origin: "fes_aragon", type_key: "stands" };
  await assert.rejects(
    assertAfcSessionsSupported(executor, { valuation: stands, sessionCount: 3 }),
    (error) => error.code === "afc_single_session" && /Stands/u.test(error.message),
  );
  await assertAfcSessionsSupported(executor, { valuation: stands, sessionCount: 1 });
  await assertAfcSessionsSupported(executor, { valuation: { origin: "fes_aragon", type_key: "seminars" }, sessionCount: 3 });
  await assertAfcSessionsSupported(executor, { valuation: null, sessionCount: 3 });
});

test("pending hours are only allowed for draft or cancelled events", () => {
  assert.doesNotThrow(() => assertHoursAllowStatus(null, "draft"));
  assert.doesNotThrow(() => assertHoursAllowStatus(null, "cancelled"));
  assert.doesNotThrow(() => assertHoursAllowStatus(0, "published"));
  assert.throws(() => assertHoursAllowStatus(null, "published"), EventHoursValuationError);
});

test("event payload defers AFC hours to the catalog and disables geofencing", () => {
  const starts = new Date(Date.now() + 86_400_000).toISOString();
  const ends = new Date(Date.now() + 90_000_000).toISOString();
  const base = {
    title: "Evento",
    description: "Descripción",
    location: "Auditorio",
    organizer: "Coordinación",
    category: "general",
    starts_at: starts,
    ends_at: ends,
    hours_value: 77,
  };

  const afc = normalizeCreateEventPayload({
    ...base,
    status: "published",
    afc_valuation: { origin: "fes_aragon", type_key: "stands", scenario_key: "stand_basic" },
    sessions: [{ starts_at: starts, ends_at: ends, hours_value: 77 }],
  });
  assert.equal(afc.value.hours_value, null);
  assert.equal(afc.value.sessions[0].hours_value, null);
  assert.equal(afc.value.afc.typeKey, "stands");

  const geo = normalizeCreateEventPayload({ ...base, geo_enforced: true });
  assert.equal(geo.value.geo_enforced, false);
  assert.equal(geo.value.geo, null);

  const legacy = normalizeCreateEventPayload({ ...base, hours_value: 3 });
  assert.equal(legacy.value.hours_value, 3);
  assert.equal(legacy.value.afc, null);
});

test("hours_value null leaves AFC hours pending, only for drafts", () => {
  const starts = new Date(Date.now() + 86_400_000).toISOString();
  const ends = new Date(Date.now() + 90_000_000).toISOString();
  const base = {
    title: "Evento CSV",
    description: "Descripción",
    location: "Auditorio",
    organizer: "Coordinación",
    category: "general",
    starts_at: starts,
    ends_at: ends,
    hours_value: null,
  };

  const draft = normalizeCreateEventPayload({ ...base, status: "draft" });
  assert.equal(draft.error, undefined);
  assert.equal(draft.value.hours_value, null);
  assert.match(normalizeCreateEventPayload({ ...base, status: "published" }).error, /falta: horas AFC/u);
  assert.match(normalizeCreateEventPayload({ ...base, hours_value: "abc" }).error, /decimal/u);
});

test("events can opt out of AFC hours and publish with 0 hrs", () => {
  const starts = new Date(Date.now() + 86_400_000).toISOString();
  const ends = new Date(Date.now() + 90_000_000).toISOString();
  const result = normalizeCreateEventPayload({
    title: "Sin horas",
    description: "Descripción",
    location: "Auditorio",
    organizer: "Coordinación",
    starts_at: starts,
    ends_at: ends,
    status: "published",
    afc_hours_enabled: false,
    hours_value: null,
    afc_valuation: { origin: "fes_aragon", type_key: "stands", scenario_key: "stand_basic" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.hours_value, 0);
  assert.equal(result.value.afc, null);
  assert.equal(result.value.afc_valuation, null);
});

test("a draft only needs title and description; publishing requires the full event", () => {
  const minimal = normalizeCreateEventPayload({ title: "Solo título", description: "Y descripción", status: "draft", hours_value: null });
  assert.equal(minimal.error, undefined);
  assert.equal(minimal.value.starts_at, null);
  assert.equal(minimal.value.category, "general");
  assert.deepEqual(minimal.value.sessions, []);

  assert.match(normalizeCreateEventPayload({ title: "Sin descripción", status: "draft" }).error, /descripción/u);
  const publish = normalizeCreateEventPayload({ title: "T", description: "D", status: "published", hours_value: 2 });
  assert.match(publish.error, /fecha y hora de inicio, fecha y hora de fin, ubicación, organizador/u);
  const halfDates = normalizeCreateEventPayload({
    title: "T",
    description: "D",
    status: "draft",
    starts_at: new Date(Date.now() + 86_400_000).toISOString(),
  });
  assert.match(halfDates.error, /inicio y también las de fin/u);
  assert.deepEqual(missingPublishFields({ title: "T", description: " ", starts_at: new Date() }), [
    "descripción",
    "fecha y hora de fin",
    "ubicación",
    "organizador",
  ]);
});

test("uploads accept only PDF, PNG or JPEG whose content matches", () => {
  assert.equal(detectFileMimeType(PDF), "application/pdf");
  assert.equal(validateFileUpload({ buffer: PNG, declaredMimeType: "image/png" }).mimeType, "image/png");
  assert.equal(validateFileUpload({ buffer: PDF, declaredMimeType: "image/png" }).statusCode, 415);
  assert.equal(validateFileUpload({ buffer: Buffer.from("<html>"), declaredMimeType: "text/html" }).statusCode, 415);
  assert.equal(validateFileUpload({ buffer: Buffer.alloc(0), declaredMimeType: "application/pdf" }).statusCode, 400);
});

test("file names are sanitized and storage paths cannot escape the base directory", () => {
  assert.equal(sanitizeFileName(encodeURIComponent("../../dictamen final.pdf"), "application/pdf"), ".._.._dictamen final.pdf");
  assert.equal(sanitizeFileName("", "image/jpeg"), "archivo.jpg");
  assert.match(buildContentDisposition("Dictamen \"Año\".pdf"), /^inline; filename="Dictamen _A_o_.pdf"; filename\*=UTF-8''/u);
  assert.throws(() => resolveStoragePath("../../etc/passwd", "/tmp/base"));
  assert.throws(() => resolveStoragePath("2026/10/../../x.pdf", "/tmp/base"));
  assert.equal(
    resolveStoragePath("2026/10/123e4567-e89b-12d3-a456-426614174000.pdf", "/tmp/base"),
    path.resolve("/tmp/base/2026/10/123e4567-e89b-12d3-a456-426614174000.pdf"),
  );
});

test("saved files are written to disk and removed if the database insert fails", async () => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "afc-files-"));
  try {
    let insertedKey = null;
    const ok = await saveUploadedFile(
      {
        async query(_sql, params) {
          insertedKey = params[1];
          return { rows: [{ id: 1, original_name: params[2] }] };
        },
      },
      { buffer: PDF, mimeType: "application/pdf", originalName: "d.pdf", purpose: "afc_hours_evidence", uploadedBy: 7 },
      { baseDir },
    );
    assert.equal(ok.id, 1);
    assert.deepEqual(await readFile(resolveStoragePath(insertedKey, baseDir)), PDF);

    let failedKey = null;
    await assert.rejects(
      saveUploadedFile(
        {
          async query(_sql, params) {
            failedKey = params[1];
            throw new Error("db down");
          },
        },
        { buffer: PDF, mimeType: "application/pdf", originalName: "d.pdf", purpose: "afc_hours_evidence", uploadedBy: 7 },
        { baseDir },
      ),
    );
    await assert.rejects(readFile(resolveStoragePath(failedKey, baseDir)), (error) => error.code === "ENOENT");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("routes protect files and the AFC catalog", async () => {
  const files = await readFile(new URL("../src/routes/filesRoutes.js", import.meta.url), "utf8");
  assert.match(files, /"\/api\/files",\s*requireAuth,\s*checkUploadPurpose/u);
  assert.match(files, /"\/api\/files\/:fileId",\s*requireAuth/u);
  const catalog = await readFile(new URL("../src/routes/afcCatalogRoutes.js", import.meta.url), "utf8");
  assert.match(catalog, /"\/api\/admin\/afc-catalog",\s*requireAuth,\s*requireEventManager/u);
  assert.equal((catalog.match(/requireAuth, requireAdmin, requireGlobalAdmin/gu) || []).length, 4);
  const server = await readFile(new URL("../server.js", import.meta.url), "utf8");
  assert.match(server, /app\.use\(afcCatalogRoutes\)/u);
  assert.match(server, /app\.use\(filesRoutes\)/u);
});
