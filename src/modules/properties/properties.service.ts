import { and, desc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { Property } from '../../db/schema/properties.js';
import { properties } from '../../db/schema/properties.js';
import type {
  CreatePropertyInput,
  PropertyPublic,
  UpdatePropertyInput,
} from './properties.schemas.js';

type DpeGrade = NonNullable<PropertyPublic['dpeGrade']>;

function isDpeGrade(value: string): value is DpeGrade {
  return ['A', 'B', 'C', 'D', 'E', 'F', 'G'].includes(value);
}

/**
 * `numeric` est renvoyé sous forme de string par le driver postgres-js.
 * On le convertit en `number` pour la réponse JSON.
 */
function parseSurfaceM2(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toPublicProperty(p: Property): PropertyPublic {
  return {
    id: p.id,
    ownerUserId: p.ownerUserId,
    addressLine: p.addressLine,
    postalCode: p.postalCode,
    city: p.city,
    propertyTypeKey: p.propertyTypeKey,
    surfaceM2: parseSurfaceM2(p.surfaceM2),
    roomCount: p.roomCount,
    builtYear: p.builtYear,
    dpeGrade: p.dpeGrade !== null && isDpeGrade(p.dpeGrade) ? p.dpeGrade : null,
    gesGrade: p.gesGrade !== null && isDpeGrade(p.gesGrade) ? p.gesGrade : null,
    furnished: p.furnished,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function listByOwner(userId: string): Promise<Property[]> {
  return db
    .select()
    .from(properties)
    .where(eq(properties.ownerUserId, userId))
    .orderBy(desc(properties.createdAt));
}

export async function getByIdForOwner(id: string, userId: string): Promise<Property> {
  const [row] = await db
    .select()
    .from(properties)
    .where(eq(properties.id, id))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Bien immobilier non trouvé' });
  }

  if (row.ownerUserId !== userId) {
    // On renvoie volontairement 403 (et pas 404) car le client est authentifié
    // et que la ressource existe — c'est la règle métier qui interdit l'accès.
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  return row;
}

export async function create(userId: string, data: CreatePropertyInput): Promise<Property> {
  const [row] = await db
    .insert(properties)
    .values({
      ownerUserId: userId,
      addressLine: data.addressLine,
      postalCode: data.postalCode,
      city: data.city,
      propertyTypeKey: data.propertyTypeKey,
      // numeric → string attendu côté Drizzle.
      surfaceM2: data.surfaceM2 !== undefined ? String(data.surfaceM2) : null,
      roomCount: data.roomCount ?? null,
      builtYear: data.builtYear ?? null,
      dpeGrade: data.dpeGrade ?? null,
      gesGrade: data.gesGrade ?? null,
      furnished: data.furnished ?? false,
    })
    .returning();

  if (!row) {
    throw new Error('Échec de la création du bien immobilier');
  }

  return row;
}

export async function update(
  id: string,
  userId: string,
  data: UpdatePropertyInput,
): Promise<Property> {
  // Pré-check d'ownership : lève 404/403 si besoin avant l'UPDATE.
  await getByIdForOwner(id, userId);

  const [row] = await db
    .update(properties)
    .set({
      addressLine: data.addressLine,
      postalCode: data.postalCode,
      city: data.city,
      propertyTypeKey: data.propertyTypeKey,
      surfaceM2: data.surfaceM2 !== undefined ? String(data.surfaceM2) : null,
      roomCount: data.roomCount ?? null,
      builtYear: data.builtYear ?? null,
      dpeGrade: data.dpeGrade ?? null,
      gesGrade: data.gesGrade ?? null,
      furnished: data.furnished ?? false,
      updatedAt: new Date(),
    })
    // Double filtre `id + ownerUserId` pour éviter toute course condition.
    .where(and(eq(properties.id, id), eq(properties.ownerUserId, userId)))
    .returning();

  if (!row) {
    throw new HTTPException(404, { message: 'Bien immobilier non trouvé' });
  }

  return row;
}

export async function remove(id: string, userId: string): Promise<void> {
  // Pré-check d'ownership : lève 404/403 si besoin avant le DELETE.
  await getByIdForOwner(id, userId);

  const deleted = await db
    .delete(properties)
    .where(and(eq(properties.id, id), eq(properties.ownerUserId, userId)))
    .returning({ id: properties.id });

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: 'Bien immobilier non trouvé' });
  }
}
