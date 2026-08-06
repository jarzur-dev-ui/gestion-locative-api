import { describe, expect, it } from 'vitest';
import type { CycleLeaseContext, CyclePeriodRow } from './cycle-document.js';
import { assembleCycleDocument } from './cycle-document.js';
import type { LeaseCyclePlan } from './cycle-planning.js';

const CTX: CycleLeaseContext = {
  landlord: {
    civility: 'M.',
    firstName: 'Jean',
    lastName: 'Dupont',
    addressLine: '1 rue de la Paix',
    postalCode: '75002',
    city: 'Paris',
    email: 'jean.dupont@example.com',
    iban: 'FR7630006000011234567890189',
    signatureImageBase64: null,
  },
  tenants: [{ civility: 'Mme', firstName: 'Alice', lastName: 'Martin' }],
  property: {
    addressLine: '10 rue des Fleurs',
    postalCode: '69001',
    city: 'Lyon',
  },
};

function period(over: Partial<CyclePeriodRow> & { id: string }): CyclePeriodRow {
  return {
    periodMonth: '2026-08-01',
    baseRentCents: 80000,
    baseChargesCents: 10000,
    adjustments: [],
    totalDueCents: 90000,
    dueDate: '2026-08-05',
    paidAt: null,
    ...over,
  };
}

const GENERATED_AT = new Date('2026-08-30T08:00:00Z');

describe('assembleCycleDocument', () => {
  it('cas normal : quittance payée + avis de la période à venir', () => {
    const periods: CyclePeriodRow[] = [
      period({
        id: 'aout',
        periodMonth: '2026-08-01',
        paidAt: new Date('2026-08-06T12:00:00Z'),
      }),
      period({
        id: 'sept',
        periodMonth: '2026-09-01',
        dueDate: '2026-09-05',
      }),
    ];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['aout'],
      noticePeriodId: 'sept',
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.receipts).toHaveLength(1);
    expect(doc.receipts[0]?.periodMonth).toBe('2026-08');
    expect(doc.receipts[0]?.paidAt).toBe('2026-08-06');
    expect(doc.notice).not.toBeNull();
    expect(doc.notice?.periodMonth).toBe('2026-09');
    expect(doc.notice?.dueDate).toBe('2026-09-05');
    expect(doc.notice?.previousBalanceCents).toBe(0);
    expect(doc.landlord).toBe(CTX.landlord);
    expect(doc.tenants).toBe(CTX.tenants);
    expect(doc.property).toBe(CTX.property);
    expect(doc.generatedAt).toBe(GENERATED_AT);
  });

  it('noticePeriodId null → notice vaut null', () => {
    const periods: CyclePeriodRow[] = [
      period({ id: 'aout', paidAt: new Date('2026-08-06T12:00:00Z') }),
    ];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['aout'],
      noticePeriodId: null,
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.notice).toBeNull();
  });

  it('rattrapage : respecte l’ordre du plan dans les quittances', () => {
    const periods: CyclePeriodRow[] = [
      period({ id: 'sept', periodMonth: '2026-09-01', paidAt: new Date('2026-09-06T12:00:00Z') }),
      period({
        id: 'juillet',
        periodMonth: '2026-07-01',
        paidAt: new Date('2026-07-06T12:00:00Z'),
      }),
      period({ id: 'aout', periodMonth: '2026-08-01', paidAt: new Date('2026-08-06T12:00:00Z') }),
    ];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['juillet', 'aout', 'sept'],
      noticePeriodId: null,
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.receipts.map((r) => r.periodMonth)).toEqual(['2026-07', '2026-08', '2026-09']);
  });

  it('ignore un id de quittance absent des périodes fournies', () => {
    const periods: CyclePeriodRow[] = [
      period({ id: 'aout', paidAt: new Date('2026-08-06T12:00:00Z') }),
    ];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['aout', 'inconnu'],
      noticePeriodId: null,
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.receipts).toHaveLength(1);
    expect(doc.receipts[0]?.periodMonth).toBe('2026-08');
  });

  it('mapping ajustements : labelKey absent retombe sur type', () => {
    const periods: CyclePeriodRow[] = [
      period({
        id: 'aout',
        paidAt: new Date('2026-08-06T12:00:00Z'),
        adjustments: [
          { type: 'late_fee', amountCents: 500 },
          { type: 'repair', labelKey: 'repair.custom', label: 'Réparation', amountCents: 1200 },
        ],
      }),
    ];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['aout'],
      noticePeriodId: null,
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.receipts[0]?.adjustments).toEqual([
      { labelKey: 'late_fee', amountCents: 500, label: undefined },
      { labelKey: 'repair.custom', amountCents: 1200, label: 'Réparation' },
    ]);
  });

  it('previousBalanceCents du plan est reporté sur la notice', () => {
    const periods: CyclePeriodRow[] = [period({ id: 'sept', dueDate: '2026-09-05' })];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: [],
      noticePeriodId: 'sept',
      previousBalanceCents: 45000,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.notice?.previousBalanceCents).toBe(45000);
  });

  it('paidAt absent (null) retombe sur generatedAt', () => {
    const periods: CyclePeriodRow[] = [period({ id: 'aout', paidAt: null })];
    const plan: LeaseCyclePlan = {
      receiptPeriodIds: ['aout'],
      noticePeriodId: null,
      previousBalanceCents: 0,
    };

    const doc = assembleCycleDocument(CTX, periods, plan, GENERATED_AT);

    expect(doc.receipts[0]?.paidAt).toBe('2026-08-30');
  });
});
