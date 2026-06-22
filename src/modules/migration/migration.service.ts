import { and, eq } from 'drizzle-orm';

import { db } from '../../db/client.js';
import { guarantors } from '../../db/schema/guarantors.js';
import { landlordProfiles } from '../../db/schema/landlord-profiles.js';
import { leaseGuarantors } from '../../db/schema/lease-guarantors.js';
import { leaseTenants } from '../../db/schema/lease-tenants.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import { tenants } from '../../db/schema/tenants.js';
import { logger } from '../../lib/logger.js';

import type { ImportRequest, LegacyBail, LegacyBailleur } from './migration.schemas.js';

type ImportReport = {
  profile: { created: boolean; updated: boolean };
  properties: { created: number; skipped: number };
  tenants: { created: number; skipped: number };
  guarantors: { created: number; skipped: number };
  leases: { created: number; skipped: number };
  warnings: string[];
};

/**
 * Sépare "75011 Paris" en { postalCode: '75011', city: 'Paris' }.
 * Default propre si format inattendu.
 */
function splitCpVille(input: string | undefined): { postalCode: string; city: string } {
  if (!input) return { postalCode: '', city: '' };
  const trimmed = input.trim();
  const match = trimmed.match(/^(\d{5})\s+(.+)$/);
  if (match?.[1] && match[2]) return { postalCode: match[1], city: match[2].trim() };
  return { postalCode: '', city: trimmed };
}

/**
 * Sépare "Jean Dupont" en { firstName, lastName } via heuristique espace simple.
 */
function splitName(fullName: string | undefined): { firstName: string; lastName: string } {
  if (!fullName) return { firstName: '', lastName: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1 && parts[0]) return { firstName: '', lastName: parts[0] };
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

function legacyCivility(input: string | undefined): string | null {
  if (!input) return null;
  if (/madame/i.test(input)) return 'Mme';
  if (/monsieur|m\./i.test(input)) return 'M.';
  return null;
}

function legacyPropertyTypeKey(input: string | undefined): string {
  if (!input) return 'apartment';
  if (input === 'parking') return 'parking';
  return 'apartment';
}

function legacyChargesTypeKey(input: string | undefined): 'package' | 'real' {
  if (input && /réel|reel/i.test(input)) return 'real';
  return 'package';
}

function legacyDpeGrade(input: string | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  if (/^[A-G]$/.test(upper)) return upper;
  return null;
}

export async function importLegacy(
  landlordUserId: string,
  request: ImportRequest,
): Promise<ImportReport> {
  const report: ImportReport = {
    profile: { created: false, updated: false },
    properties: { created: 0, skipped: 0 },
    tenants: { created: 0, skipped: 0 },
    guarantors: { created: 0, skipped: 0 },
    leases: { created: 0, skipped: 0 },
    warnings: [],
  };

  // ─── 1. Upsert landlord_profile ────────────────────────────────────────────
  await upsertLandlordProfile(landlordUserId, request.bailleur, report);

  // ─── 2. Pour chaque legacy bail, créer property + tenant + lease ──────────
  for (const bail of request.baux) {
    await importOneBail(landlordUserId, bail, report);
  }

  logger.info({ report }, 'migration.import — done');
  return report;
}

async function upsertLandlordProfile(
  userId: string,
  legacy: LegacyBailleur,
  report: ImportReport,
): Promise<void> {
  const { firstName, lastName } = splitName(legacy.nom);
  const { postalCode, city } = splitCpVille(legacy.cpVille);

  const existing = await db
    .select()
    .from(landlordProfiles)
    .where(eq(landlordProfiles.userId, userId))
    .limit(1);

  const payload = {
    userId,
    firstName,
    lastName,
    addressLine: legacy.adresse ?? '',
    postalCode,
    city,
    email: legacy.email ?? null,
  };

  if (existing.length === 0) {
    await db.insert(landlordProfiles).values(payload);
    report.profile.created = true;
  } else {
    await db
      .update(landlordProfiles)
      .set({ ...payload, updatedAt: new Date() })
      .where(eq(landlordProfiles.userId, userId));
    report.profile.updated = true;
  }
}

async function importOneBail(
  landlordUserId: string,
  bail: LegacyBail,
  report: ImportReport,
): Promise<void> {
  // ─── 2.1 Property ──────────────────────────────────────────────────────────
  const { postalCode, city } = splitCpVille(bail.cpVille);
  const addressLine = bail.rue ?? '';

  if (!addressLine || !postalCode) {
    report.warnings.push(`Bail "${bail.id ?? 'sans id'}" ignoré : adresse incomplète.`);
    return;
  }

  // Idempotence : on cherche une property existante avec la même adresse pour ce landlord
  const existingProp = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.ownerUserId, landlordUserId),
        eq(properties.addressLine, addressLine),
        eq(properties.postalCode, postalCode),
        eq(properties.city, city),
      ),
    )
    .limit(1);

  let propertyId: string;
  if (existingProp.length > 0 && existingProp[0]) {
    propertyId = existingProp[0].id;
    report.properties.skipped += 1;
  } else {
    const surface = bail.surface ? Number(bail.surface) : null;
    const rooms = bail.nbPieces ? Number(bail.nbPieces) : null;
    const builtYear = bail.periodeConstruction ? Number(bail.periodeConstruction) : null;
    const [created] = await db
      .insert(properties)
      .values({
        ownerUserId: landlordUserId,
        addressLine,
        postalCode,
        city,
        propertyTypeKey: legacyPropertyTypeKey(bail.type),
        surfaceM2: surface && !Number.isNaN(surface) ? String(surface) : null,
        roomCount: rooms && !Number.isNaN(rooms) ? rooms : null,
        builtYear: builtYear && !Number.isNaN(builtYear) ? builtYear : null,
        dpeGrade: legacyDpeGrade(bail.dpe),
        furnished: false,
      })
      .returning({ id: properties.id });
    if (!created) {
      report.warnings.push(`Impossible de créer property pour "${addressLine}".`);
      return;
    }
    propertyId = created.id;
    report.properties.created += 1;
  }

  // ─── 2.2 Tenant ────────────────────────────────────────────────────────────
  const { firstName, lastName } = splitName(bail.locataire);
  if (!firstName && !lastName) {
    report.warnings.push(`Bail "${bail.id}" : locataire sans nom, bail ignoré.`);
    return;
  }
  const tenantEmail =
    bail.locataireEmail ??
    `${`${firstName}.${lastName}`.toLowerCase().replace(/\s+/g, '')}@import.local`;

  // Idempotence par email (par créateur)
  const existingTenant = await db
    .select()
    .from(tenants)
    .where(and(eq(tenants.createdByUserId, landlordUserId), eq(tenants.email, tenantEmail)))
    .limit(1);

  let tenantId: string;
  if (existingTenant.length > 0 && existingTenant[0]) {
    tenantId = existingTenant[0].id;
    report.tenants.skipped += 1;
  } else {
    const [created] = await db
      .insert(tenants)
      .values({
        createdByUserId: landlordUserId,
        civility: legacyCivility(bail.civilite),
        firstName,
        lastName,
        email: tenantEmail,
      })
      .returning({ id: tenants.id });
    if (!created) {
      report.warnings.push(`Impossible de créer tenant ${firstName} ${lastName}.`);
      return;
    }
    tenantId = created.id;
    report.tenants.created += 1;
  }

  // ─── 2.3 Guarantor (optionnel) ────────────────────────────────────────────
  let guarantorId: string | null = null;
  if (bail.garant && bail.garant.trim() !== '') {
    const { firstName: gFirst, lastName: gLast } = splitName(bail.garant);
    const guarantorMarkerEmail = `garant-${`${gFirst}.${gLast}`.toLowerCase().replace(/\s+/g, '')}@import.local`;
    const existingG = await db
      .select()
      .from(guarantors)
      .where(
        and(
          eq(guarantors.createdByUserId, landlordUserId),
          eq(guarantors.email, guarantorMarkerEmail),
        ),
      )
      .limit(1);
    if (existingG.length > 0 && existingG[0]) {
      guarantorId = existingG[0].id;
      report.guarantors.skipped += 1;
    } else {
      const [created] = await db
        .insert(guarantors)
        .values({
          createdByUserId: landlordUserId,
          guarantorTypeKey: 'person',
          firstName: gFirst || 'Garant',
          lastName: gLast || 'Importé',
          email: guarantorMarkerEmail,
        })
        .returning({ id: guarantors.id });
      if (created) {
        guarantorId = created.id;
        report.guarantors.created += 1;
      }
    }
  }

  // ─── 2.4 Lease ─────────────────────────────────────────────────────────────
  const startDate = bail.dateEffet || new Date().toISOString().slice(0, 10);
  const monthlyRentCents = Math.round((bail.loyer ?? 0) * 100);
  const monthlyChargesCents = Math.round((bail.charges ?? 0) * 100);
  const depositCents = Math.round((bail.depotGarantie ?? 0) * 100);
  const paymentDay = Math.max(1, Math.min(31, bail.jourEcheance ?? 5));

  // Idempotence par (property + tenant + startDate)
  const existingLease = await db
    .select({ id: leases.id })
    .from(leases)
    .innerJoin(leaseTenants, eq(leaseTenants.leaseId, leases.id))
    .where(
      and(
        eq(leases.propertyId, propertyId),
        eq(leaseTenants.tenantId, tenantId),
        eq(leases.startDate, startDate),
      ),
    )
    .limit(1);

  if (existingLease.length > 0) {
    report.leases.skipped += 1;
    return;
  }

  await db.transaction(async (tx) => {
    const [createdLease] = await tx
      .insert(leases)
      .values({
        propertyId,
        leaseTypeKey: 'empty',
        startDate,
        monthlyRentCents,
        monthlyChargesCents,
        chargesTypeKey: legacyChargesTypeKey(bail.modaliteCharges),
        depositCents,
        paymentDay,
        solidarity: false,
        statusKey: 'active',
        signedAt: new Date(),
      })
      .returning({ id: leases.id });
    if (!createdLease) throw new Error('Insert lease failed');

    await tx.insert(leaseTenants).values({ leaseId: createdLease.id, tenantId });
    if (guarantorId) {
      await tx.insert(leaseGuarantors).values({ leaseId: createdLease.id, guarantorId });
    }
    report.leases.created += 1;
  });
}
