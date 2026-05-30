import type { Adjustment } from '../../db/schema/rent-periods.js';

// ---------------------------------------------------------------------------
// Pure logic helpers — réutilisés par le scheduler M4 (génération mensuelle
// automatique des `rent_periods`). Aucun accès DB ici → 100 % testable en
// unitaire, fonctions pures, déterministes.
// ---------------------------------------------------------------------------

const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[012])$/;
const PERIOD_FIRST_DAY_RE = /^\d{4}-(0[1-9]|1[012])-01$/;

/**
 * Nombre de jours dans `month` (1..12) pour `year`. Gère février bissextile via
 * `new Date(year, month, 0)` qui retourne le dernier jour du mois précédent
 * (mois 0-indexé en JS).
 */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parsePeriodMonth(periodMonth: string): { year: number; month: number } {
  if (!PERIOD_MONTH_RE.test(periodMonth)) {
    throw new Error(`Invalid period month (expected 'YYYY-MM'): ${periodMonth}`);
  }
  // Regex valide la forme — split est sûr.
  const [y, m] = periodMonth.split('-');
  return { year: Number.parseInt(y as string, 10), month: Number.parseInt(m as string, 10) };
}

/**
 * Calcule la date d'échéance (`due_date`) pour une période donnée.
 *
 * - `periodMonth` peut être au format 'YYYY-MM' OU 'YYYY-MM-01' (les deux
 *   sont supportés pour fluidifier la conversion DB ↔ logique).
 * - `paymentDay` est borné à 1..31 côté schema, mais on clampe quand même au
 *   dernier jour du mois si > daysInMonth (cas du 31 février → 28/29).
 *
 * Exemples :
 *  - periodMonth='2026-05', paymentDay=5  → '2026-05-05'
 *  - periodMonth='2026-02', paymentDay=31 → '2026-02-28'
 *  - periodMonth='2024-02', paymentDay=31 → '2024-02-29' (bissextile)
 */
export function computeDueDate(periodMonth: string, paymentDay: number): string {
  // Normalise 'YYYY-MM-01' → 'YYYY-MM' pour la suite. On accepte le format
  // long parce que la DB stocke en `date` (donc 'YYYY-MM-DD').
  const normalized = periodMonth.length === 10 ? periodMonth.slice(0, 7) : periodMonth;
  const { year, month } = parsePeriodMonth(normalized);

  if (!Number.isInteger(paymentDay) || paymentDay < 1 || paymentDay > 31) {
    throw new Error(`Invalid payment day (expected 1..31): ${paymentDay}`);
  }

  const maxDay = daysInMonth(year, month);
  const day = Math.min(paymentDay, maxDay);

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

/**
 * Calcule le total dû d'une période = loyer + charges + somme(ajustements).
 *
 * Les ajustements peuvent être négatifs (crédit). On ne clampe pas à 0 ici :
 * c'est la responsabilité du caller (route PATCH) de refuser un total négatif
 * si nécessaire — la fonction reste pure.
 */
export function computeTotalDueCents(
  baseRentCents: number,
  baseChargesCents: number,
  adjustments: Adjustment[],
): number {
  const adjSum = adjustments.reduce((acc, a) => acc + a.amountCents, 0);
  return baseRentCents + baseChargesCents + adjSum;
}

/**
 * Retourne le mois "à générer" pour le scheduler — le mois courant (jour 1
 * inclus). Sémantique : à J0 de M, on crée la période de M pour M.
 *
 * On opère en UTC pour stabilité (le scheduler tourne potentiellement dans
 * un fuseau différent du serveur applicatif ; on évite les bugs de bordure
 * de mois sur les conteneurs en UTC vs developer machine en Europe/Paris).
 */
export function getNextPeriodMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1; // 1..12
  return `${y}-${String(m).padStart(2, '0')}`;
}

/**
 * Convertit 'YYYY-MM' → 'YYYY-MM-01'.
 *
 * Utilisé pour stocker `period_month` dans la colonne `date` (Postgres exige
 * un jour pour le type `date`). On choisit conventionnellement le 1ᵉʳ du mois
 * pour préserver l'ordre lexicographique == ordre temporel.
 */
export function periodMonthToFirstDay(periodMonth: string): string {
  if (PERIOD_FIRST_DAY_RE.test(periodMonth)) {
    // Déjà au format long → on retourne tel quel pour idempotence.
    return periodMonth;
  }
  if (!PERIOD_MONTH_RE.test(periodMonth)) {
    throw new Error(`Invalid period month (expected 'YYYY-MM' or 'YYYY-MM-01'): ${periodMonth}`);
  }
  return `${periodMonth}-01`;
}

/**
 * Inverse de `periodMonthToFirstDay` : 'YYYY-MM-DD' → 'YYYY-MM'. Utilisé pour
 * remplir la colonne `period_month` (text 'YYYY-MM') de la table `documents`
 * à partir de la `date` stockée dans `rent_periods`.
 */
export function firstDayToPeriodMonth(firstDay: string): string {
  if (!PERIOD_FIRST_DAY_RE.test(firstDay) && !/^\d{4}-(0[1-9]|1[012])-\d{2}$/.test(firstDay)) {
    throw new Error(`Invalid date (expected 'YYYY-MM-DD'): ${firstDay}`);
  }
  return firstDay.slice(0, 7);
}
