import { AFC_KEY_PATTERN } from "../catalogs/afcHoursCalc.js";

const TYPE_COLUMNS = `t.id, t.origin, t.key, t.name, t.description, t.requirements,
  t.min_hours::text AS min_hours, t.max_hours::text AS max_hours, t.valuation_mode,
  t.sort_order, t.is_active, t.updated_at`;
const SCENARIO_COLUMNS = `s.id, s.activity_type_id, s.key, s.label, s.kind,
  s.percent::text AS percent, s.fixed_hours::text AS fixed_hours,
  s.sort_order, s.is_active, s.updated_at`;

export async function loadAfcCatalog(executor, { includeInactive = false } = {}) {
  const activeFilter = includeInactive ? "" : "WHERE t.is_active";
  const typesResult = await executor.query(
    `SELECT ${TYPE_COLUMNS}
     FROM afc_activity_types t
     ${activeFilter}
     ORDER BY t.origin, t.sort_order, t.id`,
  );
  const scenariosResult = await executor.query(
    `SELECT ${SCENARIO_COLUMNS}
     FROM afc_valuation_scenarios s
     JOIN afc_activity_types t ON t.id = s.activity_type_id
     ${includeInactive ? "" : "WHERE s.is_active AND t.is_active"}
     ORDER BY s.activity_type_id, s.sort_order, s.id`,
  );

  const byType = new Map();
  for (const scenario of scenariosResult.rows) {
    const key = String(scenario.activity_type_id);
    if (!byType.has(key)) byType.set(key, []);
    byType.get(key).push(scenario);
  }
  return typesResult.rows.map((type) => ({ ...type, scenarios: byType.get(String(type.id)) || [] }));
}

export async function findAfcActivityType(executor, { origin, typeKey }) {
  if (!AFC_KEY_PATTERN.test(String(origin || "")) || !AFC_KEY_PATTERN.test(String(typeKey || ""))) return null;
  const result = await executor.query(
    `SELECT ${TYPE_COLUMNS}
     FROM afc_activity_types t
     WHERE t.origin = $1 AND t.key = $2
     LIMIT 1`,
    [origin, typeKey],
  );
  return result.rows?.[0] ?? null;
}

export async function findAfcScenario(executor, { typeId, scenarioKey }) {
  if (!AFC_KEY_PATTERN.test(String(scenarioKey || ""))) return null;
  const result = await executor.query(
    `SELECT ${SCENARIO_COLUMNS}
     FROM afc_valuation_scenarios s
     WHERE s.activity_type_id = $1 AND s.key = $2
     LIMIT 1`,
    [typeId, scenarioKey],
  );
  return result.rows?.[0] ?? null;
}

export async function loadAfcTypeById(executor, typeId, { forUpdate = false } = {}) {
  const result = await executor.query(
    `SELECT ${TYPE_COLUMNS}
     FROM afc_activity_types t
     WHERE t.id = $1
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [typeId],
  );
  return result.rows?.[0] ?? null;
}

export async function loadAfcScenarioById(executor, scenarioId, { forUpdate = false } = {}) {
  const result = await executor.query(
    `SELECT ${SCENARIO_COLUMNS}
     FROM afc_valuation_scenarios s
     WHERE s.id = $1
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [scenarioId],
  );
  return result.rows?.[0] ?? null;
}

export async function loadAfcScenariosForType(executor, typeId) {
  const result = await executor.query(
    `SELECT ${SCENARIO_COLUMNS}
     FROM afc_valuation_scenarios s
     WHERE s.activity_type_id = $1
     ORDER BY s.sort_order, s.id`,
    [typeId],
  );
  return result.rows;
}
