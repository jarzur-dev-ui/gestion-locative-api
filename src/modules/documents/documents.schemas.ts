import { z } from '@hono/zod-openapi';
import { DOCUMENT_TYPES_BY_ROLE } from './document-types.js';

export const DOCUMENT_STATUSES = ['validated', 'pending_validation', 'rejected'] as const;
export const DOCUMENT_ROLES = ['landlord', 'tenant', 'guarantor'] as const;

/**
 * Période 'YYYY-MM' (utile pour les quittances/avis mensuels). On utilise
 * une regex plutôt qu'un `.date()` car on ne veut pas du tout d'un jour.
 */
const PERIOD_MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export const PeriodMonthSchema = z
  .string()
  .regex(PERIOD_MONTH_REGEX, 'Format attendu : YYYY-MM');

/**
 * Représentation publique d'un document. On expose volontairement PAS
 * `filePath` (interne au serveur) — le client utilise `downloadUrl` pour
 * récupérer le binaire (cf. décision documentée dans le rapport).
 */
export const DocumentSchema = z
  .object({
    id: z.string().uuid(),
    leaseId: z.string().uuid().nullable(),
    propertyId: z.string().uuid().nullable(),

    documentTypeKey: z.string(),
    periodMonth: z.string().nullable(),

    fileSizeBytes: z.number().int().nonnegative(),
    mimeType: z.string(),
    originalFilename: z.string(),

    statusKey: z.enum(DOCUMENT_STATUSES),
    validatedAt: z.string().datetime().nullable(),
    validatedByUserId: z.string().uuid().nullable(),
    rejectionReason: z.string().nullable(),

    cancelledAt: z.string().datetime().nullable(),
    cancelledByUserId: z.string().uuid().nullable(),
    cancellationReason: z.string().nullable(),

    uploadedByUserId: z.string().uuid(),

    // URL virtuelle de téléchargement (préférée à l'exposition du chemin
    // interne — voir décision dans le rapport).
    downloadUrl: z.string(),

    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('Document');

export const DocumentListSchema = z.array(DocumentSchema).openapi('DocumentList');

export const DocumentIdParamSchema = z
  .object({
    id: z.string().uuid().openapi({
      param: { name: 'id', in: 'path' },
      example: '00000000-0000-0000-0000-000000000000',
    }),
  })
  .openapi('DocumentIdParam');

/**
 * Filtres optionnels pour la liste. Le filtrage ACL (par rôle) est appliqué
 * en plus, côté service.
 */
export const DocumentListQuerySchema = z
  .object({
    leaseId: z
      .string()
      .uuid()
      .optional()
      .openapi({ param: { name: 'leaseId', in: 'query' } }),
    propertyId: z
      .string()
      .uuid()
      .optional()
      .openapi({ param: { name: 'propertyId', in: 'query' } }),
    documentTypeKey: z
      .string()
      .optional()
      .openapi({ param: { name: 'documentTypeKey', in: 'query' } }),
    statusKey: z
      .enum(DOCUMENT_STATUSES)
      .optional()
      .openapi({ param: { name: 'statusKey', in: 'query' } }),
  })
  .openapi('DocumentListQuery');

/**
 * Body du PATCH /:id/status (landlord uniquement).
 * - `validated` : pas de motif requis.
 * - `rejected`  : motif requis (sinon 400 côté service).
 */
export const UpdateDocumentStatusSchema = z
  .object({
    statusKey: z.enum(['validated', 'rejected']),
    rejectionReason: z.string().min(1).max(1000).optional(),
  })
  .openapi('UpdateDocumentStatus');

// --------------------------------------------------------------------------
// Whitelist endpoint
// --------------------------------------------------------------------------

/**
 * Réponse complète (toutes roles confondus). On utilise `readonly string[]`
 * pour ne pas figer la composition côté API (les listes peuvent évoluer).
 */
export const DocumentTypesAllSchema = z
  .object({
    landlord: z.array(z.string()),
    tenant: z.array(z.string()),
    guarantor: z.array(z.string()),
  })
  .openapi('DocumentTypesAll');

/**
 * Réponse filtrée à un seul rôle.
 */
export const DocumentTypesForRoleSchema = z
  .object({
    role: z.enum(DOCUMENT_ROLES),
    types: z.array(z.string()),
  })
  .openapi('DocumentTypesForRole');

export const DocumentTypesQuerySchema = z
  .object({
    role: z
      .enum(DOCUMENT_ROLES)
      .optional()
      .openapi({ param: { name: 'role', in: 'query' }, example: 'tenant' }),
  })
  .openapi('DocumentTypesQuery');

/**
 * Union de réponse pour l'endpoint /api/document-types.
 * Hono / zod-openapi gère bien `z.union` pour générer un `oneOf` OpenAPI.
 */
export const DocumentTypesResponseSchema = z
  .union([DocumentTypesAllSchema, DocumentTypesForRoleSchema])
  .openapi('DocumentTypesResponse');

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export type DocumentPublic = z.infer<typeof DocumentSchema>;
export type DocumentStatusKey = (typeof DOCUMENT_STATUSES)[number];
export type DocumentRoleKey = (typeof DOCUMENT_ROLES)[number];
export type UpdateDocumentStatusInput = z.infer<typeof UpdateDocumentStatusSchema>;

// Sanity check : la whitelist couvre bien les 3 rôles déclarés ici.
type _AssertRolesMatch = (typeof DOCUMENT_ROLES)[number] extends keyof typeof DOCUMENT_TYPES_BY_ROLE
  ? true
  : false;
const _rolesMatch: _AssertRolesMatch = true;
void _rolesMatch;
