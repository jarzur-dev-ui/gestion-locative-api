import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import type { LandlordProfile } from '../../db/schema/landlord-profiles.js';
import { landlordProfiles } from '../../db/schema/landlord-profiles.js';
import type { LandlordProfilePublic, UpsertLandlordProfileInput } from './landlord-profiles.schemas.js';

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
