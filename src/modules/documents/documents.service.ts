import { type SQL, and, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { Document } from '../../db/schema/documents.js';
import { documents } from '../../db/schema/documents.js';
import { guarantors } from '../../db/schema/guarantors.js';
import { leaseGuarantors } from '../../db/schema/lease-guarantors.js';
import { leaseTenants } from '../../db/schema/lease-tenants.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import { tenants } from '../../db/schema/tenants.js';
import type { User } from '../../db/schema/users.js';
import {
  FileTooLargeError,
  MimeMismatchError,
  UnsupportedMimeTypeError,
  assertContentMatchesDeclaredMime,
  deleteFile,
  storeFile,
} from '../../lib/storage.js';
import {
  getStorageQuotaBytes,
  getStorageUsedBytes,
} from '../landlord-profiles/landlord-profiles.service.js';
import { isAllowedTypeForRole } from './document-types.js';
import type {
  DocumentPublic,
  DocumentStatusKey,
  UpdateDocumentStatusInput,
} from './documents.schemas.js';

// ---------------------------------------------------------------------------
// Mapping DB → API
// ---------------------------------------------------------------------------

/**
 * Construit la représentation publique d'un document.
 *
 * NOTE : on n'expose volontairement PAS `filePath` (chemin interne du
 * volume). Le client utilise `downloadUrl` qui pointe vers l'endpoint
 * de streaming `GET /api/documents/:id/download`.
 */
export function toPublicDocument(d: Document): DocumentPublic {
  return {
    id: d.id,
    leaseId: d.leaseId,
    propertyId: d.propertyId,
    documentTypeKey: d.documentTypeKey,
    periodMonth: d.periodMonth,
    fileSizeBytes: d.fileSizeBytes,
    mimeType: d.mimeType,
    originalFilename: d.originalFilename,
    statusKey: d.statusKey,
    validatedAt: d.validatedAt ? d.validatedAt.toISOString() : null,
    validatedByUserId: d.validatedByUserId,
    rejectionReason: d.rejectionReason,
    cancelledAt: d.cancelledAt ? d.cancelledAt.toISOString() : null,
    cancelledByUserId: d.cancelledByUserId,
    cancellationReason: d.cancellationReason,
    uploadedByUserId: d.uploadedByUserId,
    downloadUrl: `/api/documents/${d.id}/download`,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// ACL — résolution des ids accessibles par utilisateur
// ---------------------------------------------------------------------------

type AccessibleScope = {
  leaseIds: string[];
  propertyIds: string[];
};

/**
 * Retourne, pour un utilisateur donné, l'ensemble des `leaseIds` et
 * `propertyIds` auxquels il a accès. C'est la brique de base de l'ACL
 * sur les documents : un document est accessible si son `leaseId` figure
 * dans `leaseIds` OU son `propertyId` dans `propertyIds`.
 *
 * Règles par rôle :
 * - landlord  : propriétés dont il est `ownerUserId`, et baux portant sur
 *               ces propriétés.
 * - tenant    : baux où il est lié via `lease_tenants` (jointure via
 *               `tenants.userId`). Les propriétés sont CELLES de ces baux
 *               — un locataire voit donc aussi les documents rattachés
 *               directement au bien (ex: DPE rattaché à la propriété et
 *               pas au bail).
 * - guarantor : idem locataire mais via `lease_guarantors` (jointure via
 *               `guarantors.userId`).
 *
 * On résout les ids en une seule requête par rôle, puis on les combine.
 * Le volume reste faible (typiquement < 100 baux par utilisateur).
 */
async function getAccessibleScope(user: User): Promise<AccessibleScope> {
  if (user.role === 'landlord') {
    const ownedProps = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.ownerUserId, user.id));

    const propertyIds = ownedProps.map((r) => r.id);

    if (propertyIds.length === 0) {
      return { leaseIds: [], propertyIds: [] };
    }

    const leasesOnOwnedProps = await db
      .select({ id: leases.id })
      .from(leases)
      .where(inArray(leases.propertyId, propertyIds));

    return {
      leaseIds: leasesOnOwnedProps.map((r) => r.id),
      propertyIds,
    };
  }

  if (user.role === 'tenant') {
    const rows = await db
      .select({ leaseId: leaseTenants.leaseId, propertyId: leases.propertyId })
      .from(leaseTenants)
      .innerJoin(tenants, eq(tenants.id, leaseTenants.tenantId))
      .innerJoin(leases, eq(leases.id, leaseTenants.leaseId))
      .where(eq(tenants.userId, user.id));

    const leaseIds = Array.from(new Set(rows.map((r) => r.leaseId)));
    const propertyIds = Array.from(new Set(rows.map((r) => r.propertyId)));
    return { leaseIds, propertyIds };
  }

  // guarantor
  const rows = await db
    .select({ leaseId: leaseGuarantors.leaseId, propertyId: leases.propertyId })
    .from(leaseGuarantors)
    .innerJoin(guarantors, eq(guarantors.id, leaseGuarantors.guarantorId))
    .innerJoin(leases, eq(leases.id, leaseGuarantors.leaseId))
    .where(eq(guarantors.userId, user.id));

  const leaseIds = Array.from(new Set(rows.map((r) => r.leaseId)));
  const propertyIds = Array.from(new Set(rows.map((r) => r.propertyId)));
  return { leaseIds, propertyIds };
}

/**
 * Vrai si l'utilisateur a accès à un bail donné (= il est partie au bail,
 * ou en est propriétaire via la propriété).
 *
 * Utilisé à l'upload pour autoriser le rattachement à un `leaseId`.
 */
async function userHasAccessToLease(user: User, leaseId: string): Promise<boolean> {
  if (user.role === 'landlord') {
    const [row] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.propertyId))
      .where(eq(leases.id, leaseId))
      .limit(1);
    return !!row && row.ownerUserId === user.id;
  }

  if (user.role === 'tenant') {
    const [row] = await db
      .select({ leaseId: leaseTenants.leaseId })
      .from(leaseTenants)
      .innerJoin(tenants, eq(tenants.id, leaseTenants.tenantId))
      .where(and(eq(leaseTenants.leaseId, leaseId), eq(tenants.userId, user.id)))
      .limit(1);
    return !!row;
  }

  // guarantor
  const [row] = await db
    .select({ leaseId: leaseGuarantors.leaseId })
    .from(leaseGuarantors)
    .innerJoin(guarantors, eq(guarantors.id, leaseGuarantors.guarantorId))
    .where(and(eq(leaseGuarantors.leaseId, leaseId), eq(guarantors.userId, user.id)))
    .limit(1);
  return !!row;
}

/**
 * Vrai si l'utilisateur a accès à une propriété donnée.
 *
 * Pour le V1 : seuls les bailleurs (propriétaires) ont accès aux documents
 * rattachés DIRECTEMENT à une propriété (ex: DPE seul). Les locataires et
 * garants accèdent aux documents rattachés au bail uniquement (mais ils
 * voient aussi les documents rattachés à leur propriété via le scope
 * `getAccessibleScope` qui remonte la propriété du bail) — c'est l'usage
 * normal du DPE qui doit être visible du locataire.
 *
 * Cette helper sert spécifiquement à AUTORISER l'upload d'un document
 * rattaché à une `propertyId` : seul le bailleur propriétaire peut le faire.
 */
async function userOwnsProperty(user: User, propertyId: string): Promise<boolean> {
  if (user.role !== 'landlord') return false;
  const [row] = await db
    .select({ ownerUserId: properties.ownerUserId })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);
  return !!row && row.ownerUserId === user.id;
}

/**
 * Récupère un document en vérifiant l'ACL d'accès en LECTURE.
 *
 * - 404 si le document n'existe pas (ou si l'utilisateur n'a aucun accès :
 *   on ne révèle pas son existence par souci de fuite d'info).
 *
 * Note : on choisit 404 (et pas 403) pour les utilisateurs sans aucun lien
 * avec la ressource, pour éviter de servir d'oracle d'existence.
 */
export async function assertDocumentAccessibleByUser(
  documentId: string,
  user: User,
): Promise<Document> {
  // Soft-deleted : invisibles aux lectures (filter isNull deletedAt).
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (!doc) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  const scope = await getAccessibleScope(user);
  const matchesLease = doc.leaseId !== null && scope.leaseIds.includes(doc.leaseId);
  const matchesProperty = doc.propertyId !== null && scope.propertyIds.includes(doc.propertyId);

  if (!matchesLease && !matchesProperty) {
    // 404 plutôt que 403 : on ne distingue pas "inexistant" de "non accessible".
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  return doc;
}

/**
 * Spécifique aux endpoints réservés au bailleur (PATCH status / DELETE) :
 * vérifie que le bailleur courant est bien propriétaire de la ressource
 * (lease ou property) attachée au document.
 */
async function assertDocumentManageableByLandlord(
  documentId: string,
  user: User,
): Promise<Document> {
  if (user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  // Soft-deleted : invisibles aux opérations standards (update/delete).
  // Le restore passe par un chemin dédié (`restoreDocument`).
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), isNull(documents.deletedAt)))
    .limit(1);

  if (!doc) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  // Le bailleur peut gérer un doc si :
  // - le doc est rattaché à une propriété qu'il possède, OU
  // - le doc est rattaché à un bail dont la propriété lui appartient.
  let manageable = false;

  if (doc.propertyId) {
    manageable = await userOwnsProperty(user, doc.propertyId);
  }

  if (!manageable && doc.leaseId) {
    const [row] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.propertyId))
      .where(eq(leases.id, doc.leaseId))
      .limit(1);
    manageable = !!row && row.ownerUserId === user.id;
  }

  if (!manageable) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  return doc;
}

/**
 * Résout le bailleur propriétaire de la ressource cible (lease ou property)
 * afin de rattacher la consommation de stockage à son quota.
 *
 * - Si le caller est lui-même bailleur, on retourne son `user.id`.
 * - Sinon (tenant/guarantor), on remonte la chaîne `lease → property.owner_user_id`
 *   ou directement `property.owner_user_id`. La V1 n'autorise pas les
 *   tenants/guarantors à uploader hors bail donc on devrait toujours
 *   trouver un owner via le bail.
 *
 * Retourne `null` si on ne parvient pas à identifier de bailleur — dans ce
 * cas on saute le check quota (best-effort, à durcir si besoin).
 */
async function resolveQuotaOwnerUserId(user: User, input: UploadInput): Promise<string | null> {
  if (user.role === 'landlord') return user.id;

  if (input.leaseId) {
    const [row] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.propertyId))
      .where(eq(leases.id, input.leaseId))
      .limit(1);
    if (row) return row.ownerUserId;
  }
  if (input.propertyId) {
    const [row] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(properties)
      .where(eq(properties.id, input.propertyId))
      .limit(1);
    if (row) return row.ownerUserId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

type ListFilters = {
  leaseId?: string;
  propertyId?: string;
  documentTypeKey?: string;
  statusKey?: DocumentStatusKey;
};

/**
 * Liste les documents accessibles à l'utilisateur courant, filtrés en plus
 * par les critères optionnels passés en query.
 *
 * On résout d'abord le scope ACL (ids de baux/propriétés accessibles), puis
 * on applique le filtre `(leaseId IN scope.leaseIds) OR (propertyId IN
 * scope.propertyIds)`. Cela permet de servir l'ACL en une seule query SQL.
 */
export async function listForUser(user: User, filters: ListFilters): Promise<Document[]> {
  const scope = await getAccessibleScope(user);

  // Pas de scope → pas de résultats. On évite une requête inutile et un
  // `inArray(_, [])` qui se traduit en SQL douteux.
  if (scope.leaseIds.length === 0 && scope.propertyIds.length === 0) {
    return [];
  }

  const aclClauses: SQL[] = [];
  if (scope.leaseIds.length > 0) {
    aclClauses.push(inArray(documents.leaseId, scope.leaseIds));
  }
  if (scope.propertyIds.length > 0) {
    aclClauses.push(inArray(documents.propertyId, scope.propertyIds));
  }

  // `or` peut renvoyer undefined si on lui passe un seul élément, on force
  // donc un fallback explicite. Avec au moins une clause (cf. early return),
  // le `!` est sûr.
  // biome-ignore lint/style/noNonNullAssertion: au moins une clause garantie par les early-returns ci-dessus
  const aclWhere = aclClauses.length === 1 ? aclClauses[0]! : or(...aclClauses)!;

  const filterClauses: SQL[] = [aclWhere, isNull(documents.deletedAt)];
  if (filters.leaseId) {
    filterClauses.push(eq(documents.leaseId, filters.leaseId));
  }
  if (filters.propertyId) {
    filterClauses.push(eq(documents.propertyId, filters.propertyId));
  }
  if (filters.documentTypeKey) {
    filterClauses.push(eq(documents.documentTypeKey, filters.documentTypeKey));
  }
  if (filters.statusKey) {
    filterClauses.push(eq(documents.statusKey, filters.statusKey));
  }

  return db
    .select()
    .from(documents)
    .where(and(...filterClauses))
    .orderBy(desc(documents.createdAt));
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type UploadInput = {
  file: File;
  documentTypeKey: string;
  leaseId?: string;
  propertyId?: string;
  periodMonth?: string;
};

/**
 * Persist un document : valide les ACL, valide le type vs le rôle, stocke
 * le fichier, INSERT la ligne. Si l'INSERT échoue après le storeFile, on
 * tente un best-effort `deleteFile` pour ne pas laisser de fichier orphelin.
 */
export async function uploadDocument(user: User, input: UploadInput): Promise<Document> {
  if (!input.leaseId && !input.propertyId) {
    throw new HTTPException(400, {
      message: 'Au moins un de leaseId ou propertyId est requis',
    });
  }

  // Whitelist type ↔ rôle.
  if (!isAllowedTypeForRole(user.role, input.documentTypeKey)) {
    throw new HTTPException(400, {
      message: `Type de document non autorisé pour le rôle ${user.role} : ${input.documentTypeKey}`,
    });
  }

  // ACL : l'utilisateur doit avoir accès à la ressource cible.
  if (input.leaseId) {
    const ok = await userHasAccessToLease(user, input.leaseId);
    if (!ok) {
      throw new HTTPException(403, { message: 'Accès refusé au bail cible' });
    }
  }
  if (input.propertyId) {
    // Pour le V1 : seul le bailleur peut rattacher un document directement
    // à une propriété (ex: DPE). Les locataires/garants doivent passer par
    // le bail.
    const ok = await userOwnsProperty(user, input.propertyId);
    if (!ok) {
      throw new HTTPException(403, { message: 'Accès refusé à la propriété cible' });
    }
  }

  // Lecture du fichier en mémoire — OK pour V1 (max 20 Mo, cf. storage.ts).
  // Pour les uploads plus gros, il faudrait passer en streaming via un
  // adapter type `node:stream/web` Readable → fs WriteStream.
  const arrayBuffer = await input.file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const incomingSize = buffer.byteLength;

  // Validation par magic bytes : on refuse un fichier dont le contenu réel ne
  // correspond pas au type MIME déclaré (multipart), ou hors allowlist. Évite
  // qu'un payload malveillant (HTML/SVG/exécutable) soit stocké et servi sous
  // un type d'image "sûr". On le fait AVANT le calcul de quota et le stockage.
  try {
    await assertContentMatchesDeclaredMime(buffer, input.file.type);
  } catch (err) {
    if (err instanceof MimeMismatchError) {
      throw new HTTPException(400, {
        message: 'Le contenu du fichier ne correspond pas au type déclaré',
      });
    }
    throw err;
  }

  // Quota landlord : on rattache la consommation au bailleur propriétaire
  // de la ressource (lease/property). Pour les uploads tenant/garant on
  // resolve d'abord le bailleur via la chaîne propriété → owner, puis on
  // compte vis-à-vis de SON quota — c'est lui qui héberge les pièces.
  const quotaUserId = await resolveQuotaOwnerUserId(user, input);
  if (quotaUserId) {
    const [used, quota] = await Promise.all([
      getStorageUsedBytes(quotaUserId),
      getStorageQuotaBytes(quotaUserId),
    ]);
    if (used + incomingSize > quota) {
      const usedMb = Math.round(used / (1024 * 1024));
      const quotaMb = Math.round(quota / (1024 * 1024));
      throw new HTTPException(413, {
        message: `Quota de stockage dépassé (${usedMb} Mo / ${quotaMb} Mo)`,
      });
    }
  }

  let stored: Awaited<ReturnType<typeof storeFile>>;
  try {
    stored = await storeFile(buffer, input.file.type, input.file.name);
  } catch (err) {
    if (err instanceof UnsupportedMimeTypeError) {
      throw new HTTPException(400, { message: err.message });
    }
    if (err instanceof FileTooLargeError) {
      throw new HTTPException(413, { message: err.message });
    }
    throw err;
  }

  // Règle de workflow V1 :
  // - upload par le bailleur (documents qu'il produit lui-même)  → validated
  // - upload par locataire/garant (pièces justificatives)        → pending_validation
  const statusKey: DocumentStatusKey =
    user.role === 'landlord' ? 'validated' : 'pending_validation';

  try {
    const [row] = await db
      .insert(documents)
      .values({
        leaseId: input.leaseId ?? null,
        propertyId: input.propertyId ?? null,
        documentTypeKey: input.documentTypeKey,
        periodMonth: input.periodMonth ?? null,
        filePath: stored.path,
        fileSizeBytes: stored.sizeBytes,
        mimeType: stored.mimeType,
        originalFilename: stored.originalFilename,
        statusKey,
        // Si le bailleur upload, on date la "validation" automatiquement.
        validatedAt: statusKey === 'validated' ? new Date() : null,
        validatedByUserId: statusKey === 'validated' ? user.id : null,
        uploadedByUserId: user.id,
        updatedAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error('Échec de la création du document');
    }
    return row;
  } catch (err) {
    // Compensation : on a stocké un fichier qu'aucune ligne ne référence —
    // on le supprime pour ne pas saturer le volume avec des orphelins.
    await deleteFile(stored.path).catch(() => {
      // best-effort, on ne masque pas l'erreur originale
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Status update (landlord)
// ---------------------------------------------------------------------------

export async function updateStatus(
  documentId: string,
  user: User,
  input: UpdateDocumentStatusInput,
): Promise<Document> {
  await assertDocumentManageableByLandlord(documentId, user);

  if (input.statusKey === 'rejected' && !input.rejectionReason) {
    throw new HTTPException(400, {
      message: 'Un motif de rejet est requis pour le statut "rejected"',
    });
  }

  const [row] = await db
    .update(documents)
    .set({
      statusKey: input.statusKey,
      validatedAt: input.statusKey === 'validated' ? new Date() : null,
      validatedByUserId: input.statusKey === 'validated' ? user.id : null,
      rejectionReason: input.statusKey === 'rejected' ? (input.rejectionReason ?? null) : null,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, documentId))
    .returning();

  if (!row) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Soft delete + restore (landlord)
// ---------------------------------------------------------------------------

/**
 * Soft delete : on positionne `deletedAt` + `deletedByUserId`, on garde la
 * ligne et le fichier. Le binaire sera supprimé par le cron de purge après
 * expiration du TTL configurable (`document.soft_delete_ttl_days`, 90j).
 *
 * La ligne devient invisible des lectures (cf. `isNull(documents.deletedAt)`
 * dans toutes les queries de lecture).
 */
export async function remove(documentId: string, user: User): Promise<void> {
  const doc = await assertDocumentManageableByLandlord(documentId, user);

  await db
    .update(documents)
    .set({
      deletedAt: new Date(),
      deletedByUserId: user.id,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, doc.id));
}

/**
 * Restore d'un document soft-deleted (bailleur uniquement, sur sa ressource).
 *
 * - 404 si aucun document soft-deleted ne matche pour ce bailleur.
 * - 409 si le document existe mais n'est pas (ou plus) soft-deleted.
 */
export async function restoreDocument(documentId: string, user: User): Promise<Document> {
  if (user.role !== 'landlord') {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId)).limit(1);

  if (!doc) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  // Vérifie l'ownership avant de révéler quoi que ce soit sur l'état du doc.
  let manageable = false;
  if (doc.propertyId) {
    manageable = await userOwnsProperty(user, doc.propertyId);
  }
  if (!manageable && doc.leaseId) {
    const [row] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(leases)
      .innerJoin(properties, eq(properties.id, leases.propertyId))
      .where(eq(leases.id, doc.leaseId))
      .limit(1);
    manageable = !!row && row.ownerUserId === user.id;
  }

  if (!manageable) {
    // Cohérent avec assertDocumentManageableByLandlord : on ne donne pas
    // d'oracle d'existence à un non-propriétaire.
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  if (doc.deletedAt === null) {
    // Le document n'est pas (ou plus) soft-deleted : on remonte 409 plutôt
    // qu'un succès trompeur, pour permettre au front d'afficher un message
    // adéquat (« déjà restauré »).
    throw new HTTPException(409, { message: 'Document déjà restauré' });
  }

  const [row] = await db
    .update(documents)
    .set({
      deletedAt: null,
      deletedByUserId: null,
      updatedAt: new Date(),
    })
    .where(eq(documents.id, doc.id))
    .returning();

  if (!row) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Sanity helper used by routes layer
// ---------------------------------------------------------------------------

/**
 * Lève 400 si `documents.leaseId IS NULL AND documents.propertyId IS NULL`,
 * ce qui ne devrait jamais arriver grâce à la contrainte CHECK en DB mais
 * on garde une garde-fou type-safe à la lecture (cas hypothétique d'une
 * vieille ligne ou d'une lecture sans CHECK).
 */
export function ensureOwnership(doc: Document): void {
  if (doc.leaseId === null && doc.propertyId === null) {
    throw new HTTPException(500, { message: 'Document mal formé (ni bail ni propriété)' });
  }
}

// silences unused-import warnings if drizzle optim removes them in future
void isNotNull;
