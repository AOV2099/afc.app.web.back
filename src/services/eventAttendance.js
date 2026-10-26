import { EVENT_TIME_ZONE } from "./eventFinalizationScheduler.js";

const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: EVENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Fecha (AAAA-MM-DD) en la zona horaria de los eventos; las sesiones se limitan a una por día local. */
export function eventDayKey(date) {
  return dayFormatter.format(date);
}

/** Sesiones mínimas para cumplir el porcentaje (asistidas / total >= porcentaje); misma fórmula que el front. */
export function requiredSessions(percent, total) {
  const sessions = Math.max(0, Math.trunc(Number(total) || 0));
  if (!sessions) return 0;
  const pct = Math.min(100, Math.max(1, Math.trunc(Number(percent) || 100)));
  return Math.max(1, Math.floor((pct * sessions + 99) / 100));
}

export function attendanceProgress({ attended, total, percent }) {
  const required = requiredSessions(percent, total);
  const attendedCount = Math.max(0, Number(attended) || 0);
  return { attended: attendedCount, total: Number(total) || 0, required, met: required > 0 && attendedCount >= required };
}

// Las horas se acreditan una sola vez: en el check-in con el que se alcanza exactamente el mínimo.
export function grantsHoursOnCheckin({ attendedAfter, total, percent }) {
  return attendedAfter === requiredSessions(percent, total);
}

/** Si aún es posible cumplir la asistencia mínima con las sesiones que no han terminado. */
export async function loadAttendanceReachability(executor, { eventId, percent }) {
  const result = await executor.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE ends_at >= now())::int AS pending
     FROM event_sessions
     WHERE event_id = $1`,
    [eventId],
  );
  const total = Number(result.rows?.[0]?.total ?? 0);
  const pending = Number(result.rows?.[0]?.pending ?? 0);
  const required = requiredSessions(percent, total);
  return { total, pending, required, reachable: total <= 1 || pending >= required };
}

export function unreachableAttendanceMessage({ total, pending, required }) {
  return `Ya no es posible cumplir la asistencia mínima: se requieren ${required} de ${total} sesiones y solo quedan ${pending}.`;
}

function sameTimes(existing, next) {
  return (
    new Date(existing.starts_at).getTime() === next.starts_at.getTime() &&
    new Date(existing.ends_at).getTime() === next.ends_at.getTime()
  );
}

/**
 * Con asistencias registradas: conserva las sesiones con check-ins y reprograma las demás
 * sin cambiar el total (de él depende el mínimo de asistencia).
 * existing: [{ id, starts_at, ends_at, has_checkins }]; next: [{ starts_at: Date, ends_at: Date, label }].
 * Devuelve { updates: [{ id, starts_at, ends_at, label }] } o { error }.
 */
export function planSessionReschedule(existing, next, now = new Date()) {
  if (next.length !== existing.length) {
    return {
      error: `El evento ya tiene asistencias: debe conservar sus ${existing.length} sesiones. Solo puedes cambiar la fecha u horario de las que aún no tienen asistencias.`,
    };
  }
  const remaining = [...next].sort((a, b) => a.starts_at - b.starts_at);
  const take = (session) => {
    const index = remaining.findIndex((candidate) => sameTimes(session, candidate));
    return index === -1 ? null : remaining.splice(index, 1)[0];
  };

  const updates = [];
  for (const session of existing.filter((row) => row.has_checkins)) {
    const kept = take(session);
    if (!kept) {
      return {
        error: `La sesión del ${eventDayKey(new Date(session.starts_at))} ya tiene asistencias y no puede cambiarse ni quitarse.`,
      };
    }
    updates.push({ id: session.id, starts_at: kept.starts_at, ends_at: kept.ends_at, label: kept.label });
  }

  const movable = [];
  for (const session of existing.filter((row) => !row.has_checkins)) {
    const kept = take(session);
    if (kept) updates.push({ id: session.id, starts_at: kept.starts_at, ends_at: kept.ends_at, label: kept.label });
    else movable.push(session);
  }
  for (let index = 0; index < movable.length; index += 1) {
    const target = remaining[index];
    if (target.starts_at < now) {
      return { error: "Las sesiones reprogramadas no pueden quedar en el pasado." };
    }
    updates.push({ id: movable[index].id, starts_at: target.starts_at, ends_at: target.ends_at, label: target.label });
  }
  return { updates };
}
