import { describe, expect, it } from 'vitest';
import { type CycleDocumentData, renderCycleDocumentHtml } from './pdf-renderer.js';

const landlord = {
  civility: 'M.',
  firstName: 'Jean',
  lastName: 'Bailleur',
  addressLine: '1 rue A',
  postalCode: '75001',
  city: 'Paris',
  email: null,
  iban: null,
  signatureImageBase64: null,
};
const tenants = [{ civility: null, firstName: 'Alice', lastName: 'Loc' }];
const property = { addressLine: '2 rue B', postalCode: '75002', city: 'Paris' };
const base = { landlord, tenants, property, generatedAt: new Date('2026-08-30T08:00:00Z') };

function receipt(over: Record<string, unknown> = {}) {
  return {
    periodMonth: '2026-08',
    baseRentCents: 85000,
    baseChargesCents: 5000,
    adjustments: [],
    totalDueCents: 90000,
    paidAt: '2026-08-01',
    ...over,
  };
}
function notice(over: Record<string, unknown> = {}) {
  return {
    periodMonth: '2026-09',
    baseRentCents: 85000,
    baseChargesCents: 5000,
    adjustments: [],
    totalDueCents: 90000,
    dueDate: '2026-09-01',
    previousBalanceCents: 0,
    ...over,
  };
}

describe('renderCycleDocumentHtml', () => {
  it('cas normal : une quittance du mois payé + un avis du mois à venir', () => {
    const html = renderCycleDocumentHtml({
      ...base,
      receipts: [receipt()],
      notice: notice(),
    } as CycleDocumentData);
    expect(html).toContain('Quittance');
    expect(html).toContain('août 2026');
    expect(html).toContain("Avis d'échéance");
    expect(html).toContain('septembre 2026');
    expect(html).not.toContain('Solde antérieur');
  });

  it('avis avec solde antérieur → solde débiteur cumulé', () => {
    const html = renderCycleDocumentHtml({
      ...base,
      receipts: [],
      notice: notice({ previousBalanceCents: 88000 }),
    } as CycleDocumentData);
    expect(html).toContain('Solde antérieur');
    expect(html).toContain('Solde débiteur');
    // 90000 + 88000 = 178000 → "1 780,00 €" (séparateur = espace insécable → on
    // vérifie le segment sans ambiguïté).
    expect(html).toContain('780,00');
  });

  it('rattrapage : deux quittances non délivrées', () => {
    const html = renderCycleDocumentHtml({
      ...base,
      receipts: [receipt({ periodMonth: '2026-07', paidAt: '2026-07-01' }), receipt()],
      notice: notice(),
    } as CycleDocumentData);
    expect(html).toContain('juillet 2026');
    expect(html).toContain('août 2026');
  });

  it('à la demande : quittance seule, sans avis', () => {
    const html = renderCycleDocumentHtml({
      ...base,
      receipts: [receipt()],
      notice: null,
    } as CycleDocumentData);
    expect(html).toContain('Quittance');
    expect(html).not.toContain("Avis d'échéance");
  });

  it('n’affiche jamais l’IBAN du bailleur, même s’il est renseigné', () => {
    const withIban = { ...landlord, iban: 'FR76 3000 4000 0312 3456 7890 143' };
    const html = renderCycleDocumentHtml({
      ...base,
      landlord: withIban,
      receipts: [receipt()],
      notice: notice(),
    } as CycleDocumentData);
    expect(html).not.toContain('IBAN');
    expect(html).not.toContain('3000 4000');
  });
});
