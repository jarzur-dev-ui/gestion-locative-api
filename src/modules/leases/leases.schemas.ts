import { z } from '@hono/zod-openapi';

export const LEASE_TYPES = ['empty', 'furnished'] as const;
export const CHARGES_TYPES = ['package', 'real'] as const;
export const LEASE_STATUSES = ['draft', 'active', 'ended'] as const;
export const SIGNATURE_METHODS = ['handwritten_scanned'] as const;

/**
 * Représentation publique d'un locataire embarqué dans la réponse d'un bail.
 * On reste minimaliste : juste de quoi identifier la personne côté UI.
 */
export const LeaseTenantSummarySchema = z
  .object({
    id: z.string().uuid(),
    lastName: z.string(),
    firstName: z.string(),
    email: z.string().email(),
  })
  .openapi('LeaseTenantSummary');

/**
 * Représentation publique d'un garant embarqué dans la réponse d'un bail.
 * Le polymorphisme `person | organization` est exprimé par des champs
 * nullables — le front filtre selon `guarantorTypeKey`.
 */
export const LeaseGuarantorSummarySchema = z
  .object({
    id: z.string().uuid(),
    guarantorTypeKey: z.enum(['person', 'organization']),
    lastName: z.string().nullable(),
    firstName: z.string().nullable(),
    organizationName: z.string().nullable(),
  })
  .openapi('LeaseGuarantorSummary');

/**
 * Schéma de réponse pour un bail. Contient les listes dénormalisées de
 * locataires et garants pour permettre au front d'afficher le bail en une
 * seule requête (GET /leases/:id).
 */
export const LeaseSchema = z
  .object({
    id: z.string().uuid(),
    propertyId: z.string().uuid(),

    leaseTypeKey: z.enum(LEASE_TYPES),
    startDate: z.string().date(),
    endDate: z.string().date().nullable(),

    monthlyRentCents: z.number().int().nonnegative(),
    monthlyChargesCents: z.number().int().nonnegative(),
    chargesTypeKey: z.enum(CHARGES_TYPES),
    depositCents: z.number().int().nonnegative(),

    paymentDay: z.number().int().min(1).max(31),
    solidarity: z.boolean(),

    statusKey: z.enum(LEASE_STATUSES),
    signedAt: z.string().datetime().nullable(),

    signatureMethodKey: z.enum(SIGNATURE_METHODS),
    originalPaperArchived: z.boolean(),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),

    tenants: z.array(LeaseTenantSummarySchema),
    guarantors: z.array(LeaseGuarantorSummarySchema),
  })
  .openapi('Lease');

export const LeaseListSchema = z.array(LeaseSchema).openapi('LeaseList');

/**
 * Schéma de création. `tenantIds` et `guarantorIds` peuvent être vides
 * (cas d'un brouillon que le bailleur complétera plus tard).
 */
export const CreateLeaseSchema = z
  .object({
    propertyId: z.string().uuid(),

    leaseTypeKey: z.enum(LEASE_TYPES),
    startDate: z.string().date(),
    endDate: z.string().date().optional(),

    monthlyRentCents: z.number().int().nonnegative(),
    monthlyChargesCents: z.number().int().nonnegative().optional().default(0),
    chargesTypeKey: z.enum(CHARGES_TYPES),
    depositCents: z.number().int().nonnegative().optional().default(0),

    paymentDay: z.number().int().min(1).max(31),
    solidarity: z.boolean().optional().default(false),

    signatureMethodKey: z.enum(SIGNATURE_METHODS).optional().default('handwritten_scanned'),
    originalPaperArchived: z.boolean().optional().default(false),

    tenantIds: z.array(z.string().uuid()),
    guarantorIds: z.array(z.string().uuid()),
  })
  .openapi('CreateLease');

/**
 * PATCH (JSON Merge Patch, RFC 7396) :
 * - Clé absente → ne touche pas la colonne (ni la jointure M2M associée)
 * - Clé à `null` → set la colonne à NULL (colonnes nullables seulement)
 * - Clé avec valeur → update la colonne
 *
 * Règles métier :
 * - `propertyId` est immuable (absent du schéma).
 * - `statusKey` est piloté exclusivement par `PATCH /:id/status` (absent ici).
 * - `tenantIds` / `guarantorIds` :
 *   - Absents → on ne touche pas les jointures.
 *   - Présents (tableau, possiblement vide) → remplacement intégral de la M2M.
 *
 * Colonnes NOT NULL en DB (pas de `null` accepté) :
 *   leaseTypeKey, startDate, monthlyRentCents, monthlyChargesCents,
 *   chargesTypeKey, depositCents, paymentDay, solidarity,
 *   signatureMethodKey, originalPaperArchived.
 * Colonne nullable : endDate (bail ouvert / tacite reconduction).
 */
export const PatchLeaseSchema = z
  .object({
    leaseTypeKey: z.enum(LEASE_TYPES).optional(),
    startDate: z.string().date().optional(),
    endDate: z.string().date().nullable().optional(),

    monthlyRentCents: z.number().int().nonnegative().optional(),
    monthlyChargesCents: z.number().int().nonnegative().optional(),
    chargesTypeKey: z.enum(CHARGES_TYPES).optional(),
    depositCents: z.number().int().nonnegative().optional(),

    paymentDay: z.number().int().min(1).max(31).optional(),
    solidarity: z.boolean().optional(),

    signatureMethodKey: z.enum(SIGNATURE_METHODS).optional(),
    originalPaperArchived: z.boolean().optional(),

    tenantIds: z.array(z.string().uuid()).optional(),
    guarantorIds: z.array(z.string().uuid()).optional(),
  })
  .openapi('PatchLease');

export const UpdateLeaseStatusSchema = z
  .object({
    statusKey: z.enum(LEASE_STATUSES),
  })
  .openapi('UpdateLeaseStatus');

export const LeaseIdParamSchema = z
  .object({
    id: z.string().uuid().openapi({
      param: { name: 'id', in: 'path' },
      example: '00000000-0000-0000-0000-000000000000',
    }),
  })
  .openapi('LeaseIdParam');

export const LeaseListQuerySchema = z
  .object({
    status: z
      .enum(LEASE_STATUSES)
      .optional()
      .openapi({ param: { name: 'status', in: 'query' }, example: 'active' }),
  })
  .openapi('LeaseListQuery');

export type LeasePublic = z.infer<typeof LeaseSchema>;
export type CreateLeaseInput = z.infer<typeof CreateLeaseSchema>;
export type PatchLeaseInput = z.infer<typeof PatchLeaseSchema>;
export type UpdateLeaseStatusInput = z.infer<typeof UpdateLeaseStatusSchema>;
export type LeaseStatusKey = (typeof LEASE_STATUSES)[number];
export type LeaseTypeKey = (typeof LEASE_TYPES)[number];
export type ChargesTypeKey = (typeof CHARGES_TYPES)[number];
export type SignatureMethodKey = (typeof SIGNATURE_METHODS)[number];
