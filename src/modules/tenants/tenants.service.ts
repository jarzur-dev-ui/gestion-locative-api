import { and, desc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { Tenant } from '../../db/schema/tenants.js';
import { tenants } from '../../db/schema/tenants.js';
import type { CreateTenantInput, TenantPublic, UpdateTenantInput } from './tenants.schemas.js';

export async function listByCreator(creatorUserId: string): Promise<Tenant[]> {
  return db
    .select()
    .from(tenants)
    .where(eq(tenants.createdByUserId, creatorUserId))
    .orderBy(desc(tenants.createdAt));
}

export async function create(
  creatorUserId: string,
  data: CreateTenantInput,
): Promise<Tenant> {
  const now = new Date();
  const [tenant] = await db
    .insert(tenants)
    .values({
      createdByUserId: creatorUserId,
      civility: data.civility ?? null,
      lastName: data.lastName,
      firstName: data.firstName,
      email: data.email,
      phone: data.phone ?? null,
      birthDate: data.birthDate ?? null,
      birthPlace: data.birthPlace ?? null,
      currentAddressLine: data.currentAddressLine ?? null,
      currentPostalCode: data.currentPostalCode ?? null,
      currentCity: data.currentCity ?? null,
      updatedAt: now,
    })
    .returning();

  if (!tenant) {
    throw new Error('Échec de la création du locataire');
  }

  return tenant;
}

export async function getByIdForCreator(
  id: string,
  creatorUserId: string,
): Promise<Tenant> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, id)).limit(1);

  if (!tenant) {
    throw new HTTPException(404, { message: 'Locataire introuvable' });
  }

  if (tenant.createdByUserId !== creatorUserId) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  return tenant;
}

export async function update(
  id: string,
  creatorUserId: string,
  data: UpdateTenantInput,
): Promise<Tenant> {
  // Garantit existence + ownership avant la mise à jour.
  await getByIdForCreator(id, creatorUserId);

  const [tenant] = await db
    .update(tenants)
    .set({
      civility: data.civility ?? null,
      lastName: data.lastName,
      firstName: data.firstName,
      email: data.email,
      phone: data.phone ?? null,
      birthDate: data.birthDate ?? null,
      birthPlace: data.birthPlace ?? null,
      currentAddressLine: data.currentAddressLine ?? null,
      currentPostalCode: data.currentPostalCode ?? null,
      currentCity: data.currentCity ?? null,
      updatedAt: new Date(),
    })
    .where(and(eq(tenants.id, id), eq(tenants.createdByUserId, creatorUserId)))
    .returning();

  if (!tenant) {
    throw new Error('Échec de la mise à jour du locataire');
  }

  return tenant;
}

export async function deleteTenant(id: string, creatorUserId: string): Promise<void> {
  // Garantit existence + ownership avant la suppression.
  await getByIdForCreator(id, creatorUserId);

  await db
    .delete(tenants)
    .where(and(eq(tenants.id, id), eq(tenants.createdByUserId, creatorUserId)));
}

export function toPublicTenant(tenant: Tenant): TenantPublic {
  return {
    id: tenant.id,
    userId: tenant.userId,
    createdByUserId: tenant.createdByUserId,
    civility: tenant.civility,
    lastName: tenant.lastName,
    firstName: tenant.firstName,
    email: tenant.email,
    phone: tenant.phone,
    // Drizzle `date` columns default to string mode (YYYY-MM-DD), donc pas de conversion.
    birthDate: tenant.birthDate,
    birthPlace: tenant.birthPlace,
    currentAddressLine: tenant.currentAddressLine,
    currentPostalCode: tenant.currentPostalCode,
    currentCity: tenant.currentCity,
    createdAt: tenant.createdAt.toISOString(),
    updatedAt: tenant.updatedAt.toISOString(),
  };
}
