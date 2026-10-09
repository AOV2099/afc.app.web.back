// Cálculo de horas AFC. Copia idéntica en AFC-Front/src/lib/catalogs/afcHoursCalc.js
// (tests/afcHoursCalc.test.js verifica que ambas copias coincidan).
// El catálogo (actividades y supuestos) vive en la BD: afc_activity_types y afc_valuation_scenarios.
// Decisión de producto: el porcentaje se aplica al intervalo [mínimo, máximo]: mín + (máx − mín) × %.

export const AFC_CALC_VERSION = "afc-calc-2026.10-v2";

export const AFC_ORIGIN = Object.freeze({
  FES_ARAGON: "fes_aragon",
  EXTERNAL: "external",
});

export const AFC_ORIGIN_OPTIONS = Object.freeze([
  Object.freeze({ value: AFC_ORIGIN.FES_ARAGON, label: "FES Aragón" }),
  Object.freeze({
    value: AFC_ORIGIN.EXTERNAL,
    label: "Otra dependencia de la UNAM / institución externa",
  }),
]);

export const AFC_VALUATION_MODE = Object.freeze({
  SCENARIOS: "scenarios",
  MANUAL: "manual",
  COMMITTEE: "committee",
});

export const AFC_VALUATION_MODE_OPTIONS = Object.freeze([
  Object.freeze({ value: AFC_VALUATION_MODE.SCENARIOS, label: "Supuestos del tabulador" }),
  Object.freeze({ value: AFC_VALUATION_MODE.MANUAL, label: "Horas libres dentro del rango (evidencia opcional)" }),
  Object.freeze({ value: AFC_VALUATION_MODE.COMMITTEE, label: "Comité de Carrera (horas libres + dictamen obligatorio)" }),
]);

export const AFC_SCENARIO_KIND = Object.freeze({
  PERCENT: "percent",
  FIXED_HOURS: "fixed_hours",
  COURSE_DURATION: "course_duration",
});

export const AFC_SCENARIO_KIND_OPTIONS = Object.freeze([
  Object.freeze({ value: AFC_SCENARIO_KIND.PERCENT, label: "Porcentaje del rango" }),
  Object.freeze({ value: AFC_SCENARIO_KIND.FIXED_HOURS, label: "Horas fijas" }),
  Object.freeze({ value: AFC_SCENARIO_KIND.COURSE_DURATION, label: "Duración del curso (horas × 2)" }),
]);

export const AFC_METHOD = Object.freeze({
  PERCENT_RANGE: "percent_range",
  FIXED_HOURS: "fixed_hours",
  COURSE_DURATION: "course_duration",
  MANUAL: "manual",
  COMMITTEE: "committee",
});

export const AFC_INPUT_UNIT = Object.freeze({
  COURSE_EFFECTIVE_HOURS: "course_effective_hours",
  AFC_HOURS: "afc_hours",
});

// Tope por jornada y después tope total; el total también se limita al máximo de la actividad.
export const AFC_COURSE_RULES = Object.freeze({
  multiplier: 2,
  maxAfcHoursPerDay: 20,
  maxAfcHoursTotal: 150,
  maxEffectiveHoursPerDay: 24,
  maxDays: 60,
});

export const AFC_MAX_EVENT_HOURS = 200;
export const AFC_KEY_PATTERN = /^[a-z0-9_]{1,64}$/u;

// ---------------------------------------------------------------------------
// Aritmética racional exacta (BigInt) para evitar errores de punto flotante.
// ---------------------------------------------------------------------------

function gcd(a, b) {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y) [x, y] = [y, x % y];
  return x || 1n;
}

function rat(num, den = 1n) {
  const divisor = gcd(num, den);
  return { num: num / divisor, den: den / divisor };
}

const addRat = (a, b) => rat(a.num * b.den + b.num * a.den, a.den * b.den);
const subRat = (a, b) => rat(a.num * b.den - b.num * a.den, a.den * b.den);
const mulRat = (a, b) => rat(a.num * b.num, a.den * b.den);
const cmpRat = (a, b) => {
  const left = a.num * b.den;
  const right = b.num * a.den;
  return left === right ? 0 : left < right ? -1 : 1;
};
const minRat = (a, b) => (cmpRat(a, b) <= 0 ? a : b);
const ZERO = rat(0n);

function parseDecimalRat(value, maxDecimals = 6) {
  let text;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    text = String(value);
  } else if (typeof value === "string") {
    text = value.trim();
  } else {
    return null;
  }
  const match = /^(\d{1,9})(?:\.(\d+))?$/u.exec(text);
  if (!match) return null;
  // Los NUMERIC de PostgreSQL llegan con ceros a la derecha ("37.5000").
  const fraction = (match[2] || "").replace(/0+$/u, "");
  if (fraction.length > maxDecimals) return null;
  return rat(BigInt(match[1] + fraction), 10n ** BigInt(fraction.length));
}

function ratToDecimalString(value) {
  for (let digits = 0; digits <= 40; digits += 1) {
    const power = 10n ** BigInt(digits);
    if (power % value.den !== 0n) continue;
    const scaled = (value.num * (power / value.den)).toString().padStart(digits + 1, "0");
    if (digits === 0) return scaled;
    const integerPart = scaled.slice(0, scaled.length - digits);
    const fractionPart = scaled.slice(scaled.length - digits).replace(/0+$/u, "");
    return fractionPart ? `${integerPart}.${fractionPart}` : integerPart;
  }
  throw new Error("Valor decimal no terminante.");
}

function ceilToHalfRat(value) {
  const doubled = value.num * 2n;
  const halves = doubled % value.den === 0n ? doubled / value.den : doubled / value.den + 1n;
  return rat(halves, 2n);
}

const ratToNumber = (value) => Number(ratToDecimalString(value));

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function fail(code, message) {
  return { ok: false, code, message };
}

export function normalizeDecimalString(value, maxDecimals = 6) {
  const parsed = parseDecimalRat(value, maxDecimals);
  return parsed ? ratToDecimalString(parsed) : null;
}

// Redondeo único, hacia arriba, en incrementos de 0.5: ceil(x * 2) / 2.
export function roundUpToHalfHour(value) {
  const parsed = parseDecimalRat(value);
  return parsed ? ratToNumber(ceilToHalfRat(parsed)) : null;
}

export function calculatePercentRangeHours(min, max, percent) {
  const minRatValue = parseDecimalRat(min);
  const maxRatValue = parseDecimalRat(max);
  const percentRat = parseDecimalRat(percent, 4);
  if (!minRatValue || !maxRatValue || !percentRat) return null;
  if (cmpRat(percentRat, rat(100n)) > 0 || cmpRat(minRatValue, maxRatValue) > 0) return null;
  const raw = addRat(minRatValue, mulRat(subRat(maxRatValue, minRatValue), mulRat(percentRat, rat(1n, 100n))));
  return {
    hours_before_rounding: ratToDecimalString(raw),
    final_hours: ratToNumber(ceilToHalfRat(raw)),
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

function isValidIsoDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Devuelve las jornadas normalizadas y, si están completas, el cálculo por jornada.
export function calculateCourseDurationHours(days, maxTotal = AFC_COURSE_RULES.maxAfcHoursTotal) {
  if (!Array.isArray(days) || days.length === 0) {
    return { ok: true, complete: false, days: [] };
  }
  if (days.length > AFC_COURSE_RULES.maxDays) {
    return fail("too_many_days", `Registra como máximo ${AFC_COURSE_RULES.maxDays} jornadas.`);
  }

  const multipleDays = days.length > 1;
  const seenDates = new Set();
  const normalizedDays = [];
  let complete = true;
  let effectiveTotal = ZERO;
  let afcTotal = ZERO;
  const perDayCap = rat(BigInt(AFC_COURSE_RULES.maxAfcHoursPerDay));
  const multiplier = rat(BigInt(AFC_COURSE_RULES.multiplier));
  const maxEffective = rat(BigInt(AFC_COURSE_RULES.maxEffectiveHoursPerDay));

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    if (!day || typeof day !== "object" || Array.isArray(day)) {
      return fail("invalid_duration", `La jornada ${index + 1} no tiene un formato válido.`);
    }
    const date = isBlank(day.date) ? "" : String(day.date).trim();
    if (date && !isValidIsoDate(date)) {
      return fail("invalid_duration", `La fecha de la jornada ${index + 1} no es válida.`);
    }
    if (date) {
      if (seenDates.has(date)) {
        return fail("duplicate_day", `La jornada del ${date} está duplicada.`);
      }
      seenDates.add(date);
    } else if (multipleDays) {
      complete = false;
    }

    const rawHours = day.effective_hours;
    let hoursText = "";
    if (!isBlank(rawHours)) {
      const hours = parseDecimalRat(rawHours, 2);
      if (!hours) {
        return fail(
          "invalid_duration",
          `Las horas efectivas de la jornada ${index + 1} deben ser un número no negativo con hasta dos decimales.`,
        );
      }
      if (cmpRat(hours, maxEffective) > 0) {
        return fail(
          "invalid_duration",
          `La jornada ${index + 1} no puede superar ${AFC_COURSE_RULES.maxEffectiveHoursPerDay} horas efectivas.`,
        );
      }
      hoursText = ratToDecimalString(hours);
      effectiveTotal = addRat(effectiveTotal, hours);
      afcTotal = addRat(afcTotal, minRat(mulRat(hours, multiplier), perDayCap));
    } else {
      complete = false;
    }
    normalizedDays.push({ date, effective_hours: hoursText });
  }

  if (cmpRat(effectiveTotal, ZERO) <= 0) complete = false;
  if (!complete) return { ok: true, complete: false, days: normalizedDays };

  const totalCap = parseDecimalRat(maxTotal) ?? rat(BigInt(AFC_COURSE_RULES.maxAfcHoursTotal));
  const capped = minRat(afcTotal, minRat(totalCap, rat(BigInt(AFC_COURSE_RULES.maxAfcHoursTotal))));
  return {
    ok: true,
    complete: true,
    days: normalizedDays,
    effective_total: ratToDecimalString(effectiveTotal),
    hours_before_rounding: ratToDecimalString(capped),
    final_hours: ratToNumber(ceilToHalfRat(capped)),
  };
}

function hoursOrNull(value) {
  return isBlank(value) ? null : normalizeDecimalString(value);
}

export function isAfcManualMode(mode) {
  return mode === AFC_VALUATION_MODE.MANUAL || mode === AFC_VALUATION_MODE.COMMITTEE;
}

export function isAfcEvidenceRequired(mode) {
  return mode === AFC_VALUATION_MODE.COMMITTEE;
}

export function formatAfcRangeLabel(min, max) {
  const minText = hoursOrNull(min);
  const maxText = hoursOrNull(max);
  if (minText === null && maxText === null) return "Definido por el Comité de Carrera";
  if (minText === null) return `Hasta ${maxText} h`;
  return `${minText}–${maxText} h`;
}

function manualBounds(type) {
  if (type.valuation_mode === AFC_VALUATION_MODE.COMMITTEE) {
    return { min: null, max: String(AFC_MAX_EVENT_HOURS) };
  }
  return { min: hoursOrNull(type.min_hours), max: hoursOrNull(type.max_hours) };
}

/**
 * Calcula el valor AFC de un evento con una actividad y un supuesto del catálogo (filas de BD).
 * Nunca usa rangos, porcentajes ni resultados recibidos del cliente.
 * inputs: { course_days?, manual_hours? }
 */
export function calculateAfcHours({ type, scenario = null, inputs = {} } = {}) {
  if (!type || !type.key) return fail("invalid_type", "Selecciona un tipo de actividad válido.");
  const mode = type.valuation_mode;
  const min = hoursOrNull(type.min_hours);
  const max = hoursOrNull(type.max_hours);

  const valuation = {
    calc_version: AFC_CALC_VERSION,
    origin: type.origin,
    type_id: type.id ?? null,
    type_key: type.key,
    type_name: type.name ?? null,
    scenario_id: null,
    scenario_key: null,
    scenario_label: null,
    method: null,
    min_hours: min,
    max_hours: max,
    percent: null,
    course_days: null,
    input_value: null,
    input_unit: null,
    hours_before_rounding: null,
    final_hours: null,
    evidence_required: isAfcEvidenceRequired(mode),
    complete: true,
  };

  if (isAfcManualMode(mode)) {
    if (scenario) return fail("scenario_not_applicable", "Esta actividad no usa supuestos del tabulador.");
    const bounds = manualBounds(type);
    Object.assign(valuation, {
      method: mode === AFC_VALUATION_MODE.COMMITTEE ? AFC_METHOD.COMMITTEE : AFC_METHOD.MANUAL,
      min_hours: bounds.min,
      max_hours: mode === AFC_VALUATION_MODE.COMMITTEE ? null : bounds.max,
      input_unit: AFC_INPUT_UNIT.AFC_HOURS,
      complete: false,
    });
    if (isBlank(inputs?.manual_hours)) return { ok: true, valuation };
    const hours = parseDecimalRat(inputs.manual_hours, 2);
    if (!hours || cmpRat(hours, ZERO) <= 0) {
      return fail("invalid_manual_hours", "Las horas AFC deben ser un número mayor a 0, con hasta dos decimales.");
    }
    const rounded = ceilToHalfRat(hours);
    if ((bounds.min !== null && cmpRat(rounded, parseDecimalRat(bounds.min)) < 0) ||
        (bounds.max !== null && cmpRat(rounded, parseDecimalRat(bounds.max)) > 0)) {
      return fail("out_of_range", `Las horas AFC deben quedar en el rango ${formatAfcRangeLabel(bounds.min, bounds.max)}.`);
    }
    Object.assign(valuation, {
      input_value: ratToDecimalString(hours),
      hours_before_rounding: ratToDecimalString(hours),
      final_hours: ratToNumber(rounded),
      complete: true,
    });
    return { ok: true, valuation };
  }

  if (mode !== AFC_VALUATION_MODE.SCENARIOS) {
    return fail("invalid_rule_config", "La actividad tiene un modo de valoración no válido. Revisa el catálogo AFC.");
  }
  if (!scenario || !scenario.key) {
    return fail("invalid_scenario", "Selecciona el supuesto o actividad realizada.");
  }
  Object.assign(valuation, {
    scenario_id: scenario.id ?? null,
    scenario_key: scenario.key,
    scenario_label: scenario.label ?? null,
  });

  switch (scenario.kind) {
    case AFC_SCENARIO_KIND.PERCENT: {
      const result = min === null || max === null ? null : calculatePercentRangeHours(min, max, scenario.percent);
      if (!result) return fail("invalid_rule_config", "La regla de porcentaje del catálogo no es válida.");
      Object.assign(valuation, {
        method: AFC_METHOD.PERCENT_RANGE,
        percent: normalizeDecimalString(scenario.percent, 4),
        ...result,
      });
      return { ok: true, valuation };
    }
    case AFC_SCENARIO_KIND.FIXED_HOURS: {
      const hours = parseDecimalRat(scenario.fixed_hours);
      if (!hours || cmpRat(hours, ZERO) <= 0 ||
          (min !== null && cmpRat(hours, parseDecimalRat(min)) < 0) ||
          (max !== null && cmpRat(hours, parseDecimalRat(max)) > 0)) {
        return fail("invalid_rule_config", "Las horas fijas del supuesto quedan fuera del rango de la actividad.");
      }
      Object.assign(valuation, {
        method: AFC_METHOD.FIXED_HOURS,
        hours_before_rounding: ratToDecimalString(hours),
        final_hours: ratToNumber(ceilToHalfRat(hours)),
      });
      return { ok: true, valuation };
    }
    case AFC_SCENARIO_KIND.COURSE_DURATION: {
      const result = calculateCourseDurationHours(inputs?.course_days, max ?? AFC_COURSE_RULES.maxAfcHoursTotal);
      if (!result.ok) return result;
      Object.assign(valuation, {
        method: AFC_METHOD.COURSE_DURATION,
        course_days: result.days,
        input_unit: AFC_INPUT_UNIT.COURSE_EFFECTIVE_HOURS,
        complete: result.complete,
      });
      if (result.complete) {
        Object.assign(valuation, {
          input_value: result.effective_total,
          hours_before_rounding: result.hours_before_rounding,
          final_hours: result.final_hours,
        });
      }
      return { ok: true, valuation };
    }
    default:
      return fail("invalid_rule_config", "El supuesto tiene un tipo de cálculo no válido. Revisa el catálogo AFC.");
  }
}

// Identifica los datos que determinan el valor (selección y entradas), sin resultados.
export function afcSelectionFingerprint(valuation) {
  if (!valuation) return "";
  const days = Array.isArray(valuation.course_days)
    ? valuation.course_days.map((day) => [
        String(day?.date || ""),
        normalizeDecimalString(day?.effective_hours, 2) ?? "",
      ])
    : null;
  const manual =
    valuation.method === AFC_METHOD.MANUAL || valuation.method === AFC_METHOD.COMMITTEE
      ? normalizeDecimalString(valuation.input_value, 2) ?? ""
      : null;
  return JSON.stringify([
    valuation.origin ?? null,
    valuation.type_key ?? null,
    valuation.scenario_key ?? null,
    days,
    manual,
  ]);
}

// ---------------------------------------------------------------------------
// Validación de registros del catálogo (panel de administración).
// ---------------------------------------------------------------------------

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/[\u0000-\u001F\u007F]/gu, " ").trim().slice(0, maxLength);
}

function parseHoursField(value, label) {
  if (isBlank(value)) return { value: null };
  const parsed = parseDecimalRat(typeof value === "number" ? value : String(value).trim(), 2);
  if (!parsed) return { error: `${label} debe ser un número no negativo con hasta dos decimales.` };
  return { value: ratToDecimalString(parsed) };
}

function parseSortOrder(value) {
  if (isBlank(value)) return 0;
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 100000 ? number : null;
}

/** Normaliza una actividad del catálogo. partial=true permite omitir origin/key (edición). */
export function normalizeAfcTypeInput(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Datos de actividad inválidos." };
  const value = {};
  if (!partial) {
    const origin = cleanText(raw.origin, 32);
    if (!Object.values(AFC_ORIGIN).includes(origin)) return { error: "Selecciona un origen válido." };
    const key = cleanText(raw.key, 64);
    if (!AFC_KEY_PATTERN.test(key)) {
      return { error: "La clave solo admite minúsculas, números y guion bajo (máx. 64)." };
    }
    value.origin = origin;
    value.key = key;
  }
  const name = cleanText(raw.name, 160);
  if (!name) return { error: "El nombre de la actividad es obligatorio." };
  const mode = cleanText(raw.valuation_mode, 32);
  if (!Object.values(AFC_VALUATION_MODE).includes(mode)) return { error: "Selecciona un modo de valoración válido." };

  const min = parseHoursField(raw.min_hours, "El mínimo de horas");
  if (min.error) return { error: min.error };
  const max = parseHoursField(raw.max_hours, "El máximo de horas");
  if (max.error) return { error: max.error };

  if (mode === AFC_VALUATION_MODE.COMMITTEE) {
    min.value = null;
    max.value = null;
  } else {
    if (max.value === null || Number(max.value) <= 0) return { error: "Captura un máximo de horas mayor a 0." };
    if (Number(max.value) > AFC_MAX_EVENT_HOURS) {
      return { error: `El máximo de horas no puede superar ${AFC_MAX_EVENT_HOURS}.` };
    }
    if (min.value !== null && Number(min.value) > Number(max.value)) {
      return { error: "El mínimo de horas no puede ser mayor al máximo." };
    }
    if (mode === AFC_VALUATION_MODE.MANUAL && min.value === null) {
      return { error: "Las actividades con horas libres requieren un mínimo de horas." };
    }
  }

  const sortOrder = parseSortOrder(raw.sort_order);
  if (sortOrder === null) return { error: "El orden debe ser un entero entre 0 y 100000." };

  Object.assign(value, {
    name,
    description: cleanText(raw.description, 1000) || null,
    requirements: cleanText(raw.requirements, 1000) || null,
    min_hours: min.value,
    max_hours: max.value,
    valuation_mode: mode,
    sort_order: sortOrder,
    is_active: raw.is_active === undefined ? true : raw.is_active === true || raw.is_active === "true",
  });
  return { value };
}

/** Normaliza un supuesto del tabulador. partial=true permite omitir key (edición). */
export function normalizeAfcScenarioInput(raw, { partial = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Datos de supuesto inválidos." };
  const value = {};
  if (!partial) {
    const key = cleanText(raw.key, 64);
    if (!AFC_KEY_PATTERN.test(key)) {
      return { error: "La clave solo admite minúsculas, números y guion bajo (máx. 64)." };
    }
    value.key = key;
  }
  const label = cleanText(raw.label, 200);
  if (!label) return { error: "La descripción del supuesto es obligatoria." };
  const kind = cleanText(raw.kind, 32);
  if (!Object.values(AFC_SCENARIO_KIND).includes(kind)) return { error: "Selecciona un tipo de cálculo válido." };

  let percent = null;
  let fixedHours = null;
  if (kind === AFC_SCENARIO_KIND.PERCENT) {
    const parsed = parseDecimalRat(isBlank(raw.percent) ? "" : String(raw.percent).trim(), 4);
    if (!parsed || cmpRat(parsed, rat(100n)) > 0) return { error: "El porcentaje debe estar entre 0 y 100 (hasta 4 decimales)." };
    percent = ratToDecimalString(parsed);
  } else if (kind === AFC_SCENARIO_KIND.FIXED_HOURS) {
    const parsed = parseHoursField(raw.fixed_hours, "Las horas fijas");
    if (parsed.error) return { error: parsed.error };
    if (parsed.value === null || Number(parsed.value) <= 0) return { error: "Captura horas fijas mayores a 0." };
    fixedHours = parsed.value;
  }

  const sortOrder = parseSortOrder(raw.sort_order);
  if (sortOrder === null) return { error: "El orden debe ser un entero entre 0 y 100000." };

  Object.assign(value, {
    label,
    kind,
    percent,
    fixed_hours: fixedHours,
    sort_order: sortOrder,
    is_active: raw.is_active === undefined ? true : raw.is_active === true || raw.is_active === "true",
  });
  return { value };
}

/** Verifica que un supuesto sea calculable con el rango de su actividad. Devuelve un mensaje o null. */
export function checkScenarioFitsType(type, scenario) {
  if (type.valuation_mode !== AFC_VALUATION_MODE.SCENARIOS) {
    return "Solo las actividades con supuestos del tabulador admiten supuestos.";
  }
  const result = calculateAfcHours({
    type,
    scenario,
    inputs: { course_days: [{ date: "", effective_hours: "1" }] },
  });
  if (!result.ok) {
    if (scenario.kind === AFC_SCENARIO_KIND.PERCENT && (isBlank(type.min_hours) || isBlank(type.max_hours))) {
      return `"${scenario.label}": los porcentajes requieren que la actividad tenga mínimo y máximo.`;
    }
    return `"${scenario.label}": ${result.message}`;
  }
  return null;
}
