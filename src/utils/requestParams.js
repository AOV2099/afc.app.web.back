// Entero positivo de query string; valores no numéricos, fraccionarios o negativos usan el valor por defecto.
export function parsePositiveIntParam(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, max);
}

export const MAX_PAGE = 10_000;

// Escapa comodines de LIKE/ILIKE para buscar el texto literal (backslash es el escape por defecto en PostgreSQL).
export function escapeLikePattern(value) {
  return String(value).replace(/[\\%_]/gu, (char) => `\\${char}`);
}
