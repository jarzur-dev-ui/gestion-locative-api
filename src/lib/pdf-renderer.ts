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

export type RentReceiptData = {
  landlord: LandlordInfo;
  tenants: TenantInfo[];
  property: PropertyInfo;
  /** Format 'YYYY-MM'. */
  periodMonth: string;
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: RentAdjustment[];
  totalDueCents: number;
  /** ISO date 'YYYY-MM-DD'. */
  paidAt: string;
  generatedAt: Date;
};

export type RentNoticeData = {
  landlord: LandlordInfo;
  tenants: TenantInfo[];
  property: PropertyInfo;
  periodMonth: string;
  baseRentCents: number;
  baseChargesCents: number;
  adjustments: RentAdjustment[];
  totalDueCents: number;
  /** ISO date 'YYYY-MM-DD'. */
  dueDate: string;
  generatedAt: Date;
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
  if (browser && browser.connected) {
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
// Input validation
// ---------------------------------------------------------------------------

const PERIOD_MONTH_RE = /^\d{4}-(0[1-9]|1[012])$/;

function assertCommonShape(d: {
  tenants: TenantInfo[];
  totalDueCents: number;
  periodMonth: string;
}): void {
  if (!Array.isArray(d.tenants) || d.tenants.length < 1) {
    throw new Error('pdf-renderer: at least one tenant is required');
  }
  if (typeof d.totalDueCents !== 'number' || d.totalDueCents < 0) {
    throw new Error('pdf-renderer: totalDueCents must be >= 0');
  }
  if (!PERIOD_MONTH_RE.test(d.periodMonth)) {
    throw new Error(`pdf-renderer: periodMonth must match YYYY-MM (got: ${d.periodMonth})`);
  }
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
  const tenantLines = tenants.map((t) => `<div class="party-name">${formatPerson(t)}</div>`).join('');
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
// Templates
// ---------------------------------------------------------------------------

export function renderRentReceiptHtml(data: RentReceiptData): string {
  const periodLabel = formatMonth(data.periodMonth);
  const paidAtLabel = formatDate(data.paidAt);
  const body = `
    <section class="header">
      ${landlordBlock(data.landlord)}
      ${tenantsBlock(data.tenants, data.property)}
    </section>

    <section class="title-block">
      <h1>Quittance de loyer</h1>
      <div class="period">Période : ${esc(periodLabel)}</div>
    </section>

    ${amountsTable(data)}

    <section class="mention">
      Je soussigné(e) ${formatPerson(data.landlord)}, bailleur, déclare avoir reçu
      la somme de <strong>${formatEur(data.totalDueCents)}</strong> au titre du loyer
      et des charges de la période de ${esc(periodLabel)}, et en donne quittance au(x)
      locataire(s), sous réserve de tous mes droits.<br/>
      Pour acquit, le ${esc(paidAtLabel)}.
    </section>

    ${signatureBlock(data.landlord)}

    ${footerHtml(data.generatedAt)}
  `;
  return wrapDocument('Quittance de loyer', body);
}

export function renderRentNoticeHtml(data: RentNoticeData): string {
  const periodLabel = formatMonth(data.periodMonth);
  const dueDateLabel = formatDate(data.dueDate);
  const body = `
    <section class="header">
      ${landlordBlock(data.landlord)}
      ${tenantsBlock(data.tenants, data.property)}
    </section>

    <section class="title-block">
      <h1>Avis d'échéance</h1>
      <div class="period">Période : ${esc(periodLabel)}</div>
    </section>

    ${amountsTable(data)}

    <section class="mention">
      Cet avis vous informe du montant dû au titre du loyer et des charges de la période
      de ${esc(periodLabel)}.<br/>
      <strong>À régler avant le ${esc(dueDateLabel)}</strong>${
        data.landlord.iban ? ` — IBAN du bailleur : ${esc(data.landlord.iban)}` : ''
      }.
    </section>

    ${signatureBlock(data.landlord)}

    ${footerHtml(data.generatedAt)}
  `;
  return wrapDocument("Avis d'échéance", body);
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

export async function renderRentReceiptPdf(data: RentReceiptData): Promise<Buffer> {
  assertCommonShape(data);
  const start = Date.now();
  logger.info(
    { periodMonth: data.periodMonth, tenants: data.tenants.length },
    'pdf-renderer: rent receipt — start',
  );
  const html = renderRentReceiptHtml(data);
  const buf = await htmlToPdfBuffer(html);
  logger.info(
    { periodMonth: data.periodMonth, sizeBytes: buf.byteLength, durationMs: Date.now() - start },
    'pdf-renderer: rent receipt — done',
  );
  return buf;
}

export async function renderRentNoticePdf(data: RentNoticeData): Promise<Buffer> {
  assertCommonShape(data);
  const start = Date.now();
  logger.info(
    { periodMonth: data.periodMonth, tenants: data.tenants.length },
    'pdf-renderer: rent notice — start',
  );
  const html = renderRentNoticeHtml(data);
  const buf = await htmlToPdfBuffer(html);
  logger.info(
    { periodMonth: data.periodMonth, sizeBytes: buf.byteLength, durationMs: Date.now() - start },
    'pdf-renderer: rent notice — done',
  );
  return buf;
}
