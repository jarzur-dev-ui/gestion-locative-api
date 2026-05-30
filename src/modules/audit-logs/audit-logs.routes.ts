import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { requireAuth, requireRole } from '../../middleware/require-auth.js';
import type { AppEnv } from '../../types/app-env.js';
import { ErrorResponseSchema } from '../auth/auth.schemas.js';
import { AuditLogListQuerySchema, AuditLogListResponseSchema } from './audit-logs.schemas.js';
import { listAuditLogsForUser, toPublicAuditLog } from './audit-logs.service.js';

const TAG = 'audit-logs';

const listAuditLogsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: [TAG],
  summary: "Lister les entrées d'audit visibles par le bailleur",
  description:
    "Retourne les actions effectuées par l'utilisateur courant, triées par date décroissante. Pagination cursor-based via `before`.",
  request: {
    query: AuditLogListQuerySchema,
  },
  responses: {
    200: {
      description: "Liste paginée d'entrées d'audit",
      content: { 'application/json': { schema: AuditLogListResponseSchema } },
    },
    401: {
      description: 'Non authentifié',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
    403: {
      description: 'Accès refusé',
      content: { 'application/json': { schema: ErrorResponseSchema } },
    },
  },
});

export const auditLogsRoutes = new OpenAPIHono<AppEnv>();

// Endpoint privé landlord uniquement. En V1, le scope reste limité aux
// propres actions de l'utilisateur (cf. commentaire dans audit-logs.service.ts).
auditLogsRoutes.use('*', requireAuth);
auditLogsRoutes.use('*', requireRole('landlord'));

auditLogsRoutes.openapi(listAuditLogsRoute, async (c) => {
  const user = c.get('user');
  if (!user) {
    // Défensif : requireAuth garantit user != null, mais TS ne le sait pas
    // via le type Variables.
    throw new HTTPException(401, { message: 'Non authentifié' });
  }

  const { limit, before, action, actorType, entityType } = c.req.valid('query');

  const rows = await listAuditLogsForUser({
    userId: user.id,
    limit,
    before: before ? new Date(before) : undefined,
    action,
    actorType,
    entityType,
  });

  // Curseur pour la page suivante : created_at de la dernière entrée
  // retournée. Null si on a renvoyé moins que `limit` (= dernière page).
  const nextCursor =
    rows.length === limit && rows.length > 0
      ? (rows[rows.length - 1]?.createdAt.toISOString() ?? null)
      : null;

  return c.json(
    {
      items: rows.map(toPublicAuditLog),
      nextCursor,
    },
    200,
  );
});
