/**
 * Smoke test for the PDF renderer.
 *
 * Renders sample cycle documents to /tmp and reports success + size in bytes.
 * Run with: `pnpm tsx scripts/test-pdf-render.ts`.
 *
 * Intentionally NOT wired into package.json scripts — this is a manual smoke.
 */
import { writeFile } from 'node:fs/promises';
import {
  type CycleDocumentData,
  closePdfBrowser,
  renderCycleDocumentPdf,
} from '../src/lib/pdf-renderer.js';

const landlord = {
  civility: 'M.',
  firstName: 'Jean',
  lastName: 'Dupont',
  addressLine: '12 rue de la Paix',
  postalCode: '75002',
  city: 'Paris',
  email: 'jean.dupont@example.com',
  iban: 'FR76 3000 4000 0312 3456 7890 143',
  signatureImageBase64: null,
};

const tenants = [
  { civility: 'Mme', firstName: 'Alice', lastName: 'Martin' },
  { civility: 'M.', firstName: 'Bob', lastName: 'Martin' },
];

const property = {
  addressLine: '5 avenue Victor Hugo',
  postalCode: '75116',
  city: 'Paris',
};

// Document de cycle façon agence : quittance du mois payé + avis du mois à venir.
const sampleCycle: CycleDocumentData = {
  landlord,
  tenants,
  property,
  receipts: [
    {
      periodMonth: '2026-08',
      baseRentCents: 85000,
      baseChargesCents: 12000,
      adjustments: [],
      totalDueCents: 97000,
      paidAt: '2026-08-01',
    },
  ],
  notice: {
    periodMonth: '2026-09',
    baseRentCents: 85000,
    baseChargesCents: 12000,
    adjustments: [],
    totalDueCents: 97000,
    dueDate: '2026-09-01',
    previousBalanceCents: 0,
  },
  generatedAt: new Date(),
};

// Variante impayé : pas de quittance, l'échu passe en solde antérieur.
const sampleCycleArrears: CycleDocumentData = {
  ...sampleCycle,
  receipts: [],
  notice: {
    ...(sampleCycle.notice as NonNullable<CycleDocumentData['notice']>),
    previousBalanceCents: 97000,
  },
};

async function main(): Promise<void> {
  try {
    const cycleBuf = await renderCycleDocumentPdf(sampleCycle);
    const cyclePath = '/tmp/test-cycle.pdf';
    await writeFile(cyclePath, cycleBuf);
    console.log(`OK  Cycle     : ${cyclePath} (${cycleBuf.byteLength} bytes)`);

    const cycleArrearsBuf = await renderCycleDocumentPdf(sampleCycleArrears);
    const cycleArrearsPath = '/tmp/test-cycle-arrears.pdf';
    await writeFile(cycleArrearsPath, cycleArrearsBuf);
    console.log(`OK  Cycle+solde: ${cycleArrearsPath} (${cycleArrearsBuf.byteLength} bytes)`);
  } catch (err) {
    console.error('FAIL', err);
    process.exitCode = 1;
  } finally {
    await closePdfBrowser();
  }
}

await main();
