// Meta de horas AFC por carrera (careers.afc_hours); sin carrera se usa la meta general.
export const DEFAULT_AFC_HOURS_GOAL = 480;

function toCents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
}

/** Horas que todavía se pueden acreditar sin rebasar la meta (nunca negativas). */
export function capHoursToGoal(hours, currentTotal, goal) {
  const requested = Math.max(0, toCents(hours));
  const remaining = Math.max(0, toCents(goal) - toCents(currentTotal));
  return Math.min(requested, remaining) / 100;
}

/**
 * Meta y total acumulado del usuario. lock=true bloquea la fila del usuario para que
 * dos acreditaciones simultáneas no rebasen la meta.
 */
export async function loadUserHoursProgress(executor, userId, { lock = false } = {}) {
  const goalResult = await executor.query(
    `SELECT COALESCE(c.afc_hours, $2)::numeric(10,2) AS goal
     FROM users u
     LEFT JOIN careers c ON c.id = u.career_id
     WHERE u.id = $1
     LIMIT 1${lock ? " FOR UPDATE OF u" : ""}`,
    [userId, DEFAULT_AFC_HOURS_GOAL],
  );
  const totalResult = await executor.query(
    `SELECT COALESCE(SUM(hours_delta), 0)::numeric(10,2) AS total
     FROM hours_ledger
     WHERE user_id = $1`,
    [userId],
  );
  return {
    goal: Number(goalResult.rows?.[0]?.goal ?? DEFAULT_AFC_HOURS_GOAL),
    total: Number(totalResult.rows?.[0]?.total ?? 0),
  };
}

/** Meta y total de varios usuarios en una sola consulta: Map(userId -> { goal, total }). */
export async function loadUsersHoursProgress(executor, userIds) {
  const ids = [...new Set((userIds || []).map(String))];
  const progress = new Map(ids.map((id) => [id, { goal: DEFAULT_AFC_HOURS_GOAL, total: 0 }]));
  if (ids.length === 0) return progress;
  const result = await executor.query(
    `SELECT p.user_id::text AS user_id,
            COALESCE(c.afc_hours, $2)::numeric(10,2) AS goal,
            COALESCE((SELECT SUM(hl.hours_delta) FROM hours_ledger hl WHERE hl.user_id = p.user_id), 0)::numeric(10,2) AS total
     FROM unnest($1::bigint[]) AS p(user_id)
     LEFT JOIN users target_user ON target_user.id = p.user_id
     LEFT JOIN careers c ON c.id = target_user.career_id`,
    [ids, DEFAULT_AFC_HOURS_GOAL],
  );
  for (const row of result.rows || []) {
    progress.set(String(row.user_id), {
      goal: Number(row.goal ?? DEFAULT_AFC_HOURS_GOAL),
      total: Number(row.total ?? 0),
    });
  }
  return progress;
}

export function goalCapNote(credited, requested, goal) {
  return credited < requested ? ` · meta AFC de ${goal} h: se acreditan ${credited} de ${requested} h` : "";
}
