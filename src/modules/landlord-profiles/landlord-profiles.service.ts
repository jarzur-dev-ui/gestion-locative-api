import { type SQL, and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { documents } from '../../db/schema/documents.js';
import type { LandlordProfile } from '../../db/schema/landlord-profiles.js';
import { landlordProfiles } from '../../db/schema/landlord-profiles.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import type {
  LandlordProfilePublic,
  UpsertLandlordProfileInput,
} from './landlord-profiles.schemas.js';

// Quota de stockage par défaut quand le bailleur n'a pas (encore) de profil
// en base. Aligné sur la valeur de la colonne `storage_quota_bytes` (1 GiB).
const DEFAULT_STORAGE_QUOTA_BYTES = 1_073_741_824;

export async function getByUserId(userId: string): Promise<LandlordProfile | null> {
  const [profile] = await db
    .select()
    .from(landlordProfiles)
    .where(eq(landlordProfiles.userId, userId))
    .limit(1);

  return profile ?? null;
}

export async function upsertByUserId(
  userId: string,
  data: UpsertLandlordProfileInput,
): Promise<LandlordProfile> {
  const now = new Date();
  const values = {
    userId,
    civility: data.civility ?? null,
    lastName: data.lastName,
    firstName: data.firstName,
    addressLine: data.addressLine,
    postalCode: data.postalCode,
    city: data.city,
    email: data.email ?? null,
    phone: data.phone ?? null,
    iban: data.iban ?? null,
    signatureFilePath: data.signatureFilePath ?? null,
    updatedAt: now,
  };

  const [profile] = await db
    .insert(landlordProfiles)
    .values(values)
    .onConflictDoUpdate({
      target: landlordProfiles.userId,
      set: {
        civility: values.civility,
        lastName: values.lastName,
        firstName: values.firstName,
        addressLine: values.addressLine,
        postalCode: values.postalCode,
        city: values.city,
        email: values.email,
        phone: values.phone,
        iban: values.iban,
        signatureFilePath: values.signatureFilePath,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  if (!profile) {
    // Drizzle's `returning()` should always yield a row for INSERT ... ON CONFLICT DO UPDATE.
    throw new Error('Échec de la création/mise à jour du profil bailleur');
  }

  return profile;
}

/**
 * Quota de stockage en octets pour le bailleur `userId`.
 *
 * Lit `landlord_profiles.storage_quota_bytes`. Fallback à 1 GiB si le profil
 * n'existe pas encore (un bailleur vient d'être créé mais n'a pas validé
 * son profil) — cohérent avec le `.default()` de la colonne.
 */
export async function getStorageQuotaBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({ quota: landlordProfiles.storageQuotaBytes })
    .from(landlordProfiles)
    .where(eq(landlordProfiles.userId, userId))
    .limit(1);

  return row?.quota ?? DEFAULT_STORAGE_QUOTA_BYTES;
}

/**
 * Stockage actuellement utilisé par le bailleur `userId`, en octets.
 *
 * Somme `documents.file_size_bytes` pour tous les documents :
 *  - rattachés à une propriété qu'il possède, OU
 *  - rattachés à un bail dont la propriété lui appartient
 *
 * Les documents soft-deleted (`deleted_at IS NOT NULL`) ne comptent PAS,
 * pour ne pas pénaliser le bailleur tant que le purge cron n'a pas tourné.
 */
export async function getStorageUsedBytes(userId: string): Promise<number> {
  // Resolve scope : same approach as documents.service.getAccessibleScope
  // pour un landlord (on duplique localement pour éviter une dépendance
  // circulaire landlord-profiles → documents → landlord-profiles).
  const ownedProps = await db
    .select({ id: properties.id })
    .from(properties)
    .where(eq(properties.ownerUserId, userId));

  const propertyIds = ownedProps.map((r) => r.id);
  if (propertyIds.length === 0) {
    return 0;
  }

  const leasesOnOwnedProps = await db
    .select({ id: leases.id })
    .from(leases)
    .where(inArray(leases.propertyId, propertyIds));

  const leaseIds = leasesOnOwnedProps.map((r) => r.id);

  const aclClauses: SQL[] = [];
  aclClauses.push(inArray(documents.propertyId, propertyIds));
  if (leaseIds.length > 0) {
    aclClauses.push(inArray(documents.leaseId, leaseIds));
  }

  // biome-ignore lint/style/noNonNullAssertion: aclClauses contient au moins un élément (propertyIds non vide)
  const aclWhere = aclClauses.length === 1 ? aclClauses[0]! : or(...aclClauses)!;

  const [row] = await db
    .select({
      // COALESCE pour gérer SUM() qui renvoie NULL quand aucune ligne ne matche.
      total: sql<string>`COALESCE(SUM(${documents.fileSizeBytes}), 0)`,
    })
    .from(documents)
    .where(and(aclWhere, isNull(documents.deletedAt)));

  // SUM() côté Postgres renvoie un `numeric` → driver expose en string.
  // Number() est sûr ici tant qu'on reste < 2^53 (≈ 9 PB).
  return Number(row?.total ?? 0);
}

export function toPublicLandlordProfile(profile: LandlordProfile): LandlordProfilePublic {
  return {
    userId: profile.userId,
    civility: profile.civility,
    lastName: profile.lastName,
    firstName: profile.firstName,
    addressLine: profile.addressLine,
    postalCode: profile.postalCode,
    city: profile.city,
    email: profile.email,
    phone: profile.phone,
    iban: profile.iban,
    signatureFilePath: profile.signatureFilePath,
    createdAt: profile.createdAt.toISOString(),
    updatedAt: profile.updatedAt.toISOString(),
  };
}
