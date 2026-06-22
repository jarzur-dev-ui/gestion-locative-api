import { z } from '@hono/zod-openapi';

export const SHARE_DEFAULT_TTL_DAYS = 7;
export const SHARE_MAX_TTL_DAYS = 30;

/**
 * Body de création d'un partage. `ttlDays` est optionnel (par défaut 7) et
 * borné côté serveur ET côté validation pour éviter qu'un caller ne crée
 * un lien quasi-permanent par accident.
 */
export const CreateShareSchema = z
  .object({
    documentId: z.string().uuid(),
    ttlDays: z
      .number()
      .int()
      .min(1)
      .max(SHARE_MAX_TTL_DAYS)
      .optional()
      .default(SHARE_DEFAULT_TTL_DAYS),
  })
  .openapi('CreateDocumentShare');

/**
 * Réponse à la création : on renvoie le token en clair (le bailleur peut le
 * recopier / le re-partager sans recréer un partage) et l'URL prête à coller.
 */
export const ShareCreatedResponseSchema = z
  .object({
    token: z.string(),
    expiresAt: z.string().datetime(),
    shareUrl: z.string().url(),
  })
  .openapi('DocumentShareCreatedResponse');

/**
 * Représentation publique d'un partage dans la liste GET /api/document-shares.
 * Le token complet est renvoyé (décision V1 : permet au bailleur de
 * re-partager sans recréer).
 */
export const ShareSchema = z
  .object({
    token: z.string(),
    documentId: z.string().uuid(),
    createdByUserId: z.string().uuid(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().nullable(),
    lastAccessedAt: z.string().datetime().nullable(),
    accessCount: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .openapi('DocumentShare');

export const ShareListSchema = z.array(ShareSchema).openapi('DocumentShareList');

export const ShareTokenParamSchema = z
  .object({
    token: z
      .string()
      .min(20)
      .openapi({
        param: { name: 'token', in: 'path' },
        example: 'aXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxXxX',
      }),
  })
  .openapi('DocumentShareTokenParam');

export const ShareListQuerySchema = z
  .object({
    documentId: z
      .string()
      .uuid()
      .optional()
      .openapi({ param: { name: 'documentId', in: 'query' } }),
  })
  .openapi('DocumentShareListQuery');

export type CreateShareInput = z.infer<typeof CreateShareSchema>;
export type SharePublic = z.infer<typeof ShareSchema>;
