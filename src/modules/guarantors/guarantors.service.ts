import { and, desc, eq } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { Guarantor } from '../../db/schema/guarantors.js';
import { guarantors } from '../../db/schema/guarantors.js';
import type {
  CreateGuarantorInput,
  GuarantorPublic,
  GuarantorTypeKey,
  PatchGuarantorInput,
} from './guarantors.schemas.js';

export async function listByCreator(
  creatorUserId: string,
  typeFilter?: GuarantorTypeKey,
): Promise<Guarantor[]> {
  const where = typeFilter
    ? and(
        eq(guarantors.createdByUserId, creatorUserId),
        eq(guarantors.guarantorTypeKey, typeFilter),
      )
    : eq(guarantors.createdByUserId, creatorUserId);

  return db.select().from(guarantors).where(where).orderBy(desc(guarantors.createdAt));
}

export async function create(
  creatorUserId: string,
  data: CreateGuarantorInput,
): Promise<Guarantor> {
  // On normalise toujours les deux blocs : les champs absents du payload
  // (parce que non pertinents pour le type sélectionné) sont stockés à `null`.
  // Le CHECK SQL côté DB garantit la cohérence.
  const values =
    data.guarantorTypeKey === 'person'
      ? {
          createdByUserId: creatorUserId,
          guarantorTypeKey: 'person' as const,
          civility: data.civility ?? null,
          lastName: data.lastName,
          firstName: data.firstName,
          email: data.email ?? null,
          phone: data.phone ?? null,
          birthDate: data.birthDate ?? null,
          birthPlace: data.birthPlace ?? null,
          addressLine: data.addressLine ?? null,
          postalCode: data.postalCode ?? null,
          city: data.city ?? null,
          organizationName: null,
          organizationReference: null,
          updatedAt: new Date(),
        }
      : {
          createdByUserId: creatorUserId,
          guarantorTypeKey: 'organization' as const,
          civility: null,
          lastName: null,
          firstName: null,
          email: data.email ?? null,
          phone: data.phone ?? null,
          birthDate: null,
          birthPlace: null,
          addressLine: data.addressLine ?? null,
          postalCode: data.postalCode ?? null,
          city: data.city ?? null,
          organizationName: data.organizationName,
          organizationReference: data.organizationReference ?? null,
          updatedAt: new Date(),
        };

  const [row] = await db.insert(guarantors).values(values).returning();

  if (!row) {
    throw new Error('Échec de la création du garant');
  }

  return row;
}

export async function getByIdForCreator(id: string, creatorUserId: string): Promise<Guarantor> {
  const [row] = await db.select().from(guarantors).where(eq(guarantors.id, id)).limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Garant introuvable' });
  }

  if (row.createdByUserId !== creatorUserId) {
    // 403 (et pas 404) : ressource existe mais l'utilisateur n'a pas le droit
    // d'y accéder. Cohérent avec le module `properties`.
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  return row;
}

/**
 * PATCH (JSON Merge Patch, RFC 7396) :
 * - Clé absente → ne touche pas la colonne
 * - Clé à `null` → set la colonne à NULL
 * - Clé avec valeur → update la colonne
 *
 * Règles métier :
 * - `guarantorTypeKey` est IMMUTABLE via PATCH : si fourni et différent de la
 *   valeur existante, on rejette en 400. Pour un switch person↔organization,
 *   passer par delete + recreate.
 * - Les champs cross-type (ex. patcher `lastName` sur un garant `organization`)
 *   sont laissés à la responsabilité du caller : la DB reste cohérente tant
 *   que le CHECK SQL est respecté (le caller peut techniquement écrire un
 *   `lastName` sur une organisation — on ne l'interdit pas explicitement ici
 *   car ça ne casse pas la contrainte CHECK).
 */
export async function patch(
  id: string,
  creatorUserId: string,
  data: PatchGuarantorInput,
): Promise<Guarantor> {
  // Pré-check d'ownership + récupère la ligne pour comparer le type.
  const existing = await getByIdForCreator(id, creatorUserId);

  // Le type est IMMUTABLE via cet endpoint : un switch person↔organization
  // doit passer par delete + recreate (plus simple, évite des ambiguïtés sur
  // les champs orphelins).
  if (data.guarantorTypeKey !== undefined && data.guarantorTypeKey !== existing.guarantorTypeKey) {
    throw new HTTPException(400, {
      message:
        'Le type d’un garant est immuable. Pour changer de type, supprimez puis recréez le garant.',
    });
  }

  // Construction du set : on ne met que les clés présentes (≠ undefined).
  // On exclut `guarantorTypeKey` du set : il est immutable (déjà validé
  // ci-dessus), inutile de le réécrire.
  const { guarantorTypeKey: _ignored, ...patchable } = data;
  void _ignored;
  const updateData = Object.fromEntries(
    Object.entries(patchable).filter(([, v]) => v !== undefined),
  );

  if (Object.keys(updateData).length === 0) {
    // PATCH vide → on renvoie l'entité telle quelle, sans toucher updatedAt.
    return existing;
  }

  const [row] = await db
    .update(guarantors)
    .set({ ...updateData, updatedAt: new Date() })
    // Double filtre id + ownership pour éviter toute course condition.
    .where(and(eq(guarantors.id, id), eq(guarantors.createdByUserId, creatorUserId)))
    .returning();

  if (!row) {
    throw new HTTPException(404, { message: 'Garant introuvable' });
  }

  return row;
}

export async function remove(id: string, creatorUserId: string): Promise<void> {
  // Pré-check d'ownership : lève 404/403 si besoin avant le DELETE.
  await getByIdForCreator(id, creatorUserId);

  const deleted = await db
    .delete(guarantors)
    .where(and(eq(guarantors.id, id), eq(guarantors.createdByUserId, creatorUserId)))
    .returning({ id: guarantors.id });

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: 'Garant introuvable' });
  }
}

export function toPublicGuarantor(g: Guarantor): GuarantorPublic {
  return {
    id: g.id,
    userId: g.userId,
    createdByUserId: g.createdByUserId,
    guarantorTypeKey: g.guarantorTypeKey,
    civility: g.civility,
    lastName: g.lastName,
    firstName: g.firstName,
    email: g.email,
    phone: g.phone,
    // Drizzle `date` columns default to string mode (YYYY-MM-DD).
    birthDate: g.birthDate,
    birthPlace: g.birthPlace,
    addressLine: g.addressLine,
    postalCode: g.postalCode,
    city: g.city,
    organizationName: g.organizationName,
    organizationReference: g.organizationReference,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  };
}
