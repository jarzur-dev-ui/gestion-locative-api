import { and, desc, eq, inArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../../db/client.js';
import { guarantors } from '../../db/schema/guarantors.js';
import { leaseGuarantors } from '../../db/schema/lease-guarantors.js';
import { leaseTenants } from '../../db/schema/lease-tenants.js';
import type { Lease } from '../../db/schema/leases.js';
import { leases } from '../../db/schema/leases.js';
import { properties } from '../../db/schema/properties.js';
import { tenants } from '../../db/schema/tenants.js';
import type {
  CreateLeaseInput,
  LeasePublic,
  LeaseStatusKey,
  PatchLeaseInput,
} from './leases.schemas.js';

/**
 * Toutes les transitions de statut autorisées.
 * - draft   → active : signature du bail
 * - draft   → ended  : annulation avant signature (cas rare mais légitime)
 * - active  → ended  : fin de bail
 * Toute autre transition est refusée par le service avec un 400.
 */
const ALLOWED_TRANSITIONS: Record<LeaseStatusKey, ReadonlyArray<LeaseStatusKey>> = {
  draft: ['active', 'ended'],
  active: ['ended'],
  ended: [],
};

type TenantSummary = {
  id: string;
  lastName: string;
  firstName: string;
  email: string;
};

type GuarantorSummary = {
  id: string;
  guarantorTypeKey: 'person' | 'organization';
  lastName: string | null;
  firstName: string | null;
  organizationName: string | null;
};

/**
 * Construit la représentation publique du bail à partir de la ligne Drizzle
 * et des listes (déjà chargées) de locataires/garants associés.
 */
export function toPublicLease(
  l: Lease,
  tenantsList: TenantSummary[],
  guarantorsList: GuarantorSummary[],
): LeasePublic {
  return {
    id: l.id,
    propertyId: l.propertyId,
    leaseTypeKey: l.leaseTypeKey,
    startDate: l.startDate,
    endDate: l.endDate,
    monthlyRentCents: l.monthlyRentCents,
    monthlyChargesCents: l.monthlyChargesCents,
    chargesTypeKey: l.chargesTypeKey,
    depositCents: l.depositCents,
    paymentDay: l.paymentDay,
    solidarity: l.solidarity,
    statusKey: l.statusKey,
    signedAt: l.signedAt ? l.signedAt.toISOString() : null,
    signatureMethodKey: l.signatureMethodKey,
    originalPaperArchived: l.originalPaperArchived,
    createdAt: l.createdAt.toISOString(),
    updatedAt: l.updatedAt.toISOString(),
    tenants: tenantsList,
    guarantors: guarantorsList,
  };
}

/**
 * Récupère la ligne `lease` en vérifiant que la propriété associée appartient
 * bien à `userId`. Retourne 404 si le bail n'existe pas, 403 si l'utilisateur
 * n'en est pas propriétaire (cohérent avec le module `properties`).
 */
async function getLeaseForOwner(id: string, userId: string): Promise<Lease> {
  const [row] = await db
    .select({ lease: leases, ownerUserId: properties.ownerUserId })
    .from(leases)
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(eq(leases.id, id))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Bail introuvable' });
  }

  if (row.ownerUserId !== userId) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }

  return row.lease;
}

/**
 * Vérifie que la propriété existe et appartient bien à `userId`.
 * Utilisé à la création d'un bail (POST) avant les inserts en transaction.
 */
async function assertPropertyOwnedByUser(propertyId: string, userId: string): Promise<void> {
  const [row] = await db
    .select({ ownerUserId: properties.ownerUserId })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);

  if (!row) {
    throw new HTTPException(404, { message: 'Bien immobilier non trouvé' });
  }

  if (row.ownerUserId !== userId) {
    throw new HTTPException(403, { message: 'Accès refusé' });
  }
}

/**
 * Vérifie en une seule requête que TOUS les ids fournis appartiennent bien à
 * l'utilisateur courant. Si un id manque (introuvable OU créé par quelqu'un
 * d'autre), on lève 400.
 *
 * On consolide les deux cas (inexistant / pas owner) en un seul 400 :
 * - inutile de divulguer si la ressource existe (sécurité)
 * - côté UX, c'est une erreur d'entrée payload dans les deux cas
 */
async function assertTenantsOwnedByUser(tenantIds: string[], userId: string): Promise<void> {
  if (tenantIds.length === 0) return;

  // Déduplication pour éviter qu'un id en double fausse le comparatif de comptes.
  const uniqueIds = Array.from(new Set(tenantIds));

  const rows = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(and(inArray(tenants.id, uniqueIds), eq(tenants.createdByUserId, userId)));

  if (rows.length !== uniqueIds.length) {
    throw new HTTPException(400, {
      message: 'Un ou plusieurs locataires sont introuvables ou ne vous appartiennent pas',
    });
  }
}

async function assertGuarantorsOwnedByUser(guarantorIds: string[], userId: string): Promise<void> {
  if (guarantorIds.length === 0) return;

  const uniqueIds = Array.from(new Set(guarantorIds));

  const rows = await db
    .select({ id: guarantors.id })
    .from(guarantors)
    .where(and(inArray(guarantors.id, uniqueIds), eq(guarantors.createdByUserId, userId)));

  if (rows.length !== uniqueIds.length) {
    throw new HTTPException(400, {
      message: 'Un ou plusieurs garants sont introuvables ou ne vous appartiennent pas',
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

async function loadGuarantorSummaries(leaseId: string): Promise<GuarantorSummary[]> {
  return db
    .select({
      id: guarantors.id,
      guarantorTypeKey: guarantors.guarantorTypeKey,
      lastName: guarantors.lastName,
      firstName: guarantors.firstName,
      organizationName: guarantors.organizationName,
    })
    .from(leaseGuarantors)
    .innerJoin(guarantors, eq(guarantors.id, leaseGuarantors.guarantorId))
    .where(eq(leaseGuarantors.leaseId, leaseId));
}

export async function listByOwner(userId: string, status?: LeaseStatusKey): Promise<LeasePublic[]> {
  const where = status
    ? and(eq(properties.ownerUserId, userId), eq(leases.statusKey, status))
    : eq(properties.ownerUserId, userId);

  const rows = await db
    .select({ lease: leases })
    .from(leases)
    .innerJoin(properties, eq(properties.id, leases.propertyId))
    .where(where)
    .orderBy(desc(leases.createdAt));

  // Pour la liste, on remonte aussi les locataires/garants pour chaque bail.
  // Le volume est faible (typiquement < 50 baux par bailleur), donc une boucle
  // de requêtes reste acceptable. Si on devait passer à l'échelle, on ferait
  // deux requêtes globales + map en mémoire.
  const result: LeasePublic[] = [];
  for (const { lease } of rows) {
    const [tenantsList, guarantorsList] = await Promise.all([
      loadTenantSummaries(lease.id),
      loadGuarantorSummaries(lease.id),
    ]);
    result.push(toPublicLease(lease, tenantsList, guarantorsList));
  }
  return result;
}

/**
 * Liste les baux où l'utilisateur courant est partie (locataire ou garant).
 * Utilisé par le module `me` pour le dashboard locataire/garant.
 */
export async function listForParty(userId: string): Promise<LeasePublic[]> {
  // Récupère les lease_ids où le user est dans tenants.user_id OU guarantors.user_id
  const tenantLeaseRows = await db
    .select({ leaseId: leaseTenants.leaseId })
    .from(leaseTenants)
    .innerJoin(tenants, eq(tenants.id, leaseTenants.tenantId))
    .where(eq(tenants.userId, userId));

  const guarantorLeaseRows = await db
    .select({ leaseId: leaseGuarantors.leaseId })
    .from(leaseGuarantors)
    .innerJoin(guarantors, eq(guarantors.id, leaseGuarantors.guarantorId))
    .where(eq(guarantors.userId, userId));

  const leaseIds = Array.from(
    new Set([
      ...tenantLeaseRows.map((r) => r.leaseId),
      ...guarantorLeaseRows.map((r) => r.leaseId),
    ]),
  );

  if (leaseIds.length === 0) return [];

  const rows = await db
    .select()
    .from(leases)
    .where(inArray(leases.id, leaseIds))
    .orderBy(desc(leases.createdAt));

  const result: LeasePublic[] = [];
  for (const lease of rows) {
    const [tenantsList, guarantorsList] = await Promise.all([
      loadTenantSummaries(lease.id),
      loadGuarantorSummaries(lease.id),
    ]);
    result.push(toPublicLease(lease, tenantsList, guarantorsList));
  }
  return result;
}

export async function getByIdForOwner(id: string, userId: string): Promise<LeasePublic> {
  const lease = await getLeaseForOwner(id, userId);
  const [tenantsList, guarantorsList] = await Promise.all([
    loadTenantSummaries(lease.id),
    loadGuarantorSummaries(lease.id),
  ]);
  return toPublicLease(lease, tenantsList, guarantorsList);
}

export async function create(userId: string, data: CreateLeaseInput): Promise<LeasePublic> {
  // Vérifications d'ownership AVANT la transaction : on évite d'ouvrir une
  // transaction si l'utilisateur n'a pas le droit d'écrire ces données.
  await assertPropertyOwnedByUser(data.propertyId, userId);
  await assertTenantsOwnedByUser(data.tenantIds, userId);
  await assertGuarantorsOwnedByUser(data.guarantorIds, userId);

  const inserted = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(leases)
      .values({
        propertyId: data.propertyId,
        leaseTypeKey: data.leaseTypeKey,
        startDate: data.startDate,
        endDate: data.endDate ?? null,
        monthlyRentCents: data.monthlyRentCents,
        monthlyChargesCents: data.monthlyChargesCents,
        chargesTypeKey: data.chargesTypeKey,
        depositCents: data.depositCents,
        paymentDay: data.paymentDay,
        solidarity: data.solidarity,
        signatureMethodKey: data.signatureMethodKey,
        originalPaperArchived: data.originalPaperArchived,
        updatedAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error('Échec de la création du bail');
    }

    if (data.tenantIds.length > 0) {
      const uniqueTenantIds = Array.from(new Set(data.tenantIds));
      await tx
        .insert(leaseTenants)
        .values(uniqueTenantIds.map((tenantId) => ({ leaseId: row.id, tenantId })));
    }

    if (data.guarantorIds.length > 0) {
      const uniqueGuarantorIds = Array.from(new Set(data.guarantorIds));
      await tx
        .insert(leaseGuarantors)
        .values(uniqueGuarantorIds.map((guarantorId) => ({ leaseId: row.id, guarantorId })));
    }

    return row;
  });

  const [tenantsList, guarantorsList] = await Promise.all([
    loadTenantSummaries(inserted.id),
    loadGuarantorSummaries(inserted.id),
  ]);
  return toPublicLease(inserted, tenantsList, guarantorsList);
}

/**
 * PATCH (JSON Merge Patch, RFC 7396) :
 * - Clé absente → ne touche pas la colonne (ni la M2M associée)
 * - Clé à `null` → set la colonne à NULL (colonnes nullables seulement —
 *   ici seul `endDate` est concerné)
 * - Clé avec valeur → update la colonne
 *
 * Spécificités leases :
 * - `propertyId` est IMMUTABLE (absent du schéma de patch).
 * - `statusKey` est piloté exclusivement par `PATCH /:id/status` (transitions
 *   validées par une machine à états).
 * - `tenantIds` / `guarantorIds` :
 *   - Absents → on NE TOUCHE PAS aux jointures (sémantique merge-patch).
 *   - Présents (tableau, possiblement vide) → remplacement intégral.
 *     Tableau vide = on supprime toutes les jointures.
 *   La logique delete-then-insert reste dans la même transaction que l'UPDATE
 *   sur la ligne lease pour garantir l'atomicité.
 */
export async function patch(
  id: string,
  userId: string,
  data: PatchLeaseInput,
): Promise<LeasePublic> {
  // Pré-check d'ownership : lève 404/403 si besoin avant la transaction.
  await getLeaseForOwner(id, userId);
  if (data.tenantIds !== undefined) {
    await assertTenantsOwnedByUser(data.tenantIds, userId);
  }
  if (data.guarantorIds !== undefined) {
    await assertGuarantorsOwnedByUser(data.guarantorIds, userId);
  }

  // Construction du set : on ne met que les clés présentes (≠ undefined).
  // `endDate` peut être explicitement `null` (= effacer une date de fin).
  const updateData: Record<string, unknown> = {};
  if (data.leaseTypeKey !== undefined) updateData.leaseTypeKey = data.leaseTypeKey;
  if (data.startDate !== undefined) updateData.startDate = data.startDate;
  if (data.endDate !== undefined) updateData.endDate = data.endDate;
  if (data.monthlyRentCents !== undefined) updateData.monthlyRentCents = data.monthlyRentCents;
  if (data.monthlyChargesCents !== undefined)
    updateData.monthlyChargesCents = data.monthlyChargesCents;
  if (data.chargesTypeKey !== undefined) updateData.chargesTypeKey = data.chargesTypeKey;
  if (data.depositCents !== undefined) updateData.depositCents = data.depositCents;
  if (data.paymentDay !== undefined) updateData.paymentDay = data.paymentDay;
  if (data.solidarity !== undefined) updateData.solidarity = data.solidarity;
  if (data.signatureMethodKey !== undefined)
    updateData.signatureMethodKey = data.signatureMethodKey;
  if (data.originalPaperArchived !== undefined)
    updateData.originalPaperArchived = data.originalPaperArchived;

  const hasScalarChanges = Object.keys(updateData).length > 0;
  const touchesTenants = data.tenantIds !== undefined;
  const touchesGuarantors = data.guarantorIds !== undefined;

  if (!hasScalarChanges && !touchesTenants && !touchesGuarantors) {
    // PATCH vide → on renvoie l'entité telle quelle, sans toucher updatedAt.
    return getByIdForOwner(id, userId);
  }

  const updated = await db.transaction(async (tx) => {
    let row: Lease;
    if (hasScalarChanges) {
      const [updatedRow] = await tx
        .update(leases)
        .set({ ...updateData, updatedAt: new Date() })
        .where(eq(leases.id, id))
        .returning();
      if (!updatedRow) {
        throw new HTTPException(404, { message: 'Bail introuvable' });
      }
      row = updatedRow;
    } else {
      // Pas de changement scalaire mais on a touché aux M2M : on bump quand
      // même `updatedAt` pour refléter la modification de l'agrégat bail.
      const [updatedRow] = await tx
        .update(leases)
        .set({ updatedAt: new Date() })
        .where(eq(leases.id, id))
        .returning();
      if (!updatedRow) {
        throw new HTTPException(404, { message: 'Bail introuvable' });
      }
      row = updatedRow;
    }

    // Jointures : remplacement intégral UNIQUEMENT si la clé est présente.
    // Absente → on ne touche à rien (sémantique JSON Merge Patch).
    if (touchesTenants) {
      const tenantIds = data.tenantIds!;
      await tx.delete(leaseTenants).where(eq(leaseTenants.leaseId, id));
      if (tenantIds.length > 0) {
        const uniqueTenantIds = Array.from(new Set(tenantIds));
        await tx
          .insert(leaseTenants)
          .values(uniqueTenantIds.map((tenantId) => ({ leaseId: id, tenantId })));
      }
    }

    if (touchesGuarantors) {
      const guarantorIds = data.guarantorIds!;
      await tx.delete(leaseGuarantors).where(eq(leaseGuarantors.leaseId, id));
      if (guarantorIds.length > 0) {
        const uniqueGuarantorIds = Array.from(new Set(guarantorIds));
        await tx
          .insert(leaseGuarantors)
          .values(uniqueGuarantorIds.map((guarantorId) => ({ leaseId: id, guarantorId })));
      }
    }

    return row;
  });

  const [tenantsList, guarantorsList] = await Promise.all([
    loadTenantSummaries(updated.id),
    loadGuarantorSummaries(updated.id),
  ]);
  return toPublicLease(updated, tenantsList, guarantorsList);
}

/**
 * Transition de statut du bail. Implémente la machine à états :
 *   draft → active | ended
 *   active → ended
 *   ended → (terminal)
 *
 * Toute transition non listée renvoie 400.
 */
export async function updateStatus(
  id: string,
  userId: string,
  nextStatus: LeaseStatusKey,
): Promise<LeasePublic> {
  const lease = await getLeaseForOwner(id, userId);

  if (lease.statusKey === nextStatus) {
    // Idempotence : pas d'erreur, mais pas d'écriture non plus.
    const [tenantsList, guarantorsList] = await Promise.all([
      loadTenantSummaries(lease.id),
      loadGuarantorSummaries(lease.id),
    ]);
    return toPublicLease(lease, tenantsList, guarantorsList);
  }

  const allowed = ALLOWED_TRANSITIONS[lease.statusKey];
  if (!allowed.includes(nextStatus)) {
    throw new HTTPException(400, {
      message: `Transition de statut invalide : ${lease.statusKey} → ${nextStatus}`,
    });
  }

  // `signedAt` est posé automatiquement quand on passe en `active` pour la
  // première fois. C'est la sémantique métier la plus simple pour la V1 ;
  // une UX plus fine viendra avec le workflow de signature complet.
  const setSignedAt = nextStatus === 'active' && lease.signedAt === null ? new Date() : undefined;

  const [row] = await db
    .update(leases)
    .set({
      statusKey: nextStatus,
      ...(setSignedAt ? { signedAt: setSignedAt } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leases.id, id))
    .returning();

  if (!row) {
    throw new HTTPException(404, { message: 'Bail introuvable' });
  }

  const [tenantsList, guarantorsList] = await Promise.all([
    loadTenantSummaries(row.id),
    loadGuarantorSummaries(row.id),
  ]);
  return toPublicLease(row, tenantsList, guarantorsList);
}

export async function remove(id: string, userId: string): Promise<void> {
  const lease = await getLeaseForOwner(id, userId);

  if (lease.statusKey !== 'draft') {
    throw new HTTPException(400, {
      message: 'Seuls les baux à l’état "draft" peuvent être supprimés',
    });
  }

  // ON DELETE CASCADE sur les jointures s'occupe de lease_tenants /
  // lease_guarantors automatiquement.
  const deleted = await db.delete(leases).where(eq(leases.id, id)).returning({ id: leases.id });

  if (deleted.length === 0) {
    throw new HTTPException(404, { message: 'Bail introuvable' });
  }
}
