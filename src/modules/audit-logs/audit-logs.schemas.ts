import { z } from '@hono/zod-openapi';

export const AUDIT_LOG_DEFAULT_LIMIT = 50;
export const AUDIT_LOG_MAX_LIMIT = 200;

// Liste des actorType acceptés en filtre. Doit rester alignée avec le
// pg_enum `audit_actor_type` (cf. src/db/schema/audit-logs.ts).
const ACTOR_TYPE_VALUES = ['user', 'scheduler', 'system'] as const;

/**
 * Query string pour la pagination cursor-based + filtres simples.
 *  - `limit`     : taille de page, borné à AUDIT_LOG_MAX_LIMIT côté serveur.
 *  - `before`    : curseur ISO datetime ; on retourne les entrées avec
 *                  created_at strictement antérieur à cette valeur.
 *  - `action`    : filtre exact sur le nom d'action (ex. 'lease.create').
 *  - `actorType` : filtre exact ('user' | 'scheduler' | 'system').
 *  - `entityType`: filtre exact ('lease' | 'document' | ...).
 *
 * On utilise `z.coerce.number()` pour `limit` car les query strings sont
 * toujours des strings côté HTTP.
 */
export const AuditLogListQuerySchema = z
  .object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(AUDIT_LOG_MAX_LIMIT)
      .optional()
      .default(AUDIT_LOG_DEFAULT_LIMIT)
      .openapi({ param: { name: 'limit', in: 'query' } }),
    before: z
      .string()
      .datetime()
      .optional()
      .openapi({ param: { name: 'before', in: 'query' } }),
    action: z
      .string()
      .min(1)
      .optional()
      .openapi({ param: { name: 'action', in: 'query' } }),
    actorType: z
      .enum(ACTOR_TYPE_VALUES)
      .optional()
      .openapi({ param: { name: 'actorType', in: 'query' } }),
    entityType: z
      .string()
      .min(1)
      .optional()
      .openapi({ param: { name: 'entityType', in: 'query' } }),
  })
  .openapi('AuditLogListQuery');

/**
 * Représentation publique d'une entrée d'audit. `payload` est typé `unknown`
 * (jsonb libre côté DB) — les clients doivent valider eux-mêmes la forme
 * attendue selon l'action.
 */
export const AuditLogSchema = z
  .object({
    id: z.string().uuid(),
    actorType: z.enum(ACTOR_TYPE_VALUES),
    actorUserId: z.string().uuid().nullable(),
    action: z.string(),
    entityType: z.string().nullable(),
    entityId: z.string().nullable(),
    payload: z.unknown().nullable(),
    ipAddress: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('AuditLog');

/**
 * Réponse paginée. `nextCursor` est l'ISO datetime à passer dans `?before=`
 * pour la page suivante ; null s'il n'y a plus de pages.
 */
export const AuditLogListResponseSchema = z
  .object({
    items: z.array(AuditLogSchema),
    nextCursor: z.string().datetime().nullable(),
  })
  .openapi('AuditLogListResponse');

export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;
export type AuditLogPublic = z.infer<typeof AuditLogSchema>;
