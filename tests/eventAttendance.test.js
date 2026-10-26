import assert from "node:assert/strict";
import test from "node:test";

import {
  attendanceProgress,
  eventDayKey,
  grantsHoursOnCheckin,
  loadAttendanceReachability,
  planSessionReschedule,
  requiredSessions,
  unreachableAttendanceMessage,
} from "../src/services/eventAttendance.js";
import { rangeFromSessions, sessionAttendanceState } from "../src/routes/eventsRoutes.js";
import { normalizeCreateEventPayload, parseMinAttendancePercent } from "../src/validators/events.js";

test("students see each session as attended, missed, in progress or upcoming", () => {
  const now = new Date("2027-01-10T12:00:00Z");
  const past = { starts_at: "2027-01-09T10:00:00Z", ends_at: "2027-01-09T12:00:00Z" };
  assert.equal(sessionAttendanceState(past, now), "missed");
  assert.equal(sessionAttendanceState({ ...past, checked_in_at: "2027-01-09T10:05:00Z" }, now), "attended");
  assert.equal(sessionAttendanceState({ starts_at: "2027-01-10T11:00:00Z", ends_at: "2027-01-10T13:00:00Z" }, now), "in_progress");
  assert.equal(sessionAttendanceState({ starts_at: "2027-01-11T11:00:00Z", ends_at: "2027-01-11T13:00:00Z" }, now), "upcoming");
});

const at = (iso) => new Date(iso);
const slot = (day, startHour, endHour) => ({
  starts_at: at(`2027-0${day}T${startHour}:00:00.000Z`),
  ends_at: at(`2027-0${day}T${endHour}:00:00.000Z`),
  label: null,
});

test("with attendance only sessions without check-ins can be rescheduled, keeping the total", () => {
  const now = at("2027-03-05T00:00:00.000Z");
  const existing = [
    { id: 1, ...slot("3-01", 16, 18), has_checkins: true },
    { id: 2, ...slot("3-08", 16, 18), has_checkins: false },
    { id: 3, ...slot("3-15", 16, 18), has_checkins: false },
  ];
  const moved = planSessionReschedule(existing, [slot("3-01", 16, 18), slot("3-09", 17, 19), slot("3-15", 16, 18)], now);
  assert.equal(moved.error, undefined);
  assert.deepEqual(
    moved.updates.map((update) => [update.id, update.starts_at.toISOString()]),
    [
      [1, "2027-03-01T16:00:00.000Z"],
      [3, "2027-03-15T16:00:00.000Z"],
      [2, "2027-03-09T17:00:00.000Z"],
    ],
  );

  assert.match(
    planSessionReschedule(existing, [slot("3-02", 16, 18), slot("3-08", 16, 18), slot("3-15", 16, 18)], now).error,
    /ya tiene asistencias/u,
  );
  assert.match(planSessionReschedule(existing, [slot("3-01", 16, 18), slot("3-08", 16, 18)], now).error, /conservar sus 3 sesiones/u);
  assert.match(
    planSessionReschedule(existing, [slot("3-01", 16, 18), slot("3-04", 16, 18), slot("3-15", 16, 18)], now).error,
    /pasado/u,
  );
});

test("event dates come from the first and last session", () => {
  assert.equal(rangeFromSessions([]), null);
  assert.equal(rangeFromSessions([{ starts_at: "x", ends_at: "2027-01-01T10:00:00.000Z" }]), null);
  const range = rangeFromSessions([
    { starts_at: "2027-01-08T16:00:00.000Z", ends_at: "2027-01-08T18:00:00.000Z" },
    { starts_at: "2027-01-01T16:00:00.000Z", ends_at: "2027-01-01T18:00:00.000Z" },
  ]);
  assert.equal(range.startsAt.toISOString(), "2027-01-01T16:00:00.000Z");
  assert.equal(range.endsAt.toISOString(), "2027-01-08T18:00:00.000Z");
});

test("registration is blocked once the minimum attendance is no longer reachable", async () => {
  const executor = (total, pending) => ({ query: async () => ({ rows: [{ total, pending }] }) });
  const late = await loadAttendanceReachability(executor(10, 7), { eventId: 1, percent: 80 });
  assert.deepEqual(late, { total: 10, pending: 7, required: 8, reachable: false });
  assert.equal(
    unreachableAttendanceMessage(late),
    "Ya no es posible cumplir la asistencia mínima: se requieren 8 de 10 sesiones y solo quedan 7.",
  );
  assert.equal((await loadAttendanceReachability(executor(10, 8), { eventId: 1, percent: 80 })).reachable, true);
  assert.equal((await loadAttendanceReachability(executor(1, 0), { eventId: 1, percent: 100 })).reachable, true);
});

test("required sessions match the front formula (attended / total >= percent)", () => {
  assert.equal(requiredSessions(80, 5), 4);
  assert.equal(requiredSessions(80, 4), 4);
  assert.equal(requiredSessions(65, 3), 2);
  assert.equal(requiredSessions(70, 3), 3);
  assert.equal(requiredSessions(50, 2), 1);
  assert.equal(requiredSessions(100, 1), 1);
  assert.equal(requiredSessions(null, 3), 3, "sin porcentaje se exigen todas");
});

test("hours are granted only on the check-in that reaches the minimum", () => {
  const rule = { total: 5, percent: 80 };
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((attendedAfter) => grantsHoursOnCheckin({ ...rule, attendedAfter })),
    [false, false, false, true, false],
  );
  assert.equal(grantsHoursOnCheckin({ attendedAfter: 1, total: 1, percent: 100 }), true, "una sesión: igual que antes");
  assert.deepEqual(attendanceProgress({ attended: 3, total: 5, percent: 80 }), {
    attended: 3,
    total: 5,
    required: 4,
    met: false,
  });
});

test("session days use the event time zone so evening sessions do not collide", () => {
  // 19:00 en CDMX del 19 = 01:00 UTC del 20; la sesión del 20 a las 10:00 es otro día local.
  assert.equal(eventDayKey(new Date("2027-01-20T01:00:00.000Z")), "2027-01-19");
  assert.equal(eventDayKey(new Date("2027-01-20T16:00:00.000Z")), "2027-01-20");

  const sessions = [
    { starts_at: "2027-01-20T01:00:00.000Z", ends_at: "2027-01-20T03:00:00.000Z" },
    { starts_at: "2027-01-20T16:00:00.000Z", ends_at: "2027-01-20T18:00:00.000Z" },
  ];
  const result = normalizeCreateEventPayload({
    title: "Taller vespertino",
    description: "Dos d\u00edas",
    status: "draft",
    hours_value: null,
    starts_at: sessions[0].starts_at,
    ends_at: sessions[1].ends_at,
    sessions,
    min_attendance_percent: 50,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.value.sessions.length, 2);
  assert.equal(result.value.min_attendance_percent, 50);
});

test("attendance percent is validated and only kept for multi-session events", () => {
  assert.equal(parseMinAttendancePercent(undefined), 100);
  assert.equal(parseMinAttendancePercent("75"), 75);
  assert.equal(parseMinAttendancePercent(0), null);
  assert.equal(parseMinAttendancePercent(101), null);
  assert.equal(parseMinAttendancePercent(80.5), null);

  const base = { title: "T", description: "D", status: "draft", hours_value: null };
  assert.match(normalizeCreateEventPayload({ ...base, min_attendance_percent: 0 }).error, /porcentaje m\u00ednimo/u);

  const start = new Date(Date.now() + 86_400_000);
  const end = new Date(start.getTime() + 3_600_000);
  const single = normalizeCreateEventPayload({
    ...base,
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    min_attendance_percent: 60,
  });
  assert.equal(single.value.min_attendance_percent, 100, "una sola sesi\u00f3n exige asistir");

  const tooMany = Array.from({ length: 81 }, (_, index) => {
    const day = new Date(start.getTime() + index * 86_400_000);
    return { starts_at: day.toISOString(), ends_at: new Date(day.getTime() + 3_600_000).toISOString() };
  });
  assert.match(
    normalizeCreateEventPayload({
      ...base,
      starts_at: tooMany[0].starts_at,
      ends_at: tooMany[80].ends_at,
      sessions: tooMany,
    }).error,
    /81 sesiones y el evento admite hasta 80/u,
  );
});
