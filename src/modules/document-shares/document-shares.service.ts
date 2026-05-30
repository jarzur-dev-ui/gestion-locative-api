import { randomBytes } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import type { DocumentShare } from '../../db/schema/document-shares.js';
import { documentShares } from '../../db/schema/document-shares.js';
import type { Document } from '../../db/schema/documents.js';
import { documents } from '../../db/schema/documents.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import { logger } from '../../lib/logger.js';
import {
  SHARE_DEFAULT_TTL_DAYS,
  SHARE_MAX_TTL_DAYS,
} from './document-shares.schemas.js';

// URL d'accueil de la page publique de téléchargement. En V1 on hard-code
// ; à terme on basculera vers une variable d'env (`WEB_APP_URL` ou
// `SHARE_BASE_URL`).
const WEB_APP_BASE_URL = 'https://gestion-locative.zeleph.fr';

function generateShareToken(): string {
  // 32 bytes = 256 bits d'entropie, url-safe via base64url. Même format que
  // les tokens de session et d'invitation.
  return randomBytes(32).toString('base64url');
}

function buildShareUrl(token: string): string {
  return `${WEB_APP_BASE_URL}/share/${token}`;
}

/**
 * Construit l'URL publique à partir du token. Exposée pour la route POST
 * afin de la composer dans la réponse 201.
 */
export function shareUrlFor(token: string): string {
  return buildShareUrl(token);
}

/**
 * Masque le token pour les logs (8 premiers chars + '…'). Utilisé partout
 * où on logge un token afin de ne jamais en publier l'intégralité.
 */
export function maskToken(token: string): string {
  return `${token.slice(0, 8)}...`;
}

/**
 * Vérifie qu'un landlord peut partager un document : il doit en être
 * propriétaire indirectement via la propriété ou le bail rattaché.
 *
 * Règle ACL V1 (alignée sur la lecture des documents) :
 *  - Si le document a `propertyId`, la propriété doit appartenir au user.
 *  - Sinon si `leaseId` est renseigné, le bail doit pointer vers une
 *    propriété du user.
 *  - Le CHECK SQL `documents_ownership_check` garantit qu'au moins un des
 *    deux est non null — pas besoin de gérer le cas "aucun".
 *
 * Retourne le document si l'accès est OK, sinon lève 403/404.
 */
async function assertLandlordOwnsDocument(
  documentId: string,
  userId: string,
): Promise<Document> {
  // On joint le document à `properties` par les deux chemins possibles
  // (direct via documents.property_id OU indirect via documents.lease_id →
  // leases.property_id) et on récupère l'owner de chaque côté.
  const [row] = await db
    .select({
      document: documents,
      propertyOwnerDirect: properties.ownerUserId,
      leasePropertyId: leases.propertyId,
    })
    .from(documents)
    .leftJoin(properties, eq(properties.id, documents.propertyId))
    .leftJoin(leases, eq(leases.id, documents.leaseId))
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Document introuvable' });
  }

  // Cas 1 : ownership direct via property.
  if (row.propertyOwnerDirect === userId) {
    return row.document;
  }

  // Cas 2 : ownership indirect via lease → property. On re-requête la
  // propriété rattachée au bail pour vérifier son owner. (Le `leftJoin` sur
  // `leases` ne nous donne que `leases.property_id` ; on doit faire un
  // round-trip pour récupérer son owner.)
  if (row.leasePropertyId) {
    const [propRow] = await db
      .select({ ownerUserId: properties.ownerUserId })
      .from(properties)
      .where(eq(properties.id, row.leasePropertyId))
      .limit(1);

    if (propRow?.ownerUserId === userId) {
      return row.document;
    }
  }

  throw new HTTPException(403, { message: 'Accès refusé' });
}

/**
 * Crée un partage public pour un document. Le caller doit être un landlord
 * (vérifié par la route via `requireRole`) ET propriétaire du document.
 */
export async function createShare(opts: {
  currentUserId: string;
  documentId: string;
  ttlDays?: number;
}): Promise<DocumentShare> {
  await assertLandlordOwnsDocument(opts.documentId, opts.currentUserId);

  // Borne de sécurité côté service (en plus de la validation Zod). Évite
  // qu'un caller bypass-validation crée un partage quasi-permanent.
  const ttlDays = Math.min(
    Math.max(opts.ttlDays ?? SHARE_DEFAULT_TTL_DAYS, 1),
    SHARE_MAX_TTL_DAYS,
  );

  const token = generateShareToken();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  const [share] = await db
    .insert(documentShares)
    .values({
      token,
      documentId: opts.documentId,
      createdByUserId: opts.currentUserId,
      expiresAt,
    })
    .returning();

  if (!share) {
    throw new Error('Échec de la création du partage');
  }

  return share;
}

/**
 * Révocation manuelle. Autorisée si le caller a créé le partage OU s'il
 * est le bailleur propriétaire du document. Idempotent : si le partage est
 * déjà révoqué, on garde `revokedAt` inchangé pour préserver l'audit.
 */
export async function revokeShare(token: string, byUserId: string): Promise<void> {
  const [share] = await db
    .select()
    .from(documentShares)
    .where(eq(documentShares.token, token))
    .limit(1);

  if (!share) {
    throw new HTTPException(404, { message: 'Partage introuvable' });
  }

  // Autorisation : soit le créateur du partage, soit le propriétaire du
  // document sous-jacent. On délègue à `assertLandlordOwnsDocument` pour
  // le second cas — il lèvera 403 si l'user n'est pas propriétaire.
  if (share.createdByUserId !== byUserId) {
    await assertLandlordOwnsDocument(share.documentId, byUserId);
  }

  // Idempotence : si déjà révoqué, on ne touche pas la date pour garder la
  // trace de la révocation initiale.
  if (share.revokedAt !== null) {
    return;
  }

  await db
    .update(documentShares)
    .set({ revokedAt: new Date() })
    .where(and(eq(documentShares.token, token), isNull(documentShares.revokedAt)));
}

/**
 * Liste les partages créés par l'utilisateur courant, plus récent en premier.
 * `documentId` optionnel pour filtrer la vue détaillée d'un document.
 */
export async function listSharesByCreator(
  userId: string,
  documentId?: string,
): Promise<DocumentShare[]> {
  const where = documentId
    ? and(eq(documentShares.createdByUserId, userId), eq(documentShares.documentId, documentId))
    : eq(documentShares.createdByUserId, userId);

  return db.select().from(documentShares).where(where).orderBy(desc(documentShares.createdAt));
}

/**
 * Résolution d'un partage pour téléchargement public. Retourne null si :
 *  - le token est inconnu
 *  - le partage est révoqué
 *  - le partage est expiré
 *
 * Le document est joint dans la même requête pour éviter un round-trip.
 * On exige `document IS NOT NULL` (théoriquement garanti par CASCADE, mais
 * défensif au cas où la FK serait modifiée).
 */
export async function resolveShareForDownload(
  token: string,
): Promise<{ share: DocumentShare; document: Document } | null> {
  const [row] = await db
    .select({ share: documentShares, document: documents })
    .from(documentShares)
    .innerJoin(documents, eq(documents.id, documentShares.documentId))
    .where(eq(documentShares.token, token))
    .limit(1);

  if (!row) return null;
  if (row.share.revokedAt !== null) return null;
  if (row.share.expiresAt.getTime() < Date.now()) return null;

  return { share: row.share, document: row.document };
}

/**
 * Incrément du compteur d'accès. Best-effort : on log l'erreur mais on ne
 * la propage pas — le téléchargement ne doit pas échouer si la stat fail.
 *
 * On préfère un UPDATE non-conditionné qu'un read-modify-write : `count+1`
 * en SQL évite la course entre deux accès concurrents.
 */
export async function recordShareAccess(token: string): Promise<void> {
  try {
    await db
      .update(documentShares)
      .set({
        accessCount: sql`${documentShares.accessCount} + 1`,
        lastAccessedAt: new Date(),
      })
      .where(eq(documentShares.token, token));
  } catch (err) {
    logger.warn({ err, token: maskToken(token) }, 'document-shares: failed to record access');
  }
}

/**
 * Sérialisation publique d'un partage pour les endpoints privés.
 */
export function toPublicShare(s: DocumentShare): {
  token: string;
  documentId: string;
  createdByUserId: string;
  expiresAt: string;
  revokedAt: string | null;
  lastAccessedAt: string | null;
  accessCount: number;
  createdAt: string;
} {
  return {
    token: s.token,
    documentId: s.documentId,
    createdByUserId: s.createdByUserId,
    expiresAt: s.expiresAt.toISOString(),
    revokedAt: s.revokedAt ? s.revokedAt.toISOString() : null,
    lastAccessedAt: s.lastAccessedAt ? s.lastAccessedAt.toISOString() : null,
    accessCount: s.accessCount,
    createdAt: s.createdAt.toISOString(),
  };
}
