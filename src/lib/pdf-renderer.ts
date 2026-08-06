import puppeteer, { type Browser } from 'puppeteer';
import { logger } from './logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LandlordInfo = {
  civility: string | null; // 'M.' | 'Mme'
  firstName: string;
  lastName: string;
  addressLine: string;
  postalCode: string;
  city: string;
  email: string | null;
  iban: string | null;
  /** Either a raw base64 payload or a complete data URL. */
  signatureImageBase64: string | null;
};

export type PropertyInfo = {
  addressLine: string;
  postalCode: string;
  city: string;
};

export type TenantInfo = {
  civility: string | null;
  firstName: string;
  lastName: string;
};

export type RentAdjustment = {
  labelKey: string;
  amountCents: number;
  label?: string;
};

// ---------------------------------------------------------------------------
// Browser singleton
// ---------------------------------------------------------------------------

/**
 * Single shared Chromium instance. Spawning Chromium per request is costly
 * (~200–500 ms cold start), so we keep one browser alive for the lifetime
 * of the process and only open / close lightweight pages per render call.
 */
let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let shutdownHandlersRegistered = false;

async function getBrowser(): Promise<Browser> {
  if (browser?.connected) {
    return browser;
  }
  // Coalesce concurrent first calls so we don't spawn multiple Chromium
  // instances if N renders come in before the first launch resolves.
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        // --no-sandbox / --disable-setuid-sandbox are required when the
        // container has no user namespace (typical Docker baseline).
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      })
      .then((b) => {
        browser = b;
        b.on('disconnected', () => {
          browser = null;
          browserPromise = null;
        });
        return b;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  const handler = (signal: NodeJS.Signals) => {
    logger.info({ signal }, 'pdf-renderer: closing browser on signal');
    // Best-effort: don't await — Node will run other handlers concurrently.
    closePdfBrowser().catch((err) => {
      logger.error({ err }, 'pdf-renderer: error while closing browser');
    });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
}

/**
 * Graceful shutdown — call from the main process to close Chromium.
 * Safe to call multiple times.
 */
export async function closePdfBrowser(): Promise<void> {
  const current = browser;
  browser = null;
  browserPromise = null;
  if (current) {
    try {
      await current.close();
    } catch (err) {
      logger.warn({ err }, 'pdf-renderer: browser.close() failed');
    }
  }
}

// ---------------------------------------------------------------------------
// FR formatting helpers
// ---------------------------------------------------------------------------

const MONTHS_FR = [
  'janvier',
  'février',
  'mars',
  'avril',
  'mai',
  'juin',
  'juillet',
  'août',
  'septembre',
  'octobre',
  'novembre',
  'décembre',
] as const;

const NBSP = ' ';

/**
 * Format an amount in cents as a French euro string,
 * e.g. 85000 → "850,00 €" (with non-breaking space before €).
 *
 * Handles negative values (regularisation au crédit du locataire).
 */
export function formatEur(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const decimals = String(abs % 100).padStart(2, '0');
  // Thousands separator = non-breaking space (typographie FR).
  const wholeStr = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  return `${negative ? '-' : ''}${wholeStr},${decimals}${NBSP}€`;
}

/** ISO 'YYYY-MM-DD' → 'DD/MM/YYYY'. */
export function formatDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** 'YYYY-MM' → e.g. 'mai 2026'. */
export function formatMonth(periodMonth: string): string {
  const m = /^(\d{4})-(0[1-9]|1[012])$/.exec(periodMonth);
  if (!m) {
    throw new Error(`Invalid period month: ${periodMonth}`);
  }
  const year = m[1] as string;
  const monthIdx = Number.parseInt(m[2] as string, 10) - 1;
  const monthName = MONTHS_FR[monthIdx] as string;
  return `${monthName} ${year}`;
}

// ---------------------------------------------------------------------------
// HTML rendering helpers
// ---------------------------------------------------------------------------

/**
 * Minimal HTML escape — we hand-build templates with user-controlled strings
 * (names, addresses, labels…) so every interpolation must go through this.
 */
function esc(value: string | null | undefined): string {
  if (value == null) return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPerson(p: { civility: string | null; firstName: string; lastName: string }): string {
  const parts = [p.civility, p.firstName, p.lastName].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return esc(parts.join(' '));
}

function landlordBlock(l: LandlordInfo): string {
  return `
    <div class="party">
      <div class="party-label">Bailleur</div>
      <div class="party-name">${formatPerson(l)}</div>
      <div>${esc(l.addressLine)}</div>
      <div>${esc(l.postalCode)} ${esc(l.city)}</div>
      ${l.email ? `<div class="muted">${esc(l.email)}</div>` : ''}
    </div>
  `;
}

function tenantsBlock(tenants: TenantInfo[], property: PropertyInfo): string {
  const tenantsLabel = tenants.length > 1 ? 'Locataires' : 'Locataire';
  const tenantLines = tenants
    .map((t) => `<div class="party-name">${formatPerson(t)}</div>`)
    .join('');
  return `
    <div class="party party-right">
      <div class="party-label">${tenantsLabel}</div>
      ${tenantLines}
      <div class="property-block">
        <div class="party-label">Bien loué</div>
        <div>${esc(property.addressLine)}</div>
        <div>${esc(property.postalCode)} ${esc(property.city)}</div>
      </div>
    </div>
  `;
}

function adjustmentsRows(adjustments: RentAdjustment[]): string {
  if (adjustments.length === 0) return '';
  return adjustments
    .map((a) => {
      const label = a.label && a.label.length > 0 ? a.label : a.labelKey;
      return `
        <tr>
          <td>${esc(label)}</td>
          <td class="amount">${formatEur(a.amountCents)}</td>
        </tr>
      `;
    })
    .join('');
}

function amountsTable(d: {
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: RentAdjustment[];
  totalDueCents: number;
}): string {
  return `
    <table class="amounts">
      <thead>
        <tr>
          <th>Détail</th>
          <th class="amount">Montant</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Loyer hors charges</td>
          <td class="amount">${formatEur(d.baseRentCents)}</td>
        </tr>
        <tr>
          <td>Charges</td>
          <td class="amount">${formatEur(d.baseChargesCents)}</td>
        </tr>
        ${adjustmentsRows(d.adjustments)}
      </tbody>
      <tfoot>
        <tr>
          <td>Total</td>
          <td class="amount">${formatEur(d.totalDueCents)}</td>
        </tr>
      </tfoot>
    </table>
  `;
}

function signatureBlock(l: LandlordInfo): string {
  const name = formatPerson(l);
  if (l.signatureImageBase64) {
    const raw = l.signatureImageBase64;
    const src = raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
    return `
      <div class="signature">
        <div class="signature-label">Signature du bailleur</div>
        <img class="signature-image" src="${esc(src)}" alt="Signature" />
        <div class="signature-name">${name}</div>
      </div>
    `;
  }
  return `
    <div class="signature">
      <div class="signature-label">Signature du bailleur</div>
      <div class="signature-name">${name}</div>
    </div>
  `;
}

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen,
      Ubuntu, Cantarell, "Helvetica Neue", Arial, sans-serif;
    font-size: 11pt;
    color: #1f2937;
    line-height: 1.45;
  }
  .page { padding: 0; }
  .header {
    display: flex;
    justify-content: space-between;
    gap: 24px;
    border-bottom: 1px solid #cbd5e1;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  .party { width: 48%; }
  .party-right { text-align: right; }
  .party-label {
    text-transform: uppercase;
    font-size: 9pt;
    color: #64748b;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
  }
  .party-name { font-weight: 600; }
  .property-block { margin-top: 12px; }
  .muted { color: #64748b; font-size: 10pt; }
  .title-block {
    text-align: center;
    margin: 28px 0 20px;
  }
  .title-block h1 {
    margin: 0;
    font-size: 18pt;
    color: #0f3a64;
    letter-spacing: 0.02em;
  }
  .title-block .period {
    margin-top: 6px;
    font-size: 12pt;
    color: #334155;
  }
  table.amounts {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0 24px;
  }
  table.amounts th, table.amounts td {
    padding: 8px 10px;
    border-bottom: 1px solid #e2e8f0;
    text-align: left;
  }
  table.amounts thead th {
    font-size: 9pt;
    text-transform: uppercase;
    color: #64748b;
    letter-spacing: 0.04em;
    background: #f8fafc;
  }
  table.amounts .amount { text-align: right; font-variant-numeric: tabular-nums; }
  table.amounts tfoot td {
    font-weight: 700;
    font-size: 12pt;
    color: #0f3a64;
    border-top: 2px solid #0f3a64;
    border-bottom: none;
  }
  .mention {
    margin: 24px 0;
    padding: 12px 16px;
    background: #f1f5f9;
    border-left: 4px solid #0f3a64;
    border-radius: 2px;
  }
  .signature {
    margin-top: 36px;
    text-align: right;
  }
  .signature-label {
    font-size: 9pt;
    text-transform: uppercase;
    color: #64748b;
    letter-spacing: 0.04em;
    margin-bottom: 8px;
  }
  .signature-image { max-height: 60px; max-width: 200px; display: inline-block; }
  .signature-name { margin-top: 6px; font-weight: 600; }
  .footer {
    margin-top: 48px;
    padding-top: 12px;
    border-top: 1px solid #e2e8f0;
    font-size: 9pt;
    color: #94a3b8;
    text-align: center;
  }
  /* Document de cycle : compacté pour tenir quittance + avis sur une page. */
  .cycle .header { margin-bottom: 14px; padding-bottom: 10px; }
  .cycle .title-block { margin: 14px 0 6px; }
  .cycle .title-block h1 { font-size: 14pt; }
  .cycle .title-block .period { font-size: 10.5pt; margin-top: 2px; }
  .cycle table.amounts { margin: 8px 0 12px; }
  .cycle table.amounts th, .cycle table.amounts td { padding: 5px 10px; }
  .cycle table.amounts tfoot td { font-size: 11pt; }
  .cycle .mention { margin: 12px 0; padding: 8px 12px; }
  .cycle .signature { margin-top: 16px; }
  .cycle .footer { margin-top: 20px; padding-top: 8px; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
`;

function footerHtml(generatedAt: Date): string {
  // ISO timestamp truncated to seconds — locally readable yet stable.
  const iso = generatedAt.toISOString().replace('T', ' ').slice(0, 19);
  return `<div class="footer">Document généré le ${iso} UTC par gestion-locative</div>`;
}

function wrapDocument(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>${BASE_STYLES}</style>
</head>
<body>
  <div class="page">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Templates — document de cycle : N quittances (mois payés) + 1 avis
// d'échéance (mois à venir) avec solde antérieur, en un seul document.
// ---------------------------------------------------------------------------

export type CycleReceiptSection = {
  periodMonth: string;
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: RentAdjustment[];
  totalDueCents: number;
  /** ISO 'YYYY-MM-DD'. */
  paidAt: string;
};

export type CycleNoticeSection = {
  periodMonth: string;
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: RentAdjustment[];
  totalDueCents: number;
  /** ISO 'YYYY-MM-DD'. */
  dueDate: string;
  /** Solde antérieur (Σ des périodes échues non payées). 0 si à jour. */
  previousBalanceCents: number;
};

export type CycleDocumentData = {
  landlord: LandlordInfo;
  tenants: TenantInfo[];
  property: PropertyInfo;
  receipts: CycleReceiptSection[];
  notice: CycleNoticeSection | null;
  generatedAt: Date;
};

/** Tableau de l'avis : ajoute solde antérieur + solde débiteur cumulé si arriéré. */
function noticeAmountsTable(n: CycleNoticeSection): string {
  const hasArrears = n.previousBalanceCents > 0;
  const grandTotal = n.totalDueCents + n.previousBalanceCents;
  return `
    <table class="amounts">
      <thead>
        <tr><th>Détail</th><th class="amount">Montant</th></tr>
      </thead>
      <tbody>
        ${
          hasArrears
            ? `<tr><td>Solde antérieur</td><td class="amount">${formatEur(n.previousBalanceCents)}</td></tr>`
            : ''
        }
        <tr><td>Loyer hors charges</td><td class="amount">${formatEur(n.baseRentCents)}</td></tr>
        <tr><td>Charges</td><td class="amount">${formatEur(n.baseChargesCents)}</td></tr>
        ${adjustmentsRows(n.adjustments)}
      </tbody>
      <tfoot>
        <tr>
          <td>${hasArrears ? 'Solde débiteur' : 'Total'}</td>
          <td class="amount">${formatEur(grandTotal)}</td>
        </tr>
      </tfoot>
    </table>
  `;
}

function cycleReceiptSectionHtml(r: CycleReceiptSection, landlord: LandlordInfo): string {
  const periodLabel = formatMonth(r.periodMonth);
  const paidAtLabel = formatDate(r.paidAt);
  return `
    <section class="title-block">
      <h1>Quittance de loyer</h1>
      <div class="period">Période : ${esc(periodLabel)}</div>
    </section>

    ${amountsTable(r)}

    <section class="mention">
      Je soussigné(e) ${formatPerson(landlord)}, bailleur, déclare avoir reçu la
      somme de <strong>${formatEur(r.totalDueCents)}</strong> au titre du loyer et
      des charges de la période de ${esc(periodLabel)}, et en donne quittance au(x)
      locataire(s), sous réserve de tous mes droits.<br/>
      Pour acquit, le ${esc(paidAtLabel)}.
    </section>
  `;
}

function cycleNoticeSectionHtml(n: CycleNoticeSection): string {
  const periodLabel = formatMonth(n.periodMonth);
  const dueDateLabel = formatDate(n.dueDate);
  // Volontairement pas d'IBAN sur le document : éviter qu'un locataire le
  // récupère ici pour le réutiliser sur des factures.
  return `
    <section class="title-block">
      <h1>Avis d'échéance</h1>
      <div class="period">Période : ${esc(periodLabel)}</div>
    </section>

    ${noticeAmountsTable(n)}

    <section class="mention">
      Cet avis vous informe du montant dû au titre du loyer et des charges de la
      période de ${esc(periodLabel)}.<br/>
      <strong>À régler avant le ${esc(dueDateLabel)}</strong>.
    </section>
  `;
}

export function renderCycleDocumentHtml(data: CycleDocumentData): string {
  if (data.receipts.length === 0 && !data.notice) {
    throw new Error('pdf-renderer: cycle document requires at least one receipt or a notice');
  }
  if (!Array.isArray(data.tenants) || data.tenants.length < 1) {
    throw new Error('pdf-renderer: at least one tenant is required');
  }

  const title = data.receipts.length > 0 ? 'Quittance de loyer' : "Avis d'échéance";
  const body = `
    <div class="cycle">
      <section class="header">
        ${landlordBlock(data.landlord)}
        ${tenantsBlock(data.tenants, data.property)}
      </section>

      ${data.receipts.map((r) => cycleReceiptSectionHtml(r, data.landlord)).join('')}
      ${data.notice ? cycleNoticeSectionHtml(data.notice) : ''}

      ${signatureBlock(data.landlord)}

      ${footerHtml(data.generatedAt)}
    </div>
  `;
  return wrapDocument(title, body);
}

// ---------------------------------------------------------------------------
// PDF rendering (Buffer)
// ---------------------------------------------------------------------------

async function htmlToPdfBuffer(html: string): Promise<Buffer> {
  registerShutdownHandlers();
  const br = await getBrowser();
  const page = await br.newPage();
  try {
    // NOTE: Puppeteer 25 disallows 'networkidle0' for setContent. Our HTML is
    // fully self-contained (no external CSS / JS, signature is a data URL),
    // so 'load' is sufficient — the document and any embedded resources are
    // resolved synchronously from the inline payload.
    await page.setContent(html, { waitUntil: 'load' });
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', right: '15mm', bottom: '20mm', left: '15mm' },
    });
    // page.pdf() returns Uint8Array; normalise to a Node Buffer.
    return Buffer.from(pdf);
  } finally {
    await page.close().catch((err) => {
      logger.warn({ err }, 'pdf-renderer: page.close() failed');
    });
  }
}

export async function renderCycleDocumentPdf(data: CycleDocumentData): Promise<Buffer> {
  const start = Date.now();
  logger.info(
    { receipts: data.receipts.length, hasNotice: data.notice != null },
    'pdf-renderer: cycle document — start',
  );
  const html = renderCycleDocumentHtml(data);
  const buf = await htmlToPdfBuffer(html);
  logger.info(
    { sizeBytes: buf.byteLength, durationMs: Date.now() - start },
    'pdf-renderer: cycle document — done',
  );
  return buf;
}
