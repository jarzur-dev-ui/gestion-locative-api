import { noticeCutoffDate } from './period-generation.js';

// ---------------------------------------------------------------------------
// Composition du document de cycle (logique pure, testable sans DB).
//
// Un cycle = un document unique par bail, envoyé ~`leadDays` jours avant la
// prochaine échéance, qui combine :
//  - les quittances des périodes payées mais pas encore délivrées,
//  - l'avis d'échéance de la période à venir,
//  - le solde antérieur (Σ des périodes échues non payées).
// ---------------------------------------------------------------------------

export type CyclePeriodInput = {
  id: string;
  /** 'YYYY-MM-DD'. */
  dueDate: string;
  statusKey: 'draft' | 'notice_sent' | 'paid';
  totalDueCents: number;
  /** Date de délivrance de la quittance au locataire, ou null si non délivrée. */
  receiptDeliveredAt: Date | null;
};

export type LeaseCyclePlan = {
  /** Périodes payées non délivrées → quittances à inclure, par échéance croissante. */
  receiptPeriodIds: string[];
  /** Période draft échéant sous la coupure → avis à envoyer, sinon null. */
  noticePeriodId: string | null;
  /** Σ des périodes échues non payées (hors période notifiée) — solde antérieur. */
  previousBalanceCents: number;
};

export function planLeaseCycle(
  periods: CyclePeriodInput[],
  now: Date,
  leadDays: number,
): LeaseCyclePlan {
  const cutoff = noticeCutoffDate(now, leadDays);
  const today = now.toISOString().slice(0, 10);

  const receiptPeriodIds = periods
    .filter((p) => p.statusKey === 'paid' && p.receiptDeliveredAt === null)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .map((p) => p.id);

  // La plus proche période draft dont l'échéance tombe sous la coupure.
  const noticePeriodId =
    periods
      .filter((p) => p.statusKey === 'draft' && p.dueDate <= cutoff)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0]?.id ?? null;

  const previousBalanceCents = periods
    .filter((p) => p.statusKey !== 'paid' && p.dueDate < today && p.id !== noticePeriodId)
    .reduce((sum, p) => sum + p.totalDueCents, 0);

  return { receiptPeriodIds, noticePeriodId, previousBalanceCents };
}
