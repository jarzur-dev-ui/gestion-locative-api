/**
 * Smoke test for the PDF renderer.
 *
 * Renders a sample quittance to /tmp/test-quittance.pdf and reports
 * success + size in bytes. Run with: `pnpm tsx scripts/test-pdf-render.ts`.
 *
 * Intentionally NOT wired into package.json scripts — this is a manual smoke.
 */
import { writeFile } from 'node:fs/promises';
import {
  closePdfBrowser,
  renderRentNoticePdf,
  renderRentReceiptPdf,
  type RentNoticeData,
  type RentReceiptData,
} from '../src/lib/pdf-renderer.js';

const sampleReceipt: RentReceiptData = {
  landlord: {
    civility: 'M.',
    firstName: 'Jean',
    lastName: 'Dupont',
    addressLine: '12 rue de la Paix',
    postalCode: '75002',
    city: 'Paris',
    email: 'jean.dupont@example.com',
    iban: 'FR76 3000 4000 0312 3456 7890 143',
    signatureImageBase64: null,
  },
  tenants: [
    { civility: 'Mme', firstName: 'Alice', lastName: 'Martin' },
    { civility: 'M.', firstName: 'Bob', lastName: 'Martin' },
  ],
  property: {
    addressLine: '5 avenue Victor Hugo',
    postalCode: '75116',
    city: 'Paris',
  },
  periodMonth: '2026-05',
  baseRentCents: 85000,
  baseChargesCents: 12000,
  adjustments: [
    { labelKey: 'rent_indexation', label: 'Indexation IRL', amountCents: 1500 },
    { labelKey: 'charges_regularization', label: 'Régularisation charges', amountCents: -3500 },
  ],
  totalDueCents: 95000,
  paidAt: '2026-05-05',
  generatedAt: new Date(),
};

// Note: `paidAt` from sampleReceipt is dropped — RentNoticeData uses `dueDate` instead.
const { paidAt: _paidAt, ...receiptCommon } = sampleReceipt;
void _paidAt;
const sampleNotice: RentNoticeData = {
  ...receiptCommon,
  dueDate: '2026-06-05',
};

async function main(): Promise<void> {
  try {
    const receiptBuf = await renderRentReceiptPdf(sampleReceipt);
    const receiptPath = '/tmp/test-quittance.pdf';
    await writeFile(receiptPath, receiptBuf);
    console.log(`OK  Quittance : ${receiptPath} (${receiptBuf.byteLength} bytes)`);

    const noticeBuf = await renderRentNoticePdf(sampleNotice);
    const noticePath = '/tmp/test-avis-echeance.pdf';
    await writeFile(noticePath, noticeBuf);
    console.log(`OK  Avis      : ${noticePath} (${noticeBuf.byteLength} bytes)`);
  } catch (err) {
    console.error('FAIL', err);
    process.exitCode = 1;
  } finally {
    await closePdfBrowser();
  }
}

await main();
