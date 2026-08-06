import { describe, expect, it } from 'vitest';
import { type CyclePeriodInput, planLeaseCycle } from './cycle-planning.js';

// Cadence de référence : leadDays=3, on est le 30/08 → coupure d'avis au 02/09.
const NOW = new Date('2026-08-30T08:00:00Z');
const LEAD = 3;

function period(over: Partial<CyclePeriodInput> & { id: string }): CyclePeriodInput {
  return {
    dueDate: '2026-09-01',
    statusKey: 'draft',
    totalDueCents: 90000,
    receiptDeliveredAt: null,
    ...over,
  };
}

describe('planLeaseCycle', () => {
  it('cas normal : quittance du mois payé + avis du mois à venir', () => {
    const plan = planLeaseCycle(
      [
        period({ id: 'aout', dueDate: '2026-08-01', statusKey: 'paid' }),
        period({ id: 'sept', dueDate: '2026-09-01', statusKey: 'draft' }),
      ],
      NOW,
      LEAD,
    );
    expect(plan.receiptPeriodIds).toEqual(['aout']);
    expect(plan.noticePeriodId).toBe('sept');
    expect(plan.previousBalanceCents).toBe(0);
  });

  it('impayé : pas de quittance, l’échu non payé passe en solde antérieur', () => {
    const plan = planLeaseCycle(
      [
        period({
          id: 'aout',
          dueDate: '2026-08-01',
          statusKey: 'notice_sent',
          totalDueCents: 88000,
        }),
        period({ id: 'sept', dueDate: '2026-09-01', statusKey: 'draft' }),
      ],
      NOW,
      LEAD,
    );
    expect(plan.receiptPeriodIds).toEqual([]);
    expect(plan.noticePeriodId).toBe('sept');
    expect(plan.previousBalanceCents).toBe(88000);
  });

  it('rattrapage : plusieurs quittances non délivrées, ordonnées par échéance', () => {
    const plan = planLeaseCycle(
      [
        period({ id: 'sept', dueDate: '2026-09-01', statusKey: 'draft' }),
        period({ id: 'aout', dueDate: '2026-08-01', statusKey: 'paid' }),
        period({ id: 'juillet', dueDate: '2026-07-01', statusKey: 'paid' }),
      ],
      NOW,
      LEAD,
    );
    expect(plan.receiptPeriodIds).toEqual(['juillet', 'aout']);
    expect(plan.noticePeriodId).toBe('sept');
  });

  it('exclut une quittance déjà délivrée', () => {
    const plan = planLeaseCycle(
      [
        period({
          id: 'aout',
          dueDate: '2026-08-01',
          statusKey: 'paid',
          receiptDeliveredAt: new Date('2026-08-02T10:00:00Z'),
        }),
        period({ id: 'sept', dueDate: '2026-09-01', statusKey: 'draft' }),
      ],
      NOW,
      LEAD,
    );
    expect(plan.receiptPeriodIds).toEqual([]);
    expect(plan.noticePeriodId).toBe('sept');
  });

  it('aucun avis si la prochaine échéance dépasse la coupure', () => {
    const plan = planLeaseCycle(
      [period({ id: 'oct', dueDate: '2026-10-01', statusKey: 'draft' })],
      NOW,
      LEAD,
    );
    expect(plan.noticePeriodId).toBeNull();
  });
});
