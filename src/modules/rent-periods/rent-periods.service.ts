import { and, desc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { documents } from '../../db/schema/documents.js';
import { landlordProfiles } from '../../db/schema/landlord-profiles.js';
import { leaseTenants } from '../../db/schema/lease-tenants.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import type { Adjustment, RentPeriod } from '../../db/schema/rent-periods.js';
import { rentPeriods } from '../../db/schema/rent-periods.js';
import { tenants } from '../../db/schema/tenants.js';
import {
  renderCancellationEmail,
  renderRentNoticeEmail,
  renderRentReceiptEmail,
} from '../../lib/email-templates.js';
import { logger } from '../../lib/logger.js';
import { sendEmail } from '../../lib/mailer.js';
import {
  type LandlordInfo,
  type PropertyInfo,
  type RentNoticeData,
  type RentReceiptData,
  type TenantInfo,
  formatDate,
  formatEur,
  formatMonth,
  renderRentNoticePdf,
  renderRentReceiptPdf,
} from '../../lib/pdf-renderer.js';
import { readFileBuffer, storeFile } from '../../lib/storage.js';
import { computeTotalDueCents, firstDayToPeriodMonth } from './period-generation.js';
import type {
  RentPeriodPublic,
  RentPeriodStatusKey,
  UpdateRentPeriodInput,
} from './rent-periods.schemas.js';

// URL d'accueil de l'app web — alignée avec invitations / document-shares. À
// terme : variable d'env `WEB_APP_URL`.
const WEB_APP_BASE_URL = 'https://gestion-locative.zeleph.fr';

// ---------------------------------------------------------------------------
// Mapping DB → API
// ---------------------------------------------------------------------------

type TenantSummary = {
  id: string;
  lastName: string;
  firstName: string;
  email: string;
};

/**
 * Construit la représentation publique d'une période de loyer. On convertit
 * la `date` 'YYYY-MM-DD' en 'YYYY-MM' côté API (l'UI raisonne en mois).
 */
export function toPublicRentPeriod(p: RentPeriod, tenantsList: TenantSummary[]): RentPeriodPublic {
  return {
    id: p.id,
    leaseId: p.leaseId,
    periodMonth: firstDayToPeriodMonth(p.periodMonth),
    baseRentCents: p.baseRentCents,
    baseChargesCents: p.baseChargesCents,
    adjustments: p.adjustments,
    totalDueCents: p.totalDueCents,
    dueDate: p.dueDate,
    statusKey: p.statusKey,
    noticeSentAt: p.noticeSentAt ? p.noticeSentAt.toISOString() : null,
    noticeDocumentId: p.noticeDocumentId,
    paidAt: p.paidAt ? p.paidAt.toISOString() : null,
    paidByUserId: p.paidByUserId,
    receiptDocumentId: p.receiptDocumentId,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    tenants: tenantsList,
  };
}

// ---------------------------------------------------------------------------
// ACL helpers
// ---------------------------------------------------------------------------

/**
 * Récupère une période de loyer en vérifiant que le bail associé porte sur
 * une propriété appartenant à `userId`. Renvoie 404 si la période n'existe
 * pas, 403 si l'utilisateur n'est pas propriétaire (cohérent avec
 * `leases.service.getLeaseForOwner`).
 */
async function getRentPeriodForOwner(id: string, userId: string): Promise<RentPeriod> {
  const [row] = await db
    .select({ rp: rentPeriods, ownerUserId: properties.ownerUserId })
    .from(rentPeriods)
    .innerJoin(leases, eq(leases.id, rentPeriods.leaseId))
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(eq(rentPeriods.id, id))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Période de loyer introuvable' });
  }
  if (row.ownerUserId !== userId) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
  return row.rp;
}

/**
 * Garde-fou métier : on ne génère ni avis ni quittance pour une période dont
 * le total dû est négatif (ex: gros avoir/crédit dépassant le loyer). Le
 * renderer PDF rejette `totalDueCents < 0` avec une Error générique (→ 500) ;
 * on intercepte ici en amont pour rendre un 409 explicite et actionnable.
 */
function assertNonNegativeTotal(totalDueCents: number): void {
  if (totalDueCents < 0) {
    throw new HTTPException(409, {
      message:
        'Le montant total dû est négatif (crédit supérieur au loyer) — ajustez la période avant d’émettre un avis ou une quittance',
    });
  }
}

async function loadTenantSummaries(leaseId: string): Promise<TenantSummary[]> {
  return db
    .select({
      id: tenants.id,
      lastName: tenants.lastName,
      firstName: tenants.firstName,
      email: tenants.email,
    })
    .from(leaseTenants)
    .innerJoin(tenants, eq(tenants.id, leaseTenants.tenantId))
    .where(eq(leaseTenants.leaseId, leaseId));
}

// ---------------------------------------------------------------------------
// PDF data assembly
// ---------------------------------------------------------------------------

/**
 * Charge les informations bailleur (profil + signature en base64 si
 * disponible) pour alimenter le rendu PDF.
 *
 * La signature est stockée comme fichier sur le volume (`signatureFilePath`).
 * On la charge à la demande puis on l'encode en base64 — `pdf-renderer`
 * accepte soit un payload brut, soit une data URL complète.
 */
async function loadLandlordInfo(landlordUserId: string): Promise<LandlordInfo> {
  const [profile] = await db
    .select()
    .from(landlordProfiles)
    .where(eq(landlordProfiles.userId, landlordUserId))
    .limit(1);

  if (!profile) {
    // Cas dégénéré : on a un bail mais pas de profil bailleur. On ne bloque
    // pas le PDF mais on refuse explicitement, parce qu'un avis/quittance
    // sans bailleur identifié n'a pas de valeur juridique.
    throw new HTTPException(409, {
      message:
        'Profil bailleur incomplet — renseignez-le avant d’émettre des avis ou des quittances',
    });
  }

  let signatureImageBase64: string | null = null;
  if (profile.signatureFilePath) {
    try {
      const buf = await readFileBuffer(profile.signatureFilePath);
      signatureImageBase64 = buf.toString('base64');
    } catch (err) {
      // Best-effort : si la signature est introuvable on logue et on continue
      // sans elle plutôt que de bloquer l'émission du document.
      logger.warn(
        { err, signatureFilePath: profile.signatureFilePath },
        'rent-periods: signature file not loadable, rendering PDF without signature',
      );
    }
  }

  return {
    civility: profile.civility,
    firstName: profile.firstName,
    lastName: profile.lastName,
    addressLine: profile.addressLine,
    postalCode: profile.postalCode,
    city: profile.city,
    email: profile.email,
    iban: profile.iban,
    signatureImageBase64,
  };
}

type LeaseContextForPdf = {
  landlord: LandlordInfo;
  tenants: TenantInfo[];
  property: PropertyInfo;
  /** Tenants enrichis avec email pour les envois ultérieurs. */
  tenantsWithEmail: Array<TenantInfo & { email: string }>;
};

/**
 * Assemble toutes les données nécessaires au rendu d'un avis/d'une quittance :
 * bailleur (via la propriété → owner_user_id), locataires (via lease_tenants)
 * et adresse du bien (via property). Une seule requête jointe pour la propriété
 * + owner_user_id, puis 2 requêtes additionnelles (landlord_profile, tenants).
 */
async function loadLeaseContextForPdf(leaseId: string): Promise<LeaseContextForPdf> {
  const [row] = await db
    .select({
      property: properties,
      ownerUserId: properties.ownerUserId,
    })
    .from(leases)
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(eq(leases.id, leaseId))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Bail introuvable' });
  }

  const [landlord, tenantSummaries] = await Promise.all([
    loadLandlordInfo(row.ownerUserId),
    loadTenantSummaries(leaseId),
  ]);

  if (tenantSummaries.length === 0) {
    // Le PDF renderer exige au moins un locataire. Bloque proprement avec un
    // 409 sémantique plutôt que laisser la lib jeter une erreur générique.
    throw new HTTPException(409, {
      message: 'Le bail ne comporte aucun locataire — impossible de générer le document',
    });
  }

  const tenantsForPdf: TenantInfo[] = tenantSummaries.map((t) => ({
    civility: null,
    firstName: t.firstName,
    lastName: t.lastName,
  }));

  const tenantsWithEmail = tenantSummaries.map((t) => ({
    civility: null,
    firstName: t.firstName,
    lastName: t.lastName,
    email: t.email,
  }));

  return {
    landlord,
    tenants: tenantsForPdf,
    property: {
      addressLine: row.property.addressLine,
      postalCode: row.property.postalCode,
      city: row.property.city,
    },
    tenantsWithEmail,
  };
}

function landlordDisplayName(l: LandlordInfo): string {
  const parts = [l.civility, l.firstName, l.lastName].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  return parts.join(' ');
}

function tenantDisplayName(t: TenantInfo & { email: string }): string {
  const parts = [t.firstName, t.lastName].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  // Fallback sur l'email si pour une raison quelconque les noms sont vides.
  return parts.length > 0 ? parts.join(' ') : t.email;
}

function buildPropertyAddress(p: PropertyInfo): string {
  return `${p.addressLine}, ${p.postalCode} ${p.city}`;
}

// ---------------------------------------------------------------------------
// List / Get
// ---------------------------------------------------------------------------

type ListFilters = {
  leaseId?: string;
  status?: RentPeriodStatusKey;
  periodMonth?: string; // 'YYYY-MM'
};

export async function listForOwner(
  userId: string,
  filters: ListFilters,
): Promise<RentPeriodPublic[]> {
  // Clauses additionnelles selon les filtres reçus.
  const clauses = [eq(properties.ownerUserId, userId)];
  if (filters.leaseId) {
    clauses.push(eq(rentPeriods.leaseId, filters.leaseId));
  }
  if (filters.status) {
    clauses.push(eq(rentPeriods.statusKey, filters.status));
  }
  if (filters.periodMonth) {
    // 'YYYY-MM' → 'YYYY-MM-01' (la colonne `period_month` est un `date`).
    clauses.push(eq(rentPeriods.periodMonth, `${filters.periodMonth}-01`));
  }

  const rows = await db
    .select({ rp: rentPeriods })
    .from(rentPeriods)
    .innerJoin(leases, eq(leases.id, rentPeriods.leaseId))
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(and(...clauses))
    .orderBy(desc(rentPeriods.periodMonth));

  // Charger les locataires en boucle (volume faible : typiquement < 200
  // périodes par bailleur). Si l'échelle augmente, optimiser via un IN sur
  // tous les leaseIds + map en mémoire.
  const result: RentPeriodPublic[] = [];
  for (const { rp } of rows) {
    const tenantsList = await loadTenantSummaries(rp.leaseId);
    result.push(toPublicRentPeriod(rp, tenantsList));
  }
  return result;
}

export async function getByIdForOwner(id: string, userId: string): Promise<RentPeriodPublic> {
  const period = await getRentPeriodForOwner(id, userId);
  const tenantsList = await loadTenantSummaries(period.leaseId);
  return toPublicRentPeriod(period, tenantsList);
}

// ---------------------------------------------------------------------------
// PATCH adjustments
// ---------------------------------------------------------------------------

/**
 * Met à jour les ajustements d'une période. Recalcule `totalDueCents` côté
 * service (jamais côté client) pour garantir la cohérence.
 *
 * Refusé si la période n'est plus en `draft` : une fois l'avis envoyé, les
 * montants notifiés au locataire sont figés (sinon le PDF déjà transmis ne
 * correspondrait plus aux nouveaux montants).
 */
export async function updateAdjustments(
  id: string,
  userId: string,
  input: UpdateRentPeriodInput,
): Promise<RentPeriodPublic> {
  const period = await getRentPeriodForOwner(id, userId);

  if (period.statusKey !== 'draft') {
    throw new HTTPException(409, {
      message:
        'Les ajustements ne peuvent être modifiés qu’en statut "draft" (avis non encore envoyé)',
    });
  }

  // Cast volontaire : `AdjustmentInput[]` (Zod) est shape-équivalent à
  // `Adjustment[]` (Drizzle JSONB type). On garde les deux typés séparément
  // pour découpler l'API du schéma DB (évolution indépendante possible).
  const adjustments = input.adjustments as Adjustment[];

  const totalDueCents = computeTotalDueCents(
    period.baseRentCents,
    period.baseChargesCents,
    adjustments,
  );

  const [updated] = await db
    .update(rentPeriods)
    .set({
      adjustments,
      totalDueCents,
      updatedAt: new Date(),
    })
    .where(eq(rentPeriods.id, id))
    .returning();

  if (!updated) {
    throw new HTTPException(404, { message: 'Période de loyer introuvable' });
  }

  const tenantsList = await loadTenantSummaries(updated.leaseId);
  return toPublicRentPeriod(updated, tenantsList);
}

// ---------------------------------------------------------------------------
// POST /:id/send-notice
// ---------------------------------------------------------------------------

/**
 * Émet l'avis d'échéance d'une période :
 *  1) génère le PDF via puppeteer
 *  2) stocke le fichier
 *  3) INSERT une ligne `documents` (type `rent_notice`)
 *  4) UPDATE la période → status='notice_sent', noticeSentAt, noticeDocumentId
 *
 * Les opérations 1+2 sont HORS transaction (génération PDF onéreuse, stockage
 * disque). Les opérations 3+4 sont DANS la transaction pour garantir que les
 * deux écritures DB sont cohérentes (jamais de période avec un document_id
 * pointant vers une ligne fantôme, jamais de document orphelin côté DB).
 *
 * L'envoi des emails est ENSUITE, hors transaction, best-effort : un échec
 * SMTP ne doit pas faire rollback de l'état DB (le PDF est déjà stocké et
 * référencé — l'utilisateur pourra renvoyer manuellement).
 */
export async function sendNotice(id: string, userId: string): Promise<RentPeriodPublic> {
  const period = await getRentPeriodForOwner(id, userId);

  if (period.statusKey !== 'draft') {
    throw new HTTPException(409, {
      message: 'L’avis ne peut être envoyé qu’à partir d’une période en statut "draft"',
    });
  }

  assertNonNegativeTotal(period.totalDueCents);

  const ctx = await loadLeaseContextForPdf(period.leaseId);
  const periodMonthStr = firstDayToPeriodMonth(period.periodMonth);

  const noticeData: RentNoticeData = {
    landlord: ctx.landlord,
    tenants: ctx.tenants,
    property: ctx.property,
    periodMonth: periodMonthStr,
    baseRentCents: period.baseRentCents,
    baseChargesCents: period.baseChargesCents,
    adjustments: period.adjustments.map((a) => ({
      labelKey: a.labelKey ?? a.type,
      amountCents: a.amountCents,
      label: a.label,
    })),
    totalDueCents: period.totalDueCents,
    dueDate: period.dueDate,
    generatedAt: new Date(),
  };

  // PDF generation HORS transaction (peut prendre 200–500 ms).
  const pdfBuffer = await renderRentNoticePdf(noticeData);
  const filename = `avis-echeance-${periodMonthStr}.pdf`;
  const stored = await storeFile(pdfBuffer, 'application/pdf', filename);

  let updatedPeriod: RentPeriod;
  try {
    updatedPeriod = await db.transaction(async (tx) => {
      const now = new Date();

      const [doc] = await tx
        .insert(documents)
        .values({
          leaseId: period.leaseId,
          documentTypeKey: 'rent_notice',
          periodMonth: periodMonthStr,
          filePath: stored.path,
          fileSizeBytes: stored.sizeBytes,
          mimeType: stored.mimeType,
          originalFilename: stored.originalFilename,
          statusKey: 'validated',
          validatedAt: now,
          validatedByUserId: userId,
          uploadedByUserId: userId,
          updatedAt: now,
        })
        .returning();

      if (!doc) {
        throw new Error('Échec de l’insertion du document');
      }

      const [rp] = await tx
        .update(rentPeriods)
        // Verrou optimiste sur statusKey : si une autre transaction a déjà
        // basculé la période (double-clic, race condition), on retombera
        // sur 0 ligne mise à jour → on jette et rollback.
        .set({
          statusKey: 'notice_sent',
          noticeSentAt: now,
          noticeDocumentId: doc.id,
          updatedAt: now,
        })
        .where(and(eq(rentPeriods.id, id), eq(rentPeriods.statusKey, 'draft')))
        .returning();

      if (!rp) {
        throw new HTTPException(409, {
          message: 'État de la période modifié entre-temps — réessayez',
        });
      }

      return rp;
    });
  } catch (err) {
    // Compensation best-effort : on ne supprime PAS le PDF stocké volontairement —
    // on garde le binaire pour permettre le debug post-mortem (volume non saturé
    // par un échec ponctuel, et `documents` n'a pas de ligne donc pas
    // d'orphelin DB). Mais on logue clairement pour traçabilité.
    logger.warn(
      { err, leaseId: period.leaseId, periodMonth: periodMonthStr, filePath: stored.path },
      'rent-periods: send-notice transaction failed, file kept on disk for debug',
    );
    throw err;
  }

  // Envoi des emails — best-effort, hors transaction.
  const landlordName = landlordDisplayName(ctx.landlord);
  const propertyAddress = buildPropertyAddress(ctx.property);
  const periodLabel = formatMonth(periodMonthStr);
  const totalDueLabel = formatEur(period.totalDueCents);
  const dueDateLabel = formatDate(period.dueDate);

  await Promise.all(
    ctx.tenantsWithEmail
      .filter((t) => t.email && t.email.length > 0)
      .map(async (t) => {
        const { subject, html, text } = renderRentNoticeEmail({
          recipientName: tenantDisplayName(t),
          landlordName,
          propertyAddress,
          periodLabel,
          totalDueLabel,
          dueDateLabel,
          appUrl: `${WEB_APP_BASE_URL}/rent-periods/${period.id}`,
        });
        const result = await sendEmail({
          to: t.email,
          subject,
          html,
          text,
          attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
        });
        if (!result.delivered) {
          logger.warn(
            { tenantEmail: t.email, periodId: period.id },
            'rent-periods: rent notice email not delivered',
          );
        }
      }),
  );

  const tenantsList = await loadTenantSummaries(updatedPeriod.leaseId);
  return toPublicRentPeriod(updatedPeriod, tenantsList);
}

// ---------------------------------------------------------------------------
// POST /:id/mark-paid
// ---------------------------------------------------------------------------

/**
 * Marque la période comme payée et émet la quittance :
 *  - Autorisé depuis `draft` (skip avis — cas plus rare mais légitime, ex:
 *    paiement reçu avant émission de l'avis) ou `notice_sent` (cas nominal).
 *  - Génère le PDF de quittance, INSERT le document, UPDATE la période.
 *  - Envoie la quittance par email aux locataires (PDF en pièce jointe).
 */
export async function markPaid(id: string, userId: string): Promise<RentPeriodPublic> {
  const period = await getRentPeriodForOwner(id, userId);

  if (period.statusKey === 'paid') {
    // Idempotence : pas une erreur, mais on ne re-fait rien.
    const tenantsList = await loadTenantSummaries(period.leaseId);
    return toPublicRentPeriod(period, tenantsList);
  }

  if (period.statusKey !== 'draft' && period.statusKey !== 'notice_sent') {
    throw new HTTPException(409, {
      message: `Transition invalide depuis l’état "${period.statusKey}"`,
    });
  }

  assertNonNegativeTotal(period.totalDueCents);

  const ctx = await loadLeaseContextForPdf(period.leaseId);
  const periodMonthStr = firstDayToPeriodMonth(period.periodMonth);
  const now = new Date();
  // 'YYYY-MM-DD' UTC pour la mention "Pour acquit, le …".
  const paidAtIsoDate = now.toISOString().slice(0, 10);

  const receiptData: RentReceiptData = {
    landlord: ctx.landlord,
    tenants: ctx.tenants,
    property: ctx.property,
    periodMonth: periodMonthStr,
    baseRentCents: period.baseRentCents,
    baseChargesCents: period.baseChargesCents,
    adjustments: period.adjustments.map((a) => ({
      labelKey: a.labelKey ?? a.type,
      amountCents: a.amountCents,
      label: a.label,
    })),
    totalDueCents: period.totalDueCents,
    paidAt: paidAtIsoDate,
    generatedAt: now,
  };

  const pdfBuffer = await renderRentReceiptPdf(receiptData);
  const filename = `quittance-${periodMonthStr}.pdf`;
  const stored = await storeFile(pdfBuffer, 'application/pdf', filename);

  // On capture les statuts permis pour le verrou optimiste — on n'autorise
  // pas la transition si une autre transaction a déjà basculé la ligne en
  // `paid` entre `getRentPeriodForOwner` et l'UPDATE.
  const allowedFromStatuses: RentPeriodStatusKey[] = ['draft', 'notice_sent'];

  let updatedPeriod: RentPeriod;
  try {
    updatedPeriod = await db.transaction(async (tx) => {
      const [doc] = await tx
        .insert(documents)
        .values({
          leaseId: period.leaseId,
          documentTypeKey: 'rent_receipt',
          periodMonth: periodMonthStr,
          filePath: stored.path,
          fileSizeBytes: stored.sizeBytes,
          mimeType: stored.mimeType,
          originalFilename: stored.originalFilename,
          statusKey: 'validated',
          validatedAt: now,
          validatedByUserId: userId,
          uploadedByUserId: userId,
          updatedAt: now,
        })
        .returning();

      if (!doc) {
        throw new Error('Échec de l’insertion du document');
      }

      // Drizzle ne supporte pas directement `inArray` dans un `.where`
      // composite simple ici — on reconstruit via une OR sur les deux
      // statuts attendus. Plus explicite et type-safe.
      const [rp] = await tx
        .update(rentPeriods)
        .set({
          statusKey: 'paid',
          paidAt: now,
          paidByUserId: userId,
          receiptDocumentId: doc.id,
          updatedAt: now,
        })
        .where(
          and(
            eq(rentPeriods.id, id),
            // Verrou optimiste sur les statuts permis (`draft` ou
            // `notice_sent`) — empêche le double-mark-paid via une race.
            inArray(rentPeriods.statusKey, allowedFromStatuses),
          ),
        )
        .returning();

      if (!rp) {
        throw new HTTPException(409, {
          message: 'État de la période modifié entre-temps — réessayez',
        });
      }

      return rp;
    });
  } catch (err) {
    logger.warn(
      { err, leaseId: period.leaseId, periodMonth: periodMonthStr, filePath: stored.path },
      'rent-periods: mark-paid transaction failed, file kept on disk for debug',
    );
    throw err;
  }

  // Email best-effort hors transaction.
  const landlordName = landlordDisplayName(ctx.landlord);
  const propertyAddress = buildPropertyAddress(ctx.property);
  const periodLabel = formatMonth(periodMonthStr);
  const totalPaidLabel = formatEur(period.totalDueCents);

  await Promise.all(
    ctx.tenantsWithEmail
      .filter((t) => t.email && t.email.length > 0)
      .map(async (t) => {
        const { subject, html, text } = renderRentReceiptEmail({
          recipientName: tenantDisplayName(t),
          landlordName,
          propertyAddress,
          periodLabel,
          totalPaidLabel,
          appUrl: `${WEB_APP_BASE_URL}/rent-periods/${period.id}`,
        });
        const result = await sendEmail({
          to: t.email,
          subject,
          html,
          text,
          attachments: [{ filename, content: pdfBuffer, contentType: 'application/pdf' }],
        });
        if (!result.delivered) {
          logger.warn(
            { tenantEmail: t.email, periodId: period.id },
            'rent-periods: rent receipt email not delivered',
          );
        }
      }),
  );

  const tenantsList = await loadTenantSummaries(updatedPeriod.leaseId);
  return toPublicRentPeriod(updatedPeriod, tenantsList);
}

// ---------------------------------------------------------------------------
// POST /:id/mark-unpaid
// ---------------------------------------------------------------------------

/** Fenêtre de rétractation : 24 h après le passage en `paid`. */
const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Annule un passage à `paid` dans la fenêtre 24 h :
 *  - Soft-cancel la quittance (cancelled_at, cancelled_by_user_id, reason)
 *  - Reverte le statut de la période : `notice_sent` si avis envoyé, sinon
 *    `draft`. On NE supprime PAS noticeSentAt / noticeDocumentId pour garder
 *    la traçabilité de l'avis déjà envoyé.
 *
 * Émet un email d'annulation aux locataires.
 *
 * Codes d'erreur :
 *  - 409 si statut ≠ 'paid'
 *  - 410 (Gone) si la fenêtre 24 h est dépassée
 */
export async function markUnpaid(id: string, userId: string): Promise<RentPeriodPublic> {
  const period = await getRentPeriodForOwner(id, userId);

  if (period.statusKey !== 'paid') {
    throw new HTTPException(409, {
      message: 'Seules les périodes payées peuvent être annulées',
    });
  }

  if (!period.paidAt) {
    // Cohérence : status=paid sans paidAt n'arrive pas en pratique (le set
    // est atomique), mais on garde la garde-fou.
    throw new HTTPException(409, {
      message: 'Période payée sans date de paiement — état incohérent',
    });
  }

  const elapsedMs = Date.now() - period.paidAt.getTime();
  if (elapsedMs > UNDO_WINDOW_MS) {
    throw new HTTPException(410, {
      message: 'Fenêtre d’annulation dépassée (24 h)',
    });
  }

  // Charge le contexte AVANT la transaction pour l'email post-commit.
  const ctx = await loadLeaseContextForPdf(period.leaseId);
  const periodMonthStr = firstDayToPeriodMonth(period.periodMonth);

  const updatedPeriod = await db.transaction(async (tx) => {
    const now = new Date();

    // Soft-cancel du document de quittance, si présent.
    if (period.receiptDocumentId) {
      await tx
        .update(documents)
        .set({
          cancelledAt: now,
          cancelledByUserId: userId,
          cancellationReason: 'Annulation paiement (undo bailleur)',
          updatedAt: now,
        })
        .where(eq(documents.id, period.receiptDocumentId));
    }

    // Revert du statut : on retourne sur `notice_sent` si l'avis avait été
    // envoyé, sinon sur `draft`.
    const previousStatus: RentPeriodStatusKey = period.noticeSentAt ? 'notice_sent' : 'draft';

    // Verrou optimiste : on n'autorise l'undo que si la ligne est toujours
    // en `paid` (sinon un autre acteur a déjà bougé la machine d'état).
    const [rp] = await tx
      .update(rentPeriods)
      .set({
        statusKey: previousStatus,
        paidAt: null,
        paidByUserId: null,
        receiptDocumentId: null,
        updatedAt: now,
      })
      .where(and(eq(rentPeriods.id, id), eq(rentPeriods.statusKey, 'paid')))
      .returning();

    if (!rp) {
      throw new HTTPException(409, {
        message: 'État de la période modifié entre-temps — réessayez',
      });
    }

    return rp;
  });

  // Email d'annulation — best-effort.
  const landlordName = landlordDisplayName(ctx.landlord);
  const propertyAddress = buildPropertyAddress(ctx.property);
  const periodLabel = formatMonth(periodMonthStr);

  await Promise.all(
    ctx.tenantsWithEmail
      .filter((t) => t.email && t.email.length > 0)
      .map(async (t) => {
        const { subject, html, text } = renderCancellationEmail({
          recipientName: tenantDisplayName(t),
          landlordName,
          propertyAddress,
          periodLabel,
          reason: 'Annulation du paiement par le bailleur',
        });
        const result = await sendEmail({ to: t.email, subject, html, text });
        if (!result.delivered) {
          logger.warn(
            { tenantEmail: t.email, periodId: period.id },
            'rent-periods: cancellation email not delivered',
          );
        }
      }),
  );

  const tenantsList = await loadTenantSummaries(updatedPeriod.leaseId);
  return toPublicRentPeriod(updatedPeriod, tenantsList);
}
