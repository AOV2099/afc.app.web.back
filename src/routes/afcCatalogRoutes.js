import { Router } from "express";

import { query, withTransaction } from "../postgresClient.js";
import { requireAdmin, requireAuth, requireEventManager, requireGlobalAdmin } from "../middleware/auth.js";
import { ROLES } from "../config/appConfig.js";
import {
  AFC_VALUATION_MODE,
  checkScenarioFitsType,
  normalizeAfcScenarioInput,
  normalizeAfcTypeInput,
} from "../catalogs/afcHoursCalc.js";
import {
  loadAfcCatalog,
  loadAfcScenarioById,
  loadAfcScenariosForType,
  loadAfcTypeById,
} from "../services/afcCatalogRepository.js";

const router = Router();

function parsePositiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function httpError(statusCode, message, code = undefined) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sendError(res, err, fallbackMessage, logLabel) {
  if ([400, 404, 409].includes(err?.statusCode)) {
    return res.status(err.statusCode).json({ ok: false, code: err.code, message: err.message });
  }
  if (err?.code === "23505") {
    return res.status(409).json({ ok: false, message: "Ya existe un registro con esa clave." });
  }
  if (err?.code === "23514") {
    return res.status(400).json({ ok: false, message: "Los datos no cumplen las reglas del catálogo AFC." });
  }
  console.error(`Error en ${logLabel}:`, err?.message);
  return res.status(500).json({ ok: false, message: fallbackMessage });
}

// Al cambiar rango o modo, los supuestos activos deben seguir siendo calculables.
function assertActiveScenariosFit(type, scenarios) {
  if (type.valuation_mode !== AFC_VALUATION_MODE.SCENARIOS) return;
  for (const scenario of scenarios.filter((item) => item.is_active)) {
    const problem = checkScenarioFitsType(type, scenario);
    if (problem) throw httpError(400, problem, "scenario_out_of_range");
  }
}

router.get("/api/admin/afc-catalog", requireAuth, requireEventManager, async (req, res) => {
  const includeInactive = req.query?.include_inactive === "1" && req.auth?.role === ROLES.ADMIN;
  try {
    const types = await loadAfcCatalog({ query }, { includeInactive });
    return res.status(200).json({ ok: true, types });
  } catch (err) {
    return sendError(res, err, "No se pudo consultar el catálogo AFC.", "GET /api/admin/afc-catalog");
  }
});

router.post("/api/admin/afc-catalog/types", requireAuth, requireAdmin, requireGlobalAdmin, async (req, res) => {
  const normalized = normalizeAfcTypeInput(req.body);
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const type = normalized.value;

  try {
    const result = await query(
      `INSERT INTO afc_activity_types (
         origin, key, name, description, requirements, min_hours, max_hours,
         valuation_mode, sort_order, is_active, updated_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        type.origin, type.key, type.name, type.description, type.requirements, type.min_hours,
        type.max_hours, type.valuation_mode, type.sort_order, type.is_active, req.auth.userId,
      ],
    );
    const created = await loadAfcTypeById({ query }, result.rows[0].id);
    return res.status(201).json({ ok: true, message: "Actividad creada.", type: { ...created, scenarios: [] } });
  } catch (err) {
    return sendError(res, err, "No se pudo crear la actividad.", "POST /api/admin/afc-catalog/types");
  }
});

router.put("/api/admin/afc-catalog/types/:typeId", requireAuth, requireAdmin, requireGlobalAdmin, async (req, res) => {
  const typeId = parsePositiveId(req.params.typeId);
  if (!typeId) return res.status(400).json({ ok: false, message: "Actividad inválida." });
  const normalized = normalizeAfcTypeInput(req.body, { partial: true });
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const changes = normalized.value;

  try {
    const updated = await withTransaction(async (tx) => {
      const current = await loadAfcTypeById(tx, typeId, { forUpdate: true });
      if (!current) throw httpError(404, "Actividad no encontrada.");
      const scenarios = await loadAfcScenariosForType(tx, typeId);
      assertActiveScenariosFit({ ...current, ...changes }, scenarios);

      await tx.query(
        `UPDATE afc_activity_types
         SET name = $2, description = $3, requirements = $4, min_hours = $5, max_hours = $6,
             valuation_mode = $7, sort_order = $8, is_active = $9, updated_by = $10, updated_at = now()
         WHERE id = $1`,
        [
          typeId, changes.name, changes.description, changes.requirements, changes.min_hours,
          changes.max_hours, changes.valuation_mode, changes.sort_order, changes.is_active, req.auth.userId,
        ],
      );
      const type = await loadAfcTypeById(tx, typeId);
      return { ...type, scenarios: await loadAfcScenariosForType(tx, typeId) };
    });
    return res.status(200).json({ ok: true, message: "Actividad actualizada.", type: updated });
  } catch (err) {
    return sendError(res, err, "No se pudo actualizar la actividad.", "PUT /api/admin/afc-catalog/types/:typeId");
  }
});

router.post("/api/admin/afc-catalog/types/:typeId/scenarios", requireAuth, requireAdmin, requireGlobalAdmin, async (req, res) => {
  const typeId = parsePositiveId(req.params.typeId);
  if (!typeId) return res.status(400).json({ ok: false, message: "Actividad inválida." });
  const normalized = normalizeAfcScenarioInput(req.body);
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const scenario = normalized.value;

  try {
    const created = await withTransaction(async (tx) => {
      const type = await loadAfcTypeById(tx, typeId, { forUpdate: true });
      if (!type) throw httpError(404, "Actividad no encontrada.");
      const problem = checkScenarioFitsType(type, scenario);
      if (problem) throw httpError(400, problem, "scenario_out_of_range");

      const result = await tx.query(
        `INSERT INTO afc_valuation_scenarios (
           activity_type_id, key, label, kind, percent, fixed_hours, sort_order, is_active, updated_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          typeId, scenario.key, scenario.label, scenario.kind, scenario.percent,
          scenario.fixed_hours, scenario.sort_order, scenario.is_active, req.auth.userId,
        ],
      );
      return loadAfcScenarioById(tx, result.rows[0].id);
    });
    return res.status(201).json({ ok: true, message: "Supuesto creado.", scenario: created });
  } catch (err) {
    return sendError(res, err, "No se pudo crear el supuesto.", "POST /api/admin/afc-catalog/types/:typeId/scenarios");
  }
});

router.put("/api/admin/afc-catalog/scenarios/:scenarioId", requireAuth, requireAdmin, requireGlobalAdmin, async (req, res) => {
  const scenarioId = parsePositiveId(req.params.scenarioId);
  if (!scenarioId) return res.status(400).json({ ok: false, message: "Supuesto inválido." });
  const normalized = normalizeAfcScenarioInput(req.body, { partial: true });
  if (normalized.error) return res.status(400).json({ ok: false, message: normalized.error });
  const changes = normalized.value;

  try {
    const updated = await withTransaction(async (tx) => {
      const current = await loadAfcScenarioById(tx, scenarioId, { forUpdate: true });
      if (!current) throw httpError(404, "Supuesto no encontrado.");
      const type = await loadAfcTypeById(tx, current.activity_type_id);
      if (changes.is_active) {
        const problem = checkScenarioFitsType(type, { ...current, ...changes });
        if (problem) throw httpError(400, problem, "scenario_out_of_range");
      }

      await tx.query(
        `UPDATE afc_valuation_scenarios
         SET label = $2, kind = $3, percent = $4, fixed_hours = $5, sort_order = $6,
             is_active = $7, updated_by = $8, updated_at = now()
         WHERE id = $1`,
        [
          scenarioId, changes.label, changes.kind, changes.percent, changes.fixed_hours,
          changes.sort_order, changes.is_active, req.auth.userId,
        ],
      );
      return loadAfcScenarioById(tx, scenarioId);
    });
    return res.status(200).json({ ok: true, message: "Supuesto actualizado.", scenario: updated });
  } catch (err) {
    return sendError(res, err, "No se pudo actualizar el supuesto.", "PUT /api/admin/afc-catalog/scenarios/:scenarioId");
  }
});

export default router;
